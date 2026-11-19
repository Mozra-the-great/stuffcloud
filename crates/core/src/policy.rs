//! The permission matrix and the one function that decides (A-07, SPEC 6 and 10.4, ADR 0005
//! and ADR 0010 decision 5).
//!
//! Every request has a [`Subject`] (anonymous, an account with a session, or an API token and
//! its owner) and every route declares a [`Requirement`]. [`decide`] turns the pair into a
//! [`Decision`]; nothing else in the code base decides who may do what. Deny is the default:
//! a permission nobody is granted in [`grant`] is refused for everyone, and a role or a scope
//! that is not named grants nothing.
//!
//! The rules, in one place:
//!
//! - [`grant`] is the matrix: for each [`Permission`] the lowest [`Role`] that has it and
//!   whether anonymous clients have it too. Roles are ordered (`user` < `moderator` <
//!   `admin`), so a higher role has everything a lower one has (SPEC 6: "all of the above").
//! - An account with a session has the permissions of its role. A **service account** never
//!   has a session ([`Denial::ServiceSession`]): it has tokens only.
//! - A **token** has what its scopes grant intersected with what its owner's role has
//!   ([`effective`]). It never exceeds its owner, and an admin scope stops working the moment
//!   the owner is no longer an admin, because the role is read at every request.
//! - Anonymous clients have the permissions with `anonymous` set, nothing else.
//!
//! The function is pure, so property tests and the matrix test of `app` reach every
//! combination without a server.

use std::collections::BTreeSet;

use crate::scope::{Area, Level, Permission, Scopes};
use crate::session::{Role, UserKind};

/// Who has a permission: the lowest role that does, and whether anonymous clients do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Grant {
    /// Whether a client without an account has the permission.
    pub anonymous: bool,
    /// The lowest role that has it; every higher role has it too.
    pub role: Role,
}

impl Grant {
    /// From this role up.
    const fn from(role: Role) -> Self {
        Self {
            anonymous: false,
            role,
        }
    }

    /// Everyone, anonymous clients included.
    const fn everyone() -> Self {
        Self {
            anonymous: true,
            role: Role::User,
        }
    }
}

/// The permission matrix (SPEC 6): who has `permission`.
///
/// Exhaustive on purpose: a new [`Area`] does not compile until its row is written here.
#[must_use]
pub const fn grant(permission: Permission) -> Grant {
    match (permission.area, permission.level) {
        // Sites: only accounts list and manage sites; anonymous clients may create temporary
        // internal sites where a zone allows it (the zone rules of `hosting` decide).
        (Area::Sites, Level::Read) | (Area::Account | Area::Tokens, _) => Grant::from(Role::User),
        (Area::Sites, Level::Write) => Grant::everyone(),
        // Moderators handle reports, takedowns and the blocklist (SPEC 6, 8.6).
        (Area::Moderation | Area::AdminBlocklist, _) => Grant::from(Role::Moderator),
        // Everything else that configures the instance is for admins.
        (Area::AdminZones | Area::AdminUsers | Area::AdminSettings | Area::AdminTokens, _) => {
            Grant::from(Role::Admin)
        }
    }
}

/// An account as the policy sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Account<'a> {
    /// Login name (the natural key; the allow-list of a zone names accounts by it).
    pub login: &'a str,
    /// Person or service account.
    pub kind: UserKind,
    /// Role, as stored now (never a copy that a token or session carries).
    pub role: Role,
}

/// Who sent a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subject<'a> {
    /// No valid session and no valid token.
    Anonymous,
    /// A browser session of an account.
    Session(Account<'a>),
    /// An API token: its owner and its scopes.
    Token {
        /// The account the token belongs to.
        owner: Account<'a>,
        /// What the token was created with.
        scopes: &'a Scopes,
    },
}

impl<'a> Subject<'a> {
    /// The account behind the subject, if there is one.
    #[must_use]
    pub const fn account(&self) -> Option<&Account<'a>> {
        match self {
            Self::Anonymous => None,
            Self::Session(account) | Self::Token { owner: account, .. } => Some(account),
        }
    }
}

/// What a route needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Requirement {
    /// Nothing: probes, the API description, the CSRF token endpoint and the settings groups
    /// the client needs before it logs in. Never use it for anything that changes state or
    /// holds an operator's data.
    Public,
    /// A browser session of a person. Tokens and anonymous clients never qualify (logout,
    /// "logout everywhere").
    Session,
    /// A permission: the role (or, for a token, the scope and the owner's role) must have it.
    Permit(Permission),
}

