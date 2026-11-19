//! Property tests of the local-account building blocks (A-03): login names, e-mail addresses,
//! the password policy, the login throttle and the client address behind trusted proxies.

#![expect(
    clippy::arithmetic_side_effects,
    reason = "test code: the generated inputs are bounded so the sums cannot overflow"
)]

use std::net::IpAddr;

use proptest::prelude::*;
use stuffcloud_core::account::{
    Email, Identifier, Login, MAX_LOGIN_LEN, MIN_LOGIN_LEN, PasswordContext, PasswordPolicy,
    PasswordProblem, normalize_identifier, normalize_password,
};
use stuffcloud_core::client_ip::{Bucket, ProxyList, client_address};
use stuffcloud_core::throttle::{Failures, Rule};

const RULE: Rule = Rule {
    free: 5,
    base_ms: 1000,
    max_ms: 900_000,
    window_ms: 3_600_000,
};

fn ip() -> impl Strategy<Value = IpAddr> {
    prop_oneof![
        any::<[u8; 4]>().prop_map(IpAddr::from),
        any::<[u8; 16]>().prop_map(IpAddr::from),
    ]
}

proptest! {
    #[test]
    fn an_accepted_login_is_its_own_canonical_form(text in "[a-z0-9._A-Z@ -]{0,40}") {
        if let Ok(login) = Login::parse(&text) {
            prop_assert_eq!(login.as_str(), text.as_str());
            prop_assert!((MIN_LOGIN_LEN..=MAX_LOGIN_LEN).contains(&text.len()));
            prop_assert!(text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-_".contains(&b)));
            prop_assert_eq!(Login::parse(login.as_str()).unwrap(), login);
        }
    }

    #[test]
    fn e_mail_parsing_is_case_insensitive_and_idempotent(
        local in "[a-zA-Z0-9.+_-]{1,20}",
        domain in "[a-zA-Z0-9-]{1,10}(\\.[a-zA-Z0-9-]{1,10}){1,3}",
    ) {
        let text = format!("{local}@{domain}");
        match Email::parse(&text) {
            Ok(email) => {
                prop_assert_eq!(email.as_str(), text.to_ascii_lowercase());
                prop_assert_eq!(Email::parse(email.as_str()).unwrap(), email.clone());
                prop_assert_eq!(Email::parse(&text.to_ascii_uppercase()).unwrap(), email);
            }
            Err(_) => prop_assert!(Email::parse(&text.to_ascii_lowercase()).is_err()),
        }
    }

    #[test]
    fn identifiers_ignore_case_and_surrounding_space(text in "[ \t]{0,2}[a-zA-Z0-9.@_-]{0,30}[ \t]{0,2}") {
        prop_assert_eq!(Identifier::from_input(&text), Identifier::from_input(&normalize_identifier(&text)));
        prop_assert_eq!(normalize_identifier(&normalize_identifier(&text)), normalize_identifier(&text));
    }

    #[test]
    fn the_policy_counts_characters_after_nfkc(password in "\\PC{0,40}", min in 8_usize..=20) {
        let policy = PasswordPolicy::new(min).unwrap();
        let context = PasswordContext { login: "someone", email: None };
        let problems = policy.check(&password, &context, false);
        let length = normalize_password(&password).chars().count();
        let short = problems.iter().any(|p| matches!(p, PasswordProblem::TooShort { .. }));
        prop_assert_eq!(short, length < min);
        prop_assert!(!problems.contains(&PasswordProblem::Breached));
        prop_assert!(policy.check(&password, &context, true).contains(&PasswordProblem::Breached));
        prop_assert_eq!(normalize_password(&normalize_password(&password)), normalize_password(&password));
    }

    #[test]
    fn the_throttle_never_waits_longer_than_its_maximum(
        failures in 0_u32..200,
        last_at in 0_i64..1_000_000_000,
        later in 0_i64..10_000_000,
    ) {
        let state = Failures { count: failures, last_at };
        let now = last_at + later;
        if let Some(wait) = RULE.wait(state, now) {
            prop_assert!(wait > 0 && wait <= RULE.max_ms);
            prop_assert!(failures > RULE.free);
        }
        let next = RULE.fail(state, now);
        prop_assert_eq!(next.last_at, now);
        prop_assert!(next.count >= 1);
        prop_assert!(RULE.delay_ms(failures) <= RULE.delay_ms(failures.saturating_add(1)));
        // A failure never shortens the wait.
        let before = RULE.wait(state, now).unwrap_or(0);
        let after = RULE.wait(next, now).unwrap_or(0);
        prop_assert!(after >= before);
    }

    #[test]
    fn an_untrusted_peer_cannot_choose_its_address(peer in ip(), header in "[0-9a-f.:, ]{0,60}") {
        let proxies = ProxyList::parse("192.0.2.0/24").unwrap();
        let client = client_address(peer, &[header.as_bytes()], &proxies);
        if !proxies.contains(peer) {
            prop_assert_eq!(Bucket::of(client), Bucket::of(peer));
        }
    }

    #[test]
    fn behind_a_proxy_the_client_comes_from_the_header_or_is_the_proxy(
        entries in proptest::collection::vec(ip(), 0..5),
    ) {
        let proxies = ProxyList::parse("192.0.2.0/24, 2001:db8::/32").unwrap();
        let proxy: IpAddr = "192.0.2.1".parse().unwrap();
        let header = entries.iter().map(ToString::to_string).collect::<Vec<_>>().join(", ");
        let client = client_address(proxy, &[header.as_bytes()], &proxies);
        let candidates: Vec<Bucket> = entries.iter().copied().chain([proxy]).map(Bucket::of).collect();
        prop_assert!(candidates.contains(&Bucket::of(client)));
        // The first untrusted entry from the right wins.
        if let Some(expected) = entries.iter().rev().find(|address| !proxies.contains(**address)) {
            prop_assert_eq!(Bucket::of(client), Bucket::of(*expected));
        }
    }
}
