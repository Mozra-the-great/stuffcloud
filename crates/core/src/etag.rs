//! Entity tags and the `If-Match` / `If-None-Match` preconditions (RFC 9110, sections
//! 8.8.3 and 13.1; ADR 0010 decision 3).
//!
//! Every resource of the API has a strong entity tag. A client sends it back in `If-Match`
//! to say "only if nobody changed it since I read it", or sends `If-None-Match: *` to say
//! "only if it does not exist yet". Both headers are untrusted input, so the parser is
//! strict, bounded and fuzzed:
//!
//! - a header value is either `*` or a comma-separated list of entity tags
//!   (`"abc"`, `W/"abc"`), with optional spaces and tabs around the commas;
//! - the opaque part between the quotes uses only the characters RFC 9110 allows
//!   (`!` and `#` to `~`, no space, no quote, no control and no non-ASCII character);
//! - at most [`MAX_HEADER_LEN`] bytes and [`MAX_TAGS`] tags.
//!
//! `If-Match` compares strongly (a weak tag never matches), `If-None-Match` weakly, as
//! RFC 9110 prescribes.

use std::fmt;

/// Longest header value that is parsed at all.
pub const MAX_HEADER_LEN: usize = 4096;

/// Most entity tags one header may list.
pub const MAX_TAGS: usize = 64;

/// An entity tag: its opaque value (without the quotes) and whether it is weak.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EntityTag {
    weak: bool,
    opaque: String,
}

/// Why a header value or an opaque tag value was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum EtagError {
    /// The value lists no entity tag.
    Empty,
    /// The value is longer than [`MAX_HEADER_LEN`] bytes.
    TooLong,
    /// The value lists more than [`MAX_TAGS`] entity tags.
    TooManyTags,
    /// The value is not an entity tag list; the byte offset of the first problem.
    Malformed {
        /// Byte offset in the header value where parsing stopped.
        offset: usize,
    },
}

impl fmt::Display for EtagError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("no entity tag given"),
            Self::TooLong => write!(f, "header value is longer than {MAX_HEADER_LEN} bytes"),
            Self::TooManyTags => write!(f, "more than {MAX_TAGS} entity tags"),
            Self::Malformed { offset } => {
                write!(f, "not a valid entity tag list (at byte {offset})")
            }
        }
    }
}

impl std::error::Error for EtagError {}

/// Characters allowed in the opaque part of an entity tag (`etagc` of RFC 9110 without
/// `obs-text`).
const fn is_etagc(c: char) -> bool {
    matches!(c, '!' | '#'..='~')
}

/// Optional whitespace (`OWS`) of RFC 9110.
const fn is_ows(c: char) -> bool {
    matches!(c, ' ' | '\t')
}

/// Byte offset of `rest` inside `whole`, where `rest` is a suffix of `whole`.
fn offset_in(whole: &str, rest: &str) -> usize {
    whole.len().saturating_sub(rest.len())
}

impl EntityTag {
    /// A strong entity tag with the given opaque value (without quotes).
    ///
    /// # Errors
    ///
    /// [`EtagError::Empty`] for an empty value, [`EtagError::TooLong`] above
    /// [`MAX_HEADER_LEN`] bytes, [`EtagError::Malformed`] at the first character that is not
    /// allowed between the quotes.
    pub fn strong(opaque: &str) -> Result<Self, EtagError> {
        if opaque.is_empty() {
            return Err(EtagError::Empty);
        }
        if opaque.len() > MAX_HEADER_LEN {
            return Err(EtagError::TooLong);
        }
        if let Some((offset, _)) = opaque.char_indices().find(|&(_, c)| !is_etagc(c)) {
            return Err(EtagError::Malformed { offset });
        }
        Ok(Self {
            weak: false,
            opaque: opaque.to_owned(),
        })
    }

    /// Whether the tag is weak (`W/"…"`).
    #[must_use]
    pub const fn is_weak(&self) -> bool {
        self.weak
    }

    /// The opaque value, without quotes and without the `W/` prefix.
    #[must_use]
    pub fn opaque(&self) -> &str {
        &self.opaque
    }

    /// Strong comparison (RFC 9110, 8.8.3.2): both tags strong and the values equal.
    #[must_use]
    pub fn strong_eq(&self, other: &Self) -> bool {
        !self.weak && !other.weak && self.opaque == other.opaque
    }

    /// Weak comparison (RFC 9110, 8.8.3.2): the values equal, weakness ignored.
    #[must_use]
    pub fn weak_eq(&self, other: &Self) -> bool {
        self.opaque == other.opaque
    }
}

impl fmt::Display for EntityTag {
    /// The header form: `"abc"` or `W/"abc"`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.weak {
            f.write_str("W/")?;
        }
        write!(f, "\"{}\"", self.opaque)
    }
}

/// The value of an `If-Match` or `If-None-Match` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Condition {
    /// `*`: any current representation.
    Any,
    /// A non-empty list of entity tags, in the order given.
    Tags(Vec<EntityTag>),
}

