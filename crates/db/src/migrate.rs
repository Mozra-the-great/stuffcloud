//! Versioned schema migrations.
//!
//! Migrations are SQL files compiled into the binary ([`MIGRATIONS`]), numbered from 1 without
//! gaps. The runner records each applied migration with a SHA-256 checksum of its SQL in
//! `schema_migrations` and
//!
//! - applies the pending ones in order, each in its own transaction (a failing migration
//!   leaves the database at the previous version);
//! - refuses a database whose recorded checksum differs from the compiled SQL (an applied
//!   migration was edited) and one with a version this build does not know (a newer build
//!   ran against it; downgrades are not supported).

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::DbError;

/// One migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Migration {
    /// Version, starting at 1, consecutive.
    pub version: u32,
    /// Short name for logs.
    pub name: &'static str,
    /// The SQL, run with `execute_batch`.
    pub sql: &'static str,
}

/// The migrations of this build, in order.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial",
        sql: include_str!("../migrations/0001_initial.sql"),
    },
    Migration {
        version: 2,
        name: "auth",
        sql: include_str!("../migrations/0002_auth.sql"),
    },
    Migration {
        version: 3,
        name: "accounts",
        sql: include_str!("../migrations/0003_accounts.sql"),
    },
];

/// What [`migrate`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    /// Versions applied by this run, in order.
    pub applied: Vec<u32>,
    /// Schema version after the run.
    pub version: u32,
}

/// Hex SHA-256 of a migration's SQL.
#[must_use]
pub fn checksum(sql: &str) -> String {
    hex(&Sha256::digest(sql.as_bytes()))
}

/// Lowercase hex of some bytes.
pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        for nibble in [byte >> 4, byte & 0x0f] {
            out.push(char::from(
                *DIGITS.get(usize::from(nibble)).unwrap_or(&b'0'),
            ));
        }
    }
    out
}

/// Checks that the list is numbered 1, 2, 3, … without gaps or repeats.
fn check_list(migrations: &[Migration]) -> Result<(), DbError> {
    for (expected, migration) in (1_u32..).zip(migrations) {
        if migration.version != expected {
            return Err(DbError::InvalidMigrationList {
                position: expected,
                found: migration.version,
            });
        }
    }
    Ok(())
}

/// The highest applied version (0 for a new database).
///
/// # Errors
///
/// [`DbError::Sqlite`] when the table cannot be read.
pub fn current_version(conn: &Connection) -> Result<u32, DbError> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(0);
    }
    let version: Option<u32> =
        conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })?;
    Ok(version.unwrap_or(0))
}

/// Brings the schema up to the last of `migrations`.
///
/// # Errors
///
/// [`DbError::InvalidMigrationList`], [`DbError::ChecksumMismatch`],
/// [`DbError::SchemaTooNew`], [`DbError::MigrationFailed`] or [`DbError::Sqlite`].
pub fn migrate(
    conn: &mut Connection,
    migrations: &[Migration],
) -> Result<MigrationReport, DbError> {
    check_list(migrations)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version     INTEGER PRIMARY KEY,
             name        TEXT    NOT NULL,
             checksum    TEXT    NOT NULL,
             applied_at  INTEGER NOT NULL
         ) STRICT;",
    )?;
    let known = u32::try_from(migrations.len()).unwrap_or(u32::MAX);
    let applied: Vec<(u32, String)> = {
        let mut statement =
            conn.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    for (version, recorded) in &applied {
        let Some(migration) = migrations.iter().find(|m| m.version == *version) else {
            return Err(DbError::SchemaTooNew {
                found: *version,
                known,
            });
        };
        if checksum(migration.sql) != *recorded {
            return Err(DbError::ChecksumMismatch { version: *version });
        }
    }
    let mut report = MigrationReport {
        applied: Vec::new(),
        version: current_version(conn)?,
    };
    let start = report.version;
    for migration in migrations.iter().filter(|m| m.version > start) {
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)
            .map_err(|source| DbError::MigrationFailed {
                version: migration.version,
                name: migration.name,
                source,
            })?;
        let _rows = tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at)
             VALUES (?1, ?2, ?3, unixepoch('subsec') * 1000)",
            params![migration.version, migration.name, checksum(migration.sql)],
        )?;
        tx.commit()?;
        report.applied.push(migration.version);
        report.version = migration.version;
    }
    Ok(report)
}

