//! Middleware applied to every route (see `server::router` for the order).
//!
//! - [`observe`]: metrics and one access log line per request. The line holds the method,
//!   the matched route template, the status and the duration, never the URL (its query
//!   could carry a token), a header or a client address (SPEC 11: logs without IP
//!   addresses).
//! - [`security_headers`]: the response headers of the app zone.
//! - [`timeout`]: the time limit per request.
//! - [`problems_for_bare_errors`]: error responses produced outside the handlers (the
//!   router's 404/405) become RFC 9457 problem documents too.
//! - [`panic_response`]: a panicking handler answers 500 with a problem document instead of
//!   dropping the connection.

use std::any::Any;
use std::time::Instant;

use axum::body::Body;
use axum::extract::{MatchedPath, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::metrics::UNMATCHED;
use crate::problem::{Problem, ProblemKind};
use crate::state::AppState;

/// Headers set on every response unless the handler set them itself. The API answers JSON
/// only: nothing may be framed, run scripts or load anything.
pub const SECURITY_HEADERS: [(&str, &str); 7] = [
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "no-referrer"),
    ("x-frame-options", "DENY"),
    (
        "content-security-policy",
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    ),
    ("cross-origin-opener-policy", "same-origin"),
    ("cross-origin-resource-policy", "same-origin"),
    ("cache-control", "no-store"),
];

/// Metrics and the access log line.
pub async fn observe(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let started = Instant::now();
    let method = request.method().clone();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| UNMATCHED.to_owned(), |path| path.as_str().to_owned());
    let response = next.run(request).await;
    let elapsed = started.elapsed();
    let status = response.status().as_u16();
    state
        .metrics()
        .record(&method, &route, status, elapsed.as_secs_f64());
    tracing::info!(
        target: "stuffcloud::http",
        method = %method,
        route = %route,
        status,
        duration_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
        "request"
    );
    response
}

/// Adds the security headers the handler did not set.
pub async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    for (name, value) in SECURITY_HEADERS {
        let name = HeaderName::from_static(name);
        if !headers.contains_key(&name) {
            let _previous = headers.insert(name, HeaderValue::from_static(value));
        }
    }
    response
}

/// Answers 503 when the request takes longer than the configured limit.
pub async fn timeout(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let limit = state.limits().request_timeout;
    match tokio::time::timeout(limit, next.run(request)).await {
        Ok(response) => response,
        Err(_elapsed) => Problem::with_detail(
            ProblemKind::Timeout,
            format!("the request took longer than {} s", limit.as_secs()),
        )
        .into_response(),
    }
}

/// The problem kind for a status produced outside the handlers.
#[must_use]
pub fn kind_for(status: StatusCode) -> ProblemKind {
    match status {
        StatusCode::NOT_FOUND => ProblemKind::NotFound,
        StatusCode::METHOD_NOT_ALLOWED => ProblemKind::MethodNotAllowed,
        StatusCode::PAYLOAD_TOO_LARGE => ProblemKind::PayloadTooLarge,
        StatusCode::UNSUPPORTED_MEDIA_TYPE => ProblemKind::UnsupportedMediaType,
        StatusCode::INTERNAL_SERVER_ERROR => ProblemKind::Internal,
        other => ProblemKind::Other(other),
    }
}

/// Replaces an error response without a body type by a problem document, keeping its
/// other headers (such as `Allow` on a 405).
pub async fn problems_for_bare_errors(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    let status = response.status();
    if !(status.is_client_error() || status.is_server_error())
        || response.headers().contains_key(CONTENT_TYPE)
    {
        return response;
    }
    let (mut parts, _body) = response.into_parts();
    let problem = Problem::new(kind_for(status)).into_response();
    let (problem_parts, body) = problem.into_parts();
    let _length = parts.headers.remove(CONTENT_LENGTH);
    for name in [CONTENT_TYPE, CACHE_CONTROL] {
        if let Some(value) = problem_parts.headers.get(&name) {
            let _previous = parts.headers.insert(name, value.clone());
        }
    }
    Response::from_parts(parts, body)
}

/// The answer to a panicking handler (for `tower_http::catch_panic`). The panic message is
/// not logged: it could contain request data.
#[must_use]
pub fn panic_response(_panic: Box<dyn Any + Send + 'static>) -> Response<Body> {
    tracing::error!(target: "stuffcloud::error", "a handler panicked");
    Problem::new(ProblemKind::Internal).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_for_router_statuses() {
        assert_eq!(kind_for(StatusCode::NOT_FOUND), ProblemKind::NotFound);
        assert_eq!(
            kind_for(StatusCode::METHOD_NOT_ALLOWED),
            ProblemKind::MethodNotAllowed
        );
        assert_eq!(
            kind_for(StatusCode::PAYLOAD_TOO_LARGE),
            ProblemKind::PayloadTooLarge
        );
        assert_eq!(
            kind_for(StatusCode::UNSUPPORTED_MEDIA_TYPE),
            ProblemKind::UnsupportedMediaType
        );
        assert_eq!(
            kind_for(StatusCode::INTERNAL_SERVER_ERROR),
            ProblemKind::Internal
        );
        assert_eq!(
            kind_for(StatusCode::BAD_GATEWAY),
            ProblemKind::Other(StatusCode::BAD_GATEWAY)
        );
    }

    #[test]
    fn panic_answer() {
        let response = panic_response(Box::new("boom"));
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
    }
}
