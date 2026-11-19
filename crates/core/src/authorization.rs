//! The `Authorization` request header (A-02 follow-up #134, ADR 0005 addendum).
//!
//! A request that presents an API token is not authenticated by cookie and so needs no CSRF
//! check: a browser cannot add `Authorization: Bearer ...` to a cross-site request without a
//! CORS preflight, which the app never allows. That reasoning holds for **one** credential
//! only. Browsers also attach cached HTTP credentials (`Basic`, `Digest`, `Negotiate`) on their
//! own, also to cross-site form posts, for example when a proxy in front of the app asks for a
//! login. Such a header says nothing about who started the request, so it must not switch the
//! checks off.
//!
//! [`classify`] therefore sorts the header into four cases:
//!
//! - [`Authorization::Absent`]: no header;
//! - [`Authorization::Other`]: a scheme other than `Bearer`. The app does not use it, ignores
//!   it and treats the request as if it had no `Authorization` header: cookies work and every
//!   state-changing request needs the `Origin` and CSRF checks;
//! - [`Authorization::Bearer`]: exactly one header, the scheme `Bearer` (case-insensitive,
//!   RFC 9110 11.1), one space and a well-formed credential ([`is_credential`]). Only this one
//!   bypasses the cookie and CSRF rules;
//! - [`Authorization::Malformed`]: more than one header, or the scheme `Bearer` with a missing
//!   or malformed credential. The request is refused with 401; it never falls back to
//!   cookies or to an anonymous client.
//!
//! What a well-formed credential looks like is decided here and nowhere else. Until the token
//! store of A-08 (#38) exists any `token68` of up to [`MAX_CREDENTIAL_LEN`] bytes counts; A-08
//! narrows [`is_credential`] to the real token format (prefix plus 256 random bits) and answers
//! 401 for a well-formed credential that names no token. The function is pure so the fuzz
//! targets and property tests reach it without a server.

/// Longest credential after `Bearer ` in bytes. Longer values are malformed, so a client cannot
/// make the app keep or compare an arbitrarily long string.
pub const MAX_CREDENTIAL_LEN: usize = 512;

/// The scheme that carries API tokens.
pub const BEARER_SCHEME: &str = "Bearer";

/// What the `Authorization` header fields of a request amount to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Authorization<'a> {
    /// No `Authorization` header.
    Absent,
    /// One header with a scheme other than `Bearer`: ignored, the request is handled as if it
    /// had none.
    Other,
    /// One well-formed `Bearer` credential (the bytes after `Bearer `).
    Bearer(&'a [u8]),
    /// More than one header, or a `Bearer` header without a well-formed credential.
    Malformed,
}

/// Whether a byte may appear in a `token68` credential (RFC 9110 11.2): a letter, a digit or
/// one of `-._~+/`; `=` is only allowed as trailing padding.
const fn is_token68_byte(byte: u8) -> bool {
    matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'+' | b'/')
}

/// Whether `credential` is a well-formed bearer credential: a `token68` (one or more of
/// `A-Za-z0-9-._~+/`, then any number of `=`) of at most [`MAX_CREDENTIAL_LEN`] bytes.
#[must_use]
pub fn is_credential(credential: &[u8]) -> bool {
    if credential.is_empty() || credential.len() > MAX_CREDENTIAL_LEN {
        return false;
    }
    let body = credential.len().saturating_sub(
        credential
            .iter()
            .rev()
            .take_while(|byte| **byte == b'=')
            .count(),
    );
    let (name, _padding) = credential.split_at(body);
    !name.is_empty() && name.iter().all(|byte| is_token68_byte(*byte))
}

/// Sorts the values of the `Authorization` header fields of a request, see the module
/// documentation.
#[must_use]
pub fn classify<'a>(values: &[&'a [u8]]) -> Authorization<'a> {
    match values {
        [] => Authorization::Absent,
        [one] => classify_one(one),
        _ => Authorization::Malformed,
    }
}

