//! Tests of [`crate::auth`].

use stuffcloud_core::session::{Role, SessionAge, Timeouts, UserKind};
use stuffcloud_core::token::Token;

use super::*;
use crate::AuditEntry;

const T: Timeouts = Timeouts {
    idle_ms: 10 * TOUCH_INTERVAL_MS,
    absolute_ms: 100 * TOUCH_INTERVAL_MS,
};

type Row = (Option<String>, String, String, String);

fn db() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("auth.sqlite3")).unwrap();
    let _ = db.migrate().unwrap();
    (dir, db)
}

fn hash(byte: u8) -> TokenHash {
    token_hash(&Token::from_bytes([byte; 32]))
}

fn person(db: &Database, login: &str, role: Role) -> User {
    db.create_user(login, UserKind::Person, role, None, 1)
        .unwrap()
}

fn login(db: &Database, user: &User, token: u8, now: i64) -> Session {
    db.create_session(
        &NewSession {
            user_id: user.id,
            token_hash: hash(token),
            csrf_hash: hash(token.wrapping_add(100)),
            replaces: None,
        },
        &T,
        now,
    )
    .unwrap()
}

fn security(db: &Database) -> Vec<Row> {
    db.audit_log()
        .unwrap()
        .into_iter()
        .filter(|entry| entry.category == "security")
        .map(
            |AuditEntry {
                 actor,
                 action,
                 kind,
                 key,
                 ..
             }| (actor, action, kind, key),
        )
        .collect()
}

fn row(actor: Option<&str>, action: &str, kind: &str, key: i64) -> Row {
    (
        actor.map(str::to_owned),
        action.to_owned(),
        kind.to_owned(),
        key.to_string(),
    )
}

fn active(lookup: SessionLookup) -> Session {
    match lookup {
        SessionLookup::Active(session) => session,
        other => panic!("{other:?}"),
    }
}

#[test]
fn hashes_and_actors() {
    let a = hash(1);
    assert_ne!(a, hash(2));
    assert_eq!(a, hash(1));
    // SHA-256 of 32 zero bytes.
    assert_eq!(
        crate::migrate::hex(&token_hash(&Token::from_bytes([0; 32]))),
        "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"
    );
    assert_eq!(actor(42), "user:42");
    assert!(matches!(hash_from(&[0; 31]), Err(DbError::Corrupt(_))));
    assert_eq!(hash_from(&[7; 32]).unwrap(), [7; 32]);
}

#[test]
fn users_are_created_read_and_audited() {
    let (_dir, db) = db();
    let user = db
        .create_user("alice", UserKind::Person, Role::Admin, Some("bootstrap"), 5)
        .unwrap();
    assert_eq!(
        user,
        User {
            id: user.id,
            login: "alice".to_owned(),
            kind: UserKind::Person,
            role: Role::Admin,
            created_at: 5
        }
    );
    assert_eq!(db.user(user.id).unwrap(), Some(user.clone()));
    assert_eq!(db.user(user.id + 1).unwrap(), None);
    assert!(
        db.create_user("alice", UserKind::Service, Role::User, None, 6)
            .is_err()
    );
    assert_eq!(
        security(&db),
        vec![row(Some("bootstrap"), "user.created", USER_KIND, user.id)]
    );
    assert_eq!(db.audit_log().unwrap()[0].at, 5);
}

#[test]
fn corrupt_rows_are_errors() {
    let (_dir, db) = db();
    let user = person(&db, "a", Role::User);
    assert!(matches!(
        user_from(1, "x".to_owned(), "robot", "user", 0),
        Err(DbError::Corrupt("unknown account kind"))
    ));
    assert!(matches!(
        user_from(1, "x".to_owned(), "person", "root", 0),
        Err(DbError::Corrupt("unknown role"))
    ));
    assert!(user_from(1, "x".to_owned(), "service", "moderator", 0).is_ok());
    // A value the CHECK constraint refuses can only come from a hand-edited file.
    {
        let conn = db.lock().unwrap();
        conn.execute_batch("PRAGMA ignore_check_constraints = ON")
            .unwrap();
        let _ = conn
            .execute("UPDATE users SET role = 'root' WHERE id = ?1", [user.id])
            .unwrap();
    }
    assert!(matches!(
        db.user(user.id),
        Err(DbError::Corrupt("unknown role"))
    ));
}

