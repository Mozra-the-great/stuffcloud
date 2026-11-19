//! Permission names and token scopes (A-07, SPEC 10.4, ADR 0010 decision 5).
//!
//! A [`Permission`] is an [`Area`] of the API at a [`Level`]: `sites:read`, `admin:zones:write`.
//! The text form is also the scope a token can carry (`<area>:<read|write>`), so a scope *is*
//! the permission it grants. `write` includes `read` of the same area ([`Permission::covers`]).
//!
//! [`Scopes`] is the set of scopes of one token. What a token may do is decided in
//! [`crate::policy`]: its scopes intersected with the role of its owner.
//!
//! Everything here is pure and total: parsing never panics, and every accepted text formats
//! back to exactly itself, which the property tests and the fuzz target `scope` assert.

use std::collections::BTreeSet;
use std::fmt;

/// How far an area is opened: reading it, or changing it (which includes reading).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    /// Read only.
    Read,
    /// Change, and read.
    Write,
}

impl Level {
    /// Every level, lowest first.
    pub const ALL: [Self; 2] = [Self::Read, Self::Write];

    /// The text form.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }

    /// Parses the text form (exact, lower case).
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|level| level.as_str() == text)
    }

    /// Whether a grant of this level also grants `needed`.
    #[must_use]
    pub fn covers(self, needed: Self) -> bool {
        self >= needed
    }
}

/// A part of the API that a permission or scope is about (SPEC 10.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Area {
    /// The caller's own sites (and, with the zone rules, creating them).
    Sites,
    /// The caller's own account: profile, passkeys, sessions.
    Account,
    /// The caller's own API tokens.
    Tokens,
    /// Zones and their policy (ADR 0009).
    AdminZones,
    /// Users, roles and service accounts.
    AdminUsers,
    /// Instance-wide settings groups.
    AdminSettings,
    /// The blocklist (hashes and patterns).
    AdminBlocklist,
    /// The tokens of other accounts.
    AdminTokens,
    /// Abuse reports and takedowns.
    Moderation,
}

impl Area {
    /// Every area, in the order of SPEC 10.4.
    pub const ALL: [Self; 9] = [
        Self::Sites,
        Self::Account,
        Self::Tokens,
        Self::AdminZones,
        Self::AdminUsers,
        Self::AdminSettings,
        Self::AdminBlocklist,
        Self::AdminTokens,
        Self::Moderation,
    ];

    /// The text form (the scope without its level).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sites => "sites",
            Self::Account => "account",
            Self::Tokens => "tokens",
            Self::AdminZones => "admin:zones",
            Self::AdminUsers => "admin:users",
            Self::AdminSettings => "admin:settings",
            Self::AdminBlocklist => "admin:blocklist",
            Self::AdminTokens => "admin:tokens",
            Self::Moderation => "moderation",
        }
    }

    /// Parses the text form (exact, lower case).
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|area| area.as_str() == text)
    }
}

/// An area at a level: what a route needs, what a role has, and what a token scope grants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Permission {
    /// The part of the API.
    pub area: Area,
    /// Read or write.
    pub level: Level,
}

/// Why a scope text was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeError {
    /// There is no `:` that separates a level from the area.
    NoLevel,
    /// The text after the last `:` is neither `read` nor `write`.
    UnknownLevel,
    /// The text before the last `:` names no area.
    UnknownArea,
}

impl fmt::Display for ScopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NoLevel => "a scope is <area>:<read|write>",
            Self::UnknownLevel => "the level of a scope is read or write",
            Self::UnknownArea => "this scope names no area",
        })
    }
}

impl std::error::Error for ScopeError {}

impl Permission {
    /// A permission.
    #[must_use]
    pub const fn new(area: Area, level: Level) -> Self {
        Self { area, level }
    }

    /// Every permission: each area at each level.
    pub fn all() -> impl Iterator<Item = Self> {
        Area::ALL.into_iter().flat_map(|area| {
            Level::ALL
                .into_iter()
                .map(move |level| Self { area, level })
        })
    }

    /// Parses `<area>:<read|write>`. The level is what follows the last `:` (areas contain
    /// one, `admin:zones`). Nothing is trimmed or case-folded: a scope is a token, not prose.
    ///
    /// # Errors
    ///
    /// [`ScopeError`] for any other text.
    pub fn parse(text: &str) -> Result<Self, ScopeError> {
        let (area, level) = text.rsplit_once(':').ok_or(ScopeError::NoLevel)?;
        let level = Level::parse(level).ok_or(ScopeError::UnknownLevel)?;
        let area = Area::parse(area).ok_or(ScopeError::UnknownArea)?;
        Ok(Self { area, level })
    }

