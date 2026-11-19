//! Shared state of the handlers: database, access policy, clock, metrics, limits and the
//! authentication settings.

use std::fmt;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::request::Parts;
use stuffcloud_core::session::Role;
use stuffcloud_db::{Database, DbError};

use crate::auth::{AuthSettings, Authentication};
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
/// (#37) implements this trait with the permission matrix; until then [`AdminWritePolicy`] is
/// the production policy.
pub trait AccessPolicy: Send + Sync + fmt::Debug {
    /// `Ok` when allowed, otherwise the problem to answer with. The request's
    /// [`Authentication`] is in its extensions.
    ///
    /// # Errors
    ///
    /// The problem to send, typically 401 or 403.
    fn authorize(&self, request: &Parts, access: Access, kind: &str) -> Result<(), Problem>;
}

/// The policy of this version: reads are allowed (the API is LAN-only and holds no secret,
/// ADR 0010 decision 4); writes need a session of an admin. Until accounts can log in (A-03,
/// #33) configuration is applied through the bootstrap file.
#[derive(Debug, Clone, Copy, Default)]
pub struct AdminWritePolicy;

impl AccessPolicy for AdminWritePolicy {
    fn authorize(&self, request: &Parts, access: Access, _kind: &str) -> Result<(), Problem> {
        if access == Access::Read {
            return Ok(());
        }
        match Authentication::of(request).session() {
            None => Err(Problem::with_detail(
                ProblemKind::Unauthenticated,
                "writes need the session of an admin; until accounts can log in, use the bootstrap configuration file (STUFFCLOUD_BOOTSTRAP_CONFIG)",
            )),
            Some(session) if session.user.role == Role::Admin => Ok(()),
            Some(_) => Err(Problem::with_detail(
                ProblemKind::Forbidden,
                "only an admin may change this",
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
    auth: AuthSettings,
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
            }),
        }
    }

    /// The authentication settings.
    #[must_use]
    pub fn auth(&self) -> &AuthSettings {
        &self.inner.auth
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

    fn settings() -> AuthSettings {
        AuthSettings {
            app_origin: stuffcloud_core::csrf::Origin::parse(b"https://app.example.com").unwrap(),
            timeouts: stuffcloud_core::session::Timeouts::default(),
        }
    }

    fn with_role(role: Option<Role>) -> Parts {
        let (mut parts, ()) = Request::new(()).into_parts();
        if let Some(role) = role {
            let _previous =
                parts
                    .extensions
                    .insert(Authentication::Session(stuffcloud_db::Session {
                        id: 1,
                        user: stuffcloud_db::User {
                            id: 2,
                            login: "a".to_owned(),
                            kind: stuffcloud_core::session::UserKind::Person,
                            role,
                            created_at: 0,
                        },
                        csrf_hash: [0; 32],
                        created_at: 0,
                        last_seen_at: 0,
                    }));
        }
        parts
    }

    #[test]
    fn admin_write_policy() {
        for role in [
            None,
            Some(Role::User),
            Some(Role::Moderator),
            Some(Role::Admin),
        ] {
            assert!(
                AdminWritePolicy
                    .authorize(&with_role(role), Access::Read, "x")
                    .is_ok()
            );
        }
        let anonymous = AdminWritePolicy
            .authorize(&with_role(None), Access::Write, "x")
            .unwrap_err();
        assert_eq!(anonymous.kind(), ProblemKind::Unauthenticated);
        assert!(
            anonymous
                .body()
                .detail
                .unwrap()
                .contains("STUFFCLOUD_BOOTSTRAP_CONFIG")
        );
        for role in [Role::User, Role::Moderator] {
            let problem = AdminWritePolicy
                .authorize(&with_role(Some(role)), Access::Write, "x")
                .unwrap_err();
            assert_eq!(problem.kind(), ProblemKind::Forbidden);
            assert_eq!(
                problem.body().detail.as_deref(),
                Some("only an admin may change this")
            );
        }
        assert!(
            AdminWritePolicy
                .authorize(&with_role(Some(Role::Admin)), Access::Write, "x")
                .is_ok()
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
            Arc::new(AdminWritePolicy),
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
}
