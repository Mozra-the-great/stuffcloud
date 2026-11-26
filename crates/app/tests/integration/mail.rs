//! The optional mailer (A-10, acceptance criteria of #40):
//!
//! - with SMTP unset the app runs fully: `GET /features` says `mail: false`, asking for a reset
//!   link by e-mail is `409 mail-not-configured` for every account alike, and the admin's reset
//!   link still works;
//! - with it set, the password reset mail arrives at the transport with a link that redeems
//!   once, in German or English, to the address stored for the account and no other, after an
//!   answer that is the same for every login name or address;
//! - the throttles (per client address, one token per account and cool-down) and the full queue
//!   answer 429; retries and the end of the schedule are counted;
//! - the `smtp` settings group follows the conventions of every settings group, takes the
//!   password only as a reference and refuses what could leak or inject.

use std::time::Duration;

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request};
use serde_json::{Value, json};
use stuffcloud_app::state::Clock as _;
use stuffcloud_core::account::{Email, Login};
use stuffcloud_core::session::{Role, UserKind};
use stuffcloud_core::token::Token;
use stuffcloud_db::{NewAccount, Registration, User, token_hash};
use stuffcloud_mail::{FailureKind, SendError};

use crate::common::{
    APP_ORIGIN, Browser, EPOCH, Policy, Reply, SMTP_PASSWORD, TestApp, csrf_headers,
};

const FEATURES: &str = "/api/v1/features";
const REQUEST: &str = "/api/v1/auth/password-reset/request";
const REDEEM: &str = "/api/v1/auth/password-reset";
const LOGIN: &str = "/api/v1/auth/login";
const SMTP: &str = "/api/v1/settings/smtp";
const METRICS: &str = "/metrics";

fn smtp_body() -> Value {
    json!({
        "host": "smtp.example.com",
        "port": 587,
        "security": "starttls",
        "username": "stuffcloud",
        "password": {"ref": "STUFFCLOUD_SECRET_SMTP"},
        "from": "noreply@example.com",
        "from_name": "stuffcloud"
    })
}

async fn account(app: &TestApp, login: &str, email: Option<&str>, role: Role) -> User {
    let hash = app
        .state
        .accounts()
        .passwords()
        .hash("an old passphrase")
        .await
        .unwrap();
    let login = Login::parse(login).unwrap();
    let email = email.map(|text| Email::parse(text).unwrap());
    match app
        .db
        .register(
            &NewAccount {
                login: &login,
                email: email.as_ref(),
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
    let admin = account(app, "admin", Some("admin@example.com"), Role::Admin).await;
    app.session_for(admin.id)
}

/// Sets mail up through the API, as an admin would.
async fn configure(app: &TestApp, admin: &Browser) {
    let reply = app
        .call(
            Method::PUT,
            SMTP,
            &admin.write_headers(),
            Some(&smtp_body()),
        )
        .await;
    assert_eq!(reply.status, 201, "{}", reply.text());
}

/// Asks from the client address `from`: one address may ask only so often.
async fn ask_from(app: &TestApp, from: [u8; 4], login: &str) -> Reply {
    let mut builder = Request::builder()
        .method(Method::POST)
        .uri(REQUEST)
        .header("content-type", "application/json");
    for (name, value) in csrf_headers() {
        builder = builder.header(name, value);
    }
    let mut request = builder
        .body(Body::from(json!({"login": login}).to_string()))
        .unwrap();
    let _previous = request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from((from, 40000))));
    app.send(request).await
}

async fn ask(app: &TestApp, login: &str) -> Reply {
    app.call(
        Method::POST,
        REQUEST,
        &csrf_headers(),
        Some(&json!({"login": login})),
    )
    .await
}

/// Waits (at most two seconds) until `done` holds.
async fn until(mut done: impl FnMut() -> bool) {
    for _ in 0..400 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the condition never held");
}

/// Gives the worker time to do what it would do after an answer: for the checks that something
/// does not happen.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(300)).await;
}

fn token_of(text: &str) -> String {
    let (_, rest) = text.split_once("/password-reset#token=").unwrap();
    rest.lines().next().unwrap().to_owned()
}

async fn metrics(app: &TestApp) -> String {
    app.get(METRICS).await.text()
}

