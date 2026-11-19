//! Central authorisation (A-07, acceptance criteria of #37):
//!
//! - every operation of the OpenAPI document has a declared policy, and the routes of the
//!   application are exactly those operations;
//! - the matrix test: every caller (anonymous, each role with a session, a service account's
//!   session, tokens of each role with several scope sets) against every declared route gets the
//!   status the matrix says, including a token with admin scopes owned by a non-admin and a
//!   service account trying to log in interactively;
//! - the expectations below are written out by hand and independently of `stuffcloud-core`, so
//!   a mistake in the policy cannot hide behind itself;
//! - refusals are counted, audited without personal data and rate limited; a role change ends
//!   the sessions of the account.

use axum::Router;
use axum::extract::Request;
use axum::http::{Method, Request as HttpRequest};
use axum::middleware::{Next, from_fn};
use serde_json::json;
use stuffcloud_app::access::{Declared, operations, verify};
use stuffcloud_app::auth::{ApiCaller, Authentication, start_session};
use stuffcloud_app::server::{declared_routes, endpoints};
use stuffcloud_app::state::Clock;
use stuffcloud_core::policy::Requirement;
use stuffcloud_core::scope::Scopes;
use stuffcloud_core::session::{Role, UserKind};
use stuffcloud_db::{Session, User};
use tower::ServiceExt;

use crate::common::{Policy, TestApp, csrf_headers};

const SETTINGS: &str = "/api/v1/settings/reserved-names";

/// Who may use what, written out by hand: the permission, whether anonymous clients have it and
/// the lowest role that does.
const MATRIX: [(&str, bool, Role); 18] = [
    ("sites:read", false, Role::User),
    ("sites:write", true, Role::User),
    ("account:read", false, Role::User),
    ("account:write", false, Role::User),
    ("tokens:read", false, Role::User),
    ("tokens:write", false, Role::User),
    ("admin:zones:read", false, Role::Admin),
    ("admin:zones:write", false, Role::Admin),
    ("admin:users:read", false, Role::Admin),
    ("admin:users:write", false, Role::Admin),
    ("admin:settings:read", false, Role::Admin),
    ("admin:settings:write", false, Role::Admin),
    ("admin:blocklist:read", false, Role::Moderator),
    ("admin:blocklist:write", false, Role::Moderator),
    ("admin:tokens:read", false, Role::Admin),
    ("admin:tokens:write", false, Role::Admin),
    ("moderation:read", false, Role::Moderator),
    ("moderation:write", false, Role::Moderator),
];

/// A caller of the matrix test.
#[derive(Debug, Clone)]
enum Caller {
    Anonymous,
    /// A browser session of an account.
    Session {
        role: Role,
        kind: UserKind,
    },
    /// An API token: the owner and the scopes.
    Token {
        role: Role,
        kind: UserKind,
        scopes: &'static [&'static str],
    },
}

/// What the matrix says should happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Expected {
    Allowed,
    Status(u16),
}

fn lowest_role(permission: &str) -> (bool, Role) {
    let (_, anonymous, role) = MATRIX
        .iter()
        .find(|(name, _, _)| *name == permission)
        .copied()
        .unwrap();
    (anonymous, role)
}

/// Whether the scope grants the permission: the same area, and `write` grants `read` too.
fn scope_grants(scope: &str, permission: &str) -> bool {
    let (scope_area, scope_level) = scope.rsplit_once(':').unwrap();
    let (area, level) = permission.rsplit_once(':').unwrap();
    scope_area == area && (scope_level == "write" || level == "read")
}

/// The requirement of a route in the words of the hand-written matrix.
fn need(requirement: Requirement) -> Option<(bool, Option<String>)> {
    // (is a session route, permission)
    match requirement {
        Requirement::Public => None,
        Requirement::Session => Some((true, None)),
        Requirement::Permit(permission) => Some((false, Some(permission.to_string()))),
    }
}