impl Requirement {
    /// A short label for logs and documents: `public`, `session` or the permission.
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::Public => "public".to_owned(),
            Self::Session => "session".to_owned(),
            Self::Permit(permission) => permission.to_string(),
        }
    }
}

/// Why a request is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denial {
    /// The client is anonymous and the route needs an account: answer 401.
    Unauthenticated,
    /// The account's role is too low (also: the owner's role, for a token): answer 403.
    InsufficientRole,
    /// The token has no scope that grants the permission: answer 403.
    MissingScope,
    /// A service account has no interactive session: answer 403.
    ServiceSession,
    /// The route needs a browser session and the caller used a token: answer 403.
    SessionRequired,
}

impl Denial {
    /// A stable rule name for metrics and the audit log; never contains request data.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Unauthenticated => "unauthenticated",
            Self::InsufficientRole => "insufficient_role",
            Self::MissingScope => "missing_scope",
            Self::ServiceSession => "service_session",
            Self::SessionRequired => "session_required",
        }
    }

    /// Whether the client is simply not logged in (401) rather than not allowed (403).
    #[must_use]
    pub const fn is_unauthenticated(self) -> bool {
        matches!(self, Self::Unauthenticated)
    }
}

/// The answer of [`decide`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Go ahead.
    Allow,
    /// Refuse, for this reason.
    Deny(Denial),
}

impl Decision {
    /// Whether the request may go ahead.
    #[must_use]
    pub const fn is_allowed(self) -> bool {
        matches!(self, Self::Allow)
    }
}

/// Whether the role has the permission.
fn role_has(role: Role, permission: Permission) -> bool {
    role >= grant(permission).role
}

/// Decides one permission for a subject.
fn permit(subject: &Subject<'_>, permission: Permission) -> Decision {
    match subject {
        Subject::Anonymous => {
            if grant(permission).anonymous {
                Decision::Allow
            } else {
                Decision::Deny(Denial::Unauthenticated)
            }
        }
        Subject::Session(account) => match account.kind {
            UserKind::Service => Decision::Deny(Denial::ServiceSession),
            UserKind::Person if role_has(account.role, permission) => Decision::Allow,
            UserKind::Person => Decision::Deny(Denial::InsufficientRole),
        },
        Subject::Token { owner, scopes } => {
            if !scopes.covers(permission) {
                Decision::Deny(Denial::MissingScope)
            } else if !role_has(owner.role, permission) {
                Decision::Deny(Denial::InsufficientRole)
            } else {
                Decision::Allow
            }
        }
    }
}

/// The one decision: may `subject` do what `requirement` names?
#[must_use]
pub fn decide(subject: &Subject<'_>, requirement: Requirement) -> Decision {
    match requirement {
        Requirement::Public => Decision::Allow,
        Requirement::Session => match subject {
            Subject::Anonymous => Decision::Deny(Denial::Unauthenticated),
            Subject::Token { .. } => Decision::Deny(Denial::SessionRequired),
            Subject::Session(account) => match account.kind {
                UserKind::Person => Decision::Allow,
                UserKind::Service => Decision::Deny(Denial::ServiceSession),
            },
        },
        Requirement::Permit(permission) => permit(subject, permission),
    }
}

/// The permissions a role has.
#[must_use]
pub fn role_permissions(role: Role) -> BTreeSet<Permission> {
    Permission::all()
        .filter(|permission| role_has(role, *permission))
        .collect()
}

/// The permissions an anonymous client has.
#[must_use]
pub fn anonymous_permissions() -> BTreeSet<Permission> {
    Permission::all()
        .filter(|permission| grant(*permission).anonymous)
        .collect()
}

