//! Feeds arbitrary text to the account parsers and the password policy. Fails on a panic and
//! when a verdict breaks a rule of `stuffcloud_core::account`: an accepted login name is its own
//! canonical form within the length and character rules, and a refusal names a real fault; an
//! accepted e-mail address is the lowercase input with exactly one `@` and parses to itself; the
//! login form's identifier does not depend on case or surrounding whitespace; the policy counts
//! characters after NFKC (which is idempotent) and reports a short password exactly when it is
//! short.
#![no_main]

use libfuzzer_sys::fuzz_target;
use stuffcloud_core::account::{
    Email, EmailError, Identifier, Login, LoginError, MAX_LOGIN_LEN, MAX_PASSWORD_BYTES,
    MIN_LOGIN_LEN, PasswordContext, PasswordPolicy, PasswordProblem, normalize_identifier,
    normalize_password,
};

fn login_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
}

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    match Login::parse(text) {
        Ok(login) => {
            assert_eq!(login.as_str(), text);
            assert!((MIN_LOGIN_LEN..=MAX_LOGIN_LEN).contains(&text.len()));
            assert!(text.bytes().all(login_byte));
            assert_eq!(Login::parse(login.as_str()), Ok(login));
        }
        Err(LoginError::Length(length)) => {
            assert_eq!(length, text.len());
            assert!(!(MIN_LOGIN_LEN..=MAX_LOGIN_LEN).contains(&length));
        }
        Err(LoginError::Character(index)) => {
            assert!(!login_byte(text.as_bytes()[index]));
            assert!(text.as_bytes()[..index].iter().copied().all(login_byte));
        }
        Err(LoginError::Edge) => {
            let bytes = text.as_bytes();
            let edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
            assert!(!edge(bytes[0]) || !edge(bytes[bytes.len() - 1]));
        }
        Err(_) => {}
    }
    match Email::parse(text) {
        Ok(email) => {
            assert_eq!(email.as_str(), text.to_ascii_lowercase());
            assert_eq!(email.as_str().matches('@').count(), 1);
            assert!(email.as_str().is_ascii());
            assert_eq!(Email::parse(email.as_str()), Ok(email.clone()));
            assert!(email.as_str().starts_with(email.local_part()));
        }
        Err(EmailError::At) => assert_ne!(text.matches('@').count(), 1),
        Err(EmailError::Character(index)) => assert!(!text.as_bytes()[index].is_ascii_graphic()),
        Err(_) => {}
    }
    assert_eq!(
        Identifier::from_input(text),
        Identifier::from_input(&normalize_identifier(text))
    );
    let normalized = normalize_password(text);
    assert_eq!(normalize_password(&normalized), normalized);
    let problems = PasswordPolicy::default().check(
        text,
        &PasswordContext {
            login: "someone",
            email: Some("someone@example.com"),
        },
        false,
    );
    if text.len() <= MAX_PASSWORD_BYTES {
        let short = normalized.chars().count() < 12;
        assert_eq!(
            short,
            problems
                .iter()
                .any(|problem| matches!(problem, PasswordProblem::TooShort { .. }))
        );
    } else {
        assert_eq!(problems, [PasswordProblem::TooLong]);
    }
    assert!(!problems.contains(&PasswordProblem::Breached));
});
