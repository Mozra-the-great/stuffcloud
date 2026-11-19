//! Known attack inputs, collected from path-traversal, archive-extraction and
//! homograph write-ups. Every entry must stay rejected; add one for every bug or
//! fuzz finding (the fuzz seeds in `fuzz/seeds/` carry the same inputs).

use stuffcloud_core::{SafeRelPath, Subdomain};

const PATH_ATTACKS: &[&str] = &[
    // Plain traversal
    "..",
    "../",
    "../../../../etc/passwd",
    "a/../../b",
    "a/b/../../../c",
    "./../x",
    // Absolute and UNC
    "/etc/passwd",
    "//etc/passwd",
    "/",
    "\\\\server\\share\\x",
    "\\\\?\\C:\\x",
    "\\\\.\\pipe\\x",
    // Windows separators and drives
    "..\\..\\windows\\win.ini",
    "a\\..\\..\\b",
    "C:\\x",
    "C:x",
    "c:/x",
    "file.txt::$DATA",
    "file.txt:stream",
    // Separators and dots with padding (stripped by Windows)
    "... /x",
    ".. /x",
    "x/..  /y",
    "x/. /y",
    "dir./x",
    "x.",
    " x",
    // NUL and other control characters (truncation tricks)
    "index.html\0.png",
    "a\0/../b",
    "a\n/b",
    "a\r",
    "\u{85}x",
    // Hidden and well-known
    ".well-known/acme-challenge/token",
    ".git/HEAD",
    ".env",
    "a/.htpasswd",
    ".DS_Store",
    // Bidi and invisible spoofing
    "invoice\u{202e}fdp.exe",
    "a\u{200b}b",
    "\u{feff}index.html",
    "x\u{2066}y",
    "x\u{e0041}y",
    "index\u{00a0}.html",
    "index\u{3000}.html",
    // Windows devices
    "con",
    "CON.html",
    "aux.txt",
    "nul",
    "com1.log",
    "lpt\u{b9}",
    "conin$",
    "sub/prn.txt",
    "con.d/x",
    // Encoded traversal stays harmless as a literal name, but its combinations
    // with real separators do not
    "%2e%2e/..",
    "..%2f/../x",
    // Overlong
    "a/b//c",
    "trailing/",
];

const PATHS_THAT_STAY_ALLOWED: &[&str] = &[
    // Literal names that only look like attacks: no decoding happens anywhere.
    "%2e%2e",
    "%2e%2e%2fetc%2fpasswd",
    "a..b",
    "a.b.c",
    "x/y.z",
    "console",
    "lpt10",
];

const SUBDOMAIN_ATTACKS: &[&str] = &[
    "xn--80ak6aa92e", // Punycode homograph
    "xn--abc",
    "\u{0430}pple",  // Cyrillic a
    "app\u{200b}le", // zero-width space
    "www",
    "WWW",
    "wpad",
    "autodiscover",
    "mta-sts",
    "a.b",
    "a_b",
    "-ab",
    "ab-",
    "",
    "ab",
    "localhost",
    "*",
    "a*b",
    "@",
    "a b",
    "a\0b",
];

#[test]
fn path_attacks_are_rejected() {
    for input in PATH_ATTACKS {
        assert!(
            SafeRelPath::parse(input).is_err(),
            "accepted attack path {input:?}"
        );
    }
}

#[test]
fn look_alike_literals_stay_allowed() {
    for input in PATHS_THAT_STAY_ALLOWED {
        assert_eq!(
            SafeRelPath::parse(input).map(|p| p.as_str().to_owned()),
            Ok((*input).to_owned()),
            "{input:?}"
        );
    }
}

#[test]
fn subdomain_attacks_are_rejected() {
    for input in SUBDOMAIN_ATTACKS {
        assert!(
            Subdomain::parse(input).is_err(),
            "accepted attack subdomain {input:?}"
        );
    }
}

/// Hostile `If-Match` / `If-None-Match` values: header injection, smuggled quotes and
/// separators, look-alike characters, wildcards mixed into lists.
const ENTITY_TAG_ATTACKS: &[&str] = &[
    "\"a\"\r\nX-Injected: 1",
    "\"a\"\nX-Injected: 1",
    "\"a\0\"",
    "\"a\" \"b\"",
    "\"a\"\"b\"",
    "\u{201c}a\u{201d}",
    "W/\u{201c}a\u{201d}",
    "*, \"a\"",
    "\"a\", *",
    "**",
    "w/\"a\"",
    "W/W/\"a\"",
    "\"a\\\"b\"",
    "\"",
    "\"\"\"",
    "\"a b\"",
    "\"\u{7f}\"",
    "\"\u{a0}\"",
];

#[test]
fn entity_tag_attacks_are_rejected() {
    for input in ENTITY_TAG_ATTACKS {
        assert!(
            stuffcloud_core::etag::Condition::parse(input).is_err(),
            "accepted attack entity tag list {input:?}"
        );
    }
}

/// Query strings that must never be read as a dry run being off by accident, nor as one
/// being on.
const WRITE_QUERY_ATTACKS: &[&str] = &[
    "dryrun=true",
    "dry-run=true",
    "DRY_RUN=true",
    "dry_run=TRUE",
    "dry_run=1",
    "dry_run=true&dry_run=false",
    "dry_run=false&dry_run=true",
    "dry_run=true;x=1",
    "dry_run=true%00",
    "dry_run=%74rue",
    "dry%5Frun=true",
    "dry_run[]=true",
    "dry_run",
];

