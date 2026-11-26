//! `mail`: the optional mailer's delivery side (A-10, ADR 0015).
//!
//! - [`message`]: the [`message::Outgoing`] mail and its builder, which cannot be made to inject
//!   a header or a recipient.
//! - [`transport`]: the [`transport::Transport`] seam between the queue of `app` and the network,
//!   its error that never repeats what a server said, and a recording transport for tests.
//! - [`smtp`]: the SMTP transport (TLS with rustls, `STARTTLS` required where asked, system
//!   root certificates).
//!
//! The crate knows nothing of the database, the settings group or the queue: `app` resolves the
//! settings into a [`transport::Server`] and decides when to try again.

pub mod message;
pub mod smtp;
pub mod transport;

pub use message::{BuildError, Outgoing, build};
pub use smtp::SmtpTransport;
pub use transport::{
    FailureKind, Login, Password, Recording, SendError, SendFuture, Server, Transport,
};
