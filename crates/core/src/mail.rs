//! What the optional mailer says and when it gives up (A-10, ADR 0015).
//!
//! - [`Language`]: the two languages of the mails (German and English).
//! - [`ResetMailRequest`]: the request document of `POST /api/v1/auth/password-reset/request`.
//! - [`ResetMail`]: the password reset mail, rendered as plain text in either language. There is
//!   no HTML part, no image and no tracking link: the only link is the reset link, and the
//!   text says in words what it does. Every value that goes into the text comes from the
//!   server (login name, app address, link), never from the request.
//! - [`retry_delay`]: the back-off between delivery attempts. A mail carries a one-time reset
//!   token, so the attempts stop well before the token expires.
//!
//! Nothing here sends anything; `mail` and `app` do that.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::account::MAX_IDENTIFIER_LEN;
use crate::body::Action;
use crate::field::{FieldError, FieldErrorCode, JsonPointer};

/// The language of a mail.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "lowercase")]
pub enum Language {
    /// English (the default).
    #[default]
    En,
    /// German.
    De,
}

impl Language {
    /// The language tag in documents and messages.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::De => "de",
        }
    }
}

/// `POST /api/v1/auth/password-reset/request`: ask for a reset link by e-mail.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct ResetMailRequest {
    /// The login name or the e-mail address of the account.
    #[cfg_attr(feature = "openapi", schema(example = "alice"))]
    pub login: String,
    /// The language of the mail (`en` when absent).
    #[serde(default)]
    pub language: Option<Language>,
}

impl ResetMailRequest {
    /// The language of the mail, with the default applied.
    #[must_use]
    pub fn language(&self) -> Language {
        self.language.unwrap_or_default()
    }
}

impl Action for ResetMailRequest {
    const REQUIRED: &'static [&'static str] = &["login"];
    const OPTIONAL: &'static [&'static str] = &["language"];

    fn validate(&self) -> Vec<FieldError> {
        let length = self.login.len();
        if length == 0 || length > MAX_IDENTIFIER_LEN {
            vec![FieldError::new(
                JsonPointer::root().key("login"),
                FieldErrorCode::InvalidValue,
                format!("login must have 1 to {MAX_IDENTIFIER_LEN} bytes, not {length}"),
            )]
        } else {
            Vec::new()
        }
    }
}

/// A rendered mail: one line of subject and the plain text body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// The subject (one line, no control character).
    pub subject: String,
    /// The body, plain text with `\n` line ends.
    pub text: String,
}

/// The password reset mail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResetMail<'a> {
    /// The language of the text.
    pub language: Language,
    /// The app address, so a person with several instances knows which one wrote.
    pub app: &'a str,
    /// The login name of the account.
    pub login: &'a str,
    /// The reset link with its token.
    pub link: &'a str,
    /// How long the link works, in minutes.
    pub valid_minutes: i64,
}

impl ResetMail<'_> {
    /// The subject and the text of the mail.
    #[must_use]
    pub fn render(&self) -> Rendered {
        match self.language {
            Language::En => Rendered {
                subject: "stuffcloud: reset your password".to_owned(),
                text: format!(
                    "Hello {login},\n\
                     \n\
                     someone asked to reset the password of the account \"{login}\" on\n\
                     {app}.\n\
                     \n\
                     To choose a new password, open this link within {minutes} minutes.\n\
                     It works once:\n\
                     \n\
                     {link}\n\
                     \n\
                     If you did not ask for this, ignore this message: your password stays\n\
                     as it is, and nobody can use the link without this message.\n\
                     \n\
                     -- \n\
                     stuffcloud on {app}\n",
                    login = self.login,
                    app = self.app,
                    link = self.link,
                    minutes = self.valid_minutes,
                ),
            },
            Language::De => Rendered {
                subject: "stuffcloud: Passwort zur\u{fc}cksetzen".to_owned(),
                text: format!(
                    "Hallo {login},\n\
                     \n\
                     jemand hat darum gebeten, das Passwort des Kontos \"{login}\" auf\n\
                     {app} zur\u{fc}ckzusetzen.\n\
                     \n\
                     Um ein neues Passwort zu w\u{e4}hlen, \u{f6}ffne diesen Link innerhalb von\n\
                     {minutes} Minuten. Er funktioniert nur einmal:\n\
                     \n\
                     {link}\n\
                     \n\
                     Wenn du das nicht angefordert hast, ignoriere diese Nachricht: Dein\n\
                     Passwort bleibt, wie es ist, und ohne diese Nachricht kann niemand den\n\
                     Link benutzen.\n\
                     \n\
                     -- \n\
                     stuffcloud auf {app}\n",
                    login = self.login,
                    app = self.app,
                    link = self.link,
                    minutes = self.valid_minutes,
                ),
            },
        }
    }
}