/// The scheme is everything up to the first space; it is compared without regard to case.
fn classify_one(value: &[u8]) -> Authorization<'_> {
    let (scheme, rest) = match value.iter().position(|byte| *byte == b' ') {
        Some(space) => {
            let (scheme, with_space) = value.split_at(space);
            (scheme, with_space.get(1..))
        }
        None => (value, None),
    };
    if !scheme.eq_ignore_ascii_case(BEARER_SCHEME.as_bytes()) {
        return Authorization::Other;
    }
    match rest {
        Some(credential) if is_credential(credential) => Authorization::Bearer(credential),
        _ => Authorization::Malformed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    #[test]
    fn well_formed_credentials() {
        for good in [
            &b"a"[..],
            b"abc123",
            b"ABCxyz-0189._~+/",
            b"abc=",
            b"abc==",
            b"a====",
            b"sfc_0123456789abcdef",
            b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ] {
            assert!(is_credential(good), "{}", text(good));
        }
        let longest = vec![b'a'; MAX_CREDENTIAL_LEN];
        assert!(is_credential(&longest));
        let mut padded = vec![b'a'; MAX_CREDENTIAL_LEN - 2];
        padded.extend_from_slice(b"==");
        assert!(is_credential(&padded));
    }

    #[test]
    fn malformed_credentials() {
        let too_long = vec![b'a'; MAX_CREDENTIAL_LEN + 1];
        assert!(!is_credential(&too_long));
        for bad in [
            &b""[..],
            b"=",
            b"==",
            b"a=b",
            b"=a",
            b"a b",
            b" a",
            b"a ",
            b"a,b",
            b"a;b",
            b"a\"b",
            b"\"a\"",
            b"a\tb",
            b"a\nb",
            b"a\r",
            b"a\0",
            b"a%20b",
            b"a:b",
            b"a@b",
            b"\xc3\xa4",
            b"\xff",
            b"a\x7f",
        ] {
            assert!(!is_credential(bad), "{bad:?}");
        }
    }

    #[test]
    fn no_header_is_absent() {
        assert_eq!(classify(&[]), Authorization::Absent);
    }

    #[test]
    fn a_well_formed_bearer_header_is_a_bearer() {
        for (value, credential) in [
            (&b"Bearer abc"[..], &b"abc"[..]),
            (b"bearer abc", b"abc"),
            (b"BEARER abc", b"abc"),
            (b"bEaReR abc==", b"abc=="),
            (b"Bearer sfc_0123.4-5~6+7/8", b"sfc_0123.4-5~6+7/8"),
        ] {
            assert_eq!(
                classify(&[value]),
                Authorization::Bearer(credential),
                "{}",
                text(value)
            );
        }
    }

    #[test]
    fn other_schemes_are_ignored() {
        for value in [
            &b"Basic dXNlcjpwYXNz"[..],
            b"basic dXNlcjpwYXNz",
            b"Digest username=\"a\"",
            b"Negotiate YII",
            b"NTLM TlRMTVNTUAAB",
            b"Token abc",
            b"Bearers abc",
            b"Bearer2 abc",
            b"Bear abc",
            b"Basic",
            // Not exactly the scheme, so not a bearer: handled as no header (CSRF applies).
            b" Bearer abc",
            b"Bearer\tabc",
            b"\xffBearer abc",
            b"",
            b" ",
        ] {
            assert_eq!(classify(&[value]), Authorization::Other, "{}", text(value));
        }
    }

    #[test]
    fn a_broken_bearer_header_is_malformed() {
        let too_long = format!("Bearer {}", "a".repeat(MAX_CREDENTIAL_LEN + 1));
        for value in [
            &b"Bearer"[..],
            b"Bearer ",
            b"bearer ",
            b"Bearer  abc",
            b"Bearer abc ",
            b"Bearer a b",
            b"Bearer =",
            b"Bearer a=b",
            b"Bearer \"abc\"",
            b"Bearer abc,def",
            b"Bearer \xff",
            b"Bearer abc\t",
            too_long.as_bytes(),
        ] {
            assert_eq!(
                classify(&[value]),
                Authorization::Malformed,
                "{}",
                text(value)
            );
        }
        let longest = format!("Bearer {}", "a".repeat(MAX_CREDENTIAL_LEN));
        assert!(matches!(
            classify(&[longest.as_bytes()]),
            Authorization::Bearer(_)
        ));
    }

    #[test]
    fn more_than_one_header_is_malformed() {
        for values in [
            &[&b"Bearer abc"[..], b"Bearer abc"][..],
            &[b"Basic dXNlcjpwYXNz", b"Bearer abc"],
            &[b"Bearer abc", b"Basic dXNlcjpwYXNz"],
            &[b"Basic a", b"Basic b"],
            &[b"", b""],
        ] {
            assert_eq!(classify(values), Authorization::Malformed, "{values:?}");
        }
    }
}
