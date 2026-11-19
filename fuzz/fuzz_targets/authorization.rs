//! Feeds arbitrary bytes to the `Authorization` classifier as header fields, one per line
//! (empty data is a request without the header). Fails on a panic and when the verdict breaks
//! a rule: only exactly one field, with the scheme `Bearer` in any case, one space and a
//! well-formed credential is a bearer token (the one case that skips the CSRF checks); several
//! fields are always malformed; a field with another scheme is `Other`, never a bearer; a
//! `Bearer` field with a bad credential is malformed, never ignored.
#![no_main]

use libfuzzer_sys::fuzz_target;
use stuffcloud_core::authorization::{Authorization, MAX_CREDENTIAL_LEN, classify, is_credential};

fuzz_target!(|data: &[u8]| {
    let values: Vec<&[u8]> = if data.is_empty() {
        Vec::new()
    } else {
        data.split(|byte| *byte == b'\n').collect()
    };
    let scheme_is_bearer = |value: &[u8]| {
        let end = value
            .iter()
            .position(|byte| *byte == b' ')
            .unwrap_or(value.len());
        value[..end].eq_ignore_ascii_case(b"bearer")
    };
    match classify(&values) {
        Authorization::Absent => assert!(values.is_empty()),
        Authorization::Bearer(credential) => {
            assert_eq!(values.len(), 1);
            let value = values[0];
            assert!(scheme_is_bearer(value));
            assert_eq!(value.len(), "Bearer ".len() + credential.len());
            assert_eq!(&value[value.len() - credential.len()..], credential);
            assert!(is_credential(credential));
            assert!(credential.len() <= MAX_CREDENTIAL_LEN);
            assert!(credential.is_ascii());
            assert!(!credential.contains(&b' '));
        }
        Authorization::Other => {
            assert_eq!(values.len(), 1);
            assert!(!scheme_is_bearer(values[0]));
        }
        Authorization::Malformed => {
            assert!(values.len() > 1 || scheme_is_bearer(values[0]));
        }
        _ => unreachable!("the classifier has no other verdict"),
    }
});
