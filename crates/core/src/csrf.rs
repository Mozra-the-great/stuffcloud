//! Cross-site request forgery checks (SPEC 5.5, ADR 0009 decision 8, ADR 0005 addendum).
//!
//! Hosted sites may be *same-site* with the app (one registrable domain), so `SameSite`
//! cookies are no defence. Every state-changing request (any method other than `GET`, `HEAD`,
//! `OPTIONS`) that is authenticated by cookie, or could be, must pass [`check`]:
//!
//! 1. exactly one `Origin` header, a valid serialised origin equal to the app origin
//!    (a missing, `null`, malformed or foreign origin is refused);
//! 2. `Sec-Fetch-Site`, when present, must be exactly `same-origin`;
//! 3. a CSRF token in the `X-CSRF-Token` header that equals the `__Host-` CSRF cookie
//!    (compared in constant time). The `app` crate additionally binds the token to the
//!    session: a logged-in session stores the token's hash and refuses any other token.
//!
//! The checks are pure: they take the raw header values, so the fuzz targets and property
//! tests reach them without a server.

use std::fmt;

use crate::cookie::Lookup;
use crate::token::{Token, constant_time_eq};

/// Name of the request header that carries the CSRF token.
pub const CSRF_HEADER: &str = "x-csrf-token";

/// Longest host name of an origin (DNS limit).
pub const MAX_HOST_LEN: usize = 253;

/// Whether a method is safe, so a request with it needs no CSRF check. Methods are
/// case-sensitive (RFC 9110, 9.1): `get` is not `GET` and is checked like a write.
#[must_use]
pub fn is_safe_method(method: &str) -> bool {
    matches!(method, "GET" | "HEAD" | "OPTIONS")
}

/// The scheme of an origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scheme {
    /// `http`.
    Http,
    /// `https`.
    Https,
}

impl Scheme {
    /// The scheme name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Https => "https",
        }
    }

    /// The port used when an origin names none.
    #[must_use]
    pub const fn default_port(self) -> u16 {
        match self {
            Self::Http => 80,
            Self::Https => 443,
        }
    }
}

/// A web origin: scheme, host and port (RFC 6454). Two origins are equal when all three are;
/// the default port and its explicit form are the same origin.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Origin {
    scheme: Scheme,
    host: String,
    port: u16,
}

/// Why a text is not an origin.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum OriginError {
    /// The text is empty.
    Empty,
    /// The opaque origin `null` (sandboxed frames, `data:` and `file:` pages).
    Null,
    /// Not `http://` or `https://`.
    Scheme,
    /// The host is empty, too long or has a character other than a letter, digit, `-` or
    /// `.` (or is a bracketed IPv6 address with other characters).
    Host,
    /// The port is not a number from 1 to 65535.
    Port,
    /// There is more after the host and port (a path, query, fragment or user information).
    Trailing,
    /// The text is not ASCII.
    NotAscii,
}

impl fmt::Display for OriginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Empty => "the origin is empty",
            Self::Null => "the origin is \"null\" (an opaque origin)",
            Self::Scheme => "the origin does not start with http:// or https://",
            Self::Host => "the origin has no valid host",
            Self::Port => "the origin has an invalid port",
            Self::Trailing => "the origin has more than scheme, host and port",
            Self::NotAscii => "the origin is not ASCII",
        })
    }
}

impl std::error::Error for OriginError {}

/// Whether `host` is a valid host of an origin: a DNS name of letters, digits, `-` and `.`
/// (not starting with `.` or `-`), or an IPv6 address in brackets.
fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > MAX_HOST_LEN {
        return false;
    }
    if let Some(inner) = host.strip_prefix('[') {
        return inner.strip_suffix(']').is_some_and(|address| {
            address.contains(':')
                && address
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || matches!(byte, b':' | b'.'))
        });
    }
    !host.starts_with(['.', '-'])
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
}

