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

pub mod path;
pub mod subdomain;

pub use path::{PathError, SafeRelPath};
pub use subdomain::{Subdomain, SubdomainError};
