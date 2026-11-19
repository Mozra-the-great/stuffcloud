//! Configuration from the environment, validated at startup (SPEC 11, ADR 0010 decision 8).
//!
//! Every variable is read once, every problem is collected, and the process refuses to start
//! with the full list, so an operator fixes everything in one go. Secrets come from a
//! variable or, with the `_FILE` suffix, from a file (Docker secrets, SOPS, Ansible
//! templates); setting both is an error. A secret is wrapped in [`Secret`], whose `Debug`
//! output is redacted, and no error message ever contains a secret value.
//!
//! | Variable | Default | Meaning |
//! |---|---|---|
//! | `STUFFCLOUD_APP_URL` | required | the app address (`http(s)://host[:port]`) |
//! | `STUFFCLOUD_DATA_DIR` | required | directory of the database (must exist) |
//! | `STUFFCLOUD_LISTEN` | `127.0.0.1:8000` | address the API listens on |
//! | `STUFFCLOUD_LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` or `trace` |
//! | `STUFFCLOUD_LOG_FORMAT` | `json` | `json` or `text` |
//! | `STUFFCLOUD_MAX_BODY_BYTES` | `1048576` | largest request body (1 KiB to 64 MiB) |
//! | `STUFFCLOUD_REQUEST_TIMEOUT_SECS` | `30` | time limit per request (1 to 600) |
//! | `STUFFCLOUD_SESSION_IDLE_MINUTES` | `480` | a session unused this long ends (5 to 10080) |
//! | `STUFFCLOUD_SESSION_ABSOLUTE_HOURS` | `168` | a session ends this long after login (1 to 2160, at least the idle timeout) |
//! | `STUFFCLOUD_BOOTSTRAP_CONFIG` | unset | configuration file applied on the first start |
//! | `STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN`, `_EMAIL`, `_PASSWORD[_FILE]` | unset | first admin (needs accounts, A-03) |
//! | `STUFFCLOUD_BOOTSTRAP_TOKEN_FILE` | unset | first service-account token (needs tokens, A-08) |

use std::fmt;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use axum::http::Uri;
use stuffcloud_core::csrf::Origin;
use stuffcloud_core::session::{HOUR_MS, MINUTE_MS, Timeouts};

/// Default listen address: loopback only. The container sets `0.0.0.0:8000`.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:8000";
/// Default body limit (1 MiB).
pub const DEFAULT_MAX_BODY_BYTES: usize = 1024 * 1024;
/// Smallest accepted body limit.
pub const MIN_BODY_BYTES: usize = 1024;
/// Largest accepted body limit (uploads get their own streaming path, H-04).
pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
/// Default request time limit in seconds.
pub const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Largest accepted request time limit in seconds.
pub const MAX_TIMEOUT_SECS: u64 = 600;
/// Default session idle timeout in minutes (8 hours).
pub const DEFAULT_SESSION_IDLE_MINUTES: i64 = 480;
/// Shortest accepted session idle timeout in minutes.
pub const MIN_SESSION_IDLE_MINUTES: i64 = 5;
/// Longest accepted session idle timeout in minutes (7 days).
pub const MAX_SESSION_IDLE_MINUTES: i64 = 10_080;
/// Default absolute session lifetime in hours (7 days).
pub const DEFAULT_SESSION_ABSOLUTE_HOURS: i64 = 168;
/// Longest accepted absolute session lifetime in hours (90 days).
pub const MAX_SESSION_ABSOLUTE_HOURS: i64 = 2160;

/// Where configuration values come from: the process environment in production, a map in
/// tests.
pub trait Environment {
    /// The value of a variable, `None` when unset.
    fn var(&self, name: &str) -> Option<String>;
    /// The contents of a file (for the `_FILE` variants).
    ///
    /// # Errors
    ///
    /// Whatever reading the file reports.
    fn read_file(&self, path: &str) -> std::io::Result<String>;
}

/// The real process environment and file system.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessEnvironment;

impl Environment for ProcessEnvironment {
    fn var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    fn read_file(&self, path: &str) -> std::io::Result<String> {
        std::fs::read_to_string(path)
    }
}

