//! Local accounts (A-03, SPEC 6, ADR 0005 addendum "local accounts"): login names, e-mail
//! addresses, the password policy and the request documents of the account actions.
//!
//! - A [`Login`] is the natural key of an account (SPEC 10.2): 3 to 32 bytes of `a-z`, `0-9`,
//!   `.`, `_` and `-`, starting and ending with a letter or digit. There is exactly one
//!   spelling: uppercase is refused, never folded, so two accounts cannot differ by case.
//! - An [`Email`] is ASCII (an internationalised domain is written in its `xn--` form), has one
//!   `@`, a dot-atom local part and a domain of at least two labels. It is stored in lowercase,
//!   so an address is unique whatever case it was typed in.
//! - The login form takes either; [`Identifier::from_input`] trims and lowercases what was typed
//!   and decides by the `@`. Input that is neither a login nor an address simply matches no
//!   account, so it is answered like an unknown account (no hint about the rules).
//! - Passwords are compared and hashed in Unicode NFKC ([`normalize_password`], as NIST SP
//!   800-63B asks), so the same password typed on another keyboard or system still matches. The
//!   policy ([`PasswordPolicy`]) is length based: at least `min_chars` characters (default 12,
//!   never below 8), at most [`MAX_PASSWORD_CHARS`]; not the login name or the e-mail address
//!   (or its local part), not one character repeated. The breached-password check is an
//!   offline list the operator may configure (`app`); this crate only reports the verdict.
//!
//! Nothing here touches a network, a clock or a random source.

use std::fmt;

use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

use crate::body::Action;
use crate::field::{FieldError, FieldErrorCode, JsonPointer};
use crate::token::Token;

/// Shortest login name in bytes.
pub const MIN_LOGIN_LEN: usize = 3;
/// Longest login name in bytes.
pub const MAX_LOGIN_LEN: usize = 32;
/// Longest e-mail address in bytes (RFC 5321 path limit minus the angle brackets).
pub const MAX_EMAIL_LEN: usize = 254;
/// Longest local part of an e-mail address in bytes (RFC 5321).
pub const MAX_EMAIL_LOCAL_LEN: usize = 64;
/// Longest domain label in bytes (RFC 1035).
pub const MAX_LABEL_LEN: usize = 63;
/// Longest text the login form accepts as login name or address, in bytes.
pub const MAX_IDENTIFIER_LEN: usize = 320;
/// Longest password in bytes as sent. Bounds the work before hashing; a longer body is refused
/// before any account is looked up.
pub const MAX_PASSWORD_BYTES: usize = 1024;
/// Longest password in characters (after NFKC).
pub const MAX_PASSWORD_CHARS: usize = 256;
/// The lowest minimum length an operator may configure (NIST SP 800-63B).
pub const MIN_PASSWORD_FLOOR: usize = 8;
/// The default minimum length.
pub const DEFAULT_MIN_PASSWORD_CHARS: usize = 12;
/// The highest minimum length an operator may configure.
pub const MAX_MIN_PASSWORD_CHARS: usize = 128;
/// Default lifetime of an invitation in hours (7 days).
pub const DEFAULT_INVITATION_HOURS: u32 = 168;
/// Longest lifetime of an invitation in hours (30 days).
pub const MAX_INVITATION_HOURS: u32 = 720;

/// Why a text is not a login name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum LoginError {
    /// Shorter than [`MIN_LOGIN_LEN`] or longer than [`MAX_LOGIN_LEN`] bytes.
    Length(usize),
    /// The byte at this position is not `a-z`, `0-9`, `.`, `_` or `-`.
    Character(usize),
    /// The first or the last character is not a letter or digit.
    Edge,
}

impl fmt::Display for LoginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Length(length) => write!(
                f,
                "a login name has {MIN_LOGIN_LEN} to {MAX_LOGIN_LEN} characters, not {length}"
            ),
            Self::Character(index) => write!(
                f,
                "character {index} is not one of a-z, 0-9, '.', '_' or '-' (lowercase only)"
            ),
            Self::Edge => f.write_str("a login name starts and ends with a letter or digit"),
        }
    }
}

impl std::error::Error for LoginError {}

/// A valid login name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Login(String);

