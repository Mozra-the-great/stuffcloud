//! The command line of the `stuffcloud-app` binary.
//!
//! ```text
//! stuffcloud-app [serve]     run the API (configuration from the environment)
//! stuffcloud-app healthcheck exit 0 when the local API is ready (container health check)
//! stuffcloud-app openapi     print the OpenAPI document (CI drift check)
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

use crate::config::{self, Config, Environment};
use crate::state::{AppState, Clock, ReadOnlyPolicy, SystemClock};
use crate::{bootstrap, openapi, server, telemetry};

/// Success.
pub const EXIT_OK: u8 = 0;
/// Failure.
pub const EXIT_FAILURE: u8 = 1;
/// Usage error.
pub const EXIT_USAGE: u8 = 2;

/// How long the health check waits for a connection and an answer.
pub const HEALTHCHECK_TIMEOUT: Duration = Duration::from_secs(3);

const USAGE: &str = "usage: stuffcloud-app [serve | healthcheck | openapi | version]";

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
        _ => usage(err),
    }
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
    let Ok(mut stream) = TcpStream::connect_timeout(&address, HEALTHCHECK_TIMEOUT) else {
        return false;
    };
    if stream.set_read_timeout(Some(HEALTHCHECK_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(HEALTHCHECK_TIMEOUT)).is_err()
        || stream
            .write_all(b"GET /readyz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .is_err()
    {
        return false;
    }
    let mut status_line = [0_u8; 12];
    stream.read_exact(&mut status_line).is_ok() && &status_line == b"HTTP/1.1 200"
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
    let _bootstrap = bootstrap::run(&db, config.bootstrap_config.as_deref(), clock.now_millis())
        .map_err(|error| error.to_string())?;
    let state = AppState::new(
        Arc::new(db),
        Arc::new(ReadOnlyPolicy),
        Arc::new(clock),
        config.limits,
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
        let error = start(&config).unwrap_err();
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
        let error = start(&config).unwrap_err();
        assert!(error.starts_with("cannot open the database"), "{error}");
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
        let error = start(&config).unwrap_err();
        assert!(error.starts_with("cannot listen on 127.0.0.1:"), "{error}");
    }
}
