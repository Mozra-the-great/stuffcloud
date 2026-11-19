//! Authentication of every request: session cookies and the CSRF checks (A-02, SPEC 5.5,
//! ADR 0009 decision 8, ADR 0005 addendum).
//!
//! [`authenticate`] runs before every route (unknown ones included):
//!
//! 1. A request with an `Authorization` header is an API client (tokens, A-08 #38): cookies
//!    are ignored completely and no CSRF check applies. A browser cannot add that header to a
//!    cross-site request without a CORS preflight, which the app never allows.
//! 2. Otherwise a state-changing request (any method other than `GET`, `HEAD`, `OPTIONS`) must
//!    pass [`stuffcloud_core::csrf::check`]: `Origin` equal to the app origin, `Sec-Fetch-Site`
//!    `same-origin` when present, and the `X-CSRF-Token` header equal to the CSRF cookie. This
//!    holds with and without a session, so the login form is protected too.
//! 3. The session cookie `__Host-stuffcloud-session` (only that exact name; see
//!    [`stuffcloud_core::cookie`]) is looked up by the hash of its token. A valid session
//!    becomes [`Authentication::Session`]; for a state-changing request its stored CSRF hash
//!    must match the token of step 2. A malformed, ambiguous, unknown or expired session
//!    cookie is cleared in the response.
//!
//! Every `Set-Cookie` of the app is built here from [`SESSION_COOKIE`] and [`CSRF_COOKIE`]
//! (`__Host-`, `Secure`, `Path=/`, `HttpOnly`, never `Domain`); `scripts/ci/check_cookies.py`
//! fails the build if another file sets a cookie.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{AUTHORIZATION, COOKIE, ORIGIN, SET_COOKIE};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use stuffcloud_core::cookie::{HostCookie, Lookup, SameSite, lookup};
use stuffcloud_core::csrf::{CSRF_HEADER, CsrfPass, CsrfRefusal, CsrfRequest, Origin, check};
use stuffcloud_core::session::Timeouts;
use stuffcloud_core::token::{TOKEN_BYTES, Token, constant_time_eq};
use stuffcloud_db::{NewSession, Session, SessionLookup, token_hash};

use crate::problem::{Problem, ProblemKind};
use crate::state::AppState;

/// The session cookie. `SameSite=Lax` keeps the login on links into the app; it is not
/// counted as a CSRF defence (SPEC 5.5).
pub const SESSION_COOKIE: HostCookie =
    match HostCookie::new("__Host-stuffcloud-session", SameSite::Lax) {
        Some(cookie) => cookie,
        None => unreachable!(),
    };

/// The CSRF cookie (double submit; bound to the session once there is one).
pub const CSRF_COOKIE: HostCookie =
    match HostCookie::new("__Host-stuffcloud-csrf", SameSite::Strict) {
        Some(cookie) => cookie,
        None => unreachable!(),
    };

/// The `Sec-Fetch-Site` request header.
const SEC_FETCH_SITE: HeaderName = HeaderName::from_static("sec-fetch-site");

/// What the app needs to know for authentication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthSettings {
    /// The origin of the app address; state-changing requests must name it in `Origin`.
    pub app_origin: Origin,
    /// Session lifetimes.
    pub timeouts: Timeouts,
}

/// Who sent a request. Every request that passed [`authenticate`] carries one as an
/// extension; a handler reads it with [`Authentication::of`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Authentication {
    /// No valid session (and, until A-08, no token either).
    #[default]
    Anonymous,
    /// A valid browser session.
    Session(Session),
}

impl Authentication {
    /// The authentication of a request; [`Authentication::Anonymous`] when the middleware did
    /// not run.
    #[must_use]
    pub fn of(parts: &Parts) -> Self {
        parts.extensions.get::<Self>().cloned().unwrap_or_default()
    }

    /// The session, if there is one.
    #[must_use]
    pub const fn session(&self) -> Option<&Session> {
        match self {
            Self::Anonymous => None,
            Self::Session(session) => Some(session),
        }
    }
}

