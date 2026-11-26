//! Local accounts (A-03, SPEC 6, ADR 0005 addendum "local accounts"): log in, register, redeem a
//! password reset, change the password, and the account's own profile.
//!
//! - `POST /api/v1/auth/login` (public): login name or e-mail address and password. An unknown
//!   account, a service account, an account without a password and a wrong password get the
//!   same answer (401 `invalid-credentials`, byte for byte), after the same work: one Argon2
//!   check, against a dummy hash when there is no stored one. The throttles
//!   ([`crate::throttle`]) reserve the attempt before anything is looked up and count by the
//!   typed text, so they treat unknown and known accounts alike too; once the lookup found an
//!   account, its id is counted as well. An account throttled by its id (failures under its
//!   other name) gets the same 401 after a check against the dummy hash, so the password is not
//!   tried and the answer does not tell that the two names belong together. A success starts a new session
//!   through [`crate::auth::start_session`] (the presented session ends: no fixation) and
//!   answers with the session state and its new CSRF token.
//! - `POST /api/v1/auth/register` (public): creates an account as the sign-up mode allows
//!   (`open`, `invite-only` with an invitation, never in `oidc-only`) and logs it in.
//! - `POST /api/v1/auth/password-reset` (public): redeems a reset token (single use, 60 minutes)
//!   and sets a new password; every session of the account ends.
//! - `GET /api/v1/account` and `POST /api/v1/account/password` (`account:read` / `account:write`):
//!   the own profile, and a password change that needs the current password and ends the
//!   account's other sessions.
//!
//! Anonymous writes pass the `Origin` and CSRF checks of [`crate::auth::authenticate`] like
//! every other write (#134), so a foreign page cannot log a browser in or register it.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use axum::Json;
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::request::Parts;
use axum::http::{HeaderName, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use stuffcloud_core::account::{
    Email, Identifier, Login, LoginRequest, PasswordChangeRequest, PasswordContext,
    PasswordResetRequest, RegisterRequest,
};
use stuffcloud_core::body::{Action, BodyError, parse_action};
use stuffcloud_core::client_ip::{Bucket, ProxyList, client_address, unlisted_proxy};
use stuffcloud_core::field::{FieldError, FieldErrorCode, JsonPointer};
use stuffcloud_core::session::{MINUTE_MS, Role, UserKind};
use stuffcloud_core::settings::{Signup, SignupMode};
use stuffcloud_core::token::Token;
use stuffcloud_db::auth::{USER_KIND, actor};
use stuffcloud_db::{NewAccount, Registration, Session, token_hash};
use utoipa::ToSchema;

use crate::auth::{Authentication, IssuedTokens, note_rejection, start_session};
use crate::password::Passwords;
use crate::problem::{Problem, ProblemBody, ProblemKind};
use crate::resource::{read_body, require_json, rfc3339};
use crate::sampler::{KeyedLimiter, LogSampler};
use crate::sessions::{SessionState, describe};
use crate::settings::KIND as SETTINGS_KIND;
use crate::state::AppState;
use crate::throttle::{Reservation, Throttles, account_key, id_key};

/// Route of the login below `/api/v1`.
pub const LOGIN_PATH: &str = "/auth/login";
/// Route of the registration below `/api/v1`.
pub const REGISTER_PATH: &str = "/auth/register";
/// Route of the reset redemption below `/api/v1`.
pub const RESET_PATH: &str = "/auth/password-reset";
/// Route of the own account below `/api/v1`.
pub const ACCOUNT_PATH: &str = "/account";
/// Route of the password change below `/api/v1`.
pub const PASSWORD_PATH: &str = "/account/password";

/// How long a password reset token is valid (60 minutes).
pub const RESET_TTL_MS: i64 = 60 * MINUTE_MS;

/// A failed login of a known account is audited at most once per this interval per account.
pub const LOGIN_AUDIT_INTERVAL: Duration = Duration::from_mins(1);

/// Audit action of a failed login of an existing account (internal id only).
pub const LOGIN_FAILED: &str = "login.failed";

/// Metric label of a failed login.
pub const REASON_LOGIN_FAILED: &str = "login_failed";
/// Metric label of an attempt refused by a throttle.
pub const REASON_THROTTLED: &str = "throttled";
/// Metric label of a registration the sign-up mode refuses.
pub const REASON_SIGNUP_CLOSED: &str = "signup_closed";

/// The detail of every failed login, whatever the reason.
pub const INVALID_CREDENTIALS: &str = "the login name, e-mail address or password is wrong";

/// The `X-Forwarded-For` request header.
const FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");
/// The `Forwarded` request header (RFC 7239).
const FORWARDED: HeaderName = HeaderName::from_static("forwarded");

/// The warning about an unlisted reverse proxy is logged at most once per this interval.
pub const PROXY_WARNING_INTERVAL: Duration = Duration::from_hours(1);

/// The account machinery of the running app: password hashing, throttles, the trusted proxies.
#[derive(Debug)]
pub struct Accounts {
    passwords: Passwords,
    throttles: Throttles,
    trusted_proxies: ProxyList,
    login_audit: KeyedLimiter<i64>,
    proxy_warning: LogSampler,
}

impl Accounts {
    /// Puts the pieces together.
    #[must_use]
    pub fn new(passwords: Passwords, trusted_proxies: ProxyList) -> Self {
        Self {
            passwords,
            throttles: Throttles::default(),
            trusted_proxies,
            login_audit: KeyedLimiter::new(LOGIN_AUDIT_INTERVAL, crate::throttle::CAPACITY),
            proxy_warning: LogSampler::new(PROXY_WARNING_INTERVAL),
        }
    }

    /// Password hashing and policy.
    #[must_use]
    pub const fn passwords(&self) -> &Passwords {
        &self.passwords
    }

    /// The throttles.
    #[must_use]
    pub const fn throttles(&self) -> &Throttles {
        &self.throttles
    }
}

/// `GET /api/v1/account`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct AccountProfile {
    /// Login name.
    pub login: String,
    /// E-mail address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Role.
    pub role: Role,
    /// Account kind.
    pub kind: UserKind,
    /// Creation time (RFC 3339, UTC).
    pub created_at: String,
    /// Whether the account has a password (accounts of the identity provider may not).
    pub has_password: bool,
}

