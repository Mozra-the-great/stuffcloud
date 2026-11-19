//! Bootstrap without clicks (SPEC 10.7, ADR 0010 decision 8).
//!
//! On the first start with an empty database the app applies an optional configuration
//! file (`STUFFCLOUD_BOOTSTRAP_CONFIG`) once, in one transaction, and records that the
//! bootstrap ran. Every later start ignores the bootstrap inputs with a log line; later
//! changes go through the API. The file is never read again after the first start, so it
//! can be removed.
//!
//! The file is JSON in the shape of the declarative configuration (SPEC 10.6):
//!
//! ```json
//! { "version": 1, "settings": { "reserved-names": { "names": ["intranet", "wiki"] } } }
//! ```
//!
//! Only the resources that exist so far are accepted (the settings group
//! `reserved-names`); every problem in the file is reported at once with a JSON Pointer, and
//! the app refuses to start. The file never holds secrets (ADR 0010 decision 4). YAML
//! arrives with the CLI's `validate`/`plan`/`apply` (H-13, #57), which shares this format.
//! The first admin and the bootstrap token are refused in `config` until accounts and
//! tokens exist.

use std::fmt;
use std::path::Path;

use serde_json::Value;
use stuffcloud_core::body::{Writable, canonical, parse_writable_value};
use stuffcloud_core::field::{FieldError, FieldErrorCode, JsonPointer};
use stuffcloud_core::settings::ReservedNames;
use stuffcloud_db::{BootstrapOutcome, Change, Database, DbError};

use crate::settings::KIND;

/// The only file format version so far.
pub const FILE_VERSION: u64 = 1;

/// One resource the bootstrap writes: kind, key, canonical body.
pub type BootstrapWrite = (&'static str, &'static str, String);

/// Why the bootstrap failed.
#[derive(Debug)]
pub enum BootstrapError {
    /// The file could not be read.
    Read {
        /// The file.
        path: String,
        /// What went wrong.
        error: std::io::Error,
    },
    /// The file is not JSON.
    Malformed(String),
    /// The file has invalid entries (all of them).
    Invalid(Vec<FieldError>),
    /// The database failed.
    Database(DbError),
}

impl fmt::Display for BootstrapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { path, error } => {
                write!(
                    f,
                    "cannot read the bootstrap configuration {path:?}: {}",
                    error.kind()
                )
            }
            Self::Malformed(message) => {
                write!(
                    f,
                    "the bootstrap configuration is not valid JSON: {message}"
                )
            }
            Self::Invalid(errors) => {
                f.write_str("the bootstrap configuration is invalid:")?;
                for error in errors {
                    write!(f, "\n  {error}")?;
                }
                Ok(())
            }
            Self::Database(error) => write!(f, "bootstrap failed: {error}"),
        }
    }
}

impl std::error::Error for BootstrapError {}

/// What the bootstrap did on this start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapReport {
    /// First start: these changes were applied (empty without a file).
    Applied(Vec<Change>),
    /// A later start: the inputs were ignored; the bootstrap ran at this time.
    Ignored {
        /// Unix milliseconds of the first start.
        bootstrapped_at: i64,
    },
    /// The database already held data without a bootstrap record; nothing was applied.
    SkippedNotEmpty,
}

fn parse_resource<T: Writable>(value: Value, at: &JsonPointer) -> Result<String, Vec<FieldError>> {
    parse_writable_value::<T>(value)
        .map(|document| canonical(&document))
        .map_err(|errors| {
            errors
                .into_iter()
                .map(|error| error.nested_in(at))
                .collect()
        })
}

fn expect_object(
    value: Value,
    at: &JsonPointer,
    errors: &mut Vec<FieldError>,
) -> Option<serde_json::Map<String, Value>> {
    if let Value::Object(map) = value {
        Some(map)
    } else {
        errors.push(FieldError::new(
            at.clone(),
            FieldErrorCode::InvalidType,
            "expected a JSON object",
        ));
        None
    }
}

/// Parses a bootstrap file into the writes it asks for, reporting every problem.
///
/// # Errors
///
/// [`BootstrapError::Malformed`] or [`BootstrapError::Invalid`].
pub fn parse_file(bytes: &[u8]) -> Result<Vec<BootstrapWrite>, BootstrapError> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| BootstrapError::Malformed(error.to_string()))?;
    let root = JsonPointer::root();
    let mut errors = Vec::new();
    let mut writes = Vec::new();
    let Some(top) = expect_object(value, &root, &mut errors) else {
        return Err(BootstrapError::Invalid(errors));
    };
    if top.get("version").and_then(Value::as_u64) != Some(FILE_VERSION) {
        errors.push(FieldError::new(
            root.key("version"),
            FieldErrorCode::InvalidValue,
            format!("version must be {FILE_VERSION}"),
        ));
    }
    for (name, value) in top {
        match name.as_str() {
            "version" => {}
            "settings" => {
                let at = root.key("settings");
                let Some(groups) = expect_object(value, &at, &mut errors) else {
                    continue;
                };
                for (group, document) in groups {
                    let group_at = at.key(&group);
                    if group == ReservedNames::GROUP {
                        match parse_resource::<ReservedNames>(document, &group_at) {
                            Ok(body) => writes.push((KIND, ReservedNames::GROUP, body)),
                            Err(found) => errors.extend(found),
                        }
                    } else {
                        errors.push(FieldError::new(
                            group_at,
                            FieldErrorCode::UnknownField,
                            format!("unknown settings group {group:?}"),
                        ));
                    }
                }
            }
            _ => errors.push(FieldError::new(
                root.key(&name),
                FieldErrorCode::UnknownField,
                format!("unknown section {name:?}"),
            )),
        }
    }
    if errors.is_empty() {
        Ok(writes)
    } else {
        Err(BootstrapError::Invalid(errors))
    }
}

