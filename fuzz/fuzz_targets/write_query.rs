//! Feeds arbitrary bytes to the write query parser. Fails on a panic and when a query that is
//! not exactly one `dry_run=true|false` (plus empty pairs) is accepted.
#![no_main]

use libfuzzer_sys::fuzz_target;
use stuffcloud_core::query::{MAX_QUERY_LEN, WriteQuery};

fuzz_target!(|data: &[u8]| {
    let Ok(input) = std::str::from_utf8(data) else {
        return;
    };
    let pairs: Vec<&str> = input.split('&').filter(|pair| !pair.is_empty()).collect();
    match WriteQuery::parse(Some(input)) {
        Ok(query) => {
            assert!(input.len() <= MAX_QUERY_LEN);
            match pairs.as_slice() {
                [] => assert!(!query.dry_run),
                ["dry_run=true"] => assert!(query.dry_run),
                ["dry_run=false"] => assert!(!query.dry_run),
                other => panic!("accepted {other:?}"),
            }
        }
        Err(error) => {
            // The message is bounded: names and values are clipped.
            assert!(error.to_string().len() < 300);
        }
    }
});
