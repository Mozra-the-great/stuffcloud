//! The SMTP transport, on `lettre`.
//!
//! - The connection is secured as the settings say: `tls` wraps it in TLS from the first byte,
//!   `starttls` upgrades it before anything else is sent and **requires** the upgrade (a server
//!   that does not offer `STARTTLS` fails the delivery, nothing goes out in plain text), `none` is
//!   plain text for a local mail catcher. The server's certificate is checked against the
//!   system's root certificates (and the extra ones of [`SmtpTransport::with_root_certificate`]);
//!   an operator with a private CA points `SSL_CERT_FILE` at its bundle.
//! - The login is sent only after the connection is secured, because the settings refuse a login
//!   with `security: none`, and `lettre` itself never sends it before a required upgrade.
//! - `EHLO` announces the domain of the sender address, not the name of the host the app runs on.
//! - Every connection is a new one with a time limit for each command; there is no pool, because
//!   an instance sends a handful of mails a day.
//! - Errors are mapped to [`SendError`]: the kind and the status code, never the text of the
//!   server, which may repeat the recipient's address.

use std::time::Duration;

use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::extension::ClientId;
use lettre::transport::smtp::{AsyncSmtpTransport, AsyncSmtpTransportBuilder, Error};
use lettre::{AsyncTransport, Tokio1Executor};
use stuffcloud_core::smtp::SmtpSecurity;

use crate::message::{Outgoing, build};
use crate::transport::{FailureKind, SendError, SendFuture, Server, Transport};

/// How long one SMTP command may take (connecting, each answer).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Delivers mail over SMTP.
#[derive(Debug, Clone)]
pub struct SmtpTransport {
    timeout: Duration,
    roots: Vec<Vec<u8>>,
}

impl Default for SmtpTransport {
    fn default() -> Self {
        Self::new(DEFAULT_TIMEOUT)
    }
}

impl SmtpTransport {
    /// A transport whose commands may take `timeout` each.
    #[must_use]
    pub const fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            roots: Vec::new(),
        }
    }

    /// Also trusts the PEM certificate `pem` as a root (for a server with a private CA, and for
    /// the tests).
    #[must_use]
    pub fn with_root_certificate(mut self, pem: Vec<u8>) -> Self {
        self.roots.push(pem);
        self
    }

    /// Sets how the connection is secured. A builder starts with no TLS, which is what the
    /// mode `none` wants.
    #[cfg(feature = "tls")]
    fn secure(
        &self,
        builder: AsyncSmtpTransportBuilder,
        server: &Server,
    ) -> Result<AsyncSmtpTransportBuilder, SendError> {
        use lettre::transport::smtp::client::{Certificate, Tls, TlsParameters};

        if server.security == SmtpSecurity::None {
            return Ok(builder);
        }
        let mut parameters = TlsParameters::builder(server.host.clone());
        for pem in &self.roots {
            let root =
                Certificate::from_pem(pem).map_err(|_bad| SendError::new(FailureKind::Tls))?;
            parameters = parameters.add_root_certificate(root);
        }
        let parameters = parameters
            .build()
            .map_err(|_bad| SendError::new(FailureKind::Tls))?;
        Ok(builder.tls(match server.security {
            SmtpSecurity::Tls => Tls::Wrapper(parameters),
            SmtpSecurity::Starttls | SmtpSecurity::None => Tls::Required(parameters),
        }))
    }

    /// Without the `tls` feature only the mode `none` can be served.
    #[cfg(not(feature = "tls"))]
    fn secure(
        &self,
        builder: AsyncSmtpTransportBuilder,
        server: &Server,
    ) -> Result<AsyncSmtpTransportBuilder, SendError> {
        if server.security == SmtpSecurity::None {
            Ok(builder)
        } else {
            Err(SendError::new(FailureKind::Tls))
        }
    }

    fn client(
        &self,
        server: &Server,
        hello: &str,
    ) -> Result<AsyncSmtpTransport<Tokio1Executor>, SendError> {
        let builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(server.host.clone())
            .port(server.port)
            .timeout(Some(self.timeout))
            .hello_name(ClientId::Domain(hello.to_owned()));
        let mut builder = self.secure(builder, server)?;
        if let Some(login) = &server.login {
            builder = builder.credentials(Credentials::new(
                login.username.clone(),
                login.password.expose().to_owned(),
            ));
        }
        Ok(builder.build())
    }

    async fn deliver(&self, server: &Server, mail: &Outgoing) -> Result<(), SendError> {
        let message = build(mail).map_err(|_refused| SendError::new(FailureKind::Message))?;
        let domain = mail.from.as_str().rsplit('@').next().unwrap_or_default();
        let client = self.client(server, domain)?;
        client
            .send(message)
            .await
            .map(|_response| ())
            .map_err(|error| classify(&error))
    }
}

impl Transport for SmtpTransport {
    fn send<'a>(&'a self, server: &'a Server, mail: &'a Outgoing) -> SendFuture<'a> {
        Box::pin(self.deliver(server, mail))
    }
}

/// The kind and the status code of a `lettre` error.
fn classify(error: &Error) -> SendError {
    let code = error.status().map(u16::from);
    let kind = if error.is_permanent() {
        FailureKind::Rejected
    } else if error.is_transient() {
        FailureKind::Deferred
    } else if error.is_timeout() {
        FailureKind::Timeout
    } else if tls_error(error) {
        FailureKind::Tls
    } else if error.is_response() || error.is_client() {
        FailureKind::Protocol
    } else {
        FailureKind::Connection
    };
    SendError { kind, code }
}

#[cfg(feature = "tls")]
fn tls_error(error: &Error) -> bool {
    error.is_tls()
}

#[cfg(not(feature = "tls"))]
fn tls_error(_error: &Error) -> bool {
    false
}
