//! The resource store behind the API conventions of ADR 0010 (decision 3) and the one-time
//! bootstrap (decision 8, SPEC 10.7).
//!
//! A resource is a document (`body`, canonical JSON of its writable shape) addressed by a
//! kind and a natural key. Its strong entity tag is derived from kind, key and body, so the
//! same content always has the same tag and a dry run can tell the tag a write would give.
//!
//! Every write runs in one `IMMEDIATE` transaction: read the current row, evaluate the
//! preconditions, then insert, replace or delete and add an audit row. A write that would
//! not change the body changes nothing at all (no timestamp, no audit row). A dry run runs
//! exactly the same statements and rolls the transaction back, so it reports precisely what
//! the real write would do.

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use stuffcloud_core::etag::{Condition, EntityTag};

use crate::migrate::hex;
use crate::{Database, DbError};

/// `instance_state` row that records when the bootstrap ran.
const BOOTSTRAP_MARKER: &str = "bootstrapped_at";

/// Audit actor of the writes made by the bootstrap.
pub const BOOTSTRAP_ACTOR: &str = "bootstrap";

/// The `If-Match` / `If-None-Match` conditions of a write.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Preconditions {
    /// `If-Match`: the write goes ahead only if the current tag matches (strongly).
    pub if_match: Option<Condition>,
    /// `If-None-Match`: the write goes ahead only if no current tag matches (weakly);
    /// `*` means "create only".
    pub if_none_match: Option<Condition>,
}

impl Preconditions {
    /// Whether a write may go ahead given the current tag (`None`: no resource).
    #[must_use]
    pub fn allow(&self, current: Option<&EntityTag>) -> bool {
        self.if_match
            .as_ref()
            .is_none_or(|condition| condition.if_match(current))
            && self
                .if_none_match
                .as_ref()
                .is_none_or(|condition| condition.if_none_match(current))
    }
}

/// Who writes, when, and whether for real.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteContext {
    /// Unix time in milliseconds.
    pub now: i64,
    /// Audit actor (`None` until accounts exist).
    pub actor: Option<String>,
    /// Validate and report only; nothing is changed.
    pub dry_run: bool,
}

/// A stored resource.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    /// Internal row id (returned in `meta`, never needed to address the resource).
    pub id: i64,
    /// Canonical JSON of the writable shape.
    pub body: String,
    /// Opaque value of the strong entity tag.
    pub etag: String,
    /// Creation time, Unix milliseconds.
    pub created_at: i64,
    /// Time of the last change, Unix milliseconds.
    pub updated_at: i64,
}

impl Stored {
    /// The entity tag as a value that preconditions can be compared with.
    #[must_use]
    pub fn entity_tag(&self) -> Option<EntityTag> {
        EntityTag::strong(&self.etag).ok()
    }
}

/// What a write did (or, in a dry run, would do).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// The resource did not exist and was created.
    Created,
    /// The resource existed with another body and was replaced.
    Updated,
    /// The resource existed with the same body; nothing was written.
    Unchanged,
    /// The resource was deleted.
    Deleted,
}

impl Change {
    /// The name used in API responses and audit rows.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Updated => "updated",
            Self::Unchanged => "unchanged",
            Self::Deleted => "deleted",
        }
    }
}

/// Result of a successful `put`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written {
    /// What happened.
    pub change: Change,
    /// The resource before the write.
    pub previous: Option<Stored>,
    /// The resource after the write.
    pub current: Stored,
}

/// Result of [`Database::put`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutOutcome {
    /// The write went ahead (or would have, in a dry run).
    Written(Written),
    /// A precondition failed; nothing was written.
    PreconditionFailed {
        /// The resource as it is.
        current: Option<Stored>,
    },
}

/// Result of [`Database::delete`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteOutcome {
    /// The resource was deleted (or would have been, in a dry run).
    Deleted {
        /// The resource before the delete.
        previous: Stored,
    },
    /// There is no such resource.
    NotFound,
    /// A precondition failed; nothing was deleted.
    PreconditionFailed {
        /// The resource as it is.
        current: Stored,
    },
}

