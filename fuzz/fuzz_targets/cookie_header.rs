//! Feeds arbitrary bytes to the `Cookie` header lookup as one or more header fields (split at
//! line feeds). Fails on a panic and when the result disagrees with a plain count of the pairs
//! named exactly `__Host-s`: absent for none, the trimmed value for one, ambiguous for more.
//! A differently cased prefix (`__HOST-s`) is a different name and never matches.
#![no_main]

use libfuzzer_sys::fuzz_target;
use stuffcloud_core::cookie::{Lookup, lookup};

fn trim(bytes: &[u8]) -> &[u8] {
    let is_space = |byte: &u8| *byte == b' ' || *byte == b'\t';
    let start = bytes
        .iter()
        .position(|b| !is_space(b))
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|b| !is_space(b))
        .map_or(start, |i| i + 1);
    &bytes[start..end]
}

/// The values of every pair named exactly `name`, by a second, plain implementation.
fn values<'a>(fields: &[&'a [u8]], name: &[u8]) -> Vec<&'a [u8]> {
    let mut found = Vec::new();
    for &field in fields {
        for pair in field.split(|byte| *byte == b';') {
            if let Some(equals) = pair.iter().position(|byte| *byte == b'=') {
                if trim(&pair[..equals]) == name {
                    found.push(trim(&pair[equals + 1..]));
                }
            }
        }
    }
    found
}

fn expected<'a>(found: &[&'a [u8]]) -> Lookup<'a> {
    match found {
        [] => Lookup::Absent,
        [value] => Lookup::Found(value),
        _ => Lookup::Ambiguous,
    }
}

fuzz_target!(|data: &[u8]| {
    let fields: Vec<&[u8]> = data.split(|byte| *byte == b'\n').collect();
    for name in ["__Host-s", "__HOST-s"] {
        let plain = values(&fields, name.as_bytes());
        let found = lookup(fields.iter().copied(), name);
        assert_eq!(found, expected(&plain), "{name}");
        if let Lookup::Found(value) = found {
            assert!(!value.contains(&b';'));
            assert!(!value.starts_with(b" ") && !value.ends_with(b" "));
        }
    }
});
