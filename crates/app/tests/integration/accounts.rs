//! Local accounts (A-03, acceptance criteria of #33 and the security review on it):
//!
//! - account enumeration: an unknown login name or address, a service account and a wrong
//!   password get byte-identical answers after the same work (one Argon2 check each);
//! - the sign-up modes: `invite-only` refuses open registration, `oidc-only` refuses every local
//!   registration, `open` takes anyone; invitations are single use, expire and may be bound to
//!   an address;
//! - login starts a new session (fixation), registration logs in, both set only `__Host-`
//!   cookies; the session cap ends the oldest session;
//! - the throttles answer 429 with `Retry-After` without checking the password, the per-account
//!   rule spares an address that logged in before (not behind an unlisted proxy) and counts an
//!   account under all its names; a burst of parallel attempts gets exactly the free failures
//!   plus one password check (#145);
//! - password change and admin-issued reset links (single use, 60 minutes) end sessions; a
//!   password change voids an open link; no link for an admin account through the API;
//! - the audit log holds no login names, addresses or tokens.

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request};
use serde_json::{Value, json};
use stuffcloud_core::account::{Email, Login};
use stuffcloud_core::session::{Role, UserKind};
use stuffcloud_db::{AuditEntry, NewAccount, Registration, User};
use tower::ServiceExt;

use crate::common::{APP_ORIGIN, Browser, CSRF, EPOCH, Policy, Reply, TestApp, csrf_headers};

const LOGIN: &str = "/api/v1/auth/login";
const REGISTER: &str = "/api/v1/auth/register";
const RESET: &str = "/api/v1/auth/password-reset";
const ACCOUNT: &str = "/api/v1/account";
const PASSWORD: &str = "/api/v1/account/password";
const INVITATIONS: &str = "/api/v1/admin/invitations";
const SIGNUP: &str = "/api/v1/settings/signup";

const ALICE_PASSWORD: &str = "alice's long passphrase";
const NEW_PASSWORD: &str = "a brand new passphrase";

/// Creates a person with a password, as a registration would.
async fn account(app: &TestApp, login: &str, email: &str, role: Role, password: &str) -> User {
    let hash = app
        .state
        .accounts()
        .passwords()
        .hash(password)
        .await
        .unwrap();
    let login = Login::parse(login).unwrap();
    let email = Email::parse(email).unwrap();
    match app
        .db
        .register(
            &NewAccount {
                login: &login,
                email: Some(&email),
                role,
                password_hash: &hash,
            },
            None,
            EPOCH,
        )
        .unwrap()
    {
        Registration::Created(user) => user,
        other => panic!("{other:?}"),
    }
}

async fn admin(app: &TestApp) -> Browser {
    let admin = account(
        app,
        "admin",
        "admin@example.com",
        Role::Admin,
        "the admin's passphrase",
    )
    .await;
    app.session_for(admin.id)
}

async fn login(app: &TestApp, login: &str, password: &str) -> Reply {
    app.call(
        Method::POST,
        LOGIN,
        &csrf_headers(),
        Some(&json!({"login": login, "password": password})),
    )
    .await
}

/// A request with `headers` and a JSON body, from a client address (as `axum::serve` with
/// connect info hands it over) or without one.
fn request_from(
    from: Option<[u8; 4]>,
    path: &str,
    headers: &[(String, String)],
    body: &Value,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header("content-type", "application/json");
    for (name, value) in headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let mut request = builder.body(Body::from(body.to_string())).unwrap();
    if let Some(from) = from {
        let _previous = request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((from, 40000))));
    }
    request
}

fn login_request(from: [u8; 4], login: &str, password: &str) -> Request<Body> {
    request_from(
        Some(from),
        LOGIN,
        &csrf_headers(),
        &json!({"login": login, "password": password}),
    )
}

/// A login from a client address.
async fn login_from(app: &TestApp, from: [u8; 4], login: &str, password: &str) -> Reply {
    app.send(login_request(from, login, password)).await
}

/// Sends every request at once, each on its own task, and returns the statuses sorted.
async fn burst(app: &TestApp, requests: Vec<Request<Body>>) -> Vec<u16> {
    let tasks: Vec<_> = requests
        .into_iter()
        .map(|request| {
            let router = app.router.clone();
            tokio::spawn(async move { router.oneshot(request).await.unwrap().status().as_u16() })
        })
        .collect();
    let mut statuses = Vec::with_capacity(tasks.len());
    for task in tasks {
        statuses.push(task.await.unwrap());
    }
    statuses.sort_unstable();
    statuses
}

