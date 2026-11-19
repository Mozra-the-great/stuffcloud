//! Prometheus metrics (`GET /metrics`, OpenMetrics text format).
//!
//! Labels are bounded on purpose: the route is the matched route template (never the raw
//! path, which would let a client create one series per URL), the method is one of the
//! standard methods or `other`, and no label ever holds a client address, user or token.

use std::fmt;

use axum::extract::State;
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderValue, Method};
use axum::response::{IntoResponse, Response};
use prometheus_client::encoding::EncodeLabelSet;
use prometheus_client::encoding::text::encode;
use prometheus_client::metrics::counter::Counter;
use prometheus_client::metrics::family::Family;
use prometheus_client::metrics::histogram::{Histogram, exponential_buckets};
use prometheus_client::metrics::info::Info;
use prometheus_client::registry::Registry;

use crate::problem::Problem;
use crate::state::AppState;

/// Media type of the OpenMetrics text format.
pub const OPENMETRICS: &str = "application/openmetrics-text; version=1.0.0; charset=utf-8";

/// Route label of requests that matched no route.
pub const UNMATCHED: &str = "unmatched";

/// Labels of the request counter.
#[derive(Debug, Clone, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct RequestLabels {
    /// HTTP method (standard methods only, anything else is `other`).
    pub method: String,
    /// Matched route template.
    pub route: String,
    /// Response status code.
    pub status: String,
}

/// Labels of the latency histogram.
#[derive(Debug, Clone, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct RouteLabels {
    /// HTTP method.
    pub method: String,
    /// Matched route template.
    pub route: String,
}

type HistogramFamily = Family<RouteLabels, Histogram, fn() -> Histogram>;

fn latency_histogram() -> Histogram {
    // 1 ms to about 16 s.
    Histogram::new(exponential_buckets(0.001, 2.0, 15))
}

/// The registry and the metrics the middleware records.
pub struct Metrics {
    registry: Registry,
    requests: Family<RequestLabels, Counter>,
    durations: HistogramFamily,
}

impl fmt::Debug for Metrics {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Metrics")
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

/// The method as a bounded label value.
#[must_use]
pub fn method_label(method: &Method) -> &'static str {
    match *method {
        Method::GET => "GET",
        Method::HEAD => "HEAD",
        Method::POST => "POST",
        Method::PUT => "PUT",
        Method::DELETE => "DELETE",
        Method::PATCH => "PATCH",
        Method::OPTIONS => "OPTIONS",
        _ => "other",
    }
}

impl Metrics {
    /// A registry with every metric registered.
    #[must_use]
    pub fn new() -> Self {
        let mut registry = Registry::with_prefix("stuffcloud");
        let requests = Family::<RequestLabels, Counter>::default();
        registry.register(
            "http_requests",
            "HTTP requests answered, by method, route and status",
            requests.clone(),
        );
        let durations: HistogramFamily = Family::new_with_constructor(latency_histogram);
        registry.register(
            "http_request_duration_seconds",
            "Time to answer an HTTP request, by method and route",
            durations.clone(),
        );
        registry.register(
            "build",
            "Version of the running build",
            Info::new(vec![(
                "version".to_owned(),
                env!("CARGO_PKG_VERSION").to_owned(),
            )]),
        );
        Self {
            registry,
            requests,
            durations,
        }
    }

    /// Records one answered request.
    pub fn record(&self, method: &Method, route: &str, status: u16, seconds: f64) {
        let method = method_label(method).to_owned();
        let _total = self
            .requests
            .get_or_create(&RequestLabels {
                method: method.clone(),
                route: route.to_owned(),
                status: status.to_string(),
            })
            .inc();
        self.durations
            .get_or_create(&RouteLabels {
                method,
                route: route.to_owned(),
            })
            .observe(seconds);
    }

    /// The registry in the OpenMetrics text format.
    ///
    /// # Errors
    ///
    /// Only if formatting fails, which writing to a `String` does not.
    pub fn render(&self) -> Result<String, fmt::Error> {
        let mut out = String::new();
        encode(&mut out, &self.registry)?;
        Ok(out)
    }
}

/// `GET /metrics`.
#[utoipa::path(
    get,
    path = "/metrics",
    tag = "operations",
    operation_id = "metrics",
    responses(
        (status = 200, description = "Metrics in the OpenMetrics text format", content_type = "application/openmetrics-text", body = String),
    ),
)]
pub async fn render(State(state): State<AppState>) -> Response {
    match state.metrics().render() {
        Ok(text) => {
            let mut response = text.into_response();
            let _previous = response
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static(OPENMETRICS));
            response
        }
        Err(error) => Problem::internal(&error).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn method_labels_are_bounded() {
        for (method, label) in [
            (Method::GET, "GET"),
            (Method::HEAD, "HEAD"),
            (Method::POST, "POST"),
            (Method::PUT, "PUT"),
            (Method::DELETE, "DELETE"),
            (Method::PATCH, "PATCH"),
            (Method::OPTIONS, "OPTIONS"),
            (Method::TRACE, "other"),
            (Method::from_bytes(b"BREW").unwrap(), "other"),
        ] {
            assert_eq!(method_label(&method), label);
        }
    }

    #[test]
    fn renders_recorded_requests() {
        let metrics = Metrics::default();
        metrics.record(&Method::GET, "/healthz", 200, 0.25);
        metrics.record(&Method::GET, "/healthz", 200, 0.5);
        metrics.record(&Method::from_bytes(b"BREW").unwrap(), UNMATCHED, 404, 0.0);
        let text = metrics.render().unwrap();
        assert!(
            text.contains(
                "stuffcloud_http_requests_total{method=\"GET\",route=\"/healthz\",status=\"200\"} 2"
            ),
            "{text}"
        );
        assert!(text.contains(
            "stuffcloud_http_requests_total{method=\"other\",route=\"unmatched\",status=\"404\"} 1"
        ));
        assert!(text.contains(
            "stuffcloud_http_request_duration_seconds_count{method=\"GET\",route=\"/healthz\"} 2"
        ));
        assert!(text.contains(
            "stuffcloud_http_request_duration_seconds_sum{method=\"GET\",route=\"/healthz\"} 0.75"
        ));
        assert!(text.contains(&format!(
            "stuffcloud_build_info{{version=\"{}\"}} 1",
            env!("CARGO_PKG_VERSION")
        )));
        assert!(text.ends_with("# EOF\n"));
        assert_eq!(format!("{metrics:?}"), "Metrics");
    }

    #[test]
    fn latency_buckets() {
        let histogram = latency_histogram();
        histogram.observe(0.5);
        let metrics = Metrics::new();
        metrics.record(&Method::PUT, "/x", 201, 0.5);
        let text = metrics.render().unwrap();
        assert!(text.contains("le=\"0.001\""), "{text}");
        assert!(text.contains("le=\"16.384\""), "{text}");
        assert!(!text.contains("le=\"32.768\""), "{text}");
    }
}
