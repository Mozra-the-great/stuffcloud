//! Feeds arbitrary bytes to the `If-Match` / `If-None-Match` parser. Fails on a panic and on
//! an accepted value that breaks a rule of `stuffcloud_core::etag`.
#![no_main]

use libfuzzer_sys::fuzz_target;
use stuffcloud_core::etag::{Condition, EntityTag, MAX_HEADER_LEN, MAX_TAGS};

fn is_etagc(c: char) -> bool {
    c == '!' || ('#'..='~').contains(&c)
}

fuzz_target!(|data: &[u8]| {
    let Ok(input) = std::str::from_utf8(data) else {
        return;
    };
    match Condition::parse(input) {
        Ok(condition) => {
            assert!(input.len() <= MAX_HEADER_LEN);
            // Rendering and parsing again gives the same condition.
            let rendered = condition.to_string();
            assert_eq!(Condition::parse(&rendered).as_ref(), Ok(&condition));
            match &condition {
                Condition::Any => assert_eq!(input.trim_matches([' ', '\t']), "*"),
                Condition::Tags(tags) => {
                    assert!(!tags.is_empty() && tags.len() <= MAX_TAGS);
                    for tag in tags {
                        assert!(tag.opaque().chars().all(is_etagc));
                        // A weak tag never matches strongly, a strong one matches itself.
                        if let Ok(strong) = EntityTag::strong(tag.opaque()) {
                            assert_eq!(tag.strong_eq(&strong), !tag.is_weak());
                            assert!(tag.weak_eq(&strong));
                        }
                    }
                    let first = &tags[0];
                    if let Ok(current) = EntityTag::strong(first.opaque()) {
                        assert!(!condition.if_none_match(Some(&current)));
                        assert_eq!(
                            condition.if_match(Some(&current)),
                            tags.iter()
                                .any(|t| !t.is_weak() && t.opaque() == first.opaque())
                        );
                    }
                }
            }
            assert!(!condition.if_match(None));
            assert!(condition.if_none_match(None));
        }
        Err(_) => {
            // Refused input never contains a list that the strict grammar accepts as a
            // whole; nothing more to check than "no panic".
        }
    }
    if let Ok(tag) = EntityTag::strong(input) {
        assert_eq!(tag.opaque(), input);
        assert!(!tag.is_weak());
        assert_eq!(
            Condition::parse(&tag.to_string()),
            Ok(Condition::Tags(vec![tag]))
        );
    }
});
