//! Administration of local accounts (A-03): invitations for the sign-up mode `invite-only` and
//! password reset links issued by an admin (the reset path without e-mail, SPEC 6).
//!
//! - `POST /api/v1/admin/invitations` (`admin:users:write`): a new invitation, optionally for
//!   one e-mail address, valid for 1 to 720 hours. The answer carries the token once (and a
//!   link with it); the database keeps only its hash.
//! - `GET /api/v1/admin/invitations` (`admin:users:read`): the pending invitations, without
//!   tokens.
//! - `DELETE /api/v1/admin/invitations/{id}` (`admin:users:write`): revokes one.
//! - `POST /api/v1/admin/users/{login}/password-reset` (`admin:users:write`): a reset token for
//!   the account, valid for 60 minutes and once; an older one of the account stops working. The
//!   admin hands the link over; the account sets its own password with
//!   `POST /api/v1/auth/password-reset`. The operator's command line does the same without an
//!   admin session (`stuffcloud-app reset-link <login>`), for the case that no admin can log in.
//!   A link for an admin account comes only from the command line: through the API a stolen
//!   admin session (or admin token) could otherwise take over every other admin account, and a
//!   re-authentication step would not help an API token (#147).
//!   With an SMTP server (A-10, [`crate::mail_api`]) the account asks for the link itself and gets
//!   it by e-mail; never for an admin account.
//!
//! Links put the token after `#`, so it never reaches a server log or a `Referer` header; the
//! web pages that read them come with the account UI.

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use stuffcloud_core::account::{Email, InvitationRequest, Login};
use stuffcloud_core::csrf::Origin;
use stuffcloud_core::session::HOUR_MS;
use stuffcloud_core::token::Token;
use stuffcloud_db::{Invitation, InvitationOutcome, ResetIssue, token_hash};
use utoipa::ToSchema;

use crate::accounts::{RESET_TTL_MS, parse_body};
use crate::auth::{Authentication, new_token};
use crate::problem::{Problem, ProblemBody, ProblemKind};
use crate::resource::rfc3339;
use crate::state::AppState;

/// Route of the invitations below `/api/v1`.
pub const INVITATIONS_PATH: &str = "/admin/invitations";
/// Route of one invitation below `/api/v1`.
pub const INVITATION_PATH: &str = "/admin/invitations/{id}";
/// Route of an admin-issued reset link below `/api/v1`.
pub const RESET_LINK_PATH: &str = "/admin/users/{login}/password-reset";

/// Why the API issues no reset link for an admin account.
pub const ADMIN_RESET_REFUSED: &str =
    "reset links for admin accounts are issued only on the host: stuffcloud-app reset-link <login>";

/// The link of an invitation.
#[must_use]
pub fn invitation_link(app: &Origin, token: &Token) -> String {
    format!("{app}/register#invitation={}", token.to_hex())
}

/// The link of a password reset.
#[must_use]
pub fn reset_link(app: &Origin, token: &Token) -> String {
    format!("{app}/password-reset#token={}", token.to_hex())
}

/// A pending invitation (`GET`, never with its token).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct InvitationView {
    /// Id (to revoke it).
    pub id: i64,
    /// The only e-mail address that may use it, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Creation time (RFC 3339, UTC).
    pub created_at: String,
    /// Expiry (RFC 3339, UTC).
    pub expires_at: String,
}

impl InvitationView {
    fn of(invitation: Invitation) -> Result<Self, Problem> {
        Ok(Self {
            id: invitation.id,
            email: invitation.email,
            created_at: rfc3339(invitation.created_at)?,
            expires_at: rfc3339(invitation.expires_at)?,
        })
    }
}

/// `GET /api/v1/admin/invitations`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct InvitationList {
    /// The pending invitations, oldest first.
    pub invitations: Vec<InvitationView>,
}

/// `POST /api/v1/admin/invitations`: the only time the token is shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct InvitationCreated {
    /// The invitation.
    #[serde(flatten)]
    pub invitation: InvitationView,
    /// The token for `POST /api/v1/auth/register` (`invitation`).
    pub token: String,
    /// The registration link with the token.
    pub link: String,
}

/// A password reset link: the only time the token is shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct ResetLink {
    /// The token for `POST /api/v1/auth/password-reset`.
    pub token: String,
    /// The reset link with the token.
    pub link: String,
    /// Expiry (RFC 3339, UTC).
    pub expires_at: String,
}

/// The admin behind a request (the guard admits only requests with an account).
fn admin_id(request_parts: &axum::http::request::Parts) -> Result<i64, Problem> {
    Authentication::of(request_parts)
        .user()
        .map(|user| user.id)
        .ok_or_else(|| {
            Problem::with_detail(
                ProblemKind::Unauthenticated,
                "this needs a login or an API token",
            )
        })
}

