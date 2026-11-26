//! Tests of [`crate::accounts`].

use stuffcloud_core::account::{Email, Identifier, Login};
use stuffcloud_core::session::{Role, Timeouts, UserKind};
use stuffcloud_core::token::Token;

use super::*;
use crate::{BootstrapOutcome, NewSession, SessionLookup, token_hash};

const T: Timeouts = Timeouts {
    idle_ms: 1_000_000,
    absolute_ms: 10_000_000,
};

fn db() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("accounts.sqlite3")).unwrap();
    let _ = db.migrate().unwrap();
    (dir, db)
}

fn hash(byte: u8) -> TokenHash {
    token_hash(&Token::from_bytes([byte; 32]))
}

fn login(name: &str) -> Login {
    Login::parse(name).unwrap()
}

fn email(text: &str) -> Email {
    Email::parse(text).unwrap()
}

fn register(
    db: &Database,
    name: &str,
    address: &str,
    invitation: Option<&TokenHash>,
) -> Registration {
    let login = login(name);
    let email = email(address);
    db.register(
        &NewAccount {
            login: &login,
            email: Some(&email),
            role: Role::User,
            password_hash: "phc-of-alice",
        },
        invitation,
        100,
    )
    .unwrap()
}

fn created(registration: Registration) -> User {
    match registration {
        Registration::Created(user) => user,
        other => panic!("{other:?}"),
    }
}

fn actions(db: &Database) -> Vec<(Option<String>, String, String, String)> {
    db.audit_log()
        .unwrap()
        .into_iter()
        .map(|entry| (entry.actor, entry.action, entry.kind, entry.key))
        .collect()
}

fn session(db: &Database, user_id: i64, token: u8) -> i64 {
    db.create_session(
        &NewSession {
            user_id,
            token_hash: hash(token),
            csrf_hash: hash(token.wrapping_add(100)),
            replaces: None,
            max_per_user: None,
        },
        &T,
        100,
    )
    .unwrap()
    .id
}

#[test]
fn registration_creates_an_account_with_its_password() {
    let (_dir, db) = db();
    let alice = created(register(&db, "alice", "Alice@Example.com", None));
    assert_eq!(alice.login, "alice");
    assert_eq!(alice.kind, UserKind::Person);
    assert_eq!(alice.role, Role::User);
    assert_eq!(alice.created_at, 100);
    let by_login = db
        .password_record(&Identifier::Login(login("alice")))
        .unwrap()
        .unwrap();
    assert_eq!(by_login.user, alice);
    assert_eq!(by_login.hash.as_deref(), Some("phc-of-alice"));
    let by_email = db
        .password_record(&Identifier::Email(email("ALICE@example.com")))
        .unwrap()
        .unwrap();
    assert_eq!(by_email, by_login);
    assert_eq!(
        db.password_record(&Identifier::Login(login("bob")))
            .unwrap(),
        None
    );
    assert_eq!(
        db.user_by_login(&login("alice")).unwrap(),
        Some(alice.clone())
    );
    assert_eq!(db.user_by_login(&login("bob")).unwrap(), None);
    let profile = db.profile(alice.id).unwrap().unwrap();
    assert_eq!(profile.email.as_deref(), Some("alice@example.com"));
    assert!(profile.has_password);
    assert_eq!(db.profile(alice.id + 1).unwrap(), None);
    // The audit row names the account by id only.
    let id = alice.id.to_string();
    assert_eq!(
        actions(&db),
        [(
            Some(format!("user:{id}")),
            "user.created".to_owned(),
            "user".to_owned(),
            id
        )]
    );
    for row in actions(&db) {
        assert!(!format!("{row:?}").contains("alice"));
    }
}

#[test]
fn taken_logins_and_addresses_are_refused() {
    let (_dir, db) = db();
    let _alice = created(register(&db, "alice", "alice@example.com", None));
    assert_eq!(
        register(&db, "alice", "other@example.com", None),
        Registration::LoginTaken
    );
    assert_eq!(
        register(&db, "alice2", "ALICE@example.com", None),
        Registration::EmailTaken
    );
    let login = login("carol");
    assert!(matches!(
        db.register(
            &NewAccount {
                login: &login,
                email: None,
                role: Role::Admin,
                password_hash: "x",
            },
            None,
            1,
        )
        .unwrap(),
        Registration::Created(User {
            role: Role::Admin,
            ..
        })
    ));
    let profile = db
        .profile(db.user_by_login(&login).unwrap().unwrap().id)
        .unwrap()
        .unwrap();
    assert_eq!(profile.email, None);
}

