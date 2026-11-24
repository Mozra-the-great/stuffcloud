//! Cookies of the app (SPEC 5.5, ADR 0009 decision 8): reading the `Cookie` request header
//! and writing `Set-Cookie` values.
//!
//! The app may share a registrable domain with hosted sites, so a site can set cookies that
//! the browser sends to the app too ("cookie tossing"). Two rules keep that harmless:
//!
//! - every cookie the app sets is a [`HostCookie`]: its name starts with `__Host-`, and its
//!   `Set-Cookie` value always carries `Secure` and `Path=/` and never a `Domain` attribute,
//!   so the browser keeps it for the app's host only and no other host can set or overwrite a
//!   cookie of that name;
//! - the app reads only its own cookie names, compared byte for byte ([`lookup`]): a cookie
//!   without the prefix, with a differently cased prefix (`__HOST-`) or with the name given
//!   twice is ignored.
//!
//! There is deliberately no way to give a [`HostCookie`] a `Domain` attribute. The only
//! `Set-Cookie` value the app can hold is a [`SetCookie`], and only [`HostCookie::set`] and
//! [`HostCookie::clear`] build one, so code that sets a header from any other string does not
//! compile against the helpers (it would have to name the header itself, which a CI check,
//! `scripts/ci/check_cookies.py`, and a test of every route catch from outside).

use std::fmt;

use crate::token::Token;

/// The prefix every cookie name of the app starts with.
pub const HOST_PREFIX: &str = "__Host-";

/// Whether a byte may appear in a cookie name (an RFC 9110 `token` character).
const fn is_token_byte(byte: u8) -> bool {
    matches!(byte,
        b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_'
        | b'`' | b'|' | b'~' | b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z')
}

/// Whether `name` is a valid `__Host-` cookie name: the prefix, at least one more character,
/// only token characters.
#[must_use]
pub const fn is_host_cookie_name(name: &str) -> bool {
    let mut rest = name.as_bytes();
    let mut prefix = HOST_PREFIX.as_bytes();
    while let ([expected, prefix_rest @ ..], [byte, name_rest @ ..]) = (prefix, rest) {
        if *expected != *byte {
            return false;
        }
        prefix = prefix_rest;
        rest = name_rest;
    }
    if !prefix.is_empty() || rest.is_empty() {
        return false;
    }
    while let [byte, name_rest @ ..] = rest {
        if !is_token_byte(*byte) {
            return false;
        }
        rest = name_rest;
    }
    true
}

/// The `SameSite` attribute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SameSite {
    /// Sent on top-level navigations from other sites (the session cookie, so links into the
    /// app keep the login). Not a defence against same-site hosted sites (SPEC 5.5).
    Lax,
    /// Never sent on requests started by another site.
    Strict,
}

impl SameSite {
    /// The attribute value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Lax => "Lax",
            Self::Strict => "Strict",
        }
    }
}

/// A `Set-Cookie` header value built by [`HostCookie::set`] or [`HostCookie::clear`]: always a
/// `__Host-` cookie with `Secure`, `Path=/` and `HttpOnly`, never with a `Domain` attribute.
/// There is no other constructor, so a function that takes a `SetCookie` cannot be given an
/// arbitrary cookie string.
///
/// `Debug` does not show the value (it holds a session or CSRF token); [`SetCookie::as_str`]
/// and `Display` do, because that is the text that goes into the header.
#[derive(Clone, PartialEq, Eq)]
pub struct SetCookie(String);

impl SetCookie {
    /// The header value.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SetCookie {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for SetCookie {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SetCookie(<redacted>)")
    }
}

/// A cookie of the app: a `__Host-` name and how it is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostCookie {
    name: &'static str,
    same_site: SameSite,
}

impl HostCookie {
    /// A cookie definition; `None` when `name` is not a valid `__Host-` name
    /// ([`is_host_cookie_name`]). Every app cookie is `HttpOnly`.
    #[must_use]
    pub const fn new(name: &'static str, same_site: SameSite) -> Option<Self> {
        if is_host_cookie_name(name) {
            Some(Self { name, same_site })
        } else {
            None
        }
    }

