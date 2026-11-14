//! Feeds arbitrary bytes to `SafeRelPath::parse`. Fails on a panic, on an accepted
//! path that could leave the site directory, and on a non-idempotent result.
#![no_main]

use std::path::{Component, Path};

use libfuzzer_sys::fuzz_target;
use stuffcloud_core::SafeRelPath;
use stuffcloud_core::path::{MAX_COMPONENT_BYTES, MAX_DEPTH, MAX_PATH_BYTES};

fuzz_target!(|data: &[u8]| {
    let Ok(input) = std::str::from_utf8(data) else {
        return;
    };
    let Ok(p) = SafeRelPath::parse(input) else {
        return;
    };
    let s = p.as_str();
    assert!(!s.is_empty() && s.len() <= MAX_PATH_BYTES);
    assert!(!s.starts_with('/') && !s.contains('\\') && !s.contains('\0'));
    assert!(!s.chars().any(char::is_control));
    let mut depth = 0;
    for c in p.components() {
        depth += 1;
        assert!(!c.is_empty() && !c.starts_with('.') && c.len() <= MAX_COMPONENT_BYTES);
        assert!(!c.ends_with('.') && !c.ends_with(' ') && !c.starts_with(' '));
    }
    assert!(depth <= MAX_DEPTH);
    assert!(
        Path::new(s)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    );
    assert_eq!(SafeRelPath::parse(s).as_ref(), Ok(&p));
});