/// Reads and parses the JSON body of an action.
///
/// # Errors
///
/// 415, 413, 400 or 422 (every invalid field).
pub async fn parse_body<T: Action>(
    state: &AppState,
    parts: &Parts,
    body: Body,
) -> Result<T, Problem> {
    require_json(&parts.headers)?;
    let bytes = read_body(body, state.limits().max_body_bytes).await?;
    parse_action(&bytes).map_err(|error| match error {
        BodyError::Malformed(message) => Problem::with_detail(
            ProblemKind::MalformedBody,
            format!("the body is not valid JSON: {message}"),
        ),
        BodyError::Invalid(errors) => Problem::validation(errors),
    })
}

/// The client of a request, as the throttles see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Client {
    /// The throttle key: the TCP peer, or behind a trusted proxy the address it forwarded
    /// ([`client_address`]).
    pub bucket: Bucket,
    /// Whether a known address may skip the account rule: not when the peer is probably a
    /// reverse proxy nobody listed ([`unlisted_proxy`]), whose address stands for every client.
    pub exemptions: bool,
}

/// The client of a request. Without connection information (a request handed to the router
/// directly) the unspecified address stands in. A request from a private or loopback peer
/// with forwarding headers and no `STUFFCLOUD_TRUSTED_PROXIES` logs a warning, at most once per
/// [`PROXY_WARNING_INTERVAL`] (it names no address).
#[must_use]
pub fn client_of(state: &AppState, parts: &Parts) -> Client {
    let peer = parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED), |info| info.0.ip());
    let forwarded: Vec<&[u8]> = parts
        .headers
        .get_all(FORWARDED_FOR)
        .iter()
        .map(axum::http::HeaderValue::as_bytes)
        .collect();
    let accounts = state.accounts();
    let unlisted = unlisted_proxy(peer, &accounts.trusted_proxies);
    if unlisted
        && (!forwarded.is_empty() || parts.headers.contains_key(FORWARDED))
        && let Some(suppressed) = accounts.proxy_warning.admit()
    {
        tracing::warn!(
            target: "stuffcloud::security",
            suppressed,
            "a request with forwarding headers came from a private or loopback peer, but STUFFCLOUD_TRUSTED_PROXIES is empty: every client behind the reverse proxy shares one login throttle and no address is exempt from the account rule; set it to the proxy's address or network"
        );
    }
    Client {
        bucket: Bucket::of(client_address(peer, &forwarded, &accounts.trusted_proxies)),
        exemptions: !unlisted,
    }
}