#[test]
fn a_session_is_created_found_and_touched() {
    let (_dir, db) = db();
    let user = person(&db, "alice", Role::User);
    let session = login(&db, &user, 1, 1000);
    assert_eq!(session.user, user);
    assert_eq!(session.csrf_hash, hash(101));
    assert_eq!((session.created_at, session.last_seen_at), (1000, 1000));
    assert_eq!(db.session_count(user.id).unwrap(), 1);

    // Within the touch interval nothing is written.
    let early = 1000 + TOUCH_INTERVAL_MS - 1;
    assert_eq!(
        active(db.find_session(&hash(1), &T, early).unwrap()),
        session
    );
    // At the interval the use is recorded, and kept until the next interval.
    let at = 1000 + TOUCH_INTERVAL_MS;
    assert_eq!(
        active(db.find_session(&hash(1), &T, at).unwrap()).last_seen_at,
        at
    );
    assert_eq!(
        active(db.find_session(&hash(1), &T, at + 1).unwrap()).last_seen_at,
        at
    );
    assert_eq!(
        db.find_session(&hash(2), &T, at).unwrap(),
        SessionLookup::Unknown
    );
    assert_eq!(
        security(&db)[1],
        row(
            Some(&actor(user.id)),
            "session.created",
            SESSION_KIND,
            session.id
        )
    );
}

/// A second connection that holds SQLite's write lock until it is dropped or committed.
fn hold_write_lock(dir: &tempfile::TempDir) -> Connection {
    let other = Connection::open(dir.path().join("auth.sqlite3")).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    other
}

fn is_busy(error: &DbError) -> bool {
    matches!(
        error,
        DbError::Sqlite(rusqlite::Error::SqliteFailure(failure, _))
            if failure.code == rusqlite::ErrorCode::DatabaseBusy
    )
}

#[test]
fn a_lookup_that_writes_nothing_does_not_take_the_write_lock() {
    let (dir, db) = db();
    let user = person(&db, "alice", Role::User);
    let session = login(&db, &user, 1, 1000);
    let audit_before = db.audit_log().unwrap();
    // Another process (edge) holds the write lock; waiting for it must not be necessary.
    db.lock()
        .unwrap()
        .busy_timeout(std::time::Duration::ZERO)
        .unwrap();
    let other = hold_write_lock(&dir);

    // An unknown token (random cookies) and a fresh session are answered by the read alone.
    assert_eq!(
        db.find_session(&hash(2), &T, 1000).unwrap(),
        SessionLookup::Unknown
    );
    assert_eq!(
        active(
            db.find_session(&hash(1), &T, 1000 + TOUCH_INTERVAL_MS - 1)
                .unwrap()
        ),
        session
    );
    // Recording the use and deleting an expired session need the write lock.
    let touch = db
        .find_session(&hash(1), &T, 1000 + TOUCH_INTERVAL_MS)
        .unwrap_err();
    assert!(is_busy(&touch), "{touch:?}");
    let expire = db.find_session(&hash(1), &T, T.idle_ms + 1000).unwrap_err();
    assert!(is_busy(&expire), "{expire:?}");

    other.execute_batch("COMMIT").unwrap();
    assert_eq!(db.audit_log().unwrap(), audit_before, "nothing was written");
    assert_eq!(
        active(
            db.find_session(&hash(1), &T, 1000 + TOUCH_INTERVAL_MS)
                .unwrap()
        )
        .last_seen_at,
        1000 + TOUCH_INTERVAL_MS
    );
}

#[test]
fn the_write_half_looks_the_session_up_again() {
    let (_dir, db) = db();
    let user = person(&db, "alice", Role::User);
    let session = login(&db, &user, 1, 0);
    let mut conn = db.lock().unwrap();
    // The session ended between the read and the write transaction.
    assert_eq!(
        settle_session(&mut conn, &hash(2), &T, 5).unwrap(),
        SessionLookup::Unknown
    );
    // Still there and nothing is due: the row comes back unchanged, nothing is written.
    assert_eq!(
        settle_session(&mut conn, &hash(1), &T, 5).unwrap(),
        SessionLookup::Active(session)
    );
    drop(conn);
    assert_eq!(
        security(&db).len(),
        2,
        "user.created and session.created only"
    );
}

