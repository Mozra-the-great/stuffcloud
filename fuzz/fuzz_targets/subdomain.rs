//! Feeds arbitrary bytes to the subdomain parsers. Fails on a panic and on an
//! accepted label that breaks a rule of `stuffcloud_core::subdomain`.
#![no_main]

use libfuzzer_sys::fuzz_target;
use stuffcloud_core::Subdomain;
use stuffcloud_core::subdomain::{MAX_LEN, MIN_LEN, RANDOM_LEN, RESERVED};

fn check(s: &Subdomain) {
    let v = s.as_str();
    assert!((MIN_LEN..=MAX_LEN).contains(&v.len()));
    assert!(
        v.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    );
    assert!(!v.starts_with('-') && !v.ends_with('-'));
    assert_ne!(v.get(2..4), Some("--"));
    assert!(!RESERVED.contains(&v));
    assert_eq!(Subdomain::parse(v).as_ref(), Ok(s));
}

fuzz_target!(|data: &[u8]| {
    if let Ok(bytes) = <[u8; RANDOM_LEN]>::try_from(data) {
        if let Ok(s) = Subdomain::from_random_bytes(&bytes) {
            check(&s);
        }
    }
    let Ok(input) = std::str::from_utf8(data) else {
        return;
    };
    if let Ok(s) = Subdomain::parse(input) {
        assert_eq!(s.as_str(), input);
        check(&s);
    }
    if let Ok(s) = Subdomain::parse_user_input(input) {
        check(&s);
    }
});
