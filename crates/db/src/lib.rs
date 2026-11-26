//! The SQLite database of stuffcloud (SPEC 9, ADR 0001 addendum "SQLite driver").
//!
//! - [`Database::open`] opens (or creates) the database file in WAL mode with foreign keys
//!   on, a busy timeout and `trusted_schema` off, and checks that WAL is really active.
//! - [`migrate`] holds the versioned migrations and their runner.
//! - [`store`] is the resource store behind the API conventions of ADR 0010 (idempotent
//!   create-or-replace, strong entity tags, preconditions, dry runs, audit rows) and the
//!   one-time bootstrap.
//! - [`auth`] holds accounts and sessions (A-02): hashed session and CSRF tokens, timeouts,
//!   rotation, logout, the session cap, and the security events of the audit log.
//! - [`accounts`] holds local accounts (A-03): passwords, registration, invitations and
//!   password reset tokens.
//!
//! The crate is synchronous (`rusqlite`). One connection is shared behind a mutex: SQLite
//! has a single writer anyway, and the `app` crate calls every method from
//! `tokio::task::spawn_blocking`, never on an async worker. The crate reads no clock: every
//! write takes the time as an argument, which keeps it deterministic under test.

pub mod accounts;
pub mod auth;
pub mod migrate;
pub mod store;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

pub use accounts::{
    Invitation, InvitationOutcome, MAX_MAILED_PER_HOUR, MailedReset, NewAccount, PasswordRecord,
    Profile, Registration, ResetIssue,
};
pub use auth::{
    NewSession, RoleChange, Session, SessionLookup, TOUCH_INTERVAL_MS, TokenHash, User, token_hash,
};
pub use migrate::{MIGRATIONS, Migration, MigrationReport};
pub use store::{
    AuditEntry, BootstrapOutcome, Change, DeleteOutcome, Preconditions, PutOutcome, Stored,
    WriteContext, Written,
};

/// How long a statement waits for a lock held by another connection (for example `edge`)
/// before it fails with "database is locked".
pub const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Everything that can go wrong in this crate.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum DbError {
    /// An error reported by SQLite.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The journal mode could not be switched to WAL (for example on a file system without
    /// shared memory support).
    #[error("the journal mode is {0:?}, expected \"wal\"")]
    NotWal(String),
    /// The compiled migration list is not numbered 1, 2, 3, ….
    #[error("migration list is not numbered 1, 2, 3, …: position {position} has version {found}")]
    InvalidMigrationList {
        /// Expected version at this position.
        position: u32,
        /// Version found there.
        found: u32,
    },
    /// An applied migration was edited afterwards.
    #[error("migration {version} was changed after it was applied (checksum mismatch)")]
    ChecksumMismatch {
        /// The edited migration.
        version: u32,
    },
    /// The database was migrated by a newer build.
    #[error(
        "the database has schema version {found}, this build knows only up to {known} (downgrades are not supported)"
    )]
    SchemaTooNew {
        /// Highest version recorded in the database.
        found: u32,
        /// Highest version this build knows.
        known: u32,
    },
    /// A migration failed and was rolled back.
    #[error("migration {version} ({name}) failed: {source}")]
    MigrationFailed {
        /// The failing migration.
        version: u32,
        /// Its name.
        name: &'static str,
        /// What SQLite reported.
        source: rusqlite::Error,
    },
    /// The schema is older than this build expects ([`Database::check_schema`]).
    #[error("the database has schema version {found}, this build needs {expected}")]
    SchemaOutdated {
        /// Version found.
        found: u32,
        /// Version expected.
        expected: u32,
    },
    /// No account has this id.
    #[error("there is no account with id {0}")]
    UnknownUser(i64),
    /// A service account cannot have a browser session (SPEC 10.4).
    #[error("account {0} is a service account and cannot log in interactively")]
    NoInteractiveLogin(i64),
    /// A stored value is impossible for this build (the file was edited by hand).
    #[error("the database holds an invalid value: {0}")]
    Corrupt(&'static str),
    /// A thread panicked while it held the connection.
    #[error("the database connection is unusable after a panic")]
    Poisoned,
}

/// Switches the connection to WAL and checks that SQLite really did.
fn enable_wal(conn: &Connection) -> Result<(), DbError> {
    let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    if mode.eq_ignore_ascii_case("wal") {
        Ok(())
    } else {
        Err(DbError::NotWal(mode))
    }
}