    /// The cookie name, prefix included.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        self.name
    }

    /// The `SameSite` attribute.
    #[must_use]
    pub const fn same_site(&self) -> SameSite {
        self.same_site
    }

    /// The `Set-Cookie` value that stores `value`; with `max_age` (seconds) the browser keeps
    /// it that long, without it until the browser session ends.
    #[must_use]
    pub fn set(&self, value: &Token, max_age: Option<u64>) -> SetCookie {
        let base = format!(
            "{}={}; Path=/; Secure; HttpOnly; SameSite={}",
            self.name,
            value.to_hex(),
            self.same_site.as_str()
        );
        SetCookie(match max_age {
            Some(seconds) => format!("{base}; Max-Age={seconds}"),
            None => base,
        })
    }

    /// The `Set-Cookie` value that deletes the cookie.
    #[must_use]
    pub fn clear(&self) -> SetCookie {
        SetCookie(format!(
            "{}=; Path=/; Secure; HttpOnly; SameSite={}; Max-Age=0",
            self.name,
            self.same_site.as_str()
        ))
    }
}

/// What the `Cookie` header says about one cookie name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lookup<'a> {
    /// No cookie of that name.
    Absent,
    /// Exactly one cookie of that name, with this value (raw bytes, not validated).
    Found(&'a [u8]),
    /// The name is there more than once. The app treats this as absent: one of the values may
    /// have been tossed by another host, and there is no way to tell which.
    Ambiguous,
}

impl Lookup<'_> {
    /// The value, if the name was there exactly once.
    #[must_use]
    pub const fn value(&self) -> Option<&[u8]> {
        match self {
            Self::Found(value) => Some(value),
            Self::Absent | Self::Ambiguous => None,
        }
    }
}

impl fmt::Display for Lookup<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The value is a secret; only the shape is shown.
        f.write_str(match self {
            Self::Absent => "absent",
            Self::Found(_) => "found",
            Self::Ambiguous => "ambiguous",
        })
    }
}

/// Removes leading and trailing spaces and tabs.
fn trim(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| !matches!(byte, b' ' | b'\t'))
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| !matches!(byte, b' ' | b'\t'))
        .map_or(start, |last| last.saturating_add(1));
    bytes.get(start..end).unwrap_or_default()
}

/// Splits one `name=value` pair of a `Cookie` header; a pair without `=` has no name
/// (RFC 6265bis, section 5.7) and is skipped by [`lookup`].
fn split_pair(pair: &[u8]) -> Option<(&[u8], &[u8])> {
    let equals = pair.iter().position(|byte| *byte == b'=')?;
    let name = trim(pair.get(..equals)?);
    let value = trim(pair.get(equals.saturating_add(1)..)?);
    Some((name, value))
}