const fn is_login_alnum(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit()
}

impl Login {
    /// Parses a login name; see the module documentation for the rules.
    ///
    /// # Errors
    ///
    /// The first rule the text breaks.
    pub fn parse(text: &str) -> Result<Self, LoginError> {
        let bytes = text.as_bytes();
        if !(MIN_LOGIN_LEN..=MAX_LOGIN_LEN).contains(&bytes.len()) {
            return Err(LoginError::Length(bytes.len()));
        }
        if let Some(index) = bytes
            .iter()
            .position(|byte| !(is_login_alnum(*byte) || matches!(byte, b'.' | b'_' | b'-')))
        {
            return Err(LoginError::Character(index));
        }
        match (bytes.first(), bytes.last()) {
            (Some(first), Some(last)) if is_login_alnum(*first) && is_login_alnum(*last) => {
                Ok(Self(text.to_owned()))
            }
            _ => Err(LoginError::Edge),
        }
    }

    /// The login name.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Login {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Why a text is not an e-mail address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum EmailError {
    /// Longer than [`MAX_EMAIL_LEN`] bytes, or empty.
    Length(usize),
    /// The byte at this position is not visible ASCII.
    Character(usize),
    /// There is not exactly one `@`.
    At,
    /// The part before the `@` is empty, too long or not a dot-atom.
    Local,
    /// The part after the `@` is not a domain name of at least two labels.
    Domain,
}

impl fmt::Display for EmailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Length(length) => write!(
                f,
                "an e-mail address has 1 to {MAX_EMAIL_LEN} characters, not {length}"
            ),
            Self::Character(index) => write!(
                f,
                "character {index} is not visible ASCII (write an international domain in its xn-- form)"
            ),
            Self::At => f.write_str("an e-mail address has exactly one '@'"),
            Self::Local => write!(
                f,
                "the part before '@' must be 1 to {MAX_EMAIL_LOCAL_LEN} characters without spaces, quotes or a leading, trailing or double '.'"
            ),
            Self::Domain => f.write_str(
                "the part after '@' must be a domain name with at least one dot (labels of a-z, 0-9 and '-')",
            ),
        }
    }
}

impl std::error::Error for EmailError {}

/// A valid e-mail address, in lowercase.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Email(String);

/// The `atext` characters of RFC 5322 besides letters and digits.
const fn is_atext(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'/'
                | b'='
                | b'?'
                | b'^'
                | b'_'
                | b'`'
                | b'{'
                | b'|'
                | b'}'
                | b'~'
                | b'-'
        )
}

fn valid_local(local: &str) -> bool {
    !local.is_empty()
        && local.len() <= MAX_EMAIL_LOCAL_LEN
        && local
            .split('.')
            .all(|atom| !atom.is_empty() && atom.bytes().all(is_atext))
}

fn valid_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_LABEL_LEN
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && bytes.first() != Some(&b'-')
        && bytes.last() != Some(&b'-')
}

impl Email {
    /// Parses an e-mail address (any case) into its lowercase form; see the module
    /// documentation for the rules.
    ///
    /// # Errors
    ///
    /// The first rule the text breaks.
    pub fn parse(text: &str) -> Result<Self, EmailError> {
        let bytes = text.as_bytes();
        if bytes.is_empty() || bytes.len() > MAX_EMAIL_LEN {
            return Err(EmailError::Length(bytes.len()));
        }
        if let Some(index) = bytes.iter().position(|byte| !byte.is_ascii_graphic()) {
            return Err(EmailError::Character(index));
        }
        let lower = text.to_ascii_lowercase();
        let mut parts = lower.split('@');
        let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
            return Err(EmailError::At);
        };
        if !valid_local(local) {
            return Err(EmailError::Local);
        }
        if domain.split('.').count() < 2 || !domain.split('.').all(valid_label) {
            return Err(EmailError::Domain);
        }
        Ok(Self(lower))
    }

    /// The address.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The part before the `@`.
    #[must_use]
    pub fn local_part(&self) -> &str {
        self.0.split('@').next().unwrap_or_default()
    }
}

