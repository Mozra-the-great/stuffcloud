//! The message: what is sent, built so that nothing in it can start a new header or a new
//! recipient.
//!
//! Every address is an [`Email`] (visible ASCII, one `@`, no space, so no line break and no
//! second address), the display name of the sender passed `stuffcloud_core::smtp::valid_from_name`
//! when the settings were written and is encoded again here (RFC 2047 when it has non-ASCII
//! characters, quoted otherwise), and the subject is a fixed text of the templates. The builder of
//! `lettre` refuses a name or an address that would break a header, and [`build`] turns that into
//! a [`BuildError`] instead of a message: the tests feed it the hostile values of the regression
//! corpus.
//!
//! The message is plain text (UTF-8, quoted-printable when needed), carries `Auto-Submitted:
//! auto-generated` (RFC 3834: no vacation reply or bounce loop starts from it), a `Message-ID` of
//! the sender's domain (never the name of the host the app runs on) and a `Date`.

use std::fmt;

use lettre::Message;
use lettre::address::Address;
use lettre::message::Mailbox;
use lettre::message::header::{ContentType, Header, HeaderName, HeaderValue};
use stuffcloud_core::account::Email;

/// One mail to one recipient.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing {
    /// The name shown next to the sender address.
    pub from_name: Option<String>,
    /// The sender address.
    pub from: Email,
    /// The recipient address.
    pub to: Email,
    /// The subject (one line).
    pub subject: String,
    /// The plain text body.
    pub text: String,
    /// The `Message-ID` with its angle brackets, for example `<0123abcd@example.com>`.
    pub message_id: String,
}

/// Why a message cannot be built. The text names the part, never its content (an address or a
/// name may be personal data).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum BuildError {
    /// An address was refused by the message builder.
    Address,
    /// The builder refused the headers or the body.
    Message,
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Address => "an address was refused by the message builder",
            Self::Message => "the message builder refused the headers or the body",
        })
    }
}

impl std::error::Error for BuildError {}

/// The `Auto-Submitted` header (RFC 3834).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AutoSubmitted;

impl Header for AutoSubmitted {
    fn name() -> HeaderName {
        HeaderName::new_from_ascii_str("Auto-Submitted")
    }

    fn parse(s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        if s.trim().eq_ignore_ascii_case("auto-generated") {
            Ok(Self)
        } else {
            Err("not auto-generated".into())
        }
    }

    fn display(&self) -> HeaderValue {
        HeaderValue::new(Self::name(), "auto-generated".to_owned())
    }
}

fn mailbox(name: Option<&String>, address: &Email) -> Result<Mailbox, BuildError> {
    let address: Address = address
        .as_str()
        .parse()
        .map_err(|_refused| BuildError::Address)?;
    Ok(Mailbox::new(name.cloned(), address))
}

