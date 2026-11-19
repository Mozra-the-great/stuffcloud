//! Parsing of writable resource documents (ADR 0010 decision 3, SPEC 10.2).
//!
//! A `PUT` carries the full writable shape of a resource. [`parse_writable`] turns the
//! untrusted request body into the resource type and reports every problem at once:
//!
//! - the body must be a JSON object;
//! - a `meta` member is ignored (it is what `GET` returns next to the writable shape, so a
//!   client may send a document back unchanged);
//! - every other unknown member is an error, every missing writable field is an error;
//! - type errors carry the JSON Pointer of the offending value;
//! - when the shape is right, the resource's own rules ([`Writable::validate`]) run and add
//!   their errors.

use std::fmt;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::field::{FieldError, FieldErrorCode, JsonPointer};

/// The member of a resource document that `PUT` ignores.
pub const META_FIELD: &str = "meta";

/// Most field errors one response lists; the rest are dropped (a body with thousands of
/// bad entries would otherwise produce an answer far larger than itself).
pub const MAX_FIELD_ERRORS: usize = 100;

/// A resource shape that clients write in full with `PUT`.
pub trait Writable: Serialize + DeserializeOwned {
    /// Names of the writable fields. All of them are required.
    const FIELDS: &'static [&'static str];

    /// Checks the rules of the resource and returns every violation, with pointers
    /// relative to the document root. Empty when the value is valid.
    fn validate(&self) -> Vec<FieldError>;
}

/// Why a request body is not a valid resource document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyError {
    /// Not JSON at all; the parser's message (it has no position in the document).
    Malformed(String),
    /// JSON, but some fields are wrong: every problem, at most [`MAX_FIELD_ERRORS`].
    Invalid(Vec<FieldError>),
}

