//! Site subdomains (docs/SPEC.md, section 5).
//!
//! A hosted site lives at `<subdomain>.<zone>`. The label is either generated
//! ([`Subdomain::from_random_bytes`]) or chosen by an account holder
//! ([`Subdomain::parse_user_input`]). Both end in [`Subdomain::parse`], the only
//! way to obtain a [`Subdomain`], so every value of the type obeys the rules below.
//!
//! Rules, stricter than DNS on purpose:
//! - 3 to 63 bytes from `a-z`, `0-9` and `-`; no uppercase, no other characters.
//! - No hyphen at the start or end.
//! - No hyphen at positions 3 and 4 (`xn--`, `ab--`): RFC 5891 reserves that shape
//!   for encoded labels, and allowing Punycode would allow homograph look-alikes of
//!   other sites.
//! - Not one of the [`RESERVED`] names (service, mail and autodiscovery hosts that
//!   clients probe on their own, such as `wpad`, `autoconfig` or `mta-sts`).

use std::fmt;
use std::str::FromStr;

/// Shortest label an account holder may choose.
pub const MIN_LEN: usize = 3;

/// Longest DNS label (RFC 1035).
pub const MAX_LEN: usize = 63;

/// Length of a generated label: 10 symbols of 5 bits each, 50 bits of entropy,
/// above the 40 bits the specification asks for.
pub const RANDOM_LEN: usize = 10;

/// Symbols of generated labels: 32 of them (`a-z` without `l` and `o`, `2-9`), so
/// every symbol is easy to read aloud and `byte % 32` picks one without bias.
pub const RANDOM_ALPHABET: &[u8; 32] = b"abcdefghijkmnpqrstuvwxyz23456789";

/// Names nobody can claim, sorted so a binary search can find them. An operator
/// list on top of this one belongs to the admin settings, not to this crate.
pub const RESERVED: &[&str] = &[
    "abuse",
    "account",
    "accounts",
    "admin",
    "administrator",
    "api",
    "app",
    "assets",
    "auth",
    "autoconfig",
    "autodiscover",
    "blog",
    "cdn",
    "dashboard",
    "dev",
    "docs",
    "edge",
    "ftp",
    "help",
    "hostmaster",
    "imap",
    "info",
    "isatap",
    "localhost",
    "login",
    "logout",
    "mail",
    "mta-sts",
    "ns1",
    "ns2",
    "ns3",
    "ns4",
    "oauth",
    "oidc",
    "pop",
    "pop3",
    "postmaster",
    "register",
    "root",
    "security",
    "signin",
    "signup",
    "smtp",
    "sso",
    "static",
    "status",
    "stuff",
    "stuffcloud",
    "support",
    "test",
    "webmail",
    "webmaster",
    "wpad",
    "www",
];

/// A validated site subdomain label.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Subdomain(String);

/// Why a label is not a valid [`Subdomain`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SubdomainError {
    /// The label is empty.
    Empty,
    /// Fewer than [`MIN_LEN`] bytes.
    TooShort,
    /// More than [`MAX_LEN`] bytes.
    TooLong,
    /// A character outside `a-z`, `0-9` and `-`, at this byte offset.
    InvalidChar {
        /// Byte offset of the first offending character.
        offset: usize,
    },
    /// The label starts or ends with a hyphen.
    HyphenAtEdge,
    /// Hyphens at positions 3 and 4, the shape of an encoded (`xn--`) label.
    EncodedLabelShape,
    /// One of the [`RESERVED`] names.
    Reserved,
}

impl fmt::Display for SubdomainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("subdomain is empty"),
            Self::TooShort => write!(f, "subdomain is shorter than {MIN_LEN} characters"),
            Self::TooLong => write!(f, "subdomain is longer than {MAX_LEN} characters"),
            Self::InvalidChar { offset } => write!(
                f,
                "subdomain has a character other than a-z, 0-9 or '-' at byte {offset}"
            ),
            Self::HyphenAtEdge => f.write_str("subdomain starts or ends with '-'"),
            Self::EncodedLabelShape => {
                f.write_str("subdomain has '--' at positions 3 and 4 (reserved for xn-- labels)")
            }
            Self::Reserved => f.write_str("subdomain is reserved"),
        }
    }
}

impl std::error::Error for SubdomainError {}

