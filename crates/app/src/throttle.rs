//! The login throttles of the running app (A-03): the rules of `stuffcloud_core::throttle` on
//! bounded tables in memory. Nothing here is stored or logged; a restart forgets everything.
//!
//! - **Per client address** ([`CLIENT_RULE`], IPv6 by its /64): failed logins, wrong reset
//!   tokens and wrong current passwords of a password change. The main defence against
//!   guessing: one address gets 20 free failures, then waits that double up to 15 minutes.
//! - **Per account** ([`ACCOUNT_RULE`]): failed logins for one login name or e-mail address,
//!   counted by the normalised text that was typed (an unknown name is throttled exactly like a
//!   known one, so the throttle tells nothing about which accounts exist), and once the lookup
//!   found an account also by its internal id ([`AccountKey::Id`]), so its login name and its
//!   address share one count instead of having 10 free failures each. It slows down guessing
//!   spread over many addresses. Its cost: an attacker with several addresses can keep an
//!   account waiting. Two things bound that: the wait never exceeds 15 minutes and every
//!   attempt after it is checked again (backoff, never a lockout), and a client address that
//!   logged in to the account successfully within [`KNOWN_FOR_MS`] skips this rule (it still
//!   has its own address rule). The exemption is not granted when the address is probably that
//!   of a reverse proxy nobody listed (`stuffcloud_core::client_ip::unlisted_proxy`): it would
//!   then exempt every client behind the proxy (#146). The typed-text keys are SHA-256 hashes,
//!   so the table holds no login names or addresses.
//! - **Registrations per client address** ([`REGISTER_RULE`]): every registration attempt
//!   counts; 5 are free, then waits from one minute up to an hour.
//! - **Requests for a reset link by e-mail per client address** ([`RESET_REQUEST_RULE`]): the
//!   same numbers, counted whether or not the account exists. What one account may be sent is
//!   limited in the database (one token per cool-down).
//!
//! **Attempts are reserved before they are checked** (#145). [`Throttles::reserve_login`]
//! takes the attempt's place in the address and account counts under the same lock that reads
//! them, so attempts that are still running count like failures ([`Rule::wait_in_flight`]): a
//! key gets at most `free + 1` checks however many requests arrive at once. The
//! [`Reservation`] is settled when the answer is known: a failure is booked, a success refunds
//! the place (and forgets the account's failures), and an attempt that was never checked (the
//! hashing queue was full) is refunded. A reservation that is dropped unsettled (an error, a
//! cancelled request) counts as a failure.
//!
//! Each table holds at most [`CAPACITY`] keys. A full table makes room for a new key by
//! dropping a sixteenth of itself at once ([`EVICTION_SHARE`]; the scan runs once per that many
//! new keys, not on every one): keys whose window has passed first, then the fewest failures,
//! then the oldest. A key with a running attempt is never dropped, and dropping by the fewest
//! failures means a flood of fresh keys (one failure each) cannot push out the counter of an
//! account under attack. [`Throttles::sweep`] removes forgotten keys periodically. Known
//! addresses are capped per account ([`KNOWN_PER_ACCOUNT`]; the account's own oldest one makes
//! way); when the table is full a new address simply stays unknown, so logging in elsewhere
//! can never remove another account's exemption.

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

/// Requests for a reset link by e-mail per client address: every request counts; 5 are free,
/// then waits from one minute up to an hour (the same as registrations: nobody forgets their
/// password five times in a row, and every request that gets through can cost a mail).
pub const RESET_REQUEST_RULE: Rule = Rule {
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

/// Most known client addresses per account.
pub const KNOWN_PER_ACCOUNT: usize = 16;

/// A full table drops this share of its keys at once (one sixteenth).
pub const EVICTION_SHARE: usize = 16;

/// The key of the per-account rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AccountKey {
    /// The SHA-256 of the normalised typed text (a login name or an e-mail address, of an
    /// account or not).
    Typed([u8; 32]),
    /// The internal id of an existing account.
    Id(i64),
}

/// The throttle key of a typed account name: SHA-256 of the normalised text.
#[must_use]
pub fn account_key(typed: &str) -> AccountKey {
    AccountKey::Typed(Sha256::digest(normalize_identifier(typed).as_bytes()).into())
}