#[tokio::test]
async fn without_smtp_the_app_runs_and_says_why_there_is_no_mail() {
    let app = TestApp::with_mail(Policy::Production);
    let _alice = account(&app, "alice", Some("alice@example.org"), Role::User).await;
    let features = app.get(FEATURES).await;
    assert_eq!(features.status, 200);
    assert_eq!(features.json(), json!({"mail": false}));
    // The same answer for an account, an unknown name and rubbish: it depends on the instance only.
    let answers: Vec<Value> = [
        ask(&app, "alice").await,
        ask(&app, "nobody").await,
        ask(&app, "alice@example.org").await,
        ask(&app, "not a login!").await,
    ]
    .into_iter()
    .map(|reply| reply.problem(409, "mail-not-configured"))
    .collect();
    assert!(answers.iter().all(|answer| answer == &answers[0]));
    assert_eq!(
        answers[0]["detail"],
        "this instance sends no mail: ask an administrator for a reset link"
    );
    settle().await;
    assert_eq!(app.mail.attempts(), 0);
    // The admin's way still works.
    let admin = admin(&app).await;
    let link = app
        .call(
            Method::POST,
            "/api/v1/admin/users/alice/password-reset",
            &admin.write_headers(),
            None,
        )
        .await;
    assert_eq!(link.status, 201, "{}", link.text());
    // No token was issued by the requests.
    assert!(
        !app.audit_actions()
            .contains(&"password.reset_requested".to_owned())
    );
}

#[tokio::test]
async fn the_features_follow_the_settings() {
    let app = TestApp::with_mail(Policy::Production);
    let admin = admin(&app).await;
    assert_eq!(app.get(FEATURES).await.json(), json!({"mail": false}));
    configure(&app, &admin).await;
    let features = app.get(FEATURES).await;
    assert_eq!(features.status, 200);
    assert_eq!(features.json(), json!({"mail": true}));
    let deleted = app
        .call(Method::DELETE, SMTP, &admin.write_headers(), None)
        .await;
    assert_eq!(deleted.status, 200, "{}", deleted.text());
    assert_eq!(app.get(FEATURES).await.json(), json!({"mail": false}));
}

#[tokio::test]
async fn a_reset_mail_arrives_with_a_link_that_works_once() {
    let app = TestApp::with_mail(Policy::Production);
    let admin = admin(&app).await;
    let alice = account(&app, "alice", Some("alice@example.org"), Role::User).await;
    configure(&app, &admin).await;
    let answer = app
        .call(
            Method::POST,
            REQUEST,
            &csrf_headers(),
            Some(&json!({"login": "alice"})),
        )
        .await;
    assert_eq!(answer.status, 202, "{}", answer.text());
    assert!(answer.body.is_empty());
    until(|| app.mail.sent().len() == 1).await;
    let mail = app.mail.sent().remove(0);
    assert_eq!(mail.to.as_str(), "alice@example.org");
    assert_eq!(mail.from.as_str(), "noreply@example.com");
    assert_eq!(mail.from_name.as_deref(), Some("stuffcloud"));
    assert_eq!(mail.subject, "stuffcloud: reset your password");
    assert!(mail.text.starts_with("Hello alice,"), "{}", mail.text);
    assert!(mail.text.contains("within 60 minutes"), "{}", mail.text);
    assert!(mail.text.contains(APP_ORIGIN));
    // The server the app talked to, with the password from the deployment configuration.
    let server = app.mail.servers().remove(0);
    assert_eq!(server.host, "smtp.example.com");
    assert_eq!(server.port, 587);
    assert_eq!(
        server.security,
        stuffcloud_core::smtp::SmtpSecurity::Starttls
    );
    let login = server.login.unwrap();
    assert_eq!(login.username, "stuffcloud");
    assert_eq!(login.password.expose(), SMTP_PASSWORD);
    // The link redeems once.
    let token = token_of(&mail.text);
    assert_eq!(token.len(), 64);
    let session = app.session_for(alice.id);
    let redeemed = app
        .call(
            Method::POST,
            REDEEM,
            &csrf_headers(),
            Some(&json!({"token": token, "password": "a brand new passphrase"})),
        )
        .await;
    assert_eq!(redeemed.status, 204, "{}", redeemed.text());
    // Every session of the account ended, the new password works, the old one does not.
    let account = app
        .call(
            Method::GET,
            "/api/v1/account",
            &session.read_headers(),
            None,
        )
        .await;
    assert_eq!(account.status, 401);
    let again = app
        .call(
            Method::POST,
            REDEEM,
            &csrf_headers(),
            Some(&json!({"token": token, "password": "yet another passphrase"})),
        )
        .await;
    again.assert_problem(422, "validation-failed");
    for (attempt, status) in [("a brand new passphrase", 200), ("an old passphrase", 401)] {
        let login = app
            .call(
                Method::POST,
                LOGIN,
                &csrf_headers(),
                Some(&json!({"login": "alice", "password": attempt})),
            )
            .await;
        assert_eq!(login.status, status, "{attempt}");
    }
    assert!(
        metrics(&app)
            .await
            .contains("stuffcloud_mail_deliveries_total{result=\"sent\"} 1")
    );
    // Audited by id, with no actor, and nothing personal in it.
    let rows = app.db.audit_log().unwrap();
    let requested = rows
        .iter()
        .find(|row| row.action == "password.reset_requested")
        .unwrap();
    assert_eq!(requested.actor, None);
    assert_eq!(requested.key, alice.id.to_string());
    for row in &rows {
        for text in [Some(&row.action), row.actor.as_ref(), Some(&row.key)]
            .into_iter()
            .flatten()
        {
            assert!(!text.contains("alice") && !text.contains(&token));
        }
    }
}