/// The sign-up mode now (the default when the settings group was never written).
///
/// # Errors
///
/// An internal problem when the database fails or holds a broken document.
pub async fn signup_mode(state: &AppState) -> Result<SignupMode, Problem> {
    let stored = state.db(|db| db.get(SETTINGS_KIND, Signup::GROUP)).await?;
    match stored {
        None => Ok(SignupMode::default()),
        Some(stored) => serde_json::from_str::<Signup>(&stored.body)
            .map(|signup| signup.mode)
            .map_err(|error| Problem::internal(&error)),
    }
}

fn throttled(state: &AppState, wait_ms: i64, method: &str) -> Problem {
    note_rejection(state, REASON_THROTTLED, method);
    Problem::too_many_requests(wait_ms)
}

/// Checks a password with the reservation held: a refusal for a full hashing queue gives the
/// reservation back (nothing was checked), any other error books it as a failure.
async fn verify_reserved<'a>(
    state: &AppState,
    reservation: Reservation<'a>,
    password: &str,
    stored: Option<&str>,
    method: &str,
) -> Result<(Reservation<'a>, crate::password::Verified), Problem> {
    match state.accounts().passwords().verify(password, stored).await {
        Ok(verdict) => Ok((reservation, verdict)),
        Err(problem) if problem.kind() == ProblemKind::TooManyRequests => {
            reservation.refund();
            note_rejection(state, REASON_THROTTLED, method);
            Err(problem)
        }
        Err(problem) => Err(problem),
    }
}

fn field(name: &str, code: FieldErrorCode, detail: &str) -> Problem {
    Problem::validation(vec![FieldError::new(
        JsonPointer::root().key(name),
        code,
        detail,
    )])
}

/// The password policy's verdict on a new password, as field errors at `pointer`.
fn policy_errors(
    passwords: &Passwords,
    password: &str,
    context: &PasswordContext<'_>,
    pointer: &str,
) -> Result<(), Problem> {
    let errors = passwords.policy().field_errors(
        password,
        context,
        passwords.breached(password),
        &JsonPointer::root().key(pointer),
    );
    if errors.is_empty() {
        Ok(())
    } else {
        Err(Problem::validation(errors))
    }
}

/// The answer to a started session: the session state with the new CSRF token, and both
/// cookies.
fn session_response(
    state: &AppState,
    status: StatusCode,
    session: &Session,
    tokens: &IssuedTokens,
) -> Result<Response, Problem> {
    let timeouts = state.auth().timeouts;
    let body: SessionState = describe(session, &tokens.csrf, timeouts)?;
    let mut response = (status, Json(body)).into_response();
    let max_age = timeouts.remaining_secs(session.created_at, state.now_millis());
    tokens.set_cookies(response.headers_mut(), max_age);
    Ok(response)
}

/// Audits a failed login of an existing account in the background (at most once a minute per
/// account), so the answer does not wait for a database write that an unknown account would
/// not cause.
fn audit_failed_login(state: &AppState, user_id: i64) {
    if !state.accounts().login_audit.admit(user_id) {
        return;
    }
    let state = state.clone();
    let now = state.now_millis();
    let _task = tokio::spawn(async move {
        let who = actor(user_id);
        let _written = state
            .db(move |db| {
                db.record_security_event(
                    Some(&who),
                    LOGIN_FAILED,
                    USER_KIND,
                    &user_id.to_string(),
                    now,
                )
            })
            .await;
    });
}