impl Condition {
    /// Parses a header value.
    ///
    /// # Errors
    ///
    /// See [`EtagError`]; `Malformed` carries the byte offset of the first problem.
    pub fn parse(header: &str) -> Result<Self, EtagError> {
        if header.len() > MAX_HEADER_LEN {
            return Err(EtagError::TooLong);
        }
        if header.trim_matches(is_ows) == "*" {
            return Ok(Self::Any);
        }
        let mut tags = Vec::new();
        let mut rest = header;
        loop {
            rest = rest.trim_start_matches(|c| is_ows(c) || c == ',');
            if rest.is_empty() {
                break;
            }
            let (weak, quoted) = match rest.strip_prefix("W/") {
                Some(after) => (true, after),
                None => (false, rest),
            };
            let Some(body) = quoted.strip_prefix('"') else {
                return Err(EtagError::Malformed {
                    offset: offset_in(header, quoted),
                });
            };
            let Some((opaque, after)) = body.split_once('"') else {
                return Err(EtagError::Malformed {
                    offset: header.len(),
                });
            };
            if let Some((index, _)) = opaque.char_indices().find(|&(_, c)| !is_etagc(c)) {
                return Err(EtagError::Malformed {
                    offset: offset_in(header, body).saturating_add(index),
                });
            }
            if tags.len() == MAX_TAGS {
                return Err(EtagError::TooManyTags);
            }
            tags.push(EntityTag {
                weak,
                opaque: opaque.to_owned(),
            });
            let after = after.trim_start_matches(is_ows);
            if !(after.is_empty() || after.starts_with(',')) {
                return Err(EtagError::Malformed {
                    offset: offset_in(header, after),
                });
            }
            rest = after;
        }
        if tags.is_empty() {
            Err(EtagError::Empty)
        } else {
            Ok(Self::Tags(tags))
        }
    }

    /// Evaluates the condition as `If-Match` (RFC 9110, 13.1.1) against the current tag of
    /// the resource (`None`: the resource does not exist). `true` means the request may go
    /// ahead.
    #[must_use]
    pub fn if_match(&self, current: Option<&EntityTag>) -> bool {
        match (self, current) {
            (_, None) => false,
            (Self::Any, Some(_)) => true,
            (Self::Tags(tags), Some(current)) => tags.iter().any(|tag| tag.strong_eq(current)),
        }
    }

    /// Evaluates the condition as `If-None-Match` (RFC 9110, 13.1.2) for a state-changing
    /// request. `true` means the request may go ahead.
    #[must_use]
    pub fn if_none_match(&self, current: Option<&EntityTag>) -> bool {
        match (self, current) {
            (_, None) => true,
            (Self::Any, Some(_)) => false,
            (Self::Tags(tags), Some(current)) => !tags.iter().any(|tag| tag.weak_eq(current)),
        }
    }
}

