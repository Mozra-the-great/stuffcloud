//! Session lifetimes and the account vocabulary of the auth model (A-02, ADR 0005, SPEC 6).
//!
//! A session ends when it has been idle for longer than the idle timeout, or when it is older
//! than the absolute timeout, whichever comes first ([`Timeouts::evaluate`]). Both are
//! deployment configuration (`app` reads them from the environment). Times are Unix
//! milliseconds; the arithmetic saturates, so no input can overflow.
//!
//! [`Role`] and [`UserKind`] are the stored values of an account. The permission matrix that
//! gives the roles their meaning is A-07 (#37); this module only names them.

use std::fmt;

use serde::Serialize;

/// Milliseconds per minute.
pub const MINUTE_MS: i64 = 60_000;

/// Milliseconds per hour.
pub const HOUR_MS: i64 = 60 * MINUTE_MS;

/// How long sessions may live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    /// A session not used for this long ends (milliseconds).
    pub idle_ms: i64,
    /// A session ends this long after it was created, however active it is (milliseconds).
    pub absolute_ms: i64,
}

/// Default idle timeout: 8 hours.
pub const DEFAULT_IDLE_MS: i64 = 8 * HOUR_MS;

/// Default absolute timeout: 7 days.
pub const DEFAULT_ABSOLUTE_MS: i64 = 7 * 24 * HOUR_MS;

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            idle_ms: DEFAULT_IDLE_MS,
            absolute_ms: DEFAULT_ABSOLUTE_MS,
        }
    }
}

/// The state of a session at one moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionAge {
    /// Still valid.
    Active {
        /// When it ends if it stays unused (Unix milliseconds).
        idle_expires_at: i64,
        /// When it ends at the latest (Unix milliseconds).
        absolute_expires_at: i64,
    },
    /// Unused for too long.
    IdleExpired,
    /// Older than the absolute timeout.
    AbsoluteExpired,
}

impl SessionAge {
    /// Whether the session is still valid.
    #[must_use]
    pub const fn is_active(self) -> bool {
        matches!(self, Self::Active { .. })
    }
}

impl Timeouts {
    /// The state of a session created at `created_at` and last used at `last_seen_at`, at
    /// `now`. A session is expired from the exact millisecond its timeout is reached. The
    /// absolute timeout wins when both are reached.
    #[must_use]
    pub const fn evaluate(&self, created_at: i64, last_seen_at: i64, now: i64) -> SessionAge {
        let absolute_expires_at = created_at.saturating_add(self.absolute_ms);
        let idle_expires_at = last_seen_at.saturating_add(self.idle_ms);
        if now >= absolute_expires_at {
            SessionAge::AbsoluteExpired
        } else if now >= idle_expires_at {
            SessionAge::IdleExpired
        } else {
            SessionAge::Active {
                idle_expires_at,
                absolute_expires_at,
            }
        }
    }

    /// Seconds from `now` until the absolute timeout (at least 0): the `Max-Age` of the
    /// session cookie, so the browser forgets it when the server would refuse it anyway.
    #[must_use]
    pub fn remaining_secs(&self, created_at: i64, now: i64) -> u64 {
        let left = created_at
            .saturating_add(self.absolute_ms)
            .saturating_sub(now);
        match u64::try_from(left) {
            Ok(millis) => millis / 1000,
            Err(_negative) => 0,
        }
    }
}

/// The role of an account (SPEC 6). Anonymous clients have no account and no role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub enum Role {
    /// A registered user.
    User,
    /// Handles reports, takedowns and the blocklist.
    Moderator,
    /// Everything, including users, zones and settings.
    Admin,
}

/// Kind of an account (SPEC 10.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub enum UserKind {
    /// A person who logs in interactively.
    Person,
    /// An automation account: tokens only, never a browser session.
    Service,
}

/// A stored role or kind name that this build does not know.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownName(pub String);

impl fmt::Display for UnknownName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown name {:?}", self.0)
    }
}

impl std::error::Error for UnknownName {}

impl Role {
    /// Every role, lowest first.
    pub const ALL: [Self; 3] = [Self::User, Self::Moderator, Self::Admin];

