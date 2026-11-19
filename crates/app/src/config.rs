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
//! | `STUFFCLOUD_SESSION_MAX_PER_USER` | `10` | sessions per account; a login beyond it ends the oldest (1 to 1000) |
//! | `STUFFCLOUD_ARGON2_MEMORY_KIB` | `19456` | Argon2id memory per hash in KiB (7168 to 1048576, and at least OWASP's minimum for the iterations: 47104 x 1, 19456 x 2, 12288 x 3, 9216 x 4, 7168 x 5 or more) |
//! | `STUFFCLOUD_ARGON2_ITERATIONS` | `2` | Argon2id iterations (1 to 10) |
//! | `STUFFCLOUD_ARGON2_PARALLELISM` | `1` | Argon2id lanes (1 to 16) |
//! | `STUFFCLOUD_PASSWORD_MIN_LENGTH` | `12` | shortest new password in characters (8 to 128) |
//! | `STUFFCLOUD_PASSWORD_BLOCKLIST_FILE` | unset | offline list of breached passwords, one per line |
//! | `STUFFCLOUD_TRUSTED_PROXIES` | unset | reverse proxies whose `X-Forwarded-For` is believed (addresses or CIDR blocks, comma-separated); set it whenever a proxy is in front (unset, every client shares the proxy's login throttle and the app warns) |
//! | `STUFFCLOUD_BOOTSTRAP_CONFIG` | unset | configuration file applied on the first start |
//! | `STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN`, `_EMAIL`, `_PASSWORD[_FILE]` | unset | the first admin, created on the first start (login and password required, e-mail optional; prefer `_PASSWORD_FILE` and remove the variables after the first start) |
//! | `STUFFCLOUD_BOOTSTRAP_TOKEN_FILE` | unset | first service-account token (needs tokens, A-08) |

use std::fmt;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use axum::http::Uri;
use stuffcloud_core::account::{
    DEFAULT_MIN_PASSWORD_CHARS, Email, Login, MAX_MIN_PASSWORD_CHARS, MIN_PASSWORD_FLOOR,
    PasswordContext, PasswordPolicy,
};
use stuffcloud_core::client_ip::ProxyList;
use stuffcloud_core::csrf::Origin;
use stuffcloud_core::session::{HOUR_MS, MINUTE_MS, Timeouts};

use crate::password::{
    Argon2Settings, DEFAULT_ITERATIONS, DEFAULT_MEMORY_KIB, DEFAULT_PARALLELISM, MAX_ITERATIONS,
    MAX_MEMORY_KIB, MAX_PARALLELISM, MIN_MEMORY_KIB, owasp_min_memory_kib,
};

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
/// Default number of sessions per account.
pub const DEFAULT_SESSIONS_PER_USER: usize = 10;
/// Largest accepted number of sessions per account.
pub const MAX_SESSIONS_PER_USER: usize = 1000;

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

/// The first admin, created on the first start with an empty database (SPEC 10.7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapAdmin {
    /// Login name.
    pub login: Login,
    /// E-mail address.
    pub email: Option<Email>,
    /// The password (checked against the password policy).
    pub password: Secret,
}

/// The settings of local accounts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountSettings {
    /// Argon2id parameters.
    pub argon2: Argon2Settings,
    /// The password policy.
    pub policy: PasswordPolicy,
    /// The offline list of breached passwords (read at start).
    pub blocklist: Option<PathBuf>,
    /// Sessions per account.
    pub max_sessions: usize,
    /// Reverse proxies whose `X-Forwarded-For` is believed.
    pub trusted_proxies: ProxyList,
    /// The first admin.
    pub bootstrap_admin: Option<BootstrapAdmin>,
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
    /// Local accounts.
    pub accounts: AccountSettings,
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
    let errors_before = reader.errors.len();
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
    // Compared only when both values are valid, so a bad value is reported once.
    if reader.errors.len() == errors_before && session.absolute_ms < session.idle_ms {
        reader.fail(
            "STUFFCLOUD_SESSION_ABSOLUTE_HOURS",
            "must not be shorter than STUFFCLOUD_SESSION_IDLE_MINUTES",
        );
    }
    session
}

