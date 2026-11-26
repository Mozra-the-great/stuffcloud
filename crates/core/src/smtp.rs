//! The `smtp` settings group (A-10, SPEC 6 and 10.2, ADR 0010 decision 4, ADR 0015): where the
//! optional mailer sends its mail.
//!
//! The group is a singleton resource like the other settings groups. One that was never
//! written means "no SMTP": the app then runs without any mail (an admin hands out reset links).
//! A written group holds the server, how to secure the connection, an optional login and the
//! sender of the mail.
//!
//! - **The password is a reference, never a value** (ADR 0010 decision 4): `{"ref":
//!   "STUFFCLOUD_SECRET_SMTP"}` names a variable of the deployment configuration (or, with the
//!   suffix `_FILE`, a file). Only names with the prefix [`SECRET_PREFIX`] are accepted, so a
//!   setting can never name another variable of the process as "the password". The shape is the
//!   one of the write-only secrets of the ADR addendum (#152), which add the `value` and `stored`
//!   forms later without changing what is written here.
//! - **Credentials are never sent unencrypted**: `security` is `starttls` (the connection starts
//!   in plain text and must upgrade before anything else, the usual port 587), `tls` (TLS from the
//!   first byte, port 465) or `none` (plain text, for a local mail catcher such as Mailpit), and
//!   `none` cannot be combined with a username and password.
//! - Every text that ends up in a mail header or a protocol command (host, username, sender
//!   address and name) is checked here for control characters, so a header cannot be injected
//!   through the settings.
//!
//! Nothing here opens a connection; `mail` and `app` do that.

use std::net::IpAddr;

use serde::{Deserialize, Serialize};

use crate::account::Email;
use crate::body::{Rule, Writable};
use crate::field::{FieldError, FieldErrorCode, JsonPointer};

/// The prefix every secret reference must have (ADR 0010 addendum, decision 4).
pub const SECRET_PREFIX: &str = "STUFFCLOUD_SECRET_";

/// The suffix of the file form of a variable; a reference names the variable without it.
pub const FILE_SUFFIX: &str = "_FILE";

/// Longest secret reference in bytes, prefix included.
pub const MAX_SECRET_REF_LEN: usize = 64;

/// Longest host name in bytes (RFC 1035).
pub const MAX_HOST_LEN: usize = 253;

/// Longest label of a host name in bytes.
pub const MAX_LABEL_LEN: usize = 63;

/// Longest username in bytes.
pub const MAX_USERNAME_LEN: usize = 256;

/// Longest display name of the sender in characters.
pub const MAX_FROM_NAME_CHARS: usize = 64;

/// The message of every document that is not a secret reference. It is a fixed text: what a
/// client wrote in a field that holds a secret (a password typed where a reference belongs) is
/// never echoed in an error, which the derived `Deserialize` would do for a wrong type.
pub const SECRET_SHAPE_MESSAGE: &str = "a secret is a reference: an object with the member \"ref\" only (secret values are not accepted)";

/// A reference to a secret of the deployment configuration (the SMTP password).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct SecretRef {
    /// The name of the variable (without `_FILE`): `STUFFCLOUD_SECRET_` and then capital
    /// letters, digits and `_`. The app reads the variable, or the file named by the variable
    /// with `_FILE` appended.
    #[serde(rename = "ref")]
    #[cfg_attr(feature = "openapi", schema(example = "STUFFCLOUD_SECRET_SMTP"))]
    pub name: String,
}

impl<'de> Deserialize<'de> for SecretRef {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        match value {
            serde_json::Value::Object(mut members) if members.len() == 1 => {
                match members.remove("ref") {
                    Some(serde_json::Value::String(name)) => Ok(Self { name }),
                    _ => Err(serde::de::Error::custom(SECRET_SHAPE_MESSAGE)),
                }
            }
            _ => Err(serde::de::Error::custom(SECRET_SHAPE_MESSAGE)),
        }
    }
}

