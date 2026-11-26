//! The router and the HTTP server with graceful shutdown.

use std::future::Future;

use axum::Router;
use axum::middleware::{from_fn, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use stuffcloud_core::policy::Requirement;
use stuffcloud_core::scope::{Area, Level, Permission};
use tokio::net::TcpListener;
use tower_http::catch_panic::CatchPanicLayer;

use crate::access::{Declared, Endpoints};
use crate::accounts::{
    ACCOUNT_PATH, LOGIN_PATH, PASSWORD_PATH, REGISTER_PATH, RESET_PATH, change_password,
    get_account, login, register, reset_password,
};
use crate::invitations::{
    INVITATION_PATH, INVITATIONS_PATH, RESET_LINK_PATH, create_invitation, create_reset_link,
    list_invitations, revoke_invitation,
};
use crate::mail_api::{FEATURES_PATH, RESET_REQUEST_PATH, get_features, request_password_reset};
use crate::middleware::{
    observe, panic_response, problems_for_bare_errors, security_headers, timeout,
};
use crate::problem::{Problem, ProblemKind};
use crate::sessions::{SESSION_PATH, SESSIONS_PATH, delete_session, delete_sessions, get_session};
use crate::settings::{
    RESERVED_NAMES_PATH, SIGNUP_PATH, SMTP_PATH, delete_reserved_names, delete_signup, delete_smtp,
    get_reserved_names, get_signup, get_smtp, put_reserved_names, put_signup, put_smtp,
};
use crate::state::AppState;
use crate::{auth, health, metrics, openapi};

/// Answer for every path that is not a route.
async fn not_found() -> Response {
    Problem::with_detail(ProblemKind::NotFound, "no such route").into_response()
}

/// The prefix of the versioned API.
pub const API_V1: &str = "/api/v1";

/// The path of an `/api/v1` route.
fn v1(path: &str) -> String {
    format!("{API_V1}{path}")
}

/// Every route of the application with the requirement it declares (A-07). This is the only
/// place that registers routes: a route cannot be added without saying who may use it, and
/// `access::verify` (run at startup) fails the start when the OpenAPI document and this table differ. The
/// table is rendered to `docs/api/permissions.md` (`stuffcloud-app permissions`).
///
/// Reads of the settings groups the client needs before it logs in are `public` (the API is
/// LAN-only and these hold no secret, ADR 0010 decision 4); every write needs the permission
/// of its area. A settings group that may hold anything private (the `smtp` group: the server,
/// the login and the reference to the password) declares `admin:settings:read` for its `GET`.
///
/// Logging in, registering, redeeming a reset link and asking for one by e-mail are `public`
/// (they are how a client gets an account or a session); they still pass the `Origin` and CSRF
/// checks of every write. `GET /features` is `public`: it tells a client whether to offer
/// "forgot your password?" and holds nothing about accounts.
fn table(endpoints: Endpoints) -> Endpoints {
    let read_settings = Requirement::Permit(Permission::new(Area::AdminSettings, Level::Read));
    let write_settings = Requirement::Permit(Permission::new(Area::AdminSettings, Level::Write));
    let read_account = Requirement::Permit(Permission::new(Area::Account, Level::Read));
    let write_account = Requirement::Permit(Permission::new(Area::Account, Level::Write));
    let read_users = Requirement::Permit(Permission::new(Area::AdminUsers, Level::Read));
    let write_users = Requirement::Permit(Permission::new(Area::AdminUsers, Level::Write));
    endpoints
        .get("/healthz", Requirement::Public, health::live)
        .get("/readyz", Requirement::Public, health::ready)
        .get("/metrics", Requirement::Public, metrics::render)
        .get(
            &v1("/openapi.json"),
            Requirement::Public,
            openapi::openapi_json,
        )
        .get(&v1(SESSION_PATH), Requirement::Public, get_session)
        .delete(&v1(SESSION_PATH), Requirement::Session, delete_session)
        .delete(&v1(SESSIONS_PATH), Requirement::Session, delete_sessions)
        .post(&v1(LOGIN_PATH), Requirement::Public, login)
        .post(&v1(REGISTER_PATH), Requirement::Public, register)
        .post(&v1(RESET_PATH), Requirement::Public, reset_password)
        .post(
            &v1(RESET_REQUEST_PATH),
            Requirement::Public,
            request_password_reset,
        )
        .get(&v1(FEATURES_PATH), Requirement::Public, get_features)
        .get(&v1(ACCOUNT_PATH), read_account, get_account)
        .post(&v1(PASSWORD_PATH), write_account, change_password)
        .post(&v1(INVITATIONS_PATH), write_users, create_invitation)
        .get(&v1(INVITATIONS_PATH), read_users, list_invitations)
        .delete(&v1(INVITATION_PATH), write_users, revoke_invitation)
        .post(&v1(RESET_LINK_PATH), write_users, create_reset_link)
        .get(
            &v1(RESERVED_NAMES_PATH),
            Requirement::Public,
            get_reserved_names,
        )
        .put(&v1(RESERVED_NAMES_PATH), write_settings, put_reserved_names)
        .delete(
            &v1(RESERVED_NAMES_PATH),
            write_settings,
            delete_reserved_names,
        )
        .get(&v1(SIGNUP_PATH), Requirement::Public, get_signup)
        .put(&v1(SIGNUP_PATH), write_settings, put_signup)
        .delete(&v1(SIGNUP_PATH), write_settings, delete_signup)
        .get(&v1(SMTP_PATH), read_settings, get_smtp)
        .put(&v1(SMTP_PATH), write_settings, put_smtp)
        .delete(&v1(SMTP_PATH), write_settings, delete_smtp)
}

/// The routes with a guard in front of each (what [`router`] serves).
#[must_use]
pub fn endpoints(state: AppState) -> Endpoints {
    table(Endpoints::guarded(state))
}

/// The declared routes (for the permissions document and the checks).
#[must_use]
pub fn declared_routes() -> Vec<Declared> {
    table(Endpoints::unguarded()).into_parts().1
}

/// The complete application. Middleware, from the outside in: metrics and access log,
/// security headers, panic guard, time limit, problem documents for bare router errors,
/// authentication with the CSRF checks (`auth::authenticate`, for every path including
/// unknown ones); in front of every route its guard from [`endpoints`].
pub fn router(state: AppState) -> Router {
    let (routes, _declared) = endpoints(state.clone()).into_parts();
    routes
        .fallback(not_found)
        .layer(from_fn_with_state(state.clone(), auth::authenticate))
        .layer(from_fn(problems_for_bare_errors))
        .layer(from_fn_with_state(state.clone(), timeout))
        .layer(CatchPanicLayer::custom(panic_response))
        .layer(from_fn(security_headers))
        .layer(from_fn_with_state(state.clone(), observe))
        .with_state(state)
}

/// Serves `router` on `listener` until `shutdown` completes, then lets requests in flight
/// finish (graceful shutdown).
///
/// # Errors
///
/// What the server reports (for example a failing `accept`).
pub async fn serve<F>(listener: TcpListener, router: Router, shutdown: F) -> std::io::Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    // The peer address is the client address for the login throttles (or the proxy's, which
    // `accounts::client_of` resolves through the trusted proxies).
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
}

/// Completes on SIGTERM (what `docker stop` sends) or Ctrl+C.
pub async fn shutdown_signal() {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                let _received = signal.recv().await;
            }
            Err(_unsupported) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!(target: "stuffcloud::server", "shutdown signal received; finishing requests in flight");
}
