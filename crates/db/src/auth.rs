//! Accounts and sessions (A-02, ADR 0005 addendum): the storage side of the auth model.
//!
//! - A session is identified by a random token that only the browser holds (in a `__Host-`
//!   cookie); the database stores its SHA-256 hash ([`token_hash`]), so a copy of the
//!   database does not contain a usable session. The same holds for the CSRF token bound to
//!   the session.
//! - Lookups apply the idle and absolute timeouts of the deployment ([`Timeouts`]); an expired
//!   session is deleted on sight, and [`Database::create_session`] purges every expired one.
//! - A new session never reuses a presented one (session fixation): login replaces it
//!   ([`NewSession::replaces`]), [`Database::rotate_session`] gives an existing session a new
//!   token, and a role change ends every session of the account ([`Database::set_role`]).
//! - Every security event is a row in the audit log with category `security`. Rows hold
//!   internal ids only (`user:<id>` as the actor, the session id as the key): no login name,
//!   e-mail address, token, hash or IP address.
//!
//! As in the rest of the crate, every write takes the time as an argument.

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use stuffcloud_core::session::{Role, SessionAge, Timeouts, UserKind};
use stuffcloud_core::token::Token;

use crate::{Database, DbError};

/// SHA-256 of a token, the only form in which tokens are stored.
pub type TokenHash = [u8; 32];

/// A session's `last_seen_at` is written at most this often (milliseconds), so a busy client
/// does not turn every request into a database write. The idle timeout is therefore exact to
/// within this interval.
pub const TOUCH_INTERVAL_MS: i64 = 60_000;

/// Audit kind of user rows.
pub const USER_KIND: &str = "user";
/// Audit kind of session rows.
pub const SESSION_KIND: &str = "session";
/// Audit action of an authenticated request that the access policy refused (A-07). The row's
/// kind is the permission area (`admin:settings`), its key the level and the rule that refused
/// it (`write:insufficient_role`).
pub const ACCESS_DENIED: &str = "access.denied";
/// Audit action of an interactive login that was refused because the account is a service
/// account (A-07). The row's kind is `user`, its key the internal id.
pub const LOGIN_REFUSED: &str = "login.refused";

/// The hash under which a token is stored.
#[must_use]
pub fn token_hash(token: &Token) -> TokenHash {
    Sha256::digest(token.as_bytes()).into()
}

/// The audit actor for an account: its internal id, never its login name.
#[must_use]
pub fn actor(user_id: i64) -> String {
    format!("user:{user_id}")
}

/// An account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    /// Internal id.
    pub id: i64,
    /// Login name (the natural key).
    pub login: String,
    /// Person or service account.
    pub kind: UserKind,
    /// Role.
    pub role: Role,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// A valid session with its account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    /// Internal id (in audit rows; never the token).
    pub id: i64,
    /// The account.
    pub user: User,
    /// Hash of the CSRF token bound to the session.
    pub csrf_hash: TokenHash,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds of the last recorded use.
    pub last_seen_at: i64,
}

/// Result of [`Database::find_session`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionLookup {
    /// The session is valid (its use was recorded).
    Active(Session),
    /// The session existed but had expired; it is deleted now.
    Expired(SessionAge),
    /// No session has this token.
    Unknown,
}

/// What [`Database::create_session`] stores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSession {
    /// The account that logged in.
    pub user_id: i64,
    /// Hash of the new session token.
    pub token_hash: TokenHash,
    /// Hash of the new CSRF token.
    pub csrf_hash: TokenHash,
    /// The session the request presented, if any: it is ended, so a login never keeps a
    /// session id that existed before it (session fixation).
    pub replaces: Option<i64>,
    /// The most sessions the account may hold (A-03): when the new one exceeds it, the oldest
    /// sessions of the account end (`session.evicted`). `None` only in tests.
    pub max_per_user: Option<usize>,
}

/// Result of [`Database::set_role`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoleChange {
    /// The role before.
    pub previous: Role,
    /// Sessions ended because the role changed (0 when it did not).
    pub ended_sessions: usize,
}

