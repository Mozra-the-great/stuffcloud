//! The login throttles of the running app (A-03): the rules of `stuffcloud_core::throttle` on
//! bounded tables in memory. Nothing here is stored or logged; a restart forgets everything.
//!
//! - **Per client address** ([`CLIENT_RULE`], IPv6 by its /64): failed logins, wrong reset
//!   tokens and wrong current passwords of a password change. The main defence against
//!   guessing: one address gets 20 free failures, then waits that double up to 15 minutes.
//! - **Per account** ([`ACCOUNT_RULE`]): failed logins for one login name or e-mail address,
//!   counted by the normalised text that was typed (an unknown name is throttled exactly like a
//!   known one, so the throttle tells nothing about which accounts exist). It slows down
//!   guessing spread over many addresses. Its cost: an attacker with several addresses can keep
//!   an account waiting. Two things bound that: the wait never exceeds 15 minutes and every
//!   attempt after it is checked again (backoff, never a lockout), and a client address that
//!   logged in to the account successfully within [`KNOWN_FOR_MS`] skips this rule (it still
//!   has its own address rule). The keys are SHA-256 hashes of the typed text, so the table
//!   holds no login names or addresses.
//! - **Registrations per client address** ([`REGISTER_RULE`]): every registration attempt
//!   counts; 5 are free, then waits from one minute up to an hour.
//!
//! Each table holds at most [`CAPACITY`] keys; when it is full, forgotten keys are dropped
//! first and then the key with the oldest failure, so a flood of new keys cannot grow memory.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Mutex, PoisonError};

use sha2::{Digest, Sha256};
use stuffcloud_core::account::normalize_identifier;
use stuffcloud_core::client_ip::Bucket;
use stuffcloud_core::session::{HOUR_MS, MINUTE_MS};
use stuffcloud_core::throttle::{Failures, Rule};

/// Failures per client address.
pub const CLIENT_RULE: Rule = Rule {
    free: 20,
    base_ms: 1000,
    max_ms: 15 * MINUTE_MS,
    window_ms: HOUR_MS,
};

/// Failed logins per account name.
pub const ACCOUNT_RULE: Rule = Rule {
    free: 10,
    base_ms: 1000,
    max_ms: 15 * MINUTE_MS,
    window_ms: HOUR_MS,
};

/// Registration attempts per client address.
pub const REGISTER_RULE: Rule = Rule {
    free: 5,
    base_ms: MINUTE_MS,
    max_ms: HOUR_MS,
    window_ms: 6 * HOUR_MS,
};

/// A client address that logged in to an account is exempt from that account's rule for this
/// long (30 days).
pub const KNOWN_FOR_MS: i64 = 30 * 24 * HOUR_MS;

/// Most keys per table.
pub const CAPACITY: usize = 50_000;

/// The throttle key of an account name: SHA-256 of the normalised text.
#[must_use]
pub fn account_key(typed: &str) -> [u8; 32] {
    Sha256::digest(normalize_identifier(typed).as_bytes()).into()
}

/// One bounded table of failures.
#[derive(Debug)]
struct Table<K> {
    rule: Rule,
    capacity: usize,
    entries: Mutex<HashMap<K, Failures>>,
}

impl<K: Eq + Hash + Copy> Table<K> {
    fn new(rule: Rule, capacity: usize) -> Self {
        Self {
            rule,
            capacity,
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn wait(&self, key: K, now: i64) -> Option<i64> {
        let entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        entries
            .get(&key)
            .and_then(|failures| self.rule.wait(*failures, now))
    }

    fn fail(&self, key: K, now: i64) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        if !entries.contains_key(&key) && entries.len() >= self.capacity {
            let rule = self.rule;
            entries.retain(|_key, failures| !rule.is_stale(*failures, now));
            if entries.len() >= self.capacity
                && let Some(oldest) = entries
                    .iter()
                    .min_by_key(|(_key, failures)| failures.last_at)
                    .map(|(key, _failures)| *key)
            {
                let _dropped = entries.remove(&oldest);
            }
        }
        let current = entries.get(&key).copied().unwrap_or_default();
        let _previous = entries.insert(key, self.rule.fail(current, now));
    }

    fn forget(&self, key: K) {
        let _dropped = self
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&key);
    }

    fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

/// All throttles of the app.
#[derive(Debug)]
pub struct Throttles {
    clients: Table<Bucket>,
    accounts: Table<[u8; 32]>,
    registrations: Table<Bucket>,
    known: Mutex<HashMap<([u8; 32], Bucket), i64>>,
    capacity: usize,
}

impl Default for Throttles {
    fn default() -> Self {
        Self::with_capacity(CAPACITY)
    }
}

impl Throttles {
    /// Throttles whose tables hold at most `capacity` keys each.
    #[must_use]
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            clients: Table::new(CLIENT_RULE, capacity),
            accounts: Table::new(ACCOUNT_RULE, capacity),
            registrations: Table::new(REGISTER_RULE, capacity),
            known: Mutex::new(HashMap::new()),
            capacity,
        }
    }

    fn is_known(&self, account: [u8; 32], client: Bucket, now: i64) -> bool {
        self.known
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&(account, client))
            .is_some_and(|at| now.saturating_sub(*at) < KNOWN_FOR_MS)
    }

    /// How long a login attempt for `account` from `client` has to wait; `None` when it may be
    /// checked.
    #[must_use]
    pub fn login_wait(&self, client: Bucket, account: [u8; 32], now: i64) -> Option<i64> {
        let by_client = self.clients.wait(client, now);
        let by_account = if self.is_known(account, client, now) {
            None
        } else {
            self.accounts.wait(account, now)
        };
        by_client.max(by_account)
    }

    /// Records a failed login (or a wrong current password).
    pub fn login_failed(&self, client: Bucket, account: [u8; 32], now: i64) {
        self.clients.fail(client, now);
        self.accounts.fail(account, now);
    }

    /// Records a successful login: the account's failures are forgotten and the client address
    /// becomes known for it. The address's own failures stay (logging in to one's own account
    /// must not reset the count of guesses at others).
    pub fn login_succeeded(&self, client: Bucket, account: [u8; 32], now: i64) {
        self.accounts.forget(account);
        let mut known = self.known.lock().unwrap_or_else(PoisonError::into_inner);
        if !known.contains_key(&(account, client)) && known.len() >= self.capacity {
            known.retain(|_pair, at| now.saturating_sub(*at) < KNOWN_FOR_MS);
            if known.len() >= self.capacity
                && let Some(oldest) = known
                    .iter()
                    .min_by_key(|(_pair, at)| **at)
                    .map(|(pair, _at)| *pair)
            {
                let _dropped = known.remove(&oldest);
            }
        }
        let _previous = known.insert((account, client), now);
    }

    /// How long an attempt from `client` has to wait by the address rule alone.
    #[must_use]
    pub fn client_wait(&self, client: Bucket, now: i64) -> Option<i64> {
        self.clients.wait(client, now)
    }

    /// Records a failure that counts against the address only (a wrong reset token).
    pub fn client_failed(&self, client: Bucket, now: i64) {
        self.clients.fail(client, now);
    }

    /// Counts a registration attempt from `client`, unless it has to wait: then the wait.
    #[must_use]
    pub fn register_attempt(&self, client: Bucket, now: i64) -> Option<i64> {
        let wait = self.registrations.wait(client, now);
        if wait.is_none() {
            self.registrations.fail(client, now);
        }
        wait
    }

    /// The number of keys in the tables (clients, accounts, registrations, known pairs).
    #[must_use]
    pub fn sizes(&self) -> [usize; 4] {
        [
            self.clients.len(),
            self.accounts.len(),
            self.registrations.len(),
            self.known
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .len(),
        ]
    }
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;

    use super::*;

    fn client(text: &str) -> Bucket {
        Bucket::of(text.parse::<IpAddr>().unwrap())
    }

    #[test]
    fn account_keys_ignore_case_and_whitespace() {
        assert_eq!(account_key(" Alice "), account_key("alice"));
        assert_ne!(account_key("alice"), account_key("bob"));
    }

    #[test]
    fn the_address_rule_throttles_after_twenty_failures() {
        let throttles = Throttles::default();
        let a = client("192.0.2.1");
        for n in 0..20 {
            assert_eq!(
                throttles.login_wait(a, account_key(&format!("u{n}")), 0),
                None
            );
            throttles.login_failed(a, account_key(&format!("u{n}")), 0);
        }
        assert_eq!(throttles.login_wait(a, account_key("fresh"), 0), None);
        throttles.login_failed(a, account_key("fresh"), 0);
        assert_eq!(throttles.login_wait(a, account_key("other"), 0), Some(1000));
        assert_eq!(throttles.client_wait(a, 999), Some(1));
        assert_eq!(throttles.client_wait(a, 1000), None);
        // Another address is not affected.
        assert_eq!(
            throttles.login_wait(client("192.0.2.2"), account_key("other"), 0),
            None
        );
        // The same /64 is the same client.
        assert_eq!(
            throttles.client_wait(client("2001:db8::1"), 0),
            throttles.client_wait(client("2001:db8::2"), 0)
        );
    }

    #[test]
    fn the_account_rule_throttles_after_ten_failures_from_anywhere() {
        let throttles = Throttles::default();
        let key = account_key("alice");
        for n in 0..10 {
            let from = client(&format!("198.51.100.{n}"));
            assert_eq!(throttles.login_wait(from, key, 0), None);
            throttles.login_failed(from, key, 0);
        }
        let attacker = client("198.51.100.200");
        assert_eq!(throttles.login_wait(attacker, key, 0), None);
        throttles.login_failed(attacker, key, 0);
        assert_eq!(
            throttles.login_wait(client("203.0.113.1"), key, 10),
            Some(990)
        );
        // Other accounts are not affected.
        assert_eq!(throttles.login_wait(attacker, account_key("bob"), 10), None);
    }

    #[test]
    fn an_address_that_logged_in_before_skips_the_account_rule() {
        let throttles = Throttles::default();
        let key = account_key("alice");
        let home = client("192.0.2.7");
        throttles.login_succeeded(home, key, 0);
        for n in 0..12 {
            throttles.login_failed(client(&format!("198.51.100.{n}")), key, 100);
        }
        assert!(
            throttles
                .login_wait(client("203.0.113.9"), key, 100)
                .is_some()
        );
        assert_eq!(throttles.login_wait(home, key, 100), None);
        // The exemption ends after 30 days.
        assert!(throttles.login_wait(home, key, KNOWN_FOR_MS - 1).is_none());
        for n in 0..11 {
            throttles.login_failed(client(&format!("198.51.100.{n}")), key, KNOWN_FOR_MS);
        }
        assert!(throttles.login_wait(home, key, KNOWN_FOR_MS).is_some());
    }

    #[test]
    fn a_success_forgets_the_account_but_not_the_address() {
        let throttles = Throttles::default();
        let key = account_key("alice");
        let a = client("192.0.2.1");
        for _ in 0..21 {
            throttles.login_failed(a, key, 0);
        }
        throttles.login_succeeded(a, key, 0);
        assert_eq!(throttles.sizes()[1], 0);
        assert_eq!(throttles.login_wait(a, key, 0), Some(1000));
    }

    #[test]
    fn reset_token_failures_count_against_the_address() {
        let throttles = Throttles::default();
        let a = client("192.0.2.1");
        for _ in 0..21 {
            throttles.client_failed(a, 0);
        }
        assert_eq!(throttles.client_wait(a, 0), Some(1000));
        assert_eq!(throttles.sizes(), [1, 0, 0, 0]);
    }

    #[test]
    fn registrations_are_counted_per_address() {
        let throttles = Throttles::default();
        let a = client("192.0.2.1");
        for _ in 0..5 {
            assert_eq!(throttles.register_attempt(a, 0), None);
        }
        assert_eq!(throttles.register_attempt(a, 0), None);
        assert_eq!(throttles.register_attempt(a, 0), Some(MINUTE_MS));
        // A refused attempt does not count.
        assert_eq!(throttles.register_attempt(a, MINUTE_MS - 1), Some(1));
        assert_eq!(throttles.register_attempt(a, MINUTE_MS), None);
        assert_eq!(
            throttles.register_attempt(a, MINUTE_MS),
            Some(2 * MINUTE_MS)
        );
        assert_eq!(throttles.register_attempt(client("192.0.2.2"), 0), None);
    }

    #[test]
    fn tables_are_bounded() {
        let throttles = Throttles::with_capacity(3);
        for n in 0..5_i64 {
            throttles.login_failed(
                client(&format!("192.0.2.{n}")),
                account_key(&n.to_string()),
                n,
            );
            throttles.login_succeeded(
                client(&format!("192.0.2.{n}")),
                account_key(&n.to_string()),
                n,
            );
        }
        assert_eq!(throttles.sizes(), [3, 0, 0, 3]);
        // The oldest were dropped: the newest addresses are still counted.
        let table = &throttles.clients;
        let entries = table.entries.lock().unwrap();
        assert!(entries.contains_key(&client("192.0.2.4")));
        assert!(!entries.contains_key(&client("192.0.2.0")));
        drop(entries);
        let known = throttles.known.lock().unwrap();
        assert!(known.contains_key(&(account_key("4"), client("192.0.2.4"))));
        assert!(!known.contains_key(&(account_key("0"), client("192.0.2.0"))));
        drop(known);
        // Stale keys go first, before anything recent is dropped.
        let throttles = Throttles::with_capacity(2);
        throttles.client_failed(client("192.0.2.1"), 0);
        throttles.client_failed(client("192.0.2.2"), HOUR_MS);
        throttles.client_failed(client("192.0.2.3"), HOUR_MS);
        let entries = throttles.clients.entries.lock().unwrap();
        assert!(entries.contains_key(&client("192.0.2.2")));
        assert!(entries.contains_key(&client("192.0.2.3")));
        drop(entries);
        // An existing key is updated without dropping anything.
        throttles.client_failed(client("192.0.2.2"), HOUR_MS);
        assert_eq!(throttles.sizes()[0], 2);
        let known = Throttles::with_capacity(2);
        known.login_succeeded(client("192.0.2.1"), account_key("a"), 0);
        known.login_succeeded(client("192.0.2.2"), account_key("a"), KNOWN_FOR_MS);
        known.login_succeeded(client("192.0.2.3"), account_key("a"), KNOWN_FOR_MS);
        assert!(known.is_known(account_key("a"), client("192.0.2.2"), KNOWN_FOR_MS));
        assert!(known.is_known(account_key("a"), client("192.0.2.3"), KNOWN_FOR_MS));
        known.login_succeeded(client("192.0.2.3"), account_key("a"), KNOWN_FOR_MS + 1);
        assert_eq!(known.sizes()[3], 2);
    }
}
