//! Password hashing with Argon2id (A-03, ADR 0005 decision 8 and addendum "local accounts").
//!
//! - Every password is hashed in its NFKC form ([`normalize_password`]) with Argon2id
//!   (version 19), a 16-byte random salt and the deployment's parameters, and stored as a PHC
//!   string, so each hash carries the parameters it was made with. A login with a hash made
//!   with other parameters stores a new hash ([`Verified::rehash`]).
//! - The defaults are the first of OWASP's recommended Argon2id configurations (19 MiB memory,
//!   2 iterations, 1 lane). An operator calibrates them with `STUFFCLOUD_ARGON2_*`; the start-up
//!   log reports how long one hash takes on the machine (keep it well below a second). The
//!   memory may not go below OWASP's minimum for the number of iterations
//!   ([`owasp_min_memory_kib`]: 46 MiB x 1, 19 MiB x 2, 12 MiB x 3, 9 MiB x 4, 7 MiB x 5 and
//!   more); the configuration refuses weaker pairs.
//! - Hashing is CPU and memory heavy, so it runs on the blocking pool, never on an async worker,
//!   and at most [`Passwords::concurrency`] hashes run at once, so login traffic cannot exhaust
//!   the memory of the host. Further requests queue for a slot, but the queue is bounded
//!   ([`QUEUE_PER_SLOT`] waiting requests per slot, each for at most [`MAX_QUEUE_WAIT`]): beyond
//!   it a request is answered at once with 429 and `Retry-After` ([`Problem::busy`]) instead of
//!   waiting into the request time limit, so a flood cannot make every legitimate login time
//!   out (#145). Such a request was not checked and does not count as a failed login.
//! - An unknown account is checked against a dummy hash made at start-up with the same
//!   parameters ([`Passwords::verify`] with `None`), so the answer takes as long as for a known
//!   account: the timing does not tell whether an account exists. [`Passwords::verifications`]
//!   counts every check, which lets the tests prove that each login path hashes exactly once.
//! - The breached-password check is an offline list the operator supplies
//!   (`STUFFCLOUD_PASSWORD_BLOCKLIST_FILE`, one password per line, for example a download of a
//!   breached-password corpus); no request ever leaves the host. It is kept in memory as the
//!   first 8 bytes of the SHA-256 of each normalised line, sorted.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use argon2::password_hash::Error as HashError;
use argon2::{
    ARGON2ID_IDENT, Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier,
    Version,
};
use sha2::{Digest, Sha256};
use stuffcloud_core::account::{PasswordPolicy, normalize_password};
use stuffcloud_core::token::Token;
use tokio::sync::{Semaphore, SemaphorePermit, TryAcquireError};

use crate::problem::Problem;

/// Length of the random salt in bytes.
pub const SALT_BYTES: usize = 16;

/// Default memory cost in KiB (OWASP: 19 MiB).
pub const DEFAULT_MEMORY_KIB: u32 = 19 * 1024;
/// Smallest memory cost an operator may configure in KiB (OWASP's lowest pairing, 7 MiB).
pub const MIN_MEMORY_KIB: u32 = 7 * 1024;
/// Largest memory cost an operator may configure in KiB (1 GiB).
pub const MAX_MEMORY_KIB: u32 = 1024 * 1024;
/// Default number of iterations (OWASP: 2 with 19 MiB).
pub const DEFAULT_ITERATIONS: u32 = 2;
/// Largest number of iterations an operator may configure.
pub const MAX_ITERATIONS: u32 = 10;
/// Default degree of parallelism (lanes).
pub const DEFAULT_PARALLELISM: u32 = 1;
/// Largest degree of parallelism an operator may configure.
pub const MAX_PARALLELISM: u32 = 16;
/// Most hashes computed at the same time.
pub const MAX_CONCURRENCY: usize = 16;
/// Requests that may wait for a hashing slot, per slot.
pub const QUEUE_PER_SLOT: usize = 8;
/// The longest a request waits for a hashing slot.
pub const MAX_QUEUE_WAIT: Duration = Duration::from_secs(5);
/// What a request refused for a full queue is told to wait (milliseconds).
pub const BUSY_RETRY_MS: i64 = 1000;

