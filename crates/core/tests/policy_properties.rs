//! Property tests of the authorisation rules (A-07): scope texts, the permission matrix, the
//! intersection of token scopes and owner role, and the zone-level hosting rules.

use std::collections::BTreeSet;

use proptest::prelude::*;
use stuffcloud_core::hosting::{HostingDenial, Visibility, ZonePolicy, may_host};
use stuffcloud_core::policy::{
    Account, Decision, Denial, Requirement, Subject, anonymous_permissions, decide, effective,
    grant, role_permissions,
};
use stuffcloud_core::scope::{Level, Permission, Scopes};
use stuffcloud_core::session::{Role, UserKind};

fn role() -> impl Strategy<Value = Role> {
    prop::sample::select(Role::ALL.to_vec())
}

fn kind() -> impl Strategy<Value = UserKind> {
    prop::sample::select(UserKind::ALL.to_vec())
}

fn permission() -> impl Strategy<Value = Permission> {
    prop::sample::select(Permission::all().collect::<Vec<_>>())
}

fn scopes() -> impl Strategy<Value = Scopes> {
    prop::collection::vec(permission(), 0..8).prop_map(Scopes::of)
}

fn visibility() -> impl Strategy<Value = Visibility> {
    prop_oneof![Just(Visibility::Internal), Just(Visibility::Public)]
}

fn login() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("alice".to_owned()),
        Just("bob".to_owned()),
        "[a-z]{1,6}"
    ]
}

fn zone() -> impl Strategy<Value = ZonePolicy> {
    (
        any::<bool>(),
        prop::collection::btree_set(role(), 0..4),
        prop::option::of(prop::collection::btree_set(login(), 0..4)),
        any::<bool>(),
        any::<bool>(),
    )
        .prop_map(
            |(enabled, hosting_roles, hosting_accounts, anonymous_hosting, public_sites)| {
                ZonePolicy {
                    enabled,
                    hosting_roles,
                    hosting_accounts,
                    anonymous_hosting,
                    public_sites,
                }
            },
        )
}

/// What the scopes alone grant (no role involved), computed without `Scopes::covers`.
fn granted_by(scopes: &Scopes) -> BTreeSet<Permission> {
    Permission::all()
        .filter(|needed| {
            scopes.iter().any(|scope| {
                scope.area == needed.area
                    && (scope.level == Level::Write || needed.level == Level::Read)
            })
        })
        .collect()
}

