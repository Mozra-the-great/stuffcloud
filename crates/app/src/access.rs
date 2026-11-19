//! Central authorisation of every route (A-07, SPEC 6 and 10.4, ADR 0005 and 0010).
//!
//! The rules live in `stuffcloud_core::policy`: one pure function decides (subject, requirement)
//! and denies by default. This module wires it to the router so that no route can be reached
//! without a decision:
//!
//! - A route is registered only through [`Endpoints`], which takes the route's
//!   [`Requirement`] together with its handler and puts a guard in front of the handler. There
//!   is no way to add a route without declaring what it needs. A test fails when `server.rs`
//!   registers a route any other way.
//! - [`verify`] compares the declared routes with the operations of the OpenAPI document and
//!   fails (at startup, [`crate::server::check_routes`]) when one has no declared policy or a
//!   declared route is missing from the document.
//! - The guard (`enforce`) runs after [`crate::auth::authenticate`], so the request already
//!   carries its [`Authentication`]. A refusal is 401 for a client that is not logged in and 403
//!   for one that is; both are counted in `stuffcloud_auth_rejections_total{reason}`, and a
//!   refusal of an authenticated account is written to the audit log (internal ids only, at
//!   most once a minute per account and rule).
//! - [`permissions_markdown`] renders the matrix and the route table; `docs/api/permissions.md`
//!   is that output and a test fails when the file is stale.

use std::collections::BTreeSet;
use std::fmt::{self, Write};

use axum::Router;
use axum::extract::{Request, State};
use axum::handler::Handler;
use axum::http::Method;
use axum::middleware::{Next, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodFilter, on};
use serde_json::Value;
use stuffcloud_core::policy::{self, Decision, Denial, Requirement, Subject, grant};
use stuffcloud_core::scope::Permission;
use stuffcloud_core::session::Role;
use stuffcloud_db::auth::{ACCESS_DENIED, actor};
use utoipa::openapi::OpenApi as Document;

use crate::auth::{Authentication, note_rejection};
use crate::problem::{Problem, ProblemKind};
use crate::state::AppState;

/// Decides whether a subject may do what a route requires. [`MatrixPolicy`] is the production
/// policy; tests of other features may use one that allows everything, which is why the state
/// holds a trait object. Nothing else in the application decides.
pub trait AccessPolicy: Send + Sync + fmt::Debug {
    /// The decision for one request.
    fn decide(&self, subject: &Subject<'_>, requirement: Requirement) -> Decision;
}

/// The permission matrix of `stuffcloud_core::policy`.
#[derive(Debug, Clone, Copy, Default)]
pub struct MatrixPolicy;

impl AccessPolicy for MatrixPolicy {
    fn decide(&self, subject: &Subject<'_>, requirement: Requirement) -> Decision {
        policy::decide(subject, requirement)
    }
}

/// What the denial audit keys on: the account, the permission (none for a session route) and
/// the rule that refused.
pub type DenialKey = (i64, Option<Permission>, &'static str);

/// One declared route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Declared {
    /// The HTTP method.
    pub method: Method,
    /// The path as the router and the OpenAPI document spell it (`/api/v1/...`).
    pub path: String,
    /// What the route needs.
    pub requirement: Requirement,
}

/// The routes of the application and their requirements. Build it, add routes with
/// [`Endpoints::get`], [`Endpoints::put`] and [`Endpoints::delete`], then take the router and
/// the declarations with [`Endpoints::into_parts`].
#[derive(Debug)]
pub struct Endpoints {
    state: Option<AppState>,
    router: Router<AppState>,
    declared: Vec<Declared>,
}

/// What the guard in front of one route needs.
#[derive(Debug, Clone)]
struct Guard {
    state: AppState,
    requirement: Requirement,
}

impl Endpoints {
    /// No routes yet; every route added gets its guard.
    #[must_use]
    pub fn guarded(state: AppState) -> Self {
        Self {
            state: Some(state),
            router: Router::new(),
            declared: Vec::new(),
        }
    }

