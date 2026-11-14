//! Relative paths of files inside a hosted site (docs/SPEC.md, section 8.1).
//!
//! Every file name that arrives with an upload (browser folder upload, CLI deploy,
//! ZIP entry) goes through [`SafeRelPath::parse`] before anything touches the disk.
//! A [`SafeRelPath`] can be joined onto the site's directory without leaving it,
//! and it can be written to and served from any common file system without being
//! aliased to another name.
//!
//! What it accepts, stricter than any file system on purpose:
//! - `/`-separated, relative, at most [`MAX_DEPTH`] components, at most
//!   [`MAX_PATH_BYTES`] bytes before and after normalisation, at most
//!   [`MAX_COMPONENT_BYTES`] bytes per component.
//! - Unicode in NFC: the result is normalised, so a macOS (NFD) upload and a
//!   browser request for the same name agree, and two visually identical names in
//!   different normal forms cannot both exist.
//!
//! What it rejects:
//! - Absolute paths, empty components (`a//b`, trailing `/`), `.` and `..`.
//! - Hidden components (leading `.`): `.well-known` would let a site answer ACME
//!   HTTP-01 challenges for its own subdomain, `.git` or `.env` are never meant to
//!   be published.
//! - Backslashes and the characters Windows forbids (`< > : " | ? *`), so an
//!   export unpacked on Windows cannot turn into a different path or a stream.
//! - Control characters, invisible and bidirectional formatting characters, and
//!   whitespace other than the ASCII space: they make one name look like another.
//! - Components that start with a space or end with a space or `.` (Windows strips
//!   them, which aliases names), and Windows device names (`CON`, `nul.txt`, ...).
//!
//! Symlinks cannot be expressed in a path string; the unpacker refuses link entries
//! itself.

use std::fmt;
use std::str::FromStr;

use unicode_normalization::UnicodeNormalization;

/// Longest accepted path in bytes, checked on the input and on its NFC form.
pub const MAX_PATH_BYTES: usize = 1024;

/// Longest accepted component in bytes (the usual file-system limit).
pub const MAX_COMPONENT_BYTES: usize = 255;

/// Most components a path may have.
pub const MAX_DEPTH: usize = 32;

/// Characters that are never allowed, besides control and invisible characters.
const FORBIDDEN: &[char] = &['\\', '<', '>', ':', '"', '|', '?', '*'];

/// Windows device names, matched case-insensitively against the part of a
/// component before its first `.` (trailing spaces removed). Windows treats the
/// superscript digits as device numbers too.
const WINDOWS_DEVICES: &[&str] = &[
    "aux", "clock$", "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "com¹", "com²", "com³", "con", "conin$", "conout$", "lpt0", "lpt1", "lpt2", "lpt3",
    "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9", "lpt¹", "lpt²", "lpt³", "nul", "prn",
];

/// A validated, normalised relative path of a file inside a site.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SafeRelPath(String);

/// Why a path is not a valid [`SafeRelPath`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum PathError {
    /// The path is empty.
    Empty,
    /// More than [`MAX_PATH_BYTES`] bytes, before or after normalisation.
    TooLong,
    /// More than [`MAX_DEPTH`] components.
    TooDeep,
    /// The path starts with `/`.
    Absolute,
    /// A forbidden character such as `\`, `:` or `*`.
    ForbiddenChar(char),
    /// A control character (C0, DEL, C1).
    ControlChar,
    /// An invisible, formatting or non-ASCII whitespace character.
    InvisibleChar(char),
    /// An empty component: `//` or a trailing `/`.
    EmptyComponent,
    /// A `.` or `..` component.
    DotComponent,
    /// A component starting with `.`.
    HiddenComponent,
    /// A component longer than [`MAX_COMPONENT_BYTES`] bytes.
    ComponentTooLong,
    /// A component starting with a space or ending with a space or `.`.
    ComponentEdge,
    /// A Windows device name such as `CON` or `nul.txt`.
    WindowsDeviceName,
}