    /// The stored and serialised name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Moderator => "moderator",
            Self::Admin => "admin",
        }
    }

    /// Parses a stored name.
    ///
    /// # Errors
    ///
    /// [`UnknownName`] for any other text.
    pub fn parse(text: &str) -> Result<Self, UnknownName> {
        Self::ALL
            .into_iter()
            .find(|role| role.as_str() == text)
            .ok_or_else(|| UnknownName(text.to_owned()))
    }
}

impl UserKind {
    /// Every kind.
    pub const ALL: [Self; 2] = [Self::Person, Self::Service];

    /// The stored and serialised name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Service => "service",
        }
    }

    /// Parses a stored name.
    ///
    /// # Errors
    ///
    /// [`UnknownName`] for any other text.
    pub fn parse(text: &str) -> Result<Self, UnknownName> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == text)
            .ok_or_else(|| UnknownName(text.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Timeouts = Timeouts {
        idle_ms: 100,
        absolute_ms: 1000,
    };

    #[test]
    fn defaults() {
        let timeouts = Timeouts::default();
        assert_eq!(timeouts.idle_ms, 28_800_000);
        assert_eq!(timeouts.absolute_ms, 604_800_000);
        assert_eq!(HOUR_MS, 3_600_000);
    }

    #[test]
    fn idle_boundary() {
        assert_eq!(
            T.evaluate(0, 500, 599),
            SessionAge::Active {
                idle_expires_at: 600,
                absolute_expires_at: 1000
            }
        );
        assert_eq!(T.evaluate(0, 500, 600), SessionAge::IdleExpired);
        assert_eq!(T.evaluate(0, 500, 601), SessionAge::IdleExpired);
    }

    #[test]
    fn absolute_boundary_and_precedence() {
        assert!(T.evaluate(0, 950, 999).is_active());
        assert_eq!(T.evaluate(0, 950, 1000), SessionAge::AbsoluteExpired);
        // Both reached: the absolute timeout is reported.
        assert_eq!(T.evaluate(0, 0, 5000), SessionAge::AbsoluteExpired);
        assert!(!SessionAge::IdleExpired.is_active());
        assert!(!SessionAge::AbsoluteExpired.is_active());
    }

    #[test]
    fn saturates() {
        let huge = Timeouts {
            idle_ms: i64::MAX,
            absolute_ms: i64::MAX,
        };
        assert!(huge.evaluate(i64::MAX, i64::MAX, i64::MAX - 1).is_active());
        assert_eq!(
            huge.remaining_secs(i64::MAX, i64::MIN),
            9_223_372_036_854_775
        );
        assert_eq!(T.remaining_secs(i64::MIN, i64::MAX), 0);
    }

    #[test]
    fn remaining_seconds() {
        assert_eq!(T.remaining_secs(0, 0), 1);
        assert_eq!(T.remaining_secs(0, 1), 0);
        assert_eq!(T.remaining_secs(0, 999), 0);
        assert_eq!(T.remaining_secs(0, 1000), 0);
        assert_eq!(T.remaining_secs(0, 2000), 0);
        assert_eq!(T.remaining_secs(5000, 0), 6);
        let day = Timeouts::default();
        assert_eq!(day.remaining_secs(0, 0), 604_800);
    }

    #[test]
    fn roles_and_kinds() {
        for role in Role::ALL {
            assert_eq!(Role::parse(role.as_str()), Ok(role));
        }
        assert_eq!(Role::ALL.map(Role::as_str), ["user", "moderator", "admin"]);
        assert!(Role::User < Role::Moderator && Role::Moderator < Role::Admin);
        for bad in ["", "Admin", "anonymous", "root"] {
            assert_eq!(Role::parse(bad), Err(UnknownName(bad.to_owned())));
        }
        for kind in UserKind::ALL {
            assert_eq!(UserKind::parse(kind.as_str()), Ok(kind));
        }
        assert_eq!(UserKind::ALL.map(UserKind::as_str), ["person", "service"]);
        assert_eq!(UserKind::parse("bot"), Err(UnknownName("bot".to_owned())));
        assert_eq!(
            UnknownName("x".to_owned()).to_string(),
            "unknown name \"x\""
        );
        for role in Role::ALL {
            assert_eq!(
                serde_json::to_value(role).unwrap(),
                serde_json::json!(role.as_str())
            );
        }
        for kind in UserKind::ALL {
            assert_eq!(
                serde_json::to_value(kind).unwrap(),
                serde_json::json!(kind.as_str())
            );
        }
    }
}