    /// No routes yet, and no guards: only for reading the declarations (the permissions
    /// document, the startup check), never for serving.
    #[must_use]
    pub fn unguarded() -> Self {
        Self {
            state: None,
            router: Router::new(),
            declared: Vec::new(),
        }
    }

    /// Adds a `GET` route.
    #[must_use]
    pub fn get<H, T>(self, path: &str, requirement: Requirement, handler: H) -> Self
    where
        H: Handler<T, AppState>,
        T: 'static,
    {
        self.add(Method::GET, MethodFilter::GET, path, requirement, handler)
    }

    /// Adds a `PUT` route.
    #[must_use]
    pub fn put<H, T>(self, path: &str, requirement: Requirement, handler: H) -> Self
    where
        H: Handler<T, AppState>,
        T: 'static,
    {
        self.add(Method::PUT, MethodFilter::PUT, path, requirement, handler)
    }

    /// Adds a `DELETE` route.
    #[must_use]
    pub fn delete<H, T>(self, path: &str, requirement: Requirement, handler: H) -> Self
    where
        H: Handler<T, AppState>,
        T: 'static,
    {
        self.add(
            Method::DELETE,
            MethodFilter::DELETE,
            path,
            requirement,
            handler,
        )
    }

    fn add<H, T>(
        mut self,
        method: Method,
        filter: MethodFilter,
        path: &str,
        requirement: Requirement,
        handler: H,
    ) -> Self
    where
        H: Handler<T, AppState>,
        T: 'static,
    {
        let route = on(filter, handler);
        let route = match &self.state {
            Some(state) => route.route_layer(from_fn_with_state(
                Guard {
                    state: state.clone(),
                    requirement,
                },
                enforce,
            )),
            None => route,
        };
        self.router = self.router.route(path, route);
        self.declared.push(Declared {
            method,
            path: path.to_owned(),
            requirement,
        });
        self
    }

    /// The router (every route behind its guard) and what was declared.
    pub fn into_parts(self) -> (Router<AppState>, Vec<Declared>) {
        (self.router, self.declared)
    }
}

/// The guard in front of every route: decides, and refuses with a problem document.
async fn enforce(State(guard): State<Guard>, request: Request, next: Next) -> Response {
    let (decision, user_id) = {
        let fallback = Authentication::Anonymous;
        let authentication = request
            .extensions()
            .get::<Authentication>()
            .unwrap_or(&fallback);
        (
            guard
                .state
                .policy()
                .decide(&authentication.subject(), guard.requirement),
            authentication.user().map(|user| user.id),
        )
    };
    match decision {
        Decision::Allow => next.run(request).await,
        Decision::Deny(denial) => {
            refuse(
                &guard.state,
                user_id,
                guard.requirement,
                denial,
                request.method().as_str(),
            )
            .await
        }
    }
}

/// Counts and audits a refusal and answers it.
async fn refuse(
    state: &AppState,
    user_id: Option<i64>,
    requirement: Requirement,
    denial: Denial,
    method: &str,
) -> Response {
    note_rejection(state, denial.code(), method);
    if let (false, Some(user_id)) = (denial.is_unauthenticated(), user_id) {
        audit_denial(state, user_id, requirement, denial).await;
    }
    problem_for(denial, requirement).into_response()
}

/// The audit `kind` and the level text of a refused requirement.
#[must_use]
pub fn audit_subject(requirement: Requirement) -> (&'static str, &'static str) {
    match requirement {
        Requirement::Permit(permission) => (permission.area.as_str(), permission.level.as_str()),
        Requirement::Session => ("session", "use"),
        Requirement::Public => ("public", "use"),
    }
}

/// Writes the refusal of an authenticated account to the audit log, unless the same account
/// was refused by the same rule for the same permission within the last minute.
async fn audit_denial(state: &AppState, user_id: i64, requirement: Requirement, denial: Denial) {
    let permission = match requirement {
        Requirement::Permit(permission) => Some(permission),
        Requirement::Session | Requirement::Public => None,
    };
    if !state
        .denial_audit()
        .admit((user_id, permission, denial.code()))
    {
        return;
    }
    let (kind, level) = audit_subject(requirement);
    let key = format!("{level}:{}", denial.code());
    let who = actor(user_id);
    let now = state.now_millis();
    // A failure is logged by `Problem::internal`; the refusal stands either way.
    let _written = state
        .db(move |db| db.record_security_event(Some(&who), ACCESS_DENIED, kind, &key, now))
        .await;
}

/// The problem document for a refusal. The detail names the permission, which is public
/// (`docs/api/permissions.md`), never anything about the account.
#[must_use]
pub fn problem_for(denial: Denial, requirement: Requirement) -> Problem {
    let needed = requirement.label();
    match denial {
        Denial::Unauthenticated => Problem::with_detail(
            ProblemKind::Unauthenticated,
            format!("this needs a login or an API token ({needed})"),
        ),
        Denial::InsufficientRole => Problem::with_detail(
            ProblemKind::Forbidden,
            format!("the role of this account does not have the permission {needed}"),
        ),
        Denial::MissingScope => Problem::with_detail(
            ProblemKind::Forbidden,
            format!("the API token has no scope that grants {needed}"),
        ),
        Denial::ServiceSession => Problem::with_detail(
            ProblemKind::Forbidden,
            "service accounts have no interactive session; use an API token",
        ),
        Denial::SessionRequired => Problem::with_detail(
            ProblemKind::Forbidden,
            "this needs a browser session, not an API token",
        ),
    }
}

/// The routes and the OpenAPI operations do not match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteMismatch(pub Vec<String>);

impl fmt::Display for RouteMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "route policies do not match the OpenAPI document: {}",
            self.0.join("; ")
        )
    }
}