#[test]
fn accounts_without_a_password_have_none() {
    let (_dir, db) = db();
    let robot = db
        .create_user("robot", UserKind::Service, Role::Admin, None, 1)
        .unwrap();
    let record = db
        .password_record(&Identifier::Login(login("robot")))
        .unwrap()
        .unwrap();
    assert_eq!(record.user, robot);
    assert_eq!(record.hash, None);
    assert!(!db.profile(robot.id).unwrap().unwrap().has_password);
}

#[test]
fn invitations_are_single_use_and_expire() {
    let (_dir, db) = db();
    let admin = db
        .create_user("admin", UserKind::Person, Role::Admin, None, 1)
        .unwrap();
    let invitation = match db
        .create_invitation(&hash(1), None, admin.id, 200, 50)
        .unwrap()
    {
        InvitationOutcome::Created(invitation) => invitation,
        InvitationOutcome::TooMany => panic!("too many"),
    };
    assert_eq!(
        invitation,
        Invitation {
            id: invitation.id,
            email: None,
            created_at: 50,
            expires_at: 200
        }
    );
    assert_eq!(
        db.pending_invitations(199).unwrap(),
        std::slice::from_ref(&invitation)
    );
    assert_eq!(db.pending_invitations(200).unwrap(), []);
    assert_eq!(
        register(&db, "alice", "alice@example.com", Some(&hash(9))),
        Registration::InvitationInvalid
    );
    let alice = created(register(&db, "alice", "alice@example.com", Some(&hash(1))));
    assert_eq!(db.pending_invitations(100).unwrap(), []);
    assert_eq!(
        register(&db, "bob", "bob@example.com", Some(&hash(1))),
        Registration::InvitationInvalid
    );
    let used = actions(&db)
        .into_iter()
        .find(|row| row.1 == "invitation.used")
        .unwrap();
    assert_eq!(
        used,
        (
            Some(format!("user:{}", alice.id)),
            "invitation.used".to_owned(),
            "invitation".to_owned(),
            invitation.id.to_string()
        )
    );
    // Expired: refused at its expiry, valid one millisecond before.
    let _ = db
        .create_invitation(&hash(2), None, admin.id, 100, 50)
        .unwrap();
    assert_eq!(
        register(&db, "bob", "bob@example.com", Some(&hash(2))),
        Registration::InvitationInvalid
    );
    let _ = db
        .create_invitation(&hash(3), None, admin.id, 101, 50)
        .unwrap();
    assert!(matches!(
        register(&db, "bob", "bob@example.com", Some(&hash(3))),
        Registration::Created(_)
    ));
}

#[test]
fn an_invitation_for_an_address_checks_it_before_anything_else() {
    let (_dir, db) = db();
    let admin = db
        .create_user("admin", UserKind::Person, Role::Admin, None, 1)
        .unwrap();
    let _alice = created(register(&db, "alice", "alice@example.com", None));
    let bound = email("Bob@Example.com");
    let _ = db
        .create_invitation(&hash(1), Some(&bound), admin.id, 1000, 50)
        .unwrap();
    assert_eq!(
        db.pending_invitations(60).unwrap()[0].email.as_deref(),
        Some("bob@example.com")
    );
    // The login is taken, but the wrong address is reported first: nothing about other
    // accounts is learnt from an invitation for someone else.
    assert_eq!(
        register(&db, "alice", "carol@example.com", Some(&hash(1))),
        Registration::InvitationForAnotherEmail
    );
    assert_eq!(
        register(&db, "alice", "bob@example.com", Some(&hash(1))),
        Registration::LoginTaken
    );
    // A refused registration does not use the invitation up.
    assert_eq!(db.pending_invitations(60).unwrap().len(), 1);
    assert!(matches!(
        register(&db, "bob", "BOB@example.com", Some(&hash(1))),
        Registration::Created(_)
    ));
}

