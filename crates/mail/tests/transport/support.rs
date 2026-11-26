//! A fake SMTP server for the transport tests: it speaks just enough SMTP (EHLO, STARTTLS, AUTH
//! PLAIN, MAIL, RCPT, DATA, QUIT), answers as its [`Script`] says and writes down what it was
//! sent.

use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use stuffcloud_core::account::Email;
use stuffcloud_core::smtp::SmtpSecurity;
use stuffcloud_mail::{Outgoing, Server};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// The base64 of `\0stuffcloud\0s3cret-pass`, what `AUTH PLAIN` carries for [`USERNAME`] and
/// [`PASSWORD`].
pub(crate) const PLAIN_CREDENTIALS: &str = "AHN0dWZmY2xvdWQAczNjcmV0LXBhc3M=";
pub(crate) const USERNAME: &str = "stuffcloud";
pub(crate) const PASSWORD: &str = "s3cret-pass";

/// How the server behaves.
#[derive(Debug, Clone)]
pub(crate) struct Script {
    /// Whether `EHLO` offers `STARTTLS` before the connection is secured.
    pub(crate) offer_starttls: bool,
    /// The answer to `RCPT TO`.
    pub(crate) rcpt_reply: &'static str,
    /// Accept the connection and say nothing.
    pub(crate) silent: bool,
    /// What the server says when the connection opens.
    pub(crate) greeting: &'static str,
}

impl Default for Script {
    fn default() -> Self {
        Self {
            offer_starttls: false,
            rcpt_reply: "250 2.1.5 ok",
            silent: false,
            greeting: "220 fake.example.net ESMTP ready",
        }
    }
}

/// What the server saw.
#[derive(Debug, Default, Clone)]
pub(crate) struct Seen {
    /// Every command line, without the line end, in order (the data section is in `messages`).
    pub(crate) commands: Vec<String>,
    /// Every message received by `DATA`, with the line ends as sent.
    pub(crate) messages: Vec<String>,
    /// Connections accepted.
    pub(crate) connections: usize,
}

/// What a session ended with.
pub(crate) enum Next<S> {
    /// The client left, or the connection broke.
    Done,
    /// The client asked for `STARTTLS` and got its `220`: upgrade this stream and call
    /// [`session`] again with `secured` set.
    Upgrade(S),
}

/// Serves one connection until it ends or asks for `STARTTLS`.
pub(crate) async fn session<S>(
    stream: S,
    script: &Script,
    seen: &Mutex<Seen>,
    greet: bool,
    secured: bool,
) -> Next<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut stream = BufReader::new(stream);
    if greet && send(&mut stream, script.greeting).await.is_err() {
        return Next::Done;
    }
    loop {
        let mut line = String::new();
        match stream.read_line(&mut line).await {
            Ok(0) | Err(_) => return Next::Done,
            Ok(_) => {}
        }
        let command = line.trim_end_matches(['\r', '\n']).to_owned();
        seen.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .commands
            .push(command.clone());
        let upper = command.to_ascii_uppercase();
        let reply = if upper.starts_with("EHLO") || upper.starts_with("HELO") {
            let mut reply =
                String::from("250-fake.example.net\r\n250-8BITMIME\r\n250-AUTH PLAIN\r\n");
            if script.offer_starttls && !secured {
                reply.push_str("250-STARTTLS\r\n");
            }
            reply.push_str("250 SMTPUTF8");
            reply
        } else if upper == "STARTTLS" {
            if send(&mut stream, "220 2.0.0 go ahead").await.is_err() {
                return Next::Done;
            }
            return Next::Upgrade(stream.into_inner());
        } else if upper.starts_with("AUTH PLAIN") {
            let argument = command.get("AUTH PLAIN".len()..).unwrap_or_default().trim();
            if argument == PLAIN_CREDENTIALS {
                "235 2.7.0 welcome".to_owned()
            } else {
                "535 5.7.8 bad credentials".to_owned()
            }
        } else if upper.starts_with("MAIL FROM:") {
            "250 2.1.0 ok".to_owned()
        } else if upper.starts_with("RCPT TO:") {
            script.rcpt_reply.to_owned()
        } else if upper == "DATA" {
            if send(&mut stream, "354 end with a dot").await.is_err() {
                return Next::Done;
            }
            let mut message = String::new();
            loop {
                let mut part = String::new();
                match stream.read_line(&mut part).await {
                    Ok(0) | Err(_) => return Next::Done,
                    Ok(_) => {}
                }
                if part == ".\r\n" {
                    break;
                }
                message.push_str(&part);
            }
            seen.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .messages
                .push(message);
            "250 2.0.0 queued".to_owned()
        } else if upper == "QUIT" {
            let _answered = send(&mut stream, "221 2.0.0 bye").await;
            return Next::Done;
        } else if upper == "RSET" || upper == "NOOP" {
            "250 2.0.0 ok".to_owned()
        } else {
            "502 5.5.2 not implemented".to_owned()
        };
        if send(&mut stream, &reply).await.is_err() {
            return Next::Done;
        }
    }
}

async fn send<S>(stream: &mut BufReader<S>, reply: &str) -> std::io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    stream.write_all(format!("{reply}\r\n").as_bytes()).await?;
    stream.flush().await
}

/// A running fake server on a free local port. The task ends with the test.
pub(crate) struct Fake {
    pub(crate) port: u16,
    seen: Arc<Mutex<Seen>>,
    task: JoinHandle<()>,
}

impl Fake {
    /// Starts a plain-text server.
    pub(crate) async fn start(script: Script) -> Self {
        Self::start_with(script, |stream, script, seen| async move {
            let _next = session(stream, &script, &seen, true, false).await;
        })
        .await
    }

    /// Starts a server that hands every connection to `handle` (one at a time), for the tests
    /// that wrap it in TLS.
    pub(crate) async fn start_with<F, Fut>(script: Script, handle: F) -> Self
    where
        F: Fn(TcpStream, Script, Arc<Mutex<Seen>>) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Seen::default()));
        let shared = Arc::clone(&seen);
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _peer)) = listener.accept().await else {
                    return;
                };
                {
                    let mut seen = shared.lock().unwrap_or_else(PoisonError::into_inner);
                    seen.connections = seen.connections.saturating_add(1);
                }
                if script.silent {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                }
                handle(stream, script.clone(), Arc::clone(&shared)).await;
            }
        });
        Self { port, seen, task }
    }

    /// What the server has seen so far.
    pub(crate) fn seen(&self) -> Seen {
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The mail every transport test sends.
pub(crate) fn mail() -> Outgoing {
    Outgoing {
        from_name: Some("stuffcloud".to_owned()),
        from: Email::parse("noreply@example.com").unwrap(),
        to: Email::parse("alice@example.org").unwrap(),
        subject: "stuffcloud: reset your password".to_owned(),
        text: "Hello alice,\n\nopen https://app.example.com/password-reset#token=ab\n".to_owned(),
        message_id: "<0123456789abcdef@example.com>".to_owned(),
    }
}

/// A server entry for `127.0.0.1:port`.
pub(crate) fn server(port: u16, security: SmtpSecurity) -> Server {
    Server {
        host: "127.0.0.1".to_owned(),
        port,
        security,
        login: None,
    }
}