impl std::error::Error for RouteMismatch {}

/// The operations of an OpenAPI document as `(METHOD, path)`.
#[must_use]
pub fn operations(document: &Document) -> BTreeSet<(String, String)> {
    const METHODS: [&str; 8] = [
        "get", "put", "post", "delete", "options", "head", "patch", "trace",
    ];
    let value = serde_json::to_value(document).unwrap_or(Value::Null);
    let mut found = BTreeSet::new();
    if let Some(paths) = value.get("paths").and_then(Value::as_object) {
        for (path, item) in paths {
            if let Some(item) = item.as_object() {
                for method in item.keys().filter(|key| METHODS.contains(&key.as_str())) {
                    let _new = found.insert((method.to_ascii_uppercase(), path.clone()));
                }
            }
        }
    }
    found
}

/// Checks that every operation of the document has a declared policy and every declared route
/// is in the document, and that no route is declared twice.
///
/// # Errors
///
/// [`RouteMismatch`] listing every difference.
pub fn verify(declared: &[Declared], document: &Document) -> Result<(), RouteMismatch> {
    let documented = operations(document);
    let routed: BTreeSet<(String, String)> = declared
        .iter()
        .map(|route| (route.method.as_str().to_owned(), route.path.clone()))
        .collect();
    let mut problems = Vec::new();
    if routed.len() != declared.len() {
        problems.push("a route is declared twice".to_owned());
    }
    for (method, path) in documented.difference(&routed) {
        problems.push(format!(
            "{method} {path} is documented but declares no policy"
        ));
    }
    for (method, path) in routed.difference(&documented) {
        problems.push(format!("{method} {path} is routed but not in the document"));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(RouteMismatch(problems))
    }
}

/// Whether a role has a permission, as `yes` or `no` for the documents.
fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

