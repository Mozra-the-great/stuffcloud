//! The session endpoints (A-02): `/api/v1/auth/session` and `/api/v1/auth/sessions`.
//!
//! - `GET /auth/session` tells the client who it is and hands out the CSRF token every write
//!   needs (it also sets the `__Host-stuffcloud-csrf` cookie when the browser has no valid
//!   one). Anonymous clients get a token too, so the login form is protected. It only reads
//!   the session: a new token for a session is stored only when the request may bind one
//!   ([`crate::auth::may_bind_csrf`]: same-origin, from the user, or without `Sec-Fetch-Site`).
//! - `DELETE /auth/session` ends the current session (logout).
//! - `DELETE /auth/sessions` ends every session of the account (logout everywhere).
//!
//! Logging in is not here: it is part of the login flows (A-03 to A-06), which call
//! [`crate::auth::start_session`].

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use stuffcloud_core::session::{Role, UserKind};
use stuffcloud_db::auth::actor;
use stuffcloud_db::token_hash;
use utoipa::ToSchema;

use crate::auth::{
    Authentication, CSRF_COOKIE, SESSION_COOKIE, append_cookie, bound_to, csrf_cookie,
    may_bind_csrf, new_token,
};
use crate::problem::{Problem, ProblemBody, ProblemKind};
use crate::resource::rfc3339;
use crate::state::AppState;

/// Route of the current session below `/api/v1`.
pub const SESSION_PATH: &str = "/auth/session";

/// Route of all sessions of the account below `/api/v1`.
pub const SESSIONS_PATH: &str = "/auth/sessions";

/// The account of a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct SessionUser {
    /// Login name.
    pub login: String,
    /// Role.
    pub role: Role,
    /// Account kind (always `person` for a browser session).
    pub kind: UserKind,
}

/// The lifetime of a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct SessionTimes {
    /// Login time (RFC 3339, UTC).
    pub created_at: String,
    /// The session ends at this time if it is not used before (RFC 3339, UTC).
    pub idle_expires_at: String,
    /// The session ends at this time at the latest (RFC 3339, UTC).
    pub absolute_expires_at: String,
}

/// `GET /api/v1/auth/session`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct SessionState {
    /// Whether the request carried a valid session.
    pub authenticated: bool,
    /// Send this in the `X-CSRF-Token` header of every write (the browser keeps the matching
    /// cookie).
    #[schema(example = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0")]
    pub csrf_token: String,
    /// The account (only with a session).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<SessionUser>,
    /// The lifetime (only with a session).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionTimes>,
}

/// `DELETE /api/v1/auth/sessions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub struct EndedSessions {
    /// How many sessions were ended (the current one included).
    pub ended: u64,
}

/// Adds the headers that delete both cookies.
fn clear_cookies(response: &mut Response) {
    append_cookie(response.headers_mut(), &SESSION_COOKIE.clear());
    append_cookie(response.headers_mut(), &CSRF_COOKIE.clear());
}

fn no_session() -> Problem {
    Problem::with_detail(ProblemKind::Unauthenticated, "there is no session")
}

