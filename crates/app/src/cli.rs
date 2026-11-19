//! The command line of the `stuffcloud-app` binary.
//!
//! ```text
//! stuffcloud-app [serve]     run the API (configuration from the environment)
//! stuffcloud-app healthcheck exit 0 when the local API is ready (container health check)
//! stuffcloud-app openapi     print the OpenAPI document (CI drift check)
//! stuffcloud-app permissions print the permission matrix and route table (docs/api/permissions.md)
//! stuffcloud-app reset-link <login>
//!                            print a password reset link for an account (break-glass: works
//!                            without an admin session and without e-mail; configuration from
//!                            the environment, the database must be migrated)
//! stuffcloud-app version     print the version
//! ```
//!
//! Exit codes: `0` success, `1` failure (configuration, database, bootstrap, server, not
//! healthy), `2` usage error.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use stuffcloud_db::Database;

use stuffcloud_core::account::{Login, PasswordContext};
use stuffcloud_core::session::Role;
use stuffcloud_db::NewAccount;

use crate::access::{MatrixPolicy, permissions_markdown, verify};
use crate::accounts::Accounts;
use crate::auth::AuthSettings;
use crate::config::{self, Config, Environment};
use crate::invitations::{Issued, issue_reset_link};
use crate::maintenance::{PURGE_INTERVAL, spawn_purger};
use crate::password::{Blocklist, Passwords};
use crate::state::{AppState, Clock, SystemClock};
use crate::{bootstrap, openapi, server, telemetry};

/// Success.
pub const EXIT_OK: u8 = 0;
/// Failure.
pub const EXIT_FAILURE: u8 = 1;
/// Usage error.
pub const EXIT_USAGE: u8 = 2;

/// How long the health check waits for a connection and an answer.
pub const HEALTHCHECK_TIMEOUT: Duration = Duration::from_secs(3);

const USAGE: &str = "usage: stuffcloud-app [serve | healthcheck | openapi | permissions | reset-link <login> | version]";

