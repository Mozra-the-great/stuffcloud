//! Who may host where: the zone-level part of the policy (A-07, ADR 0009 decision 3 and 4,
//! SPEC 5.2, 5.3 and 6).
//!
//! The permission matrix ([`crate::policy`]) says who may use the sites area at all. A zone
//! then narrows it with settings the admin owns (the zone resource of H-02): whether the zone
//! is enabled, which roles or which named accounts may host, whether anonymous clients may,
//! and whether sites may be public. [`may_host`] applies all of it in one place and also says
//! what the site may do ([`HostingGrant`]): an anonymous site is internal, temporary and has no
//! JavaScript; an account's site may be permanent and run JavaScript.
//!
//! No zone is special: every rule reads the [`ZonePolicy`] it is given and nothing else. The
//! defaults are those of SPEC 5.2.

use std::collections::BTreeSet;

use crate::policy::{Decision, Denial, Requirement, Subject, decide};
use crate::scope::{Area, Level, Permission};
use crate::session::Role;

/// Who may see a site (ADR 0009 decision 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    /// Served only to the LAN.
    Internal,
    /// Served to the LAN and through the tunnel.
    Public,
}

/// The policy of one zone, as the admin set it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZonePolicy {
    /// A disabled zone accepts no new sites.
    pub enabled: bool,
    /// The roles that may create sites here (ignored while `hosting_accounts` is set).
    pub hosting_roles: BTreeSet<Role>,
    /// When set, only these accounts (login names) may host here, whatever their role:
    /// "trusted accounts only". It replaces the role rule.
    pub hosting_accounts: Option<BTreeSet<String>>,
    /// Whether anonymous clients may create (internal) sites here.
    pub anonymous_hosting: bool,
    /// Whether sites here may be public.
    pub public_sites: bool,
}

impl Default for ZonePolicy {
    /// The defaults of SPEC 5.2: enabled, every role from `user` up, no allow-list, no
    /// anonymous hosting, no public sites.
    fn default() -> Self {
        Self {
            enabled: true,
            hosting_roles: Role::ALL.into_iter().collect(),
            hosting_accounts: None,
            anonymous_hosting: false,
            public_sites: false,
        }
    }
}

/// What a site created by a subject may be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostingGrant {
    /// Whether the site may be permanent (otherwise it must expire).
    pub permanent: bool,
    /// Whether the site may run JavaScript.
    pub javascript: bool,
    /// Whether the site may be public (otherwise it is internal).
    pub public: bool,
}

/// Why hosting is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostingDenial {
    /// The permission matrix refuses the subject (not logged in, no `sites:write` scope, a
    /// service account's session).
    Unauthorized(Denial),
    /// The zone is disabled.
    ZoneDisabled,
    /// The zone does not allow anonymous hosting.
    AnonymousNotAllowed,
    /// Anonymous sites are always internal (ADR 0009 decision 4).
    AnonymousPublic,
    /// The account is not among those who may host in this zone (role or allow-list).
    NotAllowedHere,
    /// The zone does not allow public sites.
    PublicNotAllowed,
}

impl HostingDenial {
    /// A stable rule name; never contains request data.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Unauthorized(denial) => denial.code(),
            Self::ZoneDisabled => "zone_disabled",
            Self::AnonymousNotAllowed => "anonymous_not_allowed",
            Self::AnonymousPublic => "anonymous_public",
            Self::NotAllowedHere => "not_allowed_here",
            Self::PublicNotAllowed => "public_not_allowed",
        }
    }
}

