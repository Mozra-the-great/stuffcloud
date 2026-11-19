//! RFC 9457 problem details, the only error format of the API (ADR 0010 decision 3).
//!
//! Every error response is `application/problem+json` with a stable `type` URI per kind of
//! problem (documented in `docs/api/problems.md`), the HTTP status, a title, an optional
//! detail sentence and, for validation problems, every invalid field with a JSON Pointer.
//! Internal errors never leak their cause to the client; it is logged instead.

use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use stuffcloud_core::field::FieldError;
use utoipa::ToSchema;

/// Media type of problem documents.
pub const PROBLEM_JSON: &str = "application/problem+json";

/// Prefix of every problem `type`: the section of `docs/api/problems.md` that explains it.
pub const TYPE_BASE: &str =
    "https://github.com/Mozra-the-great/stuffcloud/blob/main/docs/api/problems.md#";

/// The kinds of problems, each with a stable `type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ProblemKind {
    /// 400: a header or query parameter is invalid.
    BadRequest,
    /// 400: the body is not JSON.
    MalformedBody,
    /// 401: the request needs authentication the client did not provide.
    Unauthenticated,
    /// 404: no such resource or route.
    NotFound,
    /// 405: the route exists but not with this method.
    MethodNotAllowed,
    /// 412: an `If-Match` / `If-None-Match` precondition failed.
    PreconditionFailed,
    /// 413: the body is larger than the limit.
    PayloadTooLarge,
    /// 415: the body is not `application/json`.
    UnsupportedMediaType,
    /// 422: the document has invalid fields (all of them are listed).
    ValidationFailed,
    /// 500: an internal error (details only in the log).
    Internal,
    /// 503: the service is not ready (database unavailable or not migrated).
    NotReady,
    /// 503: the request took longer than the time limit.
    Timeout,
    /// Any other status, for responses produced outside the handlers.
    Other(StatusCode),
}

impl ProblemKind {
    /// The HTTP status.
    #[must_use]
    pub const fn status(self) -> StatusCode {
        match self {
            Self::BadRequest | Self::MalformedBody => StatusCode::BAD_REQUEST,
            Self::Unauthenticated => StatusCode::UNAUTHORIZED,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            Self::PreconditionFailed => StatusCode::PRECONDITION_FAILED,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::UnsupportedMediaType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::ValidationFailed => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            Self::NotReady | Self::Timeout => StatusCode::SERVICE_UNAVAILABLE,
            Self::Other(status) => status,
        }
    }

    /// The anchor in `docs/api/problems.md`; `None` for [`ProblemKind::Other`], whose
    /// `type` is `about:blank` (RFC 9457, section 4.2.1).
    #[must_use]
    pub const fn slug(self) -> Option<&'static str> {
        match self {
            Self::BadRequest => Some("bad-request"),
            Self::MalformedBody => Some("malformed-body"),
            Self::Unauthenticated => Some("unauthenticated"),
            Self::NotFound => Some("not-found"),
            Self::MethodNotAllowed => Some("method-not-allowed"),
            Self::PreconditionFailed => Some("precondition-failed"),
            Self::PayloadTooLarge => Some("payload-too-large"),
            Self::UnsupportedMediaType => Some("unsupported-media-type"),
            Self::ValidationFailed => Some("validation-failed"),
            Self::Internal => Some("internal"),
            Self::NotReady => Some("not-ready"),
            Self::Timeout => Some("timeout"),
            Self::Other(_) => None,
        }
    }

    /// The `type` URI.
    #[must_use]
    pub fn type_uri(self) -> String {
        self.slug().map_or_else(
            || "about:blank".to_owned(),
            |slug| format!("{TYPE_BASE}{slug}"),
        )
    }

    /// The `title`: the same for every occurrence of the kind.
    #[must_use]
    pub fn title(self) -> &'static str {
        match self {
            Self::BadRequest => "Bad request",
            Self::MalformedBody => "Malformed body",
            Self::Unauthenticated => "Authentication required",
            Self::NotFound => "Not found",
            Self::MethodNotAllowed => "Method not allowed",
            Self::PreconditionFailed => "Precondition failed",
            Self::PayloadTooLarge => "Payload too large",
            Self::UnsupportedMediaType => "Unsupported media type",
            Self::ValidationFailed => "Validation failed",
            Self::Internal => "Internal error",
            Self::NotReady => "Not ready",
            Self::Timeout => "Request timed out",
            Self::Other(status) => status.canonical_reason().unwrap_or("Error"),
        }
    }
}

/// A problem details document (RFC 9457).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[schema(as = Problem)]
pub struct ProblemBody {
    /// Stable identifier of the kind of problem (a URI).
    #[serde(rename = "type")]
    pub type_uri: String,
    /// Short summary, the same for every occurrence of the kind.
    pub title: String,
    /// The HTTP status code.
    pub status: u16,
    /// Explanation of this occurrence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Every invalid field (validation problems only).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<FieldError>,
}

/// An error response of the API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    kind: ProblemKind,
    detail: Option<String>,
    errors: Vec<FieldError>,
}

impl Problem {
    /// A problem without detail.
    #[must_use]
    pub const fn new(kind: ProblemKind) -> Self {
        Self {
            kind,
            detail: None,
            errors: Vec::new(),
        }
    }

