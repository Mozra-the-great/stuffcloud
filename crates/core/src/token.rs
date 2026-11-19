//! Opaque secret tokens: session IDs and CSRF tokens (A-02, ADR 0005 addendum).
//!
//! A token is 32 random bytes (256 bits). Its only text form is 64 lowercase hex digits, so
//! every token has exactly one spelling and a lookup by its hash cannot be confused by case.
//! This crate does no I/O, so it never creates a token: the `app` crate fills the bytes from
//! the operating system's random source and wraps them with [`Token::from_bytes`]. The
//! database stores only a hash of a token, never the token itself.
//!
//! `Debug` of a [`Token`] is redacted; [`Token::to_hex`] is the one way to see the value, used
//! where it goes into a cookie or a response.

use std::fmt;

/// Length of a token in bytes.
pub const TOKEN_BYTES: usize = 32;

/// Length of the text form of a token: two hex digits per byte.
pub const TOKEN_HEX_LEN: usize = 64;

/// A secret token of [`TOKEN_BYTES`] bytes.
#[derive(Clone, PartialEq, Eq)]
pub struct Token([u8; TOKEN_BYTES]);

/// Why a text is not a token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum TokenError {
    /// The text is not [`TOKEN_HEX_LEN`] bytes long.
    WrongLength(usize),
    /// The byte at this position is not a lowercase hex digit.
    InvalidCharacter(usize),
}

impl fmt::Display for TokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The token itself is never part of the message.
        match self {
            Self::WrongLength(length) => {
                write!(f, "a token has {TOKEN_HEX_LEN} characters, not {length}")
            }
            Self::InvalidCharacter(index) => {
                write!(
                    f,
                    "character {index} of the token is not a lowercase hex digit"
                )
            }
        }
    }
}

impl std::error::Error for TokenError {}

/// The value of one lowercase hex digit.
fn nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte.wrapping_sub(b'0')),
        b'a'..=b'f' => Some(byte.wrapping_sub(b'a').wrapping_add(10)),
        _ => None,
    }
}

impl Token {
    /// Wraps random bytes. The caller is responsible for the randomness.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; TOKEN_BYTES]) -> Self {
        Self(bytes)
    }

    /// Parses the text form: exactly [`TOKEN_HEX_LEN`] lowercase hex digits.
    ///
    /// # Errors
    ///
    /// [`TokenError::WrongLength`] or [`TokenError::InvalidCharacter`] (the first bad byte).
    pub fn parse(text: &[u8]) -> Result<Self, TokenError> {
        if text.len() != TOKEN_HEX_LEN {
            return Err(TokenError::WrongLength(text.len()));
        }
        let mut bytes = [0_u8; TOKEN_BYTES];
        for ((index, pair), slot) in (0_usize..)
            .step_by(2)
            .zip(text.chunks_exact(2))
            .zip(bytes.iter_mut())
        {
            let [high, low] = pair else {
                return Err(TokenError::WrongLength(text.len()));
            };
            let high = nibble(*high).ok_or(TokenError::InvalidCharacter(index))?;
            let low = nibble(*low).ok_or(TokenError::InvalidCharacter(index.wrapping_add(1)))?;
            *slot = (high << 4) | low;
        }
        Ok(Self(bytes))
    }

    /// The text form (64 lowercase hex digits). This exposes the secret.
    #[must_use]
    pub fn to_hex(&self) -> String {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(TOKEN_HEX_LEN);
        for byte in self.0 {
            for nibble in [byte >> 4, byte & 0x0f] {
                out.push(char::from(
                    *DIGITS.get(usize::from(nibble)).unwrap_or(&b'0'),
                ));
            }
        }
        out
    }

    /// The raw bytes (for hashing).
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; TOKEN_BYTES] {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

/// Compares two byte strings in time that depends only on their lengths, not on where they
/// differ. Used for secrets (CSRF tokens, token hashes); the lengths of those are public.
#[must_use]
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let difference = left
        .iter()
        .zip(right)
        .fold(0_u8, |acc, (a, b)| acc | (a ^ b));
    std::hint::black_box(difference) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn counting() -> Token {
        let mut bytes = [0_u8; TOKEN_BYTES];
        for (value, slot) in (0_u8..).zip(bytes.iter_mut()) {
            *slot = value;
        }
        Token::from_bytes(bytes)
    }

    #[test]
    fn round_trip() {
        let token = counting();
        assert_eq!(token.to_hex(), HEX);
        assert_eq!(Token::parse(HEX.as_bytes()).unwrap(), token);
        assert_eq!(token.as_bytes()[31], 31);
        let all_ff = Token::from_bytes([0xff; TOKEN_BYTES]);
        assert_eq!(all_ff.to_hex(), "f".repeat(64));
        assert_eq!(Token::parse("f".repeat(64).as_bytes()).unwrap(), all_ff);
        let nines = "9".repeat(64);
        assert_eq!(
            Token::parse(nines.as_bytes()).unwrap().as_bytes(),
            &[0x99; TOKEN_BYTES]
        );
        let as_ = "a".repeat(64);
        assert_eq!(
            Token::parse(as_.as_bytes()).unwrap().as_bytes(),
            &[0xaa; TOKEN_BYTES]
        );
    }

    #[test]
    fn length_is_exact() {
        assert_eq!(
            Token::parse(&HEX.as_bytes()[..63]),
            Err(TokenError::WrongLength(63))
        );
        let long = format!("{HEX}0");
        assert_eq!(
            Token::parse(long.as_bytes()),
            Err(TokenError::WrongLength(65))
        );
        assert_eq!(Token::parse(b""), Err(TokenError::WrongLength(0)));
    }

    #[test]
    fn only_lowercase_hex() {
        for (index, bad) in [
            (0, 'A'),
            (1, 'F'),
            (10, 'g'),
            (63, 'G'),
            (62, ' '),
            (5, '/'),
        ] {
            let mut text: Vec<u8> = HEX.as_bytes().to_vec();
            text[index] = u8::try_from(u32::from(bad)).unwrap();
            assert_eq!(
                Token::parse(&text),
                Err(TokenError::InvalidCharacter(index)),
                "{bad:?} at {index}"
            );
        }
        // Digits and letters just outside the ranges.
        for bad in *b"/:`g" {
            let text = [bad; TOKEN_HEX_LEN];
            assert_eq!(Token::parse(&text), Err(TokenError::InvalidCharacter(0)));
        }
        let mut text = [b'0'; TOKEN_HEX_LEN];
        text[1] = b':';
        assert_eq!(Token::parse(&text), Err(TokenError::InvalidCharacter(1)));
    }

    #[test]
    fn messages_never_contain_the_token() {
        assert_eq!(
            TokenError::WrongLength(3).to_string(),
            "a token has 64 characters, not 3"
        );
        assert_eq!(
            TokenError::InvalidCharacter(7).to_string(),
            "character 7 of the token is not a lowercase hex digit"
        );
        assert_eq!(format!("{:?}", counting()), "Token(<redacted>)");
    }

    #[test]
    fn constant_time_comparison() {
        assert!(constant_time_eq(b"", b""));
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"bbc"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"ab", b"abc"));
        assert!(!constant_time_eq(&[0x80], &[0x00]));
        assert!(!constant_time_eq(&[0x01], &[0x00]));
        // Two differences that cancel out under XOR alone must still differ.
        assert!(!constant_time_eq(&[1, 1], &[0, 0]));
    }
}