fn expected(caller: &Caller, requirement: Requirement) -> Expected {
    let Some((session_route, permission)) = need(requirement) else {
        return Expected::Allowed;
    };
    if session_route {
        return match caller {
            Caller::Anonymous => Expected::Status(401),
            Caller::Token { .. }
            | Caller::Session {
                kind: UserKind::Service,
                ..
            } => Expected::Status(403),
            Caller::Session {
                kind: UserKind::Person,
                ..
            } => Expected::Allowed,
        };
    }
    let permission = permission.unwrap();
    let (anonymous, lowest) = lowest_role(&permission);
    match caller {
        Caller::Anonymous if anonymous => Expected::Allowed,
        Caller::Anonymous => Expected::Status(401),
        Caller::Session {
            kind: UserKind::Service,
            ..
        } => Expected::Status(403),
        Caller::Session { role, .. } if *role >= lowest => Expected::Allowed,
        Caller::Session { .. } => Expected::Status(403),
        Caller::Token { role, scopes, .. } => {
            if scopes.iter().any(|scope| scope_grants(scope, &permission)) && *role >= lowest {
                Expected::Allowed
            } else {
                Expected::Status(403)
            }
        }
    }
}

const SCOPE_SETS: [&[&str]; 6] = [
    &[],
    &["sites:write"],
    &["admin:settings:read"],
    &["admin:settings:write"],
    &["admin:settings:write", "sites:read", "moderation:write"],
    &[
        "sites:write",
        "account:write",
        "tokens:write",
        "admin:zones:write",
        "admin:users:write",
        "admin:settings:write",
        "admin:blocklist:write",
        "admin:tokens:write",
        "moderation:write",
    ],
];

fn callers() -> Vec<(String, Caller)> {
    let mut all = vec![("anonymous".to_owned(), Caller::Anonymous)];
    for kind in UserKind::ALL {
        for role in Role::ALL {
            all.push((
                format!("{kind:?} {role:?} session"),
                Caller::Session { role, kind },
            ));
            for scopes in SCOPE_SETS {
                all.push((
                    format!("{kind:?} {role:?} token {scopes:?}"),
                    Caller::Token { role, kind, scopes },
                ));
            }
        }
    }
    all
}

fn user(id: i64, role: Role, kind: UserKind) -> User {
    User {
        id,
        login: format!("caller{id}"),
        kind,
        role,
        created_at: 0,
    }
}

fn authentication(caller: &Caller, id: i64) -> Authentication {
    match caller {
        Caller::Anonymous => Authentication::Anonymous,
        Caller::Session { role, kind } => Authentication::Session(Session {
            id,
            user: user(id, *role, *kind),
            csrf_hash: [0; 32],
            created_at: 0,
            last_seen_at: 0,
        }),
        Caller::Token { role, kind, scopes } => Authentication::Token(ApiCaller {
            owner: user(id, *role, *kind),
            scopes: Scopes::parse(scopes.iter().copied()).unwrap(),
        }),
    }
}

/// The real routes, each behind its guard, without the cookie and CSRF middleware: a layer in
/// front of them puts the given caller into the request, as `authenticate` would.
fn router_for(app: &TestApp, authentication: Authentication) -> Router {
    let (routes, _declared) = endpoints(app.state.clone()).into_parts();
    routes
        .layer(from_fn(move |mut request: Request, next: Next| {
            let authentication = authentication.clone();
            async move {
                let _previous = request.extensions_mut().insert(authentication);
                next.run(request).await
            }
        }))
        .with_state(app.state.clone())
}

fn request_for(route: &Declared) -> HttpRequest<axum::body::Body> {
    let mut builder = HttpRequest::builder()
        .method(route.method.clone())
        .uri(route.path.as_str());
    let body = if route.method == Method::PUT {
        builder = builder.header("content-type", "application/json");
        axum::body::Body::from(json!({"names": ["intranet"]}).to_string())
    } else {
        axum::body::Body::empty()
    };
    builder.body(body).unwrap()
}

#[test]
fn every_operation_of_the_document_has_a_declared_policy() {
    let document = stuffcloud_app::openapi::document();
    let declared = declared_routes();
    assert_eq!(verify(&declared, &document), Ok(()));
    let documented = operations(&document);
    assert!(documented.len() >= 10, "{documented:?}");
    assert_eq!(declared.len(), documented.len());
    // Dropping the declaration of any one operation is caught, whichever it is.
    for index in 0..declared.len() {
        let mut fewer = declared.clone();
        let removed = fewer.remove(index);
        let error = verify(&fewer, &document).unwrap_err();
        assert_eq!(error.0.len(), 1, "{removed:?}");
        assert!(error.0[0].ends_with("declares no policy"), "{error}");
    }
}