#[test]
fn invitations_can_be_revoked_and_are_capped() {
    let (_dir, db) = db();
    let admin = db
        .create_user("admin", UserKind::Person, Role::Admin, None, 1)
        .unwrap();
    let InvitationOutcome::Created(first) = db
        .create_invitation(&hash(1), None, admin.id, 500, 10)
        .unwrap()
    else {
        panic!("not created");
    };
    let revoked = |db: &Database| -> Vec<(i64, String)> {
        db.audit_log()
            .unwrap()
            .into_iter()
            .filter(|entry| entry.action == "invitation.revoked")
            .map(|entry| (entry.at, entry.key))
            .collect()
    };
    assert!(db.revoke_invitation(first.id, admin.id, 20).unwrap());
    assert_eq!(revoked(&db), vec![(20, first.id.to_string())]);
    // Revoking it again changes nothing and leaves no second entry.
    assert!(!db.revoke_invitation(first.id, admin.id, 21).unwrap());
    assert_eq!(revoked(&db), vec![(20, first.id.to_string())]);
    let rows: Vec<String> = actions(&db).into_iter().map(|row| row.1).collect();
    assert!(rows.contains(&"invitation.created".to_owned()));
    for index in 0..MAX_PENDING_INVITATIONS {
        let mut bytes = [0_u8; 32];
        bytes[..8].copy_from_slice(&u64::try_from(index).unwrap().to_le_bytes());
        bytes[31] = 0xee;
        let outcome = db
            .create_invitation(
                &token_hash(&Token::from_bytes(bytes)),
                None,
                admin.id,
                500,
                30,
            )
            .unwrap();
        assert!(matches!(outcome, InvitationOutcome::Created(_)), "{index}");
    }
    assert_eq!(
        db.create_invitation(&hash(2), None, admin.id, 500, 40)
            .unwrap(),
        InvitationOutcome::TooMany
    );
    // Expired ones do not count.
    assert!(matches!(
        db.create_invitation(&hash(2), None, admin.id, 900, 500)
            .unwrap(),
        InvitationOutcome::Created(_)
    ));
}

#[test]
fn passwords_change_and_other_sessions_end() {
    let (_dir, db) = db();
    let alice = created(register(&db, "alice", "alice@example.com", None));
    let kept = session(&db, alice.id, 1);
    let _other = session(&db, alice.id, 2);
    assert_eq!(
        db.set_password(alice.id, "new-phc", Some(kept), 200)
            .unwrap(),
        1
    );
    assert_eq!(db.session_count(alice.id).unwrap(), 1);
    assert!(matches!(
        db.find_session(&hash(1), &T, 201).unwrap(),
        SessionLookup::Active(_)
    ));
    let record = db
        .password_record(&Identifier::Login(login("alice")))
        .unwrap()
        .unwrap();
    assert_eq!(record.hash.as_deref(), Some("new-phc"));
    let tail: Vec<String> = actions(&db)
        .into_iter()
        .rev()
        .take(2)
        .map(|row| row.1)
        .collect();
    assert_eq!(
        tail,
        ["session.ended_by_password_change", "password.changed"]
    );
    // Without a session to keep, every session ends; no sessions, no audit row for them.
    assert_eq!(db.set_password(alice.id, "third", None, 300).unwrap(), 1);
    assert_eq!(db.set_password(alice.id, "fourth", None, 301).unwrap(), 0);
    assert_eq!(
        actions(&db).last().unwrap().1,
        "password.changed".to_owned()
    );
    assert!(matches!(
        db.set_password(alice.id + 7, "x", None, 1),
        Err(DbError::UnknownUser(_))
    ));
    // An account without a password gets one.
    let bob = db
        .create_user("bob", UserKind::Person, Role::User, None, 1)
        .unwrap();
    assert_eq!(db.set_password(bob.id, "bob-phc", None, 5).unwrap(), 0);
    assert!(db.profile(bob.id).unwrap().unwrap().has_password);
}

