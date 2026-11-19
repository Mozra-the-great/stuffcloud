//! Feeds arbitrary bytes to the `PUT` body parser with the `reserved-names` settings group.
//! Fails on a panic, on an accepted document that breaks a rule, and on a field error whose
//! JSON Pointer does not point into the document.
#![no_main]

use std::collections::HashSet;

use libfuzzer_sys::fuzz_target;
use serde_json::Value;
use stuffcloud_core::Subdomain;
use stuffcloud_core::body::{BodyError, MAX_FIELD_ERRORS, Writable, canonical, parse_writable};
use stuffcloud_core::settings::{MAX_RESERVED_NAMES, ReservedNames};

fuzz_target!(|data: &[u8]| {
    match parse_writable::<ReservedNames>(data) {
        Ok(parsed) => {
            assert!(parsed.validate().is_empty());
            assert!(parsed.names.len() <= MAX_RESERVED_NAMES);
            let mut seen = HashSet::new();
            for name in &parsed.names {
                assert_eq!(
                    Subdomain::parse(name).map(|s| s.as_str().to_owned()),
                    Ok(name.clone())
                );
                assert!(seen.insert(name), "duplicate {name:?} accepted");
            }
            // The canonical form parses back to the same value.
            let again: ReservedNames = parse_writable(canonical(&parsed).as_bytes()).unwrap();
            assert_eq!(again, parsed);
        }
        Err(BodyError::Malformed(_)) => {
            assert!(serde_json::from_slice::<Value>(data).is_err());
        }
        Err(BodyError::Invalid(errors)) => {
            assert!(!errors.is_empty() && errors.len() <= MAX_FIELD_ERRORS);
            let document: Value = serde_json::from_slice(data).unwrap();
            for error in &errors {
                let pointer = error.pointer.as_str();
                assert!(pointer.is_empty() || pointer.starts_with('/'));
                let tokens = error.pointer.tokens().unwrap();
                // Missing fields point at a member that is absent; everything else exists.
                if error.code != stuffcloud_core::field::FieldErrorCode::MissingField {
                    assert!(
                        document.pointer(pointer).is_some(),
                        "{pointer:?} points nowhere"
                    );
                } else {
                    assert_eq!(tokens.len(), 1);
                }
            }
        }
    }
});