/// OWASP's smallest memory cost in KiB for `iterations` (its recommended Argon2id pairs:
/// 46 MiB x 1, 19 MiB x 2, 12 MiB x 3, 9 MiB x 4, 7 MiB x 5; more iterations keep 7 MiB).
#[must_use]
pub const fn owasp_min_memory_kib(iterations: u32) -> u32 {
    match iterations {
        0 | 1 => 46 * 1024,
        2 => 19 * 1024,
        3 => 12 * 1024,
        4 => 9 * 1024,
        _ => MIN_MEMORY_KIB,
    }
}

/// The Argon2id parameters of the deployment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Settings {
    /// Memory in KiB.
    pub memory_kib: u32,
    /// Iterations.
    pub iterations: u32,
    /// Lanes.
    pub parallelism: u32,
}

impl Default for Argon2Settings {
    fn default() -> Self {
        Self {
            memory_kib: DEFAULT_MEMORY_KIB,
            iterations: DEFAULT_ITERATIONS,
            parallelism: DEFAULT_PARALLELISM,
        }
    }
}

impl Argon2Settings {
    /// The smallest parameters Argon2 accepts. Only for tests: a hash costs next to nothing.
    pub const CHEAPEST: Self = Self {
        memory_kib: 8,
        iterations: 1,
        parallelism: 1,
    };

    /// The parameters as the library takes them.
    ///
    /// # Errors
    ///
    /// The library's reason when the combination is invalid.
    pub fn params(&self) -> Result<Params, String> {
        Params::new(self.memory_kib, self.iterations, self.parallelism, None)
            .map_err(|error| error.to_string())
    }
}

/// The offline list of breached or common passwords.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Blocklist(Vec<u64>);

/// The list key of a password: the first 8 bytes of the SHA-256 of its NFKC form.
fn list_key(password: &str) -> u64 {
    let digest = Sha256::digest(normalize_password(password).as_bytes());
    let mut first = [0_u8; 8];
    for (slot, byte) in first.iter_mut().zip(digest.iter()) {
        *slot = *byte;
    }
    u64::from_be_bytes(first)
}

impl Blocklist {
    /// Reads a list with one password per line (`\n` or `\r\n`); empty lines are skipped.
    #[must_use]
    pub fn from_text(text: &str) -> Self {
        let mut keys: Vec<u64> = text
            .lines()
            .filter(|line| !line.is_empty())
            .map(list_key)
            .collect();
        keys.sort_unstable();
        keys.dedup();
        Self(keys)
    }

    /// Whether the password is on the list.
    #[must_use]
    pub fn contains(&self, password: &str) -> bool {
        self.0.binary_search(&list_key(password)).is_ok()
    }

    /// How many passwords the list holds.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the list is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// The result of a password check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    /// Whether the password matches the stored hash.
    pub matches: bool,
    /// A new hash with the current parameters, when the password matched a hash made with
    /// other ones.
    pub rehash: Option<String>,
}

/// Hashing, checking and the policy of passwords.
#[derive(Debug)]
pub struct Passwords {
    params: Params,
    dummy: String,
    policy: PasswordPolicy,
    blocklist: Blocklist,
    permits: Semaphore,
    concurrency: usize,
    queue: usize,
    max_wait: Duration,
    waiting: AtomicUsize,
    verifications: AtomicU64,
    calibration_ms: u128,
}

/// A place in the queue for a hashing slot, given back when the wait ends (also when the
/// request is cancelled).
struct Waiting<'a>(&'a AtomicUsize);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let _left = self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// The hasher for the parameters.
fn argon2(params: Params) -> Argon2<'static> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Hashes the NFKC form of a password with a fresh salt.
fn hash_blocking(params: &Params, password: &str) -> Result<String, String> {
    let mut salt = [0_u8; SALT_BYTES];
    getrandom::fill(&mut salt).map_err(|error| error.to_string())?;
    argon2(params.clone())
        .hash_password_with_salt(normalize_password(password).as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| error.to_string())
}

