//! Property tests: invariants that must hold for every input, not just the
//! examples in the unit tests. `PROPTEST_CASES` raises the case count (the deep
//! nightly run uses far more than the default 256).

#![expect(clippy::unwrap_used, reason = "test code: a panic is a failed test")]

use std::path::{Component, Path};

use proptest::prelude::*;
use stuffcloud_core::path::{MAX_COMPONENT_BYTES, MAX_DEPTH, MAX_PATH_BYTES};
use stuffcloud_core::subdomain::{MAX_LEN, MIN_LEN, RANDOM_ALPHABET, RANDOM_LEN, RESERVED};
use stuffcloud_core::{SafeRelPath, Subdomain};
use unicode_normalization::is_nfc;

/// Characters an attacker would reach for, mixed with ordinary ones.
fn path_char() -> impl Strategy<Value = char> {
    prop_oneof![
        8 => prop::char::range('a', 'z'),
        2 => Just('/'),
        2 => Just('.'),
        1 => Just(' '),
        1 => Just('\\'),
        1 => Just(':'),
        1 => Just('\0'),
        1 => Just('\u{202e}'),
        1 => Just('\u{301}'),
        1 => Just('\u{958}'),
        1 => Just('\u{2000}'),
        1 => prop::sample::select(vec!['C', 'O', 'N', 'U', 'L', '$', '¹']),
        2 => any::<char>(),
    ]
}

fn path_like() -> impl Strategy<Value = String> {
    prop::collection::vec(path_char(), 0..64).prop_map(|cs| cs.into_iter().collect())
}

fn assert_path_invariants(p: &SafeRelPath) {
    let s = p.as_str();
    assert!(!s.is_empty());
    assert!(s.len() <= MAX_PATH_BYTES);
    assert!(is_nfc(s), "not NFC: {s:?}");
    assert!(!s.starts_with('/'));
    assert!(!s.contains('\\'));
    assert!(!s.chars().any(char::is_control));
    let comps: Vec<&str> = p.components().collect();
    assert!(!comps.is_empty() && comps.len() <= MAX_DEPTH);
    for c in &comps {
        assert!(!c.is_empty());
        assert!(!c.starts_with('.'));
        assert!(!c.ends_with('.') && !c.ends_with(' ') && !c.starts_with(' '));
        assert!(c.len() <= MAX_COMPONENT_BYTES);
    }
    assert_eq!(p.file_name(), *comps.last().unwrap());
    // Joined onto a site root, the path stays below it: only normal components.
    let joined = Path::new("/srv/sites/x").join(s);
    assert!(joined.starts_with("/srv/sites/x"));
    assert!(
        Path::new(s)
            .components()
            .all(|c| matches!(c, Component::Normal(_))),
        "{s:?}"
    );
    // Parsing is idempotent: the normalised form is accepted unchanged.
    assert_eq!(SafeRelPath::parse(s).as_ref(), Ok(p));
}

proptest! {
    #[test]
    fn path_parse_never_panics_and_ok_values_hold_invariants(input in any::<String>()) {
        if let Ok(p) = SafeRelPath::parse(&input) {
            assert_path_invariants(&p);
        }
    }

    #[test]
    fn path_like_inputs_hold_invariants(input in path_like()) {
        if let Ok(p) = SafeRelPath::parse(&input) {
            assert_path_invariants(&p);
        }
    }

    #[test]
    fn simple_component_paths_are_accepted_unchanged(
        comps in prop::collection::vec("[a-zA-Z0-9_-][a-zA-Z0-9_. -]{0,20}[a-zA-Z0-9_-]", 1..=MAX_DEPTH)
    ) {
        let input = comps.join("/");
        prop_assume!(input.len() <= MAX_PATH_BYTES);
        // Exclude device names, which are rejected on purpose.
        prop_assume!(comps.iter().all(|c| {
            let stem = c.split('.').next().unwrap().trim_end().to_ascii_lowercase();
            !matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
                && !((stem.starts_with("com") || stem.starts_with("lpt"))
                    && stem.len() == 4
                    && stem.as_bytes()[3].is_ascii_digit())
        }));
        let p = SafeRelPath::parse(&input).unwrap();
        prop_assert_eq!(p.as_str(), input.as_str());
    }

    #[test]
    fn any_dot_dot_component_is_rejected(
        before in prop::collection::vec("[a-z]{1,8}", 0..4),
        after in prop::collection::vec("[a-z]{1,8}", 0..4),
    ) {
        let mut comps = before;
        comps.push("..".to_owned());
        comps.extend(after);
        prop_assert!(SafeRelPath::parse(&comps.join("/")).is_err());
    }

    #[test]
    fn subdomain_parse_never_panics_and_ok_values_hold_invariants(input in any::<String>()) {
        if let Ok(s) = Subdomain::parse(&input) {
            assert_subdomain_invariants(&s);
            prop_assert_eq!(s.as_str(), input.as_str());
        }
    }

    #[test]
    fn subdomain_label_like_inputs(input in "[a-z0-9-]{0,70}") {
        if let Ok(s) = Subdomain::parse(&input) {
            assert_subdomain_invariants(&s);
        } else {
            let len_ok = (MIN_LEN..=MAX_LEN).contains(&input.len());
            let edges_ok = !input.starts_with('-') && !input.ends_with('-');
            let shape_ok = input.get(2..4) != Some("--");
            let free = !RESERVED.contains(&input.as_str());
            prop_assert!(!(len_ok && edges_ok && shape_ok && free), "{input:?} wrongly rejected");
        }
    }

    #[test]
    fn user_input_is_case_and_padding_insensitive(input in "[ \t]{0,3}[a-zA-Z0-9-]{0,20}[ \t]{0,3}") {
        let a = Subdomain::parse_user_input(&input);
        let b = Subdomain::parse(&input.trim().to_ascii_lowercase());
        prop_assert_eq!(a, b);
    }

    #[test]
    fn random_labels_are_valid_unless_reserved(bytes in any::<[u8; RANDOM_LEN]>()) {
        match Subdomain::from_random_bytes(&bytes) {
            Ok(s) => {
                assert_subdomain_invariants(&s);
                prop_assert_eq!(s.as_str().len(), RANDOM_LEN);
                prop_assert!(s.as_str().bytes().all(|b| RANDOM_ALPHABET.contains(&b)));
            }
            Err(e) => prop_assert_eq!(e, stuffcloud_core::SubdomainError::Reserved),
        }
    }
}

fn assert_subdomain_invariants(s: &Subdomain) {
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
