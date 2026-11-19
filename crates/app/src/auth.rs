//! Authentication of every request: session cookies and the CSRF checks (A-02, SPEC 5.5,
//! ADR 0009 decision 8, ADR 0005 addendum).
//!
//! [`authenticate`] runs before every route (unknown ones included):
//!
//! 1. The `Authorization` header is sorted by [`stuffcloud_core::authorization::classify`].
//!    Exactly one well-formed `Bearer` credential is an API client (tokens, A-08 #38): cookies
//!    are ignored completely and no CSRF check applies, because a browser cannot add that
//!    header to a cross-site request without a CORS preflight, which the app never allows. Any
//!    other scheme (`Basic`, `Digest`, `Negotiate`, ...) is ignored and the request is handled
//!    as if it had no `Authorization` header: browsers attach those credentials on their own,
//!    also to cross-site form posts (a proxy in front of the app may ask for them), so they
//!    prove nothing about who started the request (#134). A malformed `Bearer` header or
//!    several `Authorization` headers are refused with 401, never read as anonymous.
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
//! (`__Host-`, `Secure`, `Path=/`, `HttpOnly`, never `Domain`) and is a
//! [`stuffcloud_core::cookie::SetCookie`], the only type the helper that adds a `Set-Cookie` header takes;
//! `scripts/ci/check_cookies.py` fails the build if another file sets a cookie.
//!
//! Every refusal is counted in `stuffcloud_auth_rejections_total{reason}`; the log line for it
//! is rate limited ([`crate::sampler::LogSampler`]), so a client cannot flood the log.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{AUTHORIZATION, COOKIE, ORIGIN, SET_COOKIE};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use stuffcloud_core::authorization::{Authorization, classify};
use stuffcloud_core::cookie::{HostCookie, Lookup, SameSite, SetCookie, lookup};
use stuffcloud_core::csrf::{
    CSRF_HEADER, CsrfPass, CsrfRefusal, CsrfRequest, Origin, check, may_bind_token,
};
use stuffcloud_core::policy::{Account, Subject};
use stuffcloud_core::scope::Scopes;
use stuffcloud_core::session::Timeouts;
use stuffcloud_core::token::{TOKEN_BYTES, Token, constant_time_eq};
use stuffcloud_db::auth::{LOGIN_REFUSED, USER_KIND, actor};
use stuffcloud_db::{DbError, NewSession, Session, SessionLookup, User, token_hash};

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

/// The metric label of a request refused for its `Authorization` header.
pub const INVALID_AUTHORIZATION: &str = "invalid_authorization";

/// The metric label of a login refused for a service account.
pub const SERVICE_LOGIN: &str = "service_login";

/// The `Sec-Fetch-Site` request header.
const SEC_FETCH_SITE: HeaderName = HeaderName::from_static("sec-fetch-site");

/// What the app needs to know for authentication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthSettings {
    /// The origin of the app address; state-changing requests must name it in `Origin`.
    pub app_origin: Origin,
    /// Session lifetimes.
    pub timeouts: Timeouts,
    /// The most sessions an account may hold; a login beyond it ends the oldest (A-03).
    pub max_sessions: usize,
}

/// An API token that was accepted: its owner (as stored now, so a role change takes effect at
/// once) and the scopes it was created with (A-07, A-08 #38).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiCaller {
    /// The account the token belongs to.
    pub owner: User,
    /// What the token was created with.
    pub scopes: Scopes,
}

/// Who sent a request. Every request that passed [`authenticate`] carries one as an
/// extension; a handler reads it with [`Authentication::of`], and the access policy turns it
/// into a [`Subject`] ([`Authentication::subject`]).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Authentication {
    /// No valid session (and, until A-08, no token either).
    #[default]
    Anonymous,
    /// A valid browser session.
    Session(Session),
    /// A valid API token. Nothing produces this before the token store of A-08 (#38); the
    /// policy and its tests already treat it, so A-08 only has to look the token up.
    Token(ApiCaller),
}