/// The recorded checksum of one applied version, if any (for tests and diagnostics).
///
/// # Errors
///
/// [`DbError::Sqlite`] when the table cannot be read.
pub fn recorded_checksum(conn: &Connection, version: u32) -> Result<Option<String>, DbError> {
    Ok(conn
        .query_row(
            "SELECT checksum FROM schema_migrations WHERE version = ?1",
            [version],
            |row| row.get(0),
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST: Migration = Migration {
        version: 1,
        name: "first",
        sql: "CREATE TABLE a (x INTEGER) STRICT;",
    };
    const SECOND: Migration = Migration {
        version: 2,
        name: "second",
        sql: "CREATE TABLE b (y INTEGER) STRICT; INSERT INTO a VALUES (1);",
    };
    const BROKEN: Migration = Migration {
        version: 2,
        name: "broken",
        sql: "CREATE TABLE c (z INTEGER) STRICT; THIS IS NOT SQL;",
    };

    fn memory() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    fn tables(conn: &Connection) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn hex_and_checksum() {
        assert_eq!(hex(&[0x00, 0x0f, 0xa5, 0xff]), "000fa5ff");
        assert_eq!(hex(&[]), "");
        assert_eq!(
            checksum(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn applies_everything_on_a_new_database() {
        let mut conn = memory();
        assert_eq!(current_version(&conn).unwrap(), 0);
        let report = migrate(&mut conn, &[FIRST, SECOND]).unwrap();
        assert_eq!(
            report,
            MigrationReport {
                applied: vec![1, 2],
                version: 2
            }
        );
        assert_eq!(tables(&conn), vec!["a", "b", "schema_migrations"]);
        assert_eq!(current_version(&conn).unwrap(), 2);
        assert_eq!(
            recorded_checksum(&conn, 2).unwrap(),
            Some(checksum(SECOND.sql))
        );
        assert_eq!(recorded_checksum(&conn, 3).unwrap(), None);
    }

    #[test]
    fn applies_only_pending_migrations_and_is_idempotent() {
        let mut conn = memory();
        assert_eq!(migrate(&mut conn, &[FIRST]).unwrap().applied, vec![1]);
        let report = migrate(&mut conn, &[FIRST, SECOND]).unwrap();
        assert_eq!(
            report,
            MigrationReport {
                applied: vec![2],
                version: 2
            }
        );
        let again = migrate(&mut conn, &[FIRST, SECOND]).unwrap();
        assert_eq!(
            again,
            MigrationReport {
                applied: vec![],
                version: 2
            }
        );
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM a", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1, "migration 2 ran exactly once");
    }

    #[test]
    fn a_failing_migration_is_rolled_back() {
        let mut conn = memory();
        let error = migrate(&mut conn, &[FIRST, BROKEN]).unwrap_err();
        match &error {
            DbError::MigrationFailed { version, name, .. } => {
                assert_eq!((*version, *name), (2, "broken"));
            }
            other => panic!("{other:?}"),
        }
        assert!(
            error
                .to_string()
                .starts_with("migration 2 (broken) failed: ")
        );
        assert_eq!(current_version(&conn).unwrap(), 1);
        assert_eq!(tables(&conn), vec!["a", "schema_migrations"]);
    }

    #[test]
    fn refuses_an_edited_migration() {
        let mut conn = memory();
        let _ = migrate(&mut conn, &[FIRST]).unwrap();
        let edited = Migration {
            sql: "CREATE TABLE a (x INTEGER, extra TEXT) STRICT;",
            ..FIRST
        };
        let error = migrate(&mut conn, &[edited]).unwrap_err();
        assert!(matches!(error, DbError::ChecksumMismatch { version: 1 }));
        assert_eq!(
            error.to_string(),
            "migration 1 was changed after it was applied (checksum mismatch)"
        );
    }

    #[test]
    fn refuses_a_newer_schema() {
        let mut conn = memory();
        let _ = migrate(&mut conn, &[FIRST, SECOND]).unwrap();
        let error = migrate(&mut conn, &[FIRST]).unwrap_err();
        assert!(matches!(
            error,
            DbError::SchemaTooNew { found: 2, known: 1 }
        ));
        assert_eq!(
            error.to_string(),
            "the database has schema version 2, this build knows only up to 1 (downgrades are not supported)"
        );
    }

    #[test]
    fn refuses_a_list_with_gaps_or_repeats() {
        let mut conn = memory();
        for (list, position, found) in [
            (vec![SECOND], 1, 2),
            (vec![FIRST, FIRST], 2, 1),
            (
                vec![
                    FIRST,
                    Migration {
                        version: 3,
                        ..SECOND
                    },
                ],
                2,
                3,
            ),
        ] {
            let error = migrate(&mut conn, &list).unwrap_err();
            match error {
                DbError::InvalidMigrationList {
                    position: p,
                    found: f,
                } => assert_eq!((p, f), (position, found)),
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(
            DbError::InvalidMigrationList {
                position: 2,
                found: 3
            }
            .to_string(),
            "migration list is not numbered 1, 2, 3, …: position 2 has version 3"
        );
        assert_eq!(tables(&conn), Vec::<String>::new(), "nothing was touched");
    }

    #[test]
    fn the_compiled_migrations_apply_cleanly() {
        let mut conn = memory();
        check_list(MIGRATIONS).unwrap();
        let report = migrate(&mut conn, MIGRATIONS).unwrap();
        assert_eq!(report.version, u32::try_from(MIGRATIONS.len()).unwrap());
        assert_eq!(
            tables(&conn),
            vec![
                "audit_log",
                "credentials",
                "instance_state",
                "invitations",
                "oidc_identities",
                "password_resets",
                "recovery_codes",
                "resources",
                "schema_migrations",
                "sessions",
                "sqlite_sequence",
                "users"
            ]
        );
    }
}