/// Why a text is not a valid secret reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SecretRefError {
    /// Does not start with [`SECRET_PREFIX`].
    Prefix,
    /// Longer than [`MAX_SECRET_REF_LEN`] bytes.
    Length,
    /// Nothing after the prefix, a character other than `A-Z`, `0-9` and `_`, or the `_FILE`
    /// suffix (the file form is found by itself).
    Name,
}

impl std::fmt::Display for SecretRefError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Prefix => write!(f, "a secret reference must start with {SECRET_PREFIX}"),
            Self::Length => write!(
                f,
                "a secret reference has at most {MAX_SECRET_REF_LEN} characters"
            ),
            Self::Name => write!(
                f,
                "after {SECRET_PREFIX} a secret reference has capital letters, digits and '_' only, at least one, and does not end in {FILE_SUFFIX} (the file form is found by itself)"
            ),
        }
    }
}

impl std::error::Error for SecretRefError {}

impl SecretRef {
    /// Checks the name: the prefix, the length, the characters.
    ///
    /// # Errors
    ///
    /// The first rule the name breaks.
    pub fn check(&self) -> Result<(), SecretRefError> {
        let Some(rest) = self.name.strip_prefix(SECRET_PREFIX) else {
            return Err(SecretRefError::Prefix);
        };
        if self.name.len() > MAX_SECRET_REF_LEN {
            return Err(SecretRefError::Length);
        }
        if rest.is_empty()
            || !rest
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            || self.name.ends_with(FILE_SUFFIX)
        {
            return Err(SecretRefError::Name);
        }
        Ok(())
    }

    /// The name of the variable that holds the path of a file with the secret.
    #[must_use]
    pub fn file_variable(&self) -> String {
        format!("{}{FILE_SUFFIX}", self.name)
    }
}

/// How the connection to the SMTP server is secured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum SmtpSecurity {
    /// Plain text first, then `STARTTLS` (required: a server without it fails the delivery
    /// instead of receiving anything in plain text). Usually port 587.
    Starttls,
    /// TLS from the first byte (SMTPS). Usually port 465.
    Tls,
    /// No encryption: only for a local mail catcher such as Mailpit. Cannot be combined with a
    /// username and password.
    None,
}

impl SmtpSecurity {
    /// The name in documents and messages.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Starttls => "starttls",
            Self::Tls => "tls",
            Self::None => "none",
        }
    }
}

/// Settings group `smtp`. A group that was never written means there is no mail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct Smtp {
    /// The server: a host name or an IP address.
    #[cfg_attr(feature = "openapi", schema(example = "smtp.example.com"))]
    pub host: String,
    /// The port (1 to 65535).
    #[cfg_attr(feature = "openapi", schema(example = 587))]
    pub port: u16,
    /// How the connection is secured.
    pub security: SmtpSecurity,
    /// The login of the server; `null` for a server without authentication.
    #[cfg_attr(feature = "openapi", schema(example = "stuffcloud"))]
    pub username: Option<String>,
    /// The password as a reference to the deployment configuration; `null` without a login.
    pub password: Option<SecretRef>,
    /// The sender address of every mail.
    #[cfg_attr(feature = "openapi", schema(example = "noreply@example.com"))]
    pub from: String,
    /// The name shown next to the sender address; `null` for none.
    #[cfg_attr(feature = "openapi", schema(example = "stuffcloud"))]
    pub from_name: Option<String>,
}

/// Whether a label is a valid part of a host name (letters, digits and `-`, not at the edges).
fn valid_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_LABEL_LEN
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        && bytes.first() != Some(&b'-')
        && bytes.last() != Some(&b'-')
}

