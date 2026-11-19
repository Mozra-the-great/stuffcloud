//! Settings groups (SPEC 10.2/10.3): `/api/v1/settings/<group>`.
//!
//! A settings group is a singleton resource. One that was never written does not exist
//! (`GET` answers 404) and its defaults apply; `DELETE` resets it to the defaults.

use axum::body::Body;
use axum::extract::State;
use axum::http::Request;
use axum::response::{IntoResponse, Response};
use stuffcloud_core::settings::{ReservedNames, Signup};

use crate::problem::ProblemBody;
use crate::resource::{self, Envelope, WriteResult};
use crate::state::AppState;

/// Resource kind of the settings groups in the store and the audit log.
pub const KIND: &str = "settings";

/// Route of the `reserved-names` group below `/api/v1`.
pub const RESERVED_NAMES_PATH: &str = "/settings/reserved-names";

/// Route of the `signup` group below `/api/v1`.
pub const SIGNUP_PATH: &str = "/settings/signup";

/// `GET /api/v1/settings/reserved-names`.
#[utoipa::path(
    get,
    path = "/api/v1/settings/reserved-names",
    tag = "settings",
    operation_id = "getReservedNames",
    responses(
        (status = 200, description = "The reserved names", body = Envelope<ReservedNames>,
            headers(("ETag" = String, description = "Strong entity tag, for If-Match"))),
        (status = 404, description = "Never written; the defaults (no names) apply", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn get_reserved_names(State(state): State<AppState>) -> Response {
    resource::get::<ReservedNames>(&state, KIND, ReservedNames::GROUP)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

/// `PUT /api/v1/settings/reserved-names`.
#[utoipa::path(
    put,
    path = "/api/v1/settings/reserved-names",
    tag = "settings",
    operation_id = "putReservedNames",
    params(
        ("dry_run" = Option<bool>, Query, description = "Validate and report the diff, change nothing"),
        ("If-Match" = Option<String>, Header, description = "Write only if the current ETag matches"),
        ("If-None-Match" = Option<String>, Header, description = "`*`: create only"),
    ),
    request_body(content = ReservedNames, description = "The full writable shape; a `meta` member is ignored"),
    responses(
        (status = 200, description = "Updated or unchanged (or a dry run)", body = WriteResult<ReservedNames>),
        (status = 201, description = "Created", body = WriteResult<ReservedNames>),
        (status = 400, description = "Malformed body, header or query", body = ProblemBody, content_type = "application/problem+json"),
        (status = 401, description = "Not authenticated", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "Authenticated, but the account or token lacks the permission admin:settings:write (docs/api/permissions.md)", body = ProblemBody, content_type = "application/problem+json"),
        (status = 412, description = "If-Match / If-None-Match failed", body = ProblemBody, content_type = "application/problem+json"),
        (status = 413, description = "Body too large", body = ProblemBody, content_type = "application/problem+json"),
        (status = 415, description = "Body is not JSON", body = ProblemBody, content_type = "application/problem+json"),
        (status = 422, description = "Invalid fields, all of them listed", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn put_reserved_names(State(state): State<AppState>, request: Request<Body>) -> Response {
    resource::put::<ReservedNames>(&state, request, KIND, ReservedNames::GROUP)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

/// `DELETE /api/v1/settings/reserved-names` (reset to the defaults).
#[utoipa::path(
    delete,
    path = "/api/v1/settings/reserved-names",
    tag = "settings",
    operation_id = "deleteReservedNames",
    params(
        ("dry_run" = Option<bool>, Query, description = "Report what would be deleted, change nothing"),
        ("If-Match" = Option<String>, Header, description = "Delete only if the current ETag matches"),
    ),
    responses(
        (status = 200, description = "Deleted (or a dry run)", body = WriteResult<ReservedNames>),
        (status = 400, description = "Malformed header or query", body = ProblemBody, content_type = "application/problem+json"),
        (status = 401, description = "Not authenticated", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "Authenticated, but the account or token lacks the permission admin:settings:write (docs/api/permissions.md)", body = ProblemBody, content_type = "application/problem+json"),
        (status = 404, description = "Never written", body = ProblemBody, content_type = "application/problem+json"),
        (status = 412, description = "If-Match failed", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn delete_reserved_names(
    State(state): State<AppState>,
    request: Request<Body>,
) -> Response {
    let (parts, _body) = request.into_parts();
    resource::delete::<ReservedNames>(&state, &parts, KIND, ReservedNames::GROUP)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

/// `GET /api/v1/settings/signup`.
#[utoipa::path(
    get,
    path = "/api/v1/settings/signup",
    tag = "settings",
    operation_id = "getSignup",
    responses(
        (status = 200, description = "The sign-up mode", body = Envelope<Signup>,
            headers(("ETag" = String, description = "Strong entity tag, for If-Match"))),
        (status = 404, description = "Never written; the default mode invite-only applies", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn get_signup(State(state): State<AppState>) -> Response {
    resource::get::<Signup>(&state, KIND, Signup::GROUP)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

/// `PUT /api/v1/settings/signup`.
#[utoipa::path(
    put,
    path = "/api/v1/settings/signup",
    tag = "settings",
    operation_id = "putSignup",
    params(
        ("dry_run" = Option<bool>, Query, description = "Validate and report the diff, change nothing"),
        ("If-Match" = Option<String>, Header, description = "Write only if the current ETag matches"),
        ("If-None-Match" = Option<String>, Header, description = "`*`: create only"),
    ),
    request_body(content = Signup, description = "The full writable shape; a `meta` member is ignored"),
    responses(
        (status = 200, description = "Updated or unchanged (or a dry run)", body = WriteResult<Signup>),
        (status = 201, description = "Created", body = WriteResult<Signup>),
        (status = 400, description = "Malformed body, header or query", body = ProblemBody, content_type = "application/problem+json"),
        (status = 401, description = "Not authenticated", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "Authenticated, but the account or token lacks the permission admin:settings:write (docs/api/permissions.md)", body = ProblemBody, content_type = "application/problem+json"),
        (status = 412, description = "If-Match / If-None-Match failed", body = ProblemBody, content_type = "application/problem+json"),
        (status = 413, description = "Body too large", body = ProblemBody, content_type = "application/problem+json"),
        (status = 415, description = "Body is not JSON", body = ProblemBody, content_type = "application/problem+json"),
        (status = 422, description = "Invalid fields, all of them listed", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn put_signup(State(state): State<AppState>, request: Request<Body>) -> Response {
    resource::put::<Signup>(&state, request, KIND, Signup::GROUP)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

/// `DELETE /api/v1/settings/signup` (reset to the defaults).
#[utoipa::path(
    delete,
    path = "/api/v1/settings/signup",
    tag = "settings",
    operation_id = "deleteSignup",
    params(
        ("dry_run" = Option<bool>, Query, description = "Report what would be deleted, change nothing"),
        ("If-Match" = Option<String>, Header, description = "Delete only if the current ETag matches"),
    ),
    responses(
        (status = 200, description = "Deleted (or a dry run)", body = WriteResult<Signup>),
        (status = 400, description = "Malformed header or query", body = ProblemBody, content_type = "application/problem+json"),
        (status = 401, description = "Not authenticated", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "Authenticated, but the account or token lacks the permission admin:settings:write (docs/api/permissions.md)", body = ProblemBody, content_type = "application/problem+json"),
        (status = 404, description = "Never written", body = ProblemBody, content_type = "application/problem+json"),
        (status = 412, description = "If-Match failed", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn delete_signup(State(state): State<AppState>, request: Request<Body>) -> Response {
    let (parts, _body) = request.into_parts();
    resource::delete::<Signup>(&state, &parts, KIND, Signup::GROUP)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}