/// Finds the cookie `name` in the values of the `Cookie` header fields (HTTP/2 may send
/// several). Names are compared byte for byte, so `__host-x` is not `__Host-x`.
pub fn lookup<'a, I>(header_values: I, name: &str) -> Lookup<'a>
where
    I: IntoIterator<Item = &'a [u8]>,
{
    let mut found = Lookup::Absent;
    for value in header_values {
        for pair in value.split(|byte| *byte == b';') {
            let Some((pair_name, pair_value)) = split_pair(pair) else {
                continue;
            };
            if pair_name == name.as_bytes() {
                found = match found {
                    Lookup::Absent => Lookup::Found(pair_value),
                    Lookup::Found(_) | Lookup::Ambiguous => return Lookup::Ambiguous,
                };
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: HostCookie = match HostCookie::new("__Host-s", SameSite::Lax) {
        Some(cookie) => cookie,
        None => panic!("invalid test cookie"),
    };

    fn token() -> Token {
        Token::from_bytes([0xab; 32])
    }

    #[test]
    fn host_cookie_names() {
        for good in ["__Host-a", "__Host-stuffcloud-session", "__Host-A_b.c~1"] {
            assert!(is_host_cookie_name(good), "{good}");
            assert!(HostCookie::new(good, SameSite::Strict).is_some());
        }
        for bad in [
            "",
            "__Host-",
            "__Host",
            "__host-a",
            "__HOST-a",
            "__Secure-a",
            "a",
            "x__Host-a",
            "__Host-a b",
            "__Host-a;b",
            "__Host-a=b",
            "__Host-\u{e9}",
            "__Host-a,",
            "__Host-\"",
            "__Host-(",
            "__Host-a/",
        ] {
            assert!(!is_host_cookie_name(bad), "{bad:?}");
            assert!(HostCookie::new(bad, SameSite::Lax).is_none());
        }
        for byte in 0_u8..=127 {
            let expected = byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte);
            assert_eq!(is_token_byte(byte), expected, "{byte}");
        }
        assert!(!is_token_byte(0x80));
    }

    #[test]
    fn set_and_clear() {
        assert_eq!(SESSION.name(), "__Host-s");
        assert_eq!(SESSION.same_site(), SameSite::Lax);
        let hex = token().to_hex();
        assert_eq!(
            SESSION.set(&token(), Some(60)).as_str(),
            format!("__Host-s={hex}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=60")
        );
        let strict = HostCookie::new("__Host-c", SameSite::Strict).unwrap();
        assert_eq!(
            strict.set(&token(), None).as_str(),
            format!("__Host-c={hex}; Path=/; Secure; HttpOnly; SameSite=Strict")
        );
        assert_eq!(
            SESSION.clear().as_str(),
            "__Host-s=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"
        );
        assert_eq!(
            strict.clear().as_str(),
            "__Host-c=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"
        );
        for header in [SESSION.set(&token(), Some(1)), SESSION.clear()] {
            let text = header.to_string();
            assert_eq!(text, header.as_str());
            assert!(!text.to_ascii_lowercase().contains("domain"), "{header}");
        }
    }

    #[test]
    fn a_set_cookie_does_not_show_its_value_in_debug() {
        let set = SESSION.set(&token(), Some(60));
        let shown = format!("{set:?}");
        assert_eq!(shown, "SetCookie(<redacted>)");
        assert!(!shown.contains(&token().to_hex()));
        assert!(set.to_string().contains(&token().to_hex()));
    }

    fn one(header: &'static str, name: &str) -> Lookup<'static> {
        lookup([header.as_bytes()], name)
    }

    #[test]
    fn lookup_finds_exactly_one() {
        assert_eq!(one("__Host-s=abc", "__Host-s"), Lookup::Found(b"abc"));
        assert_eq!(
            one("a=1; __Host-s=abc; b=2", "__Host-s"),
            Lookup::Found(b"abc")
        );
        assert_eq!(one("a=1;__Host-s=abc", "__Host-s"), Lookup::Found(b"abc"));
        assert_eq!(
            one(" \t__Host-s \t= \tabc \t;", "__Host-s"),
            Lookup::Found(b"abc")
        );
        assert_eq!(one("__Host-s=", "__Host-s"), Lookup::Found(b""));
        assert_eq!(one("__Host-s=a=b", "__Host-s"), Lookup::Found(b"a=b"));
        assert_eq!(one("__Host-s=  ", "__Host-s"), Lookup::Found(b""));
        assert_eq!(Lookup::Found(b"x").value(), Some(&b"x"[..]));
    }

    #[test]
    fn lookup_ignores_other_names() {
        for header in [
            "",
            ";;;",
            "stuffcloud=abc",
            "__host-s=abc",
            "__HOST-s=abc",
            "__Host-s2=abc",
            "x__Host-s=abc",
            "__Host-s",
            "=__Host-s=abc",
            "__Host-sabc",
        ] {
            assert_eq!(one(header, "__Host-s"), Lookup::Absent, "{header:?}");
        }
        assert_eq!(Lookup::Absent.value(), None);
    }

    #[test]
    fn a_repeated_name_is_ambiguous() {
        assert_eq!(one("__Host-s=a; __Host-s=b", "__Host-s"), Lookup::Ambiguous);
        assert_eq!(
            one("__Host-s=a; __Host-s=a; __Host-s=a", "__Host-s"),
            Lookup::Ambiguous
        );
        assert_eq!(
            lookup([&b"__Host-s=a"[..], &b"x=1; __Host-s=b"[..]], "__Host-s"),
            Lookup::Ambiguous
        );
        assert_eq!(
            lookup([&b"x=1"[..], &b"__Host-s=b"[..]], "__Host-s"),
            Lookup::Found(b"b")
        );
        assert_eq!(Lookup::Ambiguous.value(), None);
    }

    #[test]
    fn display_hides_the_value() {
        assert_eq!(Lookup::Absent.to_string(), "absent");
        assert_eq!(Lookup::Found(b"secret").to_string(), "found");
        assert_eq!(Lookup::Ambiguous.to_string(), "ambiguous");
    }

    #[test]
    fn trimming() {
        assert_eq!(trim(b""), b"");
        assert_eq!(trim(b"  "), b"");
        assert_eq!(trim(b" a "), b"a");
        assert_eq!(trim(b"\ta b\t"), b"a b");
        assert_eq!(trim(b"a"), b"a");
        assert_eq!(split_pair(b"novalue"), None);
        assert_eq!(split_pair(b" n = v "), Some((&b"n"[..], &b"v"[..])));
    }
}