/// Everything a subject may do: for a token the scopes intersected with the owner's role, for
/// a session the role, for an anonymous client the anonymous permissions, for a service
/// account's session nothing.
#[must_use]
pub fn effective(subject: &Subject<'_>) -> BTreeSet<Permission> {
    Permission::all()
        .filter(|permission| permit(subject, *permission).is_allowed())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> Permission {
        Permission::parse(text).unwrap()
    }

    fn account(kind: UserKind, role: Role) -> Account<'static> {
        Account {
            login: "someone",
            kind,
            role,
        }
    }

    fn person(role: Role) -> Account<'static> {
        account(UserKind::Person, role)
    }

    /// Who has what, written out per permission (the matrix of SPEC 6 as literal data):
    /// anonymous, then the lowest role.
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

    #[test]
    fn the_matrix_is_the_one_of_the_spec() {
        let listed: BTreeSet<Permission> = MATRIX.iter().map(|(name, _, _)| p(name)).collect();
        assert_eq!(listed, Permission::all().collect());
        for (name, anonymous, role) in MATRIX {
            assert_eq!(grant(p(name)), Grant { anonymous, role }, "{name}");
        }
    }

    #[test]
    fn role_by_role_permissions() {
        let names = |set: BTreeSet<Permission>| -> Vec<String> {
            set.iter().map(ToString::to_string).collect()
        };
        assert_eq!(
            names(anonymous_permissions()),
            ["sites:write"],
            "anonymous clients have exactly one permission"
        );
        assert_eq!(
            names(role_permissions(Role::User)),
            [
                "sites:read",
                "sites:write",
                "account:read",
                "account:write",
                "tokens:read",
                "tokens:write"
            ]
        );
        assert_eq!(
            names(role_permissions(Role::Moderator)),
            [
                "sites:read",
                "sites:write",
                "account:read",
                "account:write",
                "tokens:read",
                "tokens:write",
                "admin:blocklist:read",
                "admin:blocklist:write",
                "moderation:read",
                "moderation:write"
            ]
        );
        assert_eq!(role_permissions(Role::Admin).len(), 18);
    }

    #[test]
    fn requirement_labels() {
        assert_eq!(Requirement::Public.label(), "public");
        assert_eq!(Requirement::Session.label(), "session");
        assert_eq!(
            Requirement::Permit(p("admin:zones:write")).label(),
            "admin:zones:write"
        );
    }

    #[test]
    fn public_is_for_everyone() {
        let all_scopes = Scopes::of(Permission::all());
        let nothing = Scopes::none();
        let subjects = [
            Subject::Anonymous,
            Subject::Session(person(Role::User)),
            Subject::Session(account(UserKind::Service, Role::Admin)),
            Subject::Token {
                owner: person(Role::User),
                scopes: &nothing,
            },
            Subject::Token {
                owner: account(UserKind::Service, Role::Admin),
                scopes: &all_scopes,
            },
        ];
        for subject in subjects {
            assert_eq!(decide(&subject, Requirement::Public), Decision::Allow);
        }
    }

    #[test]
    fn a_session_route_wants_a_person_with_a_session() {
        let scopes = Scopes::of(Permission::all());
        assert_eq!(
            decide(&Subject::Anonymous, Requirement::Session),
            Decision::Deny(Denial::Unauthenticated)
        );
        for role in Role::ALL {
            assert_eq!(
                decide(&Subject::Session(person(role)), Requirement::Session),
                Decision::Allow
            );
            assert_eq!(
                decide(
                    &Subject::Session(account(UserKind::Service, role)),
                    Requirement::Session
                ),
                Decision::Deny(Denial::ServiceSession)
            );
            assert_eq!(
                decide(
                    &Subject::Token {
                        owner: person(role),
                        scopes: &scopes
                    },
                    Requirement::Session
                ),
                Decision::Deny(Denial::SessionRequired)
            );
        }
    }

    #[test]
    fn anonymous_clients_have_only_the_anonymous_permissions() {
        for permission in Permission::all() {
            let decision = decide(&Subject::Anonymous, Requirement::Permit(permission));
            if permission == p("sites:write") {
                assert_eq!(decision, Decision::Allow);
            } else {
                assert_eq!(
                    decision,
                    Decision::Deny(Denial::Unauthenticated),
                    "{permission}"
                );
            }
        }
    }

    #[test]
    fn a_session_has_the_permissions_of_its_role() {
        for role in Role::ALL {
            for (name, _, lowest) in MATRIX {
                let decision = decide(
                    &Subject::Session(person(role)),
                    Requirement::Permit(p(name)),
                );
                if role >= lowest {
                    assert_eq!(decision, Decision::Allow, "{role:?} {name}");
                } else {
                    assert_eq!(
                        decision,
                        Decision::Deny(Denial::InsufficientRole),
                        "{role:?} {name}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_service_account_has_no_session() {
        for role in Role::ALL {
            let subject = Subject::Session(account(UserKind::Service, role));
            for permission in Permission::all() {
                assert_eq!(
                    decide(&subject, Requirement::Permit(permission)),
                    Decision::Deny(Denial::ServiceSession)
                );
            }
            assert!(effective(&subject).is_empty());
        }
    }

    #[test]
    fn a_token_needs_the_scope_and_the_role() {
        // The scope is missing: refused whatever the role.
        let read_only = Scopes::parse(["admin:settings:read"]).unwrap();
        let admin_token = Subject::Token {
            owner: person(Role::Admin),
            scopes: &read_only,
        };
        assert_eq!(
            decide(&admin_token, Requirement::Permit(p("admin:settings:read"))),
            Decision::Allow
        );
        assert_eq!(
            decide(&admin_token, Requirement::Permit(p("admin:settings:write"))),
            Decision::Deny(Denial::MissingScope)
        );
        assert_eq!(
            decide(&admin_token, Requirement::Permit(p("admin:zones:read"))),
            Decision::Deny(Denial::MissingScope)
        );
        // The scope is there, the owner is not an admin (any more): refused.
        for role in [Role::User, Role::Moderator] {
            let token = Subject::Token {
                owner: person(role),
                scopes: &read_only,
            };
            assert_eq!(
                decide(&token, Requirement::Permit(p("admin:settings:read"))),
                Decision::Deny(Denial::InsufficientRole)
            );
            assert!(!effective(&token).contains(&p("admin:settings:read")));
        }
        // Without any scope a token of an admin does nothing.
        let nothing = Scopes::none();
        let empty = Subject::Token {
            owner: person(Role::Admin),
            scopes: &nothing,
        };
        assert!(effective(&empty).is_empty());
        // A write scope grants the read of its area.
        let write = Scopes::parse(["admin:zones:write"]).unwrap();
        let token = Subject::Token {
            owner: person(Role::Admin),
            scopes: &write,
        };
        assert_eq!(
            effective(&token),
            [p("admin:zones:read"), p("admin:zones:write")]
                .into_iter()
                .collect()
        );
        // A service account's token works within its role like a person's.
        let service = Subject::Token {
            owner: account(UserKind::Service, Role::Admin),
            scopes: &write,
        };
        assert_eq!(effective(&service), effective(&token));
    }

    #[test]
    fn the_scope_check_comes_before_the_role_check() {
        let scopes = Scopes::parse(["sites:read"]).unwrap();
        let token = Subject::Token {
            owner: person(Role::User),
            scopes: &scopes,
        };
        // Neither scope nor role: the missing scope is what is reported.
        assert_eq!(
            decide(&token, Requirement::Permit(p("admin:zones:write"))),
            Decision::Deny(Denial::MissingScope)
        );
    }

    #[test]
    fn effective_permissions_of_each_kind_of_subject() {
        assert_eq!(effective(&Subject::Anonymous), anonymous_permissions());
        for role in Role::ALL {
            assert_eq!(
                effective(&Subject::Session(person(role))),
                role_permissions(role)
            );
        }
    }

    #[test]
    fn denials_have_codes_and_a_status_class() {
        let all = [
            (Denial::Unauthenticated, "unauthenticated", true),
            (Denial::InsufficientRole, "insufficient_role", false),
            (Denial::MissingScope, "missing_scope", false),
            (Denial::ServiceSession, "service_session", false),
            (Denial::SessionRequired, "session_required", false),
        ];
        for (denial, code, unauthenticated) in all {
            assert_eq!(denial.code(), code);
            assert_eq!(denial.is_unauthenticated(), unauthenticated, "{code}");
        }
        assert!(Decision::Allow.is_allowed());
        assert!(!Decision::Deny(Denial::MissingScope).is_allowed());
    }

    #[test]
    fn the_account_behind_a_subject() {
        let scopes = Scopes::none();
        assert_eq!(Subject::Anonymous.account(), None);
        assert_eq!(
            Subject::Session(person(Role::User)).account(),
            Some(&person(Role::User))
        );
        assert_eq!(
            Subject::Token {
                owner: person(Role::Admin),
                scopes: &scopes
            }
            .account(),
            Some(&person(Role::Admin))
        );
    }
}