/// Builds the message of `mail`.
///
/// # Errors
///
/// [`BuildError`] when the builder refuses an address, a header or the body.
pub fn build(mail: &Outgoing) -> Result<Message, BuildError> {
    Message::builder()
        .from(mailbox(mail.from_name.as_ref(), &mail.from)?)
        .to(mailbox(None, &mail.to)?)
        .subject(mail.subject.clone())
        .message_id(Some(mail.message_id.clone()))
        .header(AutoSubmitted)
        .header(ContentType::TEXT_PLAIN)
        .body(mail.text.clone())
        .map_err(|_refused| BuildError::Message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADERS: [&str; 9] = [
        "auto-submitted",
        "content-transfer-encoding",
        "content-type",
        "date",
        "from",
        "message-id",
        "mime-version",
        "subject",
        "to",
    ];

    fn sample() -> Outgoing {
        Outgoing {
            from_name: Some("stuffcloud".to_owned()),
            from: Email::parse("noreply@example.com").unwrap(),
            to: Email::parse("alice@example.org").unwrap(),
            subject: "stuffcloud: reset your password".to_owned(),
            text: "Hello alice,\n\nopen https://app.example.com/password-reset#token=ab\n"
                .to_owned(),
            message_id: "<0123456789abcdef@example.com>".to_owned(),
        }
    }

    /// The header lines of a formatted message (folded lines joined) and its body.
    fn split(message: &Message) -> (Vec<String>, String) {
        let raw = String::from_utf8(message.formatted()).unwrap();
        let (head, body) = raw.split_once("\r\n\r\n").unwrap();
        let mut lines: Vec<String> = Vec::new();
        for line in head.split("\r\n") {
            if line.starts_with(' ') || line.starts_with('\t') {
                lines.last_mut().unwrap().push_str(line);
            } else {
                lines.push(line.to_owned());
            }
        }
        (lines, body.to_owned())
    }

    fn sorted_names(lines: &[String]) -> Vec<String> {
        let mut names: Vec<String> = lines
            .iter()
            .map(|line| line.split(':').next().unwrap().to_ascii_lowercase())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_message_has_exactly_the_expected_headers() {
        let message = build(&sample()).unwrap();
        let (lines, body) = split(&message);
        assert_eq!(sorted_names(&lines), HEADERS);
        let header = |name: &str| {
            lines
                .iter()
                .find(|line| line.to_ascii_lowercase().starts_with(&format!("{name}:")))
                .unwrap()
                .clone()
        };
        assert_eq!(header("from"), "From: stuffcloud <noreply@example.com>");
        assert_eq!(header("to"), "To: alice@example.org");
        assert_eq!(
            header("subject"),
            "Subject: stuffcloud: reset your password"
        );
        assert_eq!(
            header("message-id"),
            "Message-ID: <0123456789abcdef@example.com>"
        );
        assert_eq!(header("auto-submitted"), "Auto-Submitted: auto-generated");
        assert_eq!(
            header("content-type"),
            "Content-Type: text/plain; charset=utf-8"
        );
        assert_eq!(header("mime-version"), "MIME-Version: 1.0");
        assert!(body.contains("Hello alice,"));
        let envelope = message.envelope();
        assert_eq!(envelope.from().unwrap().to_string(), "noreply@example.com");
        let to: Vec<String> = envelope.to().iter().map(ToString::to_string).collect();
        assert_eq!(to, ["alice@example.org"]);
    }

    #[test]
    fn a_sender_without_a_name_is_just_the_address() {
        let mut mail = sample();
        mail.from_name = None;
        let (lines, _body) = split(&build(&mail).unwrap());
        assert!(lines.contains(&"From: noreply@example.com".to_owned()));
    }

    #[test]
    fn non_ascii_text_is_encoded_and_never_raw_in_a_header() {
        let mut mail = sample();
        mail.subject = "stuffcloud: Passwort zur\u{fc}cksetzen".to_owned();
        mail.from_name = Some("J\u{fc}rgen's cloud".to_owned());
        mail.text = "Hallo \u{e4}\u{f6}\u{fc}\u{df}\n".to_owned();
        let message = build(&mail).unwrap();
        let raw = message.formatted();
        let (lines, body) = split(&message);
        let end_of_head = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        assert!(raw[..end_of_head].is_ascii());
        assert!(lines.iter().any(|l| l.starts_with("Subject: =?utf-8?")));
        assert!(lines.iter().any(|l| l.starts_with("From: =?utf-8?")));
        assert!(lines.iter().any(|l| {
            l.eq_ignore_ascii_case("Content-Transfer-Encoding: quoted-printable")
                || l.eq_ignore_ascii_case("Content-Transfer-Encoding: base64")
        }));
        assert!(body.is_ascii());
    }

    /// Hostile values: none may add a header, a recipient or a body part.
    #[test]
    fn a_hostile_name_or_subject_cannot_inject_a_header() {
        let hostile = [
            "x\r\nBcc: victim@example.net",
            "x\nBcc: victim@example.net",
            "x\rBcc: victim@example.net",
            "x\r\n\r\nINJECTED BODY",
            "x\u{0}y",
            "x\u{2028}Bcc: victim@example.net",
            "=?utf-8?q?x=0D=0ABcc:_victim@example.net?=",
            "x\" <victim@example.net>, \"y",
            "x\r\n Bcc: victim@example.net",
        ];
        for value in hostile {
            for (name, subject) in [(Some(value.to_owned()), "ok"), (None, value)] {
                let mut mail = sample();
                mail.from_name = name;
                mail.subject = subject.to_owned();
                let Ok(message) = build(&mail) else {
                    continue;
                };
                let (lines, body) = split(&message);
                assert_eq!(sorted_names(&lines), HEADERS, "{value:?}");
                assert_eq!(body, build(&sample()).map(|m| split(&m).1).unwrap());
                let envelope = message.envelope();
                let to: Vec<String> = envelope.to().iter().map(ToString::to_string).collect();
                assert_eq!(to, ["alice@example.org"], "{value:?}");
                let raw = String::from_utf8(message.formatted()).unwrap();
                let head = raw.split_once("\r\n\r\n").unwrap().0;
                assert!(!head.to_ascii_lowercase().contains("\r\nbcc:"), "{value:?}");
                assert!(!head.contains("INJECTED BODY"), "{value:?}");
            }
        }
    }

    #[test]
    fn a_hostile_address_is_refused_by_its_type_before_it_gets_here() {
        for bad in [
            "a@example.com\r\nBcc: victim@example.net",
            "a@example.com>\r\nBcc: victim@example.net",
            "a b@example.com",
            "a@example.com, b@example.net",
        ] {
            assert!(Email::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_body_keeps_lines_that_look_like_commands() {
        // A body line that is a single dot would end the SMTP data section; the transport stuffs
        // it, and the message itself keeps the text as it is.
        let mut mail = sample();
        mail.text = "line\n.\nQUIT\nRSET\n".to_owned();
        let (_lines, body) = split(&build(&mail).unwrap());
        assert!(body.contains("QUIT"));
        assert!(body.contains("RSET"));
    }

    #[test]
    fn errors_name_the_part_not_the_content() {
        assert_eq!(
            BuildError::Address.to_string(),
            "an address was refused by the message builder"
        );
        assert_eq!(
            BuildError::Message.to_string(),
            "the message builder refused the headers or the body"
        );
    }

    #[test]
    fn the_auto_submitted_header_round_trips() {
        assert_eq!(AutoSubmitted::name().to_string(), "Auto-Submitted");
        assert_eq!(
            AutoSubmitted::parse(" Auto-Generated ").unwrap(),
            AutoSubmitted
        );
        assert!(AutoSubmitted::parse("no").is_err());
    }
}