/// A secret value. `Debug` never shows it; use [`Secret::expose`] where it is needed.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// The value.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// Log verbosity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    /// Errors only.
    Error,
    /// Warnings and errors.
    Warn,
    /// The default.
    Info,
    /// Verbose.
    Debug,
    /// Very verbose.
    Trace,
}

/// Log line format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    /// One JSON object per line (for log shippers).
    Json,
    /// Human-readable lines.
    Text,
}

/// The validated app address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppUrl {
    text: String,
    origin: Origin,
}

impl AppUrl {
    /// Validates an app address: `http` or `https`, a host, optionally a port, nothing else
    /// (no user info, path, query or fragment).
    ///
    /// # Errors
    ///
    /// A sentence describing the problem.
    pub fn parse(text: &str) -> Result<Self, String> {
        if text.contains('#') {
            return Err("must not have a path, query or fragment".to_owned());
        }
        let uri: Uri = text
            .parse()
            .map_err(|_invalid| "is not a valid URL".to_owned())?;
        match uri.scheme_str() {
            Some("http" | "https") => {}
            _ => return Err("must start with http:// or https://".to_owned()),
        }
        let authority = uri.authority().ok_or_else(|| "has no host".to_owned())?;
        if authority.as_str().contains('@') {
            return Err("must not contain user information".to_owned());
        }
        if authority.host().is_empty() {
            return Err("has no host".to_owned());
        }
        if !matches!(uri.path(), "" | "/") || uri.query().is_some() {
            return Err("must not have a path, query or fragment".to_owned());
        }
        let text = format!(
            "{}://{}",
            uri.scheme_str().unwrap_or_default(),
            authority.as_str().to_ascii_lowercase()
        );
        // The browser's `Origin` header is compared with this origin (CSRF, SPEC 5.5).
        let origin = Origin::parse(text.as_bytes())
            .map_err(|error| format!("is not a valid web origin: {error}"))?;
        Ok(Self { text, origin })
    }

    /// The address, normalised (lowercase host, no trailing slash).
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.text
    }

    /// The origin of the address, which every state-changing request must name in its
    /// `Origin` header.
    #[must_use]
    pub fn origin(&self) -> &Origin {
        &self.origin
    }
}

/// Request limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Largest request body in bytes.
    pub max_body_bytes: usize,
    /// Time limit per request.
    pub request_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            request_timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS),
        }
    }
}

/// The complete configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// Where the API listens.
    pub listen: SocketAddr,
    /// Directory holding the database.
    pub data_dir: PathBuf,
    /// The app address.
    pub app_url: AppUrl,
    /// Log verbosity.
    pub log_level: LogLevel,
    /// Log format.
    pub log_format: LogFormat,
    /// Request limits.
    pub limits: Limits,
    /// Session lifetimes.
    pub session: Timeouts,
    /// Bootstrap configuration file, applied on the first start (SPEC 10.7).
    pub bootstrap_config: Option<PathBuf>,
}

impl Config {
    /// Path of the database file inside the data directory.
    #[must_use]
    pub fn database_path(&self) -> PathBuf {
        self.data_dir.join("stuffcloud.sqlite3")
    }
}

/// One configuration problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    /// The variable concerned.
    pub variable: String,
    /// What is wrong (never contains a secret value).
    pub message: String,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.variable, self.message)
    }
}

/// Every configuration problem found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigErrors(pub Vec<ConfigError>);