impl Origin {
    /// Parses a serialised origin such as `https://app.example.com` or
    /// `http://app.example.com:8080`. Scheme and host are case-insensitive and stored in
    /// lowercase; nothing may follow the port (not even `/`).
    ///
    /// # Errors
    ///
    /// The first problem found, see [`OriginError`].
    pub fn parse(text: &[u8]) -> Result<Self, OriginError> {
        if text.is_empty() {
            return Err(OriginError::Empty);
        }
        let text = std::str::from_utf8(text)
            .ok()
            .filter(|text| text.is_ascii())
            .ok_or(OriginError::NotAscii)?;
        if text == "null" {
            return Err(OriginError::Null);
        }
        let lower = text.to_ascii_lowercase();
        let (scheme, rest) = if let Some(rest) = lower.strip_prefix("https://") {
            (Scheme::Https, rest)
        } else if let Some(rest) = lower.strip_prefix("http://") {
            (Scheme::Http, rest)
        } else {
            return Err(OriginError::Scheme);
        };
        if rest.contains(['/', '?', '#', '@', '\\']) {
            return Err(OriginError::Trailing);
        }
        // An IPv6 host contains colons; the port follows the closing bracket.
        let (host, port) = match rest.rfind(']') {
            Some(close) if rest.starts_with('[') => {
                let (host, after) = rest.split_at(close.saturating_add(1));
                (host, after)
            }
            _ => match rest.find(':') {
                Some(colon) => rest.split_at(colon),
                None => (rest, ""),
            },
        };
        if !valid_host(host) {
            return Err(OriginError::Host);
        }
        let port = if port.is_empty() {
            scheme.default_port()
        } else {
            let digits = port.strip_prefix(':').ok_or(OriginError::Trailing)?;
            if digits.is_empty()
                || digits.len() > 5
                || !digits.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(OriginError::Port);
            }
            digits
                .parse::<u16>()
                .ok()
                .filter(|port| *port != 0)
                .ok_or(OriginError::Port)?
        };
        Ok(Self {
            scheme,
            host: host.to_owned(),
            port,
        })
    }

    /// The scheme.
    #[must_use]
    pub const fn scheme(&self) -> Scheme {
        self.scheme
    }

    /// The host, lowercase (IPv6 addresses in brackets).
    #[must_use]
    pub fn host(&self) -> &str {
        &self.host
    }

    /// The port (the scheme's default when the text named none).
    #[must_use]
    pub const fn port(&self) -> u16 {
        self.port
    }
}

impl fmt::Display for Origin {
    /// The serialised origin as a browser sends it: the default port is left out.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}://{}", self.scheme.as_str(), self.host)?;
        if self.port != self.scheme.default_port() {
            write!(f, ":{}", self.port)?;
        }
        Ok(())
    }
}

/// Why a state-changing request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CsrfRefusal {
    /// No `Origin` header.
    MissingOrigin,
    /// More than one `Origin` header, or one that is not a valid origin (`null` included).
    InvalidOrigin,
    /// An `Origin` other than the app origin.
    ForeignOrigin,
    /// `Sec-Fetch-Site` is present and not exactly `same-origin` (or given more than once).
    CrossSiteRequest,
    /// No CSRF token in the header, or no (or an ambiguous) CSRF cookie.
    MissingToken,
    /// The header or the cookie is not a well-formed token, or the header is repeated.
    MalformedToken,
    /// The header token differs from the cookie, or does not belong to the session.
    TokenMismatch,
}

impl CsrfRefusal {
    /// A short stable name for logs and metrics.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::MissingOrigin => "missing_origin",
            Self::InvalidOrigin => "invalid_origin",
            Self::ForeignOrigin => "foreign_origin",
            Self::CrossSiteRequest => "cross_site_request",
            Self::MissingToken => "missing_token",
            Self::MalformedToken => "malformed_token",
            Self::TokenMismatch => "token_mismatch",
        }
    }
}

impl fmt::Display for CsrfRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::MissingOrigin => "the request has no Origin header",
            Self::InvalidOrigin => "the Origin header is not exactly one valid origin",
            Self::ForeignOrigin => "the Origin header is not the app origin",
            Self::CrossSiteRequest => "Sec-Fetch-Site is not same-origin",
            Self::MissingToken => "the CSRF token is missing (X-CSRF-Token header and cookie)",
            Self::MalformedToken => "the CSRF token is malformed",
            Self::TokenMismatch => "the CSRF token does not match",
        })
    }
}

/// The parts of a request [`check`] looks at, as raw header values.
#[derive(Debug, Clone, Copy)]
pub struct CsrfRequest<'a> {
    /// The method, exactly as sent.
    pub method: &'a str,
    /// Every `Origin` header value.
    pub origins: &'a [&'a [u8]],
    /// Every `Sec-Fetch-Site` header value.
    pub fetch_sites: &'a [&'a [u8]],
    /// Every `X-CSRF-Token` header value.
    pub tokens: &'a [&'a [u8]],
    /// The CSRF cookie.
    pub cookie: Lookup<'a>,
}

