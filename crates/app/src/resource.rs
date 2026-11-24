//! The resource conventions of ADR 0010 (decision 3), built once for every resource:
//!
//! - `GET` returns the writable shape plus a read-only `meta` object and a strong `ETag`;
//! - `PUT` creates or replaces with the full writable shape, idempotently, and answers
//!   `created` (201), `updated` or `unchanged` (200) with a field-level diff; an unchanged
//!   write changes nothing, not even a timestamp, and adds no audit row;
//! - `DELETE` removes the resource (404 when there is none);
//! - writes honour `If-Match` and `If-None-Match` (412 when they fail) and `?dry_run=true`
//!   (everything runs, nothing changes, the answer says what would happen);
//! - bodies must be `application/json`, unknown fields other than `meta` are refused, and
//!   every invalid field comes back in one RFC 9457 problem.
//!
//! A resource type only supplies its writable shape ([`Writable`]) and a thin handler per
//! method; see `settings.rs`.

use axum::body::{Body, to_bytes};
use axum::http::header::{CONTENT_TYPE, ETAG, IF_MATCH, IF_NONE_MATCH};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::Value;
use stuffcloud_core::body::{BodyError, Writable, canonical, parse_writable};
use stuffcloud_core::etag::Condition;
use stuffcloud_core::query::WriteQuery;
use stuffcloud_db::{Change, DeleteOutcome, Preconditions, PutOutcome, Stored, WriteContext};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use utoipa::ToSchema;

use crate::auth::Authentication;
use crate::problem::{Problem, ProblemKind};
use crate::state::AppState;

/// The read-only part of a resource document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct ResourceMeta {
    /// Internal id; never needed to address the resource.
    pub id: i64,
    /// The strong entity tag, exactly as in the `ETag` header (with quotes).
    #[schema(example = "\"3f2a9c0b7d1e4a5f8b6c2d0e9f1a7b3c\"")]
    pub etag: String,
    /// Creation time (RFC 3339, UTC).
    pub created_at: String,
    /// Time of the last change (RFC 3339, UTC).
    pub updated_at: String,
}

/// A resource as `GET` returns it: the writable shape plus `meta`.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct Envelope<T: ToSchema> {
    /// The writable fields.
    #[serde(flatten)]
    pub body: T,
    /// Read-only facts; ignored when the document is sent back with `PUT`.
    pub meta: ResourceMeta,
}

/// What a write did (or would do, in a dry run).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WriteChange {
    /// The resource was created.
    Created,
    /// The resource was replaced with different content.
    Updated,
    /// The resource already had this content; nothing changed.
    Unchanged,
    /// The resource was deleted.
    Deleted,
}

impl From<Change> for WriteChange {
    fn from(change: Change) -> Self {
        match change {
            Change::Created => Self::Created,
            Change::Updated => Self::Updated,
            Change::Unchanged => Self::Unchanged,
            Change::Deleted => Self::Deleted,
        }
    }
}

/// One changed field.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct FieldChange {
    /// JSON Pointer of the field.
    pub pointer: String,
    /// Value before the write (absent when the resource did not exist).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<Value>,
    /// Value after the write (absent for a delete).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Value>,
}

/// The answer to a write.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct WriteResult<T: ToSchema> {
    /// What happened.
    pub result: WriteChange,
    /// Whether this was a dry run (then nothing was changed).
    pub dry_run: bool,
    /// Every field that changed (or would change).
    pub diff: Vec<FieldChange>,
    /// The resource after the write; absent after a delete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<Envelope<T>>,
}

/// Formats Unix milliseconds as RFC 3339 (UTC).
///
/// # Errors
///
/// An internal problem for a time outside the representable range.
pub fn rfc3339(millis: i64) -> Result<String, Problem> {
    i128::from(millis)
        .checked_mul(1_000_000)
        .and_then(|nanos| OffsetDateTime::from_unix_timestamp_nanos(nanos).ok())
        .and_then(|time| time.format(&Rfc3339).ok())
        .ok_or_else(|| Problem::internal(&format_args!("timestamp {millis} out of range")))
}

/// The value of the `ETag` header for a stored resource.
#[must_use]
pub fn etag_header(stored: &Stored) -> String {
    format!("\"{}\"", stored.etag)
}

