//! Structured logs (`tracing`), JSON by default.
//!
//! stuffcloud's own targets log at the configured level, every dependency at `warn` and
//! above only (their debug output could contain request details). What the app logs per
//! request is decided in `middleware::observe`; the redaction tests in
//! `tests/logging.rs` prove that no client address, token or query string ends up here.

use tracing::Subscriber;
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::{Layer, Registry, fmt};

use crate::config::{LogFormat, LogLevel};

/// The filter level of a configured log level.
#[must_use]
pub const fn level_filter(level: LogLevel) -> LevelFilter {
    match level {
        LogLevel::Error => LevelFilter::ERROR,
        LogLevel::Warn => LevelFilter::WARN,
        LogLevel::Info => LevelFilter::INFO,
        LogLevel::Debug => LevelFilter::DEBUG,
        LogLevel::Trace => LevelFilter::TRACE,
    }
}

/// The filter: own targets at `level`, everything else at `warn`.
#[must_use]
pub fn targets(level: LogLevel) -> Targets {
    let own = level_filter(level);
    Targets::new()
        .with_default(LevelFilter::WARN.min(own))
        .with_target("stuffcloud", own)
        .with_target("stuffcloud_app", own)
        .with_target("stuffcloud_db", own)
}

/// A subscriber writing to `writer` (stdout in production, a buffer in tests).
pub fn subscriber<W>(level: LogLevel, format: LogFormat, writer: W) -> impl Subscriber + Send + Sync
where
    W: for<'w> MakeWriter<'w> + Send + Sync + 'static,
{
    let layer = match format {
        LogFormat::Json => fmt::layer()
            .json()
            .with_current_span(false)
            .with_span_list(false)
            .with_writer(writer)
            .boxed(),
        LogFormat::Text => fmt::layer().with_writer(writer).boxed(),
    };
    Registry::default().with(layer.with_filter(targets(level)))
}

/// Installs the subscriber for the whole process, writing to stdout. A second call (only
/// possible in tests) leaves the first subscriber in place.
pub fn init(level: LogLevel, format: LogFormat) {
    let _already_set =
        tracing::subscriber::set_global_default(subscriber(level, format, std::io::stdout));
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// Collects everything written into one buffer.
    #[derive(Clone, Default)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Buffer {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'w> MakeWriter<'w> for Buffer {
        type Writer = Self;

        fn make_writer(&'w self) -> Self::Writer {
            self.clone()
        }
    }

    impl Buffer {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    #[test]
    fn levels_map_to_filters() {
        assert_eq!(level_filter(LogLevel::Error), LevelFilter::ERROR);
        assert_eq!(level_filter(LogLevel::Warn), LevelFilter::WARN);
        assert_eq!(level_filter(LogLevel::Info), LevelFilter::INFO);
        assert_eq!(level_filter(LogLevel::Debug), LevelFilter::DEBUG);
        assert_eq!(level_filter(LogLevel::Trace), LevelFilter::TRACE);
    }

    fn capture(level: LogLevel, format: LogFormat) -> String {
        let buffer = Buffer::default();
        let _guard = tracing::subscriber::set_default(subscriber(level, format, buffer.clone()));
        tracing::info!(target: "stuffcloud::http", answer = 42, "own info");
        tracing::debug!(target: "stuffcloud::http", "own debug");
        tracing::info!(target: "hyper::proto", "dependency info");
        tracing::warn!(target: "hyper::proto", "dependency warning");
        tracing::error!(target: "stuffcloud_db", "db error");
        buffer.text()
    }

    #[test]
    fn json_lines_and_filtering() {
        let text = capture(LogLevel::Info, LogFormat::Json);
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let messages: Vec<&str> = lines
            .iter()
            .map(|line| line["fields"]["message"].as_str().unwrap())
            .collect();
        assert_eq!(messages, vec!["own info", "dependency warning", "db error"]);
        assert_eq!(lines[0]["fields"]["answer"], 42);
        assert_eq!(lines[0]["level"], "INFO");
        assert_eq!(lines[0]["target"], "stuffcloud::http");
    }

    #[test]
    fn debug_level_and_text_format() {
        let text = capture(LogLevel::Debug, LogFormat::Text);
        assert!(text.contains("own debug"), "{text}");
        assert!(!text.contains("dependency info"), "{text}");
        assert!(text.contains("dependency warning"), "{text}");
        assert!(!text.trim_start().starts_with('{'));
    }

    #[test]
    fn error_level_silences_dependency_warnings() {
        let text = capture(LogLevel::Error, LogFormat::Json);
        assert!(!text.contains("dependency warning"), "{text}");
        assert!(!text.contains("own info"), "{text}");
        assert!(text.contains("db error"), "{text}");
    }

    #[test]
    fn init_twice_is_harmless() {
        init(LogLevel::Warn, LogFormat::Json);
        init(LogLevel::Warn, LogFormat::Text);
    }
}