/// A new random token from the operating system.
///
/// # Errors
///
/// An internal problem when the random source fails.
pub fn new_token() -> Result<Token, Problem> {
    let mut bytes = [0_u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| Problem::internal(&error))?;
    Ok(Token::from_bytes(bytes))
}

/// Adds a `Set-Cookie` header.
pub fn append_cookie(headers: &mut HeaderMap, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        let _previous = headers.append(SET_COOKIE, value);
    }
}

/// The values of a header (all fields of that name), as bytes.
fn values<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Vec<&'a [u8]> {
    headers
        .get_all(name)
        .iter()
        .map(HeaderValue::as_bytes)
        .collect()
}

/// The values of every `Cookie` header field.
fn cookie_values(headers: &HeaderMap) -> Vec<&[u8]> {
    values(headers, &COOKIE)
}

/// The CSRF token in the request's cookie, if it is there exactly once and well-formed.
#[must_use]
pub fn csrf_cookie(headers: &HeaderMap) -> Option<Token> {
    lookup(cookie_values(headers), CSRF_COOKIE.name())
        .value()
        .and_then(|value| Token::parse(value).ok())
}

/// What the session cookie of a request holds.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SessionCookie {
    /// No session cookie.
    Absent,
    /// Present but malformed or given more than once: cleared, never looked up.
    Invalid,
    /// A well-formed token.
    Token(Token),
}

/// Reads the session cookie.
fn session_cookie(headers: &HeaderMap) -> SessionCookie {
    match lookup(cookie_values(headers), SESSION_COOKIE.name()) {
        Lookup::Absent => SessionCookie::Absent,
        Lookup::Ambiguous => SessionCookie::Invalid,
        Lookup::Found(value) => {
            Token::parse(value).map_or(SessionCookie::Invalid, SessionCookie::Token)
        }
    }
}

/// The CSRF verdict for a request (the part that needs no database).
fn csrf_verdict(parts: &Parts, app: &Origin) -> Result<CsrfPass, CsrfRefusal> {
    let headers = &parts.headers;
    let origins = values(headers, &ORIGIN);
    let fetch_sites = values(headers, &SEC_FETCH_SITE);
    let tokens = values(headers, &HeaderName::from_static(CSRF_HEADER));
    let cookies = cookie_values(headers);
    check(
        &CsrfRequest {
            method: parts.method.as_str(),
            origins: &origins,
            fetch_sites: &fetch_sites,
            tokens: &tokens,
            cookie: lookup(cookies, CSRF_COOKIE.name()),
        },
        app,
    )
}

/// The answer to a refused state-changing request. The log line names the rule, never a
/// header value or the client.
fn refuse(refusal: CsrfRefusal, method: &str) -> Response {
    tracing::warn!(
        target: "stuffcloud::security",
        reason = refusal.code(),
        method,
        "cross-site request refused"
    );
    Problem::with_detail(ProblemKind::CsrfRejected, refusal.to_string()).into_response()
}

/// Whether a CSRF token is the one bound to a session.
#[must_use]
pub fn bound_to(token: &Token, session: &Session) -> bool {
    constant_time_eq(&token_hash(token), &session.csrf_hash)
}

/// Looks the session cookie up. The flag says whether the response must clear the cookie.
async fn resolve(
    state: &AppState,
    cookie: SessionCookie,
) -> Result<(Authentication, bool), Problem> {
    let token = match cookie {
        SessionCookie::Absent => return Ok((Authentication::Anonymous, false)),
        SessionCookie::Invalid => return Ok((Authentication::Anonymous, true)),
        SessionCookie::Token(token) => token,
    };
    let hash = token_hash(&token);
    let timeouts = state.auth().timeouts;
    let now = state.now_millis();
    let found = state
        .db(move |db| db.find_session(&hash, &timeouts, now))
        .await?;
    Ok(match found {
        SessionLookup::Active(session) => (Authentication::Session(session), false),
        SessionLookup::Expired(_) | SessionLookup::Unknown => (Authentication::Anonymous, true),
    })
}