async fn session_state(state: &AppState, request: Request<Body>) -> Result<Response, Problem> {
    let (parts, _body) = request.into_parts();
    let authentication = Authentication::of(&parts);
    let session = authentication.session();
    let reusable = csrf_cookie(&parts.headers)
        .filter(|token| session.is_none_or(|session| bound_to(token, session)));
    let (token, fresh) = match reusable {
        Some(token) => (token, false),
        None => (new_token()?, true),
    };
    // A fresh token is kept (bound to the session, set as a cookie) only when the request may
    // bind one: a cross-site navigation carries the Lax session cookie but not the Strict CSRF
    // cookie, and must not be able to replace the token the user's open tabs use (#135).
    let keep = fresh && (session.is_none() || may_bind_csrf(&parts.headers));
    if let (true, Some(session)) = (keep, session) {
        let id = session.id;
        let hash = token_hash(&token);
        let _bound = state.db(move |db| db.set_session_csrf(id, &hash)).await?;
    }
    let timeouts = state.auth().timeouts;
    let (user, times) = match session {
        None => (None, None),
        Some(session) => (
            Some(SessionUser {
                login: session.user.login.clone(),
                role: session.user.role,
                kind: session.user.kind,
            }),
            Some(SessionTimes {
                created_at: rfc3339(session.created_at)?,
                idle_expires_at: rfc3339(session.last_seen_at.saturating_add(timeouts.idle_ms))?,
                absolute_expires_at: rfc3339(
                    session.created_at.saturating_add(timeouts.absolute_ms),
                )?,
            }),
        ),
    };
    let mut response = Json(SessionState {
        authenticated: session.is_some(),
        csrf_token: token.to_hex(),
        user,
        session: times,
    })
    .into_response();
    if keep {
        append_cookie(response.headers_mut(), &CSRF_COOKIE.set(&token, None));
    }
    Ok(response)
}

/// `GET /api/v1/auth/session`.
#[utoipa::path(
    get,
    path = "/api/v1/auth/session",
    tag = "auth",
    operation_id = "getSession",
    responses(
        (status = 200, description = "Who the client is, and the CSRF token for writes (sets the CSRF cookie when needed)", body = SessionState),
    ),
)]
pub async fn get_session(State(state): State<AppState>, request: Request<Body>) -> Response {
    session_state(&state, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn end_session(state: &AppState, request: Request<Body>) -> Result<Response, Problem> {
    let (parts, _body) = request.into_parts();
    let session = Authentication::of(&parts)
        .session()
        .cloned()
        .ok_or_else(no_session)?;
    let now = state.now_millis();
    let _ended = state.db(move |db| db.end_session(session.id, now)).await?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    clear_cookies(&mut response);
    Ok(response)
}

/// `DELETE /api/v1/auth/session` (logout).
#[utoipa::path(
    delete,
    path = "/api/v1/auth/session",
    tag = "auth",
    operation_id = "deleteSession",
    params(
        ("X-CSRF-Token" = Option<String>, Header, description = "The CSRF token from GET /api/v1/auth/session (required for browser sessions; the generated client adds it when given `csrfToken`)"),
    ),
    responses(
        (status = 204, description = "The session has ended; both cookies are deleted"),
        (status = 401, description = "There is no session", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "Origin or CSRF check failed", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn delete_session(State(state): State<AppState>, request: Request<Body>) -> Response {
    end_session(&state, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn end_all_sessions(state: &AppState, request: Request<Body>) -> Result<Response, Problem> {
    let (parts, _body) = request.into_parts();
    let session = Authentication::of(&parts)
        .session()
        .cloned()
        .ok_or_else(no_session)?;
    let now = state.now_millis();
    let user_id = session.user.id;
    let ended = state
        .db(move |db| db.end_user_sessions(user_id, Some(&actor(user_id)), now))
        .await?;
    let mut response = Json(EndedSessions {
        ended: u64::try_from(ended).unwrap_or(u64::MAX),
    })
    .into_response();
    clear_cookies(&mut response);
    Ok(response)
}

/// `DELETE /api/v1/auth/sessions` (logout everywhere).
#[utoipa::path(
    delete,
    path = "/api/v1/auth/sessions",
    tag = "auth",
    operation_id = "deleteSessions",
    params(
        ("X-CSRF-Token" = Option<String>, Header, description = "The CSRF token from GET /api/v1/auth/session (required for browser sessions; the generated client adds it when given `csrfToken`)"),
    ),
    responses(
        (status = 200, description = "Every session of the account has ended; both cookies are deleted", body = EndedSessions),
        (status = 401, description = "There is no session", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "Origin or CSRF check failed", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn delete_sessions(State(state): State<AppState>, request: Request<Body>) -> Response {
    end_all_sessions(&state, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}