/// Whether a stored hash was made with other parameters than `current`.
fn outdated(hash: &PasswordHash, current: &Params) -> bool {
    let same = hash.algorithm.as_str() == ARGON2ID_IDENT.as_str()
        && hash.version == Some(Version::V0x13.into())
        && Params::try_from(hash).is_ok_and(|stored| {
            stored.m_cost() == current.m_cost()
                && stored.t_cost() == current.t_cost()
                && stored.p_cost() == current.p_cost()
        });
    !same
}

/// Checks a password against a stored PHC string (the dummy for an unknown account).
fn verify_blocking(
    params: &Params,
    password: &str,
    stored: &str,
    real: bool,
) -> Result<Verified, String> {
    let parsed = PasswordHash::new(stored).map_err(|error| error.to_string())?;
    let normalized = normalize_password(password);
    match argon2(params.clone()).verify_password(normalized.as_bytes(), &parsed) {
        Ok(()) if real => {
            let rehash = if outdated(&parsed, params) {
                Some(hash_blocking(params, password)?)
            } else {
                None
            };
            Ok(Verified {
                matches: true,
                rehash,
            })
        }
        Ok(()) | Err(HashError::PasswordInvalid) => Ok(Verified {
            matches: false,
            rehash: None,
        }),
        Err(error) => Err(error.to_string()),
    }
}

impl Passwords {
    /// Sets up hashing: checks the parameters, makes the dummy hash for unknown accounts (and
    /// measures how long it took), and allows `concurrency` hashes at once (1 to
    /// [`MAX_CONCURRENCY`]).
    ///
    /// # Errors
    ///
    /// A sentence for the operator when the parameters are invalid or the random source fails.
    pub fn new(
        settings: Argon2Settings,
        policy: PasswordPolicy,
        blocklist: Blocklist,
        concurrency: usize,
    ) -> Result<Self, String> {
        let params = settings.params()?;
        let mut secret = [0_u8; 32];
        getrandom::fill(&mut secret).map_err(|error| error.to_string())?;
        let started = Instant::now();
        let dummy = hash_blocking(&params, &Token::from_bytes(secret).to_hex())?;
        let calibration_ms = started.elapsed().as_millis();
        let concurrency = concurrency.clamp(1, MAX_CONCURRENCY);
        Ok(Self {
            params,
            dummy,
            policy,
            blocklist,
            permits: Semaphore::new(concurrency),
            concurrency,
            queue: concurrency.saturating_mul(QUEUE_PER_SLOT),
            max_wait: MAX_QUEUE_WAIT,
            waiting: AtomicUsize::new(0),
            verifications: AtomicU64::new(0),
            calibration_ms,
        })
    }

    /// The same with another bound of the queue: at most `queue` requests wait for a slot, each
    /// for at most `max_wait`.
    #[must_use]
    pub const fn with_queue(mut self, queue: usize, max_wait: Duration) -> Self {
        self.queue = queue;
        self.max_wait = max_wait;
        self
    }

    /// How many requests may wait for a hashing slot.
    #[must_use]
    pub const fn queue(&self) -> usize {
        self.queue
    }

    /// The password policy.
    #[must_use]
    pub const fn policy(&self) -> &PasswordPolicy {
        &self.policy
    }

    /// Whether the password is on the offline list.
    #[must_use]
    pub fn breached(&self, password: &str) -> bool {
        self.blocklist.contains(password)
    }

    /// How many hashes may run at once.
    #[must_use]
    pub const fn concurrency(&self) -> usize {
        self.concurrency
    }

    /// How long the dummy hash took at start-up (milliseconds): the cost of one login.
    #[must_use]
    pub const fn calibration_ms(&self) -> u128 {
        self.calibration_ms
    }

    /// How many password checks ran (real and dummy); a request refused for a full queue is
    /// not one.
    #[must_use]
    pub fn verifications(&self) -> u64 {
        self.verifications.load(Ordering::Relaxed)
    }