#[test]
fn the_requirements_of_the_routes_are_the_documented_ones() {
    let listed: Vec<(String, String, String)> = declared_routes()
        .into_iter()
        .map(|route| {
            (
                route.path,
                route.method.to_string(),
                route.requirement.label(),
            )
        })
        .collect();
    let expected = [
        ("/api/v1/account", "GET", "account:read"),
        ("/api/v1/account/password", "POST", "account:write"),
        ("/api/v1/admin/invitations", "GET", "admin:users:read"),
        ("/api/v1/admin/invitations", "POST", "admin:users:write"),
        (
            "/api/v1/admin/invitations/{id}",
            "DELETE",
            "admin:users:write",
        ),
        (
            "/api/v1/admin/users/{login}/password-reset",
            "POST",
            "admin:users:write",
        ),
        ("/api/v1/auth/login", "POST", "public"),
        ("/api/v1/auth/password-reset", "POST", "public"),
        ("/api/v1/auth/register", "POST", "public"),
        ("/api/v1/auth/session", "DELETE", "session"),
        ("/api/v1/auth/session", "GET", "public"),
        ("/api/v1/auth/sessions", "DELETE", "session"),
        ("/api/v1/openapi.json", "GET", "public"),
        (SETTINGS, "DELETE", "admin:settings:write"),
        (SETTINGS, "GET", "public"),
        (SETTINGS, "PUT", "admin:settings:write"),
        ("/api/v1/settings/signup", "DELETE", "admin:settings:write"),
        ("/api/v1/settings/signup", "GET", "public"),
        ("/api/v1/settings/signup", "PUT", "admin:settings:write"),
        ("/healthz", "GET", "public"),
        ("/metrics", "GET", "public"),
        ("/readyz", "GET", "public"),
    ];
    let mut listed = listed;
    listed.sort();
    let expected: Vec<(String, String, String)> = expected
        .iter()
        .map(|(path, method, requirement)| {
            (
                (*path).to_owned(),
                (*method).to_owned(),
                (*requirement).to_owned(),
            )
        })
        .collect();
    assert_eq!(listed, expected);
}

#[tokio::test]
async fn the_matrix_every_caller_against_every_route() {
    let app = TestApp::new(Policy::Production);
    let declared = declared_routes();
    let mut checked = 0;
    let mut refused = 0;
    for (index, (name, caller)) in callers().into_iter().enumerate() {
        let id = i64::try_from(index).unwrap() + 1;
        let router = router_for(&app, authentication(&caller, id));
        for route in &declared {
            let reply = router.clone().oneshot(request_for(route)).await.unwrap();
            let status = reply.status().as_u16();
            match expected(&caller, route.requirement) {
                Expected::Allowed => {
                    assert!(
                        status != 401 && status != 403,
                        "{name}: {} {} answered {status}",
                        route.method,
                        route.path
                    );
                }
                Expected::Status(wanted) => {
                    assert_eq!(
                        status, wanted,
                        "{name}: {} {} answered {status}",
                        route.method, route.path
                    );
                    let body = axum::body::to_bytes(reply.into_body(), usize::MAX)
                        .await
                        .unwrap();
                    let problem: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    let slug = if wanted == 401 {
                        "unauthenticated"
                    } else {
                        "forbidden"
                    };
                    assert_eq!(
                        problem["type"],
                        format!("{}{slug}", stuffcloud_app::problem::TYPE_BASE)
                    );
                    refused += 1;
                }
            }
            checked += 1;
        }
    }
    assert_eq!(checked, callers().len() * declared.len());
    assert_eq!(callers().len(), 43);
    assert!(refused > 100, "only {refused} refusals");
}