async fn create_inner(state: &AppState, request: Request<Body>) -> Result<Response, Problem> {
    let (parts, body) = request.into_parts();
    let actor = admin_id(&parts)?;
    let form: InvitationRequest = parse_body(state, &parts, body).await?;
    let email = form
        .email
        .as_deref()
        .map(Email::parse)
        .transpose()
        .map_err(|error| Problem::internal(&error))?;
    let token = new_token()?;
    let hash = token_hash(&token);
    let now = state.now_millis();
    let expires_at = now.saturating_add(i64::from(form.hours()).saturating_mul(HOUR_MS));
    let outcome = state
        .db(move |db| db.create_invitation(&hash, email.as_ref(), actor, expires_at, now))
        .await?;
    let invitation = match outcome {
        InvitationOutcome::Created(invitation) => invitation,
        InvitationOutcome::TooMany => {
            return Err(Problem::with_detail(
                ProblemKind::LimitReached,
                format!(
                    "{} invitations are pending; revoke some or let them expire",
                    stuffcloud_db::accounts::MAX_PENDING_INVITATIONS
                ),
            ));
        }
    };
    let created = InvitationCreated {
        invitation: InvitationView::of(invitation)?,
        link: invitation_link(&state.auth().app_origin, &token),
        token: token.to_hex(),
    };
    Ok((StatusCode::CREATED, Json(created)).into_response())
}