/// The account as the policy sees it.
fn account_of(user: &User) -> Account<'_> {
    Account {
        login: &user.login,
        kind: user.kind,
        role: user.role,
    }
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
            Self::Anonymous | Self::Token(_) => None,
            Self::Session(session) => Some(session),
        }
    }

    /// The account behind the request: the owner of the session or of the token.
    #[must_use]
    pub const fn user(&self) -> Option<&User> {
        match self {
            Self::Anonymous => None,
            Self::Session(session) => Some(&session.user),
            Self::Token(caller) => Some(&caller.owner),
        }
    }

    /// The request's sender as the access policy sees it.
    #[must_use]
    pub fn subject(&self) -> Subject<'_> {
        match self {
            Self::Anonymous => Subject::Anonymous,
            Self::Session(session) => Subject::Session(account_of(&session.user)),
            Self::Token(caller) => Subject::Token {
                owner: account_of(&caller.owner),
                scopes: &caller.scopes,
            },
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

/// Adds a `Set-Cookie` header with this value, if it is a valid header value (it always is
/// for a [`SetCookie`], whose name and value are token characters and hex digits).
fn append_raw(headers: &mut HeaderMap, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        let _previous = headers.append(SET_COOKIE, value);
    }
}

/// Adds a `Set-Cookie` header. A [`SetCookie`] only comes from `HostCookie::set` and
/// `HostCookie::clear`, so no caller can add a cookie that is not a host-only `__Host-` cookie.
pub(crate) fn append_cookie(headers: &mut HeaderMap, cookie: &SetCookie) {
    append_raw(headers, cookie.as_str());
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

/// Whether a request may bind a new CSRF token to its session: see
/// [`stuffcloud_core::csrf::may_bind_token`].
#[must_use]
pub fn may_bind_csrf(headers: &HeaderMap) -> bool {
    may_bind_token(&values(headers, &SEC_FETCH_SITE))
}

/// What the `Authorization` header of a request makes of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Presented {
    /// No header, or one for another scheme: handled as if there were none.
    Nothing,
    /// A well-formed bearer token: an API client.
    Token,
    /// A broken bearer header or several headers: refused.
    Invalid,
}