/// The middleware: see the module documentation.
pub async fn authenticate(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let (mut parts, body) = request.into_parts();
    if parts.headers.contains_key(AUTHORIZATION) {
        let _previous = parts.extensions.insert(Authentication::Anonymous);
        return next.run(Request::from_parts(parts, body)).await;
    }
    let verified = match csrf_verdict(&parts, &state.auth().app_origin) {
        Ok(CsrfPass::SafeMethod) => None,
        Ok(CsrfPass::Verified(token)) => Some(token),
        Err(refusal) => return refuse(refusal, parts.method.as_str()),
    };
    let (authentication, clear) = match resolve(&state, session_cookie(&parts.headers)).await {
        Ok(resolved) => resolved,
        Err(problem) => return problem.into_response(),
    };
    if let (Some(token), Authentication::Session(session)) = (&verified, &authentication)
        && !bound_to(token, session)
    {
        return refuse(CsrfRefusal::TokenMismatch, parts.method.as_str());
    }
    let _previous = parts.extensions.insert(authentication);
    let mut response = next.run(Request::<Body>::from_parts(parts, body)).await;
    if clear {
        append_cookie(response.headers_mut(), &SESSION_COOKIE.clear());
    }
    response
}

/// Fresh session and CSRF tokens for a new or rotated session.
#[derive(Debug)]
pub struct IssuedTokens {
    /// The session token (goes only into the cookie).
    pub session: Token,
    /// The CSRF token (cookie and response body).
    pub csrf: Token,
}

impl IssuedTokens {
    /// Two new random tokens.
    ///
    /// # Errors
    ///
    /// An internal problem when the random source fails.
    pub fn generate() -> Result<Self, Problem> {
        Ok(Self {
            session: new_token()?,
            csrf: new_token()?,
        })
    }

    /// Sets both cookies on a response; the session cookie lives until the absolute
    /// timeout of the session.
    pub fn set_cookies(&self, headers: &mut HeaderMap, max_age: u64) {
        append_cookie(headers, &SESSION_COOKIE.set(&self.session, Some(max_age)));
        append_cookie(headers, &CSRF_COOKIE.set(&self.csrf, None));
    }
}

/// Starts a session for an account that has just proved who it is (the login flows of
/// A-03 to A-06 call this). The session the request presented, if any, is ended: a login
/// never keeps a session id that existed before it (session fixation).
///
/// # Errors
///
/// An internal problem when the random source or the database fails (also for an unknown
/// or service account).
pub async fn start_session(
    state: &AppState,
    parts: &Parts,
    user_id: i64,
) -> Result<(Session, IssuedTokens), Problem> {
    let tokens = IssuedTokens::generate()?;
    let new = NewSession {
        user_id,
        token_hash: token_hash(&tokens.session),
        csrf_hash: token_hash(&tokens.csrf),
        replaces: Authentication::of(parts)
            .session()
            .map(|session| session.id),
    };
    let timeouts = state.auth().timeouts;
    let now = state.now_millis();
    let session = state
        .db(move |db| db.create_session(&new, &timeouts, now))
        .await?;
    Ok((session, tokens))
}

/// Gives a session new tokens after a change of its privilege (a second factor, A-05),
/// keeping its account and age.
///
/// # Errors
///
/// An internal problem when the random source or the database fails; unauthenticated when
/// the session no longer exists.
pub async fn rotate_session(state: &AppState, session: &Session) -> Result<IssuedTokens, Problem> {
    let tokens = IssuedTokens::generate()?;
    let id = session.id;
    let token = token_hash(&tokens.session);
    let csrf = token_hash(&tokens.csrf);
    let now = state.now_millis();
    if state
        .db(move |db| db.rotate_session(id, &token, &csrf, now))
        .await?
    {
        Ok(tokens)
    } else {
        Err(Problem::with_detail(
            ProblemKind::Unauthenticated,
            "the session has ended",
        ))
    }
}

#[cfg(test)]
mod tests {
    use axum::http::Request as HttpRequest;

    use super::*;

    fn parts(headers: &[(&str, &str)]) -> Parts {
        let mut builder = HttpRequest::builder().method("PUT").uri("/x");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(()).unwrap().into_parts().0
    }