impl fmt::Display for ConfigErrors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid configuration:")?;
        for error in &self.0 {
            write!(f, "\n  {error}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ConfigErrors {}

/// Collects values and errors while reading the environment.
struct Reader<'a, E: Environment + ?Sized> {
    env: &'a E,
    errors: Vec<ConfigError>,
}

impl<E: Environment + ?Sized> Reader<'_, E> {
    fn fail(&mut self, variable: &str, message: impl Into<String>) {
        self.errors.push(ConfigError {
            variable: variable.to_owned(),
            message: message.into(),
        });
    }

    /// A plain variable; an empty value counts as unset.
    fn var(&self, name: &str) -> Option<String> {
        self.env.var(name).filter(|value| !value.is_empty())
    }

    fn required(&mut self, name: &str) -> Option<String> {
        let value = self.var(name);
        if value.is_none() {
            self.fail(name, "is required");
        }
        value
    }

    /// A secret from `name` or from the file named by `name_FILE` (one trailing line break
    /// is removed from the file).
    fn secret(&mut self, name: &str) -> Option<Secret> {
        let file_variable = format!("{name}_FILE");
        match (self.var(name), self.var(&file_variable)) {
            (Some(_), Some(_)) => {
                self.fail(
                    name,
                    format!("set either {name} or {file_variable}, not both"),
                );
                None
            }
            (Some(value), None) => Some(Secret(value)),
            (None, Some(path)) => match self.env.read_file(&path) {
                Ok(contents) => {
                    let value = contents
                        .strip_suffix("\r\n")
                        .or_else(|| contents.strip_suffix('\n'))
                        .unwrap_or(&contents);
                    if value.is_empty() {
                        self.fail(&file_variable, format!("the file {path:?} is empty"));
                        None
                    } else {
                        Some(Secret(value.to_owned()))
                    }
                }
                Err(error) => {
                    self.fail(
                        &file_variable,
                        format!("cannot read the file {path:?}: {}", error.kind()),
                    );
                    None
                }
            },
            (None, None) => None,
        }
    }

    fn number<T: std::str::FromStr + PartialOrd + fmt::Display + Copy>(
        &mut self,
        name: &str,
        default: T,
        min: T,
        max: T,
    ) -> T {
        let Some(text) = self.var(name) else {
            return default;
        };
        match text.parse::<T>() {
            Ok(value) if value >= min && value <= max => value,
            _ => {
                self.fail(name, format!("must be a whole number from {min} to {max}"));
                default
            }
        }
    }
}

/// Parses a listen address (`host:port`, IPv6 in brackets).
///
/// # Errors
///
/// A sentence describing the problem.
pub fn parse_listen(text: &str) -> Result<SocketAddr, String> {
    text.parse()
        .map_err(|_invalid| "must be an IP address and port, such as 127.0.0.1:8000".to_owned())
}

/// The listen address from the environment (used by the health check, which must not
/// depend on the rest of the configuration).
#[must_use]
pub fn listen_from<E: Environment + ?Sized>(env: &E) -> Option<SocketAddr> {
    let text = env
        .var("STUFFCLOUD_LISTEN")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_LISTEN.to_owned());
    parse_listen(&text).ok()
}

/// The session timeouts; the absolute one may not be shorter than the idle one.
fn session_timeouts<E: Environment + ?Sized>(reader: &mut Reader<'_, E>) -> Timeouts {
    let idle_minutes = reader.number(
        "STUFFCLOUD_SESSION_IDLE_MINUTES",
        DEFAULT_SESSION_IDLE_MINUTES,
        MIN_SESSION_IDLE_MINUTES,
        MAX_SESSION_IDLE_MINUTES,
    );
    let absolute_hours = reader.number(
        "STUFFCLOUD_SESSION_ABSOLUTE_HOURS",
        DEFAULT_SESSION_ABSOLUTE_HOURS,
        1,
        MAX_SESSION_ABSOLUTE_HOURS,
    );
    // Both values are bounded above, so the products cannot overflow.
    let session = Timeouts {
        idle_ms: idle_minutes.saturating_mul(MINUTE_MS),
        absolute_ms: absolute_hours.saturating_mul(HOUR_MS),
    };
    if session.absolute_ms < session.idle_ms {
        reader.fail(
            "STUFFCLOUD_SESSION_ABSOLUTE_HOURS",
            "must not be shorter than STUFFCLOUD_SESSION_IDLE_MINUTES",
        );
    }
    session
}