#[tokio::test]
async fn a_token_with_admin_scopes_owned_by_a_non_admin_is_refused() {
    let app = TestApp::new(Policy::Production);
    let all_admin: &'static [&'static str] = &[
        "admin:zones:write",
        "admin:users:write",
        "admin:settings:write",
        "admin:blocklist:write",
        "admin:tokens:write",
    ];
    for (id, role) in [(1, Role::User), (3, Role::Moderator)] {
        let caller = Caller::Token {
            role,
            kind: UserKind::Person,
            scopes: all_admin,
        };
        let router = router_for(&app, authentication(&caller, id));
        for method in [Method::PUT, Method::DELETE] {
            let route = Declared {
                method,
                path: SETTINGS.to_owned(),
                requirement: Requirement::Public,
            };
            let reply = router.clone().oneshot(request_for(&route)).await.unwrap();
            assert_eq!(reply.status().as_u16(), 403, "{role:?}");
        }
    }
    // The same token of an admin works.
    let caller = Caller::Token {
        role: Role::Admin,
        kind: UserKind::Person,
        scopes: all_admin,
    };
    let router = router_for(&app, authentication(&caller, 2));
    let put = Declared {
        method: Method::PUT,
        path: SETTINGS.to_owned(),
        requirement: Requirement::Public,
    };
    let reply = router.oneshot(request_for(&put)).await.unwrap();
    assert_eq!(reply.status().as_u16(), 201);
    // The refusals of the owners are audited by account, and the write of the admin's token is
    // attributed to its owner.
    let log = app.db.audit_log().unwrap();
    let denied: Vec<(Option<&str>, &str)> = log
        .iter()
        .filter(|entry| entry.action == "access.denied")
        .map(|entry| (entry.actor.as_deref(), entry.key.as_str()))
        .collect();
    assert_eq!(
        denied,
        [
            (Some("user:1"), "write:insufficient_role"),
            (Some("user:3"), "write:insufficient_role")
        ]
    );
    let written = log.iter().find(|entry| entry.action == "created").unwrap();
    assert_eq!(written.actor.as_deref(), Some("user:2"));
}

#[tokio::test]
async fn without_the_authentication_middleware_everything_is_anonymous() {
    // The guards deny by default: a request that never passed `authenticate` is anonymous.
    let app = TestApp::new(Policy::Production);
    let (table, _declared) = endpoints(app.state.clone()).into_parts();
    let router = table.with_state(app.state.clone());
    let put = Declared {
        method: Method::PUT,
        path: SETTINGS.to_owned(),
        requirement: Requirement::Public,
    };
    let reply = router.clone().oneshot(request_for(&put)).await.unwrap();
    assert_eq!(reply.status().as_u16(), 401);
    let get = Declared {
        method: Method::GET,
        path: "/healthz".to_owned(),
        requirement: Requirement::Public,
    };
    let reply = router.oneshot(request_for(&get)).await.unwrap();
    assert_eq!(reply.status().as_u16(), 200);
}

#[tokio::test]
async fn a_service_account_cannot_log_in_interactively() {
    let app = TestApp::new(Policy::Production);
    let robot = app
        .db
        .create_user("robot", UserKind::Service, Role::Admin, None, 0)
        .unwrap();
    let parts = HttpRequest::builder().body(()).unwrap().into_parts().0;
    let refused = start_session(&app.state, &parts, robot.id)
        .await
        .unwrap_err();
    assert_eq!(
        refused.kind(),
        stuffcloud_app::problem::ProblemKind::Forbidden
    );
    assert_eq!(
        refused.body().detail.as_deref(),
        Some("service accounts have no interactive login; use an API token")
    );
    assert_eq!(app.db.session_count(robot.id).unwrap(), 0);
    let refusals: Vec<_> = app
        .db
        .audit_log()
        .unwrap()
        .into_iter()
        .filter(|entry| entry.action == "login.refused")
        .collect();
    assert_eq!(refusals.len(), 1);
    assert_eq!(refusals[0].actor, Some(format!("user:{}", robot.id)));
    assert_eq!(refusals[0].kind, "user");
    assert_eq!(refusals[0].key, robot.id.to_string());
    assert_eq!(refusals[0].category, "security");
    assert!(!format!("{refusals:?}").contains("robot"));
    let metrics = app.get("/metrics").await.text();
    assert!(
        metrics.contains("stuffcloud_auth_rejections_total{reason=\"service_login\"} 1"),
        "{metrics}"
    );
    // An unknown account is an internal problem, not a refusal.
    let unknown = start_session(&app.state, &parts, 9999).await.unwrap_err();
    assert_eq!(
        unknown.kind(),
        stuffcloud_app::problem::ProblemKind::Internal
    );
}

