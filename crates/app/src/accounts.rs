//! Local accounts (A-03, SPEC 6, ADR 0005 addendum "local accounts"): log in, register, redeem a
//! password reset, change the password, and the account's own profile.
//!
//! - `POST /api/v1/auth/login` (public): login name or e-mail address and password. An unknown
//!   account, a service account, an account without a password and a wrong password get the
//!   same answer (401 `invalid-credentials`, byte for byte), after the same work: one Argon2
//!   check, against a dummy hash when there is no stored one. The throttles
//!   ([`crate::throttle`]) are consulted before anything is looked up and count by the typed
//!   text, so they treat unknown and known accounts alike too. A success starts a new session
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
use stuffcloud_core::client_ip::{Bucket, ProxyList, client_address};
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
use crate::sampler::KeyedLimiter;
use crate::sessions::{SessionState, describe};
use crate::settings::KIND as SETTINGS_KIND;
use crate::state::AppState;
use crate::throttle::{Throttles, account_key};

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

/// The account machinery of the running app: password hashing, throttles, the trusted proxies.
#[derive(Debug)]
pub struct Accounts {
    passwords: Passwords,
    throttles: Throttles,
    trusted_proxies: ProxyList,
    login_audit: KeyedLimiter<i64>,
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

/// The throttle key of the client that sent a request: the TCP peer, or behind a trusted
/// proxy the address it forwarded ([`client_address`]). Without connection information (a
/// request handed to the router directly) the unspecified address stands in.
#[must_use]
pub fn client_of(state: &AppState, parts: &Parts) -> Bucket {
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
    Bucket::of(client_address(
        peer,
        &forwarded,
        &state.accounts().trusted_proxies,
    ))
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
    let key = account_key(&login.login);
    let throttles = state.accounts().throttles();
    let now = state.now_millis();
    if let Some(wait) = throttles.login_wait(client, key, now) {
        return Err(throttled(state, wait, method));
    }
    let record = match Identifier::from_input(&login.login) {
        Some(identifier) => state.db(move |db| db.password_record(&identifier)).await?,
        None => None,
    };
    let stored = record
        .as_ref()
        .filter(|record| record.user.kind == UserKind::Person)
        .and_then(|record| record.hash.clone());
    let verdict = state
        .accounts()
        .passwords()
        .verify(&login.password, stored.as_deref())
        .await?;
    let user = match record {
        Some(record) if verdict.matches => record.user,
        other => {
            throttles.login_failed(client, key, now);
            note_rejection(state, REASON_LOGIN_FAILED, method);
            if let Some(record) = other {
                audit_failed_login(state, record.user.id);
            }
            return Err(Problem::with_detail(
                ProblemKind::InvalidCredentials,
                INVALID_CREDENTIALS,
            ));
        }
    };
    throttles.login_succeeded(client, key, now);
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
        .register_attempt(client_of(state, &parts), state.now_millis())
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
    let throttles = state.accounts().throttles();
    if let Some(wait) = throttles.client_wait(client, state.now_millis()) {
        return Err(throttled(state, wait, parts.method.as_str()));
    }
    let hash = Token::parse(form.token.as_bytes())
        .map(|token| token_hash(&token))
        .map_err(|error| Problem::internal(&error))?;
    let now = state.now_millis();
    let Some(profile) = state
        .db(move |db| db.password_reset_target(&hash, now))
        .await?
    else {
        throttles.client_failed(client, now);
        return Err(invalid_reset_token());
    };
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
    let key = account_key(&user.login);
    let throttles = state.accounts().throttles();
    if let Some(wait) = throttles.login_wait(client, key, state.now_millis()) {
        return Err(throttled(state, wait, parts.method.as_str()));
    }
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
    let passwords = state.accounts().passwords();
    let verdict = passwords
        .verify(&form.current_password, stored.as_deref())
        .await?;
    if !verdict.matches {
        throttles.login_failed(client, key, state.now_millis());
        note_rejection(state, REASON_LOGIN_FAILED, parts.method.as_str());
        return Err(field(
            "current_password",
            FieldErrorCode::InvalidValue,
            "the current password is wrong",
        ));
    }
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

    #[test]
    fn handlers_refuse_a_request_without_an_account() {
        let parts = Request::new(()).into_parts().0;
        let problem = caller(&parts).unwrap_err();
        assert_eq!(problem.kind(), ProblemKind::Unauthenticated);
    }

    #[test]
    fn the_client_is_the_peer_or_the_forwarded_address() {
        let state = crate::state::tests::state();
        let mut parts = Request::builder()
            .header("x-forwarded-for", "203.0.113.9")
            .body(())
            .unwrap()
            .into_parts()
            .0;
        assert_eq!(
            client_of(&state, &parts),
            Bucket::of(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
        );
        let _previous = parts
            .extensions
            .insert(ConnectInfo(SocketAddr::from(([192, 0, 2, 4], 4000))));
        assert_eq!(
            client_of(&state, &parts),
            Bucket::of(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 4)))
        );
    }
}