impl fmt::Display for Email {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// What a person typed into the login form, normalised: surrounding whitespace removed, ASCII
/// letters in lowercase. The throttles of the login count by this text, whether or not it
/// names an account, so an unknown name is throttled exactly like a known one.
#[must_use]
pub fn normalize_identifier(text: &str) -> String {
    text.trim_matches(|c: char| c.is_ascii_whitespace())
        .to_ascii_lowercase()
}

/// How the login form names an account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Identifier {
    /// By login name.
    Login(Login),
    /// By e-mail address.
    Email(Email),
}

impl Identifier {
    /// Reads the login form's first field: an e-mail address when it has an `@`, a login name
    /// otherwise. `None` when it is neither (it then matches no account).
    #[must_use]
    pub fn from_input(text: &str) -> Option<Self> {
        let normalized = normalize_identifier(text);
        if normalized.contains('@') {
            Email::parse(&normalized).ok().map(Self::Email)
        } else {
            Login::parse(&normalized).ok().map(Self::Login)
        }
    }
}

/// A password in the form that is hashed and compared: Unicode NFKC.
#[must_use]
pub fn normalize_password(password: &str) -> String {
    password.nfkc().collect()
}

/// A rule a new password breaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum PasswordProblem {
    /// Fewer characters than the policy's minimum.
    TooShort {
        /// The minimum.
        min: usize,
        /// The length given (characters after NFKC).
        actual: usize,
    },
    /// More than [`MAX_PASSWORD_CHARS`] characters or [`MAX_PASSWORD_BYTES`] bytes.
    TooLong,
    /// The login name, in any case.
    SameAsLogin,
    /// The e-mail address or its local part, in any case.
    SameAsEmail,
    /// One character repeated.
    OneCharacter,
    /// On the operator's list of breached or common passwords.
    Breached,
}

impl fmt::Display for PasswordProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShort { min, actual } => write!(
                f,
                "the password has {actual} characters; it needs at least {min}"
            ),
            Self::TooLong => write!(
                f,
                "the password is longer than {MAX_PASSWORD_CHARS} characters ({MAX_PASSWORD_BYTES} bytes)"
            ),
            Self::SameAsLogin => f.write_str("the password must not be the login name"),
            Self::SameAsEmail => f.write_str("the password must not be the e-mail address"),
            Self::OneCharacter => f.write_str("the password must not be one repeated character"),
            Self::Breached => f.write_str(
                "this password is on the list of breached or common passwords; choose another",
            ),
        }
    }
}

/// The account a new password is for, so the policy can refuse the obvious choices.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PasswordContext<'a> {
    /// The login name.
    pub login: &'a str,
    /// The e-mail address, if the account has one.
    pub email: Option<&'a str>,
}

/// The password policy (length based, SPEC 6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PasswordPolicy {
    min_chars: usize,
}

impl Default for PasswordPolicy {
    fn default() -> Self {
        Self {
            min_chars: DEFAULT_MIN_PASSWORD_CHARS,
        }
    }
}

impl PasswordPolicy {
    /// A policy with this minimum length; `None` outside [`MIN_PASSWORD_FLOOR`] to
    /// [`MAX_MIN_PASSWORD_CHARS`].
    #[must_use]
    pub fn new(min_chars: usize) -> Option<Self> {
        (MIN_PASSWORD_FLOOR..=MAX_MIN_PASSWORD_CHARS)
            .contains(&min_chars)
            .then_some(Self { min_chars })
    }

    /// The minimum length in characters.
    #[must_use]
    pub const fn min_chars(&self) -> usize {
        self.min_chars
    }

    /// Every rule `password` breaks, for the account in `context`. `breached` is the verdict of
    /// the offline list (computed by the caller on [`normalize_password`] of the same text).
    #[must_use]
    pub fn check(
        &self,
        password: &str,
        context: &PasswordContext<'_>,
        breached: bool,
    ) -> Vec<PasswordProblem> {
        if password.len() > MAX_PASSWORD_BYTES {
            return vec![PasswordProblem::TooLong];
        }
        let normalized = normalize_password(password);
        let length = normalized.chars().count();
        let mut problems = Vec::new();
        if length < self.min_chars {
            problems.push(PasswordProblem::TooShort {
                min: self.min_chars,
                actual: length,
            });
        }
        if length > MAX_PASSWORD_CHARS {
            problems.push(PasswordProblem::TooLong);
        }
        let folded = normalized.to_lowercase();
        if folded == context.login.to_lowercase() {
            problems.push(PasswordProblem::SameAsLogin);
        }
        if let Some(email) = context.email {
            let email = email.to_lowercase();
            let local = email.split('@').next().unwrap_or_default();
            if folded == email || folded == local {
                problems.push(PasswordProblem::SameAsEmail);
            }
        }
        let mut chars = normalized.chars();
        if let Some(first) = chars.next()
            && chars.all(|c| c == first)
        {
            problems.push(PasswordProblem::OneCharacter);
        }
        if breached {
            problems.push(PasswordProblem::Breached);
        }
        problems
    }