impl fmt::Display for PathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("path is empty"),
            Self::TooLong => write!(f, "path is longer than {MAX_PATH_BYTES} bytes"),
            Self::TooDeep => write!(f, "path has more than {MAX_DEPTH} components"),
            Self::Absolute => f.write_str("path is absolute"),
            Self::ForbiddenChar(c) => write!(f, "path contains the forbidden character {c:?}"),
            Self::ControlChar => f.write_str("path contains a control character"),
            Self::InvisibleChar(c) => write!(
                f,
                "path contains the invisible character U+{:04X}",
                u32::from(*c)
            ),
            Self::EmptyComponent => f.write_str("path has an empty component"),
            Self::DotComponent => f.write_str("path has a '.' or '..' component"),
            Self::HiddenComponent => f.write_str("path has a component starting with '.'"),
            Self::ComponentTooLong => write!(
                f,
                "path has a component longer than {MAX_COMPONENT_BYTES} bytes"
            ),
            Self::ComponentEdge => f.write_str(
                "path has a component starting with a space or ending with a space or '.'",
            ),
            Self::WindowsDeviceName => f.write_str("path has a Windows device name component"),
        }
    }
}

impl std::error::Error for PathError {}

/// Invisible and formatting characters, plus whitespace other than U+0020, that
/// would let one name pass for another. Control characters are checked separately.
fn is_invisible(c: char) -> bool {
    (c.is_whitespace() && c != ' ')
        || matches!(
            c,
            '\u{00AD}'
                | '\u{034F}'
                | '\u{061C}'
                | '\u{115F}'..='\u{1160}'
                | '\u{17B4}'..='\u{17B5}'
                | '\u{180B}'..='\u{180F}'
                | '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{3164}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{FEFF}'
                | '\u{FFA0}'
                | '\u{FFF0}'..='\u{FFFB}'
                | '\u{1D173}'..='\u{1D17A}'
                | '\u{E0000}'..='\u{E0FFF}'
        )
}

fn is_windows_device(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .trim_end_matches(' ');
    let stem = stem.to_lowercase();
    WINDOWS_DEVICES.contains(&stem.as_str())
}

fn check_component(component: &str) -> Result<(), PathError> {
    if component.is_empty() {
        return Err(PathError::EmptyComponent);
    }
    if component == "." || component == ".." {
        return Err(PathError::DotComponent);
    }
    if component.starts_with('.') {
        return Err(PathError::HiddenComponent);
    }
    if component.len() > MAX_COMPONENT_BYTES {
        return Err(PathError::ComponentTooLong);
    }
    if component.starts_with(' ') || component.ends_with(' ') || component.ends_with('.') {
        return Err(PathError::ComponentEdge);
    }
    if is_windows_device(component) {
        return Err(PathError::WindowsDeviceName);
    }
    Ok(())
}

impl SafeRelPath {
    /// Validates and normalises (NFC) a relative file path.
    ///
    /// # Errors
    ///
    /// Returns the first rule the path breaks, see [`PathError`]. Character rules
    /// are checked before component rules, so `a\..\b` reports the backslash.
    pub fn parse(input: &str) -> Result<Self, PathError> {
        if input.is_empty() {
            return Err(PathError::Empty);
        }
        // Checked before normalising, so an oversized input costs nothing, and
        // again after it, because NFC can make a string longer.
        if input.len() > MAX_PATH_BYTES {
            return Err(PathError::TooLong);
        }
        let normalised: String = input.nfc().collect();
        if normalised.len() > MAX_PATH_BYTES {
            return Err(PathError::TooLong);
        }
        if normalised.starts_with('/') {
            return Err(PathError::Absolute);
        }
        for c in normalised.chars() {
            if c.is_control() {
                return Err(PathError::ControlChar);
            }
            if FORBIDDEN.contains(&c) {
                return Err(PathError::ForbiddenChar(c));
            }
            if is_invisible(c) {
                return Err(PathError::InvisibleChar(c));
            }
        }
        let mut depth: usize = 0;
        for component in normalised.split('/') {
            depth = depth.saturating_add(1);
            if depth > MAX_DEPTH {
                return Err(PathError::TooDeep);
            }
            check_component(component)?;
        }
        Ok(Self(normalised))
    }