/// The throttle key of an existing account.
#[must_use]
pub const fn id_key(user_id: i64) -> AccountKey {
    AccountKey::Id(user_id)
}

/// What one key has done: its failures and the attempts being checked right now.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Entry {
    failures: Failures,
    in_flight: u32,
}

/// How an attempt ended, for one key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    /// It failed: one more failure.
    Failed,
    /// It was not checked or does not count: nothing changes.
    Refunded,
    /// It succeeded: the key's failures are forgotten.
    Succeeded,
}

/// One bounded table of failures.
#[derive(Debug)]
struct Table<K> {
    rule: Rule,
    capacity: usize,
    entries: Mutex<HashMap<K, Entry>>,
}

impl<K: Eq + Hash + Copy> Table<K> {
    fn new(rule: Rule, capacity: usize) -> Self {
        Self {
            rule,
            capacity,
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<K, Entry>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Makes room for one more key in a full table (see the module documentation); `false`
    /// when every key has an attempt running.
    fn make_room(&self, entries: &mut HashMap<K, Entry>, now: i64) -> bool {
        if entries.len() < self.capacity {
            return true;
        }
        let rule = self.rule;
        let mut candidates: Vec<((bool, u32, i64), K)> = entries
            .iter()
            .filter(|(_key, entry)| entry.in_flight == 0)
            .map(|(key, entry)| {
                let failures = entry.failures;
                (
                    (
                        !rule.is_stale(failures, now),
                        failures.count,
                        failures.last_at,
                    ),
                    *key,
                )
            })
            .collect();
        let share = (self.capacity / EVICTION_SHARE)
            .max(1)
            .min(candidates.len());
        let Some(last) = share.checked_sub(1) else {
            return false;
        };
        let _partitioned = candidates.select_nth_unstable_by_key(last, |(rank, _key)| *rank);
        for (_rank, key) in candidates.iter().take(share) {
            let _dropped = entries.remove(key);
        }
        true
    }

    /// Takes a place for an attempt of `key` at `now`, unless it has to wait: then the wait.
    fn reserve(&self, key: K, now: i64) -> Result<(), i64> {
        let mut entries = self.lock();
        let entry = entries.get(&key).copied().unwrap_or_default();
        if let Some(wait) = self
            .rule
            .wait_in_flight(entry.failures, entry.in_flight, now)
        {
            return Err(wait);
        }
        if !entries.contains_key(&key) && !self.make_room(&mut entries, now) {
            return Err(self.rule.base_ms);
        }
        let _previous = entries.insert(
            key,
            Entry {
                in_flight: entry.in_flight.saturating_add(1),
                ..entry
            },
        );
        Ok(())
    }

    /// Ends an attempt of `key` (`reserved`: whether it took a place) with `outcome` at `now`.
    fn settle(&self, key: K, reserved: bool, outcome: Outcome, now: i64) {
        let mut entries = self.lock();
        let mut entry = entries.get(&key).copied().unwrap_or_default();
        if reserved {
            entry.in_flight = entry.in_flight.saturating_sub(1);
        }
        entry.failures = match outcome {
            Outcome::Failed => self.rule.fail(entry.failures, now),
            Outcome::Refunded => entry.failures,
            Outcome::Succeeded => Failures::default(),
        };
        if entry == Entry::default() {
            let _dropped = entries.remove(&key);
        } else if entries.contains_key(&key) || self.make_room(&mut entries, now) {
            let _previous = entries.insert(key, entry);
        }
    }

    /// Counts an attempt of `key` at `now` as a failure right away, unless it has to wait:
    /// then the wait (and nothing is counted).
    fn attempt(&self, key: K, now: i64) -> Option<i64> {
        let mut entries = self.lock();
        let entry = entries.get(&key).copied().unwrap_or_default();
        if let Some(wait) = self
            .rule
            .wait_in_flight(entry.failures, entry.in_flight, now)
        {
            return Some(wait);
        }
        if !entries.contains_key(&key) && !self.make_room(&mut entries, now) {
            return Some(self.rule.base_ms);
        }
        let _previous = entries.insert(
            key,
            Entry {
                failures: self.rule.fail(entry.failures, now),
                ..entry
            },
        );
        None
    }

    /// Drops the keys whose window has passed and that have nothing running; returns how many.
    fn sweep(&self, now: i64) -> usize {
        let mut entries = self.lock();
        let before = entries.len();
        let rule = self.rule;
        entries.retain(|_key, entry| entry.in_flight > 0 || !rule.is_stale(entry.failures, now));
        before.saturating_sub(entries.len())
    }

    fn len(&self) -> usize {
        self.lock().len()
    }
}

/// The client addresses that logged in to each account, and when.
#[derive(Debug, Default)]
struct KnownTable {
    accounts: HashMap<AccountKey, Vec<(Bucket, i64)>>,
    pairs: usize,
}

impl KnownTable {
    fn is_known(&self, account: AccountKey, client: Bucket, now: i64) -> bool {
        self.accounts.get(&account).is_some_and(|addresses| {
            addresses
                .iter()
                .any(|(bucket, at)| *bucket == client && now.saturating_sub(*at) < KNOWN_FOR_MS)
        })
    }

    fn record(&mut self, account: AccountKey, client: Bucket, now: i64, capacity: usize) {
        if let Some(addresses) = self.accounts.get_mut(&account) {
            if let Some(slot) = addresses.iter_mut().find(|(bucket, _at)| *bucket == client) {
                slot.1 = now;
                return;
            }
            if addresses.len() >= KNOWN_PER_ACCOUNT {
                if let Some(oldest) = addresses.iter_mut().min_by_key(|(_bucket, at)| *at) {
                    *oldest = (client, now);
                }
                return;
            }
        }
        if self.pairs >= capacity {
            return;
        }
        self.accounts
            .entry(account)
            .or_default()
            .push((client, now));
        self.pairs = self.pairs.saturating_add(1);
    }

    fn sweep(&mut self, now: i64) -> usize {
        let before = self.pairs;
        let mut pairs = 0_usize;
        self.accounts.retain(|_account, addresses| {
            addresses.retain(|(_bucket, at)| now.saturating_sub(*at) < KNOWN_FOR_MS);
            pairs = pairs.saturating_add(addresses.len());
            !addresses.is_empty()
        });
        self.pairs = pairs;
        before.saturating_sub(pairs)
    }
}

/// All throttles of the app.
#[derive(Debug)]
pub struct Throttles {
    clients: Table<Bucket>,
    accounts: Table<AccountKey>,
    registrations: Table<Bucket>,
    reset_requests: Table<Bucket>,
    known: Mutex<KnownTable>,
    capacity: usize,
}

impl Default for Throttles {
    fn default() -> Self {
        Self::with_capacity(CAPACITY)
    }
}

/// The places one attempt holds in the throttles until its answer is known; see the module
/// documentation. Dropping it unsettled books a failure.
#[derive(Debug)]
#[must_use = "an attempt that is never settled counts as a failure when it is dropped"]
pub struct Reservation<'a> {
    throttles: &'a Throttles,
    client: Bucket,
    /// The account keys, and whether each took a place (a known address skips the rule).
    accounts: Vec<(AccountKey, bool)>,
    exemptions: bool,
    at: i64,
    settled: bool,
}

impl Reservation<'_> {
    /// Adds an account key to the attempt. A client address that logged in to the account
    /// within [`KNOWN_FOR_MS`] skips its rule (when exemptions are allowed for this attempt),
    /// but a failure still counts on it.
    ///
    /// # Errors
    ///
    /// The wait in milliseconds when the account rule refuses the attempt; the key is then not
    /// part of it.
    pub fn add_account(&mut self, account: AccountKey, now: i64) -> Result<(), i64> {
        let exempt = self.exemptions && self.throttles.is_known(account, self.client, now);
        if !exempt {
            self.throttles.accounts.reserve(account, now)?;
        }
        self.accounts.push((account, !exempt));
        Ok(())
    }

