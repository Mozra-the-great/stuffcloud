//! The OpenAPI document, generated from the handlers (`utoipa`, SPEC 10.1).
//!
//! `stuffcloud-app openapi` prints it; CI compares the output with the committed
//! `docs/api/openapi.json` and regenerates the TypeScript client of `web/` from it, so a
//! handler change without a regenerated client fails `build`. `GET /api/v1/openapi.json`
//! serves the same document.

use axum::Json;
use utoipa::OpenApi;
use utoipa::openapi::OpenApi as Document;

use crate::accounts::{self, AccountProfile};
use crate::health::{self, HealthStatus};
use crate::invitations::{self, InvitationCreated, InvitationList, InvitationView, ResetLink};
use crate::metrics;
use crate::problem::ProblemBody;
use crate::resource::{FieldChange, ResourceMeta, WriteChange};
use crate::sessions::{self, EndedSessions, SessionState, SessionTimes, SessionUser};
use crate::settings;
use stuffcloud_core::account::{
    InvitationRequest, LoginRequest, PasswordChangeRequest, PasswordResetRequest, RegisterRequest,
};

/// The API description.
#[derive(Debug, OpenApi)]
#[openapi(
    info(
        title = "stuffcloud API",
        description = "LAN API of stuffcloud (ADR 0010). Errors are RFC 9457 problem details; resources follow the conventions of docs/adr/0010-api-first-and-configuration-as-code.md. Browser clients authenticate with the __Host-stuffcloud-session cookie; every write without an Authorization header needs an Origin header equal to the app address and the X-CSRF-Token header from GET /api/v1/auth/session (docs/api/problems.md#csrf-rejected).",
        license(name = "GPL-3.0-or-later", identifier = "GPL-3.0-or-later"),
    ),
    paths(
        health::live,
        health::ready,
        metrics::render,
        openapi_json,
        sessions::get_session,
        sessions::delete_session,
        sessions::delete_sessions,
        accounts::login,
        accounts::register,
        accounts::reset_password,
        accounts::get_account,
        accounts::change_password,
        invitations::create_invitation,
        invitations::list_invitations,
        invitations::revoke_invitation,
        invitations::create_reset_link,
        settings::get_reserved_names,
        settings::put_reserved_names,
        settings::delete_reserved_names,
        settings::get_signup,
        settings::put_signup,
        settings::delete_signup,
    ),
    components(schemas(
        HealthStatus,
        ProblemBody,
        ResourceMeta,
        FieldChange,
        WriteChange,
        SessionState,
        SessionUser,
        SessionTimes,
        EndedSessions,
        LoginRequest,
        RegisterRequest,
        PasswordResetRequest,
        PasswordChangeRequest,
        AccountProfile,
        InvitationRequest,
        InvitationCreated,
        InvitationView,
        InvitationList,
        ResetLink,
    )),
    tags(
        (name = "operations", description = "Probes, metrics and the API description"),
        (name = "auth", description = "Sessions, the CSRF token, login, registration and password reset (SPEC 5.5 and 6)"),
        (name = "account", description = "The caller's own account (SPEC 6)"),
        (name = "admin", description = "Administration: invitations and reset links (SPEC 6)"),
        (name = "settings", description = "Instance-wide settings groups (SPEC 10.3)"),
    ),
)]
pub struct ApiDoc;

/// The document.
#[must_use]
pub fn document() -> Document {
    ApiDoc::openapi()
}

/// The document as pretty-printed JSON with a final line break (the committed form).
///
/// # Errors
///
/// Only if serialisation fails, which it does not for this document.
pub fn to_json() -> Result<String, serde_json::Error> {
    document().to_pretty_json().map(|mut json| {
        json.push('\n');
        json
    })
}

/// `GET /api/v1/openapi.json`.
#[utoipa::path(
    get,
    path = "/api/v1/openapi.json",
    tag = "operations",
    operation_id = "openapi",
    responses((status = 200, description = "This document", content_type = "application/json", body = Object)),
)]
pub async fn openapi_json() -> Json<Document> {
    Json(document())
}
