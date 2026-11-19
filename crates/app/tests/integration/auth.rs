//! Sessions, CSRF and cookie scope (A-02, acceptance criteria of #32; SPEC 5.5 and 14):
//!
//! - every `Set-Cookie` of every route is a `__Host-` cookie with `Secure`, `Path=/`,
//!   `HttpOnly`, `SameSite` and without `Domain`;
//! - every state-changing route refuses a missing or foreign `Origin`, a cross-site
//!   `Sec-Fetch-Site` and a missing or wrong CSRF token;
//! - cookies tossed by a same-site host (unprefixed, differently cased, duplicated) are ignored;
//! - session fixation, rotation, idle and absolute timeouts, logout and logout everywhere;
//! - the audit log holds no personal data.
//!
//! Hosts are RFC 2606 names: the app at `app.example.com`, a hosted site at
//! `site.example.com` (same registrable domain, so same-site).

use axum::http::{Method, Request};
use serde_json::{Value, json};
use stuffcloud_app::auth::{Authentication, rotate_session, start_session};
use stuffcloud_app::state::Clock;
use stuffcloud_core::session::Role;
use stuffcloud_core::token::Token;
use stuffcloud_db::{SessionLookup, token_hash};

use crate::common::{
    APP_ORIGIN, Browser, CSRF, Policy, Reply, SITE_ORIGIN, TIMEOUTS, TestApp, csrf_headers,
};

const SETTINGS: &str = "/api/v1/settings/reserved-names";
const SESSION: &str = "/api/v1/auth/session";
const SESSIONS: &str = "/api/v1/auth/sessions";

/// Every operation of the OpenAPI document (method, path), plus paths no route matches.
fn operations() -> Vec<(Method, String)> {
    let document = serde_json::to_value(stuffcloud_app::openapi::document()).unwrap();
    let mut found = Vec::new();
    for (path, item) in document["paths"].as_object().unwrap() {
        for method in item.as_object().unwrap().keys() {
            found.push((
                Method::from_bytes(method.to_ascii_uppercase().as_bytes()).unwrap(),
                path.clone(),
            ));
        }
    }
    for method in [Method::POST, Method::PUT, Method::DELETE, Method::PATCH] {
        found.push((method, "/api/v1/no-such-route".to_owned()));
    }
    found.push((Method::GET, "/api/v1/no-such-route".to_owned()));
    found
}