/// `count` times `status`, then `rest` times 429.
fn expected(status: u16, count: usize, rest: usize) -> Vec<u16> {
    let mut statuses = vec![status; count];
    statuses.extend(vec![429; rest]);
    statuses
}

/// The value of a cookie the reply sets.
fn cookie(reply: &Reply, name: &str) -> Option<String> {
    reply.set_cookies().into_iter().find_map(|set| {
        set.strip_prefix(&format!("{name}="))
            .map(|rest| rest.split(';').next().unwrap_or_default().to_owned())
    })
}

/// The browser a login or registration reply leaves behind.
fn browser_of(reply: &Reply) -> Vec<(String, String)> {
    let session = cookie(reply, "__Host-stuffcloud-session").unwrap();
    let csrf = cookie(reply, "__Host-stuffcloud-csrf").unwrap();
    assert_eq!(reply.json()["csrf_token"], csrf);
    vec![
        ("origin".to_owned(), APP_ORIGIN.to_owned()),
        ("x-csrf-token".to_owned(), csrf.clone()),
        (
            "cookie".to_owned(),
            format!("__Host-stuffcloud-session={session}; __Host-stuffcloud-csrf={csrf}"),
        ),
    ]
}

fn assert_cookies_host_only(reply: &Reply) {
    let cookies = reply.set_cookies();
    assert_eq!(cookies.len(), 2, "{cookies:?}");
    for set in cookies {
        assert!(set.starts_with("__Host-"), "{set}");
        assert!(!set.to_ascii_lowercase().contains("domain"), "{set}");
        assert!(
            set.contains("; Secure") && set.contains("; HttpOnly") && set.contains("; Path=/"),
            "{set}"
        );
    }
}

fn verifications(app: &TestApp) -> u64 {
    app.state.accounts().passwords().verifications()
}

#[tokio::test]
async fn unknown_and_known_accounts_get_identical_answers_after_the_same_work() {
    let app = TestApp::new(Policy::Production);
    let _alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    let _robot = app
        .db
        .create_user("robot", UserKind::Service, Role::Admin, None, EPOCH)
        .unwrap();
    let mut first: Option<(u16, Vec<u8>)> = None;
    for (name, password) in [
        ("nobody", ALICE_PASSWORD),
        ("nobody@example.com", ALICE_PASSWORD),
        ("alice", "wrong password"),
        ("ALICE@example.com", "wrong password"),
        ("robot", ALICE_PASSWORD),
        ("not a login", ALICE_PASSWORD),
    ] {
        let before = verifications(&app);
        let reply = login(&app, name, password).await;
        assert_eq!(
            verifications(&app),
            before + 1,
            "{name}: exactly one Argon2 check"
        );
        let problem = reply.problem(401, "invalid-credentials");
        assert_eq!(
            problem["detail"],
            "the login name, e-mail address or password is wrong"
        );
        assert!(reply.set_cookies().is_empty(), "{name}");
        let mut names: Vec<&str> = reply
            .headers
            .keys()
            .map(axum::http::HeaderName::as_str)
            .collect();
        names.sort_unstable();
        let shape = (reply.status.as_u16(), reply.body.clone());
        match &first {
            None => first = Some(shape),
            Some(expected) => assert_eq!(&shape, expected, "{name}"),
        }
        assert!(!names.contains(&"retry-after"), "{name}");
    }
    // The right password logs in, also by address in any case and with spaces around it.
    let before = verifications(&app);
    let reply = login(&app, "  Alice@Example.COM ", ALICE_PASSWORD).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    assert_eq!(verifications(&app), before + 1);
    assert_eq!(reply.json()["user"]["login"], "alice");
}

