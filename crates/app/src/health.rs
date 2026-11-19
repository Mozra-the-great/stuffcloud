//! Liveness and readiness probes (SPEC 11). Both are outside `/api/v1`: the container health
//! check and a monitoring system use them, Caddy does not route them from the outside.

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use utoipa::ToSchema;

use crate::problem::{Problem, ProblemBody, ProblemKind};
use crate::state::AppState;

/// Answer of the probes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct HealthStatus {
    /// `ok` (liveness) or `ready` (readiness).
    pub status: String,
}

/// `GET /healthz`: the process serves requests. Touches nothing else.
#[utoipa::path(
    get,
    path = "/healthz",
    tag = "operations",
    operation_id = "liveness",
    responses((status = 200, description = "The process is alive", body = HealthStatus)),
)]
pub async fn live() -> Json<HealthStatus> {
    Json(HealthStatus {
        status: "ok".to_owned(),
    })
}

/// `GET /readyz`: the database answers and has the schema this build needs.
#[utoipa::path(
    get,
    path = "/readyz",
    tag = "operations",
    operation_id = "readiness",
    responses(
        (status = 200, description = "Ready to serve the API", body = HealthStatus),
        (status = 503, description = "Not ready", body = ProblemBody, content_type = "application/problem+json"),
    ),
)]
pub async fn ready(State(state): State<AppState>) -> Response {
    match state
        .db(|db| Ok(db.check_schema().map_err(|error| error.to_string())))
        .await
    {
        Ok(Ok(())) => Json(HealthStatus {
            status: "ready".to_owned(),
        })
        .into_response(),
        Ok(Err(reason)) => {
            tracing::warn!(target: "stuffcloud::health", %reason, "not ready");
            Problem::with_detail(ProblemKind::NotReady, "the database is not ready").into_response()
        }
        Err(problem) => problem.into_response(),
    }
}