/// The text of `docs/api/permissions.md`: the permission matrix and the route table.
#[must_use]
pub fn permissions_markdown(declared: &[Declared]) -> String {
    let mut out = String::from(
        "# Permissions\n\
         \n\
         Generated by `stuffcloud-app permissions` from the permission matrix\n\
         (`crates/core/src/policy.rs`) and the route table (`crates/app/src/server.rs`); a test\n\
         fails when this file is stale. SPEC 6 and 10.4 explain the rules.\n\
         \n\
         ## Matrix\n\
         \n\
         A token has what its scopes grant and its owner's role also has; `write` includes `read`\n\
         of the same area. A service account has tokens only, never a session.\n\
         \n\
         | Permission (also the token scope) | Anonymous | User | Moderator | Admin |\n\
         |---|---|---|---|---|\n",
    );
    for permission in Permission::all() {
        let grant = grant(permission);
        let cells: Vec<&str> = std::iter::once(grant.anonymous)
            .chain(
                [Role::User, Role::Moderator, Role::Admin]
                    .into_iter()
                    .map(|role| role >= grant.role),
            )
            .map(yes_no)
            .collect();
        let _line = writeln!(out, "| `{permission}` | {} |", cells.join(" | "));
    }
    out.push_str(
        "\n\
         ## Routes\n\
         \n\
         Every operation of the OpenAPI document declares one requirement: `public` (nobody has to\n\
         log in), `session` (a browser session of a person; no token, no anonymous client) or a\n\
         permission from the matrix.\n\
         \n\
         | Method | Path | Requirement |\n\
         |---|---|---|\n",
    );
    let mut routes: Vec<&Declared> = declared.iter().collect();
    routes.sort_by(|a, b| {
        (a.path.as_str(), a.method.as_str()).cmp(&(b.path.as_str(), b.method.as_str()))
    });
    for route in routes {
        let requirement = match route.requirement {
            Requirement::Permit(permission) => format!("`{permission}`"),
            other => other.label(),
        };
        let _line = writeln!(
            out,
            "| {} | `{}` | {requirement} |",
            route.method, route.path
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use stuffcloud_core::policy::Account;
    use stuffcloud_core::scope::{Area, Level};

    use super::*;

    fn declared(method: Method, path: &str, requirement: Requirement) -> Declared {
        Declared {
            method,
            path: path.to_owned(),
            requirement,
        }
    }

    fn write_settings() -> Requirement {
        Requirement::Permit(Permission::new(Area::AdminSettings, Level::Write))
    }

    #[test]
    fn the_matrix_policy_is_the_core_decision() {
        let admin = Account {
            login: "a",
            kind: stuffcloud_core::session::UserKind::Person,
            role: Role::Admin,
        };
        assert_eq!(
            MatrixPolicy.decide(&Subject::Session(admin), write_settings()),
            Decision::Allow
        );
        assert_eq!(
            MatrixPolicy.decide(&Subject::Anonymous, write_settings()),
            Decision::Deny(Denial::Unauthenticated)
        );
    }

    #[test]
    fn what_is_audited_about_a_requirement() {
        assert_eq!(audit_subject(write_settings()), ("admin:settings", "write"));
        assert_eq!(
            audit_subject(Requirement::Permit(Permission::new(
                Area::Moderation,
                Level::Read
            ))),
            ("moderation", "read")
        );
        assert_eq!(audit_subject(Requirement::Session), ("session", "use"));
        assert_eq!(audit_subject(Requirement::Public), ("public", "use"));
    }

    #[test]
    fn every_denial_has_its_status_and_a_detail() {
        let needed = write_settings();
        let cases = [
            (
                Denial::Unauthenticated,
                ProblemKind::Unauthenticated,
                "this needs a login or an API token (admin:settings:write)",
            ),
            (
                Denial::InsufficientRole,
                ProblemKind::Forbidden,
                "the role of this account does not have the permission admin:settings:write",
            ),
            (
                Denial::MissingScope,
                ProblemKind::Forbidden,
                "the API token has no scope that grants admin:settings:write",
            ),
            (
                Denial::ServiceSession,
                ProblemKind::Forbidden,
                "service accounts have no interactive session; use an API token",
            ),
            (
                Denial::SessionRequired,
                ProblemKind::Forbidden,
                "this needs a browser session, not an API token",
            ),
        ];
        for (denial, kind, detail) in cases {
            let problem = problem_for(denial, needed);
            assert_eq!(problem.kind(), kind, "{denial:?}");
            assert_eq!(problem.body().detail.as_deref(), Some(detail), "{denial:?}");
        }
        assert_eq!(
            problem_for(Denial::Unauthenticated, Requirement::Session)
                .body()
                .detail
                .as_deref(),
            Some("this needs a login or an API token (session)")
        );
    }

    #[test]
    fn the_operations_of_the_document() {
        let found = operations(&crate::openapi::document());
        assert!(found.contains(&("GET".to_owned(), "/healthz".to_owned())));
        assert!(found.contains(&(
            "PUT".to_owned(),
            "/api/v1/settings/reserved-names".to_owned()
        )));
        assert!(found.contains(&("DELETE".to_owned(), "/api/v1/auth/sessions".to_owned())));
        // Only operations: no parameters or summaries, no other keys of a path item.
        for (method, _path) in &found {
            assert!(
                [
                    "GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"
                ]
                .contains(&method.as_str()),
                "{method}"
            );
        }
    }

    #[test]
    fn a_declaration_for_every_operation_passes() {
        let all: Vec<Declared> = operations(&crate::openapi::document())
            .into_iter()
            .map(|(method, path)| {
                declared(
                    Method::from_bytes(method.as_bytes()).unwrap(),
                    &path,
                    Requirement::Public,
                )
            })
            .collect();
        assert_eq!(verify(&all, &crate::openapi::document()), Ok(()));
    }

    #[test]
    fn an_operation_without_a_policy_is_reported() {
        let mut all: Vec<Declared> = operations(&crate::openapi::document())
            .into_iter()
            .map(|(method, path)| {
                declared(
                    Method::from_bytes(method.as_bytes()).unwrap(),
                    &path,
                    Requirement::Public,
                )
            })
            .collect();
        let removed = all.remove(0);
        let error = verify(&all, &crate::openapi::document()).unwrap_err();
        assert_eq!(
            error.0,
            [format!(
                "{} {} is documented but declares no policy",
                removed.method, removed.path
            )]
        );
        assert!(
            error
                .to_string()
                .starts_with("route policies do not match the OpenAPI document: ")
        );
    }

    #[test]
    fn a_route_outside_the_document_and_a_double_declaration_are_reported() {
        let mut all: Vec<Declared> = operations(&crate::openapi::document())
            .into_iter()
            .map(|(method, path)| {
                declared(
                    Method::from_bytes(method.as_bytes()).unwrap(),
                    &path,
                    Requirement::Public,
                )
            })
            .collect();
        all.push(declared(
            Method::POST,
            "/api/v1/undocumented",
            Requirement::Public,
        ));
        let error = verify(&all, &crate::openapi::document()).unwrap_err();
        assert_eq!(
            error.0,
            ["POST /api/v1/undocumented is routed but not in the document"]
        );
        let twice = all[0].clone();
        let _dropped = all.pop();
        all.push(twice);
        let error = verify(&all, &crate::openapi::document()).unwrap_err();
        assert_eq!(error.0, ["a route is declared twice"]);
    }

    #[test]
    fn the_markdown_lists_the_matrix_and_the_routes() {
        let text = permissions_markdown(&[
            declared(Method::PUT, "/b", write_settings()),
            declared(Method::GET, "/b", Requirement::Public),
            declared(Method::DELETE, "/a", Requirement::Session),
        ]);
        assert!(text.starts_with("# Permissions\n\nGenerated by `stuffcloud-app permissions`"));
        assert!(text.contains("| `sites:read` | no | yes | yes | yes |\n"));
        assert!(text.contains("| `sites:write` | yes | yes | yes | yes |\n"));
        assert!(text.contains("| `admin:blocklist:write` | no | no | yes | yes |\n"));
        assert!(text.contains("| `admin:settings:write` | no | no | no | yes |\n"));
        assert!(text.contains("| `moderation:read` | no | no | yes | yes |\n"));
        assert!(text.ends_with(
            "| Method | Path | Requirement |\n|---|---|---|\n\
             | DELETE | `/a` | session |\n\
             | GET | `/b` | public |\n\
             | PUT | `/b` | `admin:settings:write` |\n"
        ));
        assert_eq!(text.matches("\n| `").count(), 18 + 3);
    }

    #[test]
    fn yes_and_no() {
        assert_eq!(yes_no(true), "yes");
        assert_eq!(yes_no(false), "no");
    }
}