impl fmt::Display for Condition {
    /// The header form; parsing it again gives the same condition.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Any => f.write_str("*"),
            Self::Tags(tags) => {
                for (index, tag) in tags.iter().enumerate() {
                    if index > 0 {
                        f.write_str(", ")?;
                    }
                    write!(f, "{tag}")?;
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strong(opaque: &str) -> EntityTag {
        EntityTag::strong(opaque).unwrap()
    }

    fn weak(opaque: &str) -> EntityTag {
        EntityTag {
            weak: true,
            opaque: opaque.to_owned(),
        }
    }

    #[test]
    fn strong_tag_accepts_every_allowed_character_and_nothing_else() {
        let all: String = ('!'..='~').filter(|&c| c != '"').collect();
        let tag = strong(&all);
        assert_eq!(tag.opaque(), all);
        assert!(!tag.is_weak());
        for bad in [' ', '"', '\t', '\u{7f}', '\u{80}', 'ä', '\0'] {
            let value = format!("ab{bad}c");
            assert_eq!(
                EntityTag::strong(&value),
                Err(EtagError::Malformed { offset: 2 }),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn strong_tag_length_limits() {
        assert_eq!(EntityTag::strong(""), Err(EtagError::Empty));
        assert!(EntityTag::strong("a").is_ok());
        assert!(EntityTag::strong(&"a".repeat(MAX_HEADER_LEN)).is_ok());
        assert_eq!(
            EntityTag::strong(&"a".repeat(MAX_HEADER_LEN + 1)),
            Err(EtagError::TooLong)
        );
    }

    #[test]
    fn display_of_tags() {
        assert_eq!(strong("abc").to_string(), "\"abc\"");
        assert_eq!(weak("abc").to_string(), "W/\"abc\"");
    }

    #[test]
    fn comparisons_follow_rfc_9110() {
        // The table of RFC 9110, section 8.8.3.2.
        assert!(!weak("1").strong_eq(&weak("1")));
        assert!(weak("1").weak_eq(&weak("1")));
        assert!(!weak("1").strong_eq(&weak("2")));
        assert!(!weak("1").weak_eq(&weak("2")));
        assert!(!weak("1").strong_eq(&strong("1")));
        assert!(!strong("1").strong_eq(&weak("1")));
        assert!(weak("1").weak_eq(&strong("1")));
        assert!(strong("1").strong_eq(&strong("1")));
        assert!(strong("1").weak_eq(&strong("1")));
        assert!(!strong("1").strong_eq(&strong("2")));
    }

    #[test]
    fn parses_star_with_and_without_whitespace() {
        assert_eq!(Condition::parse("*"), Ok(Condition::Any));
        assert_eq!(Condition::parse(" \t* \t"), Ok(Condition::Any));
    }

    #[test]
    fn parses_lists() {
        assert_eq!(
            Condition::parse("\"a\""),
            Ok(Condition::Tags(vec![strong("a")]))
        );
        assert_eq!(
            Condition::parse(" W/\"a\" ,\t\"b,c\" , , \"d\" "),
            Ok(Condition::Tags(vec![weak("a"), strong("b,c"), strong("d")]))
        );
        assert_eq!(
            Condition::parse(",\"a\","),
            Ok(Condition::Tags(vec![strong("a")]))
        );
        // An empty opaque value is a valid entity tag in a header.
        assert_eq!(
            Condition::parse("\"\""),
            Ok(Condition::Tags(vec![EntityTag {
                weak: false,
                opaque: String::new()
            }]))
        );
    }

    #[test]
    fn refuses_empty_lists() {
        for value in ["", " ", ",", " , ,\t"] {
            assert_eq!(Condition::parse(value), Err(EtagError::Empty), "{value:?}");
        }
    }

    #[test]
    fn refuses_malformed_values_at_the_right_offset() {
        let cases: [(&str, usize); 11] = [
            ("abc", 0),
            ("\"abc", 4),
            ("\"a\" \"b\"", 4),
            ("\"a\"x", 3),
            ("*, \"a\"", 0),
            ("\"a\", *", 5),
            ("w/\"a\"", 0),
            ("W/a", 2),
            ("\"a b\"", 2),
            ("\"a\", \"b\u{7f}\"", 7),
            ("W/ \"a\"", 2),
        ];
        for (value, offset) in cases {
            assert_eq!(
                Condition::parse(value),
                Err(EtagError::Malformed { offset }),
                "{value:?}"
            );
        }
    }

    #[test]
    fn header_length_limit() {
        let tag = format!("\"{}\"", "a".repeat(MAX_HEADER_LEN - 2));
        assert_eq!(tag.len(), MAX_HEADER_LEN);
        assert!(Condition::parse(&tag).is_ok());
        let long = format!("\"{}\"", "a".repeat(MAX_HEADER_LEN - 1));
        assert_eq!(Condition::parse(&long), Err(EtagError::TooLong));
        assert_eq!(
            Condition::parse(&format!("*{}", " ".repeat(MAX_HEADER_LEN))),
            Err(EtagError::TooLong)
        );
    }

    #[test]
    fn tag_count_limit() {
        let list = |n: usize| vec!["\"a\""; n].join(",");
        match Condition::parse(&list(MAX_TAGS)) {
            Ok(Condition::Tags(tags)) => assert_eq!(tags.len(), MAX_TAGS),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            Condition::parse(&list(MAX_TAGS + 1)),
            Err(EtagError::TooManyTags)
        );
    }

    #[test]
    fn if_match_evaluation() {
        let current = strong("v1");
        assert!(Condition::Any.if_match(Some(&current)));
        assert!(!Condition::Any.if_match(None));
        let list = Condition::Tags(vec![strong("v0"), strong("v1")]);
        assert!(list.if_match(Some(&current)));
        assert!(!list.if_match(None));
        assert!(!Condition::Tags(vec![strong("v0")]).if_match(Some(&current)));
        assert!(!Condition::Tags(vec![weak("v1")]).if_match(Some(&current)));
    }

    #[test]
    fn if_none_match_evaluation() {
        let current = strong("v1");
        assert!(!Condition::Any.if_none_match(Some(&current)));
        assert!(Condition::Any.if_none_match(None));
        assert!(Condition::Tags(vec![strong("v0")]).if_none_match(Some(&current)));
        assert!(Condition::Tags(vec![strong("v0")]).if_none_match(None));
        assert!(!Condition::Tags(vec![strong("v0"), strong("v1")]).if_none_match(Some(&current)));
        assert!(!Condition::Tags(vec![weak("v1")]).if_none_match(Some(&current)));
    }

    #[test]
    fn display_round_trips() {
        for value in ["*", "\"a\"", "W/\"a\", \"b\"", "\"\", W/\"x,y\""] {
            let parsed = Condition::parse(value).unwrap();
            assert_eq!(parsed.to_string(), value);
            assert_eq!(Condition::parse(&parsed.to_string()), Ok(parsed));
        }
    }

    #[test]
    fn error_messages() {
        assert_eq!(EtagError::Empty.to_string(), "no entity tag given");
        assert_eq!(
            EtagError::TooLong.to_string(),
            "header value is longer than 4096 bytes"
        );
        assert_eq!(
            EtagError::TooManyTags.to_string(),
            "more than 64 entity tags"
        );
        assert_eq!(
            EtagError::Malformed { offset: 7 }.to_string(),
            "not a valid entity tag list (at byte 7)"
        );
    }
}
