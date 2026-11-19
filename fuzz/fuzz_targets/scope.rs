//! Feeds arbitrary bytes to the token scope parser, as one scope and as a list with one scope
//! per line. Fails on a panic and when a verdict breaks a rule of `stuffcloud_core::scope`: an
//! accepted scope prints back to exactly the text it was parsed from (nothing is trimmed or
//! case-folded), is `<area>:<read|write>` with a known area; a refused scope says the truth
//! about why (no `:`, an unknown level after the last `:`, an unknown area before it); a list
//! is accepted only when every line is, and then covers exactly the permissions its lines grant.
#![no_main]

use libfuzzer_sys::fuzz_target;
use stuffcloud_core::scope::{Area, Level, Permission, ScopeError, Scopes};

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    match Permission::parse(text) {
        Ok(permission) => {
            assert_eq!(permission.to_string(), text);
            let (area, level) = text
                .rsplit_once(':')
                .expect("an accepted scope has a level");
            assert_eq!(Area::parse(area), Some(permission.area));
            assert_eq!(Level::parse(level), Some(permission.level));
            assert!(permission.covers(permission));
        }
        Err(ScopeError::NoLevel) => assert!(!text.contains(':')),
        Err(ScopeError::UnknownLevel) => {
            let (_area, level) = text.rsplit_once(':').expect("a level was looked at");
            assert_eq!(Level::parse(level), None);
        }
        Err(ScopeError::UnknownArea) => {
            let (area, level) = text.rsplit_once(':').expect("an area was looked at");
            assert!(Level::parse(level).is_some());
            assert_eq!(Area::parse(area), None);
        }
    }
    let lines: Vec<&str> = text.split('\n').collect();
    match Scopes::parse(lines.iter().copied()) {
        Ok(scopes) => {
            assert!(scopes.len() <= Permission::all().count());
            for line in &lines {
                let permission = Permission::parse(line).expect("every line of a list is a scope");
                assert!(scopes.covers(permission));
            }
            assert!(scopes.may_grant(&scopes));
        }
        Err(_error) => assert!(lines.iter().any(|line| Permission::parse(line).is_err())),
    }
});
