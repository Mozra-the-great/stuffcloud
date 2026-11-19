//! Shared state of the handlers: database, access policy, clock, metrics, limits and the
//! authentication settings.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use stuffcloud_db::{Database, DbError};

use crate::access::{AccessPolicy, DenialKey};
use crate::auth::AuthSettings;
use crate::config::Limits;
use crate::metrics::Metrics;
use crate::problem::Problem;
use crate::sampler::{KeyedLimiter, LogSampler};

/// Source of the current time, replaceable in tests.
pub trait Clock: Send + Sync + fmt::Debug {
    /// Unix time in milliseconds.
    fn now_millis(&self) -> i64;
}

/// The system clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_millis(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| {
                i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
            })
    }
}

/// At most one log line per this interval for refused cross-site requests (#135); the exact
/// count is in the metrics.
pub const REJECTION_LOG_INTERVAL: Duration = Duration::from_secs(10);

/// An account that is refused again and again by the access policy is audited at most once per
/// this interval per rule (A-07); the exact count is in the metrics.
pub const DENIAL_AUDIT_INTERVAL: Duration = Duration::from_mins(1);

/// How many (account, rule) pairs the denial audit remembers; beyond it, new pairs are not
/// audited until old ones age out.
pub const DENIAL_AUDIT_CAPACITY: usize = 4096;

/// Everything a handler needs. Cheap to clone.
#[derive(Debug, Clone)]
pub struct AppState {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    db: Arc<Database>,
    policy: Arc<dyn AccessPolicy>,
    clock: Arc<dyn Clock>,
    metrics: Metrics,
    limits: Limits,
    auth: AuthSettings,
    rejection_log: LogSampler,
    denial_audit: KeyedLimiter<DenialKey>,
}

impl AppState {
    /// Builds the state.
    #[must_use]
    pub fn new(
        db: Arc<Database>,
        policy: Arc<dyn AccessPolicy>,
        clock: Arc<dyn Clock>,
        limits: Limits,
        auth: AuthSettings,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                db,
                policy,
                clock,
                metrics: Metrics::new(),
                limits,
                auth,
                rejection_log: LogSampler::new(REJECTION_LOG_INTERVAL),
                denial_audit: KeyedLimiter::new(DENIAL_AUDIT_INTERVAL, DENIAL_AUDIT_CAPACITY),
            }),
        }
    }

    /// The authentication settings.
    #[must_use]
    pub fn auth(&self) -> &AuthSettings {
        &self.inner.auth
    }

    /// The rate limit of the log lines for refused requests.
    #[must_use]
    pub fn rejection_log(&self) -> &LogSampler {
        &self.inner.rejection_log
    }

    /// The rate limit of the audit rows for refused requests.
    #[must_use]
    pub fn denial_audit(&self) -> &KeyedLimiter<DenialKey> {
        &self.inner.denial_audit
    }

    /// The access policy.
    #[must_use]
    pub fn policy(&self) -> &dyn AccessPolicy {
        &*self.inner.policy
    }

    /// The clock.
    #[must_use]
    pub fn now_millis(&self) -> i64 {
        self.inner.clock.now_millis()
    }

    /// The metrics registry.
    #[must_use]
    pub fn metrics(&self) -> &Metrics {
        &self.inner.metrics
    }

    /// The request limits.
    #[must_use]
    pub fn limits(&self) -> Limits {
        self.inner.limits
    }

    /// Runs a database operation on the blocking thread pool (never on an async worker) and
    /// hands back its own error, for callers that react to a specific [`DbError`].
    ///
    /// # Errors
    ///
    /// An internal problem when the operation's thread panics.
    pub async fn db_outcome<T, F>(&self, operation: F) -> Result<Result<T, DbError>, Problem>
    where
        T: Send + 'static,
        F: FnOnce(&Database) -> Result<T, DbError> + Send + 'static,
    {
        let db = Arc::clone(&self.inner.db);
        tokio::task::spawn_blocking(move || operation(&db))
            .await
            .map_err(|join_error| Problem::internal(&join_error))
    }

    /// Runs a database operation on the blocking thread pool (never on an async worker).
    ///
    /// # Errors
    ///
    /// An internal problem when the operation fails or its thread panics.
    pub async fn db<T, F>(&self, operation: F) -> Result<T, Problem>
    where
        T: Send + 'static,
        F: FnOnce(&Database) -> Result<T, DbError> + Send + 'static,
    {
        self.db_outcome(operation)
            .await?
            .map_err(|error| Problem::internal(&error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::MatrixPolicy;
    use crate::problem::ProblemKind;

    fn settings() -> AuthSettings {
        AuthSettings {
            app_origin: stuffcloud_core::csrf::Origin::parse(b"https://app.example.com").unwrap(),
            timeouts: stuffcloud_core::session::Timeouts::default(),
        }
    }

    #[test]
    fn system_clock_is_plausible() {
        // 2026-01-01T00:00:00Z in milliseconds; the clock must be past it.
        assert!(SystemClock.now_millis() > 1_767_225_600_000);
    }

    #[tokio::test]
    async fn db_errors_and_panics_become_internal_problems() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("s.sqlite3")).unwrap());
        let state = AppState::new(
            db,
            Arc::new(MatrixPolicy),
            Arc::new(SystemClock),
            Limits::default(),
            settings(),
        );
        assert_eq!(state.db(|_db| Ok(7)).await.unwrap(), 7);
        let failed = state
            .db(|_db| Err::<(), _>(DbError::Poisoned))
            .await
            .unwrap_err();
        assert_eq!(failed.kind(), ProblemKind::Internal);
        let panicked = state
            .db(|_db| -> Result<(), DbError> { panic!("boom") })
            .await
            .unwrap_err();
        assert_eq!(panicked.kind(), ProblemKind::Internal);
        assert_eq!(state.limits(), Limits::default());
        assert_eq!(state.auth(), &settings());
    }

    #[tokio::test]
    async fn db_outcome_keeps_the_database_error() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("s.sqlite3")).unwrap());
        let state = AppState::new(
            db,
            Arc::new(MatrixPolicy),
            Arc::new(SystemClock),
            Limits::default(),
            settings(),
        );
        let outcome = state
            .db_outcome(|_db| Err::<(), _>(DbError::Poisoned))
            .await
            .unwrap();
        assert!(matches!(outcome, Err(DbError::Poisoned)));
        assert_eq!(state.db_outcome(|_db| Ok(3)).await.unwrap().unwrap(), 3);
        let panicked = state
            .db_outcome(|_db| -> Result<(), DbError> { panic!("boom") })
            .await
            .unwrap_err();
        assert_eq!(panicked.kind(), ProblemKind::Internal);
        // The denial audit starts empty and admits a rule once per interval.
        let key = (1_i64, None, "insufficient_role");
        assert!(state.denial_audit().admit(key));
        assert!(!state.denial_audit().admit(key));
        assert!(
            state
                .denial_audit()
                .admit((2_i64, None, "insufficient_role"))
        );
    }
}