#[tokio::test]
async fn the_language_and_the_address_are_the_ones_asked_for_and_stored() {
    let app = TestApp::with_mail(Policy::Production);
    let admin = admin(&app).await;
    let _alice = account(&app, "alice", Some("alice@example.org"), Role::User).await;
    let _bob = account(&app, "bob", Some("bob@example.net"), Role::User).await;
    configure(&app, &admin).await;
    // By address, in capitals and with spaces around, in German.
    let reply = app
        .call(
            Method::POST,
            REQUEST,
            &csrf_headers(),
            Some(&json!({"login": "  Alice@Example.ORG ", "language": "de"})),
        )
        .await;
    assert_eq!(reply.status, 202);
    until(|| app.mail.sent().len() == 1).await;
    let mail = app.mail.sent().remove(0);
    assert_eq!(mail.to.as_str(), "alice@example.org");
    assert_eq!(mail.subject, "stuffcloud: Passwort zur\u{fc}cksetzen");
    assert!(mail.text.starts_with("Hallo alice,"));
    // English when the language is null; never an address from the request.
    let reply = app
        .call(
            Method::POST,
            REQUEST,
            &csrf_headers(),
            Some(&json!({"login": "bob", "language": null})),
        )
        .await;
    assert_eq!(reply.status, 202);
    until(|| app.mail.sent().len() == 2).await;
    let mail = app.mail.sent().remove(1);
    assert_eq!(mail.to.as_str(), "bob@example.net");
    assert_eq!(mail.subject, "stuffcloud: reset your password");
    // Any other language, extra member or missing login is refused as a document.
    for body in [
        json!({"login": "bob", "language": "fr"}),
        json!({"login": "bob", "email": "evil@example.com"}),
        json!({"language": "de"}),
        json!({"login": ""}),
    ] {
        let reply = app
            .call(Method::POST, REQUEST, &csrf_headers(), Some(&body))
            .await;
        reply.assert_problem(422, "validation-failed");
    }
    settle().await;
    assert_eq!(app.mail.sent().len(), 2);
}