/// Reads and validates the whole configuration.
///
/// # Errors
///
/// Every problem found, see [`ConfigErrors`].
pub fn from_env<E: Environment + ?Sized>(env: &E) -> Result<Config, ConfigErrors> {
    let mut reader = Reader {
        env,
        errors: Vec::new(),
    };

    let listen_text = reader
        .var("STUFFCLOUD_LISTEN")
        .unwrap_or_else(|| DEFAULT_LISTEN.to_owned());
    let listen =
        parse_listen(&listen_text).map_err(|message| reader.fail("STUFFCLOUD_LISTEN", message));

    let app_url = reader.required("STUFFCLOUD_APP_URL").map(|text| {
        AppUrl::parse(&text).map_err(|message| reader.fail("STUFFCLOUD_APP_URL", message))
    });

    let data_dir = reader.required("STUFFCLOUD_DATA_DIR").map(PathBuf::from);
    if let Some(dir) = data_dir.as_ref().filter(|dir| !dir.is_dir()) {
        reader.fail(
            "STUFFCLOUD_DATA_DIR",
            format!("{} is not an existing directory", dir.display()),
        );
    }

    let log_level = match reader.var("STUFFCLOUD_LOG_LEVEL").as_deref() {
        None | Some("info") => LogLevel::Info,
        Some("error") => LogLevel::Error,
        Some("warn") => LogLevel::Warn,
        Some("debug") => LogLevel::Debug,
        Some("trace") => LogLevel::Trace,
        Some(_) => {
            reader.fail(
                "STUFFCLOUD_LOG_LEVEL",
                "must be error, warn, info, debug or trace",
            );
            LogLevel::Info
        }
    };
    let log_format = match reader.var("STUFFCLOUD_LOG_FORMAT").as_deref() {
        None | Some("json") => LogFormat::Json,
        Some("text") => LogFormat::Text,
        Some(_) => {
            reader.fail("STUFFCLOUD_LOG_FORMAT", "must be json or text");
            LogFormat::Json
        }
    };

    let limits = Limits {
        max_body_bytes: reader.number(
            "STUFFCLOUD_MAX_BODY_BYTES",
            DEFAULT_MAX_BODY_BYTES,
            MIN_BODY_BYTES,
            MAX_BODY_BYTES,
        ),
        request_timeout: Duration::from_secs(reader.number(
            "STUFFCLOUD_REQUEST_TIMEOUT_SECS",
            DEFAULT_TIMEOUT_SECS,
            1,
            MAX_TIMEOUT_SECS,
        )),
    };

    let session = session_timeouts(&mut reader);

    let bootstrap_config = reader.var("STUFFCLOUD_BOOTSTRAP_CONFIG").map(PathBuf::from);

    // The first admin and the first token need accounts (A-03, #33) and tokens (A-08, #38),
    // which this version does not have. Refusing to start is safer than ignoring them: an
    // operator who sets them expects an admin to exist afterwards. The password is read
    // (so a broken `_FILE` path is reported too) and dropped at once.
    let admin_login = reader.var("STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN");
    let admin_email = reader.var("STUFFCLOUD_BOOTSTRAP_ADMIN_EMAIL");
    let admin_password = reader.secret("STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD");
    if admin_login.is_some() || admin_email.is_some() || admin_password.is_some() {
        reader.fail(
            "STUFFCLOUD_BOOTSTRAP_ADMIN_*",
            "creating the first admin needs accounts (A-03, #33), which this version does not have yet; unset these variables",
        );
    }
    drop(admin_password);
    if reader.var("STUFFCLOUD_BOOTSTRAP_TOKEN_FILE").is_some() {
        reader.fail(
            "STUFFCLOUD_BOOTSTRAP_TOKEN_FILE",
            "a bootstrap token needs API tokens (A-08, #38), which this version does not have yet; unset it",
        );
    }

    match (listen, app_url, data_dir) {
        (Ok(listen), Some(Ok(app_url)), Some(data_dir)) if reader.errors.is_empty() => Ok(Config {
            listen,
            data_dir,
            app_url,
            log_level,
            log_format,
            limits,
            session,
            bootstrap_config,
        }),
        _ => Err(ConfigErrors(reader.errors)),
    }
}

/// A map-backed environment for tests (here and in the integration tests).
#[derive(Debug, Clone, Default)]
pub struct MapEnvironment {
    /// Variables.
    pub vars: std::collections::BTreeMap<String, String>,
    /// Files by path.
    pub files: std::collections::BTreeMap<String, String>,
}