/// The database: one connection behind a mutex.
#[derive(Debug)]
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Opens or creates the database file at `path` and configures the connection.
    /// Does not migrate; call [`Database::migrate`] next.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] when the file cannot be opened, [`DbError::NotWal`] when WAL
    /// cannot be enabled.
    pub fn open(path: &Path) -> Result<Self, DbError> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                .union(OpenFlags::SQLITE_OPEN_CREATE)
                .union(OpenFlags::SQLITE_OPEN_NO_MUTEX),
        )?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        enable_wal(&conn)?;
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;
             PRAGMA trusted_schema = OFF;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Locks the connection.
    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, Connection>, DbError> {
        self.conn.lock().map_err(|_poisoned| DbError::Poisoned)
    }

    /// Applies the pending migrations of this build ([`MIGRATIONS`]).
    ///
    /// # Errors
    ///
    /// See [`migrate::migrate`].
    pub fn migrate(&self) -> Result<MigrationReport, DbError> {
        migrate::migrate(&mut *self.lock()?, MIGRATIONS)
    }

    /// Readiness probe: the connection answers and the schema is the one this build needs.
    ///
    /// # Errors
    ///
    /// [`DbError::SchemaOutdated`] or [`DbError::Sqlite`].
    pub fn check_schema(&self) -> Result<(), DbError> {
        let found = migrate::current_version(&*self.lock()?)?;
        let expected = u32::try_from(MIGRATIONS.len()).unwrap_or(u32::MAX);
        if found == expected {
            Ok(())
        } else {
            Err(DbError::SchemaOutdated { found, expected })
        }
    }

    /// The journal mode, as SQLite reports it (`"wal"` after [`Database::open`]).
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`].
    pub fn journal_mode(&self) -> Result<String, DbError> {
        Ok(self
            .lock()?
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_in_wal_mode_and_migrates() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite3")).unwrap();
        assert_eq!(db.journal_mode().unwrap(), "wal");
        assert!(matches!(
            db.check_schema(),
            Err(DbError::SchemaOutdated {
                found: 0,
                expected: 3
            })
        ));
        assert_eq!(db.migrate().unwrap().applied, vec![1, 2, 3]);
        db.check_schema().unwrap();
        assert_eq!(db.migrate().unwrap().applied, Vec::<u32>::new());
        let conn = db.lock().unwrap();
        let foreign_keys: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
        let trusted: i64 = conn
            .query_row("PRAGMA trusted_schema", [], |row| row.get(0))
            .unwrap();
        assert_eq!(trusted, 0);
        let synchronous: i64 = conn
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        assert_eq!(synchronous, 1, "NORMAL");
    }

    #[test]
    fn reopening_keeps_the_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            let _ = db.migrate().unwrap();
        }
        let db = Database::open(&path).unwrap();
        db.check_schema().unwrap();
    }

    #[test]
    fn fails_for_a_path_that_cannot_be_created() {
        let dir = tempfile::tempdir().unwrap();
        let error = Database::open(&dir.path().join("missing").join("x.sqlite3")).unwrap_err();
        assert!(matches!(error, DbError::Sqlite(_)), "{error:?}");
        assert!(error.to_string().starts_with("sqlite: "));
    }

    #[test]
    fn a_poisoned_lock_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let db = std::sync::Arc::new(Database::open(&dir.path().join("p.sqlite3")).unwrap());
        let clone = std::sync::Arc::clone(&db);
        let _ = std::thread::spawn(move || {
            let _guard = clone.lock().unwrap();
            panic!("poison the lock");
        })
        .join();
        assert!(matches!(db.migrate(), Err(DbError::Poisoned)));
        assert_eq!(
            DbError::Poisoned.to_string(),
            "the database connection is unusable after a panic"
        );
    }

    #[test]
    fn wal_is_checked() {
        // An in-memory database cannot use WAL: SQLite keeps "memory".
        let conn = Connection::open_in_memory().unwrap();
        match enable_wal(&conn) {
            Err(DbError::NotWal(mode)) => assert_eq!(mode, "memory"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn error_messages() {
        assert_eq!(
            DbError::UnknownUser(4).to_string(),
            "there is no account with id 4"
        );
        assert_eq!(
            DbError::NoInteractiveLogin(5).to_string(),
            "account 5 is a service account and cannot log in interactively"
        );
        assert_eq!(
            DbError::Corrupt("unknown role").to_string(),
            "the database holds an invalid value: unknown role"
        );
        assert_eq!(
            DbError::NotWal("delete".to_owned()).to_string(),
            "the journal mode is \"delete\", expected \"wal\""
        );
        assert_eq!(
            DbError::SchemaOutdated {
                found: 0,
                expected: 1
            }
            .to_string(),
            "the database has schema version 0, this build needs 1"
        );
    }
}