#[tokio::test]
async fn every_login_gets_the_same_answer_and_only_a_person_with_an_address_gets_mail() {
    let app = TestApp::with_mail(Policy::Production);
    let admin_session = admin(&app).await;
    let _alice = account(&app, "alice", Some("alice@example.org"), Role::User).await;
    let _plain = account(&app, "plain", None, Role::User).await;
    let _boss = account(&app, "boss", Some("boss@example.org"), Role::Admin).await;
    let _robot = app
        .db
        .create_user("robot", UserKind::Service, Role::User, None, EPOCH)
        .unwrap();
    configure(&app, &admin_session).await;
    let mut answers = Vec::new();
    for (index, who) in [
        "alice",
        "nobody",
        "plain",
        "boss",
        "admin",
        "robot",
        "nobody@example.org",
        "boss@example.org",
        "not a login!",
        "a@b",
    ]
    .into_iter()
    .enumerate()
    {
        let reply = ask_from(&app, [198, 51, 100, u8::try_from(index).unwrap()], who).await;
        answers.push((
            reply.status,
            reply.body.clone(),
            reply.header("content-type").map(str::to_owned),
        ));
    }
    assert!(
        answers
            .iter()
            .all(|answer| answer == &(axum::http::StatusCode::ACCEPTED, Vec::new(), None)),
        "{answers:?}"
    );
    until(|| app.mail.sent().len() == 1).await;
    settle().await;
    let sent = app.mail.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].to.as_str(), "alice@example.org");
    // Admin accounts get no link by mail, however they are named.
    let rows = app.db.audit_log().unwrap();
    assert_eq!(
        rows.iter()
            .filter(|row| row.action == "password.reset_requested")
            .count(),
        1
    );
}

#[tokio::test]
async fn an_account_gets_one_token_per_cooldown() {
    let app = TestApp::with_mail(Policy::Production);
    let admin = admin(&app).await;
    let _alice = account(&app, "alice", Some("alice@example.org"), Role::User).await;
    configure(&app, &admin).await;
    for _ in 0..3 {
        assert_eq!(ask(&app, "alice").await.status, 202);
    }
    until(|| app.mail.sent().len() == 1).await;
    settle().await;
    assert_eq!(app.mail.sent().len(), 1);
    // The first link is still the account's token: the later requests did not replace it.
    let first = token_of(&app.mail.sent()[0].text);
    assert!(valid_token(&app, &first));
    // Five minutes later the next request is mailed, and its token replaces the first.
    app.clock.advance(5 * 60_000);
    assert_eq!(ask(&app, "alice").await.status, 202);
    until(|| app.mail.sent().len() == 2).await;
    let second = token_of(&app.mail.sent()[1].text);
    assert_ne!(first, second);
    assert!(!valid_token(&app, &first));
    assert!(valid_token(&app, &second));
}

/// Whether the reset token (as in a link) is the account's valid one now.
fn valid_token(app: &TestApp, token: &str) -> bool {
    let hash = token_hash(&Token::parse(token.as_bytes()).unwrap());
    app.db
        .password_reset_target(&hash, app.clock.now_millis())
        .unwrap()
        .is_some()
}

#[tokio::test]
async fn a_client_is_throttled_after_five_free_requests_whoever_it_asks_about() {
    let app = TestApp::with_mail(Policy::Production);
    let admin = admin(&app).await;
    configure(&app, &admin).await;
    for index in 0..6 {
        let reply = ask(&app, &format!("nobody{index}")).await;
        assert_eq!(reply.status, 202, "request {index}");
    }
    let refused = ask(&app, "nobody-else").await;
    let problem = refused.problem(429, "too-many-requests");
    assert!(
        problem["detail"]
            .as_str()
            .unwrap()
            .starts_with("too many attempts; try again in "),
        "{problem}"
    );
    let wait: u64 = refused.header("retry-after").unwrap().parse().unwrap();
    assert!((1..=60).contains(&wait), "{wait}");
    assert!(
        metrics(&app)
            .await
            .contains("stuffcloud_auth_rejections_total{reason=\"throttled\"} 1")
    );
}

#[tokio::test]
async fn a_full_queue_refuses_the_request_and_nothing_else() {
    let app = TestApp::with_stalled_mail(Policy::Production, 2);
    let admin = admin(&app).await;
    configure(&app, &admin).await;
    for index in 0..2 {
        assert_eq!(ask(&app, "alice").await.status, 202, "{index}");
    }
    let refused = ask(&app, "alice").await;
    let problem = refused.problem(429, "too-many-requests");
    assert_eq!(
        problem["detail"],
        "the server has too many mails waiting; try again in 60 seconds"
    );
    assert_eq!(refused.header("retry-after"), Some("60"));
}