    /// The path as text, components separated by `/`.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The components of the path, in order; never empty, never `.` or `..`.
    pub fn components(&self) -> impl Iterator<Item = &str> {
        self.0.split('/')
    }

    /// The last component (the file name).
    #[must_use]
    pub fn file_name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or(&self.0)
    }
}

impl fmt::Display for SafeRelPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for SafeRelPath {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl FromStr for SafeRelPath {
    type Err = PathError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(input: &str) -> PathError {
        SafeRelPath::parse(input).unwrap_err()
    }

    #[test]
    fn accepts_ordinary_paths() {
        for ok in [
            "index.html",
            "css/site.css",
            "a/b/c/d.txt",
            "Bilder/Urlaub 2026/strand.jpg",
            "über.html",
            "日本語/ファイル.txt",
            "file.tar.gz",
            "no-extension",
            "x",
            "a b",
            "%2e%2e",
            "#anchor.html",
            "con-tact.html",
            "console.log",
            "com10.txt",
        ] {
            assert_eq!(SafeRelPath::parse(ok).unwrap().as_str(), ok, "{ok}");
        }
    }

    #[test]
    fn normalises_to_nfc() {
        let p = SafeRelPath::parse("cafe\u{301}.html").unwrap();
        assert_eq!(p.as_str(), "caf\u{e9}.html");
    }

    #[test]
    fn rejects_empty() {
        assert_eq!(err(""), PathError::Empty);
    }

    #[test]
    fn rejects_absolute_and_traversal() {
        assert_eq!(err("/etc/passwd"), PathError::Absolute);
        assert_eq!(err("//server/share"), PathError::Absolute);
        assert_eq!(err(".."), PathError::DotComponent);
        assert_eq!(err("../x"), PathError::DotComponent);
        assert_eq!(err("a/../../x"), PathError::DotComponent);
        assert_eq!(err("a/./b"), PathError::DotComponent);
        assert_eq!(err("."), PathError::DotComponent);
        assert_eq!(err("a/.."), PathError::DotComponent);
    }

    #[test]
    fn rejects_empty_components() {
        assert_eq!(err("a//b"), PathError::EmptyComponent);
        assert_eq!(err("a/"), PathError::EmptyComponent);
        assert_eq!(err("a/b/"), PathError::EmptyComponent);
    }

    #[test]
    fn rejects_hidden_components() {
        for bad in [
            ".env",
            ".git/config",
            ".well-known/acme-challenge/x",
            "a/.htaccess",
            "...",
        ] {
            assert_eq!(err(bad), PathError::HiddenComponent, "{bad}");
        }
    }

    #[test]
    fn rejects_forbidden_chars() {
        for c in ['\\', '<', '>', ':', '"', '|', '?', '*'] {
            let input = format!("a{c}b");
            assert_eq!(err(&input), PathError::ForbiddenChar(c), "{input}");
        }
        assert_eq!(err("..\\..\\x"), PathError::ForbiddenChar('\\'));
        assert_eq!(err("C:/x"), PathError::ForbiddenChar(':'));
        assert_eq!(err("file.txt::$DATA"), PathError::ForbiddenChar(':'));
    }

    #[test]
    fn rejects_control_chars() {
        for c in [
            '\0', '\u{1}', '\t', '\n', '\r', '\u{1b}', '\u{7f}', '\u{80}', '\u{9f}',
        ] {
            let input = format!("a{c}b");
            assert_eq!(err(&input), PathError::ControlChar, "{input:?}");
        }
    }

