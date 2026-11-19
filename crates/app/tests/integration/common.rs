//! Helpers shared by the integration tests.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use serde_json::Value;
use stuffcloud_app::access::{AccessPolicy, MatrixPolicy};
use stuffcloud_app::auth::AuthSettings;
use stuffcloud_app::config::Limits;
use stuffcloud_app::server::router;
use stuffcloud_app::state::{AppState, Clock};
use stuffcloud_core::csrf::Origin;
use stuffcloud_core::policy::{Decision, Requirement, Subject};
use stuffcloud_core::session::{Role, Timeouts, UserKind};
use stuffcloud_core::token::Token;
use stuffcloud_db::{Database, NewSession, Session, token_hash};
use tower::ServiceExt;

/// Lets every request through: for tests of the resource conventions, which are about bodies,
/// preconditions and dry runs and not about who may write (the matrix tests are in `authz.rs`).
#[derive(Debug)]
pub(crate) struct AllowAll;

impl AccessPolicy for AllowAll {
    fn decide(&self, _subject: &Subject<'_>, _requirement: Requirement) -> Decision {
        Decision::Allow
    }
}

/// The account machinery with the cheapest Argon2 parameters (a hash costs next to nothing).
/// The hashing queue is long enough for every burst a test sends, so a count of password
/// checks never depends on how the requests interleave (the bound itself has unit tests).
pub(crate) fn cheap_accounts() -> stuffcloud_app::accounts::Accounts {
    stuffcloud_app::accounts::Accounts::new(
        stuffcloud_app::password::Passwords::new(
            stuffcloud_app::password::Argon2Settings::CHEAPEST,
            stuffcloud_core::account::PasswordPolicy::default(),
            stuffcloud_app::password::Blocklist::default(),
            2,
        )
        .unwrap()
        .with_queue(1024, std::time::Duration::from_mins(1)),
        stuffcloud_core::client_ip::ProxyList::default(),
    )
}

/// A clock that moves one second forward on every read, so a write that touched a
/// timestamp would show it. Tests move it further with [`SteppingClock::advance`]. A frozen
/// one ([`TestApp::frozen`]) only moves on `advance`: a burst of parallel requests then
/// happens at one instant, as it does for the throttles.
#[derive(Debug)]
pub(crate) struct SteppingClock {
    offset: AtomicI64,
    step: i64,
}

impl Default for SteppingClock {
    fn default() -> Self {
        Self {
            offset: AtomicI64::new(0),
            step: 1000,
        }
    }
}

/// The first reading of [`SteppingClock`].
pub(crate) const EPOCH: i64 = 1_763_510_400_000;

impl SteppingClock {
    pub(crate) fn advance(&self, millis: i64) {
        let _ = self.offset.fetch_add(millis, Ordering::SeqCst);
    }
}

impl Clock for SteppingClock {
    fn now_millis(&self) -> i64 {
        EPOCH + self.offset.fetch_add(self.step, Ordering::SeqCst)
    }
}

/// The app address of every test app: a name that a hosted site may share (RFC 2606).
pub(crate) const APP_ORIGIN: &str = "https://app.example.com";

/// A hosted site on the same registrable domain as the app.
pub(crate) const SITE_ORIGIN: &str = "https://site.example.com";

/// The CSRF token the helpers send by default (header and cookie) for anonymous writes.
pub(crate) const CSRF: &str = "c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5";

/// Headers that pass the CSRF checks without a session.
pub(crate) fn csrf_headers() -> Vec<(String, String)> {
    vec![
        ("origin".to_owned(), APP_ORIGIN.to_owned()),
        ("x-csrf-token".to_owned(), CSRF.to_owned()),
        (
            "cookie".to_owned(),
            format!("__Host-stuffcloud-csrf={CSRF}"),
        ),
    ]
}

/// A logged-in browser: the session and the tokens its cookies hold.
#[derive(Debug, Clone)]
pub(crate) struct Browser {
    pub(crate) session: Session,
    pub(crate) token: Token,
    pub(crate) csrf: Token,
}

impl Browser {
    /// The `Cookie` header with both cookies.
    pub(crate) fn cookie(&self) -> String {
        format!(
            "__Host-stuffcloud-session={}; __Host-stuffcloud-csrf={}",
            self.token.to_hex(),
            self.csrf.to_hex()
        )
    }

    /// Headers of a read from this browser: both cookies.
    pub(crate) fn read_headers(&self) -> Vec<(String, String)> {
        vec![("cookie".to_owned(), self.cookie())]
    }

    /// Headers of a write from this browser: origin, CSRF header and both cookies.
    pub(crate) fn write_headers(&self) -> Vec<(String, String)> {
        vec![
            ("origin".to_owned(), APP_ORIGIN.to_owned()),
            ("x-csrf-token".to_owned(), self.csrf.to_hex()),
            ("cookie".to_owned(), self.cookie()),
        ]
    }
}

