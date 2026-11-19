//! Rate limit for log lines that a client can trigger at will.
//!
//! Every refused cross-site request is worth a log line for an operator, but a client that
//! sends a million of them must not fill the disk or the log pipeline (#135). A
//! [`LogSampler`] lets one line through per interval and counts what it held back; the next
//! line that gets through says how many were suppressed. The exact number of refusals is in
//! the metrics (`stuffcloud_auth_rejections_total`), the log is for the first look.

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
}