/// The columns [`Database::find_session`] reads: the session and its account.
type SessionRow = (i64, Vec<u8>, i64, i64, i64, String, String, String, i64);

/// Adds a security event to the audit log.
pub(crate) fn audit(
    conn: &Connection,
    now: i64,
    actor: Option<&str>,
    action: &str,
    kind: &str,
    key: &str,
) -> Result<(), DbError> {
    let _rows = conn.execute(
        "INSERT INTO audit_log (at, actor, action, kind, key, category)
         VALUES (?1, ?2, ?3, ?4, ?5, 'security')",
        params![now, actor, action, kind, key],
    )?;
    Ok(())
}

/// Converts a stored hash; the table's CHECK constraint makes a wrong length impossible
/// unless the file was edited by hand.
fn hash_from(bytes: &[u8]) -> Result<TokenHash, DbError> {
    TokenHash::try_from(bytes).map_err(|_wrong| DbError::Corrupt("a stored hash is not 32 bytes"))
}

/// Builds a [`User`] from stored columns.
pub(crate) fn user_from(
    id: i64,
    login: String,
    kind: &str,
    role: &str,
    created_at: i64,
) -> Result<User, DbError> {
    Ok(User {
        id,
        login,
        kind: UserKind::parse(kind).map_err(|_unknown| DbError::Corrupt("unknown account kind"))?,
        role: Role::parse(role).map_err(|_unknown| DbError::Corrupt("unknown role"))?,
        created_at,
    })
}