    /// The attempt failed: one failure for the address and every account key.
    pub fn failed(mut self, now: i64) {
        self.settle(Outcome::Failed, Outcome::Failed, now);
    }

    /// The attempt was not checked, or the check passed without being a login (a valid reset
    /// token, a correct current password): nothing is counted.
    pub fn refund(mut self) {
        let at = self.at;
        self.settle(Outcome::Refunded, Outcome::Refunded, at);
    }

    /// The login succeeded: the account's failures are forgotten and the client address becomes
    /// known for it (when exemptions are allowed). The address's own failures stay: logging in to
    /// one's own account must not reset the count of guesses at others.
    pub fn succeeded(mut self, now: i64) {
        self.settle(Outcome::Refunded, Outcome::Succeeded, now);
        if self.exemptions {
            let mut known = self
                .throttles
                .known
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            for (account, _reserved) in &self.accounts {
                known.record(*account, self.client, now, self.throttles.capacity);
            }
        }
    }

    fn settle(&mut self, client: Outcome, accounts: Outcome, now: i64) {
        if std::mem::replace(&mut self.settled, true) {
            return;
        }
        self.throttles
            .clients
            .settle(self.client, true, client, now);
        for (account, reserved) in &self.accounts {
            self.throttles
                .accounts
                .settle(*account, *reserved, accounts, now);
        }
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let at = self.at;
        self.settle(Outcome::Failed, Outcome::Failed, at);
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
            reset_requests: Table::new(RESET_REQUEST_RULE, capacity),
            known: Mutex::new(KnownTable::default()),
            capacity,
        }
    }

    fn is_known(&self, account: AccountKey, client: Bucket, now: i64) -> bool {
        self.known
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_known(account, client, now)
    }

    /// Reserves a login attempt (or a password change) for `account` from `client` at `now`.
    /// `exemptions`: whether a known address may skip the account rule (not behind an unlisted
    /// proxy).
    ///
    /// # Errors
    ///
    /// The wait in milliseconds when a rule refuses the attempt; nothing is counted then.
    pub fn reserve_login(
        &self,
        client: Bucket,
        account: AccountKey,
        exemptions: bool,
        now: i64,
    ) -> Result<Reservation<'_>, i64> {
        let mut reservation = self.reserve_client(client, now)?;
        reservation.exemptions = exemptions;
        if let Err(wait) = reservation.add_account(account, now) {
            reservation.refund();
            return Err(wait);
        }
        Ok(reservation)
    }

    /// Reserves an attempt that counts against the address only (a reset token).
    ///
    /// # Errors
    ///
    /// The wait in milliseconds when the address rule refuses the attempt.
    pub fn reserve_client(&self, client: Bucket, now: i64) -> Result<Reservation<'_>, i64> {
        self.clients.reserve(client, now)?;
        Ok(Reservation {
            throttles: self,
            client,
            accounts: Vec::with_capacity(2),
            exemptions: false,
            at: now,
            settled: false,
        })
    }

    /// Counts a registration attempt from `client`, unless it has to wait: then the wait.
    #[must_use]
    pub fn register_attempt(&self, client: Bucket, now: i64) -> Option<i64> {
        self.registrations.attempt(client, now)
    }

    /// Counts a request for a reset link by e-mail from `client`, unless it has to wait: then
    /// the wait.
    #[must_use]
    pub fn reset_request_attempt(&self, client: Bucket, now: i64) -> Option<i64> {
        self.reset_requests.attempt(client, now)
    }

    /// Drops every key whose window has passed and every known address older than
    /// [`KNOWN_FOR_MS`]; returns how many entries went. Runs with the periodic purge.
    pub fn sweep(&self, now: i64) -> usize {
        let known = self
            .known
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .sweep(now);
        self.clients
            .sweep(now)
            .saturating_add(self.accounts.sweep(now))
            .saturating_add(self.registrations.sweep(now))
            .saturating_add(self.reset_requests.sweep(now))
            .saturating_add(known)
    }

    /// The number of keys in the tables (clients, accounts, registrations, known pairs, reset
    /// requests).
    #[must_use]
    pub fn sizes(&self) -> [usize; 5] {
        [
            self.clients.len(),
            self.accounts.len(),
            self.registrations.len(),
            self.known
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .pairs,
            self.reset_requests.len(),
        ]
    }
}

#[cfg(test)]
#[path = "throttle_tests.rs"]
mod tests;
