//! Domain types and validation for stuffcloud (docs/SPEC.md).
//!
//! This crate does no I/O: no files, no network, no clock, no randomness. Every
//! function is pure, which is what lets the unit, property, mutation and fuzz tests
//! in CI exercise it exhaustively. The `app` and `edge` services build on these
//! types, so input that reaches them has already passed the checks here.
//!
//! Each validated type can only be built through its `parse` function
//! ("parse, don't validate"): holding a [`SafeRelPath`] or a [`Subdomain`] is the
//! proof that the value obeys the rules documented on it.
//!
//! The API conventions of ADR 0010 that are pure functions live here too, so the
//! fuzz targets reach them without a database: entity tags and preconditions
//! ([`etag`]), the write query string ([`query`]), writable resource documents with
//! field errors ([`body`], [`field`]) and the settings groups ([`settings`]).
//!
//! The auth building blocks of A-02 (ADR 0005 addendum) are pure as well: secret tokens
//! ([`token`]), the `Authorization` header ([`authorization`]), the `__Host-` cookies and the `Cookie` header ([`cookie`]), the `Origin` and
//! CSRF checks ([`csrf`]) and session lifetimes, roles and account kinds ([`session`]).
//!
//! Authorisation (A-07) is pure too: permission names and token scopes ([`scope`]), the
//! permission matrix and the one decision function ([`policy`]) and the zone-level rules for
//! who may host where ([`hosting`]).
//!
//! Local accounts (A-03) add login names, e-mail addresses, the password policy and the
//! account request documents ([`account`]), the login throttle ([`throttle`]) and the client
//! address behind trusted proxies ([`client_ip`]).

pub mod account;
pub mod authorization;
pub mod body;
pub mod client_ip;
pub mod cookie;
pub mod csrf;
pub mod etag;
pub mod field;
pub mod hosting;
pub mod path;
pub mod policy;
pub mod query;
pub mod scope;
pub mod session;
pub mod settings;
pub mod subdomain;
pub mod throttle;
pub mod token;

pub use path::{PathError, SafeRelPath};
pub use subdomain::{Subdomain, SubdomainError};