/// Runs the bootstrap on startup (synchronously, before the server starts).
///
/// # Errors
///
/// See [`BootstrapError`]; the app then refuses to start.
pub fn run(
    db: &Database,
    file: Option<&Path>,
    now: i64,
) -> Result<BootstrapReport, BootstrapError> {
    if let Some(at) = db.bootstrapped_at().map_err(BootstrapError::Database)? {
        if file.is_some() {
            tracing::info!(
                target: "stuffcloud::bootstrap",
                bootstrapped_at = at,
                "the instance is already bootstrapped; STUFFCLOUD_BOOTSTRAP_CONFIG is ignored (change the configuration through the API)"
            );
        }
        return Ok(BootstrapReport::Ignored {
            bootstrapped_at: at,
        });
    }
    let writes = match file {
        Some(path) => {
            let bytes = std::fs::read(path).map_err(|error| BootstrapError::Read {
                path: path.display().to_string(),
                error,
            })?;
            parse_file(&bytes)?
        }
        None => Vec::new(),
    };
    let outcome = db
        .bootstrap(
            &writes
                .iter()
                .map(|(kind, key, body)| (*kind, *key, body.clone()))
                .collect::<Vec<_>>(),
            now,
        )
        .map_err(BootstrapError::Database)?;
    Ok(match outcome {
        BootstrapOutcome::Applied { changes } => {
            tracing::info!(
                target: "stuffcloud::bootstrap",
                resources = changes.len(),
                "first start: bootstrap applied"
            );
            BootstrapReport::Applied(changes)
        }
        BootstrapOutcome::AlreadyDone { at } => BootstrapReport::Ignored {
            bootstrapped_at: at,
        },
        BootstrapOutcome::NotEmpty => {
            tracing::warn!(
                target: "stuffcloud::bootstrap",
                "the database already holds data; the bootstrap was skipped"
            );
            BootstrapReport::SkippedNotEmpty
        }
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn invalid(file: &Value) -> Vec<(String, FieldErrorCode)> {
        match parse_file(file.to_string().as_bytes()) {
            Err(BootstrapError::Invalid(errors)) => errors
                .into_iter()
                .map(|error| (error.pointer.as_str().to_owned(), error.code))
                .collect(),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_a_valid_file() {
        let writes = parse_file(
            json!({"version": 1, "settings": {"reserved-names": {"names": ["intranet"], "meta": {}}}})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            writes,
            vec![(
                KIND,
                "reserved-names",
                "{\"names\":[\"intranet\"]}".to_owned()
            )]
        );
        assert!(parse_file(br#"{"version":1}"#).unwrap().is_empty());
        assert!(
            parse_file(br#"{"version":1,"settings":{}}"#)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn reports_every_problem_with_a_pointer() {
        assert_eq!(
            invalid(&json!({
                "version": 2,
                "zones": [],
                "settings": {"reserved-names": {"names": ["ok1", "BAD"], "x": 1}, "smtp": {}}
            })),
            vec![
                ("/version".to_owned(), FieldErrorCode::InvalidValue),
                (
                    "/settings/reserved-names/x".to_owned(),
                    FieldErrorCode::UnknownField
                ),
                (
                    "/settings/reserved-names/names/1".to_owned(),
                    FieldErrorCode::InvalidValue
                ),
                ("/settings/smtp".to_owned(), FieldErrorCode::UnknownField),
                ("/zones".to_owned(), FieldErrorCode::UnknownField),
            ]
        );
        assert_eq!(
            invalid(&json!({})),
            vec![("/version".to_owned(), FieldErrorCode::InvalidValue)]
        );
        assert_eq!(
            invalid(&json!({"version": "1"})),
            vec![("/version".to_owned(), FieldErrorCode::InvalidValue)]
        );
    }

    #[test]
    fn refuses_wrong_types() {
        assert_eq!(
            invalid(&json!([])),
            vec![(String::new(), FieldErrorCode::InvalidType)]
        );
        assert_eq!(
            invalid(&json!({"version": 1, "settings": []})),
            vec![("/settings".to_owned(), FieldErrorCode::InvalidType)]
        );
        assert_eq!(
            invalid(&json!({"version": 1, "settings": {"reserved-names": 5}})),
            vec![(
                "/settings/reserved-names".to_owned(),
                FieldErrorCode::InvalidType
            )]
        );
        match parse_file(b"{") {
            Err(BootstrapError::Malformed(message)) => assert!(message.contains("EOF")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parse_resource_maps_body_errors() {
        let at = JsonPointer::root().key("x");
        let errors = parse_resource::<ReservedNames>(json!({"names": [1]}), &at).unwrap_err();
        assert_eq!(errors[0].pointer.as_str(), "/x/names/0");
        assert_eq!(errors[0].code, FieldErrorCode::InvalidType);
    }

    #[test]
    fn messages() {
        let read = BootstrapError::Read {
            path: "/etc/x.json".to_owned(),
            error: std::io::Error::from(std::io::ErrorKind::NotFound),
        };
        assert_eq!(
            read.to_string(),
            "cannot read the bootstrap configuration \"/etc/x.json\": entity not found"
        );
        assert_eq!(
            BootstrapError::Malformed("EOF".to_owned()).to_string(),
            "the bootstrap configuration is not valid JSON: EOF"
        );
        let invalid = BootstrapError::Invalid(vec![FieldError::new(
            JsonPointer::root().key("version"),
            FieldErrorCode::InvalidValue,
            "version must be 1",
        )]);
        assert_eq!(
            invalid.to_string(),
            "the bootstrap configuration is invalid:\n  /version: version must be 1"
        );
        assert_eq!(
            BootstrapError::Database(DbError::Poisoned).to_string(),
            "bootstrap failed: the database connection is unusable after a panic"
        );
    }

    fn database() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("b.sqlite3")).unwrap();
        let _ = db.migrate().unwrap();
        (dir, db)
    }

    #[test]
    fn runs_once_and_ignores_the_file_afterwards() {
        let (dir, db) = database();
        let file = dir.path().join("bootstrap.json");
        std::fs::write(
            &file,
            json!({"version": 1, "settings": {"reserved-names": {"names": ["intranet"]}}})
                .to_string(),
        )
        .unwrap();
        assert_eq!(
            run(&db, Some(&file), 1000).unwrap(),
            BootstrapReport::Applied(vec![Change::Created])
        );
        let stored = db.get(KIND, "reserved-names").unwrap().unwrap();
        assert_eq!(stored.body, "{\"names\":[\"intranet\"]}");

        // A later start: the file may even be gone or broken now.
        std::fs::write(&file, "not json").unwrap();
        assert_eq!(
            run(&db, Some(&file), 2000).unwrap(),
            BootstrapReport::Ignored {
                bootstrapped_at: 1000
            }
        );
        assert_eq!(
            run(&db, None, 3000).unwrap(),
            BootstrapReport::Ignored {
                bootstrapped_at: 1000
            }
        );
        assert_eq!(db.get(KIND, "reserved-names").unwrap(), Some(stored));
    }

    #[test]
    fn first_start_without_a_file_still_counts() {
        let (dir, db) = database();
        assert_eq!(run(&db, None, 5).unwrap(), BootstrapReport::Applied(vec![]));
        let file = dir.path().join("late.json");
        std::fs::write(
            &file,
            r#"{"version":1,"settings":{"reserved-names":{"names":["intranet"]}}}"#,
        )
        .unwrap();
        assert_eq!(
            run(&db, Some(&file), 6).unwrap(),
            BootstrapReport::Ignored { bootstrapped_at: 5 }
        );
        assert_eq!(db.get(KIND, "reserved-names").unwrap(), None);
    }

    #[test]
    fn a_broken_or_missing_file_stops_the_first_start() {
        let (dir, db) = database();
        let missing = dir.path().join("missing.json");
        assert!(matches!(
            run(&db, Some(&missing), 1),
            Err(BootstrapError::Read { .. })
        ));
        let broken = dir.path().join("broken.json");
        std::fs::write(
            &broken,
            r#"{"version":1,"settings":{"reserved-names":{"names":["X"]}}}"#,
        )
        .unwrap();
        assert!(matches!(
            run(&db, Some(&broken), 1),
            Err(BootstrapError::Invalid(_))
        ));
        assert_eq!(db.bootstrapped_at().unwrap(), None, "nothing was recorded");
    }

    #[test]
    fn a_database_with_data_is_skipped() {
        let (_dir, db) = database();
        let ctx = stuffcloud_db::WriteContext {
            now: 1,
            actor: None,
            dry_run: false,
        };
        let _ = db
            .put(
                KIND,
                "reserved-names",
                "{\"names\":[]}",
                &stuffcloud_db::Preconditions::default(),
                &ctx,
            )
            .unwrap();
        assert_eq!(run(&db, None, 2).unwrap(), BootstrapReport::SkippedNotEmpty);
    }
}