    #[test]
    fn rejects_invisible_chars() {
        for c in [
            '\u{a0}',
            '\u{ad}',
            '\u{34f}',
            '\u{61c}',
            '\u{115f}',
            '\u{1160}',
            '\u{17b4}',
            '\u{17b5}',
            '\u{180b}',
            '\u{180e}',
            '\u{180f}',
            '\u{2002}',
            '\u{200a}',
            '\u{200b}',
            '\u{200d}',
            '\u{200e}',
            '\u{200f}',
            '\u{2028}',
            '\u{2029}',
            '\u{202a}',
            '\u{202e}',
            '\u{202f}',
            '\u{205f}',
            '\u{2060}',
            '\u{2066}',
            '\u{2069}',
            '\u{206f}',
            '\u{3000}',
            '\u{3164}',
            '\u{fe00}',
            '\u{fe0f}',
            '\u{feff}',
            '\u{ffa0}',
            '\u{fff0}',
            '\u{fff9}',
            '\u{fffb}',
            '\u{1d173}',
            '\u{1d17a}',
            '\u{e0000}',
            '\u{e0001}',
            '\u{e007f}',
            '\u{e0100}',
            '\u{e0fff}',
        ] {
            let input = format!("a{c}b");
            assert_eq!(
                err(&input),
                PathError::InvisibleChar(c),
                "U+{:04X}",
                u32::from(c)
            );
        }
        // Checked after NFC, so the error names the normalised character: U+2000
        // (en quad) normalises to U+2002 (en space).
        assert_eq!(err("a\u{2000}b"), PathError::InvisibleChar('\u{2002}'));
    }

    #[test]
    fn invisible_ranges_end_where_they_should() {
        // Neighbours of the ranges above are ordinary characters.
        for ok in [
            '\u{ac}',
            '\u{ae}',
            '\u{17b3}',
            '\u{17b6}',
            '\u{2010}',
            '\u{2027}',
            '\u{2070}',
            '\u{fdff}',
            '\u{fe10}',
            '\u{fffc}',
            '\u{1d172}',
            '\u{1d17b}',
            '\u{f0000}',
        ] {
            assert!(!is_invisible(ok), "U+{:04X}", u32::from(ok));
        }
        assert!(!is_invisible(' '));
        assert!(!is_invisible('a'));
    }

    #[test]
    fn character_rules_win_over_component_rules() {
        assert_eq!(err("a\\../b"), PathError::ForbiddenChar('\\'));
        assert_eq!(err("../\0"), PathError::ControlChar);
    }

    #[test]
    fn rejects_component_edges() {
        for bad in [" a", "a ", "a.", "dir./x", "x/dir ", "a. ", "a /b"] {
            assert_eq!(err(bad), PathError::ComponentEdge, "{bad:?}");
        }
    }

    #[test]
    fn rejects_windows_device_names() {
        for bad in [
            "CON",
            "con",
            "Con.txt",
            "nul",
            "NUL.tar.gz",
            "aux.html",
            "prn",
            "com1",
            "COM9.log",
            "lpt1",
            "lpt9.txt",
            "com0",
            "lpt0",
            "com\u{b9}",
            "lpt\u{b3}.txt",
            "conin$",
            "CONOUT$.x",
            "clock$",
            "dir/con",
            "con .txt",
        ] {
            assert_eq!(err(bad), PathError::WindowsDeviceName, "{bad}");
        }
    }

    #[test]
    fn component_length_limit_is_inclusive() {
        let max = "a".repeat(MAX_COMPONENT_BYTES);
        assert!(SafeRelPath::parse(&max).is_ok());
        let over = "a".repeat(MAX_COMPONENT_BYTES + 1);
        assert_eq!(err(&over), PathError::ComponentTooLong);
    }