#[test]
fn a_recently_used_session_still_expires_at_the_absolute_timeout() {
    let (_dir, db) = db();
    let user = person(&db, "alice", Role::User);
    let session = login(&db, &user, 1, 0);
    // Used a second ago, so only the absolute timeout is reached and no touch is due.
    let _rows = db
        .lock()
        .unwrap()
        .execute(
            "UPDATE sessions SET last_seen_at = ?1",
            [T.absolute_ms - 1000],
        )
        .unwrap();
    assert_eq!(
        db.find_session(&hash(1), &T, T.absolute_ms - 1).unwrap(),
        SessionLookup::Active(Session {
            last_seen_at: T.absolute_ms - 1000,
            ..session
        })
    );
    assert_eq!(
        db.find_session(&hash(1), &T, T.absolute_ms).unwrap(),
        SessionLookup::Expired(SessionAge::AbsoluteExpired)
    );
    assert_eq!(db.session_count(user.id).unwrap(), 0);
}

#[test]
fn idle_and_absolute_expiry_delete_the_session() {
    let (_dir, db) = db();
    let user = person(&db, "alice", Role::User);
    let idle = login(&db, &user, 1, 0);
    let _ = active(db.find_session(&hash(1), &T, T.idle_ms - 1).unwrap());
    // The lookup above recorded a use at idle - 1.
    let idle_end = T.idle_ms - 1 + T.idle_ms;
    assert_eq!(
        db.find_session(&hash(1), &T, idle_end).unwrap(),
        SessionLookup::Expired(SessionAge::IdleExpired)
    );
    assert_eq!(
        db.find_session(&hash(1), &T, idle_end).unwrap(),
        SessionLookup::Unknown
    );

    let busy = login(&db, &user, 2, 0);
    let mut now = 0;
    while now + TOUCH_INTERVAL_MS < T.absolute_ms {
        now += TOUCH_INTERVAL_MS;
        let _ = active(db.find_session(&hash(2), &T, now).unwrap());
    }
    assert_eq!(
        db.find_session(&hash(2), &T, T.absolute_ms).unwrap(),
        SessionLookup::Expired(SessionAge::AbsoluteExpired)
    );
    let log = security(&db);
    assert!(log.contains(&row(None, "session.expired", SESSION_KIND, idle.id)));
    assert!(log.contains(&row(None, "session.expired", SESSION_KIND, busy.id)));
    assert_eq!(db.session_count(user.id).unwrap(), 0);
}

#[test]
fn login_replaces_the_presented_session_and_purges_expired_ones() {
    let (_dir, db) = db();
    let user = person(&db, "alice", Role::User);
    let other = person(&db, "bob", Role::User);
    let stale = login(&db, &other, 9, 0);
    let fresh_other = login(&db, &other, 8, T.idle_ms);
    let old = login(&db, &user, 1, T.idle_ms);
    let new = db
        .create_session(
            &NewSession {
                user_id: user.id,
                token_hash: hash(2),
                csrf_hash: hash(3),
                replaces: Some(old.id),
            },
            &T,
            T.idle_ms + 1,
        )
        .unwrap();
    assert_ne!(new.id, old.id);
    assert_eq!(
        db.find_session(&hash(1), &T, T.idle_ms + 2).unwrap(),
        SessionLookup::Unknown
    );
    let _ = active(db.find_session(&hash(8), &T, T.idle_ms + 2).unwrap());
    let log = security(&db);
    assert!(log.contains(&row(None, "session.expired", SESSION_KIND, stale.id)));
    assert!(!log.contains(&row(None, "session.expired", SESSION_KIND, fresh_other.id)));
    assert!(log.contains(&row(
        Some(&actor(user.id)),
        "session.replaced",
        SESSION_KIND,
        old.id
    )));
    // Replacing a session that no longer exists writes no row.
    let before = security(&db).len();
    let _ = db
        .create_session(
            &NewSession {
                user_id: user.id,
                token_hash: hash(4),
                csrf_hash: hash(5),
                replaces: Some(old.id),
            },
            &T,
            T.idle_ms + 3,
        )
        .unwrap();
    assert_eq!(security(&db).len(), before + 1, "only session.created");
}