async fn login_inner(state: &AppState, request: Request<Body>) -> Result<Response, Problem> {
    let (parts, body) = request.into_parts();
    let login: LoginRequest = parse_body(state, &parts, body).await?;
    let method = parts.method.as_str();
    let client = client_of(state, &parts);
    let throttles = state.accounts().throttles();
    let now = state.now_millis();
    let mut reservation = throttles
        .reserve_login(
            client.bucket,
            account_key(&login.login),
            client.exemptions,
            now,
        )
        .map_err(|wait| throttled(state, wait, method))?;
    let record = match Identifier::from_input(&login.login) {
        Some(identifier) => state.db(move |db| db.password_record(&identifier)).await?,
        None => None,
    };
    // The account's own count, whichever name was typed. When it refuses, the password is
    // checked against the dummy hash only: the same work and the same answer as a wrong one.
    let id_throttled = record.as_ref().is_some_and(|record| {
        reservation
            .add_account(id_key(record.user.id), now)
            .is_err()
    });
    let stored = record
        .as_ref()
        .filter(|record| record.user.kind == UserKind::Person && !id_throttled)
        .and_then(|record| record.hash.clone());
    let (reservation, verdict) = verify_reserved(
        state,
        reservation,
        &login.password,
        stored.as_deref(),
        method,
    )
    .await?;
    let user = match record {
        Some(record) if verdict.matches => record.user,
        other => {
            reservation.failed(now);
            let reason = if id_throttled {
                REASON_THROTTLED
            } else {
                REASON_LOGIN_FAILED
            };
            note_rejection(state, reason, method);
            if let Some(record) = other {
                audit_failed_login(state, record.user.id);
            }
            return Err(Problem::with_detail(
                ProblemKind::InvalidCredentials,
                INVALID_CREDENTIALS,
            ));
        }
    };
    reservation.succeeded(now);
    let user_id = user.id;
    let rehash = verdict.rehash;
    state
        .db(move |db| db.record_password_use(user_id, rehash.as_deref(), now))
        .await?;
    let (session, tokens) = start_session(state, &parts, user_id).await?;
    session_response(state, StatusCode::OK, &session, &tokens)
}