impl MapEnvironment {
    /// Sets a variable.
    #[must_use]
    pub fn with(mut self, name: &str, value: &str) -> Self {
        let _previous = self.vars.insert(name.to_owned(), value.to_owned());
        self
    }

    /// Adds a file.
    #[must_use]
    pub fn with_file(mut self, path: &str, contents: &str) -> Self {
        let _previous = self.files.insert(path.to_owned(), contents.to_owned());
        self
    }
}

impl Environment for MapEnvironment {
    fn var(&self, name: &str) -> Option<String> {
        self.vars.get(name).cloned()
    }

    fn read_file(&self, path: &str) -> std::io::Result<String> {
        self.files
            .get(path)
            .cloned()
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(dir: &std::path::Path) -> MapEnvironment {
        MapEnvironment::default()
            .with("STUFFCLOUD_APP_URL", "http://stuff.localhost:8080")
            .with("STUFFCLOUD_DATA_DIR", dir.to_str().unwrap())
    }

    fn errors(env: &MapEnvironment) -> Vec<String> {
        match from_env(env) {
            Err(ConfigErrors(errors)) => errors.iter().map(ToString::to_string).collect(),
            Ok(config) => panic!("{config:?}"),
        }
    }

    #[test]
    fn minimal_configuration_uses_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let config = from_env(&base(dir.path())).unwrap();
        assert_eq!(config.listen, DEFAULT_LISTEN.parse().unwrap());
        assert_eq!(config.app_url.as_str(), "http://stuff.localhost:8080");
        assert_eq!(config.data_dir, dir.path());
        assert_eq!(
            config.database_path(),
            dir.path().join("stuffcloud.sqlite3")
        );
        assert_eq!(config.log_level, LogLevel::Info);
        assert_eq!(config.log_format, LogFormat::Json);
        assert_eq!(config.limits, Limits::default());
        assert_eq!(config.limits.max_body_bytes, 1_048_576);
        assert_eq!(config.limits.request_timeout, Duration::from_secs(30));
        assert_eq!(config.bootstrap_config, None);
        assert_eq!(config.session, Timeouts::default());
        assert_eq!(
            config.app_url.origin(),
            &Origin::parse(b"http://stuff.localhost:8080").unwrap()
        );
    }

    #[test]
    fn session_timeouts() {
        let dir = tempfile::tempdir().unwrap();
        let read = |idle: &str, absolute: &str| {
            from_env(
                &base(dir.path())
                    .with("STUFFCLOUD_SESSION_IDLE_MINUTES", idle)
                    .with("STUFFCLOUD_SESSION_ABSOLUTE_HOURS", absolute),
            )
        };
        assert_eq!(
            read("5", "1").unwrap().session,
            Timeouts {
                idle_ms: 300_000,
                absolute_ms: 3_600_000
            }
        );
        assert_eq!(
            read("60", "1").unwrap().session,
            Timeouts {
                idle_ms: 3_600_000,
                absolute_ms: 3_600_000
            }
        );
        assert_eq!(
            read("10080", "2160").unwrap().session,
            Timeouts {
                idle_ms: 604_800_000,
                absolute_ms: 7_776_000_000
            }
        );
        let message = |idle: &str, absolute: &str| match read(idle, absolute) {
            Err(ConfigErrors(errors)) => errors.iter().map(ToString::to_string).collect::<Vec<_>>(),
            Ok(config) => panic!("{config:?}"),
        };
        assert_eq!(
            message("4", "1"),
            vec!["STUFFCLOUD_SESSION_IDLE_MINUTES: must be a whole number from 5 to 10080"]
        );
        assert_eq!(
            message("10081", "2160"),
            vec!["STUFFCLOUD_SESSION_IDLE_MINUTES: must be a whole number from 5 to 10080"]
        );
        assert_eq!(
            message("5", "0"),
            vec!["STUFFCLOUD_SESSION_ABSOLUTE_HOURS: must be a whole number from 1 to 2160"]
        );
        assert_eq!(
            message("5", "2161"),
            vec!["STUFFCLOUD_SESSION_ABSOLUTE_HOURS: must be a whole number from 1 to 2160"]
        );
        assert_eq!(
            message("61", "1"),
            vec![
                "STUFFCLOUD_SESSION_ABSOLUTE_HOURS: must not be shorter than STUFFCLOUD_SESSION_IDLE_MINUTES"
            ]
        );
    }