#[test]
fn purge_boundaries() {
    let (_dir, db) = db();
    let user = person(&db, "alice", Role::User);
    let _ = login(&db, &user, 1, 0);
    assert_eq!(db.purge_expired_sessions(&T, T.idle_ms - 1).unwrap(), 0);
    assert_eq!(db.purge_expired_sessions(&T, T.idle_ms).unwrap(), 1);
    let long = Timeouts {
        idle_ms: T.absolute_ms * 2,
        absolute_ms: T.absolute_ms,
    };
    let _ = login(&db, &user, 2, 0);
    assert_eq!(
        db.purge_expired_sessions(&long, T.absolute_ms - 1).unwrap(),
        0
    );
    assert_eq!(db.purge_expired_sessions(&long, T.absolute_ms).unwrap(), 1);
}

#[test]
fn sessions_need_a_person() {
    let (_dir, db) = db();
    let robot = db
        .create_user("robot", UserKind::Service, Role::Admin, None, 1)
        .unwrap();
    let new = |user_id| NewSession {
        user_id,
        token_hash: hash(1),
        csrf_hash: hash(2),
        replaces: None,
    };
    assert!(matches!(
        db.create_session(&new(robot.id), &T, 2),
        Err(DbError::NoInteractiveLogin(id)) if id == robot.id
    ));
    assert!(matches!(
        db.create_session(&new(999), &T, 2),
        Err(DbError::UnknownUser(999))
    ));
    assert_eq!(db.session_count(robot.id).unwrap(), 0);
}

#[test]
fn rotation_changes_the_tokens_but_keeps_the_age() {
    let (_dir, db) = db();
    let user = person(&db, "alice", Role::User);
    let session = login(&db, &user, 1, 0);
    assert!(
        db.rotate_session(session.id, &hash(2), &hash(3), 50)
            .unwrap()
    );
    assert_eq!(
        db.find_session(&hash(1), &T, 60).unwrap(),
        SessionLookup::Unknown
    );
    let found = active(db.find_session(&hash(2), &T, 60).unwrap());
    assert_eq!(found.id, session.id);
    assert_eq!(found.created_at, 0);
    assert_eq!(found.last_seen_at, 50);
    assert_eq!(found.csrf_hash, hash(3));
    assert!(
        !db.rotate_session(session.id + 1, &hash(4), &hash(5), 70)
            .unwrap()
    );
    assert_eq!(
        security(&db).last().unwrap(),
        &row(
            Some(&actor(user.id)),
            "session.rotated",
            SESSION_KIND,
            session.id
        )
    );
}

#[test]
fn csrf_rebinding() {
    let (_dir, db) = db();
    let user = person(&db, "alice", Role::User);
    let session = login(&db, &user, 1, 0);
    let before = security(&db);
    assert!(db.set_session_csrf(session.id, &hash(7)).unwrap());
    assert!(!db.set_session_csrf(session.id + 1, &hash(7)).unwrap());
    assert_eq!(
        active(db.find_session(&hash(1), &T, 1).unwrap()).csrf_hash,
        hash(7)
    );
    assert_eq!(security(&db), before, "not a security event");
}

#[test]
fn logout_and_logout_everywhere() {
    let (_dir, db) = db();
    let alice = person(&db, "alice", Role::User);
    let bob = person(&db, "bob", Role::User);
    let one = login(&db, &alice, 1, 0);
    let _two = login(&db, &alice, 2, 0);
    let _three = login(&db, &alice, 3, 0);
    let _bobs = login(&db, &bob, 4, 0);
    assert!(db.end_session(one.id, 10).unwrap());
    assert!(!db.end_session(one.id, 11).unwrap());
    assert_eq!(db.session_count(alice.id).unwrap(), 2);
    assert_eq!(
        db.end_user_sessions(alice.id, Some(&actor(alice.id)), 12)
            .unwrap(),
        2
    );
    assert_eq!(db.session_count(alice.id).unwrap(), 0);
    assert_eq!(db.session_count(bob.id).unwrap(), 1);
    let log = security(&db);
    assert!(log.contains(&row(
        Some(&actor(alice.id)),
        "session.ended",
        SESSION_KIND,
        one.id
    )));
    assert_eq!(
        log.last().unwrap(),
        &row(
            Some(&actor(alice.id)),
            "session.ended_all",
            USER_KIND,
            alice.id
        )
    );
    // Nothing left to end: no row.
    assert_eq!(db.end_user_sessions(alice.id, None, 13).unwrap(), 0);
    assert_eq!(security(&db), log);
}