/// Runs the command given by `args` (without the program name).
pub fn run<E: Environment + ?Sized>(
    args: &[String],
    env: &E,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> u8 {
    match args {
        [] => serve(env, err),
        [command] => match command.as_str() {
            "serve" => serve(env, err),
            "healthcheck" => healthcheck(env, err),
            "openapi" => print_openapi(out, err),
            "permissions" => print_permissions(out),
            "version" | "--version" => {
                report(
                    out,
                    &format!("stuffcloud-app {}", env!("CARGO_PKG_VERSION")),
                );
                EXIT_OK
            }
            "help" | "--help" | "-h" => {
                report(out, USAGE);
                EXIT_OK
            }
            _ => usage(err),
        },
        [command, login] if command == "reset-link" => reset_link_command(env, login, out, err),
        _ => usage(err),
    }
}

/// `stuffcloud-app reset-link <login>`: a reset link straight from the database, for an
/// operator who has a shell on the host but no admin who can log in.
fn reset_link_command<E: Environment + ?Sized>(
    env: &E,
    login: &str,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> u8 {
    match reset_link(env, login) {
        Ok(lines) => {
            report(out, &lines);
            EXIT_OK
        }
        Err(message) => {
            report(err, &message);
            EXIT_FAILURE
        }
    }
}

/// The work of `reset-link`: the link and its expiry, or a sentence for the operator.
fn reset_link<E: Environment + ?Sized>(env: &E, login: &str) -> Result<String, String> {
    let config = config::from_env(env).map_err(|errors| errors.to_string())?;
    let login =
        Login::parse(login).map_err(|error| format!("{login:?} is not a login name: {error}"))?;
    let path = config.database_path();
    let db = Database::open(&path)
        .map_err(|error| format!("cannot open the database {}: {error}", path.display()))?;
    db.check_schema()
        .map_err(|error| format!("the database is not ready (start the app once): {error}"))?;
    match issue_reset_link(
        &db,
        config.app_url.origin(),
        &login,
        None,
        SystemClock.now_millis(),
    )? {
        Issued::Link(link) => Ok(format!(
            "{}\nvalid once until {} (an older link of the account no longer works)",
            link.link, link.expires_at
        )),
        Issued::UnknownUser => Err(format!("no account is named {:?}", login.as_str())),
        Issued::ServiceAccount => Err(format!(
            "{:?} is a service account, which has no password",
            login.as_str()
        )),
        // Only the API is refused links for admin accounts; the command line has no actor.
        Issued::AdminAccount => Err(format!(
            "{:?} is an admin account; its link was refused",
            login.as_str()
        )),
    }
}

/// Builds password hashing from the configuration: reads the offline list and makes the dummy
/// hash (whose duration is logged as the calibration of the Argon2 parameters).
///
/// # Errors
///
/// A sentence for the operator.
pub fn passwords(config: &Config) -> Result<Passwords, String> {
    let settings = &config.accounts;
    let blocklist = match &settings.blocklist {
        None => Blocklist::default(),
        Some(path) => Blocklist::from_text(&std::fs::read_to_string(path).map_err(|error| {
            format!(
                "cannot read STUFFCLOUD_PASSWORD_BLOCKLIST_FILE {}: {}",
                path.display(),
                error.kind()
            )
        })?),
    };
    let concurrency = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
    let passwords = Passwords::new(settings.argon2, settings.policy, blocklist, concurrency)
        .map_err(|error| format!("invalid Argon2 parameters: {error}"))?;
    tracing::info!(
        target: "stuffcloud::server",
        memory_kib = settings.argon2.memory_kib,
        iterations = settings.argon2.iterations,
        parallelism = settings.argon2.parallelism,
        hash_ms = u64::try_from(passwords.calibration_ms()).unwrap_or(u64::MAX),
        concurrency = passwords.concurrency(),
        breached_list = passwords_listed(settings.blocklist.is_some()),
        "password hashing ready (one Argon2id hash took hash_ms; keep it well below a second)"
    );
    Ok(passwords)
}

fn passwords_listed(configured: bool) -> &'static str {
    if configured { "configured" } else { "none" }
}

/// The hash of the first admin's password, checked against the offline list too.
fn bootstrap_admin_hash(config: &Config, passwords: &Passwords) -> Result<Option<String>, String> {
    let Some(admin) = &config.accounts.bootstrap_admin else {
        return Ok(None);
    };
    let problems = passwords.policy().check(
        admin.password.expose(),
        &PasswordContext {
            login: admin.login.as_str(),
            email: admin
                .email
                .as_ref()
                .map(stuffcloud_core::account::Email::as_str),
        },
        passwords.breached(admin.password.expose()),
    );
    if let Some(problem) = problems.first() {
        return Err(format!("STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD: {problem}"));
    }
    passwords.hash_now(admin.password.expose()).map(Some)
}

/// Writes one line; a closed stdout or stderr is not worth a panic.
fn report(stream: &mut dyn Write, line: &str) {
    let _ignored = writeln!(stream, "{line}");
}

fn usage(err: &mut dyn Write) -> u8 {
    report(err, USAGE);
    EXIT_USAGE
}

fn print_openapi(out: &mut dyn Write, err: &mut dyn Write) -> u8 {
    match openapi::to_json() {
        Ok(json) => {
            let _ignored = out.write_all(json.as_bytes());
            EXIT_OK
        }
        Err(error) => {
            report(err, &format!("cannot render the OpenAPI document: {error}"));
            EXIT_FAILURE
        }
    }
}

fn print_permissions(out: &mut dyn Write) -> u8 {
    let _ignored = out.write_all(permissions_document().as_bytes());
    EXIT_OK
}

/// The text of `docs/api/permissions.md`: the matrix and the route table of this build.
#[must_use]
pub fn permissions_document() -> String {
    permissions_markdown(&server::declared_routes())
}

/// The address the health check connects to: the listen address, with an unspecified IP
/// (`0.0.0.0`, `::`) replaced by the loopback address of the same family.
#[must_use]
pub fn probe_address(listen: SocketAddr) -> SocketAddr {
    let ip = match listen.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        other => other,
    };
    SocketAddr::new(ip, listen.port())
}