/// Whether a text is a host name (labels of letters, digits and `-`; a single label is fine, a
/// service name of a container network has no dot; the last label is not all digits, so an
/// incomplete address such as `10.0.1` is not taken for a name) or an IP address.
#[must_use]
pub fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > MAX_HOST_LEN {
        return false;
    }
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }
    let mut last_is_numeric = false;
    for label in host.split('.') {
        if !valid_label(label) {
            return false;
        }
        last_is_numeric = label.bytes().all(|byte| byte.is_ascii_digit());
    }
    !last_is_numeric
}

/// Whether a text is a login name of an SMTP server: 1 to [`MAX_USERNAME_LEN`] bytes, no
/// control character.
fn valid_username(username: &str) -> bool {
    !username.is_empty()
        && username.len() <= MAX_USERNAME_LEN
        && !username.chars().any(char::is_control)
}

/// Whether a text is a display name of the sender: 1 to [`MAX_FROM_NAME_CHARS`] characters, no
/// control character, no `<`, `>`, `"` or `\` (they would blur where the name ends and the
/// address begins), no space at either end.
#[must_use]
pub fn valid_from_name(name: &str) -> bool {
    let chars = name.chars().count();
    (1..=MAX_FROM_NAME_CHARS).contains(&chars)
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '\\'))
        && name.trim() == name
}

impl Smtp {
    /// Name of the settings group in URLs and configuration files.
    pub const GROUP: &'static str = "smtp";

    /// The sender address as a validated address.
    #[must_use]
    pub fn from_address(&self) -> Option<Email> {
        Email::parse(&self.from).ok()
    }

    fn check_host(&self) -> Vec<FieldError> {
        if valid_host(&self.host) {
            return Vec::new();
        }
        let detail = if self.host.is_empty() || self.host.len() > MAX_HOST_LEN {
            format!("the host must have 1 to {MAX_HOST_LEN} characters")
        } else {
            "the host must be a host name (labels of letters, digits and '-', separated by dots) or an IP address"
                .to_owned()
        };
        vec![FieldError::new(
            JsonPointer::root().key("host"),
            FieldErrorCode::InvalidValue,
            detail,
        )]
    }

    fn check_port(&self) -> Vec<FieldError> {
        if self.port == 0 {
            vec![FieldError::new(
                JsonPointer::root().key("port"),
                FieldErrorCode::InvalidValue,
                "the port must be 1 to 65535",
            )]
        } else {
            Vec::new()
        }
    }

    fn check_credentials(&self) -> Vec<FieldError> {
        let mut errors = Vec::new();
        let username = JsonPointer::root().key("username");
        let password = JsonPointer::root().key("password");
        if let Some(name) = &self.username
            && !valid_username(name)
        {
            errors.push(FieldError::new(
                username.clone(),
                FieldErrorCode::InvalidValue,
                format!("the username must have 1 to {MAX_USERNAME_LEN} characters and no control character"),
            ));
        }
        match (&self.username, &self.password) {
            (Some(_), None) => errors.push(FieldError::new(
                password.clone(),
                FieldErrorCode::MissingField,
                "a username needs a password reference",
            )),
            (None, Some(_)) => errors.push(FieldError::new(
                username,
                FieldErrorCode::MissingField,
                "a password reference needs a username",
            )),
            _ => {}
        }
        if let Some(reference) = &self.password
            && let Err(error) = reference.check()
        {
            errors.push(FieldError::new(
                password.key("ref"),
                FieldErrorCode::InvalidValue,
                error.to_string(),
            ));
        }
        if self.security == SmtpSecurity::None
            && (self.username.is_some() || self.password.is_some())
        {
            errors.push(FieldError::new(
                JsonPointer::root().key("security"),
                FieldErrorCode::InvalidValue,
                "security none cannot be combined with a username and password: credentials are never sent unencrypted",
            ));
        }
        errors
    }

