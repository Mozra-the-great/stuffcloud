//! Integration tests of the SMTP transport against fake servers: what goes over the wire, how each
//! kind of failure is classified and, with the `tls` feature, the TLS modes. One test binary, so
//! the fake server in `support` is compiled once.

#![expect(
    clippy::unwrap_used,
    reason = "test code: a panic is a failed test, and the helpers outside #[test] functions are test code too"
)]

mod smtp;
mod support;
#[cfg(feature = "tls")]
mod tls;