/// Reads an account.
pub(crate) fn read_user(conn: &Connection, id: i64) -> Result<Option<User>, DbError> {
    let row: Option<(i64, String, String, String, i64)> = conn
        .query_row(
            "SELECT id, login, kind, role, created_at FROM users WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    row.map(|(id, login, kind, role, created_at)| user_from(id, login, &kind, &role, created_at))
        .transpose()
}

/// Reads a session and its account by the hash of its token.
fn read_session_row(conn: &Connection, hash: &TokenHash) -> Result<Option<SessionRow>, DbError> {
    Ok(conn
        .query_row(
            "SELECT s.id, s.csrf_hash, s.created_at, s.last_seen_at,
                    u.id, u.login, u.kind, u.role, u.created_at
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1",
            [&hash[..]],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .optional()?)
}

/// Whether a session's use is due to be recorded at `now`.
const fn touch_due(last_seen_at: i64, now: i64) -> bool {
    now.saturating_sub(last_seen_at) >= TOUCH_INTERVAL_MS
}

/// Whether a lookup of this session has to write: an expired session is deleted, a session
/// whose last recorded use is [`TOUCH_INTERVAL_MS`] old is touched.
fn session_needs_write(row: &SessionRow, timeouts: &Timeouts, now: i64) -> bool {
    let (_id, _csrf, created_at, last_seen_at, ..) = row;
    if !timeouts
        .evaluate(*created_at, *last_seen_at, now)
        .is_active()
    {
        return true;
    }
    touch_due(*last_seen_at, now)
}

/// The session of a stored row.
fn session_from(row: SessionRow) -> Result<Session, DbError> {
    let (id, csrf, created_at, last_seen_at, user_id, login, kind, role, user_created) = row;
    Ok(Session {
        id,
        user: user_from(user_id, login, &kind, &role, user_created)?,
        csrf_hash: hash_from(&csrf)?,
        created_at,
        last_seen_at,
    })
}

/// The write half of [`Database::find_session`]: in a write transaction, looks the session up
/// again (it may have ended since the read) and deletes it when it has expired or records its
/// use when that is due.
fn settle_session(
    conn: &mut Connection,
    hash: &TokenHash,
    timeouts: &Timeouts,
    now: i64,
) -> Result<SessionLookup, DbError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(row) = read_session_row(&tx, hash)? else {
        return Ok(SessionLookup::Unknown);
    };
    let (id, _csrf, created_at, last_seen_at, ..) = &row;
    let (id, created_at, last_seen_at) = (*id, *created_at, *last_seen_at);
    let age = timeouts.evaluate(created_at, last_seen_at, now);
    if !age.is_active() {
        let _rows = tx.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
        audit(
            &tx,
            now,
            None,
            "session.expired",
            SESSION_KIND,
            &id.to_string(),
        )?;
        tx.commit()?;
        return Ok(SessionLookup::Expired(age));
    }
    let mut session = session_from(row)?;
    if touch_due(last_seen_at, now) {
        let _rows = tx.execute(
            "UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        session.last_seen_at = now;
    }
    tx.commit()?;
    Ok(SessionLookup::Active(session))
}

/// Deletes the sessions that have expired at `now`, one audit row each.
fn purge_expired(conn: &Connection, timeouts: &Timeouts, now: i64) -> Result<usize, DbError> {
    let expired: Vec<i64> = {
        let mut statement = conn.prepare(
            "SELECT id FROM sessions WHERE created_at <= ?1 OR last_seen_at <= ?2 ORDER BY id",
        )?;
        let rows = statement.query_map(
            params![
                now.saturating_sub(timeouts.absolute_ms),
                now.saturating_sub(timeouts.idle_ms)
            ],
            |row| row.get(0),
        )?;
        rows.collect::<Result<_, _>>()?
    };
    for id in &expired {
        let _rows = conn.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
        audit(
            conn,
            now,
            None,
            "session.expired",
            SESSION_KIND,
            &id.to_string(),
        )?;
    }
    Ok(expired.len())
}

/// Ends the oldest sessions of an account beyond the newest `keep` (the session cap of A-03),
/// one `session.evicted` row each; returns how many.
fn evict_oldest(
    conn: &Connection,
    user_id: i64,
    keep: usize,
    actor: &str,
    now: i64,
) -> Result<usize, DbError> {
    let keep = i64::try_from(keep).unwrap_or(i64::MAX);
    let evicted: Vec<i64> = {
        let mut statement = conn.prepare(
            "SELECT id FROM sessions WHERE user_id = ?1
             ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?2",
        )?;
        let rows = statement.query_map(params![user_id, keep], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for id in &evicted {
        let _rows = conn.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
        audit(
            conn,
            now,
            Some(actor),
            "session.evicted",
            SESSION_KIND,
            &id.to_string(),
        )?;
    }
    Ok(evicted.len())
}

/// Ends every session of an account; returns how many.
pub(crate) fn end_all(
    tx: &Transaction<'_>,
    user_id: i64,
    actor: Option<&str>,
    action: &str,
    now: i64,
) -> Result<usize, DbError> {
    let ended = tx.execute("DELETE FROM sessions WHERE user_id = ?1", [user_id])?;
    if ended > 0 {
        audit(tx, now, actor, action, USER_KIND, &user_id.to_string())?;
    }
    Ok(ended)
}

impl Database {
    /// Creates an account. The login rules and the flows that call this arrive with A-03
    /// (#33); the database only enforces that the login is unique.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] (for example a login that exists) or [`DbError::Poisoned`].
    pub fn create_user(
        &self,
        login: &str,
        kind: UserKind,
        role: Role,
        actor: Option<&str>,
        now: i64,
    ) -> Result<User, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let _rows = tx.execute(
            "INSERT INTO users (login, kind, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![login, kind.as_str(), role.as_str(), now],
        )?;
        let id = tx.last_insert_rowid();
        audit(&tx, now, actor, "user.created", USER_KIND, &id.to_string())?;
        tx.commit()?;
        Ok(User {
            id,
            login: login.to_owned(),
            kind,
            role,
            created_at: now,
        })
    }

    /// Reads an account.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`], [`DbError::Corrupt`] or [`DbError::Poisoned`].
    pub fn user(&self, id: i64) -> Result<Option<User>, DbError> {
        read_user(&*self.lock()?, id)
    }

    /// Changes the role of an account. A change of privilege ends every session of the
    /// account, so a session never carries a role it was not created with; the account logs
    /// in again. Setting the same role changes nothing and writes no audit row.
    ///
    /// # Errors
    ///
    /// [`DbError::UnknownUser`], [`DbError::Sqlite`], [`DbError::Corrupt`] or
    /// [`DbError::Poisoned`].
    pub fn set_role(
        &self,
        user_id: i64,
        role: Role,
        actor: Option<&str>,
        now: i64,
    ) -> Result<RoleChange, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let user = read_user(&tx, user_id)?.ok_or(DbError::UnknownUser(user_id))?;
        if user.role == role {
            return Ok(RoleChange {
                previous: role,
                ended_sessions: 0,
            });
        }
        let _rows = tx.execute(
            "UPDATE users SET role = ?1, updated_at = ?2 WHERE id = ?3",
            params![role.as_str(), now, user_id],
        )?;
        audit(
            &tx,
            now,
            actor,
            "user.role_changed",
            USER_KIND,
            &user_id.to_string(),
        )?;
        let ended_sessions = end_all(&tx, user_id, actor, "session.ended_by_role_change", now)?;
        tx.commit()?;
        Ok(RoleChange {
            previous: user.role,
            ended_sessions,
        })
    }

    /// Stores a new session after a successful login and ends the session the request
    /// presented ([`NewSession::replaces`]). Expired sessions of every account are purged on
    /// the way, and the oldest sessions of the account beyond [`NewSession::max_per_user`] end.
    ///
    /// # Errors
    ///
    /// [`DbError::UnknownUser`], [`DbError::NoInteractiveLogin`] for a service account,
    /// [`DbError::Sqlite`] (for example a token hash that exists), [`DbError::Corrupt`] or
    /// [`DbError::Poisoned`].
    pub fn create_session(
        &self,
        new: &NewSession,
        timeouts: &Timeouts,
        now: i64,
    ) -> Result<Session, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let user = read_user(&tx, new.user_id)?.ok_or(DbError::UnknownUser(new.user_id))?;
        if user.kind != UserKind::Person {
            return Err(DbError::NoInteractiveLogin(user.id));
        }
        let actor = actor(user.id);
        let _purged = purge_expired(&tx, timeouts, now)?;
        if let Some(old) = new.replaces {
            let ended = tx.execute("DELETE FROM sessions WHERE id = ?1", [old])?;
            if ended > 0 {
                audit(
                    &tx,
                    now,
                    Some(&actor),
                    "session.replaced",
                    SESSION_KIND,
                    &old.to_string(),
                )?;
            }
        }
        let _rows = tx.execute(
            "INSERT INTO sessions (token_hash, csrf_hash, user_id, created_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![&new.token_hash[..], &new.csrf_hash[..], user.id, now],
        )?;
        let id = tx.last_insert_rowid();
        audit(
            &tx,
            now,
            Some(&actor),
            "session.created",
            SESSION_KIND,
            &id.to_string(),
        )?;
        if let Some(max) = new.max_per_user {
            let _evicted = evict_oldest(&tx, user.id, max, &actor, now)?;
        }
        tx.commit()?;
        Ok(Session {
            id,
            user,
            csrf_hash: new.csrf_hash,
            created_at: now,
            last_seen_at: now,
        })
    }

    /// Looks up the session of a token hash at `now`. A valid session's use is recorded
    /// (at most every [`TOUCH_INTERVAL_MS`]); an expired one is deleted and audited.
    ///
    /// The lookup is a read-only (deferred) transaction first: an unknown token and a valid
    /// session that needs no touch never take the write lock, so a client that sends random
    /// cookies cannot queue up writers (also those of another process, such as `edge`). Only
    /// a touch or a deletion opens a write transaction, which looks the row up again.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`], [`DbError::Corrupt`] or [`DbError::Poisoned`].
    pub fn find_session(
        &self,
        hash: &TokenHash,
        timeouts: &Timeouts,
        now: i64,
    ) -> Result<SessionLookup, DbError> {
        let mut conn = self.lock()?;
        let peeked = {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Deferred)?;
            let row = read_session_row(&tx, hash)?;
            tx.commit()?;
            row
        };
        let Some(row) = peeked else {
            return Ok(SessionLookup::Unknown);
        };
        if !session_needs_write(&row, timeouts, now) {
            return Ok(SessionLookup::Active(session_from(row)?));
        }
        settle_session(&mut conn, hash, timeouts, now)
    }

    /// Gives a session a new token and a new CSRF token, keeping its account and its age
    /// (the absolute timeout still counts from the login). Used when the privilege of the
    /// session changes (a second factor, A-05). `false` when the session does not exist.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn rotate_session(
        &self,
        session_id: i64,
        token_hash: &TokenHash,
        csrf_hash: &TokenHash,
        now: i64,
    ) -> Result<bool, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let user_id: Option<i64> = tx
            .query_row(
                "SELECT user_id FROM sessions WHERE id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(user_id) = user_id else {
            return Ok(false);
        };
        let _rows = tx.execute(
            "UPDATE sessions SET token_hash = ?1, csrf_hash = ?2, last_seen_at = ?3 WHERE id = ?4",
            params![&token_hash[..], &csrf_hash[..], now, session_id],
        )?;
        audit(
            &tx,
            now,
            Some(&actor(user_id)),
            "session.rotated",
            SESSION_KIND,
            &session_id.to_string(),
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Binds a new CSRF token to a session (when the browser lost its CSRF cookie). Not a
    /// security event: the session token is unchanged. `false` when the session does not
    /// exist.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn set_session_csrf(
        &self,
        session_id: i64,
        csrf_hash: &TokenHash,
    ) -> Result<bool, DbError> {
        let changed = self.lock()?.execute(
            "UPDATE sessions SET csrf_hash = ?1 WHERE id = ?2",
            params![&csrf_hash[..], session_id],
        )?;
        Ok(changed > 0)
    }

    /// Ends one session (logout). `false` when it does not exist.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn end_session(&self, session_id: i64, now: i64) -> Result<bool, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let user_id: Option<i64> = tx
            .query_row(
                "SELECT user_id FROM sessions WHERE id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(user_id) = user_id else {
            return Ok(false);
        };
        let _rows = tx.execute("DELETE FROM sessions WHERE id = ?1", [session_id])?;
        audit(
            &tx,
            now,
            Some(&actor(user_id)),
            "session.ended",
            SESSION_KIND,
            &session_id.to_string(),
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Ends every session of an account (logout everywhere); returns how many.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn end_user_sessions(
        &self,
        user_id: i64,
        actor: Option<&str>,
        now: i64,
    ) -> Result<usize, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let ended = end_all(&tx, user_id, actor, "session.ended_all", now)?;
        tx.commit()?;
        Ok(ended)
    }

    /// Deletes every session that has expired at `now` (run at startup; logins do it too).
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn purge_expired_sessions(&self, timeouts: &Timeouts, now: i64) -> Result<usize, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let purged = purge_expired(&tx, timeouts, now)?;
        tx.commit()?;
        Ok(purged)
    }

    /// Adds one security event to the audit log (a refused request or login). Like every
    /// security row it holds internal ids only: `actor` is `user:<id>`, `kind` and `key` are
    /// rule names or ids, never a login name, address or token.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn record_security_event(
        &self,
        actor: Option<&str>,
        action: &str,
        kind: &str,
        key: &str,
        now: i64,
    ) -> Result<(), DbError> {
        let conn = self.lock()?;
        audit(&conn, now, actor, action, kind, key)
    }

    /// The number of stored sessions of an account (all, expired ones included until they
    /// are purged).
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn session_count(&self, user_id: i64) -> Result<usize, DbError> {
        let count: i64 = self.lock()?.query_row(
            "SELECT COUNT(*) FROM sessions WHERE user_id = ?1",
            [user_id],
            |row| row.get(0),
        )?;
        usize::try_from(count).map_err(|_negative| DbError::Corrupt("negative count"))
    }
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