    fn check_sender(&self) -> Vec<FieldError> {
        let mut errors = Vec::new();
        if let Err(error) = Email::parse(&self.from) {
            errors.push(FieldError::new(
                JsonPointer::root().key("from"),
                FieldErrorCode::InvalidValue,
                error.to_string(),
            ));
        }
        if let Some(name) = &self.from_name
            && !valid_from_name(name)
        {
            errors.push(FieldError::new(
                JsonPointer::root().key("from_name"),
                FieldErrorCode::InvalidValue,
                format!(
                    "the name must have 1 to {MAX_FROM_NAME_CHARS} characters, no control character, no '<', '>', '\"' or '\\' and no space at either end"
                ),
            ));
        }
        errors
    }
}

impl Writable for Smtp {
    const FIELDS: &'static [&'static str] = &[
        "host",
        "port",
        "security",
        "username",
        "password",
        "from",
        "from_name",
    ];
    const RULES: &'static [Rule<Self>] = &[
        Self::check_host,
        Self::check_port,
        Self::check_credentials,
        Self::check_sender,
    ];
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::body::{BodyError, parse_writable};

    fn sample() -> Smtp {
        Smtp {
            host: "smtp.example.com".to_owned(),
            port: 587,
            security: SmtpSecurity::Starttls,
            username: Some("stuffcloud".to_owned()),
            password: Some(SecretRef {
                name: "STUFFCLOUD_SECRET_SMTP".to_owned(),
            }),
            from: "noreply@example.com".to_owned(),
            from_name: Some("stuffcloud".to_owned()),
        }
    }

    fn reference(name: &str) -> SecretRef {
        SecretRef {
            name: name.to_owned(),
        }
    }

    fn problems(smtp: &Smtp) -> Vec<(String, FieldErrorCode, String)> {
        smtp.validate()
            .into_iter()
            .map(|e| (e.pointer.as_str().to_owned(), e.code, e.detail))
            .collect()
    }

    fn only(smtp: &Smtp) -> (String, FieldErrorCode, String) {
        let mut found = problems(smtp);
        assert_eq!(found.len(), 1, "{found:?}");
        found.remove(0)
    }

    #[test]
    fn the_sample_is_valid_and_so_is_a_catcher_without_a_login() {
        assert_eq!(sample().validate(), Vec::new());
        let catcher = Smtp {
            host: "mailpit".to_owned(),
            port: 1025,
            security: SmtpSecurity::None,
            username: None,
            password: None,
            from: "noreply@stuff.localhost".to_owned(),
            from_name: None,
        };
        assert_eq!(catcher.validate(), Vec::new());
        assert_eq!(
            catcher.from_address().unwrap().as_str(),
            "noreply@stuff.localhost"
        );
    }

    #[test]
    fn hosts_names_and_addresses() {
        for good in [
            "smtp.example.com",
            "SMTP.Example.COM",
            "mailpit",
            "a",
            "mail-1.example.org",
            "192.0.2.25",
            "2001:db8::25",
            "::1",
            "1a.example",
            "xn--mller-kva.example",
        ] {
            assert!(valid_host(good), "{good}");
        }
        for bad in [
            "",
            "-a.example",
            "a-.example",
            "a..example",
            ".example",
            "example.",
            "a b.example",
            "a_b.example",
            "smtp.example.com\r\nRCPT TO:<x@y.z>",
            "smtp.example.com:25",
            "[::1]",
            "10.0.1",
            "1.2.3.4.5",
            "999.1.1.1",
            "mail.exämple.com",
            "smtp.example.com/",
        ] {
            assert!(!valid_host(bad), "{bad:?}");
        }
        // The length limits are exact: 253 bytes pass, 254 do not; 63 bytes per label, not 64.
        let label = "a".repeat(MAX_LABEL_LEN);
        let name_253 = format!("{label}.{label}.{label}.{}", "a".repeat(61));
        assert_eq!(name_253.len(), MAX_HOST_LEN);
        assert!(valid_host(&name_253));
        assert!(!valid_host(&format!("{name_253}a")));
        assert!(!valid_host(&format!("{}.example", "a".repeat(64))));
    }

    #[test]
    fn a_bad_host_is_reported_at_the_host() {
        let mut smtp = sample();
        smtp.host = "smtp.example.com\r\nX: y".to_owned();
        assert_eq!(
            only(&smtp),
            (
                "/host".to_owned(),
                FieldErrorCode::InvalidValue,
                "the host must be a host name (labels of letters, digits and '-', separated by dots) or an IP address"
                    .to_owned()
            )
        );
        smtp.host = String::new();
        assert_eq!(
            only(&smtp).2,
            "the host must have 1 to 253 characters".to_owned()
        );
        smtp.host = "a".repeat(254);
        assert_eq!(
            only(&smtp).2,
            "the host must have 1 to 253 characters".to_owned()
        );
    }

    #[test]
    fn the_port_is_one_to_65535() {
        let mut smtp = sample();
        smtp.port = 0;
        assert_eq!(
            only(&smtp),
            (
                "/port".to_owned(),
                FieldErrorCode::InvalidValue,
                "the port must be 1 to 65535".to_owned()
            )
        );
        for port in [1, 25, 465, 587, 65535] {
            smtp.port = port;
            assert_eq!(smtp.validate(), Vec::new());
        }
    }

    #[test]
    fn secret_references() {
        for good in [
            "STUFFCLOUD_SECRET_SMTP",
            "STUFFCLOUD_SECRET_A",
            "STUFFCLOUD_SECRET_SMTP_2",
            "STUFFCLOUD_SECRET_0",
            "STUFFCLOUD_SECRET__",
        ] {
            assert_eq!(reference(good).check(), Ok(()), "{good}");
        }
        let prefix = [
            "",
            "SMTP",
            "STUFFCLOUD_SECRET",
            "stuffcloud_secret_smtp",
            "STUFFCLOUD_SECRETS_KEY_FILE",
            "STUFFCLOUD_SECRETS_KEY",
            "PATH",
            "HOME",
            " STUFFCLOUD_SECRET_SMTP",
        ];
        for bad in prefix {
            assert_eq!(reference(bad).check(), Err(SecretRefError::Prefix), "{bad}");
        }
        for bad in [
            "STUFFCLOUD_SECRET_",
            "STUFFCLOUD_SECRET_smtp",
            "STUFFCLOUD_SECRET_SMTP-1",
            "STUFFCLOUD_SECRET_SMTP ",
            "STUFFCLOUD_SECRET_SMTP\n",
            "STUFFCLOUD_SECRET_SMTP_FILE",
            "STUFFCLOUD_SECRET__FILE",
            "STUFFCLOUD_SECRET_SMT\u{c4}",
        ] {
            assert_eq!(reference(bad).check(), Err(SecretRefError::Name), "{bad:?}");
        }
        // 64 bytes pass, 65 do not.
        let fits = format!("{SECRET_PREFIX}{}", "A".repeat(MAX_SECRET_REF_LEN - 18));
        assert_eq!(fits.len(), MAX_SECRET_REF_LEN);
        assert_eq!(reference(&fits).check(), Ok(()));
        assert_eq!(
            reference(&format!("{fits}A")).check(),
            Err(SecretRefError::Length)
        );
        assert_eq!(
            reference("STUFFCLOUD_SECRET_SMTP").file_variable(),
            "STUFFCLOUD_SECRET_SMTP_FILE"
        );
    }

    #[test]
    fn secret_reference_messages() {
        assert_eq!(
            SecretRefError::Prefix.to_string(),
            "a secret reference must start with STUFFCLOUD_SECRET_"
        );
        assert_eq!(
            SecretRefError::Length.to_string(),
            "a secret reference has at most 64 characters"
        );
        assert_eq!(
            SecretRefError::Name.to_string(),
            "after STUFFCLOUD_SECRET_ a secret reference has capital letters, digits and '_' only, at least one, and does not end in _FILE (the file form is found by itself)"
        );
    }

    #[test]
    fn a_bad_reference_is_reported_at_its_ref_member() {
        let mut smtp = sample();
        smtp.password = Some(reference("PATH"));
        assert_eq!(
            only(&smtp),
            (
                "/password/ref".to_owned(),
                FieldErrorCode::InvalidValue,
                "a secret reference must start with STUFFCLOUD_SECRET_".to_owned()
            )
        );
    }

    #[test]
    fn a_login_needs_both_halves() {
        let mut smtp = sample();
        smtp.password = None;
        assert_eq!(
            only(&smtp),
            (
                "/password".to_owned(),
                FieldErrorCode::MissingField,
                "a username needs a password reference".to_owned()
            )
        );
        let mut smtp = sample();
        smtp.username = None;
        assert_eq!(
            only(&smtp),
            (
                "/username".to_owned(),
                FieldErrorCode::MissingField,
                "a password reference needs a username".to_owned()
            )
        );
        let mut smtp = sample();
        smtp.username = None;
        smtp.password = None;
        assert_eq!(smtp.validate(), Vec::new());
    }

    #[test]
    fn usernames() {
        let mut smtp = sample();
        for good in [
            "a",
            "user@example.com",
            &"u".repeat(MAX_USERNAME_LEN),
            "j\u{fc}rgen",
        ] {
            smtp.username = Some(good.to_owned());
            assert_eq!(smtp.validate(), Vec::new(), "{good}");
        }
        for bad in [
            String::new(),
            "u".repeat(MAX_USERNAME_LEN + 1),
            "a\r\nb".to_owned(),
            "a\0b".to_owned(),
            "a\tb".to_owned(),
            "a\u{85}b".to_owned(),
        ] {
            smtp.username = Some(bad.clone());
            assert_eq!(
                only(&smtp),
                (
                    "/username".to_owned(),
                    FieldErrorCode::InvalidValue,
                    "the username must have 1 to 256 characters and no control character"
                        .to_owned()
                ),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn plain_text_never_carries_credentials() {
        let mut smtp = sample();
        smtp.security = SmtpSecurity::None;
        let detail = "security none cannot be combined with a username and password: credentials are never sent unencrypted";
        assert_eq!(
            only(&smtp),
            (
                "/security".to_owned(),
                FieldErrorCode::InvalidValue,
                detail.to_owned()
            )
        );
        // Either half alone is refused twice over: once for the login being incomplete and
        // once for the plain connection.
        smtp.password = None;
        assert_eq!(problems(&smtp).len(), 2);
        assert!(
            problems(&smtp)
                .iter()
                .any(|(pointer, _, d)| pointer == "/security" && d == detail)
        );
        smtp.password = sample().password;
        smtp.username = None;
        assert_eq!(problems(&smtp).len(), 2);
        // The two encrypted modes take the login.
        for security in [SmtpSecurity::Starttls, SmtpSecurity::Tls] {
            let mut smtp = sample();
            smtp.security = security;
            assert_eq!(smtp.validate(), Vec::new());
        }
    }

    #[test]
    fn sender_addresses() {
        let mut smtp = sample();
        smtp.from = "no reply@example.com".to_owned();
        let (pointer, code, detail) = only(&smtp);
        assert_eq!(pointer, "/from");
        assert_eq!(code, FieldErrorCode::InvalidValue);
        assert_eq!(
            detail,
            Email::parse("no reply@example.com")
                .unwrap_err()
                .to_string()
        );
        for bad in [
            "",
            "noreply",
            "noreply@example",
            "noreply@example.com\r\nBcc: x@example.com",
            "<noreply@example.com>",
            "a@b.example, c@d.example",
        ] {
            smtp.from = bad.to_owned();
            assert_eq!(only(&smtp).0, "/from", "{bad:?}");
            assert!(smtp.from_address().is_none());
        }
    }

    #[test]
    fn sender_names() {
        let mut smtp = sample();
        for good in [
            "stuffcloud",
            "J\u{fc}rgen's cloud",
            "a",
            &"n".repeat(MAX_FROM_NAME_CHARS),
            "x (home)",
        ] {
            smtp.from_name = Some(good.to_owned());
            assert_eq!(smtp.validate(), Vec::new(), "{good}");
        }
        smtp.from_name = None;
        assert_eq!(smtp.validate(), Vec::new());
        for bad in [
            String::new(),
            "n".repeat(MAX_FROM_NAME_CHARS + 1),
            "a\r\nBcc: x@example.com".to_owned(),
            "a\nb".to_owned(),
            "a\0b".to_owned(),
            "Bob <bob@example.com>".to_owned(),
            "a>b".to_owned(),
            "a\"b".to_owned(),
            "a\\b".to_owned(),
            " a".to_owned(),
            "a ".to_owned(),
            "\u{a0}a".to_owned(),
        ] {
            smtp.from_name = Some(bad.clone());
            assert_eq!(
                only(&smtp),
                (
                    "/from_name".to_owned(),
                    FieldErrorCode::InvalidValue,
                    "the name must have 1 to 64 characters, no control character, no '<', '>', '\"' or '\\' and no space at either end".to_owned()
                ),
                "{bad:?}"
            );
        }
        // Characters, not bytes: 64 two-byte characters fit.
        smtp.from_name = Some("\u{fc}".repeat(MAX_FROM_NAME_CHARS));
        assert_eq!(smtp.validate(), Vec::new());
    }

    #[test]
    fn every_problem_is_reported_at_once() {
        let smtp = Smtp {
            host: String::new(),
            port: 0,
            security: SmtpSecurity::None,
            username: Some(String::new()),
            password: Some(reference("X")),
            from: "x".to_owned(),
            from_name: Some(String::new()),
        };
        let pointers: Vec<String> = problems(&smtp).into_iter().map(|(p, _, _)| p).collect();
        assert_eq!(
            pointers,
            vec![
                "/host",
                "/port",
                "/username",
                "/password/ref",
                "/security",
                "/from",
                "/from_name"
            ]
        );
    }

    #[test]
    fn parses_through_the_writable_conventions() {
        let document = json!({
            "host": "smtp.example.com",
            "port": 465,
            "security": "tls",
            "username": "stuffcloud",
            "password": {"ref": "STUFFCLOUD_SECRET_SMTP"},
            "from": "noreply@example.com",
            "from_name": null,
            "meta": {"etag": "x"}
        });
        let parsed: Smtp = parse_writable(document.to_string().as_bytes()).unwrap();
        assert_eq!(parsed.security, SmtpSecurity::Tls);
        assert_eq!(parsed.port, 465);
        assert_eq!(parsed.from_name, None);
        assert_eq!(
            serde_json::to_value(&parsed).unwrap(),
            json!({
                "host": "smtp.example.com",
                "port": 465,
                "security": "tls",
                "username": "stuffcloud",
                "password": {"ref": "STUFFCLOUD_SECRET_SMTP"},
                "from": "noreply@example.com",
                "from_name": null
            })
        );
    }

    #[test]
    fn the_full_shape_is_required_and_unknown_members_are_refused() {
        let errors = |document: serde_json::Value| match parse_writable::<Smtp>(
            document.to_string().as_bytes(),
        ) {
            Err(BodyError::Invalid(errors)) => errors
                .into_iter()
                .map(|e| (e.pointer.as_str().to_owned(), e.code))
                .collect::<Vec<_>>(),
            other => panic!("{other:?}"),
        };
        assert_eq!(
            errors(json!({"host": "mailpit"})),
            vec![
                ("/port".to_owned(), FieldErrorCode::MissingField),
                ("/security".to_owned(), FieldErrorCode::MissingField),
                ("/username".to_owned(), FieldErrorCode::MissingField),
                ("/password".to_owned(), FieldErrorCode::MissingField),
                ("/from".to_owned(), FieldErrorCode::MissingField),
                ("/from_name".to_owned(), FieldErrorCode::MissingField),
            ]
        );
        let mut document = json!({
            "host": "mailpit", "port": 1025, "security": "none", "username": null,
            "password": null, "from": "noreply@stuff.localhost", "from_name": null
        });
        document["extra"] = json!(1);
        assert_eq!(
            errors(document.clone()),
            vec![("/extra".to_owned(), FieldErrorCode::UnknownField)]
        );
        let _extra = document.as_object_mut().unwrap().remove("extra");
        document["port"] = json!(70000);
        assert_eq!(
            errors(document.clone()),
            vec![("/port".to_owned(), FieldErrorCode::InvalidType)]
        );
        document["port"] = json!(1025);
        document["security"] = json!("ssl");
        assert_eq!(
            errors(document.clone()),
            vec![("/security".to_owned(), FieldErrorCode::InvalidType)]
        );
    }

    #[test]
    fn a_secret_reference_is_an_object_with_a_ref_and_nothing_else() {
        let parse = |value: serde_json::Value| serde_json::from_value::<SecretRef>(value);
        assert_eq!(
            parse(json!({"ref": "STUFFCLOUD_SECRET_SMTP"})).unwrap(),
            reference("STUFFCLOUD_SECRET_SMTP")
        );
        // Whatever the text is, a name is only checked later, by `check`.
        assert_eq!(parse(json!({"ref": ""})).unwrap(), reference(""));
        for bad in [
            json!({}),
            json!({"ref": 5}),
            json!({"ref": null}),
            json!({"ref": ["STUFFCLOUD_SECRET_SMTP"]}),
            json!({"value": "hunter2"}),
            json!({"stored": true}),
            json!({"ref": "STUFFCLOUD_SECRET_SMTP", "value": "hunter2"}),
            json!("hunter2"),
            json!(["hunter2"]),
            json!(7),
            json!(true),
            json!(null),
        ] {
            let error = parse(bad.clone()).unwrap_err().to_string();
            assert_eq!(error, SECRET_SHAPE_MESSAGE, "{bad}");
            assert!(!error.contains("hunter2"));
        }
    }

    #[test]
    fn a_secret_value_is_not_accepted_yet() {
        // The write-only forms of ADR 0010's addendum (#152) are not implemented: only a
        // reference is a secret today, and the error never repeats what was written.
        for member in [
            json!({"value": "hunter2"}),
            json!({"stored": true}),
            json!({"ref": "STUFFCLOUD_SECRET_SMTP", "value": "hunter2"}),
            json!("hunter2"),
            json!(["hunter2"]),
        ] {
            let document = json!({
                "host": "smtp.example.com", "port": 587, "security": "starttls",
                "username": "u", "password": member,
                "from": "noreply@example.com", "from_name": null
            });
            match parse_writable::<Smtp>(document.to_string().as_bytes()) {
                Err(BodyError::Invalid(errors)) => {
                    assert_eq!(errors.len(), 1, "{errors:?}");
                    assert_eq!(errors[0].pointer.as_str(), "/password");
                    assert_eq!(errors[0].code, FieldErrorCode::InvalidType);
                    assert_eq!(errors[0].detail, SECRET_SHAPE_MESSAGE);
                }
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn names_of_the_group_and_the_modes() {
        assert_eq!(Smtp::GROUP, "smtp");
        assert_eq!(SmtpSecurity::Starttls.as_str(), "starttls");
        assert_eq!(SmtpSecurity::Tls.as_str(), "tls");
        assert_eq!(SmtpSecurity::None.as_str(), "none");
        for security in [
            SmtpSecurity::Starttls,
            SmtpSecurity::Tls,
            SmtpSecurity::None,
        ] {
            assert_eq!(
                serde_json::to_value(security).unwrap(),
                json!(security.as_str())
            );
        }
    }
}