#[test]
fn write_query_attacks_are_rejected() {
    for input in WRITE_QUERY_ATTACKS {
        assert!(
            stuffcloud_core::query::WriteQuery::parse(Some(input)).is_err(),
            "accepted attack query {input:?}"
        );
    }
}

/// Fuzz finding (`write_query`, 2026-11-19): a refused parameter made of control characters
/// was escaped in the message after it had been clipped, so the message grew far beyond its
/// bound. Seed: `fuzz/seeds/write_query/seed-07`.
#[test]
fn query_errors_stay_short_for_control_characters() {
    for input in [
        "\u{1}".repeat(200),
        format!("dry_run={}", "\u{7f}".repeat(200)),
        format!("{}=true", "\u{202e}".repeat(100)),
    ] {
        let message = stuffcloud_core::query::WriteQuery::parse(Some(&input))
            .unwrap_err()
            .to_string();
        assert!(message.len() < 300, "{} bytes: {message}", message.len());
    }
}

/// `Origin` values that must never count as the app origin `https://app.example.com`: lookalike
/// hosts, user information, paths, whitespace, encodings and opaque origins (ADR 0009, CSRF).
const ORIGIN_ATTACKS: &[&str] = &[
    "null",
    "NULL",
    "",
    " https://app.example.com",
    "https://app.example.com ",
    "https://app.example.com\t",
    "https://app.example.com.",
    "https://app.example.com.site.example.com",
    "https://site.example.com",
    "https://app-example.com",
    "https://app.example.com@site.example.com",
    "https://site.example.com@app.example.com",
    "https://site.example.com/https://app.example.com",
    "https://app.example.com/",
    "https://app.example.com:443/",
    "https://app.example.com:0443x",
    "https://app.example.com%2f",
    "https://app%2eexample.com",
    "https://xn--pp-8ka.example.com",
    "http://app.example.com",
    "https://app.example.com:8443",
    "https://app.example.com:443:443",
    "https://app\u{2024}example.com",
    "https://\u{430}pp.example.com",
    "https://app.example.com\0",
    "https://app.example.com\r\nx: y",
    "ws://app.example.com",
    "//app.example.com",
    "app.example.com",
];

#[test]
fn origin_attacks_are_not_the_app_origin() {
    use stuffcloud_core::csrf::Origin;
    let app = Origin::parse(b"https://app.example.com").unwrap();
    for input in ORIGIN_ATTACKS {
        assert_ne!(
            Origin::parse(input.as_bytes()).as_ref(),
            Ok(&app),
            "{input:?} counted as the app origin"
        );
    }
}

/// `Cookie` headers in which a hosted site on the same registrable domain tries to plant or
/// shadow the session cookie `__Host-stuffcloud-session` (cookie tossing, ADR 0009). None of
/// them may yield a session value.
const COOKIE_TOSSING: &[&str] = &[
    "stuffcloud-session=0000000000000000000000000000000000000000000000000000000000000000",
    "__host-stuffcloud-session=0000000000000000000000000000000000000000000000000000000000000000",
    "__HOST-stuffcloud-session=0000000000000000000000000000000000000000000000000000000000000000",
    "__Secure-stuffcloud-session=0000000000000000000000000000000000000000000000000000000000000000",
    "__Host-stuffcloud-session=1111111111111111111111111111111111111111111111111111111111111111; __Host-stuffcloud-session=0000000000000000000000000000000000000000000000000000000000000000",
    "=__Host-stuffcloud-session=0000000000000000000000000000000000000000000000000000000000000000",
    "__Host-stuffcloud-session",
    "__Host-stuffcloud-sessionx=0000000000000000000000000000000000000000000000000000000000000000",
    "x__Host-stuffcloud-session=0000000000000000000000000000000000000000000000000000000000000000",
];

#[test]
fn tossed_cookies_yield_no_session() {
    use stuffcloud_core::cookie::lookup;
    for input in COOKIE_TOSSING {
        assert_eq!(
            lookup([input.as_bytes()], "__Host-stuffcloud-session").value(),
            None,
            "{input:?} yielded a session value"
        );
    }
}

/// Token texts that must not parse: other cases, padding, encodings and lengths.
const TOKEN_ATTACKS: &[&str] = &[
    "",
    "00",
    "000000000000000000000000000000000000000000000000000000000000000",
    "00000000000000000000000000000000000000000000000000000000000000000",
    "000000000000000000000000000000000000000000000000000000000000000A",
    " 000000000000000000000000000000000000000000000000000000000000000",
    "000000000000000000000000000000000000000000000000000000000000000 ",
    "\"00000000000000000000000000000000000000000000000000000000000000\"",
    "%30000000000000000000000000000000000000000000000000000000000000",
    "0x00000000000000000000000000000000000000000000000000000000000000",
    "00000000000000000000000000000000000000000000000000000000000000\u{0}0",
];

#[test]
fn token_attacks_are_rejected() {
    for input in TOKEN_ATTACKS {
        assert!(
            stuffcloud_core::token::Token::parse(input.as_bytes()).is_err(),
            "accepted attack token {input:?}"
        );
    }
}