impl fmt::Display for BodyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed(message) => write!(f, "the body is not valid JSON: {message}"),
            Self::Invalid(errors) => {
                f.write_str("the document has invalid fields:")?;
                for error in errors {
                    write!(f, " {error};")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for BodyError {}

/// Parses a request body into the writable shape `T`.
///
/// # Errors
///
/// [`BodyError::Malformed`] when the bytes are not JSON, [`BodyError::Invalid`] with every
/// field problem otherwise.
pub fn parse_writable<T: Writable>(body: &[u8]) -> Result<T, BodyError> {
    let value: Value =
        serde_json::from_slice(body).map_err(|error| BodyError::Malformed(error.to_string()))?;
    parse_writable_value(value).map_err(BodyError::Invalid)
}

/// As [`parse_writable`], for a document that is already parsed (for example one entry of
/// a configuration file).
///
/// # Errors
///
/// Every field problem, at most [`MAX_FIELD_ERRORS`].
pub fn parse_writable_value<T: Writable>(value: Value) -> Result<T, Vec<FieldError>> {
    let Value::Object(mut members) = value else {
        return Err(vec![FieldError::new(
            JsonPointer::root(),
            FieldErrorCode::InvalidType,
            format!("expected a JSON object, got {}", kind_of(&value)),
        )]);
    };
    let _meta = members.remove(META_FIELD);
    let root = JsonPointer::root();
    let mut errors: Vec<FieldError> = members
        .keys()
        .filter(|name| !T::FIELDS.contains(&name.as_str()))
        .map(|name| {
            FieldError::new(
                root.key(name),
                FieldErrorCode::UnknownField,
                format!("unknown field {name:?}"),
            )
        })
        .collect();
    errors.extend(
        T::FIELDS
            .iter()
            .filter(|name| !members.contains_key(**name))
            .map(|name| {
                FieldError::new(
                    root.key(name),
                    FieldErrorCode::MissingField,
                    format!("missing field {name:?} (PUT takes the full writable shape)"),
                )
            }),
    );
    let known: Map<String, Value> = members
        .into_iter()
        .filter(|(name, _)| T::FIELDS.contains(&name.as_str()))
        .collect();
    if errors
        .iter()
        .all(|error| error.code != FieldErrorCode::MissingField)
    {
        match serde_path_to_error::deserialize::<_, T>(Value::Object(known)) {
            Ok(parsed) => {
                errors.extend(parsed.validate());
                if errors.is_empty() {
                    return Ok(parsed);
                }
            }
            Err(error) => errors.push(FieldError::new(
                pointer_of(error.path()),
                FieldErrorCode::InvalidType,
                error.inner().to_string(),
            )),
        }
    }
    errors.truncate(MAX_FIELD_ERRORS);
    Err(errors)
}

/// The canonical JSON of a writable document: what the store keeps and what its entity tag
/// is computed from. Serialising a derived struct with string keys into a string cannot
/// fail; should a hand-written `Serialize` ever fail, the empty string is stored, which no
/// document parses back from, so the error surfaces on the next read.
#[must_use]
pub fn canonical<T: Writable>(document: &T) -> String {
    serde_json::to_string(document).unwrap_or_default()
}

/// The JSON type name of a value, for messages.
fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

/// Converts the path of a deserialisation error into a JSON Pointer.
fn pointer_of(path: &serde_path_to_error::Path) -> JsonPointer {
    path.iter()
        .fold(JsonPointer::root(), |pointer, segment| match segment {
            serde_path_to_error::Segment::Seq { index } => pointer.index(*index),
            serde_path_to_error::Segment::Map { key } => pointer.key(key),
            serde_path_to_error::Segment::Enum { .. } | serde_path_to_error::Segment::Unknown => {
                pointer
            }
        })
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    /// A small resource with two fields and one rule.
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Sample {
        name: String,
        sizes: Vec<u8>,
    }

    impl Writable for Sample {
        const FIELDS: &'static [&'static str] = &["name", "sizes"];

        fn validate(&self) -> Vec<FieldError> {
            let mut errors = Vec::new();
            if self.name.is_empty() {
                errors.push(FieldError::new(
                    JsonPointer::root().key("name"),
                    FieldErrorCode::InvalidValue,
                    "empty",
                ));
            }
            for (index, size) in self.sizes.iter().enumerate() {
                if *size == 0 {
                    errors.push(FieldError::new(
                        JsonPointer::root().key("sizes").index(index),
                        FieldErrorCode::InvalidValue,
                        "zero",
                    ));
                }
            }
            errors
        }
    }

    fn invalid(body: &Value) -> Vec<(String, FieldErrorCode)> {
        match parse_writable::<Sample>(body.to_string().as_bytes()) {
            Err(BodyError::Invalid(errors)) => errors
                .into_iter()
                .map(|e| (e.pointer.as_str().to_owned(), e.code))
                .collect(),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn accepts_a_valid_document() {
        let parsed = parse_writable::<Sample>(br#"{"name":"a","sizes":[1,2]}"#).unwrap();
        assert_eq!(
            parsed,
            Sample {
                name: "a".to_owned(),
                sizes: vec![1, 2]
            }
        );
    }

    #[test]
    fn ignores_meta_of_any_shape() {
        for meta in [json!({"etag": "x"}), json!(null), json!([1])] {
            let body = json!({"name": "a", "sizes": [], "meta": meta});
            assert!(parse_writable::<Sample>(body.to_string().as_bytes()).is_ok());
        }
    }

    #[test]
    fn refuses_bytes_that_are_not_json() {
        match parse_writable::<Sample>(b"{\"name\":") {
            Err(BodyError::Malformed(message)) => assert!(message.contains("EOF"), "{message}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn refuses_documents_that_are_not_objects() {
        for (body, kind) in [
            (json!(null), "null"),
            (json!(true), "a boolean"),
            (json!(1), "a number"),
            (json!("x"), "a string"),
            (json!([]), "an array"),
        ] {
            assert_eq!(kind_of(&body), kind);
            match parse_writable::<Sample>(body.to_string().as_bytes()) {
                Err(BodyError::Invalid(errors)) => {
                    assert_eq!(
                        errors,
                        vec![FieldError::new(
                            JsonPointer::root(),
                            FieldErrorCode::InvalidType,
                            format!("expected a JSON object, got {kind}")
                        )]
                    );
                }
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn canonical_form_is_compact_and_ordered_like_the_struct() {
        let sample = Sample {
            name: "a".to_owned(),
            sizes: vec![2, 1],
        };
        assert_eq!(canonical(&sample), r#"{"name":"a","sizes":[2,1]}"#);
    }

    #[test]
    fn value_parsing_returns_the_errors() {
        assert_eq!(
            parse_writable_value::<Sample>(json!({"name": "a"})).unwrap_err(),
            vec![FieldError::new(
                JsonPointer::root().key("sizes"),
                FieldErrorCode::MissingField,
                "missing field \"sizes\" (PUT takes the full writable shape)"
            )]
        );
    }

    #[test]
    fn names_the_object_type() {
        assert_eq!(kind_of(&json!({})), "an object");
    }

    #[test]
    fn reports_unknown_and_missing_fields_together() {
        let errors = invalid(&json!({"extra": 1, "name": "a", "other": 2}));
        assert_eq!(
            errors,
            vec![
                ("/extra".to_owned(), FieldErrorCode::UnknownField),
                ("/other".to_owned(), FieldErrorCode::UnknownField),
                ("/sizes".to_owned(), FieldErrorCode::MissingField),
            ]
        );
    }

    #[test]
    fn reports_unknown_fields_and_rule_violations_together() {
        let errors = invalid(&json!({"name": "", "sizes": [1, 0, 0], "x/y": 1}));
        assert_eq!(
            errors,
            vec![
                ("/x~1y".to_owned(), FieldErrorCode::UnknownField),
                ("/name".to_owned(), FieldErrorCode::InvalidValue),
                ("/sizes/1".to_owned(), FieldErrorCode::InvalidValue),
                ("/sizes/2".to_owned(), FieldErrorCode::InvalidValue),
            ]
        );
    }

    #[test]
    fn type_errors_point_at_the_value() {
        assert_eq!(
            invalid(&json!({"name": "a", "sizes": [1, "two"]})),
            vec![("/sizes/1".to_owned(), FieldErrorCode::InvalidType)]
        );
        assert_eq!(
            invalid(&json!({"name": 5, "sizes": []})),
            vec![("/name".to_owned(), FieldErrorCode::InvalidType)]
        );
        assert_eq!(
            invalid(&json!({"name": "a", "sizes": [300]})),
            vec![("/sizes/0".to_owned(), FieldErrorCode::InvalidType)]
        );
    }

    #[test]
    fn messages_name_the_field() {
        match parse_writable::<Sample>(br#"{"name":"a","zzz":1}"#) {
            Err(BodyError::Invalid(errors)) => {
                assert_eq!(errors[0].detail, "unknown field \"zzz\"");
                assert_eq!(
                    errors[1].detail,
                    "missing field \"sizes\" (PUT takes the full writable shape)"
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn caps_the_number_of_errors() {
        let sizes = vec![0; MAX_FIELD_ERRORS + 5];
        let errors = invalid(&json!({"name": "a", "sizes": sizes}));
        assert_eq!(errors.len(), MAX_FIELD_ERRORS);
        let sizes = vec![0; MAX_FIELD_ERRORS];
        assert_eq!(
            invalid(&json!({"name": "a", "sizes": sizes})).len(),
            MAX_FIELD_ERRORS
        );
    }

    #[test]
    fn pointer_of_ignores_enum_segments() {
        #[derive(Debug, Deserialize)]
        enum Shape {
            Square(#[expect(dead_code, reason = "only deserialised to provoke an error")] u8),
        }
        let error = serde_path_to_error::deserialize::<_, Vec<Shape>>(json!([{"Square": "x"}]))
            .unwrap_err();
        assert_eq!(pointer_of(error.path()).as_str(), "/0");
    }

    #[test]
    fn display_lists_every_problem() {
        assert_eq!(
            BodyError::Malformed("EOF".to_owned()).to_string(),
            "the body is not valid JSON: EOF"
        );
        let error = BodyError::Invalid(vec![
            FieldError::new(JsonPointer::root().key("a"), FieldErrorCode::Duplicate, "x"),
            FieldError::new(JsonPointer::root(), FieldErrorCode::InvalidType, "y"),
        ]);
        assert_eq!(
            error.to_string(),
            "the document has invalid fields: /a: x; (document): y;"
        );
    }
}