fn is_write(method: &Method) -> bool {
    !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

/// A body for the routes that take one.
fn body_for(method: &Method, path: &str) -> Option<Value> {
    (*method == Method::PUT && path == SETTINGS).then(|| json!({"names": ["intranet"]}))
}

fn header(name: &str, value: &str) -> (String, String) {
    (name.to_owned(), value.to_owned())
}

/// Asserts the cookie rules of SPEC 5.5 on one `Set-Cookie` value.
fn assert_host_only(set_cookie: &str) {
    assert!(set_cookie.starts_with("__Host-"), "{set_cookie}");
    let attributes: Vec<String> = set_cookie
        .split(';')
        .skip(1)
        .map(|attribute| attribute.trim().to_ascii_lowercase())
        .collect();
    for required in ["path=/", "secure", "httponly"] {
        assert!(
            attributes.iter().any(|a| a == required),
            "{required} missing: {set_cookie}"
        );
    }
    assert!(
        attributes
            .iter()
            .any(|a| a == "samesite=lax" || a == "samesite=strict"),
        "{set_cookie}"
    );
    assert!(
        !attributes.iter().any(|a| a.starts_with("domain")),
        "{set_cookie}"
    );
    assert!(
        !set_cookie.to_ascii_lowercase().contains("domain"),
        "{set_cookie}"
    );
}

async fn session_state(app: &TestApp, headers: &[(String, String)]) -> (Reply, Value) {
    let reply = app.call(Method::GET, SESSION, headers, None).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    let json = reply.json();
    (reply, json)
}

#[tokio::test]
async fn every_set_cookie_of_every_route_is_host_only() {
    let mut seen = 0;
    for (method, path) in operations() {
        let app = TestApp::new(Policy::Production);
        let admin = app.login("admin", Role::Admin);
        let invalid = vec![header("cookie", "__Host-stuffcloud-session=not-a-token")];
        let unknown = vec![
            header("origin", APP_ORIGIN),
            header("x-csrf-token", CSRF),
            header(
                "cookie",
                &format!(
                    "__Host-stuffcloud-session={}; __Host-stuffcloud-csrf={CSRF}",
                    Token::from_bytes([9; 32]).to_hex()
                ),
            ),
        ];
        for headers in [
            Vec::new(),
            csrf_headers(),
            invalid,
            unknown,
            admin.write_headers(),
        ] {
            let reply = app
                .call(
                    method.clone(),
                    &path,
                    &headers,
                    body_for(&method, &path).as_ref(),
                )
                .await;
            for set_cookie in reply.set_cookies() {
                assert_host_only(&set_cookie);
                seen += 1;
            }
            assert!(
                reply.header("access-control-allow-origin").is_none(),
                "{method} {path}"
            );
        }
    }
    // The routes really set cookies (session state, logout, clearing a bad cookie), so the
    // loop above checked something.
    assert!(seen >= 10, "only {seen} Set-Cookie headers seen");
}

/// Writes from the admin's browser that break one rule each, with the expected detail.
fn refusal_cases(admin: &Browser) -> Vec<(Vec<(String, String)>, &'static str)> {
    let cookie = admin.cookie();
    let token = admin.csrf.to_hex();
    let other = Token::from_bytes([7; 32]).to_hex();
    vec![
        (
            vec![header("x-csrf-token", &token), header("cookie", &cookie)],
            "the request has no Origin header",
        ),
        (
            vec![
                header("origin", SITE_ORIGIN),
                header("x-csrf-token", &token),
                header("cookie", &cookie),
            ],
            "the Origin header is not the app origin",
        ),
        (
            vec![
                header("origin", "null"),
                header("x-csrf-token", &token),
                header("cookie", &cookie),
            ],
            "the Origin header is not exactly one valid origin",
        ),
        (
            vec![
                header("origin", "http://app.example.com"),
                header("x-csrf-token", &token),
                header("cookie", &cookie),
            ],
            "the Origin header is not the app origin",
        ),
        (
            vec![
                header("origin", APP_ORIGIN),
                header("sec-fetch-site", "same-site"),
                header("x-csrf-token", &token),
                header("cookie", &cookie),
            ],
            "Sec-Fetch-Site is not same-origin",
        ),
        (
            vec![
                header("origin", APP_ORIGIN),
                header("sec-fetch-site", "cross-site"),
                header("x-csrf-token", &token),
                header("cookie", &cookie),
            ],
            "Sec-Fetch-Site is not same-origin",
        ),
        (
            vec![header("origin", APP_ORIGIN), header("cookie", &cookie)],
            "the CSRF token is missing (X-CSRF-Token header and cookie)",
        ),
        (
            vec![
                header("origin", APP_ORIGIN),
                header("x-csrf-token", &token),
                header(
                    "cookie",
                    &format!("__Host-stuffcloud-session={}", admin.token.to_hex()),
                ),
            ],
            "the CSRF token is missing (X-CSRF-Token header and cookie)",
        ),
        (
            vec![
                header("origin", APP_ORIGIN),
                header("x-csrf-token", &other),
                header("cookie", &cookie),
            ],
            "the CSRF token does not match",
        ),
        (
            vec![
                header("origin", APP_ORIGIN),
                header("x-csrf-token", "not-a-token"),
                header("cookie", &cookie),
            ],
            "the CSRF token is malformed",
        ),
        // Header and cookie agree, but the token is not the one bound to the session.
        (
            vec![
                header("origin", APP_ORIGIN),
                header("x-csrf-token", &other),
                header(
                    "cookie",
                    &format!(
                        "__Host-stuffcloud-session={}; __Host-stuffcloud-csrf={other}",
                        admin.token.to_hex()
                    ),
                ),
            ],
            "the CSRF token does not match",
        ),
    ]
}

#[tokio::test]
async fn every_state_changing_route_refuses_cross_site_requests() {
    let mut checked = 0;
    for (method, path) in operations().into_iter().filter(|(m, _)| is_write(m)) {
        let app = TestApp::new(Policy::Production);
        let admin = app.login("admin", Role::Admin);
        let cases = refusal_cases(&admin);
        let audit_before = app.db.audit_log().unwrap();
        for (headers, detail) in cases {
            let reply = app
                .call(
                    method.clone(),
                    &path,
                    &headers,
                    body_for(&method, &path).as_ref(),
                )
                .await;
            let problem = reply.problem(403, "csrf-rejected");
            assert_eq!(problem["detail"], detail, "{method} {path}");
            checked += 1;
        }
        // Nothing was written by the refused requests: the session is still there.
        assert_eq!(app.db.audit_log().unwrap(), audit_before, "{method} {path}");
        assert_eq!(app.db.session_count(admin.session.user.id).unwrap(), 1);
        // With everything right, the request reaches the route.
        let reply = app
            .call(
                method.clone(),
                &path,
                &admin.write_headers(),
                body_for(&method, &path).as_ref(),
            )
            .await;
        assert_ne!(
            reply.status.as_u16(),
            403,
            "{method} {path}: {}",
            reply.text()
        );
    }
    assert!(checked >= 7 * 11, "only {checked} refusals checked");
}

#[tokio::test]
async fn anonymous_writes_need_the_csrf_checks_too() {
    let app = TestApp::new(Policy::Production);
    let body = json!({"names": ["intranet"]});
    app.call(Method::PUT, SETTINGS, &[], Some(&body))
        .await
        .assert_problem(403, "csrf-rejected");
    let mut wrong = csrf_headers();
    wrong[1].1 = Token::from_bytes([1; 32]).to_hex();
    app.call(Method::PUT, SETTINGS, &wrong, Some(&body))
        .await
        .assert_problem(403, "csrf-rejected");
    // Passing the checks leads to the access policy.
    app.call(Method::PUT, SETTINGS, &csrf_headers(), Some(&body))
        .await
        .assert_problem(401, "unauthenticated");
}

#[tokio::test]
async fn tossed_cookies_are_ignored() {
    let app = TestApp::new(Policy::Production);
    let admin = app.login("admin", Role::Admin);
    let valid = admin.token.to_hex();
    let attacker = app.login("mallory", Role::User);
    let tossed = attacker.token.to_hex();
    // The real cookie works.
    let (_, state) = session_state(&app, &admin.read_headers()).await;
    assert_eq!(state["authenticated"], true);
    assert_eq!(state["user"]["role"], "admin");
    for cookie in [
        format!("stuffcloud-session={valid}"),
        format!("__host-stuffcloud-session={valid}"),
        format!("__HOST-stuffcloud-session={valid}"),
        format!("__Secure-stuffcloud-session={valid}"),
        format!("session={valid}"),
        // A site set a second cookie of the same name (for the parent domain): ambiguous.
        format!("__Host-stuffcloud-session={tossed}; __Host-stuffcloud-session={valid}"),
        format!("__Host-stuffcloud-session={valid}; __Host-stuffcloud-session={tossed}"),
    ] {
        let (reply, state) = session_state(&app, &[header("cookie", &cookie)]).await;
        assert_eq!(state["authenticated"], false, "{cookie}");
        assert!(state.get("user").is_none(), "{cookie}");
        if cookie.starts_with("__Host-") {
            assert!(
                reply
                    .set_cookies()
                    .contains(&"__Host-stuffcloud-session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0".to_owned()),
                "{cookie}"
            );
        }
    }
    // A tossed cookie never gives a write the admin's rights.
    let mut headers = csrf_headers();
    headers[2].1 = format!("__Host-stuffcloud-csrf={CSRF}; stuffcloud-session={valid}");
    app.call(
        Method::PUT,
        SETTINGS,
        &headers,
        Some(&json!({"names": ["x"]})),
    )
    .await
    .assert_problem(401, "unauthenticated");
}

#[tokio::test]
async fn the_session_endpoint_hands_out_csrf_tokens() {
    let app = TestApp::new(Policy::Production);
    // Anonymous, no cookie: a new token, set as a cookie.
    let (reply, state) = session_state(&app, &[]).await;
    assert_eq!(state["authenticated"], false);
    let token = state["csrf_token"].as_str().unwrap().to_owned();
    assert!(Token::parse(token.as_bytes()).is_ok());
    assert_eq!(
        reply.set_cookies(),
        vec![format!(
            "__Host-stuffcloud-csrf={token}; Path=/; Secure; HttpOnly; SameSite=Strict"
        )]
    );
    assert_eq!(
        state.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["authenticated", "csrf_token"]
    );
    // With the cookie: the same token, no new cookie.
    let cookie = vec![header("cookie", &format!("__Host-stuffcloud-csrf={token}"))];
    let (reply, state) = session_state(&app, &cookie).await;
    assert_eq!(state["csrf_token"], token);
    assert!(reply.set_cookies().is_empty());
    // A malformed cookie is replaced.
    let (reply, state) =
        session_state(&app, &[header("cookie", "__Host-stuffcloud-csrf=zz")]).await;
    assert_ne!(state["csrf_token"], "zz");
    assert_eq!(reply.set_cookies().len(), 1);
}

#[tokio::test]
async fn a_session_gets_its_bound_token_or_a_new_one() {
    let app = TestApp::new(Policy::Production);
    let admin = app.login("alice", Role::Admin);
    let (reply, state) = session_state(&app, &admin.read_headers()).await;
    assert!(reply.set_cookies().is_empty());
    assert_eq!(state["authenticated"], true);
    assert_eq!(state["csrf_token"], admin.csrf.to_hex());
    assert_eq!(
        state["user"],
        json!({"login": "alice", "role": "admin", "kind": "person"})
    );
    let times = &state["session"];
    for field in ["created_at", "idle_expires_at", "absolute_expires_at"] {
        assert!(times[field].as_str().unwrap().ends_with('Z'), "{times}");
    }
    assert_ne!(times["created_at"], times["idle_expires_at"]);
    assert_ne!(times["idle_expires_at"], times["absolute_expires_at"]);

    // The browser lost its CSRF cookie (or holds an anonymous one): a new token is bound.
    for cookie in [
        format!("__Host-stuffcloud-session={}", admin.token.to_hex()),
        format!(
            "__Host-stuffcloud-session={}; __Host-stuffcloud-csrf={CSRF}",
            admin.token.to_hex()
        ),
    ] {
        let (reply, state) = session_state(&app, &[header("cookie", &cookie)]).await;
        let fresh = state["csrf_token"].as_str().unwrap().to_owned();
        assert_ne!(fresh, admin.csrf.to_hex());
        assert_ne!(fresh, CSRF);
        assert_eq!(reply.set_cookies().len(), 1);
        let bound = Browser {
            csrf: Token::parse(fresh.as_bytes()).unwrap(),
            ..admin.clone()
        };
        let write = app
            .call(
                Method::PUT,
                SETTINGS,
                &bound.write_headers(),
                Some(&json!({"names": [format!("n{}", fresh.get(..6).unwrap())]})),
            )
            .await;
        assert!(write.status.is_success(), "{}", write.text());
        // The old token no longer belongs to the session.
        app.call(
            Method::PUT,
            SETTINGS,
            &admin.write_headers(),
            Some(&json!({"names": []})),
        )
        .await
        .assert_problem(403, "csrf-rejected");
    }
}

#[tokio::test]
async fn writes_need_an_admin_session() {
    let app = TestApp::new(Policy::Production);
    let body = json!({"names": ["intranet"]});
    let user = app.login("user", Role::User);
    let moderator = app.login("moderator", Role::Moderator);
    let admin = app.login("admin", Role::Admin);
    for browser in [&user, &moderator] {
        let problem = app
            .call(Method::PUT, SETTINGS, &browser.write_headers(), Some(&body))
            .await
            .problem(403, "forbidden");
        assert_eq!(problem["detail"], "only an admin may change this");
    }
    let created = app
        .call(Method::PUT, SETTINGS, &admin.write_headers(), Some(&body))
        .await;
    assert_eq!(created.status.as_u16(), 201, "{}", created.text());
    let entry = app
        .db
        .audit_log()
        .unwrap()
        .into_iter()
        .rev()
        .find(|entry| entry.category == "resource")
        .unwrap();
    assert_eq!(entry.action, "created");
    // Reads stay open.
    let read = app.get(SETTINGS).await;
    assert_eq!(read.status.as_u16(), 200);
}

#[tokio::test]
async fn logout_ends_the_session_and_clears_the_cookies() {
    let app = TestApp::new(Policy::Production);
    let alice = app.login("alice", Role::User);
    let other = app.session_for(alice.session.user.id);
    let reply = app
        .call(Method::DELETE, SESSION, &alice.write_headers(), None)
        .await;
    assert_eq!(reply.status.as_u16(), 204, "{}", reply.text());
    assert_eq!(
        reply.set_cookies(),
        vec![
            "__Host-stuffcloud-session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
            "__Host-stuffcloud-csrf=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
        ]
    );
    let (_, state) = session_state(&app, &alice.read_headers()).await;
    assert_eq!(state["authenticated"], false);
    // The other session of the account is untouched.
    let (_, state) = session_state(&app, &other.read_headers()).await;
    assert_eq!(state["authenticated"], true);
    // Without a session there is nothing to end.
    for path in [SESSION, SESSIONS] {
        let problem = app
            .call(Method::DELETE, path, &csrf_headers(), None)
            .await
            .problem(401, "unauthenticated");
        assert_eq!(problem["detail"], "there is no session");
    }
    let actions: Vec<String> = app
        .db
        .audit_log()
        .unwrap()
        .into_iter()
        .map(|entry| entry.action)
        .collect();
    assert!(actions.contains(&"session.ended".to_owned()), "{actions:?}");
}

#[tokio::test]
async fn logout_everywhere_ends_every_session_of_the_account() {
    let app = TestApp::new(Policy::Production);
    let alice = app.login("alice", Role::User);
    let laptop = app.session_for(alice.session.user.id);
    let phone = app.session_for(alice.session.user.id);
    let bob = app.login("bob", Role::User);
    let reply = app
        .call(Method::DELETE, SESSIONS, &phone.write_headers(), None)
        .await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    assert_eq!(reply.json(), json!({"ended": 3}));
    assert_eq!(reply.set_cookies().len(), 2);
    for browser in [&alice, &laptop, &phone] {
        let (_, state) = session_state(&app, &browser.read_headers()).await;
        assert_eq!(state["authenticated"], false);
    }
    let (_, state) = session_state(&app, &bob.read_headers()).await;
    assert_eq!(state["authenticated"], true);
}

#[tokio::test]
async fn idle_and_absolute_timeouts_end_sessions() {
    let app = TestApp::new(Policy::Production);
    let idle = app.login("idle", Role::User);
    app.clock.advance(TIMEOUTS.idle_ms / 2);
    let (_, state) = session_state(&app, &idle.read_headers()).await;
    assert_eq!(state["authenticated"], true, "half the idle time");
    app.clock.advance(TIMEOUTS.idle_ms + 1);
    let (reply, state) = session_state(&app, &idle.read_headers()).await;
    assert_eq!(state["authenticated"], false, "idle timeout");
    assert!(
        reply
            .set_cookies()
            .iter()
            .any(|cookie| cookie.starts_with("__Host-stuffcloud-session=;"))
    );

    let busy = app.login("busy", Role::User);
    let mut used = 0;
    while used < TIMEOUTS.absolute_ms - TIMEOUTS.idle_ms / 2 {
        app.clock.advance(TIMEOUTS.idle_ms / 2);
        used += TIMEOUTS.idle_ms / 2;
        let (_, state) = session_state(&app, &busy.read_headers()).await;
        assert_eq!(state["authenticated"], true, "used for {used} ms");
    }
    // Used five minutes ago, so only the absolute timeout can end it now.
    app.clock.advance(TIMEOUTS.idle_ms / 2);
    let (_, state) = session_state(&app, &busy.read_headers()).await;
    assert_eq!(state["authenticated"], false, "absolute timeout");
    let expired = app
        .db
        .audit_log()
        .unwrap()
        .into_iter()
        .filter(|entry| entry.action == "session.expired")
        .count();
    assert_eq!(expired, 2);
}

/// The request parts of a browser, with the authentication the middleware would attach.
fn parts_of(app_session: Option<stuffcloud_db::Session>) -> axum::http::request::Parts {
    let (mut parts, ()) = Request::new(()).into_parts();
    if let Some(session) = app_session {
        let _ = parts.extensions.insert(Authentication::Session(session));
    }
    parts
}

#[tokio::test]
async fn login_never_keeps_a_presented_session() {
    let app = TestApp::new(Policy::Production);
    let presented = app.login("alice", Role::User);
    let user_id = presented.session.user.id;
    let (session, tokens) = start_session(
        &app.state,
        &parts_of(Some(presented.session.clone())),
        user_id,
    )
    .await
    .unwrap();
    assert_ne!(session.id, presented.session.id);
    assert_ne!(tokens.session, presented.token);
    assert_ne!(tokens.csrf, presented.csrf);
    let now = app.clock.now_millis();
    assert_eq!(
        app.db
            .find_session(&token_hash(&presented.token), &TIMEOUTS, now)
            .unwrap(),
        SessionLookup::Unknown,
        "the presented session id is gone"
    );
    let (_, state) = session_state(
        &app,
        &[header(
            "cookie",
            &format!("__Host-stuffcloud-session={}", tokens.session.to_hex()),
        )],
    )
    .await;
    assert_eq!(state["authenticated"], true);
    // Without a presented session a login simply adds one.
    let (_second, _) = start_session(&app.state, &parts_of(None), user_id)
        .await
        .unwrap();
    assert_eq!(app.db.session_count(user_id).unwrap(), 2);
    // A service account cannot log in.
    let robot = app
        .db
        .create_user(
            "robot",
            stuffcloud_core::session::UserKind::Service,
            Role::Admin,
            None,
            0,
        )
        .unwrap();
    assert!(
        start_session(&app.state, &parts_of(None), robot.id)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn rotation_replaces_both_tokens() {
    let app = TestApp::new(Policy::Production);
    let alice = app.login("alice", Role::User);
    let tokens = rotate_session(&app.state, &alice.session).await.unwrap();
    let (_, state) = session_state(&app, &alice.read_headers()).await;
    assert_eq!(state["authenticated"], false, "the old token is dead");
    let rotated = Browser {
        session: alice.session.clone(),
        token: tokens.session,
        csrf: tokens.csrf,
    };
    let (_, state) = session_state(&app, &rotated.read_headers()).await;
    assert_eq!(state["authenticated"], true);
    assert_eq!(state["csrf_token"], rotated.csrf.to_hex());
    // A session that has ended cannot be rotated.
    assert!(app.db.end_session(alice.session.id, 0).unwrap());
    let problem = rotate_session(&app.state, &alice.session)
        .await
        .unwrap_err();
    assert_eq!(
        problem.kind(),
        stuffcloud_app::problem::ProblemKind::Unauthenticated
    );
}

#[tokio::test]
async fn a_role_change_logs_the_account_out() {
    let app = TestApp::new(Policy::Production);
    let alice = app.login("alice", Role::User);
    let change = app
        .db
        .set_role(alice.session.user.id, Role::Admin, Some("user:1"), 0)
        .unwrap();
    assert_eq!(change.ended_sessions, 1);
    let (_, state) = session_state(&app, &alice.read_headers()).await;
    assert_eq!(state["authenticated"], false);
    // The new privilege comes only with a new login: the old cookies are anonymous now.
    app.call(
        Method::PUT,
        SETTINGS,
        &alice.write_headers(),
        Some(&json!({"names": []})),
    )
    .await
    .assert_problem(401, "unauthenticated");
}

#[tokio::test]
async fn an_authorization_header_turns_cookies_off() {
    let app = TestApp::new(Policy::AllowAll);
    let admin = app.login("admin", Role::Admin);
    let mut headers = admin.read_headers();
    headers.push(header("authorization", "Bearer x"));
    let (_, state) = session_state(&app, &headers).await;
    assert_eq!(state["authenticated"], false, "the cookie is ignored");
    // API clients send no Origin; the access policy decides (here: allow all).
    let reply = app
        .call(
            Method::PUT,
            SETTINGS,
            &[header("authorization", "Bearer x")],
            Some(&json!({"names": ["intranet"]})),
        )
        .await;
    assert_eq!(reply.status.as_u16(), 201, "{}", reply.text());
}

#[tokio::test]
async fn no_cors_for_site_origins() {
    let app = TestApp::new(Policy::Production);
    let preflight = app
        .call(
            Method::OPTIONS,
            SETTINGS,
            &[
                header("origin", SITE_ORIGIN),
                header("access-control-request-method", "PUT"),
                header("access-control-request-headers", "x-csrf-token"),
            ],
            None,
        )
        .await;
    let get = app
        .call(Method::GET, SESSION, &[header("origin", SITE_ORIGIN)], None)
        .await;
    for reply in [preflight, get] {
        for (name, _) in &reply.headers {
            assert!(
                !name.as_str().starts_with("access-control-"),
                "{name} on {}",
                reply.status
            );
        }
    }
}

#[tokio::test]
async fn the_audit_log_holds_no_personal_data() {
    let app = TestApp::new(Policy::Production);
    let alice = app.login("alice.private", Role::Admin);
    let _ = session_state(&app, &alice.read_headers()).await;
    let _ = app
        .call(
            Method::PUT,
            SETTINGS,
            &alice.write_headers(),
            Some(&json!({"names": ["intranet"]})),
        )
        .await;
    let laptop = app.session_for(alice.session.user.id);
    let _ = app
        .call(Method::DELETE, SESSION, &laptop.write_headers(), None)
        .await;
    let _ = app
        .call(Method::DELETE, SESSIONS, &alice.write_headers(), None)
        .await;
    let log = app.db.audit_log().unwrap();
    let actions: Vec<&str> = log.iter().map(|entry| entry.action.as_str()).collect();
    assert_eq!(
        actions,
        [
            "user.created",
            "session.created",
            "created",
            "session.created",
            "session.ended",
            "session.ended_all"
        ]
    );
    let secrets = [
        alice.token.to_hex(),
        alice.csrf.to_hex(),
        laptop.token.to_hex(),
        laptop.csrf.to_hex(),
    ];
    for entry in &log {
        let text = format!("{entry:?}");
        assert!(!text.contains("alice"), "{text}");
        assert!(!text.contains("127.0.0.1"), "{text}");
        for secret in &secrets {
            assert!(!text.contains(secret.as_str()), "{text}");
        }
    }
    let actor = format!("user:{}", alice.session.user.id);
    assert_eq!(log[2].actor.as_deref(), Some(actor.as_str()));
}