#[test]
fn a_role_change_ends_every_session() {
    let (_dir, db) = db();
    let alice = person(&db, "alice", Role::User);
    let bob = person(&db, "bob", Role::User);
    let _ = login(&db, &alice, 1, 0);
    let _ = login(&db, &alice, 2, 0);
    let _ = login(&db, &bob, 3, 0);
    let admin = Some("user:99");
    let audit_before = security(&db).len();
    assert_eq!(
        db.set_role(alice.id, Role::User, admin, 5).unwrap(),
        RoleChange {
            previous: Role::User,
            ended_sessions: 0
        }
    );
    assert_eq!(db.session_count(alice.id).unwrap(), 2);
    assert_eq!(security(&db).len(), audit_before, "unchanged role");
    assert_eq!(
        db.set_role(alice.id, Role::Admin, admin, 6).unwrap(),
        RoleChange {
            previous: Role::User,
            ended_sessions: 2
        }
    );
    assert_eq!(db.user(alice.id).unwrap().unwrap().role, Role::Admin);
    assert_eq!(db.session_count(alice.id).unwrap(), 0);
    assert_eq!(db.session_count(bob.id).unwrap(), 1);
    let log = security(&db);
    assert_eq!(
        log[audit_before..].to_vec(),
        vec![
            row(admin, "user.role_changed", USER_KIND, alice.id),
            row(admin, "session.ended_by_role_change", USER_KIND, alice.id),
        ]
    );
    // A change without sessions writes only the role row.
    assert_eq!(
        db.set_role(alice.id, Role::Moderator, admin, 7)
            .unwrap()
            .ended_sessions,
        0
    );
    assert_eq!(security(&db).len(), log.len() + 1);
    assert!(matches!(
        db.set_role(999, Role::Admin, admin, 8),
        Err(DbError::UnknownUser(999))
    ));
}

#[test]
fn audit_rows_hold_no_personal_data() {
    let (_dir, db) = db();
    let user = db
        .create_user("alice.secret", UserKind::Person, Role::User, None, 1)
        .unwrap();
    let session = login(&db, &user, 1, 2);
    assert!(
        db.rotate_session(session.id, &hash(2), &hash(3), 3)
            .unwrap()
    );
    assert!(db.end_session(session.id, 4).unwrap());
    let tokens = [1_u8, 2, 3, 101].map(|byte| Token::from_bytes([byte; 32]).to_hex());
    let hashes = [1_u8, 2, 3, 101].map(|byte| crate::migrate::hex(&hash(byte)));
    let log = db.audit_log().unwrap();
    assert_eq!(log.len(), 4);
    for entry in log {
        let text = format!("{entry:?}");
        assert!(!text.contains("alice"), "{text}");
        for secret in tokens.iter().chain(&hashes) {
            assert!(!text.contains(secret.as_str()), "{text}");
        }
        assert_eq!(entry.category, "security");
    }
}

#[test]
fn deleting_a_user_deletes_the_sessions() {
    let (_dir, db) = db();
    let user = person(&db, "alice", Role::User);
    let _ = login(&db, &user, 1, 0);
    let _ = db
        .lock()
        .unwrap()
        .execute("DELETE FROM users WHERE id = ?1", [user.id])
        .unwrap();
    assert_eq!(db.session_count(user.id).unwrap(), 0);
}

#[test]
fn stored_hashes_have_32_bytes() {
    let (_dir, db) = db();
    let user = person(&db, "alice", Role::User);
    let short = db.lock().unwrap().execute(
        "INSERT INTO sessions (token_hash, csrf_hash, user_id, created_at, last_seen_at)
         VALUES (x'00', x'00', ?1, 0, 0)",
        [user.id],
    );
    assert!(short.is_err());
}