/// Asks `GET /readyz` on `address`; `true` for a 200 answer.
#[must_use]
pub fn probe(address: SocketAddr) -> bool {
    ask_ready(address).unwrap_or(false)
}

/// The probe itself; any I/O problem means "not ready".
fn ask_ready(address: SocketAddr) -> std::io::Result<bool> {
    let mut stream = TcpStream::connect_timeout(&address, HEALTHCHECK_TIMEOUT)?;
    stream.set_read_timeout(Some(HEALTHCHECK_TIMEOUT))?;
    stream.set_write_timeout(Some(HEALTHCHECK_TIMEOUT))?;
    stream.write_all(b"GET /readyz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut status_line = [0_u8; 12];
    stream.read_exact(&mut status_line)?;
    Ok(&status_line == b"HTTP/1.1 200")
}

fn healthcheck<E: Environment + ?Sized>(env: &E, err: &mut dyn Write) -> u8 {
    let Some(listen) = config::listen_from(env) else {
        report(err, "healthcheck: STUFFCLOUD_LISTEN is not a valid address");
        return EXIT_FAILURE;
    };
    if probe(probe_address(listen)) {
        EXIT_OK
    } else {
        report(err, "healthcheck: the API is not ready");
        EXIT_FAILURE
    }
}

fn serve<E: Environment + ?Sized>(env: &E, err: &mut dyn Write) -> u8 {
    let config = match config::from_env(env) {
        Ok(config) => config,
        Err(errors) => {
            report(err, &errors.to_string());
            return EXIT_FAILURE;
        }
    };
    telemetry::init(config.log_level, config.log_format);
    match start(&config) {
        Ok(()) => EXIT_OK,
        Err(message) => {
            tracing::error!(target: "stuffcloud::server", error = %message, "stopped");
            report(err, &message);
            EXIT_FAILURE
        }
    }
}

/// Opens and migrates the database, runs the bootstrap, then serves until SIGTERM or
/// Ctrl+C.
///
/// # Errors
///
/// A sentence for the operator.
pub fn start(config: &Config) -> Result<(), String> {
    let path = config.database_path();
    let db = Database::open(&path)
        .map_err(|error| format!("cannot open the database {}: {error}", path.display()))?;
    let report = db
        .migrate()
        .map_err(|error| format!("cannot migrate the database: {error}"))?;
    tracing::info!(
        target: "stuffcloud::server",
        schema_version = report.version,
        applied = ?report.applied,
        "database ready"
    );
    let clock = SystemClock;
    let passwords = passwords(config)?;
    let admin_hash = bootstrap_admin_hash(config, &passwords)?;
    let admin = match (&config.accounts.bootstrap_admin, &admin_hash) {
        (Some(admin), Some(hash)) => Some(NewAccount {
            login: &admin.login,
            email: admin.email.as_ref(),
            role: Role::Admin,
            password_hash: hash,
        }),
        _ => None,
    };
    let _bootstrap = bootstrap::run(
        &db,
        config.bootstrap_config.as_deref(),
        admin.as_ref(),
        clock.now_millis(),
    )
    .map_err(|error| error.to_string())?;
    let purged = db
        .purge_expired_sessions(&config.session, clock.now_millis())
        .map_err(|error| format!("cannot purge expired sessions: {error}"))?;
    tracing::info!(target: "stuffcloud::server", purged, "expired sessions purged");
    // A route without a declared policy never serves a request: the start fails instead.
    verify(&server::declared_routes(), &openapi::document()).map_err(|error| error.to_string())?;
    let state = AppState::new(
        Arc::new(db),
        Arc::new(MatrixPolicy),
        Arc::new(clock),
        config.limits,
        AuthSettings {
            app_origin: config.app_url.origin().clone(),
            timeouts: config.session,
            max_sessions: config.accounts.max_sessions,
        },
        Accounts::new(passwords, config.accounts.trusted_proxies.clone()),
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("cannot start the runtime: {error}"))?;
    let listen = config.listen;
    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind(listen)
            .await
            .map_err(|error| format!("cannot listen on {listen}: {error}"))?;
        tracing::info!(target: "stuffcloud::server", %listen, "listening");
        let _purger = spawn_purger(state.clone(), PURGE_INTERVAL);
        server::serve(listener, server::router(state), server::shutdown_signal())
            .await
            .map_err(|error| format!("server error: {error}"))
    })?;
    tracing::info!(target: "stuffcloud::server", "stopped cleanly");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MapEnvironment;

    fn call(args: &[&str], env: &MapEnvironment) -> (u8, String, String) {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&args, env, &mut out, &mut err);
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    /// The error `start` refuses with. A start that does not refuse would serve until the
    /// process ends; the thread and the time limit turn that into a failed test (and a
    /// caught mutant) instead of a hung test run.
    fn refusal(config: &Config) -> String {
        let (sender, receiver) = std::sync::mpsc::channel();
        let config = config.clone();
        let _detached = std::thread::spawn(move || {
            let _sent = sender.send(start(&config));
        });
        match receiver.recv_timeout(Duration::from_secs(10)) {
            Ok(Err(error)) => error,
            Ok(Ok(())) => panic!("the app started and stopped instead of refusing"),
            Err(error) => panic!("the app did not refuse to start: {error}"),
        }
    }

    #[test]
    fn usage_errors() {
        for args in [vec!["nope"], vec!["serve", "extra"], vec!["openapi", "x"]] {
            let (code, out, err) = call(&args, &MapEnvironment::default());
            assert_eq!(code, EXIT_USAGE, "{args:?}");
            assert!(out.is_empty());
            assert_eq!(err.trim_end(), USAGE);
        }
    }

    #[test]
    fn help_and_version() {
        for flag in ["help", "--help", "-h"] {
            let (code, out, _) = call(&[flag], &MapEnvironment::default());
            assert_eq!((code, out.trim_end()), (EXIT_OK, USAGE));
        }
        for flag in ["version", "--version"] {
            let (code, out, _) = call(&[flag], &MapEnvironment::default());
            assert_eq!(code, EXIT_OK);
            assert_eq!(
                out,
                format!("stuffcloud-app {}\n", env!("CARGO_PKG_VERSION"))
            );
        }
    }

    #[test]
    fn openapi_prints_the_document() {
        let (code, out, err) = call(&["openapi"], &MapEnvironment::default());
        assert_eq!(code, EXIT_OK);
        assert!(err.is_empty());
        assert_eq!(out, openapi::to_json().unwrap());
    }

    #[test]
    fn permissions_prints_the_matrix_and_the_routes() {
        let (code, out, err) = call(&["permissions"], &MapEnvironment::default());
        assert_eq!(code, EXIT_OK);
        assert!(err.is_empty());
        assert_eq!(out, permissions_document());
        assert!(out.starts_with(
            "# Permissions
"
        ));
        assert!(
            out.contains("| PUT | `/api/v1/settings/reserved-names` | `admin:settings:write` |")
        );
        assert!(out.contains("| GET | `/healthz` | public |"));
    }

    #[test]
    fn serve_reports_every_configuration_problem() {
        for args in [vec![], vec!["serve"]] {
            let (code, _, err) = call(&args, &MapEnvironment::default());
            assert_eq!(code, EXIT_FAILURE);
            assert!(err.starts_with("invalid configuration:"), "{err}");
            assert!(err.contains("STUFFCLOUD_APP_URL: is required"), "{err}");
            assert!(err.contains("STUFFCLOUD_DATA_DIR: is required"), "{err}");
        }
    }

    #[test]
    fn probe_addresses() {
        let cases = [
            ("0.0.0.0:8000", "127.0.0.1:8000"),
            ("[::]:8000", "[::1]:8000"),
            ("192.0.2.5:80", "192.0.2.5:80"),
            ("[2001:db8::1]:80", "[2001:db8::1]:80"),
            ("127.0.0.1:9", "127.0.0.1:9"),
        ];
        for (listen, expected) in cases {
            assert_eq!(
                probe_address(listen.parse().unwrap()),
                expected.parse::<SocketAddr>().unwrap()
            );
        }
    }

    /// Answers one connection with `answer` and returns the address.
    fn one_shot_server(answer: &'static [u8]) -> SocketAddr {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let _thread = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0_u8; 256];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(answer);
            }
        });
        address
    }

    #[test]
    fn probe_needs_a_200() {
        assert!(probe(one_shot_server(b"HTTP/1.1 200 OK\r\n\r\n")));
        assert!(!probe(one_shot_server(
            b"HTTP/1.1 503 Service Unavailable\r\n\r\n"
        )));
        assert!(!probe(one_shot_server(b"HTTP/1.1 20")));
        assert!(!probe(one_shot_server(b"")));
    }

    #[test]
    fn probe_of_a_closed_port_fails() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        assert!(!probe(address));
    }

    #[test]
    fn healthcheck_command() {
        let address = one_shot_server(b"HTTP/1.1 200 OK\r\n\r\n");
        let env = MapEnvironment::default().with("STUFFCLOUD_LISTEN", &address.to_string());
        let (code, _, err) = call(&["healthcheck"], &env);
        assert_eq!((code, err.as_str()), (EXIT_OK, ""));

        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let env = MapEnvironment::default().with("STUFFCLOUD_LISTEN", &format!("127.0.0.1:{port}"));
        let (code, _, err) = call(&["healthcheck"], &env);
        assert_eq!(code, EXIT_FAILURE);
        assert_eq!(err.trim_end(), "healthcheck: the API is not ready");

        let env = MapEnvironment::default().with("STUFFCLOUD_LISTEN", "nonsense");
        let (code, _, err) = call(&["healthcheck"], &env);
        assert_eq!(code, EXIT_FAILURE);
        assert_eq!(
            err.trim_end(),
            "healthcheck: STUFFCLOUD_LISTEN is not a valid address"
        );
    }

    #[test]
    fn start_reports_database_and_bootstrap_problems() {
        let dir = tempfile::tempdir().unwrap();
        let env = MapEnvironment::default()
            .with("STUFFCLOUD_APP_URL", "http://stuff.localhost")
            .with("STUFFCLOUD_DATA_DIR", dir.path().to_str().unwrap())
            .with(
                "STUFFCLOUD_BOOTSTRAP_CONFIG",
                dir.path().join("missing.json").to_str().unwrap(),
            );
        let config = config::from_env(&env).unwrap();
        let error = refusal(&config);
        assert!(
            error.starts_with("cannot read the bootstrap configuration"),
            "{error}"
        );

        // A directory where the database file should be.
        let other = tempfile::tempdir().unwrap();
        let config = Config {
            data_dir: other.path().to_path_buf(),
            ..config
        };
        std::fs::create_dir(config.database_path()).unwrap();
        let error = refusal(&config);
        assert!(error.starts_with("cannot open the database"), "{error}");
    }

    #[test]
    fn start_refuses_a_weak_or_breached_admin_password_and_a_missing_list() {
        let dir = tempfile::tempdir().unwrap();
        let list = dir.path().join("breached.txt");
        std::fs::write(&list, "correct horse battery staple\n").unwrap();
        let env = MapEnvironment::default()
            .with("STUFFCLOUD_APP_URL", "http://stuff.localhost")
            .with("STUFFCLOUD_DATA_DIR", dir.path().to_str().unwrap())
            .with("STUFFCLOUD_ARGON2_MEMORY_KIB", "7168")
            .with("STUFFCLOUD_ARGON2_ITERATIONS", "1")
            .with("STUFFCLOUD_PASSWORD_BLOCKLIST_FILE", list.to_str().unwrap())
            .with("STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN", "root")
            .with(
                "STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD",
                "correct horse battery staple",
            );
        let config = config::from_env(&env).unwrap();
        assert_eq!(
            refusal(&config),
            "STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD: this password is on the list of breached or common passwords; choose another"
        );
        // Nothing was created.
        let db = Database::open(&config.database_path()).unwrap();
        assert_eq!(db.bootstrapped_at().unwrap(), None);
        let missing = Config {
            accounts: config::AccountSettings {
                blocklist: Some(dir.path().join("nope.txt")),
                ..config.accounts.clone()
            },
            ..config
        };
        let error = refusal(&missing);
        assert!(
            error.starts_with("cannot read STUFFCLOUD_PASSWORD_BLOCKLIST_FILE "),
            "{error}"
        );
        assert_eq!(passwords_listed(true), "configured");
        assert_eq!(passwords_listed(false), "none");
    }

    #[test]
    fn reset_link_prints_a_link_for_an_account() {
        let dir = tempfile::tempdir().unwrap();
        let env = MapEnvironment::default()
            .with("STUFFCLOUD_APP_URL", "https://app.example.com")
            .with("STUFFCLOUD_DATA_DIR", dir.path().to_str().unwrap());
        // Before the first start the database is not ready.
        let (code, out, err) = call(&["reset-link", "alice"], &env);
        assert_eq!(code, EXIT_FAILURE);
        assert!(out.is_empty());
        assert!(
            err.starts_with("the database is not ready (start the app once): "),
            "{err}"
        );
        let config = config::from_env(&env).unwrap();
        let db = Database::open(&config.database_path()).unwrap();
        let _ = db.migrate().unwrap();
        let _ = db
            .create_user(
                "alice",
                stuffcloud_core::session::UserKind::Person,
                Role::User,
                None,
                1,
            )
            .unwrap();
        let _ = db
            .create_user(
                "robot",
                stuffcloud_core::session::UserKind::Service,
                Role::User,
                None,
                1,
            )
            .unwrap();
        let (code, out, err) = call(&["reset-link", "alice"], &env);
        assert_eq!(code, EXIT_OK, "{err}");
        assert!(
            out.starts_with("https://app.example.com/password-reset#token="),
            "{out}"
        );
        assert!(out.contains("\nvalid once until "), "{out}");
        assert_eq!(
            call(&["reset-link", "bob"], &env).2.trim_end(),
            "no account is named \"bob\""
        );
        assert_eq!(
            call(&["reset-link", "robot"], &env).2.trim_end(),
            "\"robot\" is a service account, which has no password"
        );
        // An admin account gets its link only here, never through the API.
        let _ = db
            .create_user(
                "root",
                stuffcloud_core::session::UserKind::Person,
                Role::Admin,
                None,
                1,
            )
            .unwrap();
        let (code, out, err) = call(&["reset-link", "root"], &env);
        assert_eq!(code, EXIT_OK, "{err}");
        assert!(out.starts_with("https://app.example.com/password-reset#token="));
        assert_eq!(
            call(&["reset-link", "Bob"], &env).2.trim_end(),
            "\"Bob\" is not a login name: character 0 is not one of a-z, 0-9, '.', '_' or '-' (lowercase only)"
        );
        let (code, _, err) = call(&["reset-link", "alice"], &MapEnvironment::default());
        assert_eq!(code, EXIT_FAILURE);
        assert!(err.starts_with("invalid configuration:"), "{err}");
        let blocked = tempfile::tempdir().unwrap();
        std::fs::create_dir(blocked.path().join("stuffcloud.sqlite3")).unwrap();
        let env = MapEnvironment::default()
            .with("STUFFCLOUD_APP_URL", "https://app.example.com")
            .with("STUFFCLOUD_DATA_DIR", blocked.path().to_str().unwrap());
        assert!(
            call(&["reset-link", "alice"], &env)
                .2
                .starts_with("cannot open the database")
        );
        // The command needs exactly one login name.
        assert_eq!(call(&["reset-link"], &env).0, EXIT_USAGE);
        assert_eq!(call(&["reset-link", "a", "b"], &env).0, EXIT_USAGE);
    }

    #[test]
    fn start_reports_a_busy_port() {
        let dir = tempfile::tempdir().unwrap();
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let env = MapEnvironment::default()
            .with("STUFFCLOUD_APP_URL", "http://stuff.localhost")
            .with("STUFFCLOUD_DATA_DIR", dir.path().to_str().unwrap())
            .with(
                "STUFFCLOUD_LISTEN",
                &taken.local_addr().unwrap().to_string(),
            );
        let config = config::from_env(&env).unwrap();
        let error = refusal(&config);
        assert!(error.starts_with("cannot listen on 127.0.0.1:"), "{error}");
    }
}