/// Reads the `Authorization` header.
fn presented(headers: &HeaderMap) -> Presented {
    match classify(&values(headers, &AUTHORIZATION)) {
        Authorization::Bearer(_credential) => Presented::Token,
        Authorization::Malformed => Presented::Invalid,
        // Absent, another scheme, or a verdict added later: the cookie and CSRF rules apply.
        _ => Presented::Nothing,
    }
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

/// Counts a refusal and logs it, rate limited. The log line names the rule, never a header
/// value or the client.
pub(crate) fn note_rejection(state: &AppState, reason: &'static str, method: &str) {
    state.metrics().record_rejection(reason);
    if let Some(suppressed) = state.rejection_log().admit() {
        tracing::warn!(
            target: "stuffcloud::security",
            reason,
            method,
            suppressed,
            "request refused (logged once per interval; the count is stuffcloud_auth_rejections_total)"
        );
    }
}

/// The answer to a refused state-changing request.
fn refuse(state: &AppState, refusal: CsrfRefusal, method: &str) -> Response {
    note_rejection(state, refusal.code(), method);
    Problem::with_detail(ProblemKind::CsrfRejected, refusal.to_string()).into_response()
}

/// The answer to an `Authorization` header that is no usable bearer token.
fn refuse_authorization(state: &AppState, method: &str) -> Response {
    note_rejection(state, INVALID_AUTHORIZATION, method);
    Problem::with_detail(
        ProblemKind::Unauthenticated,
        "the Authorization header is not exactly one well-formed Bearer token",
    )
    .into_response()
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
    match presented(&parts.headers) {
        Presented::Token => {
            let _previous = parts.extensions.insert(Authentication::Anonymous);
            return next.run(Request::from_parts(parts, body)).await;
        }
        Presented::Invalid => return refuse_authorization(&state, parts.method.as_str()),
        Presented::Nothing => {}
    }
    let verified = match csrf_verdict(&parts, &state.auth().app_origin) {
        Ok(CsrfPass::SafeMethod) => None,
        Ok(CsrfPass::Verified(token)) => Some(token),
        Err(refusal) => return refuse(&state, refusal, parts.method.as_str()),
    };
    let (authentication, clear) = match resolve(&state, session_cookie(&parts.headers)).await {
        Ok(resolved) => resolved,
        Err(problem) => return problem.into_response(),
    };
    if let (Some(token), Authentication::Session(session)) = (&verified, &authentication)
        && !bound_to(token, session)
    {
        return refuse(&state, CsrfRefusal::TokenMismatch, parts.method.as_str());
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
/// account); forbidden (and audited) for a service account, which has no interactive login.
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
        max_per_user: Some(state.auth().max_sessions),
    };
    let timeouts = state.auth().timeouts;
    let now = state.now_millis();
    let created = state
        .db_outcome(move |db| db.create_session(&new, &timeouts, now))
        .await?;
    match created {
        Ok(session) => Ok((session, tokens)),
        Err(DbError::NoInteractiveLogin(id)) => {
            refuse_service_login(state, id).await;
            Err(Problem::with_detail(
                ProblemKind::Forbidden,
                "service accounts have no interactive login; use an API token",
            ))
        }
        Err(error) => Err(Problem::internal(&error)),
    }
}

/// Counts and audits a login that was refused because the account is a service account.
async fn refuse_service_login(state: &AppState, user_id: i64) {
    state.metrics().record_rejection(SERVICE_LOGIN);
    let who = actor(user_id);
    let now = state.now_millis();
    let _audited = state
        .db(move |db| {
            db.record_security_event(
                Some(&who),
                LOGIN_REFUSED,
                USER_KIND,
                &user_id.to_string(),
                now,
            )
        })
        .await;
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
        append_raw(&mut headers, "a=1");
        append_raw(&mut headers, "b=2");
        append_raw(&mut headers, "bad\nvalue");
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
                SESSION_COOKIE.set(&issued.session, Some(42)).to_string(),
                CSRF_COOKIE.set(&issued.csrf, None).to_string()
            ]
        );
        let mut headers = HeaderMap::new();
        append_cookie(&mut headers, &SESSION_COOKIE.clear());
        assert_eq!(
            headers.get(SET_COOKIE).unwrap().to_str().unwrap(),
            SESSION_COOKIE.clear().as_str()
        );
    }

    #[test]
    fn the_authorization_header_decides_how_a_request_is_read() {
        let of = |values: &[&str]| {
            let mut headers = HeaderMap::new();
            for value in values {
                let _ = headers.append(AUTHORIZATION, HeaderValue::from_str(value).unwrap());
            }
            presented(&headers)
        };
        assert_eq!(of(&[]), Presented::Nothing);
        assert_eq!(of(&["Bearer abc"]), Presented::Token);
        assert_eq!(of(&["bearer abc=="]), Presented::Token);
        for other in ["Basic dXNlcjpwYXNz", "Digest a=b", "Negotiate x", "NTLM x"] {
            assert_eq!(of(&[other]), Presented::Nothing, "{other}");
        }
        for broken in ["Bearer", "Bearer a=b", "Bearer a b"] {
            assert_eq!(of(&[broken]), Presented::Invalid, "{broken}");
        }
        assert_eq!(of(&["Bearer abc", "Bearer abc"]), Presented::Invalid);
        assert_eq!(of(&["Basic x", "Bearer abc"]), Presented::Invalid);
    }

    #[test]
    fn binding_a_token_needs_a_same_origin_or_user_request() {
        let headers = |sites: &[&str]| {
            let mut headers = HeaderMap::new();
            for site in sites {
                let _ = headers.append(SEC_FETCH_SITE, HeaderValue::from_str(site).unwrap());
            }
            headers
        };
        assert!(may_bind_csrf(&headers(&[])));
        assert!(may_bind_csrf(&headers(&["same-origin"])));
        assert!(may_bind_csrf(&headers(&["none"])));
        assert!(!may_bind_csrf(&headers(&["cross-site"])));
        assert!(!may_bind_csrf(&headers(&["same-site"])));
        assert!(!may_bind_csrf(&headers(&["same-origin", "same-origin"])));
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