/// The outcome of a [`check`] that passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CsrfPass {
    /// A safe method: nothing was checked.
    SafeMethod,
    /// A state-changing request that passed; the token is what the caller binds to the
    /// session.
    Verified(Token),
}

/// Checks a request against the CSRF rules of this module.
///
/// # Errors
///
/// The first rule the request breaks, in the order of the module documentation.
pub fn check(request: &CsrfRequest<'_>, app: &Origin) -> Result<CsrfPass, CsrfRefusal> {
    if is_safe_method(request.method) {
        return Ok(CsrfPass::SafeMethod);
    }
    let origin = match request.origins {
        [] => return Err(CsrfRefusal::MissingOrigin),
        [one] => Origin::parse(one).map_err(|_invalid| CsrfRefusal::InvalidOrigin)?,
        _ => return Err(CsrfRefusal::InvalidOrigin),
    };
    if origin != *app {
        return Err(CsrfRefusal::ForeignOrigin);
    }
    match request.fetch_sites {
        [] | [b"same-origin"] => {}
        _ => return Err(CsrfRefusal::CrossSiteRequest),
    }
    let header = match request.tokens {
        [] => return Err(CsrfRefusal::MissingToken),
        [one] => *one,
        _ => return Err(CsrfRefusal::MalformedToken),
    };
    let cookie = request.cookie.value().ok_or(CsrfRefusal::MissingToken)?;
    let token = Token::parse(header).map_err(|_malformed| CsrfRefusal::MalformedToken)?;
    let cookie_token = Token::parse(cookie).map_err(|_malformed| CsrfRefusal::MalformedToken)?;
    if constant_time_eq(token.as_bytes(), cookie_token.as_bytes()) {
        Ok(CsrfPass::Verified(token))
    } else {
        Err(CsrfRefusal::TokenMismatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &[u8] = b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OTHER: &[u8] = b"1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn app() -> Origin {
        Origin::parse(b"https://app.example.com").unwrap()
    }

    #[test]
    fn safe_methods() {
        for method in ["GET", "HEAD", "OPTIONS"] {
            assert!(is_safe_method(method), "{method}");
        }
        for method in ["POST", "PUT", "DELETE", "PATCH", "get", "Get", "TRACE", ""] {
            assert!(!is_safe_method(method), "{method}");
        }
    }

    #[test]
    fn origins_parse_and_normalise() {
        let cases: &[(&str, Scheme, &str, u16, &str)] = &[
            (
                "https://app.example.com",
                Scheme::Https,
                "app.example.com",
                443,
                "https://app.example.com",
            ),
            (
                "HTTPS://App.Example.COM:443",
                Scheme::Https,
                "app.example.com",
                443,
                "https://app.example.com",
            ),
            (
                "http://app.example.com:80",
                Scheme::Http,
                "app.example.com",
                80,
                "http://app.example.com",
            ),
            (
                "http://app.example.com:8080",
                Scheme::Http,
                "app.example.com",
                8080,
                "http://app.example.com:8080",
            ),
            (
                "https://app.example.com:80",
                Scheme::Https,
                "app.example.com",
                80,
                "https://app.example.com:80",
            ),
            (
                "http://localhost:1",
                Scheme::Http,
                "localhost",
                1,
                "http://localhost:1",
            ),
            (
                "http://192.0.2.1:65535",
                Scheme::Http,
                "192.0.2.1",
                65535,
                "http://192.0.2.1:65535",
            ),
            (
                "https://[2001:DB8::1]",
                Scheme::Https,
                "[2001:db8::1]",
                443,
                "https://[2001:db8::1]",
            ),
            (
                "https://[2001:db8::1]:8443",
                Scheme::Https,
                "[2001:db8::1]",
                8443,
                "https://[2001:db8::1]:8443",
            ),
            (
                "http://a-b.example.org",
                Scheme::Http,
                "a-b.example.org",
                80,
                "http://a-b.example.org",
            ),
        ];
        for (text, scheme, host, port, display) in cases {
            let origin = Origin::parse(text.as_bytes()).unwrap();
            assert_eq!(origin.scheme(), *scheme, "{text}");
            assert_eq!(origin.host(), *host, "{text}");
            assert_eq!(origin.port(), *port, "{text}");
            assert_eq!(origin.to_string(), *display, "{text}");
            assert_eq!(Origin::parse(display.as_bytes()).unwrap(), origin);
        }
        assert_eq!(
            Origin::parse(b"https://app.example.com:443").unwrap(),
            app()
        );
        assert_ne!(Origin::parse(b"http://app.example.com").unwrap(), app());
        assert_eq!(Scheme::Http.as_str(), "http");
        assert_eq!(Scheme::Https.as_str(), "https");
    }

    #[test]
    fn origins_refused() {
        let long_host = format!("https://{}", "a".repeat(MAX_HOST_LEN + 1));
        let longest_host = format!("https://{}", "a".repeat(MAX_HOST_LEN));
        assert!(Origin::parse(longest_host.as_bytes()).is_ok());
        let cases: &[(&[u8], OriginError)] = &[
            (b"", OriginError::Empty),
            (b"null", OriginError::Null),
            (b"NULL", OriginError::Scheme),
            (b"ftp://app.example.com", OriginError::Scheme),
            (b"app.example.com", OriginError::Scheme),
            (b"https:/app.example.com", OriginError::Scheme),
            (b"https://", OriginError::Host),
            (b"https://:443", OriginError::Host),
            (b"https://.example.com", OriginError::Host),
            (b"https://-example.com", OriginError::Host),
            (b"https://app_x.example.com", OriginError::Host),
            (b"https://app example.com", OriginError::Host),
            (b"https://[]", OriginError::Host),
            (b"https://[zz::1]", OriginError::Host),
            (b"https://[::1", OriginError::Host),
            (b"https://[1234]", OriginError::Host),
            (long_host.as_bytes(), OriginError::Host),
            (b"https://app.example.com/", OriginError::Trailing),
            (b"https://app.example.com/x", OriginError::Trailing),
            (b"https://app.example.com?x", OriginError::Trailing),
            (b"https://app.example.com#x", OriginError::Trailing),
            (b"https://user@app.example.com", OriginError::Trailing),
            (b"https://app.example.com\\x", OriginError::Trailing),
            (b"https://[::1]x", OriginError::Trailing),
            (b"https://app.example.com:", OriginError::Port),
            (b"https://app.example.com:0", OriginError::Port),
            (b"https://app.example.com:65536", OriginError::Port),
            (b"https://app.example.com:123456", OriginError::Port),
            (b"https://app.example.com:+1", OriginError::Port),
            (b"https://app.example.com:1:2", OriginError::Port),
            (b"https://app.example.com:8a", OriginError::Port),
            (
                "https://\u{e4}.example.com".as_bytes(),
                OriginError::NotAscii,
            ),
            (b"https://\xff", OriginError::NotAscii),
        ];
        for (text, error) in cases {
            assert_eq!(
                Origin::parse(text).as_ref(),
                Err(error),
                "{}",
                String::from_utf8_lossy(text)
            );
        }
    }

    #[test]
    fn origin_error_messages() {
        let table = [
            (OriginError::Empty, "the origin is empty"),
            (
                OriginError::Null,
                "the origin is \"null\" (an opaque origin)",
            ),
            (
                OriginError::Scheme,
                "the origin does not start with http:// or https://",
            ),
            (OriginError::Host, "the origin has no valid host"),
            (OriginError::Port, "the origin has an invalid port"),
            (
                OriginError::Trailing,
                "the origin has more than scheme, host and port",
            ),
            (OriginError::NotAscii, "the origin is not ASCII"),
        ];
        for (error, message) in table {
            assert_eq!(error.to_string(), message);
        }
    }

    fn request<'a>(
        method: &'a str,
        origins: &'a [&'a [u8]],
        fetch_sites: &'a [&'a [u8]],
        tokens: &'a [&'a [u8]],
        cookie: Lookup<'a>,
    ) -> CsrfRequest<'a> {
        CsrfRequest {
            method,
            origins,
            fetch_sites,
            tokens,
            cookie,
        }
    }

    const APP: &[u8] = b"https://app.example.com";

    #[test]
    fn a_complete_request_passes() {
        for fetch_sites in [&[][..], &[&b"same-origin"[..]][..]] {
            let passed = check(
                &request("PUT", &[APP], fetch_sites, &[TOKEN], Lookup::Found(TOKEN)),
                &app(),
            )
            .unwrap();
            assert_eq!(passed, CsrfPass::Verified(Token::parse(TOKEN).unwrap()));
        }
        // The explicit default port is the same origin.
        assert!(
            check(
                &request(
                    "DELETE",
                    &[b"https://APP.example.com:443"],
                    &[],
                    &[TOKEN],
                    Lookup::Found(TOKEN)
                ),
                &app()
            )
            .is_ok()
        );
    }

    #[test]
    fn safe_methods_are_not_checked() {
        for method in ["GET", "HEAD", "OPTIONS"] {
            assert_eq!(
                check(&request(method, &[], &[], &[], Lookup::Absent), &app()),
                Ok(CsrfPass::SafeMethod)
            );
        }
    }

    /// The refusal for a `PUT` with these headers.
    fn refusal(
        origins: &[&[u8]],
        fetch_sites: &[&[u8]],
        tokens: &[&[u8]],
        cookie: Lookup<'_>,
    ) -> CsrfRefusal {
        check(
            &request("PUT", origins, fetch_sites, tokens, cookie),
            &app(),
        )
        .unwrap_err()
    }

    #[test]
    fn origin_rules_refuse() {
        use CsrfRefusal::{CrossSiteRequest, ForeignOrigin, InvalidOrigin, MissingOrigin};
        let ok = Lookup::Found(TOKEN);
        assert_eq!(refusal(&[], &[], &[TOKEN], ok), MissingOrigin);
        assert_eq!(refusal(&[b"null"], &[], &[TOKEN], ok), InvalidOrigin);
        assert_eq!(refusal(&[APP, APP], &[], &[TOKEN], ok), InvalidOrigin);
        for foreign in [
            &b"https://site.example.com"[..],
            b"http://app.example.com",
            b"https://app.example.com:8443",
            b"https://example.com",
        ] {
            assert_eq!(refusal(&[foreign], &[], &[TOKEN], ok), ForeignOrigin);
        }
        for site in [
            &b"same-site"[..],
            b"cross-site",
            b"none",
            b"Same-Origin",
            b"",
        ] {
            assert_eq!(refusal(&[APP], &[site], &[TOKEN], ok), CrossSiteRequest);
        }
        let twice: &[&[u8]] = &[b"same-origin", b"same-origin"];
        assert_eq!(refusal(&[APP], twice, &[TOKEN], ok), CrossSiteRequest);
        // A lowercase method is not safe: it is checked like any write.
        assert_eq!(
            check(&request("get", &[], &[], &[], Lookup::Absent), &app()),
            Err(MissingOrigin)
        );
    }

    #[test]
    fn token_rules_refuse() {
        use CsrfRefusal::{MalformedToken, MissingToken, TokenMismatch};
        let ok = Lookup::Found(TOKEN);
        assert_eq!(refusal(&[APP], &[], &[], ok), MissingToken);
        assert_eq!(refusal(&[APP], &[], &[TOKEN], Lookup::Absent), MissingToken);
        assert_eq!(
            refusal(&[APP], &[], &[TOKEN], Lookup::Ambiguous),
            MissingToken
        );
        assert_eq!(refusal(&[APP], &[], &[TOKEN, TOKEN], ok), MalformedToken);
        assert_eq!(refusal(&[APP], &[], &[b"short"], ok), MalformedToken);
        assert_eq!(
            refusal(&[APP], &[], &[TOKEN], Lookup::Found(b"short")),
            MalformedToken
        );
        assert_eq!(
            refusal(&[APP], &[], &[TOKEN], Lookup::Found(OTHER)),
            TokenMismatch
        );
        assert_eq!(refusal(&[APP], &[], &[OTHER], ok), TokenMismatch);
    }

    #[test]
    fn refusal_codes_and_messages() {
        let table = [
            (
                CsrfRefusal::MissingOrigin,
                "missing_origin",
                "the request has no Origin header",
            ),
            (
                CsrfRefusal::InvalidOrigin,
                "invalid_origin",
                "the Origin header is not exactly one valid origin",
            ),
            (
                CsrfRefusal::ForeignOrigin,
                "foreign_origin",
                "the Origin header is not the app origin",
            ),
            (
                CsrfRefusal::CrossSiteRequest,
                "cross_site_request",
                "Sec-Fetch-Site is not same-origin",
            ),
            (
                CsrfRefusal::MissingToken,
                "missing_token",
                "the CSRF token is missing (X-CSRF-Token header and cookie)",
            ),
            (
                CsrfRefusal::MalformedToken,
                "malformed_token",
                "the CSRF token is malformed",
            ),
            (
                CsrfRefusal::TokenMismatch,
                "token_mismatch",
                "the CSRF token does not match",
            ),
        ];
        for (refusal, code, message) in table {
            assert_eq!(refusal.code(), code);
            assert_eq!(refusal.to_string(), message);
        }
    }
}
