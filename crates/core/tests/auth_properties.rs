//! Property tests of the auth building blocks (A-02): tokens, cookies, origins, the CSRF
//! check and session lifetimes.

#![expect(
    clippy::unwrap_used,
    clippy::string_slice,
    clippy::arithmetic_side_effects,
    reason = "test code: a panic is a failed test, and the generated inputs are bounded so the sums cannot overflow"
)]

use proptest::prelude::*;
use stuffcloud_core::cookie::{HostCookie, Lookup, SameSite, lookup};
use stuffcloud_core::csrf::{CsrfPass, CsrfRequest, Origin, check, is_safe_method};
use stuffcloud_core::session::{SessionAge, Timeouts};
use stuffcloud_core::token::{TOKEN_HEX_LEN, Token, constant_time_eq};

fn app() -> Origin {
    Origin::parse(b"https://app.example.com").unwrap()
}

/// Cookie names that look like the app's, plus noise.
fn cookie_name() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("__Host-s".to_owned()),
        Just("__host-s".to_owned()),
        Just("__HOST-s".to_owned()),
        Just("s".to_owned()),
        Just("__Host-s2".to_owned()),
        "[!#-:<>-~]{0,10}",
    ]
}

proptest! {
    #[test]
    fn tokens_round_trip(bytes in any::<[u8; 32]>()) {
        let token = Token::from_bytes(bytes);
        let hex = token.to_hex();
        prop_assert_eq!(hex.len(), TOKEN_HEX_LEN);
        prop_assert!(hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        prop_assert_eq!(Token::parse(hex.as_bytes()).unwrap(), token);
    }

    #[test]
    fn an_accepted_token_text_is_canonical(text in "[0-9a-fA-F]{60,68}") {
        if let Ok(token) = Token::parse(text.as_bytes()) {
            prop_assert_eq!(token.to_hex(), text);
        }
    }

    #[test]
    fn constant_time_eq_is_equality(a in prop::collection::vec(any::<u8>(), 0..8),
                                    b in prop::collection::vec(any::<u8>(), 0..8)) {
        prop_assert_eq!(constant_time_eq(&a, &b), a == b);
        prop_assert!(constant_time_eq(&a, &a));
    }

    #[test]
    fn lookup_agrees_with_a_simple_count(
        pairs in prop::collection::vec((cookie_name(), "[!#-+\\--:<-~]{0,8}"), 0..6),
    ) {
        let header = pairs
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        let matching: Vec<&String> = pairs
            .iter()
            .filter(|(name, _)| name == "__Host-s")
            .map(|(_, value)| value)
            .collect();
        let found = lookup([header.as_bytes()], "__Host-s");
        match matching.as_slice() {
            [] => prop_assert_eq!(found, Lookup::Absent),
            [value] => prop_assert_eq!(found, Lookup::Found(value.as_bytes())),
            _ => prop_assert_eq!(found, Lookup::Ambiguous),
        }
    }

    #[test]
    fn set_cookie_values_are_host_only(bytes in any::<[u8; 32]>(), age in any::<Option<u64>>(),
                                       strict in any::<bool>()) {
        let same_site = if strict { SameSite::Strict } else { SameSite::Lax };
        let cookie = HostCookie::new("__Host-x", same_site).unwrap();
        for header in [cookie.set(&Token::from_bytes(bytes), age), cookie.clear()] {
            prop_assert!(header.starts_with("__Host-x="));
            prop_assert!(header.contains("; Path=/;"));
            prop_assert!(header.contains("; Secure;"));
            prop_assert!(header.contains("; HttpOnly;"));
            prop_assert!(header.contains("; SameSite="));
            prop_assert!(!header.to_ascii_lowercase().contains("domain"));
        }
    }

    #[test]
    fn origins_round_trip(host in "[a-z0-9][a-z0-9.-]{0,30}", port in 1_u16..,
                          https in any::<bool>(), upper in any::<bool>()) {
        let scheme = if https { "https" } else { "http" };
        let text = format!("{scheme}://{host}:{port}");
        let text = if upper { text.to_ascii_uppercase() } else { text };
        let origin = Origin::parse(text.as_bytes()).unwrap();
        prop_assert_eq!(origin.port(), port);
        let shown = origin.to_string();
        prop_assert_eq!(Origin::parse(shown.as_bytes()).unwrap(), origin.clone());
        prop_assert!(!shown["https://".len()..].contains('/'));
        prop_assert_eq!(shown.to_ascii_lowercase(), shown);
    }

    #[test]
    fn origin_parsing_never_panics(text in prop::collection::vec(any::<u8>(), 0..64)) {
        if let Ok(origin) = Origin::parse(&text) {
            let shown = origin.to_string();
            prop_assert_eq!(Origin::parse(shown.as_bytes()).unwrap(), origin);
        }
    }

    #[test]
    fn a_passed_write_had_the_app_origin_and_matching_tokens(
        method in prop_oneof![Just("PUT"), Just("POST"), Just("DELETE"), Just("PATCH"), Just("GET")],
        origin in prop_oneof![
            Just(b"https://app.example.com".to_vec()),
            Just(b"https://app.example.com:443".to_vec()),
            Just(b"https://site.example.com".to_vec()),
            Just(b"null".to_vec()),
        ],
        header in prop_oneof![Just([1_u8; 32]), Just([2_u8; 32])],
        cookie in prop_oneof![Just([1_u8; 32]), Just([2_u8; 32])],
        with_site in any::<bool>(),
    ) {
        let header_hex = Token::from_bytes(header).to_hex();
        let cookie_hex = Token::from_bytes(cookie).to_hex();
        let origins: [&[u8]; 1] = [&origin];
        let sites: &[&[u8]] = if with_site { &[b"same-origin"] } else { &[] };
        let tokens: [&[u8]; 1] = [header_hex.as_bytes()];
        let request = CsrfRequest {
            method,
            origins: &origins,
            fetch_sites: sites,
            tokens: &tokens,
            cookie: Lookup::Found(cookie_hex.as_bytes()),
        };
        match check(&request, &app()) {
            Ok(CsrfPass::SafeMethod) => prop_assert!(is_safe_method(method)),
            Ok(CsrfPass::Verified(token)) => {
                prop_assert!(!is_safe_method(method));
                prop_assert_eq!(Origin::parse(&origin).unwrap(), app());
                prop_assert_eq!(header, cookie);
                prop_assert_eq!(token.as_bytes(), &header);
            }
            Err(_refused) => prop_assert!(
                !is_safe_method(method)
                    && ((origin != b"https://app.example.com"
                        && origin != b"https://app.example.com:443")
                        || header != cookie)
            ),
        }
    }

    #[test]
    fn sessions_expire_monotonically(
        idle in 1_i64..1_000_000, absolute in 1_i64..10_000_000,
        created in 0_i64..1_000_000, used in 0_i64..1_000_000,
        now in 0_i64..20_000_000, later in 0_i64..1_000_000,
    ) {
        let timeouts = Timeouts { idle_ms: idle, absolute_ms: absolute };
        let last_seen = created + used;
        let age = timeouts.evaluate(created, last_seen, now);
        if let SessionAge::Active { idle_expires_at, absolute_expires_at } = age {
            prop_assert!(now < idle_expires_at && now < absolute_expires_at);
            prop_assert!(absolute_expires_at - created == absolute);
        } else {
            prop_assert!(!timeouts.evaluate(created, last_seen, now + later).is_active());
        }
        prop_assert!(timeouts.remaining_secs(created, now) <= u64::try_from(absolute).unwrap() / 1000);
    }
}