/// Whether `subject` may create (or change the visibility of) a site with `visibility` in a
/// zone with this policy, and what the site may be.
///
/// The order of the checks is part of the contract, so the reason is stable: the permission
/// matrix (`sites:write`), then the zone's enabled flag, then the rules for the kind of
/// subject.
///
/// # Errors
///
/// The [`HostingDenial`] of the first rule that refuses.
pub fn may_host(
    subject: &Subject<'_>,
    zone: &ZonePolicy,
    visibility: Visibility,
) -> Result<HostingGrant, HostingDenial> {
    let needed = Permission::new(Area::Sites, Level::Write);
    if let Decision::Deny(denial) = decide(subject, Requirement::Permit(needed)) {
        return Err(HostingDenial::Unauthorized(denial));
    }
    if !zone.enabled {
        return Err(HostingDenial::ZoneDisabled);
    }
    let Some(account) = subject.account() else {
        // Anonymous: only where the zone says so, only internal, only temporary, no scripts.
        if !zone.anonymous_hosting {
            return Err(HostingDenial::AnonymousNotAllowed);
        }
        if visibility == Visibility::Public {
            return Err(HostingDenial::AnonymousPublic);
        }
        return Ok(HostingGrant {
            permanent: false,
            javascript: false,
            public: false,
        });
    };
    let listed = match &zone.hosting_accounts {
        Some(accounts) => accounts.contains(account.login),
        None => zone.hosting_roles.contains(&account.role),
    };
    if !listed {
        return Err(HostingDenial::NotAllowedHere);
    }
    if visibility == Visibility::Public && !zone.public_sites {
        return Err(HostingDenial::PublicNotAllowed);
    }
    Ok(HostingGrant {
        permanent: true,
        javascript: true,
        public: zone.public_sites,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::Account;
    use crate::scope::Scopes;
    use crate::session::UserKind;

    fn person(login: &str, role: Role) -> Subject<'_> {
        Subject::Session(Account {
            login,
            kind: UserKind::Person,
            role,
        })
    }

    fn zone() -> ZonePolicy {
        ZonePolicy::default()
    }

    const ACCOUNT_GRANT: HostingGrant = HostingGrant {
        permanent: true,
        javascript: true,
        public: false,
    };

    #[test]
    fn the_defaults_are_those_of_the_spec() {
        let policy = ZonePolicy::default();
        assert!(policy.enabled);
        assert_eq!(
            policy.hosting_roles,
            [Role::User, Role::Moderator, Role::Admin]
                .into_iter()
                .collect()
        );
        assert_eq!(policy.hosting_accounts, None);
        assert!(!policy.anonymous_hosting);
        assert!(!policy.public_sites);
    }

    #[test]
    fn accounts_host_internal_sites_by_default() {
        for role in Role::ALL {
            assert_eq!(
                may_host(&person("a", role), &zone(), Visibility::Internal),
                Ok(ACCOUNT_GRANT)
            );
        }
    }

    #[test]
    fn public_sites_need_the_zone_to_allow_them() {
        let mut policy = zone();
        assert_eq!(
            may_host(&person("a", Role::User), &policy, Visibility::Public),
            Err(HostingDenial::PublicNotAllowed)
        );
        policy.public_sites = true;
        assert_eq!(
            may_host(&person("a", Role::User), &policy, Visibility::Public),
            Ok(HostingGrant {
                public: true,
                ..ACCOUNT_GRANT
            })
        );
        // Allowing public sites does not make an internal site public.
        assert_eq!(
            may_host(&person("a", Role::User), &policy, Visibility::Internal),
            Ok(HostingGrant {
                public: true,
                ..ACCOUNT_GRANT
            })
        );
    }

    #[test]
    fn anonymous_clients_host_only_where_the_zone_allows_it() {
        let mut policy = zone();
        for visibility in [Visibility::Internal, Visibility::Public] {
            assert_eq!(
                may_host(&Subject::Anonymous, &policy, visibility),
                Err(HostingDenial::AnonymousNotAllowed)
            );
        }
        policy.anonymous_hosting = true;
        assert_eq!(
            may_host(&Subject::Anonymous, &policy, Visibility::Internal),
            Ok(HostingGrant {
                permanent: false,
                javascript: false,
                public: false
            })
        );
        // Never public, even where the zone allows public sites.
        policy.public_sites = true;
        assert_eq!(
            may_host(&Subject::Anonymous, &policy, Visibility::Public),
            Err(HostingDenial::AnonymousPublic)
        );
        assert_eq!(
            may_host(&Subject::Anonymous, &policy, Visibility::Internal),
            Ok(HostingGrant {
                permanent: false,
                javascript: false,
                public: false
            })
        );
    }

    #[test]
    fn a_disabled_zone_accepts_nobody() {
        let mut policy = zone();
        policy.enabled = false;
        policy.anonymous_hosting = true;
        for subject in [
            Subject::Anonymous,
            person("a", Role::User),
            person("a", Role::Admin),
        ] {
            assert_eq!(
                may_host(&subject, &policy, Visibility::Internal),
                Err(HostingDenial::ZoneDisabled)
            );
        }
    }

    #[test]
    fn the_role_rule_names_the_roles() {
        let mut policy = zone();
        policy.hosting_roles = [Role::Moderator, Role::Admin].into_iter().collect();
        assert_eq!(
            may_host(&person("a", Role::User), &policy, Visibility::Internal),
            Err(HostingDenial::NotAllowedHere)
        );
        for role in [Role::Moderator, Role::Admin] {
            assert!(may_host(&person("a", role), &policy, Visibility::Internal).is_ok());
        }
        // No role at all: nobody hosts, not even an admin (no zone is special).
        policy.hosting_roles.clear();
        assert_eq!(
            may_host(&person("a", Role::Admin), &policy, Visibility::Internal),
            Err(HostingDenial::NotAllowedHere)
        );
    }

    #[test]
    fn an_allow_list_replaces_the_role_rule() {
        let mut policy = zone();
        policy.hosting_accounts = Some(["trusted".to_owned()].into_iter().collect());
        // Listed: allowed whatever the role, also one the role rule would refuse.
        policy.hosting_roles.clear();
        assert_eq!(
            may_host(
                &person("trusted", Role::User),
                &policy,
                Visibility::Internal
            ),
            Ok(ACCOUNT_GRANT)
        );
        // Not listed: refused whatever the role, also one the role rule would allow.
        policy.hosting_roles = Role::ALL.into_iter().collect();
        for role in Role::ALL {
            assert_eq!(
                may_host(&person("other", role), &policy, Visibility::Internal),
                Err(HostingDenial::NotAllowedHere)
            );
        }
        // The login is compared exactly.
        for login in ["Trusted", "trusted ", "trust", ""] {
            assert_eq!(
                may_host(&person(login, Role::Admin), &policy, Visibility::Internal),
                Err(HostingDenial::NotAllowedHere),
                "{login:?}"
            );
        }
        // An empty list means nobody.
        policy.hosting_accounts = Some(BTreeSet::new());
        assert_eq!(
            may_host(
                &person("trusted", Role::Admin),
                &policy,
                Visibility::Internal
            ),
            Err(HostingDenial::NotAllowedHere)
        );
    }

    #[test]
    fn the_allow_list_does_not_let_anonymous_clients_in() {
        let mut policy = zone();
        policy.hosting_accounts = Some(BTreeSet::new());
        assert_eq!(
            may_host(&Subject::Anonymous, &policy, Visibility::Internal),
            Err(HostingDenial::AnonymousNotAllowed)
        );
        // Anonymous hosting is its own setting; the allow-list is about accounts.
        policy.anonymous_hosting = true;
        assert!(may_host(&Subject::Anonymous, &policy, Visibility::Internal).is_ok());
    }

    #[test]
    fn a_token_needs_the_sites_scope_and_the_zone_rules() {
        let write = Scopes::parse(["sites:write"]).unwrap();
        let read = Scopes::parse(["sites:read"]).unwrap();
        let owner = Account {
            login: "a",
            kind: UserKind::Person,
            role: Role::User,
        };
        assert_eq!(
            may_host(
                &Subject::Token {
                    owner,
                    scopes: &write
                },
                &zone(),
                Visibility::Internal
            ),
            Ok(ACCOUNT_GRANT)
        );
        assert_eq!(
            may_host(
                &Subject::Token {
                    owner,
                    scopes: &read
                },
                &zone(),
                Visibility::Internal
            ),
            Err(HostingDenial::Unauthorized(Denial::MissingScope))
        );
        // The zone rules apply to the owner of the token.
        let mut policy = zone();
        policy.hosting_accounts = Some(BTreeSet::new());
        assert_eq!(
            may_host(
                &Subject::Token {
                    owner,
                    scopes: &write
                },
                &policy,
                Visibility::Internal
            ),
            Err(HostingDenial::NotAllowedHere)
        );
    }

    #[test]
    fn a_service_account_hosts_through_tokens_only() {
        let write = Scopes::parse(["sites:write"]).unwrap();
        let owner = Account {
            login: "ci",
            kind: UserKind::Service,
            role: Role::User,
        };
        assert_eq!(
            may_host(&Subject::Session(owner), &zone(), Visibility::Internal),
            Err(HostingDenial::Unauthorized(Denial::ServiceSession))
        );
        assert_eq!(
            may_host(
                &Subject::Token {
                    owner,
                    scopes: &write
                },
                &zone(),
                Visibility::Internal
            ),
            Ok(ACCOUNT_GRANT)
        );
    }

    #[test]
    fn the_reason_follows_the_order_of_the_checks() {
        // Matrix first: a token without the scope hears that, not the zone's state.
        let none = Scopes::none();
        let owner = Account {
            login: "a",
            kind: UserKind::Person,
            role: Role::User,
        };
        let mut policy = zone();
        policy.enabled = false;
        assert_eq!(
            may_host(
                &Subject::Token {
                    owner,
                    scopes: &none
                },
                &policy,
                Visibility::Public
            ),
            Err(HostingDenial::Unauthorized(Denial::MissingScope))
        );
        // Then the enabled flag, before the rules about the account.
        assert_eq!(
            may_host(&person("a", Role::User), &policy, Visibility::Public),
            Err(HostingDenial::ZoneDisabled)
        );
        // Who may host comes before whether public is allowed.
        let mut policy = zone();
        policy.hosting_roles.clear();
        assert_eq!(
            may_host(&person("a", Role::User), &policy, Visibility::Public),
            Err(HostingDenial::NotAllowedHere)
        );
        // For anonymous clients "not allowed here" comes before "not public".
        let policy = zone();
        assert_eq!(
            may_host(&Subject::Anonymous, &policy, Visibility::Public),
            Err(HostingDenial::AnonymousNotAllowed)
        );
    }

    #[test]
    fn denial_codes() {
        assert_eq!(
            HostingDenial::Unauthorized(Denial::MissingScope).code(),
            "missing_scope"
        );
        assert_eq!(HostingDenial::ZoneDisabled.code(), "zone_disabled");
        assert_eq!(
            HostingDenial::AnonymousNotAllowed.code(),
            "anonymous_not_allowed"
        );
        assert_eq!(HostingDenial::AnonymousPublic.code(), "anonymous_public");
        assert_eq!(HostingDenial::NotAllowedHere.code(), "not_allowed_here");
        assert_eq!(HostingDenial::PublicNotAllowed.code(), "public_not_allowed");
    }
}