/// One row of the audit log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEntry {
    /// Row id, increasing.
    pub id: i64,
    /// Unix milliseconds.
    pub at: i64,
    /// Who acted (`None` until accounts exist).
    pub actor: Option<String>,
    /// `created`, `updated`, `deleted` or `bootstrap`.
    pub action: String,
    /// Resource kind.
    pub kind: String,
    /// Resource key.
    pub key: String,
}

/// Result of [`Database::bootstrap`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapOutcome {
    /// This was the first start with an empty database; the writes were applied.
    Applied {
        /// One change per write, in order.
        changes: Vec<Change>,
    },
    /// The bootstrap already ran at this time (Unix milliseconds); nothing was applied.
    AlreadyDone {
        /// When it ran.
        at: i64,
    },
    /// The database already held data without a bootstrap record (created by another
    /// path); nothing was applied, the bootstrap is now recorded as done.
    NotEmpty,
}

/// The opaque value of the strong entity tag of a resource: the first 128 bits of
/// SHA-256 over kind, key and body, in hex.
#[must_use]
pub fn etag_for(kind: &str, key: &str, body: &str) -> String {
    let mut hasher = Sha256::new();
    for part in [kind, key, body] {
        hasher.update(part.len().to_le_bytes());
        hasher.update(part.as_bytes());
    }
    let digest = hasher.finalize();
    hex(digest.get(..16).unwrap_or_default())
}

