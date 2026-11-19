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
    #[cfg_attr(feature = "openapi", schema(example = json!(["intranet", "wiki"])))]
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

/// Who may create a local account (SPEC 6, ADR 0005 decision 5).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum SignupMode {
    /// Anyone who can reach the app may register.
    Open,
    /// Only holders of an invitation from an admin may register (the default).
    #[default]
    InviteOnly,
    /// No local registration; accounts come from the identity provider (A-06). Admins still
    /// create local accounts (the break-glass admin), and existing ones keep working.
    OidcOnly,
}

impl SignupMode {
    /// The name in documents and messages.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::InviteOnly => "invite-only",
            Self::OidcOnly => "oidc-only",
        }
    }
}

/// Settings group `signup`. A group that was never written means the default mode,
/// `invite-only`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct Signup {
    /// The sign-up mode.
    pub mode: SignupMode,
}

impl Signup {
    /// Name of the settings group in URLs and configuration files.
    pub const GROUP: &'static str = "signup";
}

impl Writable for Signup {
    const FIELDS: &'static [&'static str] = &["mode"];

    fn validate(&self) -> Vec<FieldError> {
        // Every value of the enum is valid; serde refuses anything else.
        Vec::new()
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
        assert!(names(&["intranet", "wiki", "a-b"]).validate().is_empty());
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
        let errors = names(&[
            "intranet", "Auth", "ab", "intranet", "wpad", "x_y", "intranet",
        ])
        .validate();
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
        assert_eq!(
            errors[2].detail,
            "\"intranet\" is already listed at /names/0"
        );
        assert_eq!(
            errors[5].detail,
            "\"intranet\" is already listed at /names/0"
        );
    }

    #[test]
    fn subdomains_of_a_valid_list() {
        let list = names(&["intranet", "wiki"]);
        let parsed: Vec<String> = list
            .subdomains()
            .iter()
            .map(|s| s.as_str().to_owned())
            .collect();
        assert_eq!(parsed, vec!["intranet", "wiki"]);
        assert_eq!(names(&["Bad", "ok1"]).subdomains().len(), 1);
    }

    #[test]
    fn parses_through_the_writable_conventions() {
        let parsed: ReservedNames =
            parse_writable(br#"{"names":["intranet"],"meta":{"etag":"x"}}"#).unwrap();
        assert_eq!(parsed, names(&["intranet"]));
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
    fn signup_modes() {
        assert_eq!(Signup::default().mode, SignupMode::InviteOnly);
        assert_eq!(Signup::GROUP, "signup");
        for (mode, name) in [
            (SignupMode::Open, "open"),
            (SignupMode::InviteOnly, "invite-only"),
            (SignupMode::OidcOnly, "oidc-only"),
        ] {
            assert_eq!(mode.as_str(), name);
            let parsed: Signup =
                parse_writable(json!({ "mode": name }).to_string().as_bytes()).unwrap();
            assert_eq!(parsed.mode, mode);
            assert!(parsed.validate().is_empty());
            assert_eq!(
                serde_json::to_value(parsed).unwrap(),
                json!({ "mode": name })
            );
        }
        match parse_writable::<Signup>(br#"{"mode":"closed"}"#) {
            Err(BodyError::Invalid(errors)) => {
                assert_eq!(errors.len(), 1);
                assert_eq!(errors[0].pointer.as_str(), "/mode");
                assert_eq!(errors[0].code, FieldErrorCode::InvalidType);
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