/// The Argon2id parameters; the memory must reach OWASP's minimum for the iterations (checked
/// only when both are valid, so a bad value is reported once).
fn argon2_settings<E: Environment + ?Sized>(reader: &mut Reader<'_, E>) -> Argon2Settings {
    let errors_before = reader.errors.len();
    let settings = Argon2Settings {
        memory_kib: reader.number(
            "STUFFCLOUD_ARGON2_MEMORY_KIB",
            DEFAULT_MEMORY_KIB,
            MIN_MEMORY_KIB,
            MAX_MEMORY_KIB,
        ),
        iterations: reader.number(
            "STUFFCLOUD_ARGON2_ITERATIONS",
            DEFAULT_ITERATIONS,
            1,
            MAX_ITERATIONS,
        ),
        parallelism: reader.number(
            "STUFFCLOUD_ARGON2_PARALLELISM",
            DEFAULT_PARALLELISM,
            1,
            MAX_PARALLELISM,
        ),
    };
    let floor = owasp_min_memory_kib(settings.iterations);
    if reader.errors.len() == errors_before && settings.memory_kib < floor {
        reader.fail(
            "STUFFCLOUD_ARGON2_MEMORY_KIB",
            format!(
                "must be at least {floor} with {} iteration{} (OWASP's minimum Argon2id pairs: 47104 x 1, 19456 x 2, 12288 x 3, 9216 x 4, 7168 x 5 or more)",
                settings.iterations,
                if settings.iterations == 1 { "" } else { "s" }
            ),
        );
    }
    settings
}

/// The first admin: login name and password are required once any of the variables is set;
/// every problem is reported, never the password itself.
fn bootstrap_admin<E: Environment + ?Sized>(
    reader: &mut Reader<'_, E>,
    policy: PasswordPolicy,
) -> Option<BootstrapAdmin> {
    const LOGIN: &str = "STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN";
    const EMAIL: &str = "STUFFCLOUD_BOOTSTRAP_ADMIN_EMAIL";
    const PASSWORD: &str = "STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD";
    let login_text = reader.var(LOGIN);
    let email_text = reader.var(EMAIL);
    let password = reader.secret(PASSWORD);
    if login_text.is_none() && email_text.is_none() && password.is_none() {
        return None;
    }
    let login = match login_text.as_deref().map(Login::parse) {
        None => {
            reader.fail(LOGIN, "is required to create the first admin");
            None
        }
        Some(Err(error)) => {
            reader.fail(LOGIN, error.to_string());
            None
        }
        Some(Ok(login)) => Some(login),
    };
    let email = match email_text.as_deref().map(Email::parse) {
        None => None,
        Some(Err(error)) => {
            reader.fail(EMAIL, error.to_string());
            None
        }
        Some(Ok(email)) => Some(email),
    };
    if password.is_none()
        && !reader
            .errors
            .iter()
            .any(|error| error.variable.starts_with(PASSWORD))
    {
        reader.fail(
            PASSWORD,
            format!("(or {PASSWORD}_FILE) is required to create the first admin"),
        );
    }
    if let (Some(login), Some(password)) = (&login, &password) {
        let problems = policy.check(
            password.expose(),
            &PasswordContext {
                login: login.as_str(),
                email: email.as_ref().map(Email::as_str),
            },
            false,
        );
        for problem in problems {
            reader.fail(PASSWORD, problem.to_string());
        }
    }
    Some(BootstrapAdmin {
        login: login?,
        email,
        password: password?,
    })
}