#[tokio::test]
async fn a_login_starts_a_new_session_and_ends_the_presented_one() {
    let app = TestApp::new(Policy::Production);
    let alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    let first = login(&app, "alice", ALICE_PASSWORD).await;
    assert_eq!(first.status.as_u16(), 200, "{}", first.text());
    assert_cookies_host_only(&first);
    let body = first.json();
    assert_eq!(body["authenticated"], true);
    assert_eq!(
        body["user"],
        json!({"login": "alice", "role": "user", "kind": "person"})
    );
    assert!(body["session"]["absolute_expires_at"].is_string());
    let browser = browser_of(&first);
    let reply = app.call(Method::GET, ACCOUNT, &browser, None).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    // Logging in again from the same browser replaces its session (fixation).
    let mut again = Request::builder()
        .method(Method::POST)
        .uri(LOGIN)
        .header("content-type", "application/json");
    for (name, value) in &browser {
        again = again.header(name.as_str(), value.as_str());
    }
    let second = app
        .send(
            again
                .body(Body::from(
                    json!({"login": "alice", "password": ALICE_PASSWORD}).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(second.status.as_u16(), 200, "{}", second.text());
    assert_ne!(
        cookie(&second, "__Host-stuffcloud-session"),
        cookie(&first, "__Host-stuffcloud-session")
    );
    assert_ne!(second.json()["csrf_token"], first.json()["csrf_token"]);
    assert_eq!(app.db.session_count(alice.id).unwrap(), 1);
    app.call(Method::GET, ACCOUNT, &browser, None)
        .await
        .assert_problem(401, "unauthenticated");
    let actions = app.audit_actions();
    assert!(
        actions.contains(&"session.replaced".to_owned()),
        "{actions:?}"
    );
}

#[tokio::test]
async fn the_oldest_session_ends_beyond_the_cap() {
    let app = TestApp::new(Policy::Production);
    let alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    let first = browser_of(&login(&app, "alice", ALICE_PASSWORD).await);
    for _ in 0..10 {
        assert_eq!(
            login(&app, "alice", ALICE_PASSWORD).await.status.as_u16(),
            200
        );
    }
    assert_eq!(app.db.session_count(alice.id).unwrap(), 10);
    app.call(Method::GET, ACCOUNT, &first, None)
        .await
        .assert_problem(401, "unauthenticated");
    assert!(app.audit_actions().contains(&"session.evicted".to_owned()));
}

#[tokio::test]
async fn failed_logins_are_throttled_without_checking_the_password() {
    let app = TestApp::new(Policy::Production);
    let _alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    for name in ["alice", "nobody"] {
        let mut refused = None;
        for attempt in 0..40 {
            let before = verifications(&app);
            let reply = login_from(&app, [198, 51, 100, attempt], name, "wrong password").await;
            if reply.status.as_u16() == 429 {
                assert_eq!(
                    verifications(&app),
                    before,
                    "a throttled attempt is not checked"
                );
                refused = Some(reply);
                break;
            }
            reply.assert_problem(401, "invalid-credentials");
        }
        let reply = refused.unwrap_or_else(|| panic!("{name} was never throttled"));
        let problem = reply.problem(429, "too-many-requests");
        let seconds: u64 = reply.header("retry-after").unwrap().parse().unwrap();
        assert!(seconds >= 1);
        assert!(
            problem["detail"]
                .as_str()
                .unwrap()
                .starts_with("too many attempts; try again in "),
            "{problem}"
        );
    }
    // The wait is over after at most 15 minutes.
    app.clock.advance(16 * 60_000);
    let reply = login_from(&app, [203, 0, 113, 1], "alice", ALICE_PASSWORD).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    let metrics = app.get("/metrics").await.text();
    assert!(metrics.contains("reason=\"throttled\""), "{metrics}");
    assert!(metrics.contains("reason=\"login_failed\""), "{metrics}");
}

#[tokio::test]
async fn an_address_that_logged_in_before_is_spared_by_the_account_rule() {
    let app = TestApp::new(Policy::Production);
    let _alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    let home = [192, 0, 2, 7];
    assert_eq!(
        login_from(&app, home, "alice", ALICE_PASSWORD)
            .await
            .status
            .as_u16(),
        200
    );
    let mut throttled = false;
    for attempt in 0..40 {
        let reply = login_from(&app, [198, 51, 100, attempt], "alice", "guess").await;
        throttled |= reply.status.as_u16() == 429;
    }
    assert!(throttled, "the account rule never applied");
    let stranger = login_from(&app, [203, 0, 113, 50], "alice", ALICE_PASSWORD).await;
    stranger.assert_problem(429, "too-many-requests");
    let reply = login_from(&app, home, "alice", ALICE_PASSWORD).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_burst_at_one_account_gets_exactly_its_free_failures_plus_one_check() {
    let app = TestApp::frozen(Policy::Production);
    let _alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    // Known and unknown names alike: 10 free failures plus one check, the rest is refused
    // unchecked, from 60 different addresses at the same instant.
    for name in ["alice", "nobody"] {
        let before = verifications(&app);
        let requests = (0..60)
            .map(|n| login_request([198, 51, 100, n], name, "wrong password"))
            .collect();
        assert_eq!(burst(&app, requests).await, expected(401, 11, 49), "{name}");
        assert_eq!(verifications(&app), before + 11, "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_burst_from_one_address_gets_exactly_its_free_failures_plus_one_check() {
    let app = TestApp::frozen(Policy::Production);
    let before = verifications(&app);
    let requests = (0..60)
        .map(|n| login_request([192, 0, 2, 50], &format!("guess{n}"), "wrong password"))
        .collect();
    assert_eq!(burst(&app, requests).await, expected(401, 21, 39));
    assert_eq!(verifications(&app), before + 21);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_burst_of_password_changes_gets_exactly_the_free_failures_plus_one_check() {
    let app = TestApp::frozen(Policy::Production);
    let alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    let browser = app.session_for(alice.id);
    let before = verifications(&app);
    let requests = (0..40)
        .map(|_| {
            request_from(
                None,
                PASSWORD,
                &browser.write_headers(),
                &json!({"current_password": "wrong", "new_password": NEW_PASSWORD}),
            )
        })
        .collect();
    assert_eq!(burst(&app, requests).await, expected(422, 11, 29));
    assert_eq!(verifications(&app), before + 11);
    // The failures count for the account: a login under its address is refused now too.
    let reply = login_from(&app, [203, 0, 113, 4], "alice@example.com", ALICE_PASSWORD).await;
    reply.assert_problem(401, "invalid-credentials");
}

#[tokio::test]
async fn an_account_is_counted_under_all_its_names() {
    let app = TestApp::frozen(Policy::Production);
    let _alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    for n in 0..10 {
        login_from(&app, [198, 51, 100, n], "alice", "guess")
            .await
            .assert_problem(401, "invalid-credentials");
    }
    // The address is a fresh name, but the account has used up its free failures: this one is
    // the last check...
    login_from(&app, [198, 51, 100, 10], "alice@example.com", "guess")
        .await
        .assert_problem(401, "invalid-credentials");
    // ...and now even the right password under a third spelling is not tried: the same 401 as a
    // wrong one, after a check against the dummy hash (no 429 that would tell the names belong
    // together).
    let before = verifications(&app);
    let refused = login_from(&app, [203, 0, 113, 1], " ALICE@example.com", ALICE_PASSWORD).await;
    let wrong = login_from(&app, [203, 0, 113, 2], "nobody@example.com", "guess").await;
    assert_eq!(verifications(&app), before + 2);
    assert_eq!(refused.status, wrong.status);
    assert_eq!(refused.body, wrong.body);
    assert!(refused.header("retry-after").is_none());
    assert!(refused.set_cookies().is_empty());
    // Once the wait is over the right password works again.
    app.clock.advance(2000);
    let reply = login_from(&app, [203, 0, 113, 1], "alice@example.com", ALICE_PASSWORD).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    let metrics = app.get("/metrics").await.text();
    assert!(metrics.contains("reason=\"throttled\""), "{metrics}");
}

#[tokio::test]
async fn behind_an_unlisted_proxy_no_address_is_exempt() {
    let app = TestApp::frozen(Policy::Production);
    let _alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    // The peer is a private address and no proxy is listed: it is everyone behind the proxy.
    let proxy = [172, 18, 0, 3];
    assert_eq!(
        login_from(&app, proxy, "alice", ALICE_PASSWORD)
            .await
            .status
            .as_u16(),
        200
    );
    for n in 0..11 {
        login_from(&app, [198, 51, 100, n], "alice", "guess")
            .await
            .assert_problem(401, "invalid-credentials");
    }
    // The owner's earlier login from that address does not exempt it (an attacker behind the
    // same proxy would share the exemption), whereas a public address that logged in is spared.
    login_from(&app, proxy, "alice", ALICE_PASSWORD)
        .await
        .assert_problem(429, "too-many-requests");
    assert_eq!(app.state.accounts().throttles().sizes()[3], 0);
}

async fn register(app: &TestApp, body: &Value) -> Reply {
    app.call(Method::POST, REGISTER, &csrf_headers(), Some(body))
        .await
}

async fn set_mode(app: &TestApp, admin: &Browser, mode: &str) {
    let reply = app
        .call(
            Method::PUT,
            SIGNUP,
            &admin.write_headers(),
            Some(&json!({"mode": mode})),
        )
        .await;
    assert!(reply.status.is_success(), "{}", reply.text());
}

async fn invite(app: &TestApp, admin: &Browser, body: &Value) -> Value {
    let reply = app
        .call(
            Method::POST,
            INVITATIONS,
            &admin.write_headers(),
            Some(body),
        )
        .await;
    assert_eq!(reply.status.as_u16(), 201, "{}", reply.text());
    reply.json()
}

#[tokio::test]
async fn invite_only_refuses_open_registration() {
    let app = TestApp::new(Policy::Production);
    let admin = admin(&app).await;
    let bob =
        json!({"login": "bob", "email": "bob@example.com", "password": "bob's own passphrase"});
    // The default mode is invite-only.
    app.get(SIGNUP).await.assert_problem(404, "not-found");
    let refused = register(&app, &bob).await;
    let problem = refused.problem(403, "signup-closed");
    assert_eq!(
        problem["detail"],
        "registration needs an invitation (sign-up mode invite-only)"
    );
    assert!(refused.set_cookies().is_empty());
    let unknown = "0".repeat(64);
    let reply = register(&app, &json!({"login": "bob", "email": "bob@example.com", "password": "bob's own passphrase", "invitation": unknown})).await;
    assert_eq!(
        reply.problem(422, "validation-failed")["errors"][0]["pointer"],
        "/invitation"
    );
    // With an invitation it works and logs in.
    let invitation = invite(&app, &admin, &json!({})).await;
    let token = invitation["token"].as_str().unwrap().to_owned();
    assert_eq!(
        invitation["link"],
        format!("{APP_ORIGIN}/register#invitation={token}")
    );
    let mut with = bob.clone();
    with["invitation"] = json!(token);
    let created = register(&app, &with).await;
    assert_eq!(created.status.as_u16(), 201, "{}", created.text());
    assert_cookies_host_only(&created);
    assert_eq!(created.json()["user"]["login"], "bob");
    let profile = app
        .call(Method::GET, ACCOUNT, &browser_of(&created), None)
        .await;
    assert_eq!(profile.json()["email"], "bob@example.com");
    assert_eq!(profile.json()["has_password"], true);
    assert_eq!(profile.json()["role"], "user");
    // The invitation is used up.
    let mut carol = json!({"login": "carol", "email": "carol@example.com", "password": "carol's own passphrase"});
    carol["invitation"] = json!(token);
    let reply = register(&app, &carol).await;
    assert_eq!(
        reply.problem(422, "validation-failed")["errors"][0]["detail"],
        "the invitation is unknown, used or expired"
    );
    // oidc-only refuses even an invitation.
    set_mode(&app, &admin, "oidc-only").await;
    let fresh = invite(&app, &admin, &json!({})).await;
    carol["invitation"] = fresh["token"].clone();
    register(&app, &carol)
        .await
        .assert_problem(403, "signup-closed");
    // open takes anyone.
    set_mode(&app, &admin, "open").await;
    assert_eq!(app.get(SIGNUP).await.json()["mode"], "open");
    // Deleting the setting goes back to the default: invite-only again.
    let reset = app
        .call(Method::DELETE, SIGNUP, &admin.write_headers(), None)
        .await;
    assert_eq!(reset.status.as_u16(), 200, "{}", reset.text());
    app.get(SIGNUP).await.assert_problem(404, "not-found");
    set_mode(&app, &admin, "open").await;
    let dave = register(
        &app,
        &json!({"login": "dave", "email": "dave@example.com", "password": "dave's own passphrase"}),
    )
    .await;
    assert_eq!(dave.status.as_u16(), 201, "{}", dave.text());
}

#[tokio::test]
async fn registration_reports_every_rule() {
    let app = TestApp::new(Policy::Production);
    let admin = admin(&app).await;
    set_mode(&app, &admin, "open").await;
    let _alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    let errors = |reply: &Reply| -> Vec<(String, String)> {
        reply.problem(422, "validation-failed")["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|error| {
                (
                    error["pointer"].as_str().unwrap().to_owned(),
                    error["code"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    };
    let shape = register(&app, &json!({"login": "B", "email": "x", "password": ""})).await;
    assert_eq!(
        errors(&shape),
        [
            ("/login".to_owned(), "invalid_value".to_owned()),
            ("/email".to_owned(), "invalid_value".to_owned()),
            ("/password".to_owned(), "invalid_value".to_owned()),
        ]
    );
    let weak = register(
        &app,
        &json!({"login": "bob", "email": "bob@example.com", "password": "bobbobbob"}),
    )
    .await;
    let problem = weak.problem(422, "validation-failed");
    assert_eq!(
        problem["errors"][0]["detail"],
        "the password has 9 characters; it needs at least 12"
    );
    let taken = register(
        &app,
        &json!({"login": "alice", "email": "bob@example.com", "password": "bob's own passphrase"}),
    )
    .await;
    assert_eq!(errors(&taken), [("/login".to_owned(), "taken".to_owned())]);
    let address = register(
        &app,
        &json!({"login": "bob", "email": "ALICE@example.com", "password": "bob's own passphrase"}),
    )
    .await;
    assert_eq!(
        errors(&address),
        [("/email".to_owned(), "taken".to_owned())]
    );
}

#[tokio::test]
async fn registrations_are_throttled_per_client() {
    let app = TestApp::new(Policy::Production);
    let admin = admin(&app).await;
    set_mode(&app, &admin, "open").await;
    let weak = json!({"login": "bob", "email": "bob@example.com", "password": "short"});
    for _ in 0..6 {
        register(&app, &weak)
            .await
            .assert_problem(422, "validation-failed");
    }
    let reply = register(&app, &weak).await;
    reply.assert_problem(429, "too-many-requests");
    assert!(reply.header("retry-after").is_some());
}

#[tokio::test]
async fn an_invitation_for_an_address_is_only_for_it() {
    let app = TestApp::new(Policy::Production);
    let admin = admin(&app).await;
    let invitation = invite(
        &app,
        &admin,
        &json!({"email": "Bob@Example.com", "expires_in_hours": 1}),
    )
    .await;
    assert_eq!(invitation["email"], "bob@example.com");
    let token = invitation["token"].clone();
    let other = register(&app, &json!({"login": "eve", "email": "eve@example.com", "password": "eve's own passphrase", "invitation": token})).await;
    assert_eq!(
        other.problem(422, "validation-failed")["errors"][0]["detail"],
        "the invitation is for another e-mail address"
    );
    // It expires after its hour.
    app.clock.advance(60 * 60_000);
    let late = register(&app, &json!({"login": "bob", "email": "bob@example.com", "password": "bob's own passphrase", "invitation": token})).await;
    assert_eq!(
        late.problem(422, "validation-failed")["errors"][0]["pointer"],
        "/invitation"
    );
}

#[tokio::test]
async fn invitations_are_listed_without_tokens_and_can_be_revoked() {
    let app = TestApp::new(Policy::Production);
    let admin = admin(&app).await;
    let first = invite(&app, &admin, &json!({})).await;
    let _second = invite(&app, &admin, &json!({"email": "bob@example.com"})).await;
    let list = app
        .call(Method::GET, INVITATIONS, &admin.read_headers(), None)
        .await
        .json();
    let entries = list["invitations"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    for entry in entries {
        assert!(
            entry.get("token").is_none() && entry.get("link").is_none(),
            "{entry}"
        );
    }
    assert_eq!(entries[1]["email"], "bob@example.com");
    let path = format!("{INVITATIONS}/{}", first["id"]);
    let reply = app
        .call(Method::DELETE, &path, &admin.write_headers(), None)
        .await;
    assert_eq!(reply.status.as_u16(), 204);
    app.call(Method::DELETE, &path, &admin.write_headers(), None)
        .await
        .assert_problem(404, "not-found");
    app.call(
        Method::DELETE,
        &format!("{INVITATIONS}/abc"),
        &admin.write_headers(),
        None,
    )
    .await
    .assert_problem(404, "not-found");
    let list = app
        .call(Method::GET, INVITATIONS, &admin.read_headers(), None)
        .await
        .json();
    assert_eq!(list["invitations"].as_array().unwrap().len(), 1);
    let revoked = register(&app, &json!({"login": "bob", "email": "bob@example.com", "password": "bob's own passphrase", "invitation": first["token"]})).await;
    revoked.assert_problem(422, "validation-failed");
    // Bad input and a user without the permission.
    let reply = app
        .call(
            Method::POST,
            INVITATIONS,
            &admin.write_headers(),
            Some(&json!({"expires_in_hours": 0})),
        )
        .await;
    reply.assert_problem(422, "validation-failed");
    let user = app.login("someone", Role::User);
    app.call(
        Method::POST,
        INVITATIONS,
        &user.write_headers(),
        Some(&json!({})),
    )
    .await
    .assert_problem(403, "forbidden");
}

#[tokio::test]
async fn the_own_password_changes_and_other_sessions_end() {
    let app = TestApp::new(Policy::Production);
    let alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    let here = browser_of(&login(&app, "alice", ALICE_PASSWORD).await);
    let there = browser_of(&login(&app, "alice", ALICE_PASSWORD).await);
    let wrong = app
        .call(
            Method::POST,
            PASSWORD,
            &here,
            Some(&json!({"current_password": "nope", "new_password": NEW_PASSWORD})),
        )
        .await;
    assert_eq!(
        wrong.problem(422, "validation-failed")["errors"][0]["pointer"],
        "/current_password"
    );
    let weak = app
        .call(
            Method::POST,
            PASSWORD,
            &here,
            Some(&json!({"current_password": ALICE_PASSWORD, "new_password": "alice"})),
        )
        .await;
    let details: Vec<String> = weak.problem(422, "validation-failed")["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|error| error["detail"].as_str().unwrap().to_owned())
        .collect();
    assert!(
        details.contains(&"the password must not be the login name".to_owned()),
        "{details:?}"
    );
    let changed = app
        .call(
            Method::POST,
            PASSWORD,
            &here,
            Some(&json!({"current_password": ALICE_PASSWORD, "new_password": NEW_PASSWORD})),
        )
        .await;
    assert_eq!(changed.status.as_u16(), 204, "{}", changed.text());
    assert_eq!(app.db.session_count(alice.id).unwrap(), 1);
    assert_eq!(
        app.call(Method::GET, ACCOUNT, &here, None)
            .await
            .status
            .as_u16(),
        200
    );
    app.call(Method::GET, ACCOUNT, &there, None)
        .await
        .assert_problem(401, "unauthenticated");
    login(&app, "alice", ALICE_PASSWORD)
        .await
        .assert_problem(401, "invalid-credentials");
    assert_eq!(
        login(&app, "alice", NEW_PASSWORD).await.status.as_u16(),
        200
    );
}

#[tokio::test]
async fn a_password_change_voids_an_open_reset_link() {
    let app = TestApp::new(Policy::Production);
    let admin = admin(&app).await;
    let alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    let link = app
        .call(
            Method::POST,
            "/api/v1/admin/users/alice/password-reset",
            &admin.write_headers(),
            None,
        )
        .await
        .json();
    let changed = app
        .call(
            Method::POST,
            PASSWORD,
            &app.session_for(alice.id).write_headers(),
            Some(&json!({"current_password": ALICE_PASSWORD, "new_password": NEW_PASSWORD})),
        )
        .await;
    assert_eq!(changed.status.as_u16(), 204, "{}", changed.text());
    let redeemed = app
        .call(
            Method::POST,
            RESET,
            &csrf_headers(),
            Some(&json!({"token": link["token"], "password": "the attacker's passphrase"})),
        )
        .await;
    assert_eq!(
        redeemed.problem(422, "validation-failed")["errors"][0]["detail"],
        "the reset link is unknown, used or expired"
    );
    assert_eq!(
        login(&app, "alice", NEW_PASSWORD).await.status.as_u16(),
        200
    );
}

#[tokio::test]
async fn an_admin_reset_link_works_once_within_the_hour() {
    let app = TestApp::new(Policy::Production);
    let admin = admin(&app).await;
    let alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    let _session = login(&app, "alice", ALICE_PASSWORD).await;
    let issue = |login: &'static str| {
        let headers = admin.write_headers();
        let app = &app;
        async move {
            app.call(
                Method::POST,
                &format!("/api/v1/admin/users/{login}/password-reset"),
                &headers,
                None,
            )
            .await
        }
    };
    let reply = issue("alice").await;
    assert_eq!(reply.status.as_u16(), 201, "{}", reply.text());
    let link = reply.json();
    let token = link["token"].as_str().unwrap().to_owned();
    assert_eq!(
        link["link"],
        format!("{APP_ORIGIN}/password-reset#token={token}")
    );
    assert!(link["expires_at"].is_string());
    let redeem = |password: &'static str, token: String| {
        let app = &app;
        async move {
            app.call(
                Method::POST,
                RESET,
                &csrf_headers(),
                Some(&json!({"token": token, "password": password})),
            )
            .await
        }
    };
    let weak = redeem("short", token.clone()).await;
    assert_eq!(
        weak.problem(422, "validation-failed")["errors"][0]["pointer"],
        "/password"
    );
    assert_eq!(
        redeem(NEW_PASSWORD, token.clone()).await.status.as_u16(),
        204
    );
    assert_eq!(app.db.session_count(alice.id).unwrap(), 0);
    let again = redeem("yet another passphrase", token).await;
    assert_eq!(
        again.problem(422, "validation-failed")["errors"][0]["detail"],
        "the reset link is unknown, used or expired"
    );
    assert_eq!(
        login(&app, "alice", NEW_PASSWORD).await.status.as_u16(),
        200
    );
    // Unknown and service accounts.
    issue("nobody").await.assert_problem(404, "not-found");
    issue("{login}").await.assert_problem(404, "not-found");
    let _robot = app
        .db
        .create_user("robot", UserKind::Service, Role::User, None, EPOCH)
        .unwrap();
    issue("robot").await.assert_problem(403, "forbidden");
    // No link for an admin account through the API, not even the caller's own.
    let _other = account(
        &app,
        "other",
        "other@example.com",
        Role::Admin,
        "the other admin's passphrase",
    )
    .await;
    for target in ["other", "admin"] {
        let refused = issue(target).await;
        assert_eq!(
            refused.problem(403, "forbidden")["detail"],
            "reset links for admin accounts are issued only on the host: stuffcloud-app reset-link <login>",
            "{target}"
        );
    }
    // An hour later a link no longer works (the admin's own session is long idle by then, so
    // this comes last).
    let late = issue("alice").await.json()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    app.clock.advance(60 * 60_000);
    redeem("yet another passphrase", late)
        .await
        .assert_problem(422, "validation-failed");
}

/// The `login.failed` audit entries, polled until there are at least `wanted` of them (the
/// audit write runs in the background).
async fn failed_login_entries(app: &TestApp, wanted: usize) -> Vec<AuditEntry> {
    let mut failed = Vec::new();
    for _ in 0..200 {
        failed = app
            .db
            .audit_log()
            .unwrap()
            .into_iter()
            .filter(|entry| entry.action == "login.failed")
            .collect();
        if failed.len() >= wanted {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    failed
}

#[tokio::test]
async fn the_audit_log_names_no_one() {
    let app = TestApp::new(Policy::Production);
    let admin = admin(&app).await;
    let alice = account(
        &app,
        "alice",
        "alice@example.com",
        Role::User,
        ALICE_PASSWORD,
    )
    .await;
    // The failed login is written in the background, once a minute per account: the first
    // failure is written (inverting the limiter's answer fails here, with a single failure)...
    let _ = login(&app, "alice", "wrong password").await;
    let failed = failed_login_entries(&app, 1).await;
    // ...and the later ones within the minute are not.
    let _ = login(&app, "alice", "wrong again").await;
    let _ = login(&app, "nobody", "wrong").await;
    let _ = login(&app, "alice", ALICE_PASSWORD).await;
    let _ = invite(&app, &admin, &json!({"email": "bob@example.com"})).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(failed_login_entries(&app, 1).await.len(), 1);
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].key, alice.id.to_string());
    assert_eq!(failed[0].category, "security");
    for entry in app.db.audit_log().unwrap() {
        let text = format!("{entry:?}");
        for secret in ["alice", "nobody", "example.com", "bob", CSRF] {
            assert!(!text.contains(secret), "{text}");
        }
    }
}
