//! Property tests of the API building blocks (ADR 0010): entity tags and preconditions, the
//! write query string, JSON Pointers and writable documents.

#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "test code: a panic is a failed test"
)]

use proptest::prelude::*;
use serde_json::{Value, json};
use stuffcloud_core::body::{MAX_FIELD_ERRORS, canonical, parse_writable};
use stuffcloud_core::etag::{Condition, EntityTag, MAX_TAGS};
use stuffcloud_core::field::JsonPointer;
use stuffcloud_core::query::{QueryError, WriteQuery};
use stuffcloud_core::settings::ReservedNames;

/// Opaque entity tag values: the allowed characters, commas and slashes included.
fn opaque() -> impl Strategy<Value = String> {
    "[!#-~]{1,12}"
}

fn tag_list() -> impl Strategy<Value = Vec<(bool, String)>> {
    prop::collection::vec((any::<bool>(), opaque()), 1..=8)
}

fn header_of(tags: &[(bool, String)], separator: &str) -> String {
    tags.iter()
        .map(|(weak, opaque)| format!("{}\"{opaque}\"", if *weak { "W/" } else { "" }))
        .collect::<Vec<_>>()
        .join(separator)
}

proptest! {
    #[test]
    fn etag_parse_never_panics_and_round_trips(input in any::<String>()) {
        if let Ok(condition) = Condition::parse(&input) {
            let rendered = condition.to_string();
            prop_assert_eq!(Condition::parse(&rendered), Ok(condition.clone()));
            if let Condition::Tags(tags) = &condition {
                prop_assert!(!tags.is_empty() && tags.len() <= MAX_TAGS);
                for tag in tags {
                    prop_assert!(tag.opaque().chars().all(|c| c == '!' || ('#'..='~').contains(&c)));
                }
            }
        }
    }

    #[test]
    fn generated_lists_parse_to_exactly_their_tags(
        tags in tag_list(),
        separator in prop::sample::select(vec![",", ", ", " ,\t", ",,"]),
    ) {
        let header = header_of(&tags, separator);
        match Condition::parse(&header) {
            Ok(Condition::Tags(parsed)) => {
                prop_assert_eq!(parsed.len(), tags.len());
                for (tag, (weak, opaque)) in parsed.iter().zip(&tags) {
                    prop_assert_eq!(tag.is_weak(), *weak);
                    prop_assert_eq!(tag.opaque(), opaque.as_str());
                }
            }
            other => prop_assert!(false, "{header:?} gave {other:?}"),
        }
    }

    #[test]
    fn if_match_and_if_none_match_agree_for_strong_tags(tags in tag_list(), current in opaque()) {
        let current = EntityTag::strong(&current).unwrap();
        let strong_only: Vec<(bool, String)> =
            tags.iter().map(|(_, opaque)| (false, opaque.clone())).collect();
        let condition = Condition::parse(&header_of(&strong_only, ",")).unwrap();
        // With strong tags only, "some tag matches" is the same for both comparisons.
        prop_assert_eq!(
            condition.if_match(Some(&current)),
            !condition.if_none_match(Some(&current))
        );
        prop_assert!(!condition.if_match(None));
        prop_assert!(condition.if_none_match(None));
    }

    #[test]
    fn write_query_accepts_only_dry_run(input in "[a-z_=&%0-9]{0,40}") {
        match WriteQuery::parse(Some(&input)) {
            Ok(query) => {
                let pairs: Vec<&str> = input.split('&').filter(|p| !p.is_empty()).collect();
                prop_assert!(pairs.len() <= 1);
                prop_assert_eq!(query.dry_run, pairs.first() == Some(&"dry_run=true"));
            }
            Err(QueryError::TooLong) => prop_assert!(false, "short input"),
            Err(_) => {}
        }
    }

    #[test]
    fn pointer_tokens_round_trip(segments in prop::collection::vec("[a-z~/0-9]{0,6}", 0..6)) {
        let pointer = segments
            .iter()
            .fold(JsonPointer::root(), |pointer, segment| pointer.key(segment));
        prop_assert_eq!(pointer.tokens(), Some(segments));
    }

    #[test]
    fn reserved_names_errors_point_into_the_document(
        names in prop::collection::vec("[a-zA-Z0-9_-]{0,8}", 0..20),
        extra in prop::option::of("[a-z]{1,5}"),
    ) {
        let mut document = json!({"names": names});
        if let Some(extra) = &extra {
            if extra != "names" && extra != "meta" {
                document[extra.as_str()] = json!(1);
            }
        }
        match parse_writable::<ReservedNames>(document.to_string().as_bytes()) {
            Ok(parsed) => {
                // Accepted documents are canonical: they survive a round trip unchanged.
                prop_assert_eq!(parsed.names.clone(), names);
                let again: ReservedNames = parse_writable(canonical(&parsed).as_bytes()).unwrap();
                prop_assert_eq!(again, parsed);
            }
            Err(stuffcloud_core::body::BodyError::Invalid(errors)) => {
                prop_assert!(!errors.is_empty() && errors.len() <= MAX_FIELD_ERRORS);
                for error in errors {
                    let target: Option<&Value> = document.pointer(error.pointer.as_str());
                    prop_assert!(target.is_some(), "{:?} points nowhere in {document}", error.pointer);
                }
            }
            Err(other) => prop_assert!(false, "{other:?}"),
        }
    }
}
