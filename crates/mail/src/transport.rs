//! What the app asks of a mail transport, and the transport that only remembers (for tests).
//!
//! [`Transport`] is the one seam between the queue of `app` and the network: the SMTP transport
//! ([`crate::smtp::SmtpTransport`]) is the real one, [`Recording`] captures the mails in memory.
//! A transport never logs, and its error ([`SendError`]) says what kind of failure it was and the
//! SMTP status code, never the server's text: that text may repeat the recipient's address.

use std::collections::VecDeque;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};

use stuffcloud_core::smtp::SmtpSecurity;

use crate::message::Outgoing;

/// An SMTP password. `Debug` never shows it.
#[derive(Clone, PartialEq, Eq)]
pub struct Password(String);

impl Password {
    /// Wraps a password.
    #[must_use]
    pub fn new(password: String) -> Self {
        Self(password)
    }

    /// The password, where the transport needs it.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Password {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Password(<redacted>)")
    }
}

/// The login of an SMTP server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Login {
    /// The username.
    pub username: String,
    /// The password.
    pub password: Password,
}

/// Where and how a mail is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Server {
    /// Host name or IP address.
    pub host: String,
    /// Port.
    pub port: u16,
    /// How the connection is secured.
    pub security: SmtpSecurity,
    /// The login, when the server wants one.
    pub login: Option<Login>,
}

/// What went wrong with a delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum FailureKind {
    /// The message could not be built.
    Message,
    /// The server could not be reached, or the connection broke.
    Connection,
    /// The server did not answer in time.
    Timeout,
    /// The TLS handshake failed (an untrusted or wrong certificate, no `STARTTLS`).
    Tls,
    /// The server answered something the client could not use.
    Protocol,
    /// The server turned the mail away for now (a 4xx answer).
    Deferred,
    /// The server turned the mail away for good (a 5xx answer, including a refused login).
    Rejected,
}

/// A failed delivery: the kind and, when the server answered, its status code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SendError {
    /// What went wrong.
    pub kind: FailureKind,
    /// The SMTP status code of the answer, if there was one.
    pub code: Option<u16>,
}

impl SendError {
    /// An error without a status code.
    #[must_use]
    pub const fn new(kind: FailureKind) -> Self {
        Self { kind, code: None }
    }

    /// An error of the server's answer with status `code`.
    #[must_use]
    pub const fn answered(kind: FailureKind, code: u16) -> Self {
        Self {
            kind,
            code: Some(code),
        }
    }

    /// Whether a later attempt may succeed: everything but a mail that cannot be built and a
    /// mail the server rejected for good.
    #[must_use]
    pub const fn is_transient(&self) -> bool {
        !matches!(self.kind, FailureKind::Message | FailureKind::Rejected)
    }
}

impl fmt::Display for SendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self.kind {
            FailureKind::Message => "the message could not be built",
            FailureKind::Connection => "the connection to the server failed",
            FailureKind::Timeout => "the server did not answer in time",
            FailureKind::Tls => "the TLS handshake failed",
            FailureKind::Protocol => "the server's answer was not understood",
            FailureKind::Deferred => "the server turned the mail away for now",
            FailureKind::Rejected => "the server rejected the mail",
        })?;
        if let Some(code) = self.code {
            write!(f, " (SMTP {code})")?;
        }
        Ok(())
    }
}

impl std::error::Error for SendError {}

/// The future of a delivery.
pub type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<(), SendError>> + Send + 'a>>;

/// Delivers one mail to `server`.
pub trait Transport: Send + Sync + fmt::Debug {
    /// Sends `mail`; an error says whether trying again may help ([`SendError::is_transient`]).
    fn send<'a>(&'a self, server: &'a Server, mail: &'a Outgoing) -> SendFuture<'a>;
}

#[derive(Debug, Default)]
struct Log {
    sent: Vec<(Server, Outgoing)>,
    attempts: usize,
    failures: VecDeque<SendError>,
}

/// A transport that keeps every mail in memory and fails on demand. Cheap to clone; clones share
/// the log. For tests of everything that sends mail.
#[derive(Debug, Clone, Default)]
pub struct Recording {
    log: Arc<Mutex<Log>>,
}

impl Recording {
    /// An empty recording transport.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Log> {
        self.log.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The next delivery fails with `error` (after the ones queued before).
    pub fn fail_next(&self, error: SendError) {
        self.lock().failures.push_back(error);
    }

