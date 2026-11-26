//! The TLS modes of the SMTP transport against fake servers with a self-signed certificate:
//! TLS from the first byte, `STARTTLS` (which is required, never optional), the check of the
//! server's certificate and name, and that no credential and no mail is sent before the
//! connection is secured.

use std::sync::Arc;
use std::time::Duration;

use crate::support::{Fake, Next, PASSWORD, PLAIN_CREDENTIALS, Script, USERNAME, mail, session};
use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use stuffcloud_core::smtp::SmtpSecurity;
use stuffcloud_mail::{FailureKind, Login, Password, SmtpTransport, Transport};
use tokio_rustls::TlsAcceptor;

/// A TLS acceptor with a fresh self-signed certificate for `name`, and that certificate as PEM.
fn pki(name: &str) -> (TlsAcceptor, Vec<u8>) {
    let certified = rcgen::generate_simple_self_signed(vec![name.to_owned()]).unwrap();
    let certificate: CertificateDer<'static> = certified.cert.der().clone();
    let key = PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der());
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate], PrivateKeyDer::Pkcs8(key))
        .unwrap();
    (
        TlsAcceptor::from(Arc::new(config)),
        certified.cert.pem().into_bytes(),
    )
}

async fn implicit_tls(acceptor: TlsAcceptor, script: Script) -> Fake {
    Fake::start_with(script, move |stream, script, seen| {
        let acceptor = acceptor.clone();
        async move {
            if let Ok(tls) = acceptor.accept(stream).await {
                let _next = session(tls, &script, &seen, true, true).await;
            }
        }
    })
    .await
}

async fn starttls(acceptor: TlsAcceptor, script: Script) -> Fake {
    Fake::start_with(script, move |stream, script, seen| {
        let acceptor = acceptor.clone();
        async move {
            if let Next::Upgrade(stream) = session(stream, &script, &seen, true, false).await
                && let Ok(tls) = acceptor.accept(stream).await
            {
                let _next = session(tls, &script, &seen, false, true).await;
            }
        }
    })
    .await
}

fn server(port: u16, security: SmtpSecurity, password: &str) -> stuffcloud_mail::Server {
    stuffcloud_mail::Server {
        host: "localhost".to_owned(),
        port,
        security,
        login: Some(Login {
            username: USERNAME.to_owned(),
            password: Password::new(password.to_owned()),
        }),
    }
}

fn transport(root: &[u8]) -> SmtpTransport {
    SmtpTransport::new(Duration::from_secs(10)).with_root_certificate(root.to_vec())
}

fn auth_line() -> String {
    format!("AUTH PLAIN {PLAIN_CREDENTIALS}")
}

#[tokio::test]
async fn tls_from_the_first_byte_delivers_and_logs_in() {
    let (acceptor, root) = pki("localhost");
    let fake = implicit_tls(acceptor, Script::default()).await;
    let result = transport(&root)
        .send(&server(fake.port, SmtpSecurity::Tls, PASSWORD), &mail())
        .await;
    assert_eq!(result, Ok(()));
    let seen = fake.seen();
    assert_eq!(seen.commands[0], "EHLO example.com");
    assert!(seen.commands.contains(&auth_line()), "{:?}", seen.commands);
    assert_eq!(seen.messages.len(), 1);
}

#[tokio::test]
async fn a_certificate_nobody_trusts_stops_the_delivery_before_anything_is_sent() {
    let (acceptor, _root) = pki("localhost");
    let fake = implicit_tls(acceptor, Script::default()).await;
    let error = SmtpTransport::new(Duration::from_secs(10))
        .send(&server(fake.port, SmtpSecurity::Tls, PASSWORD), &mail())
        .await
        .unwrap_err();
    assert_eq!(error.kind, FailureKind::Tls);
    assert!(error.is_transient());
    let seen = fake.seen();
    assert!(seen.commands.is_empty(), "{:?}", seen.commands);
    assert!(seen.messages.is_empty());
}

#[tokio::test]
async fn a_certificate_for_another_name_is_refused() {
    let (acceptor, root) = pki("other.example.com");
    let fake = implicit_tls(acceptor, Script::default()).await;
    let error = transport(&root)
        .send(&server(fake.port, SmtpSecurity::Tls, PASSWORD), &mail())
        .await
        .unwrap_err();
    assert_eq!(error.kind, FailureKind::Tls);
    assert!(fake.seen().commands.is_empty());
}

#[tokio::test]
async fn starttls_upgrades_before_the_login_and_the_mail() {
    let (acceptor, root) = pki("localhost");
    let fake = starttls(
        acceptor,
        Script {
            offer_starttls: true,
            ..Script::default()
        },
    )
    .await;
    let result = transport(&root)
        .send(
            &server(fake.port, SmtpSecurity::Starttls, PASSWORD),
            &mail(),
        )
        .await;
    assert_eq!(result, Ok(()));
    let seen = fake.seen();
    let position = |wanted: &str| {
        seen.commands
            .iter()
            .position(|c| c.starts_with(wanted))
            .unwrap_or_else(|| panic!("{wanted} not in {:?}", seen.commands))
    };
    assert!(position("STARTTLS") < position("AUTH"));
    assert!(position("AUTH") < position("MAIL FROM"));
    assert!(position("MAIL FROM") < position("RCPT TO"));
    assert_eq!(
        seen.commands
            .iter()
            .filter(|c| c.starts_with("EHLO"))
            .count(),
        2
    );
    assert_eq!(seen.messages.len(), 1);
}

#[tokio::test]
async fn starttls_is_required_a_server_without_it_gets_nothing() {
    let (_acceptor, root) = pki("localhost");
    let fake = Fake::start(Script::default()).await;
    let result = transport(&root)
        .send(
            &server(fake.port, SmtpSecurity::Starttls, PASSWORD),
            &mail(),
        )
        .await;
    assert!(result.is_err());
    let seen = fake.seen();
    assert!(seen.messages.is_empty());
    assert!(
        !seen
            .commands
            .iter()
            .any(|c| c.starts_with("AUTH") || c.starts_with("MAIL") || c.starts_with("RCPT")),
        "{:?}",
        seen.commands
    );
}

#[tokio::test]
async fn a_root_certificate_that_is_not_one_fails_before_anything_is_sent() {
    let fake = Fake::start(Script::default()).await;
    let error = SmtpTransport::new(Duration::from_secs(10))
        .with_root_certificate(
            b"-----BEGIN CERTIFICATE-----
!!! not base64 !!!
-----END CERTIFICATE-----
"
            .to_vec(),
        )
        .send(&server(fake.port, SmtpSecurity::Tls, PASSWORD), &mail())
        .await
        .unwrap_err();
    assert_eq!(error.kind, FailureKind::Tls);
    assert_eq!(fake.seen().connections, 0);
}

#[tokio::test]
async fn a_wrong_password_delivers_nothing() {
    let (acceptor, root) = pki("localhost");
    let fake = implicit_tls(acceptor, Script::default()).await;
    let error = transport(&root)
        .send(
            &server(fake.port, SmtpSecurity::Tls, "not-the-password"),
            &mail(),
        )
        .await
        .unwrap_err();
    let shown = error.to_string();
    assert!(!shown.contains("not-the-password"));
    assert!(fake.seen().messages.is_empty());
}