/// The settings of local accounts.
fn account_settings<E: Environment + ?Sized>(reader: &mut Reader<'_, E>) -> AccountSettings {
    let argon2 = argon2_settings(reader);
    let policy = PasswordPolicy::new(reader.number(
        "STUFFCLOUD_PASSWORD_MIN_LENGTH",
        DEFAULT_MIN_PASSWORD_CHARS,
        MIN_PASSWORD_FLOOR,
        MAX_MIN_PASSWORD_CHARS,
    ))
    .unwrap_or_default();
    let blocklist = reader
        .var("STUFFCLOUD_PASSWORD_BLOCKLIST_FILE")
        .map(PathBuf::from);
    let max_sessions = reader.number(
        "STUFFCLOUD_SESSION_MAX_PER_USER",
        DEFAULT_SESSIONS_PER_USER,
        1,
        MAX_SESSIONS_PER_USER,
    );
    let trusted_proxies =
        match ProxyList::parse(&reader.var("STUFFCLOUD_TRUSTED_PROXIES").unwrap_or_default()) {
            Ok(list) => list,
            Err(error) => {
                reader.fail("STUFFCLOUD_TRUSTED_PROXIES", error.to_string());
                ProxyList::default()
            }
        };
    // The first admin (the break-glass admin, SPEC 10.7); the password is checked against the
    // policy here, so a weak one stops the start instead of creating the account.
    let bootstrap_admin = bootstrap_admin(reader, policy);
    AccountSettings {
        argon2,
        policy,
        blocklist,
        max_sessions,
        trusted_proxies,
        bootstrap_admin,
    }
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

    let accounts = account_settings(&mut reader);
    // The first token needs API tokens (A-08, #38), which this version does not have. Refusing
    // to start is safer than ignoring it: an operator who sets it expects a token to exist.
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
            accounts,
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
    fn the_bootstrap_admin_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let config = from_env(
            &base(dir.path())
                .with("STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN", "root")
                .with("STUFFCLOUD_BOOTSTRAP_ADMIN_EMAIL", "Root@Example.com")
                .with(
                    "STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD_FILE",
                    "/run/secrets/admin",
                )
                .with_file("/run/secrets/admin", &format!("{PASSWORD}\n")),
        )
        .unwrap();
        let admin = config.accounts.bootstrap_admin.unwrap();
        assert_eq!(admin.login.as_str(), "root");
        assert_eq!(admin.email.unwrap().as_str(), "root@example.com");
        assert_eq!(admin.password.expose(), PASSWORD);
        let without_email = from_env(
            &base(dir.path())
                .with("STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN", "root")
                .with("STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD", PASSWORD),
        )
        .unwrap();
        assert_eq!(without_email.accounts.bootstrap_admin.unwrap().email, None);
        assert_eq!(
            from_env(&base(dir.path()))
                .unwrap()
                .accounts
                .bootstrap_admin,
            None
        );
    }

    #[test]
    fn bootstrap_admin_problems_never_show_the_password() {
        let dir = tempfile::tempdir().unwrap();
        let cases = [
            (
                base(dir.path()).with("STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD", PASSWORD),
                vec!["STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN: is required to create the first admin"],
            ),
            (
                base(dir.path()).with("STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN", "root"),
                vec![
                    "STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD: (or STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD_FILE) is required to create the first admin",
                ],
            ),
            (
                base(dir.path()).with("STUFFCLOUD_BOOTSTRAP_ADMIN_EMAIL", "nope"),
                vec![
                    "STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN: is required to create the first admin",
                    "STUFFCLOUD_BOOTSTRAP_ADMIN_EMAIL: an e-mail address has exactly one '@'",
                    "STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD: (or STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD_FILE) is required to create the first admin",
                ],
            ),
            (
                base(dir.path())
                    .with("STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN", "Root")
                    .with("STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD", PASSWORD),
                vec![
                    "STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN: character 0 is not one of a-z, 0-9, '.', '_' or '-' (lowercase only)",
                ],
            ),
            (
                base(dir.path())
                    .with("STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN", "root")
                    .with("STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD", "short"),
                vec![
                    "STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD: the password has 5 characters; it needs at least 12",
                ],
            ),
            (
                base(dir.path())
                    .with("STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN", "rootrootroot")
                    .with("STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD", "RootRootRoot"),
                vec![
                    "STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD: the password must not be the login name",
                ],
            ),
            (
                base(dir.path())
                    .with("STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN", "root")
                    .with("STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD_FILE", "/missing"),
                vec![
                    "STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD_FILE: cannot read the file \"/missing\": entity not found",
                ],
            ),
        ];
        for (env, expected) in cases {
            let found = errors(&env);
            assert_eq!(found, expected);
            assert!(!format!("{found:?}").contains(PASSWORD));
        }
    }

    #[test]
    fn account_settings() {
        let dir = tempfile::tempdir().unwrap();
        let defaults = from_env(&base(dir.path())).unwrap().accounts;
        assert_eq!(defaults.argon2, Argon2Settings::default());
        assert_eq!(defaults.policy, PasswordPolicy::default());
        assert_eq!(defaults.blocklist, None);
        assert_eq!(defaults.max_sessions, 10);
        assert!(defaults.trusted_proxies.is_empty());
        let set = from_env(
            &base(dir.path())
                .with("STUFFCLOUD_ARGON2_MEMORY_KIB", "7168")
                .with("STUFFCLOUD_ARGON2_ITERATIONS", "10")
                .with("STUFFCLOUD_ARGON2_PARALLELISM", "16")
                .with("STUFFCLOUD_PASSWORD_MIN_LENGTH", "8")
                .with("STUFFCLOUD_PASSWORD_BLOCKLIST_FILE", "/srv/breached.txt")
                .with("STUFFCLOUD_SESSION_MAX_PER_USER", "1")
                .with("STUFFCLOUD_TRUSTED_PROXIES", "192.0.2.10, 2001:db8::/32"),
        )
        .unwrap()
        .accounts;
        assert_eq!(
            set.argon2,
            Argon2Settings {
                memory_kib: 7168,
                iterations: 10,
                parallelism: 16
            }
        );
        assert_eq!(set.policy.min_chars(), 8);
        assert_eq!(set.blocklist, Some(PathBuf::from("/srv/breached.txt")));
        assert_eq!(set.max_sessions, 1);
        assert!(set.trusted_proxies.contains("2001:db8::5".parse().unwrap()));
        let upper = from_env(
            &base(dir.path())
                .with("STUFFCLOUD_ARGON2_MEMORY_KIB", "1048576")
                .with("STUFFCLOUD_PASSWORD_MIN_LENGTH", "128")
                .with("STUFFCLOUD_SESSION_MAX_PER_USER", "1000"),
        )
        .unwrap()
        .accounts;
        assert_eq!(upper.argon2.memory_kib, 1_048_576);
        assert_eq!(upper.policy.min_chars(), 128);
        assert_eq!(upper.max_sessions, 1000);
        assert_eq!(
            errors(
                &base(dir.path())
                    .with("STUFFCLOUD_ARGON2_MEMORY_KIB", "7167")
                    .with("STUFFCLOUD_ARGON2_ITERATIONS", "11")
                    .with("STUFFCLOUD_ARGON2_PARALLELISM", "0")
                    .with("STUFFCLOUD_PASSWORD_MIN_LENGTH", "7")
                    .with("STUFFCLOUD_SESSION_MAX_PER_USER", "1001")
                    .with("STUFFCLOUD_TRUSTED_PROXIES", "proxy.example")
            ),
            vec![
                "STUFFCLOUD_ARGON2_MEMORY_KIB: must be a whole number from 7168 to 1048576",
                "STUFFCLOUD_ARGON2_ITERATIONS: must be a whole number from 1 to 10",
                "STUFFCLOUD_ARGON2_PARALLELISM: must be a whole number from 1 to 16",
                "STUFFCLOUD_PASSWORD_MIN_LENGTH: must be a whole number from 8 to 128",
                "STUFFCLOUD_SESSION_MAX_PER_USER: must be a whole number from 1 to 1000",
                "STUFFCLOUD_TRUSTED_PROXIES: \"proxy.example\" is not an IP address or a CIDR block (such as 192.0.2.10 or 198.51.100.0/24)",
            ]
        );
        assert_eq!(
            errors(&base(dir.path()).with("STUFFCLOUD_ARGON2_MEMORY_KIB", "1048577")),
            vec!["STUFFCLOUD_ARGON2_MEMORY_KIB: must be a whole number from 7168 to 1048576"]
        );
    }

    #[test]
    fn argon2_parameters_keep_the_owasp_floor() {
        let dir = tempfile::tempdir().unwrap();
        let with = |memory: &str, iterations: &str| {
            base(dir.path())
                .with("STUFFCLOUD_ARGON2_MEMORY_KIB", memory)
                .with("STUFFCLOUD_ARGON2_ITERATIONS", iterations)
        };
        // Each of OWASP's pairs is accepted exactly at its floor and refused just below it.
        for (memory, iterations, floor) in [
            (47_104_u32, 1_u32, "must be at least 47104 with 1 iteration"),
            (19_456, 2, "must be at least 19456 with 2 iterations"),
            (12_288, 3, "must be at least 12288 with 3 iterations"),
            (9_216, 4, "must be at least 9216 with 4 iterations"),
        ] {
            let accepted = from_env(&with(&memory.to_string(), &iterations.to_string()))
                .unwrap()
                .accounts
                .argon2;
            assert_eq!(
                (accepted.memory_kib, accepted.iterations),
                (memory, iterations)
            );
            assert_eq!(
                errors(&with(
                    &memory.saturating_sub(1).to_string(),
                    &iterations.to_string()
                )),
                vec![format!(
                    "STUFFCLOUD_ARGON2_MEMORY_KIB: {floor} (OWASP's minimum Argon2id pairs: 47104 x 1, 19456 x 2, 12288 x 3, 9216 x 4, 7168 x 5 or more)"
                )]
            );
        }
        assert!(from_env(&with("7168", "5")).is_ok());
        // The default memory with a single iteration is too weak.
        assert_eq!(
            errors(&base(dir.path()).with("STUFFCLOUD_ARGON2_ITERATIONS", "1")).len(),
            1
        );
        // An invalid value is reported once, without the floor on top.
        assert_eq!(
            errors(&with("7168", "0")),
            vec!["STUFFCLOUD_ARGON2_ITERATIONS: must be a whole number from 1 to 10"]
        );
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
