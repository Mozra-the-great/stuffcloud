//! The query string of a write request (ADR 0010 decision 3: every write accepts
//! `?dry_run=true`).
//!
//! The parser is strict on purpose: a misspelt parameter (`?dryrun=true`) must not turn a
//! dry run into a real write, so every parameter other than `dry_run` is refused, as are
//! repeated parameters and values other than `true` and `false`. Parameter names and values
//! are compared byte for byte (no percent-decoding: none of the accepted forms needs it).

use std::fmt;

/// Longest query string that is parsed at all.
pub const MAX_QUERY_LEN: usize = 1024;

/// The parameters of a write request.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WriteQuery {
    /// `dry_run=true`: validate and report, change nothing.
    pub dry_run: bool,
}

/// Why a query string was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum QueryError {
    /// Longer than [`MAX_QUERY_LEN`] bytes.
    TooLong,
    /// A parameter this request does not take.
    Unknown(String),
    /// A parameter given more than once.
    Repeated(String),
    /// A value other than `true` or `false` (`None`: the parameter had no `=`).
    InvalidValue {
        /// The parameter.
        name: String,
        /// The value as sent.
        value: Option<String>,
    },
}

impl fmt::Display for QueryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLong => write!(f, "query string is longer than {MAX_QUERY_LEN} bytes"),
            Self::Unknown(name) => write!(f, "unknown query parameter {name:?}"),
            Self::Repeated(name) => write!(f, "query parameter {name:?} is given more than once"),
            Self::InvalidValue { name, value: None } => {
                write!(f, "query parameter {name:?} needs a value: true or false")
            }
            Self::InvalidValue {
                name,
                value: Some(value),
            } => write!(
                f,
                "query parameter {name:?} must be true or false, not {value:?}"
            ),
        }
    }
}

impl std::error::Error for QueryError {}

/// The longest prefix of `text` that is at most `max` bytes and ends on a character
/// boundary, so an echoed parameter cannot make a message arbitrarily long.
fn clip(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    text.get(..end).unwrap_or_default().to_owned()
}

/// Longest parameter name or value echoed in an error.
const ECHO_LEN: usize = 64;

impl WriteQuery {
    /// Parses the query string of a write request (`None`: the URL had no `?`).
    ///
    /// # Errors
    ///
    /// See [`QueryError`].
    pub fn parse(query: Option<&str>) -> Result<Self, QueryError> {
        let Some(query) = query else {
            return Ok(Self::default());
        };
        if query.len() > MAX_QUERY_LEN {
            return Err(QueryError::TooLong);
        }
        let mut dry_run = None;
        for pair in query.split('&').filter(|pair| !pair.is_empty()) {
            let (name, value) = match pair.split_once('=') {
                Some((name, value)) => (name, Some(value)),
                None => (pair, None),
            };
            if name != "dry_run" {
                return Err(QueryError::Unknown(clip(name, ECHO_LEN)));
            }
            if dry_run.is_some() {
                return Err(QueryError::Repeated(name.to_owned()));
            }
            dry_run = Some(match value {
                Some("true") => true,
                Some("false") => false,
                other => {
                    return Err(QueryError::InvalidValue {
                        name: name.to_owned(),
                        value: other.map(|value| clip(value, ECHO_LEN)),
                    });
                }
            });
        }
        Ok(Self {
            dry_run: dry_run.unwrap_or(false),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_query_and_empty_query_mean_a_real_write() {
        assert_eq!(WriteQuery::parse(None), Ok(WriteQuery { dry_run: false }));
        assert_eq!(
            WriteQuery::parse(Some("")),
            Ok(WriteQuery { dry_run: false })
        );
        assert_eq!(
            WriteQuery::parse(Some("&&")),
            Ok(WriteQuery { dry_run: false })
        );
    }

    #[test]
    fn dry_run_values() {
        assert_eq!(
            WriteQuery::parse(Some("dry_run=true")),
            Ok(WriteQuery { dry_run: true })
        );
        assert_eq!(
            WriteQuery::parse(Some("&dry_run=false&")),
            Ok(WriteQuery { dry_run: false })
        );
        for bad in ["TRUE", "1", "yes", "", "true "] {
            assert_eq!(
                WriteQuery::parse(Some(&format!("dry_run={bad}"))),
                Err(QueryError::InvalidValue {
                    name: "dry_run".to_owned(),
                    value: Some(bad.to_owned())
                }),
                "{bad:?}"
            );
        }
        assert_eq!(
            WriteQuery::parse(Some("dry_run")),
            Err(QueryError::InvalidValue {
                name: "dry_run".to_owned(),
                value: None
            })
        );
    }

    #[test]
    fn refuses_unknown_and_repeated_parameters() {
        for (query, name) in [
            ("dryrun=true", "dryrun"),
            ("dry_run=true&x=1", "x"),
            ("dry%5Frun=true", "dry%5Frun"),
            ("=true", ""),
        ] {
            assert_eq!(
                WriteQuery::parse(Some(query)),
                Err(QueryError::Unknown(name.to_owned())),
                "{query:?}"
            );
        }
        assert_eq!(
            WriteQuery::parse(Some("dry_run=false&dry_run=true")),
            Err(QueryError::Repeated("dry_run".to_owned()))
        );
    }

    #[test]
    fn length_limit() {
        let padding = "&".repeat(MAX_QUERY_LEN - "dry_run=true".len());
        let at_limit = format!("dry_run=true{padding}");
        assert_eq!(at_limit.len(), MAX_QUERY_LEN);
        assert_eq!(
            WriteQuery::parse(Some(&at_limit)),
            Ok(WriteQuery { dry_run: true })
        );
        assert_eq!(
            WriteQuery::parse(Some(&format!("{at_limit}&"))),
            Err(QueryError::TooLong)
        );
    }

    #[test]
    fn echoed_names_and_values_are_clipped() {
        let long = "ä".repeat(40);
        match WriteQuery::parse(Some(&long)) {
            Err(QueryError::Unknown(name)) => assert_eq!(name, "ä".repeat(32)),
            other => panic!("{other:?}"),
        }
        match WriteQuery::parse(Some(&format!("dry_run={}", "x".repeat(100)))) {
            Err(QueryError::InvalidValue {
                value: Some(value), ..
            }) => assert_eq!(value, "x".repeat(ECHO_LEN)),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn clip_cuts_on_character_boundaries() {
        assert_eq!(clip("abc", 2), "ab");
        assert_eq!(clip("abc", 3), "abc");
        assert_eq!(clip("abc", 10), "abc");
        assert_eq!(clip("aä", 2), "a");
        assert_eq!(clip("aä", 3), "aä");
        assert_eq!(clip("ä", 0), "");
    }

    #[test]
    fn error_messages() {
        assert_eq!(
            QueryError::TooLong.to_string(),
            "query string is longer than 1024 bytes"
        );
        assert_eq!(
            QueryError::Unknown("x".to_owned()).to_string(),
            "unknown query parameter \"x\""
        );
        assert_eq!(
            QueryError::Repeated("dry_run".to_owned()).to_string(),
            "query parameter \"dry_run\" is given more than once"
        );
        assert_eq!(
            QueryError::InvalidValue {
                name: "dry_run".to_owned(),
                value: None
            }
            .to_string(),
            "query parameter \"dry_run\" needs a value: true or false"
        );
        assert_eq!(
            QueryError::InvalidValue {
                name: "dry_run".to_owned(),
                value: Some("1".to_owned())
            }
            .to_string(),
            "query parameter \"dry_run\" must be true or false, not \"1\""
        );
    }
}