/// `POST /api/v1/auth/login`.
#[utoipa::path(
    post,
    path = "/api/v1/auth/login",
    tag = "auth",
    operation_id = "login",
    params(
        ("X-CSRF-Token" = String, Header, description = "The CSRF token from GET /api/v1/auth/session (browsers; API clients use a token instead of logging in)"),
    ),
    request_body(content = LoginRequest, description = "Login name or e-mail address, and the password"),
    responses(
        (status = 200, description = "Logged in: the new session and its CSRF token (sets both cookies; the previous session of the browser has ended)", body = SessionState),
        (status = 400, description = "Malformed body", body = ProblemBody, content_type = "application/problem+json"),
        (status = 401, description = "Wrong login or password (the same answer for an unknown account)", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "Origin or CSRF check failed", body = ProblemBody, content_type = "application/problem+json"),
        (status = 415, description = "Body is not JSON", body = ProblemBody, content_type = "application/problem+json"),
        (status = 422, description = "Invalid fields (empty or too long)", body = ProblemBody, content_type = "application/problem+json"),
        (status = 429, description = "Too many failed attempts; see Retry-After", body = ProblemBody, content_type = "application/problem+json",
            headers(("Retry-After" = u64, description = "Seconds until the next attempt is checked"))),
    ),
)]
pub async fn login(State(state): State<AppState>, request: Request<Body>) -> Response {
    login_inner(&state, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

/// Whether the sign-up mode allows this registration.
fn admit_registration(
    state: &AppState,
    mode: SignupMode,
    invited: bool,
    method: &str,
) -> Result<(), Problem> {
    let refusal = match (mode, invited) {
        (SignupMode::Open, _) | (SignupMode::InviteOnly, true) => return Ok(()),
        (SignupMode::InviteOnly, false) => {
            "registration needs an invitation (sign-up mode invite-only)"
        }
        (SignupMode::OidcOnly, _) => {
            "local registration is closed (sign-up mode oidc-only); log in through the identity provider"
        }
    };
    note_rejection(state, REASON_SIGNUP_CLOSED, method);
    Err(Problem::with_detail(ProblemKind::SignupClosed, refusal))
}

async fn register_inner(state: &AppState, request: Request<Body>) -> Result<Response, Problem> {
    let (parts, body) = request.into_parts();
    let form: RegisterRequest = parse_body(state, &parts, body).await?;
    let method = parts.method.as_str();
    let (Ok(login), Ok(email)) = (Login::parse(&form.login), Email::parse(&form.email)) else {
        return Err(Problem::internal(&"a validated registration did not parse"));
    };
    let invitation = form
        .invitation
        .as_deref()
        .map(|text| Token::parse(text.as_bytes()).map(|token| token_hash(&token)))
        .transpose()
        .map_err(|error| Problem::internal(&error))?;
    let mode = signup_mode(state).await?;
    admit_registration(state, mode, invitation.is_some(), method)?;
    if let Some(wait) = state
        .accounts()
        .throttles()
        .register_attempt(client_of(state, &parts).bucket, state.now_millis())
    {
        return Err(throttled(state, wait, method));
    }
    let passwords = state.accounts().passwords();
    policy_errors(
        passwords,
        &form.password,
        &PasswordContext {
            login: login.as_str(),
            email: Some(email.as_str()),
        },
        "password",
    )?;
    let hash = passwords.hash(&form.password).await?;
    let now = state.now_millis();
    let registration = state
        .db(move |db| {
            db.register(
                &NewAccount {
                    login: &login,
                    email: Some(&email),
                    role: Role::User,
                    password_hash: &hash,
                },
                invitation.as_ref(),
                now,
            )
        })
        .await?;
    let user = match registration {
        Registration::Created(user) => user,
        Registration::LoginTaken => {
            return Err(field(
                "login",
                FieldErrorCode::Taken,
                "this login name is taken",
            ));
        }
        Registration::EmailTaken => {
            return Err(field(
                "email",
                FieldErrorCode::Taken,
                "another account has this e-mail address",
            ));
        }
        Registration::InvitationInvalid => {
            return Err(field(
                "invitation",
                FieldErrorCode::InvalidValue,
                "the invitation is unknown, used or expired",
            ));
        }
        Registration::InvitationForAnotherEmail => {
            return Err(field(
                "email",
                FieldErrorCode::InvalidValue,
                "the invitation is for another e-mail address",
            ));
        }
    };
    let (session, tokens) = start_session(state, &parts, user.id).await?;
    session_response(state, StatusCode::CREATED, &session, &tokens)
}

/// `POST /api/v1/auth/register`.
#[utoipa::path(
    post,
    path = "/api/v1/auth/register",
    tag = "auth",
    operation_id = "register",
    params(
        ("X-CSRF-Token" = String, Header, description = "The CSRF token from GET /api/v1/auth/session"),
    ),
    request_body(content = RegisterRequest, description = "The new account; `invitation` is required in the sign-up mode invite-only"),
    responses(
        (status = 201, description = "Registered and logged in: the new session and its CSRF token (sets both cookies)", body = SessionState),
        (status = 400, description = "Malformed body", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "The sign-up mode does not allow this registration (signup-closed), or the Origin or CSRF check failed", body = ProblemBody, content_type = "application/problem+json"),
        (status = 415, description = "Body is not JSON", body = ProblemBody, content_type = "application/problem+json"),
        (status = 422, description = "Invalid fields: the rules of login name and e-mail address, the password policy, a taken login name or address, an unknown, used or expired invitation", body = ProblemBody, content_type = "application/problem+json"),
        (status = 429, description = "Too many registrations from this client; see Retry-After", body = ProblemBody, content_type = "application/problem+json",
            headers(("Retry-After" = u64, description = "Seconds until the next attempt"))),
    ),
)]
pub async fn register(State(state): State<AppState>, request: Request<Body>) -> Response {
    register_inner(&state, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

/// The answer to a reset token that does not work.
fn invalid_reset_token() -> Problem {
    field(
        "token",
        FieldErrorCode::InvalidValue,
        "the reset link is unknown, used or expired",
    )
}

async fn reset_inner(state: &AppState, request: Request<Body>) -> Result<Response, Problem> {
    let (parts, body) = request.into_parts();
    let form: PasswordResetRequest = parse_body(state, &parts, body).await?;
    let client = client_of(state, &parts);
    let now = state.now_millis();
    let reservation = state
        .accounts()
        .throttles()
        .reserve_client(client.bucket, now)
        .map_err(|wait| throttled(state, wait, parts.method.as_str()))?;
    let hash = Token::parse(form.token.as_bytes())
        .map(|token| token_hash(&token))
        .map_err(|error| Problem::internal(&error))?;
    let Some(profile) = state
        .db(move |db| db.password_reset_target(&hash, now))
        .await?
    else {
        reservation.failed(now);
        return Err(invalid_reset_token());
    };
    // A valid token is no guess: nothing counts against the address.
    reservation.refund();
    let passwords = state.accounts().passwords();
    policy_errors(
        passwords,
        &form.password,
        &PasswordContext {
            login: &profile.user.login,
            email: profile.email.as_deref(),
        },
        "password",
    )?;
    let new_hash = passwords.hash(&form.password).await?;
    let now = state.now_millis();
    match state
        .db(move |db| db.redeem_password_reset(&hash, &new_hash, now))
        .await?
    {
        Some(_user) => Ok(StatusCode::NO_CONTENT.into_response()),
        // Redeemed or expired in between.
        None => Err(invalid_reset_token()),
    }
}

/// `POST /api/v1/auth/password-reset`.
#[utoipa::path(
    post,
    path = "/api/v1/auth/password-reset",
    tag = "auth",
    operation_id = "resetPassword",
    params(
        ("X-CSRF-Token" = String, Header, description = "The CSRF token from GET /api/v1/auth/session"),
    ),
    request_body(content = PasswordResetRequest, description = "The token of the reset link and the new password"),
    responses(
        (status = 204, description = "The password is set; every session of the account has ended (log in with the new password)"),
        (status = 400, description = "Malformed body", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "Origin or CSRF check failed", body = ProblemBody, content_type = "application/problem+json"),
        (status = 415, description = "Body is not JSON", body = ProblemBody, content_type = "application/problem+json"),
        (status = 422, description = "Invalid fields: an unknown, used or expired token, the password policy", body = ProblemBody, content_type = "application/problem+json"),
        (status = 429, description = "Too many failures from this client; see Retry-After", body = ProblemBody, content_type = "application/problem+json",
            headers(("Retry-After" = u64, description = "Seconds until the next attempt"))),
    ),
)]
pub async fn reset_password(State(state): State<AppState>, request: Request<Body>) -> Response {
    reset_inner(&state, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

/// The account behind a request; the guard admits only requests that have one.
fn caller(parts: &Parts) -> Result<Authentication, Problem> {
    let authentication = Authentication::of(parts);
    if authentication.user().is_some() {
        Ok(authentication)
    } else {
        Err(Problem::with_detail(
            ProblemKind::Unauthenticated,
            "this needs a login or an API token",
        ))
    }
}

async fn profile_inner(state: &AppState, request: Request<Body>) -> Result<Response, Problem> {
    let (parts, _body) = request.into_parts();
    let authentication = caller(&parts)?;
    let user_id = authentication.user().map_or(0, |user| user.id);
    let profile = state
        .db(move |db| db.profile(user_id))
        .await?
        .ok_or_else(|| Problem::with_detail(ProblemKind::NotFound, "the account does not exist"))?;
    Ok(Json(AccountProfile {
        login: profile.user.login,
        email: profile.email,
        role: profile.user.role,
        kind: profile.user.kind,
        created_at: rfc3339(profile.user.created_at)?,
        has_password: profile.has_password,
    })
    .into_response())
}

/// `GET /api/v1/account`.
#[utoipa::path(
    get,
    path = "/api/v1/account",
    tag = "account",
    operation_id = "getAccount",
    responses(
        (status = 200, description = "The own account", body = AccountProfile),
        (status = 401, description = "Not authenticated", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "The token lacks the scope account:read", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn get_account(State(state): State<AppState>, request: Request<Body>) -> Response {
    profile_inner(&state, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn change_inner(state: &AppState, request: Request<Body>) -> Result<Response, Problem> {
    let (parts, body) = request.into_parts();
    let authentication = caller(&parts)?;
    let form: PasswordChangeRequest = parse_body(state, &parts, body).await?;
    let Some(user) = authentication.user().cloned() else {
        return Err(Problem::internal(
            &"an authenticated caller without an account",
        ));
    };
    let client = client_of(state, &parts);
    let method = parts.method.as_str();
    let reservation = state
        .accounts()
        .throttles()
        .reserve_login(
            client.bucket,
            id_key(user.id),
            client.exemptions,
            state.now_millis(),
        )
        .map_err(|wait| throttled(state, wait, method))?;
    let user_id = user.id;
    let profile = state
        .db(move |db| db.profile(user_id))
        .await?
        .ok_or_else(|| Problem::with_detail(ProblemKind::NotFound, "the account does not exist"))?;
    let login = Login::parse(&user.login).map_err(|error| Problem::internal(&error))?;
    let stored = state
        .db(move |db| db.password_record(&Identifier::Login(login)))
        .await?
        .and_then(|record| record.hash);
    let (reservation, verdict) = verify_reserved(
        state,
        reservation,
        &form.current_password,
        stored.as_deref(),
        method,
    )
    .await?;
    if !verdict.matches {
        reservation.failed(state.now_millis());
        note_rejection(state, REASON_LOGIN_FAILED, method);
        return Err(field(
            "current_password",
            FieldErrorCode::InvalidValue,
            "the current password is wrong",
        ));
    }
    reservation.refund();
    let passwords = state.accounts().passwords();
    policy_errors(
        passwords,
        &form.new_password,
        &PasswordContext {
            login: &user.login,
            email: profile.email.as_deref(),
        },
        "new_password",
    )?;
    let hash = passwords.hash(&form.new_password).await?;
    let keep = authentication.session().map(|session| session.id);
    let now = state.now_millis();
    let _ended = state
        .db(move |db| db.set_password(user_id, &hash, keep, now))
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `POST /api/v1/account/password`.
#[utoipa::path(
    post,
    path = "/api/v1/account/password",
    tag = "account",
    operation_id = "changePassword",
    params(
        ("X-CSRF-Token" = Option<String>, Header, description = "The CSRF token from GET /api/v1/auth/session (required for browser sessions)"),
    ),
    request_body(content = PasswordChangeRequest, description = "The current and the new password"),
    responses(
        (status = 204, description = "The password is changed; every other session of the account has ended"),
        (status = 400, description = "Malformed body", body = ProblemBody, content_type = "application/problem+json"),
        (status = 401, description = "Not authenticated", body = ProblemBody, content_type = "application/problem+json"),
        (status = 403, description = "The token lacks the scope account:write, or the Origin or CSRF check failed", body = ProblemBody, content_type = "application/problem+json"),
        (status = 415, description = "Body is not JSON", body = ProblemBody, content_type = "application/problem+json"),
        (status = 422, description = "Invalid fields: a wrong current password, the password policy", body = ProblemBody, content_type = "application/problem+json"),
        (status = 429, description = "Too many wrong passwords; see Retry-After", body = ProblemBody, content_type = "application/problem+json",
            headers(("Retry-After" = u64, description = "Seconds until the next attempt is checked"))),
    ),
)]
pub async fn change_password(State(state): State<AppState>, request: Request<Body>) -> Response {
    change_inner(&state, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_documented_durations_hold() {
        // A reset link is valid for 60 minutes; the failed-login audit row is written once a
        // minute per account.
        assert_eq!(RESET_TTL_MS, 3_600_000);
        assert_eq!(LOGIN_AUDIT_INTERVAL.as_secs(), 60);
    }

    #[test]
    fn registration_follows_the_sign_up_mode() {
        let state = crate::state::tests::state();
        assert!(admit_registration(&state, SignupMode::Open, false, "POST").is_ok());
        assert!(admit_registration(&state, SignupMode::Open, true, "POST").is_ok());
        assert!(admit_registration(&state, SignupMode::InviteOnly, true, "POST").is_ok());
        let refused =
            admit_registration(&state, SignupMode::InviteOnly, false, "POST").unwrap_err();
        assert_eq!(refused.kind(), ProblemKind::SignupClosed);
        assert_eq!(
            refused.body().detail.as_deref(),
            Some("registration needs an invitation (sign-up mode invite-only)")
        );
        for invited in [false, true] {
            let refused =
                admit_registration(&state, SignupMode::OidcOnly, invited, "POST").unwrap_err();
            assert_eq!(
                refused.body().detail.as_deref(),
                Some(
                    "local registration is closed (sign-up mode oidc-only); log in through the identity provider"
                )
            );
        }
    }

    #[tokio::test]
    async fn a_login_that_finds_the_hashing_queue_full_is_refunded() {
        let passwords = Passwords::new(
            crate::password::Argon2Settings::CHEAPEST,
            stuffcloud_core::account::PasswordPolicy::default(),
            crate::password::Blocklist::default(),
            1,
        )
        .unwrap()
        // No queue at all; a mutant that lets it wait anyway waits only briefly (the bound itself
        // is tested in `password`).
        .with_queue(0, Duration::from_millis(100));
        let state = crate::state::tests::state_with_accounts(Accounts::new(
            passwords,
            ProxyList::default(),
        ));
        let _held = state.accounts().passwords().hold_slots();
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"login":"alice","password":"a long enough passphrase"}"#,
            ))
            .unwrap();
        let response = login(State(state.clone()), request).await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()["retry-after"], "1");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let problem: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            problem["detail"],
            "the server is busy checking other passwords; try again in 1 second"
        );
        // Nothing was checked, so nothing counts: the reservation went back.
        assert_eq!(state.accounts().passwords().verifications(), 0);
        assert_eq!(state.accounts().throttles().sizes(), [0, 0, 0, 0, 0]);
    }

    #[tokio::test]
    async fn a_login_that_fails_with_an_error_counts_as_a_failure() {
        let state = crate::state::tests::state();
        let db = state.database();
        let alice = db
            .create_user("alice", UserKind::Person, Role::User, None, 0)
            .unwrap();
        // A stored hash that is no PHC string: the check is an internal error, not "busy".
        let _ended = db
            .set_password(alice.id, "not a phc string", None, 0)
            .unwrap();
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"login":"alice","password":"a long enough passphrase"}"#,
            ))
            .unwrap();
        let response = login(State(state.clone()), request).await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        // The reservation was not refunded: the address and both account keys count it.
        assert_eq!(state.accounts().throttles().sizes(), [1, 2, 0, 0, 0]);
    }

    #[test]
    fn handlers_refuse_a_request_without_an_account() {
        let parts = Request::new(()).into_parts().0;
        let problem = caller(&parts).unwrap_err();
        assert_eq!(problem.kind(), ProblemKind::Unauthenticated);
    }

    fn parts_from(peer: [u8; 4], headers: &[(&str, &str)]) -> Parts {
        let mut builder = Request::builder();
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let mut parts = builder.body(()).unwrap().into_parts().0;
        let _previous = parts
            .extensions
            .insert(ConnectInfo(SocketAddr::from((peer, 4000))));
        parts
    }

    fn bucket(octets: [u8; 4]) -> Bucket {
        Bucket::of(IpAddr::V4(Ipv4Addr::from(octets)))
    }

    #[test]
    fn the_client_is_the_peer_or_the_forwarded_address() {
        let state = crate::state::tests::state();
        let parts = Request::builder()
            .header("x-forwarded-for", "203.0.113.9")
            .body(())
            .unwrap()
            .into_parts()
            .0;
        assert_eq!(
            client_of(&state, &parts),
            Client {
                bucket: bucket([0, 0, 0, 0]),
                exemptions: true
            }
        );
        let public = parts_from([192, 0, 2, 4], &[("x-forwarded-for", "203.0.113.9")]);
        assert_eq!(
            client_of(&state, &public),
            Client {
                bucket: bucket([192, 0, 2, 4]),
                exemptions: true
            }
        );
        // Nothing to warn about: the sampler still lets its first line through.
        assert_eq!(state.accounts().proxy_warning.admit(), Some(0));
    }

    #[test]
    fn an_unlisted_proxy_gets_no_exemptions_and_a_warning() {
        let state = crate::state::tests::state();
        let quiet = parts_from([172, 18, 0, 3], &[]);
        assert_eq!(
            client_of(&state, &quiet),
            Client {
                bucket: bucket([172, 18, 0, 3]),
                exemptions: false
            }
        );
        // Without forwarding headers there is nothing to warn about yet.
        assert_eq!(state.accounts().proxy_warning.admit(), Some(0));
        let state = crate::state::tests::state();
        let forwarded = parts_from([127, 0, 0, 1], &[("x-forwarded-for", "203.0.113.9")]);
        assert_eq!(
            client_of(&state, &forwarded),
            Client {
                bucket: bucket([127, 0, 0, 1]),
                exemptions: false
            }
        );
        // The warning took the sampler's line.
        assert_eq!(state.accounts().proxy_warning.admit(), None);
        let state = crate::state::tests::state();
        let rfc7239 = parts_from([10, 0, 0, 2], &[("forwarded", "for=203.0.113.9")]);
        assert!(!client_of(&state, &rfc7239).exemptions);
        assert_eq!(state.accounts().proxy_warning.admit(), None);
        assert_eq!(PROXY_WARNING_INTERVAL.as_secs(), 3600);
    }

    #[test]
    fn a_listed_proxy_forwards_the_client_with_exemptions() {
        let state = crate::state::tests::state_with_proxies("172.16.0.0/12");
        let forwarded = parts_from([172, 18, 0, 3], &[("x-forwarded-for", "203.0.113.9")]);
        assert_eq!(
            client_of(&state, &forwarded),
            Client {
                bucket: bucket([203, 0, 113, 9]),
                exemptions: true
            }
        );
        assert_eq!(state.accounts().proxy_warning.admit(), Some(0));
    }
}
