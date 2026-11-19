//! Instance-wide settings groups (SPEC 10.2 and 10.3, ADR 0010 decisions 2 and 9).
//!
//! A settings group is a singleton resource addressed by its name. This module holds the
//! writable shapes and their rules; storage and the HTTP conventions live in `db` and `app`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::body::Writable;
use crate::field::{FieldError, FieldErrorCode, JsonPointer};
use crate::subdomain::Subdomain;

/// Most names the instance-wide reserved list may hold.
pub const MAX_RESERVED_NAMES: usize = 1000;

/// Settings group `reserved-names`: site names nobody may claim in any zone, on top of the
/// names stuffcloud reserves itself ([`crate::subdomain::RESERVED`]) and those a zone
/// reserves (ADR 0009).
///
/// Each name must be a valid site name in canonical form (lowercase, see [`Subdomain`]),
/// may appear only once, and the list keeps the order it was written in, so a `GET` returns
/// exactly what the last `PUT` sent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct ReservedNames {
    /// The reserved site names.
    #[cfg_attr(feature = "openapi", schema(example = json!(["auth", "status"])))]
    pub names: Vec<String>,
}

impl ReservedNames {
    /// Name of the settings group in URLs and configuration files.
    pub const GROUP: &'static str = "reserved-names";

    /// The names as validated site names. Only meaningful for a value that passed
    /// [`Writable::validate`]; invalid entries are skipped.
    #[must_use]
    pub fn subdomains(&self) -> Vec<Subdomain> {
        self.names
            .iter()
            .filter_map(|name| Subdomain::parse(name).ok())
            .collect()
    }
}

impl Writable for ReservedNames {
    const FIELDS: &'static [&'static str] = &["names"];

    fn validate(&self) -> Vec<FieldError> {
        let field = JsonPointer::root().key("names");
        let mut errors = Vec::new();
        if self.names.len() > MAX_RESERVED_NAMES {
            errors.push(FieldError::new(
                field.clone(),
                FieldErrorCode::TooMany,
                format!(
                    "{} names given, at most {MAX_RESERVED_NAMES} are allowed",
                    self.names.len()
                ),
            ));
        }
        let mut first_seen: HashMap<&str, usize> = HashMap::new();
        for (index, name) in self.names.iter().enumerate() {
            if let Err(error) = Subdomain::parse(name) {
                errors.push(FieldError::new(
                    field.index(index),
                    FieldErrorCode::InvalidValue,
                    format!("{name:?} is not a site name that can be reserved: {error}"),
                ));
            } else if let Some(first) = first_seen.get(name.as_str()) {
                errors.push(FieldError::new(
                    field.index(index),
                    FieldErrorCode::Duplicate,
                    format!("{name:?} is already listed at /names/{first}"),
                ));
            } else {
                let _ = first_seen.insert(name, index);
            }
        }
        errors
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::body::{BodyError, parse_writable};

    fn names(list: &[&str]) -> ReservedNames {
        ReservedNames {
            names: list.iter().map(|name| (*name).to_owned()).collect(),
        }
    }

    #[test]
    fn valid_lists() {
        assert!(names(&[]).validate().is_empty());
        assert!(names(&["auth", "status", "a-b"]).validate().is_empty());
        let full: Vec<String> = (0..MAX_RESERVED_NAMES)
            .map(|i| format!("n{i:04}"))
            .collect();
        assert!(ReservedNames { names: full }.validate().is_empty());
    }

    #[test]
    fn too_many_names() {
        let list: Vec<String> = (0..=MAX_RESERVED_NAMES)
            .map(|i| format!("n{i:04}"))
            .collect();
        assert_eq!(
            ReservedNames { names: list }.validate(),
            vec![FieldError::new(
                JsonPointer::root().key("names"),
                FieldErrorCode::TooMany,
                "1001 names given, at most 1000 are allowed"
            )]
        );
    }

    #[test]
    fn every_invalid_and_duplicate_name_is_reported() {
        let errors = names(&["auth", "Auth", "ab", "auth", "wpad", "x_y", "auth"]).validate();
        let summary: Vec<(&str, FieldErrorCode)> = errors
            .iter()
            .map(|e| (e.pointer.as_str(), e.code))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("/names/1", FieldErrorCode::InvalidValue),
                ("/names/2", FieldErrorCode::InvalidValue),
                ("/names/3", FieldErrorCode::Duplicate),
                ("/names/4", FieldErrorCode::InvalidValue),
                ("/names/5", FieldErrorCode::InvalidValue),
                ("/names/6", FieldErrorCode::Duplicate),
            ]
        );
        assert_eq!(
            errors[0].detail,
            "\"Auth\" is not a site name that can be reserved: subdomain has a character other than a-z, 0-9 or '-' at byte 0"
        );
        assert_eq!(
            errors[3].detail,
            "\"wpad\" is not a site name that can be reserved: subdomain is reserved"
        );
        assert_eq!(errors[2].detail, "\"auth\" is already listed at /names/0");
        assert_eq!(errors[5].detail, "\"auth\" is already listed at /names/0");
    }

    #[test]
    fn subdomains_of_a_valid_list() {
        let list = names(&["auth", "status"]);
        let parsed: Vec<String> = list
            .subdomains()
            .iter()
            .map(|s| s.as_str().to_owned())
            .collect();
        assert_eq!(parsed, vec!["auth", "status"]);
        assert_eq!(names(&["Bad", "ok1"]).subdomains().len(), 1);
    }

    #[test]
    fn parses_through_the_writable_conventions() {
        let parsed: ReservedNames =
            parse_writable(br#"{"names":["auth"],"meta":{"etag":"x"}}"#).unwrap();
        assert_eq!(parsed, names(&["auth"]));
        match parse_writable::<ReservedNames>(
            json!({"names": ["ok1", "--"], "extra": true})
                .to_string()
                .as_bytes(),
        ) {
            Err(BodyError::Invalid(errors)) => {
                let pointers: Vec<&str> = errors.iter().map(|e| e.pointer.as_str()).collect();
                assert_eq!(pointers, vec!["/extra", "/names/1"]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn serialises_in_the_written_order() {
        let value = serde_json::to_value(names(&["zeta", "alpha"])).unwrap();
        assert_eq!(value, json!({"names": ["zeta", "alpha"]}));
        assert_eq!(ReservedNames::GROUP, "reserved-names");
    }
}