    /// A problem with a detail sentence.
    #[must_use]
    pub fn with_detail(kind: ProblemKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: Some(detail.into()),
            errors: Vec::new(),
        }
    }

    /// A validation problem listing every invalid field.
    #[must_use]
    pub fn validation(errors: Vec<FieldError>) -> Self {
        Self {
            kind: ProblemKind::ValidationFailed,
            detail: Some(format!(
                "{} invalid field{}",
                errors.len(),
                if errors.len() == 1 { "" } else { "s" }
            )),
            errors,
        }
    }

    /// An internal error: `cause` goes to the log, the client only learns that it happened.
    #[must_use]
    pub fn internal(cause: &dyn std::fmt::Display) -> Self {
        tracing::error!(target: "stuffcloud::error", error = %cause, "internal error");
        Self::new(ProblemKind::Internal)
    }

    /// The kind.
    #[must_use]
    pub const fn kind(&self) -> ProblemKind {
        self.kind
    }

    /// The document that is sent.
    #[must_use]
    pub fn body(&self) -> ProblemBody {
        ProblemBody {
            type_uri: self.kind.type_uri(),
            title: self.kind.title().to_owned(),
            status: self.kind.status().as_u16(),
            detail: self.detail.clone(),
            errors: self.errors.clone(),
        }
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let body = serde_json::to_vec(&self.body()).unwrap_or_default();
        let mut response = (self.kind.status(), body).into_response();
        let headers = response.headers_mut();
        let _previous = headers.insert(CONTENT_TYPE, HeaderValue::from_static(PROBLEM_JSON));
        let _previous = headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;
    use stuffcloud_core::field::{FieldErrorCode, JsonPointer};

    use super::*;

    const ALL: [ProblemKind; 13] = [
        ProblemKind::BadRequest,
        ProblemKind::MalformedBody,
        ProblemKind::Unauthenticated,
        ProblemKind::NotFound,
        ProblemKind::MethodNotAllowed,
        ProblemKind::PreconditionFailed,
        ProblemKind::PayloadTooLarge,
        ProblemKind::UnsupportedMediaType,
        ProblemKind::ValidationFailed,
        ProblemKind::Internal,
        ProblemKind::NotReady,
        ProblemKind::Timeout,
        ProblemKind::Other(StatusCode::IM_A_TEAPOT),
    ];

    #[test]
    fn statuses_titles_and_types() {
        let table: Vec<(u16, &str, String)> = ALL
            .iter()
            .map(|k| (k.status().as_u16(), k.title(), k.type_uri()))
            .collect();
        let t = |slug: &str| format!("{TYPE_BASE}{slug}");
        assert_eq!(
            table,
            vec![
                (400, "Bad request", t("bad-request")),
                (400, "Malformed body", t("malformed-body")),
                (401, "Authentication required", t("unauthenticated")),
                (404, "Not found", t("not-found")),
                (405, "Method not allowed", t("method-not-allowed")),
                (412, "Precondition failed", t("precondition-failed")),
                (413, "Payload too large", t("payload-too-large")),
                (415, "Unsupported media type", t("unsupported-media-type")),
                (422, "Validation failed", t("validation-failed")),
                (500, "Internal error", t("internal")),
                (503, "Not ready", t("not-ready")),
                (503, "Request timed out", t("timeout")),
                (418, "I'm a teapot", "about:blank".to_owned()),
            ]
        );
    }

    #[test]
    fn other_status_without_a_reason_phrase() {
        let kind = ProblemKind::Other(StatusCode::from_u16(599).unwrap());
        assert_eq!(kind.title(), "Error");
        assert_eq!(kind.slug(), None);
    }

    #[test]
    fn every_documented_type_has_a_section_in_problems_md() {
        let doc = include_str!("../../../docs/api/problems.md");
        for kind in ALL {
            if let Some(slug) = kind.slug() {
                assert!(
                    doc.contains(&format!("<a id=\"{slug}\"></a>")),
                    "docs/api/problems.md lacks the anchor {slug}"
                );
            }
        }
    }

    #[test]
    fn validation_detail_counts_fields() {
        let error = FieldError::new(JsonPointer::root(), FieldErrorCode::InvalidType, "x");
        assert_eq!(
            Problem::validation(vec![error.clone()])
                .body()
                .detail
                .as_deref(),
            Some("1 invalid field")
        );
        assert_eq!(
            Problem::validation(vec![error.clone(), error])
                .body()
                .detail
                .as_deref(),
            Some("2 invalid fields")
        );
        assert_eq!(
            Problem::validation(vec![]).body().detail.as_deref(),
            Some("0 invalid fields")
        );
    }

    #[tokio::test]
    async fn response_is_problem_json() {
        let problem = Problem::validation(vec![FieldError::new(
            JsonPointer::root().key("names").index(0),
            FieldErrorCode::InvalidValue,
            "bad",
        )]);
        assert_eq!(problem.kind(), ProblemKind::ValidationFailed);
        let response = problem.into_response();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(response.headers()[CONTENT_TYPE], PROBLEM_JSON);
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": format!("{TYPE_BASE}validation-failed"),
                "title": "Validation failed",
                "status": 422,
                "detail": "1 invalid field",
                "errors": [{"pointer": "/names/0", "code": "invalid_value", "detail": "bad"}]
            })
        );
    }

    #[tokio::test]
    async fn optional_members_are_omitted() {
        let response = Problem::new(ProblemKind::NotFound).into_response();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": format!("{TYPE_BASE}not-found"),
                "title": "Not found",
                "status": 404
            })
        );
        let with_detail = Problem::with_detail(ProblemKind::BadRequest, "why").body();
        assert_eq!(with_detail.detail.as_deref(), Some("why"));
    }

    #[test]
    fn internal_hides_the_cause() {
        let problem = Problem::internal(&"disk on fire");
        assert_eq!(problem.kind(), ProblemKind::Internal);
        assert_eq!(problem.body().detail, None);
    }
}