    /// The mails delivered so far, oldest first.
    #[must_use]
    pub fn sent(&self) -> Vec<Outgoing> {
        self.lock()
            .sent
            .iter()
            .map(|(_, mail)| mail.clone())
            .collect()
    }

    /// The servers the delivered mails went to, oldest first.
    #[must_use]
    pub fn servers(&self) -> Vec<Server> {
        self.lock()
            .sent
            .iter()
            .map(|(server, _)| server.clone())
            .collect()
    }

    /// How many deliveries were attempted, failed ones included.
    #[must_use]
    pub fn attempts(&self) -> usize {
        self.lock().attempts
    }
}

impl Transport for Recording {
    fn send<'a>(&'a self, server: &'a Server, mail: &'a Outgoing) -> SendFuture<'a> {
        Box::pin(async move {
            let mut log = self.lock();
            log.attempts = log.attempts.saturating_add(1);
            if let Some(error) = log.failures.pop_front() {
                return Err(error);
            }
            log.sent.push((server.clone(), mail.clone()));
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use stuffcloud_core::account::Email;

    use super::*;

    fn server() -> Server {
        Server {
            host: "mailpit".to_owned(),
            port: 1025,
            security: SmtpSecurity::None,
            login: None,
        }
    }

    fn mail(subject: &str) -> Outgoing {
        Outgoing {
            from_name: None,
            from: Email::parse("noreply@example.com").unwrap(),
            to: Email::parse("alice@example.org").unwrap(),
            subject: subject.to_owned(),
            text: "text\n".to_owned(),
            message_id: "<id@example.com>".to_owned(),
        }
    }

    #[test]
    fn a_password_is_never_printed() {
        let login = Login {
            username: "stuffcloud".to_owned(),
            password: Password::new("hunter2".to_owned()),
        };
        assert_eq!(login.password.expose(), "hunter2");
        let shown = format!("{login:?} {:?}", server());
        assert!(!shown.contains("hunter2"));
        assert!(shown.contains("Password(<redacted>)"));
    }

    #[test]
    fn which_failures_are_worth_a_retry() {
        for (kind, transient) in [
            (FailureKind::Message, false),
            (FailureKind::Rejected, false),
            (FailureKind::Connection, true),
            (FailureKind::Timeout, true),
            (FailureKind::Tls, true),
            (FailureKind::Protocol, true),
            (FailureKind::Deferred, true),
        ] {
            assert_eq!(SendError::new(kind).is_transient(), transient, "{kind:?}");
            assert_eq!(
                SendError::answered(kind, 451).is_transient(),
                transient,
                "{kind:?}"
            );
        }
    }

    #[test]
    fn errors_say_the_kind_and_the_code_and_nothing_else() {
        for (kind, text) in [
            (FailureKind::Message, "the message could not be built"),
            (
                FailureKind::Connection,
                "the connection to the server failed",
            ),
            (FailureKind::Timeout, "the server did not answer in time"),
            (FailureKind::Tls, "the TLS handshake failed"),
            (
                FailureKind::Protocol,
                "the server's answer was not understood",
            ),
            (
                FailureKind::Deferred,
                "the server turned the mail away for now",
            ),
            (FailureKind::Rejected, "the server rejected the mail"),
        ] {
            assert_eq!(SendError::new(kind).to_string(), text);
            assert_eq!(
                SendError::answered(kind, 550).to_string(),
                format!("{text} (SMTP 550)")
            );
        }
    }

    #[tokio::test]
    async fn the_recording_transport_keeps_what_it_sent_and_fails_on_demand() {
        let recording = Recording::new();
        let clone = recording.clone();
        clone.fail_next(SendError::new(FailureKind::Connection));
        clone.fail_next(SendError::answered(FailureKind::Rejected, 550));
        let server = server();
        let first = mail("one");
        assert_eq!(
            recording.send(&server, &first).await,
            Err(SendError::new(FailureKind::Connection))
        );
        assert_eq!(
            recording.send(&server, &first).await,
            Err(SendError::answered(FailureKind::Rejected, 550))
        );
        assert!(recording.sent().is_empty());
        assert_eq!(recording.send(&server, &first).await, Ok(()));
        assert_eq!(recording.send(&server, &mail("two")).await, Ok(()));
        let subjects: Vec<String> = clone.sent().into_iter().map(|m| m.subject).collect();
        assert_eq!(subjects, ["one", "two"]);
        assert_eq!(clone.servers(), vec![server.clone(), server]);
        assert_eq!(clone.attempts(), 4);
    }
}