#[test]
fn a_login_records_the_use_and_a_new_hash() {
    let (_dir, db) = db();
    let alice = created(register(&db, "alice", "alice@example.com", None));
    let used_at = |db: &Database| -> Option<i64> {
        db.lock()
            .unwrap()
            .query_row(
                "SELECT last_used_at FROM credentials WHERE user_id = ?1",
                [alice.id],
                |row| row.get(0),
            )
            .unwrap()
    };
    assert_eq!(used_at(&db), None);
    db.record_password_use(alice.id, None, 150).unwrap();
    assert_eq!(used_at(&db), Some(150));
    let record = |db: &Database| {
        db.password_record(&Identifier::Login(login("alice")))
            .unwrap()
            .unwrap()
            .hash
    };
    assert_eq!(record(&db).as_deref(), Some("phc-of-alice"));
    db.record_password_use(alice.id, Some("rehashed"), 160)
        .unwrap();
    assert_eq!(record(&db).as_deref(), Some("rehashed"));
    assert_eq!(used_at(&db), Some(160));
}

#[test]
fn reset_tokens_are_single_use_short_lived_and_end_every_session() {
    let (_dir, db) = db();
    let admin = db
        .create_user("admin", UserKind::Person, Role::Admin, None, 1)
        .unwrap();
    let alice = created(register(&db, "alice", "alice@example.com", None));
    let _s1 = session(&db, alice.id, 1);
    let _s2 = session(&db, alice.id, 2);
    assert_eq!(
        db.issue_password_reset(&login("alice"), &hash(10), Some(admin.id), 500, 100)
            .unwrap(),
        ResetIssue::Issued(alice.clone())
    );
    // A second reset replaces the first.
    assert_eq!(
        db.issue_password_reset(&login("alice"), &hash(11), None, 600, 110)
            .unwrap(),
        ResetIssue::Issued(alice.clone())
    );
    assert_eq!(db.password_reset_target(&hash(10), 120).unwrap(), None);
    let target = db.password_reset_target(&hash(11), 599).unwrap().unwrap();
    assert_eq!(target.user, alice);
    assert_eq!(target.email.as_deref(), Some("alice@example.com"));
    assert_eq!(db.password_reset_target(&hash(11), 600).unwrap(), None);
    assert_eq!(db.redeem_password_reset(&hash(10), "x", 120).unwrap(), None);
    assert_eq!(db.redeem_password_reset(&hash(11), "x", 600).unwrap(), None);
    assert_eq!(
        db.redeem_password_reset(&hash(11), "reset-phc", 599)
            .unwrap(),
        Some(alice.clone())
    );
    assert_eq!(
        db.redeem_password_reset(&hash(11), "again", 599).unwrap(),
        None
    );
    assert_eq!(db.session_count(alice.id).unwrap(), 0);
    assert_eq!(
        db.password_record(&Identifier::Login(login("alice")))
            .unwrap()
            .unwrap()
            .hash
            .as_deref(),
        Some("reset-phc")
    );
    let rows = actions(&db);
    let issued: Vec<Option<String>> = rows
        .iter()
        .filter(|row| row.1 == "password.reset_issued")
        .map(|row| row.0.clone())
        .collect();
    assert_eq!(issued, [Some(format!("user:{}", admin.id)), None]);
    let tail: Vec<&str> = rows
        .iter()
        .rev()
        .take(2)
        .map(|row| row.1.as_str())
        .collect();
    assert_eq!(tail, ["session.ended_by_password_reset", "password.reset"]);
    assert_eq!(
        db.issue_password_reset(&login("nobody"), &hash(12), None, 900, 100)
            .unwrap(),
        ResetIssue::UnknownUser
    );
    let _robot = db
        .create_user("robot", UserKind::Service, Role::User, None, 1)
        .unwrap();
    assert_eq!(
        db.issue_password_reset(&login("robot"), &hash(12), None, 900, 100)
            .unwrap(),
        ResetIssue::ServiceAccount
    );
}