    #[test]
    fn every_setting_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let env = base(dir.path())
            .with("STUFFCLOUD_LISTEN", "[::1]:9000")
            .with("STUFFCLOUD_LOG_LEVEL", "debug")
            .with("STUFFCLOUD_LOG_FORMAT", "text")
            .with("STUFFCLOUD_MAX_BODY_BYTES", "2048")
            .with("STUFFCLOUD_REQUEST_TIMEOUT_SECS", "5")
            .with(
                "STUFFCLOUD_BOOTSTRAP_CONFIG",
                "/etc/stuffcloud/bootstrap.json",
            );
        let config = from_env(&env).unwrap();
        assert_eq!(config.listen, "[::1]:9000".parse().unwrap());
        assert_eq!(config.log_level, LogLevel::Debug);
        assert_eq!(config.log_format, LogFormat::Text);
        assert_eq!(
            config.limits,
            Limits {
                max_body_bytes: 2048,
                request_timeout: Duration::from_secs(5)
            }
        );
        assert_eq!(
            config.bootstrap_config,
            Some(PathBuf::from("/etc/stuffcloud/bootstrap.json"))
        );
    }

    #[test]
    fn log_levels_and_formats() {
        let dir = tempfile::tempdir().unwrap();
        for (text, level) in [
            ("error", LogLevel::Error),
            ("warn", LogLevel::Warn),
            ("info", LogLevel::Info),
            ("debug", LogLevel::Debug),
            ("trace", LogLevel::Trace),
        ] {
            let env = base(dir.path()).with("STUFFCLOUD_LOG_LEVEL", text);
            assert_eq!(from_env(&env).unwrap().log_level, level);
        }
        let env = base(dir.path()).with("STUFFCLOUD_LOG_FORMAT", "json");
        assert_eq!(from_env(&env).unwrap().log_format, LogFormat::Json);
    }

    #[test]
    fn empty_values_count_as_unset() {
        let dir = tempfile::tempdir().unwrap();
        let env = base(dir.path())
            .with("STUFFCLOUD_LISTEN", "")
            .with("STUFFCLOUD_LOG_LEVEL", "");
        let config = from_env(&env).unwrap();
        assert_eq!(config.listen, DEFAULT_LISTEN.parse().unwrap());
        assert_eq!(config.log_level, LogLevel::Info);
    }

    #[test]
    fn reports_every_problem_at_once() {
        let env = MapEnvironment::default()
            .with("STUFFCLOUD_LISTEN", "localhost")
            .with("STUFFCLOUD_LOG_LEVEL", "loud")
            .with("STUFFCLOUD_LOG_FORMAT", "xml")
            .with("STUFFCLOUD_MAX_BODY_BYTES", "lots")
            .with("STUFFCLOUD_REQUEST_TIMEOUT_SECS", "0");
        assert_eq!(
            errors(&env),
            vec![
                "STUFFCLOUD_LISTEN: must be an IP address and port, such as 127.0.0.1:8000",
                "STUFFCLOUD_APP_URL: is required",
                "STUFFCLOUD_DATA_DIR: is required",
                "STUFFCLOUD_LOG_LEVEL: must be error, warn, info, debug or trace",
                "STUFFCLOUD_LOG_FORMAT: must be json or text",
                "STUFFCLOUD_MAX_BODY_BYTES: must be a whole number from 1024 to 67108864",
                "STUFFCLOUD_REQUEST_TIMEOUT_SECS: must be a whole number from 1 to 600",
            ]
        );
    }

    #[test]
    fn number_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let body =
            |value: &str| from_env(&base(dir.path()).with("STUFFCLOUD_MAX_BODY_BYTES", value));
        assert_eq!(body("1024").unwrap().limits.max_body_bytes, 1024);
        assert!(body("1023").is_err());
        assert_eq!(
            body("67108864").unwrap().limits.max_body_bytes,
            MAX_BODY_BYTES
        );
        assert!(body("67108865").is_err());
        assert!(body("-1").is_err());
        let timeout = |value: &str| {
            from_env(&base(dir.path()).with("STUFFCLOUD_REQUEST_TIMEOUT_SECS", value))
        };
        assert_eq!(
            timeout("1").unwrap().limits.request_timeout,
            Duration::from_secs(1)
        );
        assert_eq!(
            timeout("600").unwrap().limits.request_timeout,
            Duration::from_mins(10)
        );
        assert!(timeout("601").is_err());
    }

    #[test]
    fn data_dir_must_exist() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        let env = base(dir.path()).with("STUFFCLOUD_DATA_DIR", missing.to_str().unwrap());
        assert_eq!(
            errors(&env),
            vec![format!(
                "STUFFCLOUD_DATA_DIR: {} is not an existing directory",
                missing.display()
            )]
        );
    }

    #[test]
    fn app_url_rules() {
        for (text, expected) in [
            ("http://stuff.localhost", "http://stuff.localhost"),
            ("https://Stuff.Example:8443/", "https://stuff.example:8443"),
            ("http://192.0.2.1:8080", "http://192.0.2.1:8080"),
            ("http://[2001:db8::1]", "http://[2001:db8::1]"),
        ] {
            let url = AppUrl::parse(text).unwrap();
            assert_eq!(url.as_str(), expected, "{text}");
            assert_eq!(
                url.origin().to_string(),
                expected.replace(":443", ""),
                "{text}"
            );
        }
        for (text, message) in [
            ("not a url", "is not a valid URL"),
            ("ftp://stuff.example", "must start with http:// or https://"),
            ("stuff.example", "must start with http:// or https://"),
            ("/path", "must start with http:// or https://"),
            (
                "http://user@stuff.example",
                "must not contain user information",
            ),
            (
                "http://stuff.example/app",
                "must not have a path, query or fragment",
            ),
            (
                "http://stuff.example/?x=1",
                "must not have a path, query or fragment",
            ),
            (
                "http://stuff.example/#x",
                "must not have a path, query or fragment",
            ),
            ("http://:8080", "has no host"),
            (
                "http://stuff_host.example",
                "is not a valid web origin: the origin has no valid host",
            ),
        ] {
            assert_eq!(AppUrl::parse(text), Err(message.to_owned()), "{text}");
        }
    }

    #[test]
    fn listen_from_falls_back_to_the_default() {
        let empty = MapEnvironment::default();
        assert_eq!(listen_from(&empty), Some(DEFAULT_LISTEN.parse().unwrap()));
        let set = MapEnvironment::default().with("STUFFCLOUD_LISTEN", "0.0.0.0:8000");
        assert_eq!(listen_from(&set), Some("0.0.0.0:8000".parse().unwrap()));
        let blank = MapEnvironment::default().with("STUFFCLOUD_LISTEN", "");
        assert_eq!(listen_from(&blank), Some(DEFAULT_LISTEN.parse().unwrap()));
        let bad = MapEnvironment::default().with("STUFFCLOUD_LISTEN", "x");
        assert_eq!(listen_from(&bad), None);
    }

    const PASSWORD: &str = "correct horse battery staple";

    #[test]
    fn bootstrap_admin_is_refused_without_leaking_the_password() {
        let dir = tempfile::tempdir().unwrap();
        for env in [
            base(dir.path()).with("STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD", PASSWORD),
            base(dir.path())
                .with(
                    "STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD_FILE",
                    "/run/secrets/admin",
                )
                .with_file("/run/secrets/admin", &format!("{PASSWORD}\n")),
            base(dir.path()).with("STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN", "admin"),
            base(dir.path()).with("STUFFCLOUD_BOOTSTRAP_ADMIN_EMAIL", "admin@example.com"),
        ] {
            let found = errors(&env);
            assert_eq!(found.len(), 1, "{found:?}");
            assert!(found[0].starts_with(
                "STUFFCLOUD_BOOTSTRAP_ADMIN_*: creating the first admin needs accounts (A-03, #33)"
            ));
            assert!(!format!("{found:?}").contains(PASSWORD));
        }
    }

    #[test]
    fn bootstrap_token_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let env = base(dir.path()).with("STUFFCLOUD_BOOTSTRAP_TOKEN_FILE", "/run/secrets/token");
        assert_eq!(
            errors(&env),
            vec![
                "STUFFCLOUD_BOOTSTRAP_TOKEN_FILE: a bootstrap token needs API tokens (A-08, #38), which this version does not have yet; unset it"
            ]
        );
    }

    #[test]
    fn secret_rules() {
        let name = "STUFFCLOUD_X";
        let read = |env: &MapEnvironment| {
            let mut reader = Reader {
                env,
                errors: Vec::new(),
            };
            let value = reader.secret(name);
            (
                value,
                reader
                    .errors
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>(),
            )
        };
        let (value, errors) = read(&MapEnvironment::default().with(name, PASSWORD));
        assert_eq!(value.unwrap().expose(), PASSWORD);
        assert!(errors.is_empty());

        for contents in [
            PASSWORD.to_owned(),
            format!("{PASSWORD}\n"),
            format!("{PASSWORD}\r\n"),
        ] {
            let env = MapEnvironment::default()
                .with("STUFFCLOUD_X_FILE", "/s")
                .with_file("/s", &contents);
            assert_eq!(read(&env).0.unwrap().expose(), PASSWORD);
        }
        let two_lines = MapEnvironment::default()
            .with("STUFFCLOUD_X_FILE", "/s")
            .with_file("/s", "a\n\n");
        assert_eq!(
            read(&two_lines).0.unwrap().expose(),
            "a\n",
            "only one line break is removed"
        );

        let (value, errors) = read(&MapEnvironment::default());
        assert!(value.is_none() && errors.is_empty());

        let both = MapEnvironment::default()
            .with(name, PASSWORD)
            .with("STUFFCLOUD_X_FILE", "/s");
        let (value, errors) = read(&both);
        assert!(value.is_none());
        assert_eq!(
            errors,
            vec!["STUFFCLOUD_X: set either STUFFCLOUD_X or STUFFCLOUD_X_FILE, not both"]
        );

        let missing = MapEnvironment::default().with("STUFFCLOUD_X_FILE", "/nope");
        assert_eq!(
            read(&missing).1,
            vec!["STUFFCLOUD_X_FILE: cannot read the file \"/nope\": entity not found"]
        );
        let empty = MapEnvironment::default()
            .with("STUFFCLOUD_X_FILE", "/e")
            .with_file("/e", "\n");
        assert_eq!(
            read(&empty).1,
            vec!["STUFFCLOUD_X_FILE: the file \"/e\" is empty"]
        );
    }

    #[test]
    fn secret_debug_is_redacted() {
        let secret = Secret(PASSWORD.to_owned());
        assert_eq!(format!("{secret:?}"), "Secret(<redacted>)");
        assert_eq!(secret.expose(), PASSWORD);
    }

    #[test]
    fn errors_display() {
        let errors = ConfigErrors(vec![
            ConfigError {
                variable: "A".to_owned(),
                message: "x".to_owned(),
            },
            ConfigError {
                variable: "B".to_owned(),
                message: "y".to_owned(),
            },
        ]);
        assert_eq!(errors.to_string(), "invalid configuration:\n  A: x\n  B: y");
    }

    #[test]
    fn process_environment_reads_files_and_variables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f");
        std::fs::write(&path, "contents").unwrap();
        assert_eq!(
            ProcessEnvironment
                .read_file(path.to_str().unwrap())
                .unwrap(),
            "contents"
        );
        // PATH exists on every platform the tests run on; no variable is modified.
        assert!(ProcessEnvironment.var("PATH").is_some());
        assert!(
            ProcessEnvironment
                .var("STUFFCLOUD_TEST_SURELY_UNSET_9F2C")
                .is_none()
        );
    }
}