proptest! {
    #[test]
    fn a_scope_text_that_parses_prints_back_exactly(text in "[a-z:A-Z ]{0,24}") {
        if let Ok(permission) = Permission::parse(&text) {
            prop_assert_eq!(permission.to_string(), text);
        }
    }

    #[test]
    fn every_permission_round_trips_through_its_text(permission in permission()) {
        prop_assert_eq!(Permission::parse(&permission.to_string()), Ok(permission));
    }

    #[test]
    fn a_token_has_the_intersection_of_its_scopes_and_its_owners_role(
        owner_kind in kind(), owner_role in role(), scopes in scopes()
    ) {
        let owner = Account { login: "owner", kind: owner_kind, role: owner_role };
        let token = Subject::Token { owner, scopes: &scopes };
        let expected: BTreeSet<Permission> = role_permissions(owner_role)
            .intersection(&granted_by(&scopes))
            .copied()
            .collect();
        prop_assert_eq!(effective(&token), expected);
    }

    #[test]
    fn a_token_never_exceeds_its_owner(owner_role in role(), scopes in scopes()) {
        let owner = Account { login: "owner", kind: UserKind::Person, role: owner_role };
        let token = effective(&Subject::Token { owner, scopes: &scopes });
        let session = effective(&Subject::Session(owner));
        prop_assert!(token.is_subset(&session));
    }

    #[test]
    fn admin_scopes_stop_working_when_the_owner_is_no_admin(
        owner_role in role(), scopes in scopes(), needed in permission()
    ) {
        let owner = Account { login: "owner", kind: UserKind::Person, role: owner_role };
        let token = Subject::Token { owner, scopes: &scopes };
        if grant(needed).role == Role::Admin && owner_role != Role::Admin {
            prop_assert!(!effective(&token).contains(&needed));
            prop_assert!(!decide(&token, Requirement::Permit(needed)).is_allowed());
        }
    }

    #[test]
    fn demoting_the_owner_never_widens_a_token(
        first in role(), second in role(), scopes in scopes()
    ) {
        let (low, high) = if first <= second { (first, second) } else { (second, first) };
        let of = |role| {
            effective(&Subject::Token {
                owner: Account { login: "owner", kind: UserKind::Person, role },
                scopes: &scopes,
            })
        };
        prop_assert!(of(low).is_subset(&of(high)));
    }

    #[test]
    fn more_scopes_never_mean_less(a in scopes(), b in scopes(), owner_role in role()) {
        let owner = Account { login: "owner", kind: UserKind::Person, role: owner_role };
        let union = Scopes::of(a.iter().chain(b.iter()));
        let with = |scopes: &Scopes| effective(&Subject::Token { owner, scopes });
        prop_assert!(with(&a).is_subset(&with(&union)));
        prop_assert!(with(&b).is_subset(&with(&union)));
    }

    #[test]
    fn decide_agrees_with_effective(
        owner_kind in kind(), owner_role in role(), scopes in scopes(), needed in permission(),
        which in 0_u8..3
    ) {
        let owner = Account { login: "owner", kind: owner_kind, role: owner_role };
        let subject = match which {
            0 => Subject::Anonymous,
            1 => Subject::Session(owner),
            _ => Subject::Token { owner, scopes: &scopes },
        };
        let allowed = decide(&subject, Requirement::Permit(needed)) == Decision::Allow;
        prop_assert_eq!(allowed, effective(&subject).contains(&needed));
    }

    #[test]
    fn anonymous_is_the_lowest_and_roles_only_add(role_a in role(), role_b in role()) {
        prop_assert!(anonymous_permissions().is_subset(&role_permissions(Role::User)));
        if role_a <= role_b {
            prop_assert!(role_permissions(role_a).is_subset(&role_permissions(role_b)));
        }
    }

    #[test]
    fn a_session_route_is_never_open_to_a_token_or_to_nobody(
        owner_role in role(), scopes in scopes()
    ) {
        let owner = Account { login: "owner", kind: UserKind::Person, role: owner_role };
        prop_assert_eq!(
            decide(&Subject::Token { owner, scopes: &scopes }, Requirement::Session),
            Decision::Deny(Denial::SessionRequired)
        );
        prop_assert_eq!(
            decide(&Subject::Anonymous, Requirement::Session),
            Decision::Deny(Denial::Unauthenticated)
        );
    }

    #[test]
    fn a_token_creates_tokens_only_within_its_scopes(parent in scopes(), child in scopes()) {
        let may = parent.may_grant(&child);
        let covered = child.iter().all(|scope| parent.covers(scope));
        prop_assert_eq!(may, covered);
        if may {
            prop_assert!(granted_by(&child).is_subset(&granted_by(&parent)));
        }
        prop_assert!(parent.may_grant(&parent));
    }

    #[test]
    fn may_grant_is_transitive(a in scopes(), b in scopes(), c in scopes()) {
        if a.may_grant(&b) && b.may_grant(&c) {
            prop_assert!(a.may_grant(&c));
        }
    }

    #[test]
    fn anonymous_clients_never_host_public_permanent_or_scripted_sites(
        zone in zone(), visibility in visibility()
    ) {
        if let Ok(grant) = may_host(&Subject::Anonymous, &zone, visibility) {
            prop_assert_eq!(visibility, Visibility::Internal);
            prop_assert!(zone.enabled);
            prop_assert!(zone.anonymous_hosting);
            prop_assert!(!grant.public);
            prop_assert!(!grant.permanent);
            prop_assert!(!grant.javascript);
        }
    }

    #[test]
    fn a_disabled_zone_accepts_nobody(
        mut zone in zone(), visibility in visibility(), owner_role in role(), name in login()
    ) {
        zone.enabled = false;
        let account = Account { login: &name, kind: UserKind::Person, role: owner_role };
        for subject in [Subject::Anonymous, Subject::Session(account)] {
            prop_assert!(may_host(&subject, &zone, visibility).is_err());
        }
    }

    #[test]
    fn who_may_host_follows_the_allow_list_or_the_roles(
        zone in zone(), visibility in visibility(), owner_role in role(), name in login()
    ) {
        let account = Account { login: &name, kind: UserKind::Person, role: owner_role };
        let result = may_host(&Subject::Session(account), &zone, visibility);
        let listed = match &zone.hosting_accounts {
            Some(accounts) => accounts.contains(&name),
            None => zone.hosting_roles.contains(&owner_role),
        };
        match result {
            Ok(grant) => {
                prop_assert!(zone.enabled);
                prop_assert!(listed);
                prop_assert!(grant.permanent && grant.javascript);
                prop_assert_eq!(grant.public, zone.public_sites);
                if visibility == Visibility::Public {
                    prop_assert!(zone.public_sites);
                }
            }
            Err(HostingDenial::NotAllowedHere) => {
                prop_assert!(zone.enabled);
                prop_assert!(!listed);
            }
            Err(HostingDenial::ZoneDisabled) => prop_assert!(!zone.enabled),
            Err(HostingDenial::PublicNotAllowed) => {
                prop_assert!(zone.enabled && listed);
                prop_assert_eq!(visibility, Visibility::Public);
                prop_assert!(!zone.public_sites);
            }
            Err(other) => return Err(TestCaseError::fail(format!("unexpected {other:?}"))),
        }
    }

    #[test]
    fn an_allow_list_makes_the_roles_irrelevant(
        mut zone in zone(), roles in prop::collection::btree_set(role(), 0..4),
        owner_role in role(), name in login(), visibility in visibility()
    ) {
        let _list = zone.hosting_accounts.get_or_insert_with(BTreeSet::new);
        let account = Account { login: &name, kind: UserKind::Person, role: owner_role };
        let before = may_host(&Subject::Session(account), &zone, visibility);
        zone.hosting_roles = roles;
        prop_assert_eq!(may_host(&Subject::Session(account), &zone, visibility), before);
    }
}