#[test]
fn only_the_command_line_issues_reset_links_for_admins() {
    let (_dir, db) = db();
    let admin = db
        .create_user("admin", UserKind::Person, Role::Admin, None, 1)
        .unwrap();
    let other = db
        .create_user("other", UserKind::Person, Role::Admin, None, 1)
        .unwrap();
    for target in ["admin", "other"] {
        assert_eq!(
            db.issue_password_reset(&login(target), &hash(20), Some(admin.id), 900, 100)
                .unwrap(),
            ResetIssue::AdminAccount,
            "{target}"
        );
    }
    // Nothing was stored or audited for the refused ones.
    assert_eq!(db.password_reset_target(&hash(20), 101).unwrap(), None);
    assert!(
        !actions(&db)
            .iter()
            .any(|row| row.1 == "password.reset_issued")
    );
    assert_eq!(
        db.issue_password_reset(&login("other"), &hash(21), None, 900, 100)
            .unwrap(),
        ResetIssue::Issued(other)
    );
}

#[test]
fn a_password_change_deletes_the_open_reset_token() {
    let (_dir, db) = db();
    let alice = created(register(&db, "alice", "alice@example.com", None));
    let bob = created(register(&db, "bob", "bob@example.com", None));
    for (user, token) in [("alice", 30), ("bob", 31)] {
        let _ = db
            .issue_password_reset(&login(user), &hash(token), None, 900, 100)
            .unwrap();
    }
    let _ended = db.set_password(alice.id, "changed", None, 200).unwrap();
    assert_eq!(db.password_reset_target(&hash(30), 201).unwrap(), None);
    assert_eq!(
        db.redeem_password_reset(&hash(30), "undo", 201).unwrap(),
        None
    );
    // Another account's link is untouched.
    assert_eq!(
        db.password_reset_target(&hash(31), 201)
            .unwrap()
            .unwrap()
            .user,
        bob
    );
}

#[test]
fn expired_tokens_are_purged() {
    let (_dir, db) = db();
    let admin = db
        .create_user("admin", UserKind::Person, Role::Admin, None, 1)
        .unwrap();
    let _ = db
        .create_invitation(&hash(1), None, admin.id, 100, 1)
        .unwrap();
    let _ = db
        .create_invitation(&hash(2), None, admin.id, 101, 1)
        .unwrap();
    let _ = db
        .issue_password_reset(&login("admin"), &hash(3), None, 100, 1)
        .unwrap();
    assert_eq!(db.purge_expired_tokens(99).unwrap(), 0);
    assert_eq!(db.purge_expired_tokens(100).unwrap(), 2);
    assert_eq!(db.pending_invitations(100).unwrap().len(), 1);
    assert_eq!(db.purge_expired_tokens(101).unwrap(), 1);
}