    /// Whether holding `self` also grants `needed`: same area, and a level that covers it.
    #[must_use]
    pub fn covers(self, needed: Self) -> bool {
        self.area == needed.area && self.level.covers(needed.level)
    }
}

impl fmt::Display for Permission {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.area.as_str(), self.level.as_str())
    }
}

/// The scopes of one token: a set, so a repeated scope counts once.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scopes(BTreeSet<Permission>);

impl Scopes {
    /// No scope: such a token can do nothing.
    #[must_use]
    pub const fn none() -> Self {
        Self(BTreeSet::new())
    }

    /// The scopes named by `items`.
    ///
    /// # Errors
    ///
    /// The [`ScopeError`] of the first item that is no scope.
    pub fn parse<'a, I>(items: I) -> Result<Self, ScopeError>
    where
        I: IntoIterator<Item = &'a str>,
    {
        items
            .into_iter()
            .map(Permission::parse)
            .collect::<Result<BTreeSet<_>, _>>()
            .map(Self)
    }

    /// The scopes that grant these permissions.
    pub fn of<I>(permissions: I) -> Self
    where
        I: IntoIterator<Item = Permission>,
    {
        Self(permissions.into_iter().collect())
    }

    /// Whether one of the scopes grants `needed` (a `write` scope grants the `read` of its
    /// area).
    #[must_use]
    pub fn covers(&self, needed: Permission) -> bool {
        self.0.iter().any(|scope| scope.covers(needed))
    }

    /// Whether a token with these scopes may create a token with `requested`: every requested
    /// scope must already be granted here (SPEC 10.4, "a subset of its own scopes").
    #[must_use]
    pub fn may_grant(&self, requested: &Self) -> bool {
        requested.0.iter().all(|scope| self.covers(*scope))
    }