    /// [`PasswordPolicy::check`] as field errors at `pointer`.
    #[must_use]
    pub fn field_errors(
        &self,
        password: &str,
        context: &PasswordContext<'_>,
        breached: bool,
        pointer: &JsonPointer,
    ) -> Vec<FieldError> {
        self.check(password, context, breached)
            .into_iter()
            .map(|problem| {
                FieldError::new(
                    pointer.clone(),
                    FieldErrorCode::InvalidValue,
                    problem.to_string(),
                )
            })
            .collect()
    }
}

/// Field errors for a text that must be at most `max` bytes and not empty.
fn bounded(text: &str, max: usize, field: &str, errors: &mut Vec<FieldError>) {
    if text.is_empty() || text.len() > max {
        errors.push(FieldError::new(
            JsonPointer::root().key(field),
            FieldErrorCode::InvalidValue,
            format!("{field} must have 1 to {max} bytes"),
        ));
    }
}

/// A field error for a secret token (invitation, password reset) that is not well-formed.
fn token_field(text: &str, field: &str, errors: &mut Vec<FieldError>) {
    if let Err(error) = Token::parse(text.as_bytes()) {
        errors.push(FieldError::new(
            JsonPointer::root().key(field),
            FieldErrorCode::InvalidValue,
            error.to_string(),
        ));
    }
}

/// `POST /api/v1/auth/login`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct LoginRequest {
    /// The login name or the e-mail address of the account.
    #[cfg_attr(feature = "openapi", schema(example = "alice"))]
    pub login: String,
    /// The password.
    pub password: String,
}

impl Action for LoginRequest {
    const REQUIRED: &'static [&'static str] = &["login", "password"];
    const OPTIONAL: &'static [&'static str] = &[];

    fn validate(&self) -> Vec<FieldError> {
        let mut errors = Vec::new();
        bounded(&self.login, MAX_IDENTIFIER_LEN, "login", &mut errors);
        bounded(&self.password, MAX_PASSWORD_BYTES, "password", &mut errors);
        errors
    }
}

/// `POST /api/v1/auth/register`. The password policy is checked after these rules, by the
/// server (its minimum length and the offline list are deployment configuration).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct RegisterRequest {
    /// The login name (the natural key of the account).
    #[cfg_attr(feature = "openapi", schema(example = "alice"))]
    pub login: String,
    /// The e-mail address.
    #[cfg_attr(feature = "openapi", schema(example = "alice@example.com"))]
    pub email: String,
    /// The password.
    pub password: String,
    /// The invitation token (required in the sign-up mode `invite-only`).
    #[serde(default)]
    pub invitation: Option<String>,
}

impl Action for RegisterRequest {
    const REQUIRED: &'static [&'static str] = &["login", "email", "password"];
    const OPTIONAL: &'static [&'static str] = &["invitation"];

    fn validate(&self) -> Vec<FieldError> {
        let mut errors = Vec::new();
        if let Err(error) = Login::parse(&self.login) {
            errors.push(FieldError::new(
                JsonPointer::root().key("login"),
                FieldErrorCode::InvalidValue,
                error.to_string(),
            ));
        }
        if let Err(error) = Email::parse(&self.email) {
            errors.push(FieldError::new(
                JsonPointer::root().key("email"),
                FieldErrorCode::InvalidValue,
                error.to_string(),
            ));
        }
        bounded(&self.password, MAX_PASSWORD_BYTES, "password", &mut errors);
        if let Some(invitation) = &self.invitation {
            token_field(invitation, "invitation", &mut errors);
        }
        errors
    }
}

