//! Shared state of the handlers: database, access policy, clock, metrics, limits.

use std::fmt;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::request::Parts;
use stuffcloud_db::{Database, DbError};

use crate::config::Limits;
use crate::metrics::Metrics;
use crate::problem::{Problem, ProblemKind};

/// What a request wants to do with a resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Read it.
    Read,
    /// Change it (including dry runs, which authorise exactly like the real write).
    Write,
}

/// Decides whether a request may access a resource kind. The central authorisation of A-07
/// (#37) implements this trait; until then [`ReadOnlyPolicy`] is the only production policy.
pub trait AccessPolicy: Send + Sync + fmt::Debug {
    /// `Ok` when allowed, otherwise the problem to answer with.
    ///
    /// # Errors
    ///
    /// The problem to send, typically 401 or 403.
    fn authorize(&self, request: &Parts, access: Access, kind: &str) -> Result<(), Problem>;
}

/// The policy of this version: reads are allowed (the API is LAN-only and holds no secret,
/// ADR 0010 decision 4), writes need authentication, which arrives with accounts (A-02,
/// #32). Configuration is applied through the bootstrap file until then.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReadOnlyPolicy;

impl AccessPolicy for ReadOnlyPolicy {
    fn authorize(&self, _request: &Parts, access: Access, _kind: &str) -> Result<(), Problem> {
        match access {
            Access::Read => Ok(()),
            Access::Write => Err(Problem::with_detail(
                ProblemKind::Unauthenticated,
                "writes need an authenticated account, which this version does not support yet; use the bootstrap configuration file (STUFFCLOUD_BOOTSTRAP_CONFIG)",
            )),
        }
    }
}

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
}

impl AppState {
    /// Builds the state.
    #[must_use]
    pub fn new(
        db: Arc<Database>,
        policy: Arc<dyn AccessPolicy>,
        clock: Arc<dyn Clock>,
        limits: Limits,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                db,
                policy,
                clock,
                metrics: Metrics::new(),
                limits,
            }),
        }
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
        let db = Arc::clone(&self.inner.db);
        match tokio::task::spawn_blocking(move || operation(&db)).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(Problem::internal(&error)),
            Err(join_error) => Err(Problem::internal(&join_error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::Request;

    use super::*;

    #[test]
    fn read_only_policy() {
        let (parts, ()) = Request::new(()).into_parts();
        assert!(ReadOnlyPolicy.authorize(&parts, Access::Read, "x").is_ok());
        let problem = ReadOnlyPolicy
            .authorize(&parts, Access::Write, "x")
            .unwrap_err();
        assert_eq!(problem.kind(), ProblemKind::Unauthenticated);
        assert!(
            problem
                .body()
                .detail
                .unwrap()
                .contains("STUFFCLOUD_BOOTSTRAP_CONFIG")
        );
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
            Arc::new(ReadOnlyPolicy),
            Arc::new(SystemClock),
            Limits::default(),
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
    }
}