    /// Takes every hashing slot, so the next request has to queue (tests of the callers).
    #[cfg(test)]
    pub(crate) fn hold_slots(&self) -> SemaphorePermit<'_> {
        self.permits
            .try_acquire_many(u32::try_from(self.concurrency).unwrap())
            .unwrap()
    }

    /// A hashing slot: a free one at once, or one waited for in the bounded queue.
    async fn slot(&self) -> Result<SemaphorePermit<'_>, Problem> {
        match self.permits.try_acquire() {
            Ok(permit) => return Ok(permit),
            Err(TryAcquireError::Closed) => {
                return Err(Problem::internal(&"the hashing slots are closed"));
            }
            Err(TryAcquireError::NoPermits) => {}
        }
        let queue = self.queue;
        if self
            .waiting
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |waiting| {
                (waiting < queue).then_some(waiting.saturating_add(1))
            })
            .is_err()
        {
            return Err(Problem::busy(BUSY_RETRY_MS));
        }
        let _waiting = Waiting(&self.waiting);
        match tokio::time::timeout(self.max_wait, self.permits.acquire()).await {
            Ok(Ok(permit)) => Ok(permit),
            Ok(Err(closed)) => Err(Problem::internal(&closed)),
            Err(_elapsed) => Err(Problem::busy(BUSY_RETRY_MS)),
        }
    }

    /// Runs `work` on the blocking pool (the caller holds a slot).
    async fn blocking<T: Send + 'static>(
        work: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, Problem> {
        tokio::task::spawn_blocking(work)
            .await
            .map_err(|error| Problem::internal(&error))?
            .map_err(|error| Problem::internal(&error))
    }

    /// The PHC string of a new password.
    ///
    /// # Errors
    ///
    /// An internal problem when hashing fails; [`Problem::busy`] when the queue is full.
    pub async fn hash(&self, password: &str) -> Result<String, Problem> {
        let params = self.params.clone();
        let password = password.to_owned();
        let _slot = self.slot().await?;
        Self::blocking(move || hash_blocking(&params, &password)).await
    }

    /// [`Passwords::hash`] on the calling thread, outside the runtime (the first admin at
    /// start-up).
    ///
    /// # Errors
    ///
    /// A sentence when hashing fails.
    pub fn hash_now(&self, password: &str) -> Result<String, String> {
        hash_blocking(&self.params, password)
    }

    /// Checks a password against the stored hash of an account, or against the dummy hash when
    /// there is none (unknown account, service account, no password): exactly one Argon2
    /// computation either way, and never a match without a stored hash.
    ///
    /// # Errors
    ///
    /// An internal problem when the stored hash is not a PHC string or hashing fails;
    /// [`Problem::busy`] (429) when no slot is free and the queue is full, or the wait for a
    /// slot took too long: then nothing was checked.
    pub async fn verify(&self, password: &str, stored: Option<&str>) -> Result<Verified, Problem> {
        let _slot = self.slot().await?;
        let _counted = self.verifications.fetch_add(1, Ordering::Relaxed);
        let params = self.params.clone();
        let password = password.to_owned();
        let real = stored.is_some();
        let stored = stored.unwrap_or(&self.dummy).to_owned();
        Self::blocking(move || verify_blocking(&params, &password, &stored, real)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cheap() -> Passwords {
        Passwords::new(
            Argon2Settings::CHEAPEST,
            PasswordPolicy::default(),
            Blocklist::from_text("correct horse battery staple\r\n\nhunter2hunter2\n"),
            2,
        )
        .unwrap()
    }

    #[test]
    fn settings() {
        assert_eq!(
            Argon2Settings::default(),
            Argon2Settings {
                memory_kib: 19_456,
                iterations: 2,
                parallelism: 1
            }
        );
        let params = Argon2Settings::default().params().unwrap();
        assert_eq!(
            (params.m_cost(), params.t_cost(), params.p_cost()),
            (19_456, 2, 1)
        );
        let error = Argon2Settings {
            memory_kib: 8,
            iterations: 1,
            parallelism: 2,
        }
        .params()
        .unwrap_err();
        assert!(!error.is_empty());
        assert!(
            Argon2Settings {
                iterations: 0,
                ..Argon2Settings::CHEAPEST
            }
            .params()
            .is_err()
        );
    }

    #[test]
    fn blocklist() {
        let list = Blocklist::from_text("one\ntwo\r\ntwo\n\nthree");
        assert_eq!(list.len(), 3);
        assert!(!list.is_empty());
        assert!(list.contains("two"));
        assert!(list.contains("three"));
        assert!(!list.contains("Two"));
        assert!(!list.contains(""));
        // The list compares NFKC forms: a ligature matches its letters.
        assert!(Blocklist::from_text("finale").contains("\u{fb01}nale"));
        assert!(Blocklist::default().is_empty());
        assert!(!Blocklist::default().contains("one"));
        assert_ne!(list_key("a"), list_key("b"));
    }

    #[tokio::test]
    async fn hashes_verify_and_carry_their_parameters() {
        let passwords = cheap();
        assert_eq!(passwords.concurrency(), 2);
        let hash = passwords.hash("correct horse").await.unwrap();
        assert!(hash.starts_with("$argon2id$v=19$m=8,t=1,p=1$"), "{hash}");
        let again = passwords.hash("correct horse").await.unwrap();
        assert_ne!(hash, again, "every hash has its own salt");
        assert_eq!(
            passwords
                .verify("correct horse", Some(&hash))
                .await
                .unwrap(),
            Verified {
                matches: true,
                rehash: None
            }
        );
        assert_eq!(
            passwords
                .verify("correct horsE", Some(&hash))
                .await
                .unwrap(),
            Verified {
                matches: false,
                rehash: None
            }
        );
        // NFKC: the ligature and its letters are the same password.
        let now = passwords.hash_now("correct horse").unwrap();
        assert!(
            passwords
                .verify("correct horse", Some(&now))
                .await
                .unwrap()
                .matches
        );
        let ligature = passwords.hash("\u{fb01}ne").await.unwrap();
        assert!(
            passwords
                .verify("fine", Some(&ligature))
                .await
                .unwrap()
                .matches
        );
        assert_eq!(passwords.verifications(), 4);
    }

    #[tokio::test]
    async fn without_a_stored_hash_the_dummy_is_checked_and_never_matches() {
        let passwords = cheap();
        let before = passwords.verifications();
        let verdict = passwords.verify("anything", None).await.unwrap();
        assert!(!verdict.matches);
        assert_eq!(passwords.verifications(), before + 1);
        assert!(passwords.dummy.starts_with("$argon2id$"));
    }

    #[tokio::test]
    async fn a_hash_with_old_parameters_is_replaced_on_login() {
        let old = Passwords::new(
            Argon2Settings {
                memory_kib: 16,
                iterations: 2,
                parallelism: 1,
            },
            PasswordPolicy::default(),
            Blocklist::default(),
            1,
        )
        .unwrap();
        let stored = old.hash("secret words").await.unwrap();
        let current = cheap();
        let verdict = current.verify("secret words", Some(&stored)).await.unwrap();
        assert!(verdict.matches);
        let rehash = verdict.rehash.unwrap();
        assert!(
            rehash.starts_with("$argon2id$v=19$m=8,t=1,p=1$"),
            "{rehash}"
        );
        assert!(
            current
                .verify("secret words", Some(&rehash))
                .await
                .unwrap()
                .matches
        );
        // A wrong password never produces a new hash.
        assert_eq!(
            current.verify("wrong", Some(&stored)).await.unwrap().rehash,
            None
        );
        // Each parameter on its own counts.
        for (memory_kib, iterations, parallelism) in [(16, 1, 1), (8, 2, 1), (16, 1, 2)] {
            let other = Passwords::new(
                Argon2Settings {
                    memory_kib,
                    iterations,
                    parallelism,
                },
                PasswordPolicy::default(),
                Blocklist::default(),
                1,
            )
            .unwrap();
            let stored = other.hash("x").await.unwrap();
            let verdict = current.verify("x", Some(&stored)).await.unwrap();
            assert!(
                verdict.rehash.is_some(),
                "{memory_kib} {iterations} {parallelism}"
            );
        }
        // Another variant of Argon2 is replaced too.
        let argon2i = Argon2::new(
            Algorithm::Argon2i,
            Version::V0x13,
            Argon2Settings::CHEAPEST.params().unwrap(),
        )
        .hash_password_with_salt(b"x", b"saltsaltsaltsalt")
        .unwrap()
        .to_string();
        let verdict = current.verify("x", Some(&argon2i)).await.unwrap();
        assert!(verdict.matches);
        assert!(verdict.rehash.is_some());
        let v16 = Argon2::new(
            Algorithm::Argon2id,
            Version::V0x10,
            Argon2Settings::CHEAPEST.params().unwrap(),
        )
        .hash_password_with_salt(b"x", b"saltsaltsaltsalt")
        .unwrap()
        .to_string();
        let verdict = current.verify("x", Some(&v16)).await.unwrap();
        assert!(verdict.matches);
        assert!(verdict.rehash.is_some());
    }

    #[tokio::test]
    async fn a_broken_stored_hash_is_an_internal_error() {
        let passwords = cheap();
        for broken in ["", "plain", "$md5$c2FsdHNhbHQ$aGFzaA"] {
            assert!(
                passwords.verify("x", Some(broken)).await.is_err(),
                "{broken:?}"
            );
        }
    }

    #[test]
    fn the_dummy_check_never_matches_not_even_its_own_password() {
        let passwords = cheap();
        let hash = passwords.hash_now("the one and only passphrase").unwrap();
        // The same password and a valid hash: a real check matches, a dummy check does not.
        let real = verify_blocking(
            &passwords.params,
            "the one and only passphrase",
            &hash,
            true,
        )
        .unwrap();
        assert!(real.matches);
        let dummy = verify_blocking(
            &passwords.params,
            "the one and only passphrase",
            &hash,
            false,
        )
        .unwrap();
        assert_eq!(
            dummy,
            Verified {
                matches: false,
                rehash: None
            }
        );
    }

    #[test]
    fn the_calibration_is_the_time_of_one_hash() {
        // A hash of 32 MiB with three passes takes far longer than a millisecond, in every
        // build profile; 0 or 1 would mean the measurement is thrown away.
        let measured = Passwords::new(
            Argon2Settings {
                memory_kib: 32_768,
                iterations: 3,
                parallelism: 1,
            },
            PasswordPolicy::default(),
            Blocklist::default(),
            1,
        )
        .unwrap();
        assert!(
            measured.calibration_ms() > 1,
            "{}",
            measured.calibration_ms()
        );
        assert!(measured.calibration_ms() < 60_000);
    }
    #[test]
    fn the_owasp_floor_follows_its_pairs() {
        assert_eq!(owasp_min_memory_kib(0), 47_104);
        assert_eq!(owasp_min_memory_kib(1), 47_104);
        assert_eq!(owasp_min_memory_kib(2), 19_456);
        assert_eq!(owasp_min_memory_kib(3), 12_288);
        assert_eq!(owasp_min_memory_kib(4), 9_216);
        assert_eq!(owasp_min_memory_kib(5), 7_168);
        assert_eq!(owasp_min_memory_kib(MAX_ITERATIONS), MIN_MEMORY_KIB);
        // The defaults are OWASP's first pair, exactly at the floor.
        let defaults = Argon2Settings::default();
        assert_eq!(
            owasp_min_memory_kib(defaults.iterations),
            defaults.memory_kib
        );
        assert_eq!(QUEUE_PER_SLOT, 8);
        assert_eq!(MAX_QUEUE_WAIT, Duration::from_secs(5));
        assert_eq!(BUSY_RETRY_MS, 1000);
    }

    /// Waits until `count` requests are queued for a slot; fails after two seconds, so a broken
    /// queue fails the test instead of hanging it.
    async fn queued(passwords: &Passwords, count: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while passwords.waiting.load(Ordering::Acquire) != count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the request never queued");
    }

    /// The answer of `work`, which must come at once (no waiting in the queue).
    async fn at_once<T>(work: impl Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(2), work)
            .await
            .expect("the request waited instead of being answered at once")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_queue_for_a_slot_is_bounded() {
        let passwords = std::sync::Arc::new(cheap().with_queue(1, Duration::from_secs(30)));
        assert_eq!(passwords.queue(), 1);
        assert_eq!(cheap().queue(), 2 * QUEUE_PER_SLOT);
        let first = passwords.permits.try_acquire().unwrap();
        let second = passwords.permits.try_acquire().unwrap();
        // One request may wait...
        let waiter = {
            let passwords = std::sync::Arc::clone(&passwords);
            tokio::spawn(async move { passwords.verify("anything", None).await })
        };
        queued(&passwords, 1).await;
        // ...the next one is refused at once, and nothing was checked.
        for refused in [
            at_once(passwords.verify("anything", None))
                .await
                .unwrap_err(),
            at_once(passwords.hash("anything")).await.unwrap_err(),
        ] {
            assert_eq!(refused.kind(), crate::problem::ProblemKind::TooManyRequests);
            assert_eq!(refused.retry_after(), Some(1));
            assert_eq!(
                refused.body().detail.as_deref(),
                Some("the server is busy checking other passwords; try again in 1 second")
            );
        }
        assert_eq!(passwords.verifications(), 0);
        drop(first);
        assert!(!waiter.await.unwrap().unwrap().matches);
        assert_eq!(passwords.verifications(), 1);
        assert_eq!(passwords.waiting.load(Ordering::Acquire), 0);
        drop(second);
        // With free slots nobody queues.
        assert!(!passwords.verify("anything", None).await.unwrap().matches);
        assert_eq!(passwords.waiting.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn a_request_waits_for_a_slot_only_so_long() {
        let passwords = cheap().with_queue(4, Duration::from_millis(20));
        let _first = passwords.permits.try_acquire().unwrap();
        let _second = passwords.permits.try_acquire().unwrap();
        let refused = passwords.verify("anything", None).await.unwrap_err();
        assert_eq!(refused.retry_after(), Some(1));
        assert_eq!(passwords.waiting.load(Ordering::Acquire), 0);
        assert_eq!(passwords.verifications(), 0);
        passwords.permits.close();
        assert_eq!(
            passwords.verify("anything", None).await.unwrap_err().kind(),
            crate::problem::ProblemKind::Internal
        );
    }

    #[tokio::test]
    async fn closed_slots_are_an_internal_error_also_while_waiting() {
        let passwords = std::sync::Arc::new(cheap().with_queue(4, Duration::from_secs(30)));
        let first = passwords.permits.try_acquire().unwrap();
        let _second = passwords.permits.try_acquire().unwrap();
        let waiter = {
            let passwords = std::sync::Arc::clone(&passwords);
            tokio::spawn(async move { passwords.hash("anything").await })
        };
        queued(&passwords, 1).await;
        passwords.permits.close();
        assert_eq!(
            waiter.await.unwrap().unwrap_err().kind(),
            crate::problem::ProblemKind::Internal
        );
        drop(first);
    }

    #[test]
    fn policy_breach_and_calibration() {
        let passwords = cheap();
        assert_eq!(passwords.policy(), &PasswordPolicy::default());
        assert!(passwords.breached("hunter2hunter2"));
        assert!(!passwords.breached("hunter3hunter3"));
        assert!(passwords.calibration_ms() < 60_000);
        let one = Passwords::new(
            Argon2Settings::CHEAPEST,
            PasswordPolicy::default(),
            Blocklist::default(),
            0,
        )
        .unwrap();
        assert_eq!(one.concurrency(), 1);
        let many = Passwords::new(
            Argon2Settings::CHEAPEST,
            PasswordPolicy::default(),
            Blocklist::default(),
            1000,
        )
        .unwrap();
        assert_eq!(many.concurrency(), MAX_CONCURRENCY);
        assert!(
            Passwords::new(
                Argon2Settings {
                    iterations: 0,
                    ..Argon2Settings::CHEAPEST
                },
                PasswordPolicy::default(),
                Blocklist::default(),
                1
            )
            .is_err()
        );
    }
}