/// `meta` of a stored resource.
///
/// # Errors
///
/// An internal problem for a corrupt timestamp.
pub fn meta(stored: &Stored) -> Result<ResourceMeta, Problem> {
    Ok(ResourceMeta {
        id: stored.id,
        etag: etag_header(stored),
        created_at: rfc3339(stored.created_at)?,
        updated_at: rfc3339(stored.updated_at)?,
    })
}

/// A stored resource as the typed document `GET` returns.
///
/// # Errors
///
/// An internal problem when the stored body no longer parses (it was written by this code,
/// so that means a corrupt database).
pub fn envelope<T: Writable + ToSchema>(stored: &Stored) -> Result<Envelope<T>, Problem> {
    let body: T = serde_json::from_str(&stored.body).map_err(|error| Problem::internal(&error))?;
    Ok(Envelope {
        body,
        meta: meta(stored)?,
    })
}

/// The field-level diff between two bodies (`None`: the resource does not exist).
#[must_use]
pub fn diff(fields: &[&str], before: Option<&Value>, after: Option<&Value>) -> Vec<FieldChange> {
    fields
        .iter()
        .filter_map(|field| {
            let old = before.and_then(|value| value.get(field)).cloned();
            let new = after.and_then(|value| value.get(field)).cloned();
            (old != new).then(|| FieldChange {
                pointer: format!("/{field}"),
                before: old,
                after: new,
            })
        })
        .collect()
}

fn parse_stored(stored: Option<&Stored>) -> Result<Option<Value>, Problem> {
    stored
        .map(|stored| serde_json::from_str(&stored.body).map_err(|error| Problem::internal(&error)))
        .transpose()
}

/// Reads one precondition header; repeated header lines form one list (RFC 9110, 5.3).
fn condition(headers: &HeaderMap, name: &HeaderName) -> Result<Option<Condition>, Problem> {
    let mut values = Vec::new();
    for value in headers.get_all(name) {
        let text = value.to_str().map_err(|_not_ascii| {
            Problem::with_detail(
                ProblemKind::BadRequest,
                format!("{name} must be visible ASCII"),
            )
        })?;
        values.push(text);
    }
    if values.is_empty() {
        return Ok(None);
    }
    Condition::parse(&values.join(", "))
        .map(Some)
        .map_err(|error| Problem::with_detail(ProblemKind::BadRequest, format!("{name}: {error}")))
}

/// The `If-Match` / `If-None-Match` preconditions of a request.
///
/// # Errors
///
/// A 400 problem for a malformed header.
pub fn preconditions(headers: &HeaderMap) -> Result<Preconditions, Problem> {
    Ok(Preconditions {
        if_match: condition(headers, &IF_MATCH)?,
        if_none_match: condition(headers, &IF_NONE_MATCH)?,
    })
}

/// The query string of a write.
///
/// # Errors
///
/// A 400 problem naming the bad parameter.
pub fn write_query(parts: &Parts) -> Result<WriteQuery, Problem> {
    WriteQuery::parse(parts.uri.query())
        .map_err(|error| Problem::with_detail(ProblemKind::BadRequest, error.to_string()))
}

/// Refuses bodies that are not JSON (`application/json` or a `+json` type).
///
/// # Errors
///
/// A 415 problem.
pub fn require_json(headers: &HeaderMap) -> Result<(), Problem> {
    let essence = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase());
    match essence.as_deref() {
        Some(media)
            if media == "application/json"
                || (media.starts_with("application/") && media.ends_with("+json")) =>
        {
            Ok(())
        }
        _ => Err(Problem::with_detail(
            ProblemKind::UnsupportedMediaType,
            "the body must be JSON (Content-Type: application/json)",
        )),
    }
}

/// Reads the body up to the configured limit.
///
/// # Errors
///
/// A 413 problem when the body is larger.
pub async fn read_body(body: Body, limit: usize) -> Result<Vec<u8>, Problem> {
    to_bytes(body, limit)
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|_too_large| {
            Problem::with_detail(
                ProblemKind::PayloadTooLarge,
                format!("the body is larger than {limit} bytes"),
            )
        })
}

/// Parses a writable document.
///
/// # Errors
///
/// 400 for bytes that are not JSON, 422 with every invalid field otherwise.
pub fn parse_document<T: Writable>(bytes: &[u8]) -> Result<T, Problem> {
    parse_writable(bytes).map_err(|error| match error {
        BodyError::Malformed(message) => Problem::with_detail(
            ProblemKind::MalformedBody,
            format!("the body is not valid JSON: {message}"),
        ),
        BodyError::Invalid(errors) => Problem::validation(errors),
    })
}

