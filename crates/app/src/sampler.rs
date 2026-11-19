//! Rate limit for log lines that a client can trigger at will.
//!
//! Every refused cross-site request is worth a log line for an operator, but a client that
//! sends a million of them must not fill the disk or the log pipeline (#135). A
//! [`LogSampler`] lets one line through per interval and counts what it held back; the next
//! line that gets through says how many were suppressed. The exact number of refusals is in
//! the metrics (`stuffcloud_auth_rejections_total`), the log is for the first look.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// Lets one log line through per interval.
#[derive(Debug)]
pub struct LogSampler {
    interval: Duration,
    state: Mutex<SamplerState>,
}

#[derive(Debug, Default)]
struct SamplerState {
    /// When the last line got through; `None` before the first.
    last: Option<Instant>,
    /// Lines held back since then.
    suppressed: u64,
}

impl LogSampler {
    /// A sampler that admits the first line and then at most one per `interval`.
    #[must_use]
    pub const fn new(interval: Duration) -> Self {
        Self {
            interval,
            state: Mutex::new(SamplerState {
                last: None,
                suppressed: 0,
            }),
        }
    }

    /// Whether a line may be logged now. `Some(n)` means yes, and `n` lines were suppressed
    /// since the last one that got through; `None` means no (and counts it).
    pub fn admit(&self) -> Option<u64> {
        self.admit_at(Instant::now())
    }

    /// [`LogSampler::admit`] at a given time (for tests).
    pub fn admit_at(&self, now: Instant) -> Option<u64> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let due = state
            .last
            .is_none_or(|last| now.saturating_duration_since(last) >= self.interval);
        if due {
            state.last = Some(now);
            Some(std::mem::take(&mut state.suppressed))
        } else {
            state.suppressed = state.suppressed.saturating_add(1);
            None
        }
    }
}

/// Lets one event per key through per interval, with bounded memory.
///
/// The audit log records an account that is refused again and again (A-07), but an account
/// that hammers a forbidden route must not turn every request into a database write. A
/// [`KeyedLimiter`] admits the first event of a key and then one per interval; keys whose
/// interval has passed are forgotten when the table is full, and when it is still full after
/// that a new key is not admitted (the metrics still count the refusal).
#[derive(Debug)]
pub struct KeyedLimiter<K> {
    interval: Duration,
    capacity: usize,
    last: Mutex<HashMap<K, Instant>>,
}

impl<K: Eq + Hash> KeyedLimiter<K> {
    /// A limiter that admits each key once per `interval` and remembers at most `capacity`
    /// keys.
    #[must_use]
    pub fn new(interval: Duration, capacity: usize) -> Self {
        Self {
            interval,
            capacity,
            last: Mutex::new(HashMap::new()),
        }
    }

    /// Whether an event for `key` may be recorded now.
    pub fn admit(&self, key: K) -> bool {
        self.admit_at(key, Instant::now())
    }

