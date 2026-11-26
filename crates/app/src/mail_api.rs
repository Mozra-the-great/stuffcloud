//! The HTTP side of the optional mailer (A-10, ADR 0015).
//!
//! - `GET /api/v1/features` (public): what this instance can do that depends on its set-up.
//!   Today that is `mail`: whether the settings group `smtp` exists. A client reads it before it
//!   offers "forgot your password?", and says why when mail is off (an admin hands out reset
//!   links instead). It tells nothing about accounts.
//! - `POST /api/v1/auth/password-reset/request` (public): asks for a reset link by e-mail. The
//!   answer is `202` with no body for every login name or address, known or not, an admin
//!   account or an account without an address, so it tells nothing about which accounts exist;
//!   the work happens after the answer ([`crate::mail`]). Without mail it is `409
//!   mail-not-configured`, which does not depend on the account either. The client address is
//!   throttled for every request, and an account gets at most one token per
//!   [`crate::mail::RESET_COOLDOWN_MS`]. The mail goes only to the address stored for the account,
//!   never to one from the request. The link in it is redeemed with
//!   `POST /api/v1/auth/password-reset`.

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use stuffcloud_core::account::Identifier;
use stuffcloud_core::mail::ResetMailRequest;
use utoipa::ToSchema;

use crate::accounts::{REASON_THROTTLED, client_of, parse_body};
use crate::auth::note_rejection;
use crate::mail::{QUEUE_FULL_WAIT_MS, Rejected, ResetJob, smtp_settings};
use crate::problem::{Problem, ProblemBody, ProblemKind};
use crate::state::AppState;

/// Route of the features below `/api/v1`.
pub const FEATURES_PATH: &str = "/features";
/// Route of the request for a reset link by e-mail below `/api/v1`.
pub const RESET_REQUEST_PATH: &str = "/auth/password-reset/request";

/// What this instance can do that depends on how it is set up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub struct Features {
    /// Whether the instance can send mail (the settings group `smtp` exists): with it an account
    /// can ask for a password reset link itself, without it an admin issues the link.
    pub mail: bool,
}

async fn features_inner(state: &AppState) -> Result<Response, Problem> {
    let mail = smtp_settings(state).await?.is_some();
    Ok(Json(Features { mail }).into_response())
}

/// `GET /api/v1/features`.
#[utoipa::path(
    get,
    path = "/api/v1/features",
    tag = "operations",
    operation_id = "getFeatures",
    responses(
        (status = 200, description = "What this instance can do", body = Features),
    ),
)]
pub async fn get_features(State(state): State<AppState>) -> Response {
    features_inner(&state)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn request_inner(state: &AppState, request: Request<Body>) -> Result<Response, Problem> {
    let (parts, body) = request.into_parts();
    let form: ResetMailRequest = parse_body(state, &parts, body).await?;
    if smtp_settings(state).await?.is_none() {
        return Err(Problem::with_detail(
            ProblemKind::MailNotConfigured,
            "this instance sends no mail: ask an administrator for a reset link",
        ));
    }
    if let Some(wait) = state
        .accounts()
        .throttles()
        .reset_request_attempt(client_of(state, &parts).bucket, state.now_millis())
    {
        note_rejection(state, REASON_THROTTLED, parts.method.as_str());
        return Err(Problem::too_many_requests(wait));
    }
    // Text that is neither a login name nor an address names no account: answered like any
    // other request, so the answer says nothing about the rules for names.
    if let Some(identifier) = Identifier::from_input(&form.login) {
        let job = ResetJob {
            identifier,
            language: form.language(),
        };
        state
            .mailer()
            .submit(job)
            .map_err(|rejected| match rejected {
                Rejected::Full => Problem::mail_busy(QUEUE_FULL_WAIT_MS),
                Rejected::Unavailable => Problem::internal(&"the mailer is not running"),
            })?;
    }
    Ok(StatusCode::ACCEPTED.into_response())
}

/// `POST /api/v1/auth/password-reset/request`.
#[utoipa::path(
    post,
    path = "/api/v1/auth/password-reset/request",
    tag = "auth",
    operation_id = "requestPasswordReset",
    params(
        ("X-CSRF-Token" = String, Header, description = "The CSRF token from GET /api/v1/auth/session"),
    ),
    request_body(content = ResetMailRequest, description = "The login name or e-mail address, and the language of the mail"),
    responses(
        (status = 202, description = "Accepted: if the account exists, has an e-mail address, is not an admin and was not sent a link in the last 5 minutes, a mail with a reset link is on its way (the answer is the same for every account)"),
        (status = 400, description = "Malformed body", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "Origin or CSRF check failed", body = ProblemBody, content_type = "application/problem+json"),
        (status = 409, description = "This instance sends no mail (mail-not-configured); ask an administrator for a link", body = ProblemBody, content_type = "application/problem+json"),
        (status = 415, description = "Body is not JSON", body = ProblemBody, content_type = "application/problem+json"),
        (status = 422, description = "Invalid fields (empty or too long)", body = ProblemBody, content_type = "application/problem+json"),
        (status = 429, description = "Too many requests from this client, or too many mails waiting; see Retry-After", body = ProblemBody, content_type = "application/problem+json",
            headers(("Retry-After" = u64, description = "Seconds until the next request is taken"))),
    ),
)]
pub async fn request_password_reset(
    State(state): State<AppState>,
    request: Request<Body>,
) -> Response {
    request_inner(&state, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}
