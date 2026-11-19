//! Login throttling as a pure state machine (A-03, SPEC 6, ADR 0005 addendum "local accounts").
//!
//! A [`Rule`] counts failures of one key (a client address, a login name, ...). The first
//! [`Rule::free`] failures cost nothing. From then on every attempt has to wait: the wait
//! starts at [`Rule::base_ms`] after the last failure and doubles with every further failure,
//! up to [`Rule::max_ms`]. An attempt during the wait is refused without being checked, so it
//! costs the server no password hash and the attacker no information. A key that stays quiet
//! for [`Rule::window_ms`] after its last failure is forgotten.
//!
//! This is a backoff, not a lockout: however many failures a key collects, an attempt is
//! checked again once its wait is over, and the wait never exceeds [`Rule::max_ms`]. The
//! trade-off of the per-account rule (an attacker can keep an account waiting) is described in
//! the ADR; the `app` crate exempts a client address that logged in to that account before.
//!
//! Times are Unix milliseconds; the arithmetic saturates.

/// The parameters of one throttle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    /// Failures that cost nothing.
    pub free: u32,
    /// The first wait (milliseconds), after failure number `free + 1`.
    pub base_ms: i64,
    /// The longest wait (milliseconds).
    pub max_ms: i64,
    /// A key quiet for this long after its last failure is forgotten (milliseconds).
    pub window_ms: i64,
}

/// What one key has done so far.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Failures {
    /// Failures counted (since the key was last forgotten).
    pub count: u32,
    /// Unix milliseconds of the last failure.
    pub last_at: i64,
}

/// The most doublings counted; `base_ms * 2^40` exceeds any sensible maximum.
const MAX_DOUBLINGS: u32 = 40;

impl Rule {
    /// The failures that still count at `now`: nothing once the window has passed.
    #[must_use]
    pub const fn current(&self, failures: Failures, now: i64) -> Failures {
        if now.saturating_sub(failures.last_at) >= self.window_ms {
            Failures {
                count: 0,
                last_at: 0,
            }
        } else {
            failures
        }
    }

    /// The wait after `count` failures (0 while they are free).
    #[must_use]
    pub fn delay_ms(&self, count: u32) -> i64 {
        let Some(over) = count.checked_sub(self.free).filter(|over| *over > 0) else {
            return 0;
        };
        let doublings = over.saturating_sub(1).min(MAX_DOUBLINGS);
        self.base_ms
            .saturating_mul(2_i64.saturating_pow(doublings))
            .min(self.max_ms)
    }

    /// How long an attempt at `now` still has to wait (milliseconds); `None` when it may be
    /// checked.
    #[must_use]
    pub fn wait(&self, failures: Failures, now: i64) -> Option<i64> {
        let failures = self.current(failures, now);
        let until = failures
            .last_at
            .saturating_add(self.delay_ms(failures.count));
        (failures.count > self.free && now < until).then(|| until.saturating_sub(now))
    }

    /// The state after a failed attempt at `now`.
    #[must_use]
    pub const fn fail(&self, failures: Failures, now: i64) -> Failures {
        let failures = self.current(failures, now);
        Failures {
            count: failures.count.saturating_add(1),
            last_at: now,
        }
    }

    /// Whether the key can be forgotten at `now` (nothing would change if it were).
    #[must_use]
    pub const fn is_stale(&self, failures: Failures, now: i64) -> bool {
        now.saturating_sub(failures.last_at) >= self.window_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RULE: Rule = Rule {
        free: 3,
        base_ms: 1000,
        max_ms: 8000,
        window_ms: 60_000,
    };

    fn after(count: u32, last_at: i64) -> Failures {
        Failures { count, last_at }
    }

    #[test]
    fn free_failures_never_wait() {
        let mut state = Failures::default();
        for n in 1..=3 {
            state = RULE.fail(state, 100);
            assert_eq!(state, after(n, 100));
            assert_eq!(RULE.wait(state, 100), None, "{n}");
        }
        state = RULE.fail(state, 100);
        assert_eq!(RULE.wait(state, 100), Some(1000));
        assert_eq!(RULE.wait(state, 1099), Some(1));
        assert_eq!(RULE.wait(state, 1100), None);
    }

    #[test]
    fn free_failures_do_not_wait_even_when_the_clock_steps_back() {
        // At the free count the delay is 0, so only the comparison with `free` keeps a clock that
        // stepped back from turning the last failure into a wait.
        assert_eq!(RULE.wait(after(3, 100), 50), None);
        assert_eq!(RULE.wait(after(4, 100), 50), Some(1050));
    }

    #[test]
    fn the_wait_doubles_up_to_the_maximum() {
        assert_eq!(RULE.delay_ms(0), 0);
        assert_eq!(RULE.delay_ms(3), 0);
        assert_eq!(RULE.delay_ms(4), 1000);
        assert_eq!(RULE.delay_ms(5), 2000);
        assert_eq!(RULE.delay_ms(6), 4000);
        assert_eq!(RULE.delay_ms(7), 8000);
        assert_eq!(RULE.delay_ms(8), 8000);
        assert_eq!(RULE.delay_ms(u32::MAX), 8000);
        let huge = Rule {
            max_ms: i64::MAX,
            ..RULE
        };
        assert_eq!(huge.delay_ms(44), 1000 * (1 << 40));
        assert_eq!(huge.delay_ms(u32::MAX), 1000 * (1 << 40));
        let giant = Rule {
            base_ms: i64::MAX / 2,
            ..huge
        };
        assert_eq!(giant.delay_ms(6), i64::MAX);
    }

    #[test]
    fn a_quiet_key_is_forgotten() {
        let state = after(10, 1_000);
        assert_eq!(RULE.current(state, 60_999), state);
        assert_eq!(RULE.current(state, 61_000), Failures::default());
        assert!(!RULE.is_stale(state, 60_999));
        assert!(RULE.is_stale(state, 61_000));
        assert_eq!(RULE.wait(state, 61_000), None);
        assert_eq!(RULE.fail(state, 61_000), after(1, 61_000));
        assert_eq!(RULE.fail(state, 60_999), after(11, 60_999));
    }

    #[test]
    fn saturates() {
        let state = after(u32::MAX, i64::MAX);
        assert_eq!(RULE.fail(state, i64::MAX), after(u32::MAX, i64::MAX));
        assert_eq!(RULE.wait(after(5, i64::MAX - 10), i64::MAX - 10), Some(10));
        assert_eq!(
            RULE.current(after(1, i64::MIN), i64::MAX),
            Failures::default()
        );
    }
}