impl Subdomain {
    /// Validates a label that must already be in canonical form (lowercase, no
    /// surrounding whitespace). Use [`Subdomain::parse_user_input`] for text typed
    /// by a person.
    ///
    /// # Errors
    ///
    /// Returns the first rule the label breaks, see [`SubdomainError`].
    pub fn parse(input: &str) -> Result<Self, SubdomainError> {
        if input.is_empty() {
            return Err(SubdomainError::Empty);
        }
        if input.len() > MAX_LEN {
            return Err(SubdomainError::TooLong);
        }
        if let Some((offset, _)) = input
            .char_indices()
            .find(|&(_, c)| !matches!(c, 'a'..='z' | '0'..='9' | '-'))
        {
            return Err(SubdomainError::InvalidChar { offset });
        }
        if input.len() < MIN_LEN {
            return Err(SubdomainError::TooShort);
        }
        if input.starts_with('-') || input.ends_with('-') {
            return Err(SubdomainError::HyphenAtEdge);
        }
        if input.get(2..4) == Some("--") {
            return Err(SubdomainError::EncodedLabelShape);
        }
        if RESERVED.binary_search(&input).is_ok() {
            return Err(SubdomainError::Reserved);
        }
        Ok(Self(input.to_owned()))
    }

    /// Validates a label typed by a person: surrounding ASCII whitespace is
    /// removed and ASCII letters are lowercased, nothing else is changed. Non-ASCII
    /// input is rejected rather than transliterated.
    ///
    /// # Errors
    ///
    /// As [`Subdomain::parse`].
    pub fn parse_user_input(input: &str) -> Result<Self, SubdomainError> {
        Self::parse(&input.trim_ascii().to_ascii_lowercase())
    }