fn read(conn: &Connection, kind: &str, key: &str) -> Result<Option<Stored>, DbError> {
    Ok(conn
        .query_row(
            "SELECT id, body, etag, created_at, updated_at FROM resources WHERE kind = ?1 AND key = ?2",
            params![kind, key],
            |row| {
                Ok(Stored {
                    id: row.get(0)?,
                    body: row.get(1)?,
                    etag: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()?)
}

fn audit(
    tx: &Transaction<'_>,
    ctx: &WriteContext,
    action: &str,
    kind: &str,
    key: &str,
) -> Result<(), DbError> {
    let _rows = tx.execute(
        "INSERT INTO audit_log (at, actor, action, kind, key) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![ctx.now, ctx.actor, action, kind, key],
    )?;
    Ok(())
}

/// The write part of `put`, inside a transaction the caller owns.
fn put_in(
    tx: &Transaction<'_>,
    kind: &str,
    key: &str,
    body: &str,
    preconditions: &Preconditions,
    ctx: &WriteContext,
) -> Result<PutOutcome, DbError> {
    let previous = read(tx, kind, key)?;
    let current_tag = previous.as_ref().and_then(Stored::entity_tag);
    if !preconditions.allow(current_tag.as_ref()) {
        return Ok(PutOutcome::PreconditionFailed { current: previous });
    }
    let etag = etag_for(kind, key, body);
    let (change, current) = match &previous {
        Some(old) if old.body == body => (Change::Unchanged, old.clone()),
        Some(old) => {
            let _rows = tx.execute(
                "UPDATE resources SET body = ?1, etag = ?2, updated_at = ?3 WHERE id = ?4",
                params![body, etag, ctx.now, old.id],
            )?;
            audit(tx, ctx, Change::Updated.as_str(), kind, key)?;
            (
                Change::Updated,
                Stored {
                    body: body.to_owned(),
                    etag,
                    updated_at: ctx.now,
                    ..old.clone()
                },
            )
        }
        None => {
            let _rows = tx.execute(
                "INSERT INTO resources (kind, key, body, etag, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![kind, key, body, etag, ctx.now],
            )?;
            let id = tx.last_insert_rowid();
            audit(tx, ctx, Change::Created.as_str(), kind, key)?;
            (
                Change::Created,
                Stored {
                    id,
                    body: body.to_owned(),
                    etag,
                    created_at: ctx.now,
                    updated_at: ctx.now,
                },
            )
        }
    };
    Ok(PutOutcome::Written(Written {
        change,
        previous,
        current,
    }))
}

/// The bootstrap record, if any.
fn marker(conn: &Connection) -> Result<Option<i64>, DbError> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM instance_state WHERE name = ?1",
            [BOOTSTRAP_MARKER],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value.map(|text| text.parse().unwrap_or_default()))
}

/// Commits, or rolls back for a dry run.
fn finish(tx: Transaction<'_>, dry_run: bool) -> Result<(), DbError> {
    if dry_run {
        tx.rollback()?;
    } else {
        tx.commit()?;
    }
    Ok(())
}

impl Database {
    /// Reads one resource.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn get(&self, kind: &str, key: &str) -> Result<Option<Stored>, DbError> {
        read(&*self.lock()?, kind, key)
    }

    /// Creates or replaces a resource with `body` (idempotent; see the module docs).
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`]. A failed precondition is an outcome,
    /// not an error.
    pub fn put(
        &self,
        kind: &str,
        key: &str,
        body: &str,
        preconditions: &Preconditions,
        ctx: &WriteContext,
    ) -> Result<PutOutcome, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let outcome = put_in(&tx, kind, key, body, preconditions, ctx)?;
        finish(tx, ctx.dry_run)?;
        Ok(outcome)
    }

    /// Deletes a resource.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`]. A missing resource and a failed
    /// precondition are outcomes, not errors.
    pub fn delete(
        &self,
        kind: &str,
        key: &str,
        preconditions: &Preconditions,
        ctx: &WriteContext,
    ) -> Result<DeleteOutcome, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(previous) = read(&tx, kind, key)? else {
            return Ok(DeleteOutcome::NotFound);
        };
        if !preconditions.allow(previous.entity_tag().as_ref()) {
            return Ok(DeleteOutcome::PreconditionFailed { current: previous });
        }
        let _rows = tx.execute("DELETE FROM resources WHERE id = ?1", [previous.id])?;
        audit(&tx, ctx, Change::Deleted.as_str(), kind, key)?;
        finish(tx, ctx.dry_run)?;
        Ok(DeleteOutcome::Deleted { previous })
    }

    /// The whole audit log, oldest first.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn audit_log(&self) -> Result<Vec<AuditEntry>, DbError> {
        let conn = self.lock()?;
        let mut statement =
            conn.prepare("SELECT id, at, actor, action, kind, key FROM audit_log ORDER BY id")?;
        let rows = statement.query_map([], |row| {
            Ok(AuditEntry {
                id: row.get(0)?,
                at: row.get(1)?,
                actor: row.get(2)?,
                action: row.get(3)?,
                kind: row.get(4)?,
                key: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// When the bootstrap ran (Unix milliseconds), `None` before the first start.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn bootstrapped_at(&self) -> Result<Option<i64>, DbError> {
        marker(&*self.lock()?)
    }

    /// Applies the bootstrap writes `(kind, key, body)` exactly once: on the first start
    /// with an empty database, all in one transaction, together with the record that the
    /// bootstrap ran. Every later call changes nothing.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`]; on an error nothing is applied.
    pub fn bootstrap(
        &self,
        writes: &[(&str, &str, String)],
        now: i64,
    ) -> Result<BootstrapOutcome, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(at) = marker(&tx)? {
            return Ok(BootstrapOutcome::AlreadyDone { at });
        }
        let has_data: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM resources) OR EXISTS (SELECT 1 FROM audit_log)",
            [],
            |row| row.get(0),
        )?;
        let ctx = WriteContext {
            now,
            actor: Some(BOOTSTRAP_ACTOR.to_owned()),
            dry_run: false,
        };
        let outcome = if has_data {
            BootstrapOutcome::NotEmpty
        } else {
            let mut changes = Vec::with_capacity(writes.len());
            for (kind, key, body) in writes {
                if let PutOutcome::Written(written) =
                    put_in(&tx, kind, key, body, &Preconditions::default(), &ctx)?
                {
                    changes.push(written.change);
                }
            }
            audit(&tx, &ctx, "bootstrap", "instance", "bootstrap")?;
            BootstrapOutcome::Applied { changes }
        };
        let _rows = tx.execute(
            "INSERT INTO instance_state (name, value) VALUES (?1, ?2)",
            params![BOOTSTRAP_MARKER, now.to_string()],
        )?;
        tx.commit()?;
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KIND: &str = "settings";
    const KEY: &str = "reserved-names";

    fn db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("store.sqlite3")).unwrap();
        let _ = db.migrate().unwrap();
        (dir, db)
    }

    fn ctx(now: i64, dry_run: bool) -> WriteContext {
        WriteContext {
            now,
            actor: None,
            dry_run,
        }
    }

    fn written(outcome: PutOutcome) -> Written {
        match outcome {
            PutOutcome::Written(written) => written,
            other @ PutOutcome::PreconditionFailed { .. } => panic!("{other:?}"),
        }
    }

    fn if_match(header: &str) -> Preconditions {
        Preconditions {
            if_match: Some(Condition::parse(header).unwrap()),
            if_none_match: None,
        }
    }

    fn if_none_match(header: &str) -> Preconditions {
        Preconditions {
            if_match: None,
            if_none_match: Some(Condition::parse(header).unwrap()),
        }
    }

    fn actions(db: &Database) -> Vec<String> {
        db.audit_log()
            .unwrap()
            .into_iter()
            .map(|entry| entry.action)
            .collect()
    }

    #[test]
    fn etag_depends_on_kind_key_and_body() {
        let base = etag_for("a", "b", "c");
        assert_eq!(base.len(), 32);
        assert!(base.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(etag_for("a", "b", "c"), base);
        assert_ne!(etag_for("x", "b", "c"), base);
        assert_ne!(etag_for("a", "x", "c"), base);
        assert_ne!(etag_for("a", "b", "x"), base);
        // Length prefixes keep the parts apart.
        assert_ne!(etag_for("ab", "", "c"), etag_for("a", "b", "c"));
        assert!(EntityTag::strong(&base).is_ok());
    }

    #[test]
    fn change_names() {
        assert_eq!(Change::Created.as_str(), "created");
        assert_eq!(Change::Updated.as_str(), "updated");
        assert_eq!(Change::Unchanged.as_str(), "unchanged");
        assert_eq!(Change::Deleted.as_str(), "deleted");
    }

    #[test]
    fn preconditions_combine() {
        let tag = EntityTag::strong("v1").unwrap();
        assert!(Preconditions::default().allow(None));
        assert!(Preconditions::default().allow(Some(&tag)));
        assert!(if_match("\"v1\"").allow(Some(&tag)));
        assert!(!if_match("\"v0\"").allow(Some(&tag)));
        assert!(!if_match("*").allow(None));
        assert!(if_none_match("*").allow(None));
        assert!(!if_none_match("*").allow(Some(&tag)));
        let both = Preconditions {
            if_match: Some(Condition::Any),
            if_none_match: Some(Condition::parse("\"v0\"").unwrap()),
        };
        assert!(both.allow(Some(&tag)));
        assert!(!both.allow(None));
        let conflicting = Preconditions {
            if_match: Some(Condition::Any),
            if_none_match: Some(Condition::Any),
        };
        assert!(!conflicting.allow(Some(&tag)));
    }

    #[test]
    fn create_update_unchanged() {
        let (_dir, db) = db();
        assert_eq!(db.get(KIND, KEY).unwrap(), None);

        let created = written(
            db.put(
                KIND,
                KEY,
                "{\"a\":1}",
                &Preconditions::default(),
                &ctx(10, false),
            )
            .unwrap(),
        );
        assert_eq!(created.change, Change::Created);
        assert_eq!(created.previous, None);
        assert_eq!(created.current.body, "{\"a\":1}");
        assert_eq!(created.current.etag, etag_for(KIND, KEY, "{\"a\":1}"));
        assert_eq!(
            (created.current.created_at, created.current.updated_at),
            (10, 10)
        );
        assert_eq!(db.get(KIND, KEY).unwrap(), Some(created.current.clone()));

        let same = written(
            db.put(
                KIND,
                KEY,
                "{\"a\":1}",
                &Preconditions::default(),
                &ctx(20, false),
            )
            .unwrap(),
        );
        assert_eq!(same.change, Change::Unchanged);
        assert_eq!(
            same.current, created.current,
            "not even a timestamp changes"
        );
        assert_eq!(db.get(KIND, KEY).unwrap(), Some(created.current.clone()));

        let updated = written(
            db.put(
                KIND,
                KEY,
                "{\"a\":2}",
                &Preconditions::default(),
                &ctx(30, false),
            )
            .unwrap(),
        );
        assert_eq!(updated.change, Change::Updated);
        assert_eq!(updated.previous, Some(created.current.clone()));
        assert_eq!(updated.current.id, created.current.id);
        assert_eq!(
            (updated.current.created_at, updated.current.updated_at),
            (10, 30)
        );
        assert_eq!(updated.current.etag, etag_for(KIND, KEY, "{\"a\":2}"));
        assert_eq!(db.get(KIND, KEY).unwrap(), Some(updated.current));

        assert_eq!(
            actions(&db),
            vec!["created", "updated"],
            "no audit row for unchanged"
        );
        let log = db.audit_log().unwrap();
        assert_eq!((log[0].at, log[1].at), (10, 30));
        assert_eq!((log[0].kind.as_str(), log[0].key.as_str()), (KIND, KEY));
        assert_eq!(log[0].actor, None);
        assert!(log[0].id < log[1].id);
    }

    #[test]
    fn keys_and_kinds_are_separate() {
        let (_dir, db) = db();
        let _ = db
            .put(KIND, "one", "{}", &Preconditions::default(), &ctx(1, false))
            .unwrap();
        let _ = db
            .put(
                "other",
                KEY,
                "{}",
                &Preconditions::default(),
                &ctx(1, false),
            )
            .unwrap();
        assert_eq!(db.get(KIND, KEY).unwrap(), None);
        assert!(db.get(KIND, "one").unwrap().is_some());
        assert!(db.get("other", KEY).unwrap().is_some());
    }

    #[test]
    fn dry_runs_change_nothing_but_report_everything() {
        let (_dir, db) = db();
        let would_create = written(
            db.put(
                KIND,
                KEY,
                "{\"a\":1}",
                &Preconditions::default(),
                &ctx(10, true),
            )
            .unwrap(),
        );
        assert_eq!(would_create.change, Change::Created);
        assert_eq!(would_create.current.etag, etag_for(KIND, KEY, "{\"a\":1}"));
        assert_eq!(db.get(KIND, KEY).unwrap(), None);
        assert!(actions(&db).is_empty());

        let created = written(
            db.put(
                KIND,
                KEY,
                "{\"a\":1}",
                &Preconditions::default(),
                &ctx(20, false),
            )
            .unwrap(),
        );
        let would_update = written(
            db.put(
                KIND,
                KEY,
                "{\"a\":2}",
                &Preconditions::default(),
                &ctx(30, true),
            )
            .unwrap(),
        );
        assert_eq!(would_update.change, Change::Updated);
        assert_eq!(would_update.previous, Some(created.current.clone()));
        assert_eq!(db.get(KIND, KEY).unwrap(), Some(created.current.clone()));

        match db
            .delete(KIND, KEY, &Preconditions::default(), &ctx(40, true))
            .unwrap()
        {
            DeleteOutcome::Deleted { previous } => assert_eq!(previous, created.current),
            other => panic!("{other:?}"),
        }
        assert_eq!(db.get(KIND, KEY).unwrap(), Some(created.current));
        assert_eq!(actions(&db), vec!["created"]);
    }

    #[test]
    fn stale_if_match_fails_and_writes_nothing() {
        let (_dir, db) = db();
        let created = written(
            db.put(
                KIND,
                KEY,
                "{\"a\":1}",
                &Preconditions::default(),
                &ctx(1, false),
            )
            .unwrap(),
        );
        let stale = if_match("\"0123\"");
        for dry_run in [false, true] {
            assert_eq!(
                db.put(KIND, KEY, "{\"a\":2}", &stale, &ctx(2, dry_run))
                    .unwrap(),
                PutOutcome::PreconditionFailed {
                    current: Some(created.current.clone())
                }
            );
            assert_eq!(
                db.delete(KIND, KEY, &stale, &ctx(2, dry_run)).unwrap(),
                DeleteOutcome::PreconditionFailed {
                    current: created.current.clone()
                }
            );
        }
        let fresh = if_match(&format!("\"{}\"", created.current.etag));
        let updated = written(
            db.put(KIND, KEY, "{\"a\":2}", &fresh, &ctx(3, false))
                .unwrap(),
        );
        assert_eq!(updated.change, Change::Updated);
        assert_eq!(actions(&db), vec!["created", "updated"]);
    }

    #[test]
    fn if_match_on_a_missing_resource_fails() {
        let (_dir, db) = db();
        assert_eq!(
            db.put(KIND, KEY, "{}", &if_match("*"), &ctx(1, false))
                .unwrap(),
            PutOutcome::PreconditionFailed { current: None }
        );
        assert_eq!(db.get(KIND, KEY).unwrap(), None);
    }

    #[test]
    fn if_none_match_star_creates_only() {
        let (_dir, db) = db();
        let created = written(
            db.put(KIND, KEY, "{}", &if_none_match("*"), &ctx(1, false))
                .unwrap(),
        );
        assert_eq!(created.change, Change::Created);
        assert_eq!(
            db.put(KIND, KEY, "{\"b\":1}", &if_none_match("*"), &ctx(2, false))
                .unwrap(),
            PutOutcome::PreconditionFailed {
                current: Some(created.current)
            }
        );
    }

    #[test]
    fn delete() {
        let (_dir, db) = db();
        assert_eq!(
            db.delete(KIND, KEY, &Preconditions::default(), &ctx(1, false))
                .unwrap(),
            DeleteOutcome::NotFound
        );
        let created = written(
            db.put(KIND, KEY, "{}", &Preconditions::default(), &ctx(2, false))
                .unwrap(),
        );
        let fresh = if_match(&format!("\"{}\"", created.current.etag));
        assert_eq!(
            db.delete(KIND, KEY, &fresh, &ctx(3, false)).unwrap(),
            DeleteOutcome::Deleted {
                previous: created.current
            }
        );
        assert_eq!(db.get(KIND, KEY).unwrap(), None);
        assert_eq!(actions(&db), vec!["created", "deleted"]);
        assert_eq!(db.audit_log().unwrap()[1].at, 3);
    }

    #[test]
    fn actor_is_recorded() {
        let (_dir, db) = db();
        let context = WriteContext {
            now: 5,
            actor: Some("someone".to_owned()),
            dry_run: false,
        };
        let _ = db
            .put(KIND, KEY, "{}", &Preconditions::default(), &context)
            .unwrap();
        assert_eq!(db.audit_log().unwrap()[0].actor.as_deref(), Some("someone"));
    }

    #[test]
    fn stored_entity_tag() {
        let stored = Stored {
            id: 1,
            body: String::new(),
            etag: "abc".to_owned(),
            created_at: 0,
            updated_at: 0,
        };
        assert_eq!(stored.entity_tag(), EntityTag::strong("abc").ok());
        let broken = Stored {
            etag: "a b".to_owned(),
            ..stored
        };
        assert_eq!(broken.entity_tag(), None);
    }

    #[test]
    fn bootstrap_applies_exactly_once() {
        let (_dir, db) = db();
        assert_eq!(db.bootstrapped_at().unwrap(), None);
        let writes = [
            (KIND, KEY, "{\"a\":1}".to_owned()),
            (KIND, "other", "{}".to_owned()),
        ];
        assert_eq!(
            db.bootstrap(&writes, 100).unwrap(),
            BootstrapOutcome::Applied {
                changes: vec![Change::Created, Change::Created]
            }
        );
        let stored = db.get(KIND, KEY).unwrap().unwrap();
        assert_eq!(
            (stored.body.as_str(), stored.created_at),
            ("{\"a\":1}", 100)
        );
        let log = db.audit_log().unwrap();
        let summary: Vec<(&str, Option<&str>)> = log
            .iter()
            .map(|e| (e.action.as_str(), e.actor.as_deref()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("created", Some(BOOTSTRAP_ACTOR)),
                ("created", Some(BOOTSTRAP_ACTOR)),
                ("bootstrap", Some(BOOTSTRAP_ACTOR)),
            ]
        );
        assert_eq!(
            (log[2].kind.as_str(), log[2].key.as_str()),
            ("instance", "bootstrap")
        );

        assert_eq!(db.bootstrapped_at().unwrap(), Some(100));
        let later = [(KIND, KEY, "{\"a\":2}".to_owned())];
        assert_eq!(
            db.bootstrap(&later, 200).unwrap(),
            BootstrapOutcome::AlreadyDone { at: 100 }
        );
        assert_eq!(db.get(KIND, KEY).unwrap(), Some(stored));
        assert_eq!(db.audit_log().unwrap().len(), 3);
    }

    #[test]
    fn bootstrap_without_writes_still_counts() {
        let (_dir, db) = db();
        assert_eq!(
            db.bootstrap(&[], 7).unwrap(),
            BootstrapOutcome::Applied { changes: vec![] }
        );
        assert_eq!(
            db.bootstrap(&[(KIND, KEY, "{}".to_owned())], 8).unwrap(),
            BootstrapOutcome::AlreadyDone { at: 7 }
        );
        assert_eq!(db.get(KIND, KEY).unwrap(), None);
    }

    #[test]
    fn bootstrap_skips_a_database_with_data() {
        for seed_audit_only in [false, true] {
            let (_dir, db) = db();
            if seed_audit_only {
                let conn = db.lock().unwrap();
                let _ = conn
                    .execute(
                        "INSERT INTO audit_log (at, action, kind, key) VALUES (1, 'x', 'y', 'z')",
                        [],
                    )
                    .unwrap();
            } else {
                let _ = db
                    .put(
                        KIND,
                        "manual",
                        "{}",
                        &Preconditions::default(),
                        &ctx(1, false),
                    )
                    .unwrap();
            }
            assert_eq!(
                db.bootstrap(&[(KIND, KEY, "{}".to_owned())], 5).unwrap(),
                BootstrapOutcome::NotEmpty
            );
            assert_eq!(db.get(KIND, KEY).unwrap(), None);
            assert_eq!(
                db.bootstrap(&[], 6).unwrap(),
                BootstrapOutcome::AlreadyDone { at: 5 }
            );
        }
    }

    #[test]
    fn a_failing_bootstrap_applies_nothing() {
        let (_dir, db) = db();
        {
            let conn = db.lock().unwrap();
            conn.execute_batch(
                "CREATE TRIGGER refuse BEFORE INSERT ON resources WHEN NEW.key = 'bad'
                 BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();
        }
        let writes = [(KIND, KEY, "{}".to_owned()), (KIND, "bad", "{}".to_owned())];
        assert!(matches!(db.bootstrap(&writes, 1), Err(DbError::Sqlite(_))));
        assert_eq!(db.get(KIND, KEY).unwrap(), None);
        assert!(db.audit_log().unwrap().is_empty());
        assert_eq!(
            db.bootstrap(&[(KIND, KEY, "{}".to_owned())], 2).unwrap(),
            BootstrapOutcome::Applied {
                changes: vec![Change::Created]
            }
        );
    }
}
