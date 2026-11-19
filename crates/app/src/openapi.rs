//! The OpenAPI document, generated from the handlers (`utoipa`, SPEC 10.1).
//!
//! `stuffcloud-app openapi` prints it; CI compares the output with the committed
//! `docs/api/openapi.json` and regenerates the TypeScript client of `web/` from it, so a
//! handler change without a regenerated client fails `build`. `GET /api/v1/openapi.json`
//! serves the same document.

use axum::Json;
use utoipa::OpenApi;
use utoipa::openapi::OpenApi as Document;

use crate::health::{self, HealthStatus};
use crate::metrics;
use crate::problem::ProblemBody;
use crate::resource::{FieldChange, ResourceMeta, WriteChange};
use crate::settings;

/// The API description.
#[derive(Debug, OpenApi)]
#[openapi(
    info(
        title = "stuffcloud API",
        description = "LAN API of stuffcloud (ADR 0010). Errors are RFC 9457 problem details; resources follow the conventions of docs/adr/0010-api-first-and-configuration-as-code.md.",
        license(name = "GPL-3.0-or-later", identifier = "GPL-3.0-or-later"),
    ),
    paths(
        health::live,
        health::ready,
        metrics::render,
        openapi_json,
        settings::get_reserved_names,
        settings::put_reserved_names,
        settings::delete_reserved_names,
    ),
    components(schemas(HealthStatus, ProblemBody, ResourceMeta, FieldChange, WriteChange)),
    tags(
        (name = "operations", description = "Probes, metrics and the API description"),
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