/// Test timeouts: short enough to cross with [`SteppingClock::advance`].
pub(crate) const TIMEOUTS: Timeouts = Timeouts {
    idle_ms: 10 * 60_000,
    absolute_ms: 60 * 60_000,
};

/// An app on a fresh temporary database.
pub(crate) struct TestApp {
    pub(crate) dir: tempfile::TempDir,
    pub(crate) db: Arc<Database>,
    pub(crate) clock: Arc<SteppingClock>,
    pub(crate) state: AppState,
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

    /// A test app whose clock stands still between `advance` calls.
    pub(crate) fn frozen(policy: Policy) -> Self {
        Self::build(
            policy,
            Limits::default(),
            SteppingClock {
                offset: AtomicI64::new(0),
                step: 0,
            },
        )
    }

    pub(crate) fn with_limits(policy: Policy, limits: Limits) -> Self {
        Self::build(policy, limits, SteppingClock::default())
    }

    fn build(policy: Policy, limits: Limits, clock: SteppingClock) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("test.sqlite3")).unwrap());
        let _ = db.migrate().unwrap();
        let policy: Arc<dyn AccessPolicy> = match policy {
            Policy::AllowAll => Arc::new(AllowAll),
            Policy::Production => Arc::new(MatrixPolicy),
        };
        let clock = Arc::new(clock);
        let shared_clock: Arc<dyn Clock> = Arc::<SteppingClock>::clone(&clock);
        let state = AppState::new(
            Arc::clone(&db),
            policy,
            shared_clock,
            limits,
            AuthSettings {
                app_origin: Origin::parse(APP_ORIGIN.as_bytes()).unwrap(),
                timeouts: TIMEOUTS,
                max_sessions: 10,
            },
            cheap_accounts(),
        );
        Self {
            dir,
            db,
            clock,
            router: router(state.clone()),
            state,
        }
    }

    /// Creates a person with `role` and a session for it, as a login would.
    pub(crate) fn login(&self, login: &str, role: Role) -> Browser {
        let user = self
            .db
            .create_user(login, UserKind::Person, role, None, EPOCH)
            .unwrap();
        self.session_for(user.id)
    }

    /// A new session for an existing account.
    pub(crate) fn session_for(&self, user_id: i64) -> Browser {
        let token = Token::from_bytes(random_bytes());
        let csrf = Token::from_bytes(random_bytes());
        let session = self
            .db
            .create_session(
                &NewSession {
                    user_id,
                    token_hash: token_hash(&token),
                    csrf_hash: token_hash(&csrf),
                    replaces: None,
                    max_per_user: None,
                },
                &TIMEOUTS,
                self.clock.now_millis(),
            )
            .unwrap();
        Browser {
            session,
            token,
            csrf,
        }
    }

    /// Sends `method path` with `headers` and an optional JSON body.
    pub(crate) async fn call(
        &self,
        method: Method,
        path: &str,
        headers: &[(String, String)],
        body: Option<&Value>,
    ) -> Reply {
        let mut builder = Request::builder().method(method).uri(path);
        for (name, value) in headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        let body = match body {
            Some(json) => {
                builder = builder.header("content-type", "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        self.send(builder.body(body).unwrap()).await
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
        for (name, value) in csrf_headers() {
            builder = builder.header(name, value);
        }
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        self.send(builder.body(Body::from(body.to_string())).unwrap())
            .await
    }

    pub(crate) async fn delete(&self, path: &str, headers: &[(&str, &str)]) -> Reply {
        let mut builder = Request::builder().method(Method::DELETE).uri(path);
        for (name, value) in csrf_headers() {
            builder = builder.header(name, value);
        }
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

/// 32 bytes that differ on every call (tests need uniqueness, not secrecy).
fn random_bytes() -> [u8; 32] {
    static NEXT: AtomicI64 = AtomicI64::new(1);
    let seed = NEXT.fetch_add(1, Ordering::SeqCst).to_le_bytes();
    let mut bytes = [0x5a_u8; 32];
    for (index, slot) in bytes.iter_mut().enumerate() {
        *slot ^= seed[index % 8].wrapping_add(u8::try_from(index).unwrap());
    }
    bytes
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

    /// Every `Set-Cookie` value.
    pub(crate) fn set_cookies(&self) -> Vec<String> {
        self.headers
            .get_all("set-cookie")
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect()
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
#[cfg(unix)]
pub(crate) fn raw_http(address: std::net::SocketAddr, request: &str) -> String {
    use std::io::{Read, Write};
    use std::time::Duration;

    let mut stream =
        std::net::TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
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