    #[test]
    fn cookie_definitions() {
        assert_eq!(SESSION_COOKIE.name(), "__Host-stuffcloud-session");
        assert_eq!(SESSION_COOKIE.same_site(), SameSite::Lax);
        assert_eq!(CSRF_COOKIE.name(), "__Host-stuffcloud-csrf");
        assert_eq!(CSRF_COOKIE.same_site(), SameSite::Strict);
    }

    #[test]
    fn tokens_are_random() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_ne!(a, b);
        assert_ne!(a.as_bytes(), &[0; TOKEN_BYTES]);
        let issued = IssuedTokens::generate().unwrap();
        assert_ne!(issued.session, issued.csrf);
    }

    #[test]
    fn session_cookie_states() {
        let token = Token::from_bytes([3; 32]);
        let hex = token.to_hex();
        let cookie = |value: &str| parts(&[("cookie", value)]).headers;
        assert_eq!(session_cookie(&HeaderMap::new()), SessionCookie::Absent);
        assert_eq!(
            session_cookie(&cookie(&format!("__Host-stuffcloud-session={hex}"))),
            SessionCookie::Token(token.clone())
        );
        assert_eq!(
            session_cookie(&cookie("__Host-stuffcloud-session=nope")),
            SessionCookie::Invalid
        );
        assert_eq!(
            session_cookie(&cookie(&format!(
                "__Host-stuffcloud-session={hex}; __Host-stuffcloud-session={hex}"
            ))),
            SessionCookie::Invalid
        );
        assert_eq!(
            session_cookie(&cookie(&format!("stuffcloud-session={hex}"))),
            SessionCookie::Absent
        );
        assert_eq!(
            csrf_cookie(&cookie(&format!("__Host-stuffcloud-csrf={hex}"))),
            Some(token)
        );
        assert_eq!(csrf_cookie(&cookie("__Host-stuffcloud-csrf=x")), None);
        assert_eq!(csrf_cookie(&HeaderMap::new()), None);
    }

    #[test]
    fn appended_cookies() {
        let mut headers = HeaderMap::new();
        append_cookie(&mut headers, "a=1");
        append_cookie(&mut headers, "b=2");
        append_cookie(&mut headers, "bad\nvalue");
        let all: Vec<&str> = headers
            .get_all(SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect();
        assert_eq!(all, ["a=1", "b=2"]);
        let issued = IssuedTokens::generate().unwrap();
        let mut headers = HeaderMap::new();
        issued.set_cookies(&mut headers, 42);
        let all: Vec<String> = headers
            .get_all(SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            all,
            [
                SESSION_COOKIE.set(&issued.session, Some(42)),
                CSRF_COOKIE.set(&issued.csrf, None)
            ]
        );
    }

    #[test]
    fn verdicts_read_every_header() {
        let app = Origin::parse(b"https://app.example.com").unwrap();
        let hex = Token::from_bytes([5; 32]).to_hex();
        let cookie = format!("__Host-stuffcloud-csrf={hex}");
        let good = parts(&[
            ("origin", "https://app.example.com"),
            ("sec-fetch-site", "same-origin"),
            ("x-csrf-token", &hex),
            ("cookie", &cookie),
        ]);
        assert!(matches!(
            csrf_verdict(&good, &app),
            Ok(CsrfPass::Verified(_))
        ));
        let cross = parts(&[
            ("origin", "https://app.example.com"),
            ("sec-fetch-site", "same-site"),
            ("x-csrf-token", &hex),
            ("cookie", &cookie),
        ]);
        assert_eq!(
            csrf_verdict(&cross, &app),
            Err(CsrfRefusal::CrossSiteRequest)
        );
        let no_cookie = parts(&[
            ("origin", "https://app.example.com"),
            ("x-csrf-token", &hex),
        ]);
        assert_eq!(
            csrf_verdict(&no_cookie, &app),
            Err(CsrfRefusal::MissingToken)
        );
    }

    #[test]
    fn authentication_of_parts() {
        let mut request = parts(&[]);
        assert_eq!(Authentication::of(&request), Authentication::Anonymous);
        assert_eq!(Authentication::Anonymous.session(), None);
        let _previous = request.extensions.insert(Authentication::Anonymous);
        assert_eq!(Authentication::of(&request), Authentication::Anonymous);
    }
}