    #[test]
    fn depth_limit_is_inclusive() {
        let max = ["d"; MAX_DEPTH].join("/");
        assert!(SafeRelPath::parse(&max).is_ok());
        let over = ["d"; MAX_DEPTH + 1].join("/");
        assert_eq!(err(&over), PathError::TooDeep);
    }

    #[test]
    fn path_length_limit_is_inclusive() {
        // 4 components of 255 bytes plus 3 separators plus one more byte: 1024.
        let comp = "a".repeat(MAX_COMPONENT_BYTES);
        let max = format!("{comp}/{comp}/{comp}/{comp}a");
        assert_eq!(max.len(), MAX_PATH_BYTES);
        assert_eq!(err(&max), PathError::ComponentTooLong);
        let max = format!("{comp}/{comp}/{comp}/a/{}", "a".repeat(254));
        assert_eq!(max.len(), MAX_PATH_BYTES);
        assert!(SafeRelPath::parse(&max).is_ok());
        let over = format!("{max}a");
        assert_eq!(err(&over), PathError::TooLong);
    }

    #[test]
    fn raw_length_is_limited_even_if_nfc_is_short_enough() {
        // "e" + combining acute is 3 bytes; its NFC form "é" is 2.
        let comp = "e\u{301}".repeat(80);
        let input = [comp.as_str(); 5].join("/");
        assert!(input.len() > MAX_PATH_BYTES);
        assert!(input.nfc().collect::<String>().len() <= MAX_PATH_BYTES);
        assert_eq!(err(&input), PathError::TooLong);
    }

    #[test]
    fn nfc_length_is_limited_even_if_raw_input_fits() {
        // U+0958 (3 bytes) is excluded from composition; NFC keeps it decomposed
        // into two 3-byte characters, doubling the length.
        let input = "\u{958}".repeat(300);
        assert!(input.len() <= MAX_PATH_BYTES);
        assert!(input.nfc().collect::<String>().len() > MAX_PATH_BYTES);
        assert_eq!(err(&input), PathError::TooLong);
    }

    #[test]
    fn accessors() {
        let p = SafeRelPath::parse("a/b/c.txt").unwrap();
        assert_eq!(p.components().collect::<Vec<_>>(), ["a", "b", "c.txt"]);
        assert_eq!(p.file_name(), "c.txt");
        assert_eq!(SafeRelPath::parse("x").unwrap().file_name(), "x");
        assert_eq!(p.to_string(), "a/b/c.txt");
        assert_eq!(p.as_ref(), "a/b/c.txt");
        assert_eq!("../x".parse::<SafeRelPath>(), Err(PathError::DotComponent));
        assert_eq!("y/z".parse::<SafeRelPath>().unwrap().as_str(), "y/z");
    }

    #[test]
    fn error_messages_are_specific() {
        let cases = [
            (PathError::Empty, "path is empty"),
            (PathError::TooLong, "path is longer than 1024 bytes"),
            (PathError::TooDeep, "path has more than 32 components"),
            (PathError::Absolute, "path is absolute"),
            (
                PathError::ForbiddenChar(':'),
                "path contains the forbidden character ':'",
            ),
            (PathError::ControlChar, "path contains a control character"),
            (
                PathError::InvisibleChar('\u{200b}'),
                "path contains the invisible character U+200B",
            ),
            (PathError::EmptyComponent, "path has an empty component"),
            (PathError::DotComponent, "path has a '.' or '..' component"),
            (
                PathError::HiddenComponent,
                "path has a component starting with '.'",
            ),
            (
                PathError::ComponentTooLong,
                "path has a component longer than 255 bytes",
            ),
            (
                PathError::ComponentEdge,
                "path has a component starting with a space or ending with a space or '.'",
            ),
            (
                PathError::WindowsDeviceName,
                "path has a Windows device name component",
            ),
        ];
        for (e, msg) in cases {
            assert_eq!(e.to_string(), msg);
        }
    }
}