#[tokio::test]
async fn retries_carry_the_mail_through_and_the_end_of_the_schedule_is_counted() {
    let app = TestApp::with_mail(Policy::Production);
    let admin = admin(&app).await;
    let _alice = account(&app, "alice", Some("alice@example.org"), Role::User).await;
    let _bob = account(&app, "bob", Some("bob@example.net"), Role::User).await;
    let _carol = account(&app, "carol", Some("carol@example.com"), Role::User).await;
    configure(&app, &admin).await;
    // Two transient failures, then success: one mail, three attempts.
    app.mail.fail_next(SendError::new(FailureKind::Connection));
    app.mail
        .fail_next(SendError::answered(FailureKind::Deferred, 451));
    assert_eq!(ask(&app, "alice").await.status, 202);
    until(|| app.mail.sent().len() == 1).await;
    assert_eq!(app.mail.attempts(), 3);
    // A refusal for good is one attempt.
    app.mail
        .fail_next(SendError::answered(FailureKind::Rejected, 550));
    assert_eq!(ask(&app, "bob").await.status, 202);
    until(|| metrics_has(&app, "failed", 1)).await;
    assert_eq!(app.mail.attempts(), 4);
    // Five transient failures use up the schedule of four waits.
    for _ in 0..5 {
        app.mail.fail_next(SendError::new(FailureKind::Timeout));
    }
    assert_eq!(ask(&app, "carol").await.status, 202);
    until(|| metrics_has(&app, "failed", 2)).await;
    assert_eq!(app.mail.attempts(), 9);
    assert_eq!(app.mail.sent().len(), 1);
    let text = metrics(&app).await;
    assert!(
        text.contains("stuffcloud_mail_deliveries_total{result=\"retry\"} 6"),
        "{text}"
    );
    assert!(text.contains("stuffcloud_mail_deliveries_total{result=\"sent\"} 1"));
}

fn metrics_has(app: &TestApp, result: &str, count: u32) -> bool {
    // Read straight from the state: no request needed.
    let text = app.state.metrics().render().unwrap();
    text.contains(&format!(
        "stuffcloud_mail_deliveries_total{{result=\"{result}\"}} {count}"
    ))
}

#[tokio::test]
async fn the_smtp_group_follows_the_conventions_and_never_holds_a_secret() {
    let app = TestApp::with_mail(Policy::Production);
    let admin = admin(&app).await;
    // Never written: 404 for an admin, 401 and 403 for the others (the group is not public).
    assert_eq!(
        app.call(Method::GET, SMTP, &admin.read_headers(), None)
            .await
            .status,
        404
    );
    assert_eq!(app.get(SMTP).await.status, 401);
    let user = app.login("user", Role::User);
    let forbidden = app
        .call(Method::GET, SMTP, &user.read_headers(), None)
        .await;
    assert_eq!(forbidden.status, 403);
    let forbidden = app
        .call(Method::PUT, SMTP, &user.write_headers(), Some(&smtp_body()))
        .await;
    assert_eq!(forbidden.status, 403);
    // A dry run changes nothing and shows the diff.
    let dry = app
        .call(
            Method::PUT,
            &format!("{SMTP}?dry_run=true"),
            &admin.write_headers(),
            Some(&smtp_body()),
        )
        .await;
    assert_eq!(dry.status, 200, "{}", dry.text());
    assert_eq!(dry.json()["dry_run"], true);
    assert_eq!(dry.json()["result"], "created");
    assert_eq!(app.get(FEATURES).await.json(), json!({"mail": false}));
    configure(&app, &admin).await;
    let read = app
        .call(Method::GET, SMTP, &admin.read_headers(), None)
        .await;
    assert_eq!(read.status, 200);
    let document = read.json();
    for (field, value) in smtp_body().as_object().unwrap() {
        assert_eq!(&document[field], value, "{field}");
    }
    assert!(document["meta"]["etag"].is_string());
    // Only the name of the variable is stored; the value never is, in any answer or the log.
    let text = format!(
        "{document} {}",
        app.db.get("settings", "smtp").unwrap().unwrap().body
    );
    assert!(!text.contains(SMTP_PASSWORD));
    let rows = format!("{:?}", app.db.audit_log().unwrap());
    assert!(!rows.contains(SMTP_PASSWORD));
    // The same document again is unchanged.
    let same = app
        .call(
            Method::PUT,
            SMTP,
            &admin.write_headers(),
            Some(&smtp_body()),
        )
        .await;
    assert_eq!(same.status, 200);
    assert_eq!(same.json()["result"], "unchanged");
}

