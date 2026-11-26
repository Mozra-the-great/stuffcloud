//! Feeds arbitrary bytes to the `PUT` body parser with the `smtp` settings group. Fails on a
//! panic and on an accepted document that breaks a rule of `stuffcloud_core::smtp`: no control
//! character in the host, the username, the sender or its name; no `<`, `>`, `"` or `\` in the
//! name; a host that is an IP address or made of DNS labels only; a port from 1; the sender is
//! one address; credentials come as a pair and never with `security: none`; the password is a
//! reference with the prefix `STUFFCLOUD_SECRET_`; the document survives its canonical form. And
//! on a refusal that echoes a secret: every error about `/password` is one of the fixed
//! sentences, so what was typed into the field never comes back.
#![no_main]

use libfuzzer_sys::fuzz_target;
use serde_json::Value;
use stuffcloud_core::body::{BodyError, MAX_FIELD_ERRORS, Writable, canonical, parse_writable};
use stuffcloud_core::smtp::{
    FILE_SUFFIX, SECRET_PREFIX, SECRET_SHAPE_MESSAGE, SecretRefError, Smtp, SmtpSecurity,
    valid_from_name, valid_host,
};

fn no_control(text: &str) -> bool {
    !text.chars().any(char::is_control)
}

/// Every sentence an error at `/password` may be.
fn allowed_password_detail(detail: &str) -> bool {
    detail == SECRET_SHAPE_MESSAGE
        || detail == "a username needs a password reference"
        || [
            SecretRefError::Prefix,
            SecretRefError::Length,
            SecretRefError::Name,
        ]
        .iter()
        .any(|error| error.to_string() == detail)
}

fuzz_target!(|data: &[u8]| {
    match parse_writable::<Smtp>(data) {
        Ok(smtp) => {
            assert!(smtp.validate().is_empty());
            assert!(valid_host(&smtp.host) && no_control(&smtp.host));
            assert!(smtp.port >= 1);
            assert!(smtp.from_address().is_some());
            assert!(smtp.from.is_ascii() && no_control(&smtp.from));
            assert_eq!(smtp.from.matches('@').count(), 1);
            if let Some(name) = &smtp.from_name {
                assert!(valid_from_name(name) && no_control(name));
                assert!(!name.contains(['<', '>', '"', '\\']));
            }
            assert_eq!(smtp.username.is_some(), smtp.password.is_some());
            if let Some(username) = &smtp.username {
                assert!(no_control(username) && !username.is_empty());
            }
            if let Some(reference) = &smtp.password {
                assert!(reference.name.starts_with(SECRET_PREFIX));
                assert!(!reference.name.ends_with(FILE_SUFFIX));
                assert!(reference.check().is_ok());
            }
            if smtp.security == SmtpSecurity::None {
                assert!(smtp.username.is_none() && smtp.password.is_none());
            }
            let again: Smtp = parse_writable(canonical(&smtp).as_bytes()).unwrap();
            assert_eq!(again, smtp);
        }
        Err(BodyError::Malformed(_)) => {
            assert!(serde_json::from_slice::<Value>(data).is_err());
        }
        Err(BodyError::Invalid(errors)) => {
            assert!(!errors.is_empty() && errors.len() <= MAX_FIELD_ERRORS);
            for error in &errors {
                let pointer = error.pointer.as_str();
                if pointer == "/password" || pointer.starts_with("/password/") {
                    assert!(
                        allowed_password_detail(&error.detail)
                            || error.detail.starts_with("missing field"),
                        "{:?}",
                        error.detail
                    );
                }
            }
        }
    }
});