/// The waits between delivery attempts, in seconds: 15 seconds, 1 minute, 5 minutes and 15
/// minutes after the first, second, third and fourth failed attempt. The fifth failure is final,
/// 21 minutes and 15 seconds after the first attempt, well inside the 60 minutes a reset link
/// lives.
pub const RETRY_DELAYS_SECS: [u64; 4] = [15, 60, 300, 900];

/// How many attempts a mail gets in all.
pub const MAX_ATTEMPTS: usize = RETRY_DELAYS_SECS.len() + 1;

/// The wait before the next attempt after `failed` attempts have failed (`failed` is at least
/// 1); `None` when the mail has had its last attempt.
#[must_use]
pub fn retry_delay(failed: usize) -> Option<Duration> {
    failed
        .checked_sub(1)
        .and_then(|index| RETRY_DELAYS_SECS.get(index))
        .map(|secs| Duration::from_secs(*secs))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::body::{BodyError, parse_action};

    fn mail(language: Language) -> ResetMail<'static> {
        ResetMail {
            language,
            app: "https://app.example.com",
            login: "alice",
            link: "https://app.example.com/password-reset#token=abc",
            valid_minutes: 60,
        }
    }

    #[test]
    fn the_english_mail() {
        let rendered = mail(Language::En).render();
        assert_eq!(rendered.subject, "stuffcloud: reset your password");
        assert_eq!(
            rendered.text,
            "Hello alice,\n\
             \n\
             someone asked to reset the password of the account \"alice\" on\n\
             https://app.example.com.\n\
             \n\
             To choose a new password, open this link within 60 minutes.\n\
             It works once:\n\
             \n\
             https://app.example.com/password-reset#token=abc\n\
             \n\
             If you did not ask for this, ignore this message: your password stays\n\
             as it is, and nobody can use the link without this message.\n\
             \n\
             -- \n\
             stuffcloud on https://app.example.com\n"
        );
    }

    #[test]
    fn the_german_mail() {
        let rendered = mail(Language::De).render();
        assert_eq!(rendered.subject, "stuffcloud: Passwort zur\u{fc}cksetzen");
        assert_eq!(
            rendered.text,
            "Hallo alice,\n\
             \n\
             jemand hat darum gebeten, das Passwort des Kontos \"alice\" auf\n\
             https://app.example.com zur\u{fc}ckzusetzen.\n\
             \n\
             Um ein neues Passwort zu w\u{e4}hlen, \u{f6}ffne diesen Link innerhalb von\n\
             60 Minuten. Er funktioniert nur einmal:\n\
             \n\
             https://app.example.com/password-reset#token=abc\n\
             \n\
             Wenn du das nicht angefordert hast, ignoriere diese Nachricht: Dein\n\
             Passwort bleibt, wie es ist, und ohne diese Nachricht kann niemand den\n\
             Link benutzen.\n\
             \n\
             -- \n\
             stuffcloud auf https://app.example.com\n"
        );
    }

    #[test]
    fn the_mails_are_plain_text_without_a_second_link() {
        for language in [Language::En, Language::De] {
            let rendered = mail(language).render();
            assert!(!rendered.subject.contains(['\r', '\n']));
            assert!(!rendered.text.contains(['\r', '<', '>']));
            // The link is the only line with a path; the app address is named, not linked
            // twice as a URL with a query or a fragment.
            let links = rendered
                .text
                .lines()
                .filter(|line| line.contains("#token="))
                .count();
            assert_eq!(links, 1);
            assert!(!rendered.text.contains("src="));
            assert!(!rendered.text.contains("http://"));
        }
    }

    #[test]
    fn the_minutes_come_from_the_caller() {
        let mut reset = mail(Language::En);
        reset.valid_minutes = 15;
        assert!(reset.render().text.contains("within 15 minutes"));
        reset.language = Language::De;
        assert!(reset.render().text.contains("von\n15 Minuten"));
    }

    #[test]
    fn languages() {
        assert_eq!(Language::default(), Language::En);
        assert_eq!(Language::En.as_str(), "en");
        assert_eq!(Language::De.as_str(), "de");
        for language in [Language::En, Language::De] {
            assert_eq!(
                serde_json::to_value(language).unwrap(),
                json!(language.as_str())
            );
            let back: Language = serde_json::from_value(json!(language.as_str())).unwrap();
            assert_eq!(back, language);
        }
        for bad in ["EN", "fr", "", "en-US", "de "] {
            assert!(
                serde_json::from_value::<Language>(json!(bad)).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_request_document() {
        let parsed: ResetMailRequest = parse_action(br#"{"login":"alice"}"#).unwrap();
        assert_eq!(parsed.login, "alice");
        assert_eq!(parsed.language, None);
        assert_eq!(parsed.language(), Language::En);
        let parsed: ResetMailRequest =
            parse_action(br#"{"login":"alice@example.com","language":"de"}"#).unwrap();
        assert_eq!(parsed.language(), Language::De);
        let parsed: ResetMailRequest =
            parse_action(br#"{"login":"alice","language":null}"#).unwrap();
        assert_eq!(parsed.language(), Language::En);
    }

    #[test]
    fn the_request_document_is_checked() {
        let errors = |body: &str| match parse_action::<ResetMailRequest>(body.as_bytes()) {
            Err(BodyError::Invalid(errors)) => errors
                .into_iter()
                .map(|e| (e.pointer.as_str().to_owned(), e.code, e.detail))
                .collect::<Vec<_>>(),
            other => panic!("{other:?}"),
        };
        assert_eq!(
            errors("{}"),
            vec![(
                "/login".to_owned(),
                FieldErrorCode::MissingField,
                "missing field \"login\"".to_owned()
            )]
        );
        assert_eq!(
            errors(r#"{"login":""}"#),
            vec![(
                "/login".to_owned(),
                FieldErrorCode::InvalidValue,
                "login must have 1 to 320 bytes, not 0".to_owned()
            )]
        );
        let long = format!(r#"{{"login":"{}"}}"#, "a".repeat(MAX_IDENTIFIER_LEN + 1));
        assert_eq!(
            errors(&long),
            vec![(
                "/login".to_owned(),
                FieldErrorCode::InvalidValue,
                "login must have 1 to 320 bytes, not 321".to_owned()
            )]
        );
        let fits = format!(r#"{{"login":"{}"}}"#, "a".repeat(MAX_IDENTIFIER_LEN));
        assert!(parse_action::<ResetMailRequest>(fits.as_bytes()).is_ok());
        assert_eq!(
            errors(r#"{"login":"a","language":"fr"}"#)[0].0,
            "/language".to_owned()
        );
        assert_eq!(
            errors(r#"{"login":"a","extra":1}"#),
            vec![(
                "/extra".to_owned(),
                FieldErrorCode::UnknownField,
                "unknown field \"extra\"".to_owned()
            )]
        );
    }

    #[test]
    fn the_retry_schedule() {
        assert_eq!(retry_delay(0), None);
        assert_eq!(retry_delay(1), Some(Duration::from_secs(15)));
        assert_eq!(retry_delay(2), Some(Duration::from_mins(1)));
        assert_eq!(retry_delay(3), Some(Duration::from_mins(5)));
        assert_eq!(retry_delay(4), Some(Duration::from_mins(15)));
        assert_eq!(retry_delay(5), None);
        assert_eq!(retry_delay(usize::MAX), None);
        assert_eq!(MAX_ATTEMPTS, 5);
        // The last attempt starts before the reset link (60 minutes) has expired, with room
        // for the attempt itself.
        let total: u64 = RETRY_DELAYS_SECS.iter().sum();
        assert_eq!(total, 1275);
        assert!(total < 40 * 60);
    }
}
