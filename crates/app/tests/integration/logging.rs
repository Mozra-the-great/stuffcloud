//! Log redaction (acceptance criterion of A-01, SPEC 11): requests that carry tokens,
//! cookies, forwarded client addresses and secrets in the query string go through a real
//! TCP server, and none of it appears in the log, while the access lines are there.

use std::sync::{Arc, Mutex};

use stuffcloud_app::config::{LogFormat, LogLevel};
use stuffcloud_app::server::serve;
use stuffcloud_app::telemetry::subscriber;
use tracing_subscriber::fmt::MakeWriter;

use crate::common::{Policy, TestApp, raw_http};

#[derive(Clone, Default)]
struct Buffer(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Buffer {
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

const TOKEN: &str = "stc_live_7f3a9b2c4d5e6f708192a3b4c5d6e7f8";
const COOKIE: &str = "session-cookie-value-0c1d2e3f";
const FORWARDED: &str = "203.0.113.77";
const QUERY_SECRET: &str = "query-secret-5a6b7c8d";

#[tokio::test]
async fn logs_contain_no_addresses_tokens_cookies_or_queries() {
    for format in [LogFormat::Json, LogFormat::Text] {
        let buffer = Buffer::default();
        let _guard =
            tracing::subscriber::set_default(subscriber(LogLevel::Trace, format, buffer.clone()));
        let app = TestApp::new(Policy::AllowAll);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(serve(listener, app.router.clone(), async move {
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
        ];
        for request in requests {
            let answer = tokio::task::spawn_blocking(move || raw_http(address, &request))
                .await
                .unwrap();
            assert!(answer.starts_with("HTTP/1.1 4"), "{answer}");
        }
        stop.send(()).unwrap();
        server.await.unwrap().unwrap();

        let log = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
        assert!(log.contains("/api/v1/settings/reserved-names"), "{log}");
        assert!(log.contains("unmatched"), "{log}");
        assert!(log.contains("404"), "{log}");
        for secret in [
            TOKEN,
            COOKIE,
            FORWARDED,
            QUERY_SECRET,
            "127.0.0.1",
            "Bearer",
            "stuff.localhost",
        ] {
            assert!(
                !log.contains(secret),
                "{secret:?} leaked into the {format:?} log:\n{log}"
            );
        }
    }
}
