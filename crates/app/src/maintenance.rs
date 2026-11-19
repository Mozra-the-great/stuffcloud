//! Periodic housekeeping (A-03): expired sessions, invitations and reset tokens are deleted
//! every [`PURGE_INTERVAL`], not only when a login or a lookup happens to see them, so the
//! tables do not grow with sessions nobody returns to.

use std::time::Duration;

use tokio::task::JoinHandle;

use crate::state::AppState;

/// How often the purge runs.
pub const PURGE_INTERVAL: Duration = Duration::from_mins(10);

/// One purge: expired sessions (one audit row each) and expired tokens. Returns how many rows
/// went; a failure is logged and the next run tries again.
pub async fn purge_once(state: &AppState) -> usize {
    let timeouts = state.auth().timeouts;
    let now = state.now_millis();
    let purged = state
        .db(move |db| {
            let sessions = db.purge_expired_sessions(&timeouts, now)?;
            let tokens = db.purge_expired_tokens(now)?;
            Ok(sessions.saturating_add(tokens))
        })
        .await
        .unwrap_or(0);
    if purged > 0 {
        tracing::info!(target: "stuffcloud::maintenance", purged, "expired sessions and tokens purged");
    }
    purged
}

/// Runs [`purge_once`] every `period` (the first run after one period) until the task is
/// aborted or the runtime stops.
#[must_use]
pub fn spawn_purger(state: AppState, period: Duration) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval(period);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let _immediate = ticks.tick().await;
        loop {
            let _tick = ticks.tick().await;
            let _purged = purge_once(&state).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use stuffcloud_core::session::{Role, UserKind};
    use stuffcloud_core::token::Token;
    use stuffcloud_db::{NewSession, token_hash};

    use super::*;

    fn expired_session(state: &AppState) -> i64 {
        let db_user = state_db(state)
            .create_user("alice", UserKind::Person, Role::User, None, 0)
            .unwrap();
        let _ = state_db(state)
            .create_session(
                &NewSession {
                    user_id: db_user.id,
                    token_hash: token_hash(&Token::from_bytes([1; 32])),
                    csrf_hash: token_hash(&Token::from_bytes([2; 32])),
                    replaces: None,
                    max_per_user: None,
                },
                &state.auth().timeouts,
                0,
            )
            .unwrap();
        db_user.id
    }

    fn state_db(state: &AppState) -> std::sync::Arc<stuffcloud_db::Database> {
        state.database()
    }

    #[tokio::test]
    async fn a_purge_deletes_expired_sessions_and_tokens() {
        let state = crate::state::tests::state();
        let user = expired_session(&state);
        let admin = state_db(&state)
            .create_user("admin", UserKind::Person, Role::Admin, None, 0)
            .unwrap();
        let _ = state_db(&state)
            .create_invitation(
                &token_hash(&Token::from_bytes([3; 32])),
                None,
                admin.id,
                1,
                0,
            )
            .unwrap();
        assert_eq!(purge_once(&state).await, 2);
        assert_eq!(state_db(&state).session_count(user).unwrap(), 0);
        assert_eq!(purge_once(&state).await, 0);
    }

    /// A log writer that keeps what it is given.
    #[derive(Clone, Default)]
    struct Buffer(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for Buffer {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'w> tracing_subscriber::fmt::MakeWriter<'w> for Buffer {
        type Writer = Self;

        fn make_writer(&'w self) -> Self::Writer {
            self.clone()
        }
    }

    impl Buffer {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    #[tokio::test]
    async fn a_purge_is_logged_only_when_it_removed_something() {
        let buffer = Buffer::default();
        let _guard = tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .with_writer(buffer.clone())
                .with_ansi(false)
                .finish(),
        );
        let state = crate::state::tests::state();
        // Nothing to purge: no line.
        assert_eq!(purge_once(&state).await, 0);
        assert_eq!(buffer.text(), "");
        // Something to purge: one line that names the number.
        let _ = expired_session(&state);
        assert_eq!(purge_once(&state).await, 1);
        let text = buffer.text();
        assert_eq!(
            text.matches("expired sessions and tokens purged").count(),
            1,
            "{text}"
        );
        assert!(text.contains("purged=1"), "{text}");
        // Nothing left again: still the one line.
        assert_eq!(purge_once(&state).await, 0);
        assert_eq!(
            buffer
                .text()
                .matches("expired sessions and tokens purged")
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn the_purger_runs_periodically() {
        let state = crate::state::tests::state();
        let user = expired_session(&state);
        let task = spawn_purger(state.clone(), Duration::from_millis(20));
        let mut waited = 0;
        while state_db(&state).session_count(user).unwrap() > 0 {
            assert!(waited < 500, "the purger did not run");
            tokio::time::sleep(Duration::from_millis(10)).await;
            waited += 1;
        }
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
    }
}