#[test]
fn the_bootstrap_creates_the_first_admin_once() {
    let (_dir, db) = db();
    let name = login("root");
    let address = email("root@example.com");
    let admin = NewAccount {
        login: &name,
        email: Some(&address),
        role: Role::Admin,
        password_hash: "root-phc",
    };
    assert!(matches!(
        db.bootstrap(&[], Some(&admin), 5).unwrap(),
        BootstrapOutcome::Applied { .. }
    ));
    let record = db
        .password_record(&Identifier::Login(name.clone()))
        .unwrap()
        .unwrap();
    assert_eq!(record.user.role, Role::Admin);
    assert_eq!(record.hash.as_deref(), Some("root-phc"));
    let first = actions(&db).into_iter().next().unwrap();
    assert_eq!(first.0.as_deref(), Some(crate::store::BOOTSTRAP_ACTOR));
    assert_eq!(first.1, "user.created");
    assert_eq!(
        db.bootstrap(&[], Some(&admin), 6).unwrap(),
        BootstrapOutcome::AlreadyDone { at: 5 }
    );
    assert_eq!(
        db.lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn one_password_per_account() {
    let (_dir, db) = db();
    let alice = created(register(&db, "alice", "alice@example.com", None));
    let second = db.lock().unwrap().execute(
        "INSERT INTO credentials (user_id, kind, data, created_at) VALUES (?1, 'password', 'x', 1)",
        [alice.id],
    );
    assert!(second.is_err());
}

const COOLDOWN: i64 = 300_000;

fn mailed(db: &Database, who: &Identifier, token: u8, now: i64) -> MailedReset {
    db.issue_password_reset_for_mail(
        who,
        &hash(token),
        now.saturating_add(3_600_000),
        now,
        COOLDOWN,
    )
    .unwrap()
}

#[test]
fn a_reset_by_mail_is_issued_by_login_name_or_address_and_returns_the_stored_address() {
    let (_dir, db) = db();
    let alice = created(register(&db, "alice", "alice@example.com", None));
    let by_login = Identifier::Login(login("alice"));
    assert_eq!(
        mailed(&db, &by_login, 1, 1_000_000),
        MailedReset::Issued {
            user: alice.clone(),
            email: "alice@example.com".to_owned()
        }
    );
    // The token works once, for 60 minutes from `now`.
    let target = db
        .password_reset_target(&hash(1), 1_000_000 + 3_599_999)
        .unwrap()
        .unwrap();
    assert_eq!(target.user, alice);
    assert_eq!(
        db.password_reset_target(&hash(1), 1_000_000 + 3_600_000)
            .unwrap(),
        None
    );
    // By address, once the cool-down has passed; the older token is replaced.
    let by_address = Identifier::Email(email("alice@example.com"));
    assert_eq!(
        mailed(&db, &by_address, 2, 1_000_000 + COOLDOWN),
        MailedReset::Issued {
            user: alice,
            email: "alice@example.com".to_owned()
        }
    );
    assert_eq!(db.password_reset_target(&hash(1), 1_000_001).unwrap(), None);
    assert!(
        db.password_reset_target(&hash(2), 1_000_001)
            .unwrap()
            .is_some()
    );
}

#[test]
fn a_reset_by_mail_is_audited_by_id_without_an_actor() {
    let (_dir, db) = db();
    let alice = created(register(&db, "alice", "alice@example.com", None));
    let _issued = mailed(&db, &Identifier::Login(login("alice")), 1, 1_000_000);
    let rows = actions(&db);
    let last = rows.last().unwrap();
    assert_eq!(
        last,
        &(
            None,
            "password.reset_requested".to_owned(),
            "user".to_owned(),
            alice.id.to_string()
        )
    );
}

#[test]
fn the_cooldown_is_exact_and_covers_tokens_of_any_origin() {
    let (_dir, db) = db();
    let admin = db
        .create_user("admin", UserKind::Person, Role::Admin, None, 1)
        .unwrap();
    let _alice = created(register(&db, "alice", "alice@example.com", None));
    let who = Identifier::Login(login("alice"));
    assert!(matches!(
        mailed(&db, &who, 1, 1_000_000),
        MailedReset::Issued { .. }
    ));
    for at in [1_000_000, 1_000_001, 1_000_000 + COOLDOWN - 1] {
        assert_eq!(mailed(&db, &who, 2, at), MailedReset::Cooldown, "{at}");
    }
    // A refused request changed nothing: the first token still works, the second never existed.
    assert!(
        db.password_reset_target(&hash(1), 1_000_001)
            .unwrap()
            .is_some()
    );
    assert_eq!(db.password_reset_target(&hash(2), 1_000_001).unwrap(), None);
    assert_eq!(
        actions(&db)
            .iter()
            .filter(|row| row.1 == "password.reset_requested")
            .count(),
        1
    );
    assert!(matches!(
        mailed(&db, &who, 3, 1_000_000 + COOLDOWN),
        MailedReset::Issued { .. }
    ));
    // A link an admin issued counts like any other.
    assert!(matches!(
        db.issue_password_reset(
            &login("alice"),
            &hash(4),
            Some(admin.id),
            9_000_000,
            5_000_000
        )
        .unwrap(),
        ResetIssue::Issued(_)
    ));
    assert_eq!(mailed(&db, &who, 5, 5_000_000 + 1), MailedReset::Cooldown);
}

#[test]
fn a_reset_by_mail_refuses_what_has_no_business_getting_one() {
    let (_dir, db) = db();
    let _admin = db
        .create_user("admin", UserKind::Person, Role::Admin, None, 1)
        .unwrap();
    let _robot = db
        .create_user("robot", UserKind::Service, Role::User, None, 1)
        .unwrap();
    let _plain = db
        .create_user("plain", UserKind::Person, Role::User, None, 1)
        .unwrap();
    let _moderator = created(register(&db, "mod", "mod@example.com", None));
    for (who, expected) in [
        (Identifier::Login(login("nobody")), MailedReset::UnknownUser),
        (
            Identifier::Email(email("nobody@example.com")),
            MailedReset::UnknownUser,
        ),
        (
            Identifier::Login(login("robot")),
            MailedReset::ServiceAccount,
        ),
        (Identifier::Login(login("admin")), MailedReset::AdminAccount),
        (Identifier::Login(login("plain")), MailedReset::NoAddress),
    ] {
        assert_eq!(mailed(&db, &who, 9, 1_000_000), expected, "{who:?}");
    }
    // Nothing was stored or audited.
    assert_eq!(db.password_reset_target(&hash(9), 1_000_001).unwrap(), None);
    assert!(
        !actions(&db)
            .iter()
            .any(|row| row.1 == "password.reset_requested")
    );
}

#[test]
fn an_admin_with_an_address_gets_no_mail_either() {
    let (_dir, db) = db();
    let admin = login("boss");
    let address = email("boss@example.com");
    let _created = db
        .register(
            &NewAccount {
                login: &admin,
                email: Some(&address),
                role: Role::Admin,
                password_hash: "phc",
            },
            None,
            100,
        )
        .unwrap();
    for who in [Identifier::Login(admin), Identifier::Email(address)] {
        assert_eq!(mailed(&db, &who, 1, 1_000_000), MailedReset::AdminAccount);
    }
}

#[test]
fn an_admins_link_that_is_still_valid_is_never_replaced_by_a_mail() {
    let (_dir, db) = db();
    let admin = db
        .create_user("admin", UserKind::Person, Role::Admin, None, 1)
        .unwrap();
    let _alice = created(register(&db, "alice", "alice@example.org", None));
    let who = Identifier::Login(login("alice"));
    assert!(matches!(
        db.issue_password_reset(
            &login("alice"),
            &hash(1),
            Some(admin.id),
            9_000_000,
            1_000_000
        )
        .unwrap(),
        ResetIssue::Issued(_)
    ));
    // Long after the cool-down, but before the link expires: the link stays.
    assert_eq!(
        db.issue_password_reset_for_mail(&who, &hash(2), 12_000_000, 5_000_000, COOLDOWN)
            .unwrap(),
        MailedReset::Cooldown
    );
    assert!(
        db.password_reset_target(&hash(1), 5_000_001)
            .unwrap()
            .is_some()
    );
    assert_eq!(db.password_reset_target(&hash(2), 5_000_001).unwrap(), None);
    // Once it has expired a mail may be sent.
    assert!(matches!(
        db.issue_password_reset_for_mail(&who, &hash(3), 13_000_000, 9_000_000, COOLDOWN)
            .unwrap(),
        MailedReset::Issued { .. }
    ));
}

#[test]
fn an_account_is_mailed_at_most_three_times_an_hour() {
    let (_dir, db) = db();
    let _alice = created(register(&db, "alice", "alice@example.org", None));
    let who = Identifier::Login(login("alice"));
    let start = 10_000_000_i64;
    assert_eq!(MAX_MAILED_PER_HOUR, 3);
    for (index, token) in [1_u8, 2, 3].into_iter().enumerate() {
        let now = start + i64::try_from(index).unwrap() * COOLDOWN;
        assert!(
            matches!(mailed(&db, &who, token, now), MailedReset::Issued { .. }),
            "{index}"
        );
    }
    // A fourth request, one cool-down after the third, is refused and changes nothing.
    assert_eq!(
        mailed(&db, &who, 4, start + 3 * COOLDOWN),
        MailedReset::Cooldown
    );
    assert!(
        db.password_reset_target(&hash(3), start + 3 * COOLDOWN)
            .unwrap()
            .is_some()
    );
    assert_eq!(
        mailed(&db, &who, 4, start + 3_600_000 - 1),
        MailedReset::Cooldown
    );
    // The first of the three leaves the window exactly one hour after it was made.
    assert!(matches!(
        mailed(&db, &who, 5, start + 3_600_000),
        MailedReset::Issued { .. }
    ));
    // Another account has its own count.
    let _bob = created(register(&db, "bob", "bob@example.net", None));
    assert!(matches!(
        mailed(
            &db,
            &Identifier::Login(login("bob")),
            6,
            start + 3 * COOLDOWN
        ),
        MailedReset::Issued { .. }
    ));
}
