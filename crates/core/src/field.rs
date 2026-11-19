//! Field errors with JSON Pointers (RFC 6901), the building block of the validation problem
//! details of the API (RFC 9457; ADR 0010 decision 3: every invalid field at once, each with
//! a JSON Pointer to it).

use std::fmt;

use serde::Serialize;

/// A JSON Pointer (RFC 6901) into a request document. The empty pointer is the whole
/// document.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct JsonPointer(String);

impl JsonPointer {
    /// The pointer to the whole document (`""`).
    #[must_use]
    pub const fn root() -> Self {
        Self(String::new())
    }

    /// This pointer extended by an object member name; `~` and `/` are escaped.
    #[must_use]
    pub fn key(&self, name: &str) -> Self {
        let escaped = name.replace('~', "~0").replace('/', "~1");
        Self(format!("{}/{escaped}", self.0))
    }

    /// This pointer extended by an array index.
    #[must_use]
    pub fn index(&self, index: usize) -> Self {
        Self(format!("{}/{index}", self.0))
    }

    /// The pointer as text, ready for `serde_json::Value::pointer`.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The unescaped reference tokens, or `None` when the text is not a valid pointer (a
    /// non-empty pointer must start with `/`, `~` must be followed by `0` or `1`).
    #[must_use]
    pub fn tokens(&self) -> Option<Vec<String>> {
        parse_tokens(&self.0)
    }
}

/// Splits pointer text into unescaped reference tokens (RFC 6901, section 4).
fn parse_tokens(text: &str) -> Option<Vec<String>> {
    if text.is_empty() {
        return Some(Vec::new());
    }
    let rest = text.strip_prefix('/')?;
    rest.split('/')
        .map(|token| {
            let mut out = String::with_capacity(token.len());
            let mut chars = token.chars();
            while let Some(c) = chars.next() {
                if c == '~' {
                    match chars.next() {
                        Some('0') => out.push('~'),
                        Some('1') => out.push('/'),
                        _ => return None,
                    }
                } else {
                    out.push(c);
                }
            }
            Some(out)
        })
        .collect()
}

impl fmt::Display for JsonPointer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// What is wrong with a field. The serialised names are part of the API (stable).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum FieldErrorCode {
    /// A member the resource does not have (only `meta` is ignored).
    UnknownField,
    /// A writable field is missing (`PUT` takes the full writable shape).
    MissingField,
    /// The JSON type is wrong (for example a number where a list is expected).
    InvalidType,
    /// The value breaks a rule of the field.
    InvalidValue,
    /// The value repeats an earlier list entry.
    Duplicate,
    /// The list has more entries than allowed.
    TooMany,
}

/// One invalid field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct FieldError {
    /// Where the problem is: a JSON Pointer (RFC 6901) into the request document.
    #[cfg_attr(feature = "openapi", schema(value_type = String, example = "/names/0"))]
    pub pointer: JsonPointer,
    /// What kind of problem it is.
    pub code: FieldErrorCode,
    /// A sentence for people.
    pub detail: String,
}

impl FieldError {
    /// A field error.
    #[must_use]
    pub fn new(pointer: JsonPointer, code: FieldErrorCode, detail: impl Into<String>) -> Self {
        Self {
            pointer,
            code,
            detail: detail.into(),
        }
    }

    /// The same error with its pointer moved below `prefix` (for a resource nested in a
    /// larger document, such as the bootstrap configuration file).
    #[must_use]
    pub fn nested_in(self, prefix: &JsonPointer) -> Self {
        Self {
            pointer: JsonPointer(format!("{}{}", prefix.0, self.pointer.0)),
            ..self
        }
    }
}

impl fmt::Display for FieldError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let at = if self.pointer.0.is_empty() {
            "(document)"
        } else {
            self.pointer.as_str()
        };
        write!(f, "{at}: {}", self.detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_pointers_with_escaping() {
        let root = JsonPointer::root();
        assert_eq!(root.as_str(), "");
        assert_eq!(root.key("names").as_str(), "/names");
        assert_eq!(root.key("names").index(3).as_str(), "/names/3");
        assert_eq!(root.key("a/b~c").as_str(), "/a~1b~0c");
        assert_eq!(root.key("").as_str(), "/");
        assert_eq!(root.key("~1").as_str(), "/~01");
        assert_eq!(root.key("x").to_string(), "/x");
    }

    #[test]
    fn tokens_undo_the_escaping() {
        let pointer = JsonPointer::root().key("a/b~c").index(0).key("~1");
        assert_eq!(
            pointer.tokens(),
            Some(vec!["a/b~c".to_owned(), "0".to_owned(), "~1".to_owned()])
        );
        assert_eq!(JsonPointer::root().tokens(), Some(Vec::new()));
        assert_eq!(
            JsonPointer::root().key("").tokens(),
            Some(vec![String::new()])
        );
    }

    #[test]
    fn tokens_refuse_invalid_text() {
        assert_eq!(parse_tokens("a"), None);
        assert_eq!(parse_tokens("/a~"), None);
        assert_eq!(parse_tokens("/a~2"), None);
        assert_eq!(parse_tokens("/~0~1"), Some(vec!["~/".to_owned()]));
    }

    #[test]
    fn pointers_resolve_in_serde_json() {
        let doc = serde_json::json!({"a/b": [{"~": 1}]});
        let pointer = JsonPointer::root().key("a/b").index(0).key("~");
        assert_eq!(doc.pointer(pointer.as_str()), Some(&serde_json::json!(1)));
    }

    #[test]
    fn codes_serialise_as_snake_case() {
        let codes = [
            (FieldErrorCode::UnknownField, "unknown_field"),
            (FieldErrorCode::MissingField, "missing_field"),
            (FieldErrorCode::InvalidType, "invalid_type"),
            (FieldErrorCode::InvalidValue, "invalid_value"),
            (FieldErrorCode::Duplicate, "duplicate"),
            (FieldErrorCode::TooMany, "too_many"),
        ];
        for (code, name) in codes {
            assert_eq!(serde_json::to_value(code).unwrap(), serde_json::json!(name));
        }
    }

    #[test]
    fn field_error_serialises_and_displays() {
        let error = FieldError::new(
            JsonPointer::root().key("names").index(1),
            FieldErrorCode::Duplicate,
            "repeats /names/0",
        );
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({"pointer": "/names/1", "code": "duplicate", "detail": "repeats /names/0"})
        );
        assert_eq!(error.to_string(), "/names/1: repeats /names/0");
        let whole = FieldError::new(JsonPointer::root(), FieldErrorCode::InvalidType, "no");
        assert_eq!(whole.to_string(), "(document): no");
    }

    #[test]
    fn nesting_prefixes_the_pointer() {
        let error = FieldError::new(
            JsonPointer::root().key("names"),
            FieldErrorCode::InvalidValue,
            "bad",
        );
        let prefix = JsonPointer::root().key("settings").key("reserved-names");
        let nested = error.nested_in(&prefix);
        assert_eq!(nested.pointer.as_str(), "/settings/reserved-names/names");
        assert_eq!(nested.code, FieldErrorCode::InvalidValue);
        assert_eq!(nested.detail, "bad");
    }
}