    /// [`KeyedLimiter::admit`] at a given time (for tests).
    pub fn admit_at(&self, key: K, now: Instant) -> bool {
        let interval = self.interval;
        let fresh = |last: &Instant| now.saturating_duration_since(*last) < interval;
        let mut table = self.last.lock().unwrap_or_else(PoisonError::into_inner);
        match table.get(&key) {
            Some(last) if fresh(last) => return false,
            Some(_expired) => {}
            None => {
                if table.len() >= self.capacity {
                    table.retain(|_key, last| fresh(last));
                    if table.len() >= self.capacity {
                        return false;
                    }
                }
            }
        }
        let _previous = table.insert(key, now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTERVAL: Duration = Duration::from_secs(10);

    #[test]
    fn the_first_line_and_then_one_per_interval() {
        let sampler = LogSampler::new(INTERVAL);
        let start = Instant::now();
        assert_eq!(sampler.admit_at(start), Some(0));
        assert_eq!(sampler.admit_at(start), None);
        assert_eq!(sampler.admit_at(start + Duration::from_secs(9)), None);
        assert_eq!(
            sampler.admit_at(
                (start + INTERVAL)
                    .checked_sub(Duration::from_millis(1))
                    .unwrap()
            ),
            None
        );
        // Exactly one interval later the next line gets through and reports what was held back.
        assert_eq!(sampler.admit_at(start + INTERVAL), Some(3));
        assert_eq!(sampler.admit_at(start + INTERVAL), None);
        assert_eq!(sampler.admit_at(start + INTERVAL * 2), Some(1));
        assert_eq!(sampler.admit_at(start + INTERVAL * 5), Some(0));
    }

    #[test]
    fn a_clock_that_moves_back_never_admits() {
        let sampler = LogSampler::new(INTERVAL);
        let start = Instant::now() + INTERVAL * 3;
        assert_eq!(sampler.admit_at(start), Some(0));
        assert_eq!(
            sampler.admit_at(start.checked_sub(INTERVAL * 2).unwrap()),
            None
        );
    }

    #[test]
    fn a_flood_logs_a_bounded_number_of_lines() {
        let sampler = LogSampler::new(INTERVAL);
        let start = Instant::now();
        let admitted = (0_u32..10_000)
            .filter(|millisecond| {
                sampler
                    .admit_at(start + Duration::from_millis(u64::from(*millisecond)))
                    .is_some()
            })
            .count();
        // Ten seconds of requests: the first line, and one at the 10 s mark.
        assert_eq!(admitted, 1);
    }

    #[test]
    fn the_real_clock_admits_the_first_line() {
        let sampler = LogSampler::new(INTERVAL);
        assert_eq!(sampler.admit(), Some(0));
        assert_eq!(sampler.admit(), None);
    }

    #[test]
    fn a_key_is_admitted_once_per_interval() {
        let limiter = KeyedLimiter::new(INTERVAL, 8);
        let start = Instant::now();
        assert!(limiter.admit_at("a", start));
        assert!(!limiter.admit_at("a", start));
        assert!(
            !limiter.admit_at(
                "a",
                (start + INTERVAL)
                    .checked_sub(Duration::from_millis(1))
                    .unwrap()
            )
        );
        // Another key is independent.
        assert!(limiter.admit_at("b", start));
        // Exactly one interval later the key is admitted again, once.
        assert!(limiter.admit_at("a", start + INTERVAL));
        assert!(!limiter.admit_at("a", start + INTERVAL));
        assert!(limiter.admit_at("a", start + INTERVAL * 2));
    }

    #[test]
    fn a_clock_that_moves_back_never_admits_a_known_key() {
        let limiter = KeyedLimiter::new(INTERVAL, 8);
        let start = Instant::now() + INTERVAL * 3;
        assert!(limiter.admit_at(1, start));
        assert!(!limiter.admit_at(1, start.checked_sub(INTERVAL * 2).unwrap()));
    }

    #[test]
    fn the_table_never_grows_past_its_capacity() {
        let limiter = KeyedLimiter::new(INTERVAL, 3);
        let start = Instant::now();
        for key in 0..3 {
            assert!(limiter.admit_at(key, start));
        }
        // Full of fresh keys: a new key is refused, a known one is still rate limited.
        assert!(!limiter.admit_at(3, start + Duration::from_secs(1)));
        assert!(!limiter.admit_at(0, start + Duration::from_secs(1)));
        // Once the old keys are stale, room is made for the new one.
        assert!(limiter.admit_at(3, start + INTERVAL));
        assert_eq!(limiter.last.lock().unwrap().len(), 1);
        assert!(limiter.admit_at(4, start + INTERVAL));
        assert!(limiter.admit_at(5, start + INTERVAL));
        assert!(!limiter.admit_at(6, start + INTERVAL));
        assert_eq!(limiter.last.lock().unwrap().len(), 3);
    }

    #[test]
    fn an_expired_key_is_replaced_in_place_when_the_table_is_full() {
        let limiter = KeyedLimiter::new(INTERVAL, 2);
        let start = Instant::now();
        assert!(limiter.admit_at("a", start));
        assert!(limiter.admit_at("b", start + Duration::from_secs(5)));
        // "a" is stale and "b" is not: "a" comes back without evicting "b".
        assert!(limiter.admit_at("a", start + INTERVAL));
        assert!(!limiter.admit_at("b", start + INTERVAL));
        assert_eq!(limiter.last.lock().unwrap().len(), 2);
    }

    #[test]
    fn the_real_clock_admits_the_first_event() {
        let limiter = KeyedLimiter::new(INTERVAL, 1);
        assert!(limiter.admit("k"));
        assert!(!limiter.admit("k"));
    }
}
