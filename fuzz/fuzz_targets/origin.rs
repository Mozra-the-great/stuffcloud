//! Feeds arbitrary bytes to the `Origin` parser. Fails on a panic and when an accepted origin
//! breaks a rule of `stuffcloud_core::csrf::Origin`: its serialisation parses to the same
//! origin, is lowercase ASCII and has nothing after the port; parsing ignores the case of
//! scheme and host; the port is never 0 and the host never empty.
#![no_main]

use libfuzzer_sys::fuzz_target;
use stuffcloud_core::csrf::{Origin, Scheme};

fuzz_target!(|data: &[u8]| {
    let Ok(origin) = Origin::parse(data) else {
        return;
    };
    let shown = origin.to_string();
    assert_eq!(Origin::parse(shown.as_bytes()).as_ref(), Ok(&origin));
    assert!(shown.is_ascii());
    assert_eq!(shown.to_ascii_lowercase(), shown);
    let rest = match origin.scheme() {
        Scheme::Http => shown.strip_prefix("http://"),
        Scheme::Https => shown.strip_prefix("https://"),
    };
    let rest = rest.expect("the serialisation starts with its scheme");
    assert!(!rest.contains(['/', '?', '#', '@', '\\', ' ']));
    assert_ne!(origin.port(), 0);
    assert!(!origin.host().is_empty());
    assert_eq!(
        Origin::parse(&data.to_ascii_uppercase()).as_ref(),
        Ok(&origin),
        "parsing is case-insensitive"
    );
});
