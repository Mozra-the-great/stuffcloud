//! Log redaction (acceptance criterion of A-01, SPEC 11): requests that carry tokens,
//! cookies, forwarded client addresses and secrets in the query string go through a real
//! TCP server, and none of it appears in the log, while the access lines are there (and the
//! warning about an unlisted reverse proxy, which names no address).
//!
//! A test binary of its own: it installs the process-wide subscriber, which a thread-local
//! one in the shared integration binary cannot replace reliably (tests run on many threads
//! and `tracing` caches per call site whether anyone listens).

#![expect(
    clippy::unwrap_used,
    reason = "test code: a panic is a failed test, and the helpers outside #[test] functions are test code too"
)]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use stuffcloud_app::access::AccessPolicy;
use stuffcloud_app::config::{Limits, LogLevel};
use stuffcloud_app::server::{router, serve};
use stuffcloud_app::state::{AppState, SystemClock};
use stuffcloud_app::telemetry::targets;
use stuffcloud_core::policy::{Decision, Requirement, Subject};
use stuffcloud_db::Database;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::{Layer, Registry, fmt};

#[derive(Clone, Default)]
struct Buffer(Arc<Mutex<Vec<u8>>>);

impl Write for Buffer {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'w> MakeWriter<'w> for Buffer {
    type Writer = Self;

    fn make_writer(&'w self) -> Self::Writer {
        self.clone()
    }
}

impl Buffer {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

/// Lets the write through, so the request reaches validation (and its error paths).
#[derive(Debug)]
struct AllowAll;

impl AccessPolicy for AllowAll {
    fn decide(&self, _subject: &Subject<'_>, _requirement: Requirement) -> Decision {
        Decision::Allow
    }
}

fn raw_http(address: SocketAddr, request: &str) -> String {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer).unwrap();
    String::from_utf8_lossy(&answer).into_owned()
}

const TOKEN: &str = "stc_live_7f3a9b2c4d5e6f708192a3b4c5d6e7f8";
const COOKIE: &str = "session-cookie-value-0c1d2e3f";
const FORWARDED: &str = "203.0.113.77";
const QUERY_SECRET: &str = "query-secret-5a6b7c8d";
const CSRF: &str = "c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5";
const LOGIN_BODY: &str = r#"{"login":"nobody","password":"a wrong passphrase"}"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn logs_contain_no_addresses_tokens_cookies_or_queries() {
    // Both formats of `telemetry`, with its filter, at the most verbose level.
    let json = Buffer::default();
    let text = Buffer::default();
    let subscriber = Registry::default()
        .with(
            fmt::layer()
                .json()
                .with_current_span(false)
                .with_span_list(false)
                .with_writer(json.clone())
                .with_filter(targets(LogLevel::Trace)),
        )
        .with(
            fmt::layer()
                .with_writer(text.clone())
                .with_filter(targets(LogLevel::Trace)),
        );
    tracing::subscriber::set_global_default(subscriber).unwrap();

    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("log.sqlite3")).unwrap());
    let _ = db.migrate().unwrap();
    let state = AppState::new(
        db,
        Arc::new(AllowAll),
        Arc::new(SystemClock),
        Limits::default(),
        stuffcloud_app::auth::AuthSettings {
            app_origin: stuffcloud_core::csrf::Origin::parse(b"https://app.example.com").unwrap(),
            timeouts: stuffcloud_core::session::Timeouts::default(),
            max_sessions: 10,
        },
        stuffcloud_app::accounts::Accounts::new(
            stuffcloud_app::password::Passwords::new(
                stuffcloud_app::password::Argon2Settings::CHEAPEST,
                stuffcloud_core::account::PasswordPolicy::default(),
                stuffcloud_app::password::Blocklist::default(),
                2,
            )
            .unwrap(),
            stuffcloud_core::client_ip::ProxyList::default(),
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(serve(listener, router(state), async move {
        let _ = stopped.await;
    }));

    let requests = [
        format!(
            "GET /api/v1/settings/reserved-names?token={QUERY_SECRET} HTTP/1.1\r\nHost: stuff.localhost\r\nAuthorization: Bearer {TOKEN}\r\nCookie: session={COOKIE}\r\nX-Forwarded-For: {FORWARDED}\r\nX-Real-IP: {FORWARDED}\r\nConnection: close\r\n\r\n"
        ),
        format!(
            "PUT /api/v1/settings/reserved-names HTTP/1.1\r\nHost: stuff.localhost\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{{\"names\":[\"x\"]}}"
        ),
        format!(
            "GET /nope/{QUERY_SECRET} HTTP/1.1\r\nHost: stuff.localhost\r\nForwarded: for={FORWARDED}\r\nConnection: close\r\n\r\n"
        ),
        // A login through an unlisted proxy (loopback peer, forwarded address, no list): the
        // warning names no address.
        format!(
            "POST /api/v1/auth/login HTTP/1.1\r\nHost: stuff.localhost\r\nOrigin: https://app.example.com\r\nCookie: __Host-stuffcloud-csrf={CSRF}\r\nX-CSRF-Token: {CSRF}\r\nX-Forwarded-For: {FORWARDED}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{LOGIN_BODY}",
            LOGIN_BODY.len()
        ),
    ];
    for request in requests {
        let answer = tokio::task::spawn_blocking(move || raw_http(address, &request))
            .await
            .unwrap();
        assert!(answer.starts_with("HTTP/1.1 4"), "{answer}");
    }
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    for (format, log) in [("json", json.text()), ("text", text.text())] {
        assert!(
            log.contains("/api/v1/settings/reserved-names"),
            "{format}: {log}"
        );
        assert!(log.contains("unmatched"), "{format}: {log}");
        assert!(
            log.contains("STUFFCLOUD_TRUSTED_PROXIES is empty"),
            "{format}: {log}"
        );
        assert!(log.contains("422"), "{format}: {log}");
        assert!(log.contains("404"), "{format}: {log}");
        // Probes are named by position, so a failure message never repeats the value itself.
        let forbidden = [
            TOKEN,
            COOKIE,
            FORWARDED,
            QUERY_SECRET,
            "127.0.0.1",
            "Bearer",
            "stuff.localhost",
        ];
        for (index, probe) in forbidden.iter().enumerate() {
            assert!(
                !log.contains(probe),
                "forbidden value #{index} leaked into the {format} log"
            );
        }
    }
}