/// `POST /api/v1/account/password`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct PasswordChangeRequest {
    /// The password now.
    pub current_password: String,
    /// The new password.
    pub new_password: String,
}

impl Action for PasswordChangeRequest {
    const REQUIRED: &'static [&'static str] = &["current_password", "new_password"];
    const OPTIONAL: &'static [&'static str] = &[];

    fn validate(&self) -> Vec<FieldError> {
        let mut errors = Vec::new();
        bounded(
            &self.current_password,
            MAX_PASSWORD_BYTES,
            "current_password",
            &mut errors,
        );
        bounded(
            &self.new_password,
            MAX_PASSWORD_BYTES,
            "new_password",
            &mut errors,
        );
        errors
    }
}

/// `POST /api/v1/auth/password-reset`: redeem a reset token.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct PasswordResetRequest {
    /// The token from the reset link.
    pub token: String,
    /// The new password.
    pub password: String,
}

impl Action for PasswordResetRequest {
    const REQUIRED: &'static [&'static str] = &["token", "password"];
    const OPTIONAL: &'static [&'static str] = &[];

    fn validate(&self) -> Vec<FieldError> {
        let mut errors = Vec::new();
        token_field(&self.token, "token", &mut errors);
        bounded(&self.password, MAX_PASSWORD_BYTES, "password", &mut errors);
        errors
    }
}

/// `POST /api/v1/admin/invitations`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct InvitationRequest {
    /// Only this e-mail address may register with the invitation (any address when absent).
    #[serde(default)]
    #[cfg_attr(feature = "openapi", schema(example = "bob@example.com"))]
    pub email: Option<String>,
    /// Lifetime in hours (1 to 720, default 168).
    #[serde(default)]
    pub expires_in_hours: Option<u32>,
}

impl InvitationRequest {
    /// The lifetime in hours, with the default applied.
    #[must_use]
    pub fn hours(&self) -> u32 {
        self.expires_in_hours.unwrap_or(DEFAULT_INVITATION_HOURS)
    }
}