    /// The scopes in their fixed order.
    pub fn iter(&self) -> impl Iterator<Item = Permission> + '_ {
        self.0.iter().copied()
    }

    /// How many distinct scopes there are.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether there is no scope.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn permission(text: &str) -> Permission {
        Permission::parse(text).unwrap()
    }

    #[test]
    fn levels() {
        assert_eq!(Level::Read.as_str(), "read");
        assert_eq!(Level::Write.as_str(), "write");
        assert_eq!(Level::parse("read"), Some(Level::Read));
        assert_eq!(Level::parse("write"), Some(Level::Write));
        for refused in ["", "Read", "WRITE", " read", "read ", "rw", "admin"] {
            assert_eq!(Level::parse(refused), None, "{refused:?}");
        }
        assert!(Level::Read.covers(Level::Read));
        assert!(!Level::Read.covers(Level::Write));
        assert!(Level::Write.covers(Level::Read));
        assert!(Level::Write.covers(Level::Write));
    }

    #[test]
    fn areas_have_the_names_of_the_spec() {
        let names: Vec<&str> = Area::ALL.iter().map(|area| area.as_str()).collect();
        assert_eq!(
            names,
            [
                "sites",
                "account",
                "tokens",
                "admin:zones",
                "admin:users",
                "admin:settings",
                "admin:blocklist",
                "admin:tokens",
                "moderation",
            ]
        );
        for area in Area::ALL {
            assert_eq!(Area::parse(area.as_str()), Some(area));
        }
        for refused in ["", "Sites", "admin", "admin:", ":zones", "site", "sites "] {
            assert_eq!(Area::parse(refused), None, "{refused:?}");
        }
    }

    #[test]
    fn every_area_at_every_level_is_a_permission() {
        let all: Vec<Permission> = Permission::all().collect();
        assert_eq!(all.len(), 18);
        let distinct: BTreeSet<Permission> = all.iter().copied().collect();
        assert_eq!(distinct.len(), 18);
        assert_eq!(
            all.first().map(ToString::to_string).as_deref(),
            Some("sites:read")
        );
        assert_eq!(
            all.last().map(ToString::to_string).as_deref(),
            Some("moderation:write")
        );
    }

    #[test]
    fn permissions_parse_and_print() {
        assert_eq!(
            permission("sites:read"),
            Permission::new(Area::Sites, Level::Read)
        );
        assert_eq!(
            permission("admin:zones:write"),
            Permission::new(Area::AdminZones, Level::Write)
        );
        assert_eq!(
            permission("moderation:read"),
            Permission::new(Area::Moderation, Level::Read)
        );
        for permission in Permission::all() {
            assert_eq!(Permission::parse(&permission.to_string()), Ok(permission));
        }
        assert_eq!(
            Permission::new(Area::AdminTokens, Level::Write).to_string(),
            "admin:tokens:write"
        );
    }

    #[test]
    fn bad_scope_texts_say_what_is_wrong() {
        let cases = [
            ("", ScopeError::NoLevel),
            ("sites", ScopeError::NoLevel),
            ("admin", ScopeError::NoLevel),
            ("sites:", ScopeError::UnknownLevel),
            ("sites:delete", ScopeError::UnknownLevel),
            ("sites:Read", ScopeError::UnknownLevel),
            ("sites:read ", ScopeError::UnknownLevel),
            ("sites:read:write", ScopeError::UnknownArea),
            (":read", ScopeError::UnknownArea),
            ("admin:read", ScopeError::UnknownArea),
            ("admin:zone:read", ScopeError::UnknownArea),
            ("Sites:read", ScopeError::UnknownArea),
            (" sites:read", ScopeError::UnknownArea),
            ("*:read", ScopeError::UnknownArea),
            ("admin:*:write", ScopeError::UnknownArea),
        ];
        for (text, error) in cases {
            assert_eq!(Permission::parse(text), Err(error), "{text:?}");
        }
        assert_eq!(
            ScopeError::NoLevel.to_string(),
            "a scope is <area>:<read|write>"
        );
        assert_eq!(
            ScopeError::UnknownLevel.to_string(),
            "the level of a scope is read or write"
        );
        assert_eq!(
            ScopeError::UnknownArea.to_string(),
            "this scope names no area"
        );
    }

    #[test]
    fn write_covers_read_of_the_same_area_only() {
        let write = permission("sites:write");
        assert!(write.covers(permission("sites:write")));
        assert!(write.covers(permission("sites:read")));
        assert!(!write.covers(permission("tokens:read")));
        assert!(!write.covers(permission("admin:zones:read")));
        let read = permission("sites:read");
        assert!(read.covers(permission("sites:read")));
        assert!(!read.covers(permission("sites:write")));
        assert!(!read.covers(permission("account:read")));
    }

    #[test]
    fn a_set_of_scopes() {
        let scopes = Scopes::parse(["sites:write", "admin:zones:read", "sites:write"]).unwrap();
        assert_eq!(scopes.len(), 2);
        assert!(!scopes.is_empty());
        assert!(scopes.covers(permission("sites:read")));
        assert!(scopes.covers(permission("sites:write")));
        assert!(scopes.covers(permission("admin:zones:read")));
        assert!(!scopes.covers(permission("admin:zones:write")));
        assert!(!scopes.covers(permission("account:read")));
        let listed: Vec<String> = scopes.iter().map(|scope| scope.to_string()).collect();
        assert_eq!(listed, ["sites:write", "admin:zones:read"]);
        assert_eq!(
            Scopes::parse(["sites:write", "nope"]),
            Err(ScopeError::NoLevel)
        );
        assert_eq!(
            Scopes::parse(["nope:read", "sites:write", "x"]),
            Err(ScopeError::UnknownArea)
        );
    }

    #[test]
    fn no_scopes_grant_nothing() {
        let none = Scopes::none();
        assert!(none.is_empty());
        assert_eq!(none.len(), 0);
        assert_eq!(none, Scopes::default());
        assert_eq!(none, Scopes::parse([]).unwrap());
        for permission in Permission::all() {
            assert!(!none.covers(permission));
        }
        assert_eq!(none.iter().count(), 0);
    }

    #[test]
    fn a_token_creates_tokens_only_within_its_own_scopes() {
        let parent = Scopes::parse(["sites:write", "tokens:read", "admin:zones:read"]).unwrap();
        let may = |requested: &[&str]| {
            parent.may_grant(&Scopes::parse(requested.iter().copied()).unwrap())
        };
        assert!(may(&[]));
        assert!(may(&["sites:write"]));
        assert!(may(&["sites:read"]));
        assert!(may(&["sites:read", "tokens:read", "admin:zones:read"]));
        assert!(!may(&["tokens:write"]));
        assert!(!may(&["admin:zones:write"]));
        assert!(!may(&["sites:write", "account:read"]));
        assert!(!may(&["admin:users:read"]));
        assert!(!Scopes::none().may_grant(&Scopes::of([permission("sites:read")])));
        assert!(Scopes::none().may_grant(&Scopes::none()));
    }

    #[test]
    fn scopes_from_permissions() {
        let scopes = Scopes::of([permission("sites:read"), permission("sites:read")]);
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes, Scopes::parse(["sites:read"]).unwrap());
    }
}
