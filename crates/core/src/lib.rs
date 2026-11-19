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

pub mod body;
pub mod etag;
pub mod field;
pub mod path;
pub mod query;
pub mod settings;
pub mod subdomain;

pub use path::{PathError, SafeRelPath};
pub use subdomain::{Subdomain, SubdomainError};
