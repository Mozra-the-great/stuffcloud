//! The router and the HTTP server with graceful shutdown.

use std::future::Future;

use axum::Router;
use axum::middleware::{from_fn, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use tokio::net::TcpListener;
use tower_http::catch_panic::CatchPanicLayer;

use crate::middleware::{
    observe, panic_response, problems_for_bare_errors, security_headers, timeout,
};
use crate::problem::{Problem, ProblemKind};
use crate::settings::{
    RESERVED_NAMES_PATH, delete_reserved_names, get_reserved_names, put_reserved_names,
};
use crate::state::AppState;
use crate::{health, metrics, openapi};

/// Answer for every path that is not a route.
async fn not_found() -> Response {
    Problem::with_detail(ProblemKind::NotFound, "no such route").into_response()
}

/// The routes of `/api/v1`.
fn api_v1() -> Router<AppState> {
    Router::new()
        .route("/openapi.json", get(openapi::openapi_json))
        .route(
            RESERVED_NAMES_PATH,
            get(get_reserved_names)
                .put(put_reserved_names)
                .delete(delete_reserved_names),
        )
}

/// The complete application. Middleware, from the outside in: metrics and access log,
/// security headers, panic guard, time limit, problem documents for bare router errors.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health::live))
        .route("/readyz", get(health::ready))
        .route("/metrics", get(metrics::render))
        .nest("/api/v1", api_v1())
        .fallback(not_found)
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
    axum::serve(listener, router)
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