impl Action for InvitationRequest {
    const REQUIRED: &'static [&'static str] = &[];
    const OPTIONAL: &'static [&'static str] = &["email", "expires_in_hours"];

    fn validate(&self) -> Vec<FieldError> {
        let mut errors = Vec::new();
        if let Some(Err(error)) = self.email.as_deref().map(Email::parse) {
            errors.push(FieldError::new(
                JsonPointer::root().key("email"),
                FieldErrorCode::InvalidValue,
                error.to_string(),
            ));
        }
        if !(1..=MAX_INVITATION_HOURS).contains(&self.hours()) {
            errors.push(FieldError::new(
                JsonPointer::root().key("expires_in_hours"),
                FieldErrorCode::InvalidValue,
                format!("expires_in_hours must be 1 to {MAX_INVITATION_HOURS}"),
            ));
        }
        errors
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::{BodyError, parse_action};

    #[test]
    fn login_boundaries() {
        assert_eq!(Login::parse("abc").unwrap().as_str(), "abc");
        assert_eq!(Login::parse("ab"), Err(LoginError::Length(2)));
        assert_eq!(Login::parse(""), Err(LoginError::Length(0)));
        let longest = "a".repeat(MAX_LOGIN_LEN);
        assert_eq!(Login::parse(&longest).unwrap().to_string(), longest);
        assert_eq!(
            Login::parse(&"a".repeat(MAX_LOGIN_LEN + 1)),
            Err(LoginError::Length(33))
        );
        assert!(Login::parse("a.b_c-d0").is_ok());
        assert!(Login::parse("0z9").is_ok());
        assert_eq!(Login::parse("Abc"), Err(LoginError::Character(0)));
        assert_eq!(Login::parse("ab c"), Err(LoginError::Character(2)));
        assert_eq!(Login::parse("ab@c"), Err(LoginError::Character(2)));
        assert_eq!(Login::parse("abé"), Err(LoginError::Character(2)));
        for edge in [".ab", "ab.", "_ab", "ab_", "-ab", "ab-"] {
            assert_eq!(Login::parse(edge), Err(LoginError::Edge), "{edge}");
        }
    }

    #[test]
    fn login_messages() {
        assert_eq!(
            LoginError::Length(2).to_string(),
            "a login name has 3 to 32 characters, not 2"
        );
        assert_eq!(
            LoginError::Character(4).to_string(),
            "character 4 is not one of a-z, 0-9, '.', '_' or '-' (lowercase only)"
        );
        assert_eq!(
            LoginError::Edge.to_string(),
            "a login name starts and ends with a letter or digit"
        );
    }

    #[test]
    fn email_rules() {
        let parsed = Email::parse("Alice.B+x@Mail.Example.COM").unwrap();
        assert_eq!(parsed.as_str(), "alice.b+x@mail.example.com");
        assert_eq!(parsed.to_string(), "alice.b+x@mail.example.com");
        assert_eq!(parsed.local_part(), "alice.b+x");
        assert!(Email::parse("a@b.c").is_ok());
        assert!(Email::parse("o'neil!#$%&*/=?^_`{|}~-@xn--bcher-kva.example").is_ok());
        assert_eq!(Email::parse(""), Err(EmailError::Length(0)));
        let longest = format!(
            "{}@{}.{}.{}",
            "b".repeat(64),
            "d".repeat(63),
            "d".repeat(63),
            "d".repeat(61)
        );
        assert_eq!(longest.len(), MAX_EMAIL_LEN);
        assert!(Email::parse(&longest).is_ok());
        assert_eq!(
            Email::parse(&format!("{longest}x")),
            Err(EmailError::Length(255))
        );
        assert_eq!(
            Email::parse("a b@example.com"),
            Err(EmailError::Character(1))
        );
        assert_eq!(Email::parse("ä@example.com"), Err(EmailError::Character(0)));
        assert_eq!(Email::parse("a\u{7f}@x.y"), Err(EmailError::Character(1)));
        assert_eq!(Email::parse("example.com"), Err(EmailError::At));
        assert_eq!(Email::parse("a@b@example.com"), Err(EmailError::At));
        for local in ["", ".a", "a.", "a..b", "\"a\"", "a(b)", "a,b"] {
            assert_eq!(
                Email::parse(&format!("{local}@example.com")),
                Err(EmailError::Local),
                "{local}"
            );
        }
        assert_eq!(
            Email::parse(&format!("{}@example.com", "a".repeat(65))),
            Err(EmailError::Local)
        );
        assert!(Email::parse(&format!("{}@example.com", "a".repeat(64))).is_ok());
        for domain in [
            "localhost",
            "example..com",
            ".example.com",
            "example.com.",
            "-a.example",
            "a-.example",
            "a_b.example",
            "",
        ] {
            assert_eq!(
                Email::parse(&format!("a@{domain}")),
                Err(EmailError::Domain),
                "{domain}"
            );
        }
        assert!(Email::parse(&format!("a@{}.example", "d".repeat(63))).is_ok());
        assert_eq!(
            Email::parse(&format!("a@{}.example", "d".repeat(64))),
            Err(EmailError::Domain)
        );
    }

    #[test]
    fn email_messages() {
        assert_eq!(
            EmailError::Length(300).to_string(),
            "an e-mail address has 1 to 254 characters, not 300"
        );
        assert_eq!(
            EmailError::Character(3).to_string(),
            "character 3 is not visible ASCII (write an international domain in its xn-- form)"
        );
        assert_eq!(
            EmailError::At.to_string(),
            "an e-mail address has exactly one '@'"
        );
        assert_eq!(
            EmailError::Local.to_string(),
            "the part before '@' must be 1 to 64 characters without spaces, quotes or a leading, trailing or double '.'"
        );
        assert_eq!(
            EmailError::Domain.to_string(),
            "the part after '@' must be a domain name with at least one dot (labels of a-z, 0-9 and '-')"
        );
    }

    #[test]
    fn identifiers() {
        assert_eq!(normalize_identifier("  Alice\t\n"), "alice");
        assert_eq!(
            Identifier::from_input(" Alice "),
            Some(Identifier::Login(Login::parse("alice").unwrap()))
        );
        assert_eq!(
            Identifier::from_input("Alice@Example.com"),
            Some(Identifier::Email(
                Email::parse("alice@example.com").unwrap()
            ))
        );
        assert_eq!(Identifier::from_input("a"), None);
        assert_eq!(Identifier::from_input("a@b"), None);
        assert_eq!(Identifier::from_input(""), None);
    }

    fn context() -> PasswordContext<'static> {
        PasswordContext {
            login: "alice",
            email: Some("Alice.Smith@example.com"),
        }
    }

    #[test]
    fn policy_bounds() {
        assert_eq!(PasswordPolicy::default().min_chars(), 12);
        assert_eq!(PasswordPolicy::new(7), None);
        assert_eq!(PasswordPolicy::new(8).unwrap().min_chars(), 8);
        assert_eq!(PasswordPolicy::new(128).unwrap().min_chars(), 128);
        assert_eq!(PasswordPolicy::new(129), None);
    }

    #[test]
    fn password_length_is_counted_in_characters_after_nfkc() {
        let policy = PasswordPolicy::default();
        assert!(policy.check("correcthorse", &context(), false).is_empty());
        assert_eq!(
            policy.check("correcthors", &context(), false),
            vec![PasswordProblem::TooShort {
                min: 12,
                actual: 11
            }]
        );
        // Twelve characters of two bytes each.
        assert!(policy.check(&"äö".repeat(6), &context(), false).is_empty());
        // The ligature "ﬁ" becomes "fi" in NFKC: 6 + 6 characters.
        assert_eq!(normalize_password("ﬁ"), "fi");
        assert!(policy.check(&"ﬁx".repeat(4), &context(), false).is_empty());
        let longest = "ab".repeat(MAX_PASSWORD_CHARS / 2);
        assert!(policy.check(&longest, &context(), false).is_empty());
        assert_eq!(
            policy.check(&format!("{longest}c"), &context(), false),
            vec![PasswordProblem::TooLong]
        );
        assert_eq!(
            policy.check(&"x".repeat(MAX_PASSWORD_BYTES + 1), &context(), false),
            vec![PasswordProblem::TooLong]
        );
    }

    #[test]
    fn obvious_passwords_are_refused() {
        let policy = PasswordPolicy::new(8).unwrap();
        let long_login = PasswordContext {
            login: "alicealice",
            email: None,
        };
        assert_eq!(
            policy.check("AliceAlice", &long_login, false),
            vec![PasswordProblem::SameAsLogin]
        );
        assert_eq!(
            policy.check("alice.smith@EXAMPLE.com", &context(), false),
            vec![PasswordProblem::SameAsEmail]
        );
        assert_eq!(
            policy.check("Alice.Smith", &context(), false),
            vec![PasswordProblem::SameAsEmail]
        );
        assert_eq!(
            policy.check("aaaaaaaa", &context(), false),
            vec![PasswordProblem::OneCharacter]
        );
        assert!(policy.check("aaaaaaab", &context(), false).is_empty());
        assert_eq!(
            policy.check("unusual words", &context(), true),
            vec![PasswordProblem::Breached]
        );
        assert_eq!(
            policy.check("", &context(), false),
            vec![PasswordProblem::TooShort { min: 8, actual: 0 }]
        );
        let errors = policy.field_errors(
            "aaaaaaa",
            &context(),
            true,
            &JsonPointer::root().key("password"),
        );
        let details: Vec<&str> = errors.iter().map(|error| error.detail.as_str()).collect();
        assert_eq!(
            details,
            [
                "the password has 7 characters; it needs at least 8",
                "the password must not be one repeated character",
                "this password is on the list of breached or common passwords; choose another",
            ]
        );
        assert!(
            errors
                .iter()
                .all(|error| error.pointer.as_str() == "/password"
                    && error.code == FieldErrorCode::InvalidValue)
        );
    }

    #[test]
    fn password_messages() {
        assert_eq!(
            PasswordProblem::TooLong.to_string(),
            "the password is longer than 256 characters (1024 bytes)"
        );
        assert_eq!(
            PasswordProblem::SameAsLogin.to_string(),
            "the password must not be the login name"
        );
        assert_eq!(
            PasswordProblem::SameAsEmail.to_string(),
            "the password must not be the e-mail address"
        );
    }

    fn pointers(result: Result<impl fmt::Debug, BodyError>) -> Vec<String> {
        match result {
            Err(BodyError::Invalid(errors)) => errors
                .into_iter()
                .map(|error| error.pointer.as_str().to_owned())
                .collect(),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn login_request() {
        let ok: LoginRequest = parse_action(br#"{"login":"a","password":"p"}"#).unwrap();
        assert_eq!(ok.login, "a");
        assert_eq!(
            pointers(parse_action::<LoginRequest>(
                br#"{"login":"","password":""}"#
            )),
            ["/login", "/password"]
        );
        let long = format!(
            r#"{{"login":"{}","password":"{}"}}"#,
            "a".repeat(MAX_IDENTIFIER_LEN + 1),
            "p".repeat(MAX_PASSWORD_BYTES + 1)
        );
        assert_eq!(
            pointers(parse_action::<LoginRequest>(long.as_bytes())),
            ["/login", "/password"]
        );
        let longest = format!(
            r#"{{"login":"{}","password":"{}"}}"#,
            "a".repeat(MAX_IDENTIFIER_LEN),
            "p".repeat(MAX_PASSWORD_BYTES)
        );
        assert!(parse_action::<LoginRequest>(longest.as_bytes()).is_ok());
        let errors = LoginRequest {
            login: String::new(),
            password: "x".to_owned(),
        }
        .validate();
        assert_eq!(errors[0].detail, "login must have 1 to 320 bytes");
    }

    #[test]
    fn register_request() {
        let token = "ab".repeat(32);
        let body = format!(
            r#"{{"login":"alice","email":"Alice@Example.com","password":"p","invitation":"{token}"}}"#
        );
        let ok: RegisterRequest = parse_action(body.as_bytes()).unwrap();
        assert_eq!(ok.invitation.as_deref(), Some(token.as_str()));
        assert!(
            parse_action::<RegisterRequest>(
                br#"{"login":"alice","email":"a@example.com","password":"p"}"#
            )
            .is_ok()
        );
        assert_eq!(
            pointers(parse_action::<RegisterRequest>(
                br#"{"login":"A","email":"x","password":"","invitation":"nope"}"#
            )),
            ["/login", "/email", "/password", "/invitation"]
        );
    }

    #[test]
    fn password_change_and_reset_requests() {
        assert!(
            parse_action::<PasswordChangeRequest>(
                br#"{"current_password":"a","new_password":"b"}"#
            )
            .is_ok()
        );
        assert_eq!(
            pointers(parse_action::<PasswordChangeRequest>(
                br#"{"current_password":"","new_password":""}"#
            )),
            ["/current_password", "/new_password"]
        );
        let body = format!(r#"{{"token":"{}","password":"p"}}"#, "0".repeat(64));
        assert!(parse_action::<PasswordResetRequest>(body.as_bytes()).is_ok());
        assert_eq!(
            pointers(parse_action::<PasswordResetRequest>(
                br#"{"token":"x","password":""}"#
            )),
            ["/token", "/password"]
        );
    }

    #[test]
    fn invitation_request() {
        let empty: InvitationRequest = parse_action(b"{}").unwrap();
        assert_eq!(empty, InvitationRequest::default());
        assert_eq!(empty.hours(), DEFAULT_INVITATION_HOURS);
        let full: InvitationRequest =
            parse_action(br#"{"email":"b@example.com","expires_in_hours":720}"#).unwrap();
        assert_eq!(full.hours(), 720);
        assert!(parse_action::<InvitationRequest>(br#"{"expires_in_hours":1}"#).is_ok());
        assert_eq!(
            pointers(parse_action::<InvitationRequest>(
                br#"{"email":"nope","expires_in_hours":0}"#
            )),
            ["/email", "/expires_in_hours"]
        );
        assert_eq!(
            pointers(parse_action::<InvitationRequest>(
                br#"{"expires_in_hours":721}"#
            )),
            ["/expires_in_hours"]
        );
        let errors = InvitationRequest {
            email: None,
            expires_in_hours: Some(0),
        }
        .validate();
        assert_eq!(errors[0].detail, "expires_in_hours must be 1 to 720");
    }
}