/// `POST /api/v1/admin/invitations`.
#[utoipa::path(
    post,
    path = "/api/v1/admin/invitations",
    tag = "admin",
    operation_id = "createInvitation",
    params(
        ("X-CSRF-Token" = Option<String>, Header, description = "The CSRF token from GET /api/v1/auth/session (required for browser sessions)"),
    ),
    request_body(content = InvitationRequest, description = "Optionally the e-mail address it is for and its lifetime"),
    responses(
        (status = 201, description = "Created; the token is shown only now", body = InvitationCreated),
        (status = 400, description = "Malformed body", body = ProblemBody, content_type = "application/problem+json"),
        (status = 401, description = "Not authenticated", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "The account or token lacks the permission admin:users:write, or the Origin or CSRF check failed", body = ProblemBody, content_type = "application/problem+json"),
        (status = 409, description = "Too many invitations are pending", body = ProblemBody, content_type = "application/problem+json"),
        (status = 415, description = "Body is not JSON", body = ProblemBody, content_type = "application/problem+json"),
        (status = 422, description = "Invalid fields", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn create_invitation(State(state): State<AppState>, request: Request<Body>) -> Response {
    create_inner(&state, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn list_inner(state: &AppState) -> Result<Response, Problem> {
    let now = state.now_millis();
    let pending = state.db(move |db| db.pending_invitations(now)).await?;
    let invitations = pending
        .into_iter()
        .map(InvitationView::of)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(InvitationList { invitations }).into_response())
}

/// `GET /api/v1/admin/invitations`.
#[utoipa::path(
    get,
    path = "/api/v1/admin/invitations",
    tag = "admin",
    operation_id = "listInvitations",
    responses(
        (status = 200, description = "The pending invitations (without tokens)", body = InvitationList),
        (status = 401, description = "Not authenticated", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "The account or token lacks the permission admin:users:read", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn list_invitations(State(state): State<AppState>) -> Response {
    list_inner(&state)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn revoke_inner(
    state: &AppState,
    id: &str,
    request: Request<Body>,
) -> Result<Response, Problem> {
    let (parts, _body) = request.into_parts();
    let actor = admin_id(&parts)?;
    let missing = || {
        Problem::with_detail(
            ProblemKind::NotFound,
            format!("invitation {id:?} does not exist"),
        )
    };
    let id: i64 = id.parse().map_err(|_not_a_number| missing())?;
    let now = state.now_millis();
    if state
        .db(move |db| db.revoke_invitation(id, actor, now))
        .await?
    {
        Ok(StatusCode::NO_CONTENT.into_response())
    } else {
        Err(missing())
    }
}

/// `DELETE /api/v1/admin/invitations/{id}`.
#[utoipa::path(
    delete,
    path = "/api/v1/admin/invitations/{id}",
    tag = "admin",
    operation_id = "revokeInvitation",
    params(
        ("id" = String, Path, description = "The id of the invitation"),
        ("X-CSRF-Token" = Option<String>, Header, description = "The CSRF token from GET /api/v1/auth/session (required for browser sessions)"),
    ),
    responses(
        (status = 204, description = "Revoked"),
        (status = 401, description = "Not authenticated", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "The account or token lacks the permission admin:users:write, or the Origin or CSRF check failed", body = ProblemBody, content_type = "application/problem+json"),
        (status = 404, description = "No pending invitation has this id", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn revoke_invitation(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request<Body>,
) -> Response {
    revoke_inner(&state, &id, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

/// What issuing a reset link did.
#[derive(Debug)]
pub enum Issued {
    /// The link (with its token) and its expiry.
    Link(ResetLink),
    /// No account has this login name.
    UnknownUser,
    /// A service account has no password.
    ServiceAccount,
    /// An admin account: only the operator's command line issues its links.
    AdminAccount,
}

/// Issues a password reset link for `login` (`actor`: the admin, `None` for the operator's
/// command line). Shared by the API and `stuffcloud-app reset-link`.
///
/// # Errors
///
/// A sentence when the random source or the database fails.
pub fn issue_reset_link(
    db: &stuffcloud_db::Database,
    app: &Origin,
    login: &Login,
    actor: Option<i64>,
    now: i64,
) -> Result<Issued, String> {
    let mut bytes = [0_u8; stuffcloud_core::token::TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    let token = Token::from_bytes(bytes);
    let expires_at = now.saturating_add(RESET_TTL_MS);
    let issued = db
        .issue_password_reset(login, &token_hash(&token), actor, expires_at, now)
        .map_err(|error| error.to_string())?;
    Ok(match issued {
        ResetIssue::Issued(_user) => Issued::Link(ResetLink {
            link: reset_link(app, &token),
            token: token.to_hex(),
            expires_at: rfc3339(expires_at)
                .map_err(|_bad| "the expiry is out of range".to_owned())?,
        }),
        ResetIssue::UnknownUser => Issued::UnknownUser,
        ResetIssue::ServiceAccount => Issued::ServiceAccount,
        ResetIssue::AdminAccount => Issued::AdminAccount,
    })
}

async fn reset_inner(
    state: &AppState,
    login: &str,
    request: Request<Body>,
) -> Result<Response, Problem> {
    let (parts, _body) = request.into_parts();
    let actor = admin_id(&parts)?;
    let missing = || {
        Problem::with_detail(
            ProblemKind::NotFound,
            format!("no account is named {login:?}"),
        )
    };
    let login = Login::parse(login).map_err(|_invalid| missing())?;
    let app = state.auth().app_origin.clone();
    let now = state.now_millis();
    let issued = state
        .db_outcome(move |db| {
            Ok::<_, stuffcloud_db::DbError>(issue_reset_link(db, &app, &login, Some(actor), now))
        })
        .await?
        .map_err(|error| Problem::internal(&error))?
        .map_err(|error| Problem::internal(&error))?;
    match issued {
        Issued::Link(link) => Ok((StatusCode::CREATED, Json(link)).into_response()),
        Issued::UnknownUser => Err(missing()),
        Issued::ServiceAccount => Err(Problem::with_detail(
            ProblemKind::Forbidden,
            "service accounts have no password; use an API token",
        )),
        Issued::AdminAccount => Err(Problem::with_detail(
            ProblemKind::Forbidden,
            ADMIN_RESET_REFUSED,
        )),
    }
}

/// `POST /api/v1/admin/users/{login}/password-reset`.
#[utoipa::path(
    post,
    path = "/api/v1/admin/users/{login}/password-reset",
    tag = "admin",
    operation_id = "createPasswordResetLink",
    params(
        ("login" = String, Path, description = "The login name of the account"),
        ("X-CSRF-Token" = Option<String>, Header, description = "The CSRF token from GET /api/v1/auth/session (required for browser sessions)"),
    ),
    responses(
        (status = 201, description = "The reset link; the token is shown only now and works once within 60 minutes", body = ResetLink),
        (status = 401, description = "Not authenticated", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "The account or token lacks the permission admin:users:write, the account is a service account or an admin account (their links come only from `stuffcloud-app reset-link`), or the Origin or CSRF check failed", body = ProblemBody, content_type = "application/problem+json"),
        (status = 404, description = "No account has this login name", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn create_reset_link(
    State(state): State<AppState>,
    Path(login): Path<String>,
    request: Request<Body>,
) -> Response {
    reset_inner(&state, &login, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_carry_the_token_after_the_hash() {
        let app = Origin::parse(b"https://app.example.com").unwrap();
        let token = Token::from_bytes([0xab; 32]);
        let hex = "ab".repeat(32);
        assert_eq!(
            invitation_link(&app, &token),
            format!("https://app.example.com/register#invitation={hex}")
        );
        assert_eq!(
            reset_link(&app, &token),
            format!("https://app.example.com/password-reset#token={hex}")
        );
    }

    #[test]
    fn handlers_refuse_a_request_without_an_account() {
        let parts = Request::new(()).into_parts().0;
        assert_eq!(
            admin_id(&parts).unwrap_err().kind(),
            ProblemKind::Unauthenticated
        );
    }
}
