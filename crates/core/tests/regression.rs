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
