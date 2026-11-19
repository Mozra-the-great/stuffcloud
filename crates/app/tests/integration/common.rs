//! Helpers shared by the integration tests.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use serde_json::Value;
use stuffcloud_app::config::Limits;
use stuffcloud_app::problem::Problem;
use stuffcloud_app::server::router;
use stuffcloud_app::state::{Access, AccessPolicy, AppState, Clock, ReadOnlyPolicy};
use stuffcloud_db::Database;
use tower::ServiceExt;

/// Lets every request through: stands in for the authorisation of A-07 in tests of the
/// resource conventions.
#[derive(Debug)]
pub(crate) struct AllowAll;

impl AccessPolicy for AllowAll {
    fn authorize(&self, _request: &Parts, _access: Access, _kind: &str) -> Result<(), Problem> {
        Ok(())
    }
}

/// A clock that moves one second forward on every read, so a write that touched a
/// timestamp would show it.
#[derive(Debug, Default)]
pub(crate) struct SteppingClock(AtomicI64);

impl Clock for SteppingClock {
    fn now_millis(&self) -> i64 {
        1_763_510_400_000 + self.0.fetch_add(1000, Ordering::SeqCst)
    }
}

/// An app on a fresh temporary database.
pub(crate) struct TestApp {
    pub(crate) dir: tempfile::TempDir,
    pub(crate) db: Arc<Database>,
    pub(crate) router: Router,
}

/// Which policy the test app uses.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Policy {
    AllowAll,
    Production,
}

impl TestApp {
    pub(crate) fn new(policy: Policy) -> Self {
        Self::with_limits(policy, Limits::default())
    }

    pub(crate) fn with_limits(policy: Policy, limits: Limits) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("test.sqlite3")).unwrap());
        let _ = db.migrate().unwrap();
        let policy: Arc<dyn AccessPolicy> = match policy {
            Policy::AllowAll => Arc::new(AllowAll),
            Policy::Production => Arc::new(ReadOnlyPolicy),
        };
        let state = AppState::new(
            Arc::clone(&db),
            policy,
            Arc::new(SteppingClock::default()),
            limits,
        );
        Self {
            dir,
            db,
            router: router(state),
        }
    }

    pub(crate) async fn send(&self, request: Request<Body>) -> Reply {
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            headers,
            body: bytes.to_vec(),
        }
    }

    pub(crate) async fn get(&self, path: &str) -> Reply {
        self.send(Request::get(path).body(Body::empty()).unwrap())
            .await
    }

    pub(crate) async fn put_json(
        &self,
        path: &str,
        body: &Value,
        headers: &[(&str, &str)],
    ) -> Reply {
        let mut builder = Request::put(path).header("content-type", "application/json");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        self.send(builder.body(Body::from(body.to_string())).unwrap())
            .await
    }

    pub(crate) async fn delete(&self, path: &str, headers: &[(&str, &str)]) -> Reply {
        let mut builder = Request::builder().method(Method::DELETE).uri(path);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        self.send(builder.body(Body::empty()).unwrap()).await
    }

    pub(crate) fn audit_actions(&self) -> Vec<String> {
        self.db
            .audit_log()
            .unwrap()
            .into_iter()
            .map(|entry| entry.action)
            .collect()
    }
}

/// A response with its body read.
#[derive(Debug)]
pub(crate) struct Reply {
    pub(crate) status: StatusCode,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Vec<u8>,
}

impl Reply {
    pub(crate) fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|error| panic!("not JSON ({error}): {}", self.text()))
    }

    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    /// Asserts a problem document of the given type slug and status.
    pub(crate) fn assert_problem(&self, status: u16, slug: &str) {
        let _document = self.problem(status, slug);
    }

    /// As [`Reply::assert_problem`], returning the document.
    pub(crate) fn problem(&self, status: u16, slug: &str) -> Value {
        assert_eq!(self.status.as_u16(), status, "{}", self.text());
        assert_eq!(
            self.header("content-type"),
            Some("application/problem+json"),
            "{}",
            self.text()
        );
        let json = self.json();
        assert_eq!(
            json["type"],
            format!("{}{slug}", stuffcloud_app::problem::TYPE_BASE),
            "{json}"
        );
        assert_eq!(json["status"], status);
        json
    }
}

/// A minimal HTTP/1.1 client over a real socket: returns the raw answer.
pub(crate) fn raw_http(address: SocketAddr, request: &str) -> String {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer).unwrap();
    String::from_utf8_lossy(&answer).into_owned()
}

/// A free local port (bound and released; good enough for tests).
pub(crate) fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