#[tokio::test]
async fn refusals_are_counted_and_audited_once_a_minute_without_personal_data() {
    let app = TestApp::new(Policy::Production);
    let body = json!({"names": ["intranet"]});
    let alice = app.login("alice.secret", Role::User);
    let bob = app.login("bob.secret", Role::Moderator);
    for _ in 0..5 {
        app.call(Method::PUT, SETTINGS, &alice.write_headers(), Some(&body))
            .await
            .assert_problem(403, "forbidden");
    }
    app.call(Method::DELETE, SETTINGS, &alice.write_headers(), None)
        .await
        .assert_problem(403, "forbidden");
    app.call(Method::PUT, SETTINGS, &bob.write_headers(), Some(&body))
        .await
        .assert_problem(403, "forbidden");
    // Anonymous clients are counted but never audited: they could fill the log at will.
    for _ in 0..3 {
        app.call(Method::PUT, SETTINGS, &csrf_headers(), Some(&body))
            .await
            .assert_problem(401, "unauthenticated");
    }
    let denied: Vec<_> = app
        .db
        .audit_log()
        .unwrap()
        .into_iter()
        .filter(|entry| entry.action == "access.denied")
        .collect();
    // One row per account and rule within the minute: alice's six refusals are one row.
    assert_eq!(denied.len(), 2, "{denied:?}");
    assert_eq!(
        denied[0].actor,
        Some(format!("user:{}", alice.session.user.id))
    );
    assert_eq!(
        denied[1].actor,
        Some(format!("user:{}", bob.session.user.id))
    );
    for entry in &denied {
        assert_eq!(entry.kind, "admin:settings");
        assert_eq!(entry.key, "write:insufficient_role");
        assert_eq!(entry.category, "security");
        let text = format!("{entry:?}");
        assert!(!text.contains("secret") && !text.contains("alice") && !text.contains("bob"));
    }
    let metrics = app.get("/metrics").await.text();
    assert!(
        metrics.contains("stuffcloud_auth_rejections_total{reason=\"insufficient_role\"} 7"),
        "{metrics}"
    );
    assert!(
        metrics.contains("stuffcloud_auth_rejections_total{reason=\"unauthenticated\"} 3"),
        "{metrics}"
    );
    // Nothing was written by a refused request.
    app.get(SETTINGS).await.assert_problem(404, "not-found");
}

#[tokio::test]
async fn a_role_change_ends_the_sessions_and_the_new_role_applies() {
    let app = TestApp::new(Policy::Production);
    let body = json!({"names": ["intranet"]});
    let admin = app.login("admin", Role::Admin);
    let second = app.session_for(admin.session.user.id);
    assert_eq!(
        app.call(Method::PUT, SETTINGS, &admin.write_headers(), Some(&body))
            .await
            .status
            .as_u16(),
        201
    );
    let id = admin.session.user.id;
    let now = app.clock.now_millis();
    let change = app
        .db
        .set_role(id, Role::User, Some(&format!("user:{id}")), now)
        .unwrap();
    assert_eq!(change.previous, Role::Admin);
    assert_eq!(change.ended_sessions, 2);
    // Both old sessions are gone: the request is anonymous now, the cookies are cleared.
    for browser in [&admin, &second] {
        let reply = app
            .call(Method::PUT, SETTINGS, &browser.write_headers(), Some(&body))
            .await;
        reply.assert_problem(401, "unauthenticated");
        assert!(
            reply
                .set_cookies()
                .iter()
                .any(|cookie| cookie.starts_with("__Host-stuffcloud-session=;")),
            "{:?}",
            reply.set_cookies()
        );
    }
    // A new login carries the new role: no longer allowed to write.
    let again = app.session_for(id);
    app.call(Method::PUT, SETTINGS, &again.write_headers(), Some(&body))
        .await
        .assert_problem(403, "forbidden");
    let actions = app.audit_actions();
    assert!(
        actions.contains(&"user.role_changed".to_owned()),
        "{actions:?}"
    );
    assert!(
        actions.contains(&"session.ended_by_role_change".to_owned()),
        "{actions:?}"
    );
}

#[test]
fn routes_are_registered_only_through_the_declaring_table() {
    // `server.rs` is the only place with routes; it must not use the router's own methods,
    // which would add a route without a declared policy.
    let source = include_str!("../../src/server.rs");
    for needle in [
        concat!(".rou", "te("),
        concat!(".ne", "st("),
        concat!(".mer", "ge("),
        concat!(".rou", "te_service("),
    ] {
        assert!(!source.contains(needle), "server.rs uses {needle}");
    }
    assert!(source.contains("Endpoints"));
}

#[test]
fn the_permissions_document_is_current() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/api/permissions.md");
    let committed = std::fs::read_to_string(path).unwrap();
    let generated = stuffcloud_app::cli::permissions_document();
    assert_eq!(
        committed, generated,
        "docs/api/permissions.md is stale: run `cargo run -q -p stuffcloud-app -- permissions > docs/api/permissions.md`"
    );
}