/// The audit actor of a request: the account of its session (`user:<id>`), none otherwise.
fn actor_of(parts: &Parts) -> Option<String> {
    Authentication::of(parts)
        .user()
        .map(|user| stuffcloud_db::auth::actor(user.id))
}

fn with_etag(mut response: Response, stored: &Stored) -> Response {
    if let Ok(value) = HeaderValue::from_str(&etag_header(stored)) {
        let _previous = response.headers_mut().insert(ETAG, value);
    }
    response
}

fn precondition_failed() -> Problem {
    Problem::with_detail(
        ProblemKind::PreconditionFailed,
        "the resource does not match If-Match / If-None-Match; read it again and retry",
    )
}

fn not_found(kind: &str, key: &str) -> Problem {
    Problem::with_detail(
        ProblemKind::NotFound,
        format!("{kind} {key:?} does not exist"),
    )
}

/// `GET` of a resource.
///
/// # Errors
///
/// The problem to answer with (404, 500). Who may read is decided by the route's guard
/// ([`crate::access`]).
pub async fn get<T: Writable + ToSchema + Send + 'static>(
    state: &AppState,
    kind: &'static str,
    key: &'static str,
) -> Result<Response, Problem> {
    let stored = state
        .db(move |db| db.get(kind, key))
        .await?
        .ok_or_else(|| not_found(kind, key))?;
    let document = envelope::<T>(&stored)?;
    Ok(with_etag(axum::Json(document).into_response(), &stored))
}

