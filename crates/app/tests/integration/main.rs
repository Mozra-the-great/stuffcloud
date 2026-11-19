//! Integration tests of the `app` crate: the router against a temporary database, the log
//! redaction over a real socket, and the binary as a process. One test binary, so the
//! shared helpers in `common` are compiled once.

#![expect(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    reason = "test code: a panic is a failed test, and the helpers outside #[test] functions are test code too"
)]

mod accounts;
mod auth;
mod authz;
mod common;
mod conventions;
mod operations;
mod process;