    /// Builds a generated label from [`RANDOM_LEN`] bytes of a cryptographically
    /// secure source (the caller's, this crate does no I/O). Each byte picks one
    /// symbol of [`RANDOM_ALPHABET`].
    ///
    /// # Errors
    ///
    /// [`SubdomainError::Reserved`] if the bytes happen to spell a reserved name;
    /// the caller draws new bytes, as it does when the name is already taken.
    pub fn from_random_bytes(bytes: &[u8; RANDOM_LEN]) -> Result<Self, SubdomainError> {
        #[expect(
            clippy::indexing_slicing,
            reason = "b % 32 is always below RANDOM_ALPHABET.len() == 32"
        )]
        let label: String = bytes
            .iter()
            .map(|&b| char::from(RANDOM_ALPHABET[usize::from(b % 32)]))
            .collect();
        Self::parse(&label)
    }

    /// The label as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Subdomain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for Subdomain {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl FromStr for Subdomain {
    type Err = SubdomainError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_canonical_labels() {
        for ok in ["abc", "my-site", "a1b2c3", "123", "a-b-c", "x2y"] {
            assert_eq!(Subdomain::parse(ok).unwrap().as_str(), ok, "{ok}");
        }
    }

    #[test]
    fn length_bounds_are_inclusive() {
        assert_eq!(Subdomain::parse("ab"), Err(SubdomainError::TooShort));
        assert!(Subdomain::parse("abc").is_ok());
        let max = "a".repeat(MAX_LEN);
        assert!(Subdomain::parse(&max).is_ok());
        let over = "a".repeat(MAX_LEN + 1);
        assert_eq!(Subdomain::parse(&over), Err(SubdomainError::TooLong));
    }

    #[test]
    fn rejects_empty() {
        assert_eq!(Subdomain::parse(""), Err(SubdomainError::Empty));
        assert_eq!(
            Subdomain::parse_user_input("   "),
            Err(SubdomainError::Empty)
        );
    }

    #[test]
    fn reports_offset_of_first_invalid_char() {
        let cases = [
            ("Abc", 0),
            ("aBc", 1),
            ("a.b", 1),
            ("a_b", 1),
            ("ab ", 2),
            ("ab/", 2),
            ("äbc", 0),
            ("abé", 2),
            ("a\u{0430}c", 1), // Cyrillic a
            ("ab\0", 2),
            ("abc\u{200b}", 3),
        ];
        for (input, offset) in cases {
            assert_eq!(
                Subdomain::parse(input),
                Err(SubdomainError::InvalidChar { offset }),
                "{input:?}"
            );
        }
    }

    #[test]
    fn invalid_char_wins_over_too_short() {
        assert_eq!(
            Subdomain::parse("A"),
            Err(SubdomainError::InvalidChar { offset: 0 })
        );
    }

    #[test]
    fn rejects_hyphen_at_edge() {
        for bad in ["-abc", "abc-", "-ab-", "---"] {
            assert_eq!(
                Subdomain::parse(bad),
                Err(SubdomainError::HyphenAtEdge),
                "{bad}"
            );
        }
    }

    #[test]
    fn rejects_encoded_label_shape() {
        for bad in ["xn--abc", "ab--cd", "zz--", "ab--c"] {
            let got = Subdomain::parse(bad);
            assert!(
                got == Err(SubdomainError::EncodedLabelShape)
                    || got == Err(SubdomainError::HyphenAtEdge),
                "{bad}: {got:?}"
            );
        }
        assert_eq!(
            Subdomain::parse("xn--abc"),
            Err(SubdomainError::EncodedLabelShape)
        );
        // Double hyphens elsewhere are fine.
        assert!(Subdomain::parse("a--bc").is_ok());
        assert!(Subdomain::parse("abc--d").is_ok());
    }

    #[test]
    fn reserved_list_is_sorted_unique_and_otherwise_valid() {
        assert!(RESERVED.windows(2).all(|w| w[0] < w[1]));
        for name in RESERVED {
            assert_eq!(
                Subdomain::parse(name),
                Err(SubdomainError::Reserved),
                "{name}"
            );
        }
    }

    #[test]
    fn reserved_check_is_exact() {
        assert!(Subdomain::parse("www2").is_ok());
        assert!(Subdomain::parse("admins").is_ok());
        assert!(Subdomain::parse("myapp").is_ok());
    }

    #[test]
    fn user_input_is_trimmed_and_lowercased() {
        assert_eq!(
            Subdomain::parse_user_input("  My-Site\t").unwrap().as_str(),
            "my-site"
        );
        assert_eq!(
            Subdomain::parse_user_input("WWW"),
            Err(SubdomainError::Reserved)
        );
        // Only ASCII is folded: a non-ASCII letter stays and is rejected.
        assert_eq!(
            Subdomain::parse_user_input("ÄBC"),
            Err(SubdomainError::InvalidChar { offset: 0 })
        );
        // Inner whitespace is not removed.
        assert_eq!(
            Subdomain::parse_user_input("a b"),
            Err(SubdomainError::InvalidChar { offset: 1 })
        );
    }

    #[test]
    fn random_alphabet_has_32_distinct_valid_symbols() {
        let mut seen = RANDOM_ALPHABET.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), 32);
        for &b in RANDOM_ALPHABET {
            assert!(b.is_ascii_lowercase() || b.is_ascii_digit());
            assert!(!matches!(b, b'l' | b'o' | b'0' | b'1'));
        }
    }

    #[test]
    fn random_bytes_map_onto_the_alphabet() {
        let zeros = Subdomain::from_random_bytes(&[0; RANDOM_LEN]).unwrap();
        assert_eq!(zeros.as_str(), "aaaaaaaaaa");
        let bytes: [u8; RANDOM_LEN] = [0, 1, 31, 32, 33, 63, 64, 255, 128, 30];
        let label = Subdomain::from_random_bytes(&bytes).unwrap();
        assert_eq!(label.as_str(), "ab9ab9a9a8");
        assert_eq!(label.as_str().len(), RANDOM_LEN);
    }

    #[test]
    fn every_byte_value_yields_a_valid_symbol() {
        for b in 0..=u8::MAX {
            let label = Subdomain::from_random_bytes(&[b; RANDOM_LEN]).unwrap();
            let expected = char::from(RANDOM_ALPHABET[usize::from(b % 32)]);
            assert!(label.as_str().chars().all(|c| c == expected));
        }
    }

    #[test]
    fn display_and_conversions_round_trip() {
        let s: Subdomain = "my-site".parse().unwrap();
        assert_eq!(s.to_string(), "my-site");
        assert_eq!(s.as_ref(), "my-site");
        assert_eq!(
            "WWW".parse::<Subdomain>(),
            Err(SubdomainError::InvalidChar { offset: 0 })
        );
    }

    #[test]
    fn error_messages_are_specific() {
        let cases = [
            (SubdomainError::Empty, "subdomain is empty"),
            (
                SubdomainError::TooShort,
                "subdomain is shorter than 3 characters",
            ),
            (
                SubdomainError::TooLong,
                "subdomain is longer than 63 characters",
            ),
            (
                SubdomainError::InvalidChar { offset: 4 },
                "subdomain has a character other than a-z, 0-9 or '-' at byte 4",
            ),
            (
                SubdomainError::HyphenAtEdge,
                "subdomain starts or ends with '-'",
            ),
            (
                SubdomainError::EncodedLabelShape,
                "subdomain has '--' at positions 3 and 4 (reserved for xn-- labels)",
            ),
            (SubdomainError::Reserved, "subdomain is reserved"),
        ];
        for (err, msg) in cases {
            assert_eq!(err.to_string(), msg);
        }
    }
}
