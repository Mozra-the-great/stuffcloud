//! The SMTP transport against a fake plain-text server: what goes over the wire, and how each
//! kind of failure is classified. The TLS modes are in `tls.rs`.

use std::time::Duration;

use crate::support::{Fake, Script, mail, server};
use stuffcloud_core::smtp::SmtpSecurity;
use stuffcloud_mail::{FailureKind, SendError, SmtpTransport, Transport};

#[tokio::test]
async fn a_mail_reaches_a_plain_server_as_built() {
    let fake = Fake::start(Script::default()).await;
    let result = SmtpTransport::default()
        .send(&server(fake.port, SmtpSecurity::None), &mail())
        .await;
    assert_eq!(result, Ok(()));
    let seen = fake.seen();
    assert_eq!(seen.connections, 1);
    // The client names the sender's domain, not the host it runs on.
    assert_eq!(seen.commands[0], "EHLO example.com");
    assert!(
        seen.commands
            .iter()
            .any(|c| c.starts_with("MAIL FROM:<noreply@example.com>"))
    );
    assert!(
        seen.commands
            .iter()
            .any(|c| c == "RCPT TO:<alice@example.org>")
    );
    assert!(seen.commands.iter().any(|c| c == "QUIT"));
    // Nothing secured, nothing authenticated.
    assert!(
        !seen
            .commands
            .iter()
            .any(|c| c.starts_with("AUTH") || c == "STARTTLS")
    );
    assert_eq!(seen.messages.len(), 1);
    let message = &seen.messages[0];
    assert!(message.contains("To: alice@example.org\r\n"), "{message}");
    assert!(message.contains("Subject: stuffcloud: reset your password\r\n"));
    assert!(message.contains("Auto-Submitted: auto-generated\r\n"));
    assert!(message.contains("Message-ID: <0123456789abcdef@example.com>\r\n"));
    assert!(message.contains("password-reset#token=ab"));
}

#[tokio::test]
async fn a_permanent_refusal_is_final_and_does_not_repeat_the_server_text() {
    let fake = Fake::start(Script {
        rcpt_reply: "550 5.1.1 <alice@example.org> user unknown",
        ..Script::default()
    })
    .await;
    let error = SmtpTransport::default()
        .send(&server(fake.port, SmtpSecurity::None), &mail())
        .await
        .unwrap_err();
    assert_eq!(error, SendError::answered(FailureKind::Rejected, 550));
    assert!(!error.is_transient());
    let shown = error.to_string();
    assert_eq!(shown, "the server rejected the mail (SMTP 550)");
    assert!(!shown.contains("alice") && !shown.contains("unknown"));
    assert!(fake.seen().messages.is_empty());
}

#[tokio::test]
async fn a_temporary_refusal_may_be_tried_again() {
    let fake = Fake::start(Script {
        rcpt_reply: "451 4.3.0 try again later",
        ..Script::default()
    })
    .await;
    let error = SmtpTransport::default()
        .send(&server(fake.port, SmtpSecurity::None), &mail())
        .await
        .unwrap_err();
    assert_eq!(error, SendError::answered(FailureKind::Deferred, 451));
    assert!(error.is_transient());
}

#[tokio::test]
async fn a_closed_port_is_a_connection_error() {
    let port = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    };
    let error = SmtpTransport::default()
        .send(&server(port, SmtpSecurity::None), &mail())
        .await
        .unwrap_err();
    assert_eq!(error, SendError::new(FailureKind::Connection));
    assert!(error.is_transient());
}

#[tokio::test]
async fn a_server_that_says_nothing_times_out() {
    let fake = Fake::start(Script {
        silent: true,
        ..Script::default()
    })
    .await;
    let error = SmtpTransport::new(Duration::from_millis(300))
        .send(&server(fake.port, SmtpSecurity::None), &mail())
        .await
        .unwrap_err();
    assert_eq!(error, SendError::new(FailureKind::Timeout));
    assert!(error.is_transient());
}

#[tokio::test]
async fn starttls_and_tls_are_never_downgraded_to_plain_text() {
    // A server that speaks plain text only: neither secure mode may send anything to it.
    for security in [SmtpSecurity::Starttls, SmtpSecurity::Tls] {
        let fake = Fake::start(Script::default()).await;
        let result = SmtpTransport::new(Duration::from_secs(5))
            .send(&server(fake.port, security), &mail())
            .await;
        assert!(result.is_err(), "{security:?}");
        let seen = fake.seen();
        assert!(seen.messages.is_empty(), "{security:?}");
        assert!(
            !seen
                .commands
                .iter()
                .any(|c| c.starts_with("MAIL") || c.starts_with("AUTH")),
            "{security:?}: {:?}",
            seen.commands
        );
    }
}