/// `PUT` of a resource (create or replace).
///
/// # Errors
///
/// The problem to answer with (400, 412, 413, 415, 422, 500). Who may write is decided by the
/// route's guard ([`crate::access`]), which runs before the handler.
pub async fn put<T: Writable + ToSchema + Send + 'static>(
    state: &AppState,
    request: Request<Body>,
    kind: &'static str,
    key: &'static str,
) -> Result<Response, Problem> {
    let (parts, body) = request.into_parts();
    let query = write_query(&parts)?;
    let preconditions = preconditions(&parts.headers)?;
    require_json(&parts.headers)?;
    let bytes = read_body(body, state.limits().max_body_bytes).await?;
    let document: T = parse_document(&bytes)?;
    let canonical = canonical(&document);
    let after = serde_json::to_value(&document).unwrap_or(Value::Null);
    let ctx = WriteContext {
        now: state.now_millis(),
        actor: actor_of(&parts),
        dry_run: query.dry_run,
    };
    let outcome = state
        .db(move |db| db.put(kind, key, &canonical, &preconditions, &ctx))
        .await?;
    let written = match outcome {
        PutOutcome::Written(written) => written,
        PutOutcome::PreconditionFailed { .. } => return Err(precondition_failed()),
    };
    let before = parse_stored(written.previous.as_ref())?;
    let result = WriteResult {
        result: written.change.into(),
        dry_run: query.dry_run,
        diff: diff(T::FIELDS, before.as_ref(), Some(&after)),
        resource: Some(envelope::<T>(&written.current)?),
    };
    let status = if written.change == Change::Created && !query.dry_run {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok(with_etag(
        (status, axum::Json(result)).into_response(),
        &written.current,
    ))
}

/// `DELETE` of a resource.
///
/// # Errors
///
/// The problem to answer with (400, 404, 412, 500). Who may delete is decided by the route's
/// guard ([`crate::access`]).
pub async fn delete<T: Writable + ToSchema + Send + 'static>(
    state: &AppState,
    parts: &Parts,
    kind: &'static str,
    key: &'static str,
) -> Result<Response, Problem> {
    let query = write_query(parts)?;
    let preconditions = preconditions(&parts.headers)?;
    let ctx = WriteContext {
        now: state.now_millis(),
        actor: actor_of(parts),
        dry_run: query.dry_run,
    };
    let outcome = state
        .db(move |db| db.delete(kind, key, &preconditions, &ctx))
        .await?;
    let previous = match outcome {
        DeleteOutcome::Deleted { previous } => previous,
        DeleteOutcome::NotFound => return Err(not_found(kind, key)),
        DeleteOutcome::PreconditionFailed { .. } => return Err(precondition_failed()),
    };
    let before = parse_stored(Some(&previous))?;
    let result: WriteResult<T> = WriteResult {
        result: WriteChange::Deleted,
        dry_run: query.dry_run,
        diff: diff(T::FIELDS, before.as_ref(), None),
        resource: None,
    };
    Ok(axum::Json(result).into_response())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn headers(pairs: &[(&HeaderName, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            let _ = map.append((*name).clone(), HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn stored(etag: &str, created: i64, updated: i64) -> Stored {
        Stored {
            id: 3,
            body: "{\"names\":[\"intranet\"]}".to_owned(),
            etag: etag.to_owned(),
            created_at: created,
            updated_at: updated,
        }
    }

    #[test]
    fn timestamps_are_rfc3339() {
        assert_eq!(rfc3339(0).unwrap(), "1970-01-01T00:00:00Z");
        assert_eq!(
            rfc3339(1_763_510_400_123).unwrap(),
            "2025-11-19T00:00:00.123Z"
        );
        assert_eq!(rfc3339(i64::MAX).unwrap_err().kind(), ProblemKind::Internal);
        assert_eq!(rfc3339(i64::MIN).unwrap_err().kind(), ProblemKind::Internal);
    }

    #[test]
    fn meta_of_a_stored_resource() {
        let meta = meta(&stored("abc", 0, 1000)).unwrap();
        assert_eq!(
            meta,
            ResourceMeta {
                id: 3,
                etag: "\"abc\"".to_owned(),
                created_at: "1970-01-01T00:00:00Z".to_owned(),
                updated_at: "1970-01-01T00:00:01Z".to_owned(),
            }
        );
        assert_eq!(
            super::meta(&stored("abc", 0, i64::MAX)).unwrap_err().kind(),
            ProblemKind::Internal
        );
        assert_eq!(
            super::meta(&stored("abc", i64::MAX, 0)).unwrap_err().kind(),
            ProblemKind::Internal
        );
    }

    #[test]
    fn envelope_flattens_the_body() {
        use stuffcloud_core::settings::ReservedNames;
        let document = envelope::<ReservedNames>(&stored("abc", 0, 0)).unwrap();
        assert_eq!(
            serde_json::to_value(&document).unwrap(),
            json!({
                "names": ["intranet"],
                "meta": {"id": 3, "etag": "\"abc\"", "created_at": "1970-01-01T00:00:00Z", "updated_at": "1970-01-01T00:00:00Z"}
            })
        );
        let corrupt = Stored {
            body: "{".to_owned(),
            ..stored("abc", 0, 0)
        };
        assert_eq!(
            envelope::<ReservedNames>(&corrupt).unwrap_err().kind(),
            ProblemKind::Internal
        );
        assert_eq!(
            parse_stored(Some(&corrupt)).unwrap_err().kind(),
            ProblemKind::Internal
        );
        assert_eq!(parse_stored(None).unwrap(), None);
    }

    #[test]
    fn diff_lists_changed_fields_only() {
        let fields = ["a", "b", "c"];
        let before = json!({"a": 1, "b": [1], "c": "x"});
        let after = json!({"a": 1, "b": [1, 2], "c": "y"});
        assert_eq!(
            diff(&fields, Some(&before), Some(&after)),
            vec![
                FieldChange {
                    pointer: "/b".to_owned(),
                    before: Some(json!([1])),
                    after: Some(json!([1, 2]))
                },
                FieldChange {
                    pointer: "/c".to_owned(),
                    before: Some(json!("x")),
                    after: Some(json!("y"))
                },
            ]
        );
        assert_eq!(diff(&fields, Some(&before), Some(&before)), Vec::new());
        let created = diff(&["a"], None, Some(&after));
        assert_eq!(
            created,
            vec![FieldChange {
                pointer: "/a".to_owned(),
                before: None,
                after: Some(json!(1))
            }]
        );
        let deleted = diff(&["a"], Some(&before), None);
        assert_eq!(deleted[0].after, None);
        assert_eq!(deleted[0].before, Some(json!(1)));
        assert_eq!(
            serde_json::to_value(&deleted[0]).unwrap(),
            json!({"pointer": "/a", "before": 1})
        );
    }

    #[test]
    fn change_mapping() {
        for (change, expected) in [
            (Change::Created, WriteChange::Created),
            (Change::Updated, WriteChange::Updated),
            (Change::Unchanged, WriteChange::Unchanged),
            (Change::Deleted, WriteChange::Deleted),
        ] {
            assert_eq!(WriteChange::from(change), expected);
            assert_eq!(
                serde_json::to_value(expected).unwrap(),
                json!(change.as_str())
            );
        }
    }

    #[test]
    fn preconditions_from_headers() {
        assert_eq!(
            preconditions(&HeaderMap::new()).unwrap(),
            Preconditions::default()
        );
        let both = preconditions(&headers(&[
            (&IF_MATCH, "\"a\""),
            (&IF_MATCH, "\"b\""),
            (&IF_NONE_MATCH, "*"),
        ]))
        .unwrap();
        assert_eq!(
            both.if_match,
            Some(Condition::parse("\"a\", \"b\"").unwrap())
        );
        assert_eq!(both.if_none_match, Some(Condition::Any));
        let bad = preconditions(&headers(&[(&IF_MATCH, "abc")])).unwrap_err();
        assert_eq!(bad.kind(), ProblemKind::BadRequest);
        assert_eq!(
            bad.body().detail.as_deref(),
            Some("if-match: not a valid entity tag list (at byte 0)")
        );
        let mut binary = HeaderMap::new();
        let _ = binary.insert(IF_NONE_MATCH, HeaderValue::from_bytes(b"\"\xff\"").unwrap());
        let problem = preconditions(&binary).unwrap_err();
        assert_eq!(
            problem.body().detail.as_deref(),
            Some("if-none-match must be visible ASCII")
        );
    }

    #[test]
    fn json_content_types() {
        for good in [
            "application/json",
            "Application/JSON; charset=utf-8",
            "application/merge-patch+json",
            " application/json ",
        ] {
            assert!(
                require_json(&headers(&[(&CONTENT_TYPE, good)])).is_ok(),
                "{good}"
            );
        }
        for bad in [
            "text/plain",
            "application/x-www-form-urlencoded",
            "text/json",
            "application/jsonx",
            "json",
        ] {
            assert_eq!(
                require_json(&headers(&[(&CONTENT_TYPE, bad)]))
                    .unwrap_err()
                    .kind(),
                ProblemKind::UnsupportedMediaType,
                "{bad}"
            );
        }
        assert!(require_json(&HeaderMap::new()).is_err());
    }

    #[test]
    fn query_problems() {
        let (parts, ()) = Request::builder()
            .uri("/x?dryrun=true")
            .body(())
            .unwrap()
            .into_parts();
        let problem = write_query(&parts).unwrap_err();
        assert_eq!(problem.kind(), ProblemKind::BadRequest);
        assert_eq!(
            problem.body().detail.as_deref(),
            Some("unknown query parameter \"dryrun\"")
        );
        let (parts, ()) = Request::builder()
            .uri("/x?dry_run=true")
            .body(())
            .unwrap()
            .into_parts();
        assert!(write_query(&parts).unwrap().dry_run);
    }

    #[tokio::test]
    async fn body_limit() {
        assert_eq!(read_body(Body::from("12345"), 5).await.unwrap(), b"12345");
        let problem = read_body(Body::from("123456"), 5).await.unwrap_err();
        assert_eq!(problem.kind(), ProblemKind::PayloadTooLarge);
        assert_eq!(
            problem.body().detail.as_deref(),
            Some("the body is larger than 5 bytes")
        );
    }

    #[test]
    fn document_problems() {
        use stuffcloud_core::settings::ReservedNames;
        let malformed = parse_document::<ReservedNames>(b"{").unwrap_err();
        assert_eq!(malformed.kind(), ProblemKind::MalformedBody);
        assert!(
            malformed
                .body()
                .detail
                .unwrap()
                .starts_with("the body is not valid JSON: ")
        );
        let invalid =
            parse_document::<ReservedNames>(br#"{"names":["ok1","X"],"x":1}"#).unwrap_err();
        assert_eq!(invalid.kind(), ProblemKind::ValidationFailed);
        assert_eq!(invalid.body().errors.len(), 2);
    }

    #[test]
    fn etag_header_quotes_the_tag() {
        assert_eq!(etag_header(&stored("abc", 0, 0)), "\"abc\"");
        let response = with_etag(().into_response(), &stored("abc", 0, 0));
        assert_eq!(response.headers()[ETAG], "\"abc\"");
        let response = with_etag(().into_response(), &stored("a\nb", 0, 0));
        assert!(response.headers().get(ETAG).is_none());
    }
}