#[tokio::test]
async fn the_smtp_group_refuses_a_secret_value_plain_credentials_and_injection() {
    let app = TestApp::with_mail(Policy::Production);
    let admin = admin(&app).await;
    let put = |body: Value| {
        let headers = admin.write_headers();
        let app = &app;
        async move { app.call(Method::PUT, SMTP, &headers, Some(&body)).await }
    };
    let pointers = |reply: &Reply| -> Vec<String> {
        reply.problem(422, "validation-failed")["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|error| error["pointer"].as_str().unwrap().to_owned())
            .collect()
    };
    let with = |field: &str, value: Value| {
        let mut body = smtp_body();
        body[field] = value;
        body
    };
    // The write-only forms of #152 do not exist yet.
    for member in [
        json!({"value": "hunter2"}),
        json!({"stored": true}),
        json!("hunter2"),
        json!({"ref": "PATH"}),
        json!({"ref": "STUFFCLOUD_SECRET_SMTP_FILE"}),
        json!({"ref": "STUFFCLOUD_SECRETS_KEY_FILE"}),
    ] {
        let reply = put(with("password", member.clone())).await;
        let found = pointers(&reply);
        assert!(
            found.iter().any(|pointer| pointer.starts_with("/password")),
            "{member}: {found:?}"
        );
        assert!(!reply.text().contains("hunter2"), "{}", reply.text());
    }
    // A login over a plain connection, an unreachable host, a header injection.
    let plain = put(with("security", json!("none"))).await;
    assert_eq!(pointers(&plain), ["/security"]);
    let injected_host = put(with(
        "host",
        json!("smtp.example.com\r\nRCPT TO:<x@example.com>"),
    ))
    .await;
    assert_eq!(pointers(&injected_host), ["/host"]);
    let injected_name = put(with("from_name", json!("x\r\nBcc: victim@example.net"))).await;
    assert_eq!(pointers(&injected_name), ["/from_name"]);
    let injected_from = put(with(
        "from",
        json!("a@example.com\r\nBcc: victim@example.net"),
    ))
    .await;
    assert_eq!(pointers(&injected_from), ["/from"]);
    let port = put(with("port", json!(0))).await;
    assert_eq!(pointers(&port), ["/port"]);
    let big_port = put(with("port", json!(70000))).await;
    assert_eq!(pointers(&big_port), ["/port"]);
    // Nothing of that was stored.
    assert_eq!(app.get(FEATURES).await.json(), json!({"mail": false}));
    // A plain connection without a login is the local mail catcher.
    let mut catcher = smtp_body();
    catcher["host"] = json!("mailpit");
    catcher["port"] = json!(1025);
    catcher["security"] = json!("none");
    catcher["username"] = Value::Null;
    catcher["password"] = Value::Null;
    catcher["from_name"] = Value::Null;
    assert_eq!(put(catcher).await.status, 201);
}

#[tokio::test]
async fn the_dev_stack_bootstrap_sets_mail_up_for_the_catcher() {
    let raw = include_bytes!("../../../../docker/app/bootstrap.dev.json");
    let writes = stuffcloud_app::bootstrap::parse_file(raw).unwrap();
    let smtp = writes
        .iter()
        .find(|(_kind, key, _body)| *key == "smtp")
        .expect("bootstrap.dev.json has no smtp group");
    let parsed: stuffcloud_core::smtp::Smtp = serde_json::from_str(&smtp.2).unwrap();
    // The compose service is reached by its name, in plain text, without a login.
    assert_eq!(parsed.host, "mailpit");
    assert_eq!(parsed.port, 1025);
    assert_eq!(parsed.security, stuffcloud_core::smtp::SmtpSecurity::None);
    assert_eq!((parsed.username, parsed.password), (None, None));
    assert_eq!(parsed.from, "noreply@stuff.localhost");
    // The stack lets the smoke test register an account to ask for a reset mail.
    let signup = writes
        .iter()
        .find(|(_kind, key, _body)| *key == "signup")
        .expect("bootstrap.dev.json has no signup group");
    assert_eq!(signup.2, r#"{"mode":"open"}"#);
}
