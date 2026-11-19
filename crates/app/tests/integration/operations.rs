//! Probes, metrics, the OpenAPI document, router errors, security headers and limits.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Request};
use stuffcloud_app::config::Limits;
use stuffcloud_app::middleware::SECURITY_HEADERS;
use stuffcloud_app::server::router;
use stuffcloud_app::state::{AppState, ReadOnlyPolicy, SystemClock};
use stuffcloud_db::Database;

use crate::common::{Policy, TestApp};

#[tokio::test]
async fn the_api_boots_against_a_temporary_database() {
    let app = TestApp::new(Policy::Production);
    let live = app.get("/healthz").await;
    assert_eq!(live.status.as_u16(), 200);
    assert_eq!(live.json(), serde_json::json!({"status": "ok"}));
    let ready = app.get("/readyz").await;
    assert_eq!(ready.status.as_u16(), 200);
    assert_eq!(ready.json(), serde_json::json!({"status": "ready"}));
    assert!(app.dir.path().join("test.sqlite3").is_file());
}

#[tokio::test]
async fn readiness_fails_on_an_unmigrated_database() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("raw.sqlite3")).unwrap());
    let state = AppState::new(
        db,
        Arc::new(ReadOnlyPolicy),
        Arc::new(SystemClock),
        Limits::default(),
    );
    let app = router(state);
    let response =
        tower::ServiceExt::oneshot(app, Request::get("/readyz").body(Body::empty()).unwrap())
            .await
            .unwrap();
    assert_eq!(response.status().as_u16(), 503);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["detail"], "the database is not ready");
    assert!(json["type"].as_str().unwrap().ends_with("#not-ready"));
}

#[tokio::test]
async fn metrics_count_requests_by_route_template() {
    let app = TestApp::new(Policy::Production);
    let _ = app.get("/healthz").await;
    let _ = app.get("/api/v1/settings/reserved-names").await;
    let _ = app.get("/api/v1/does-not-exist?token=abc").await;
    let metrics = app.get("/metrics").await;
    assert_eq!(metrics.status.as_u16(), 200);
    assert_eq!(
        metrics.header("content-type"),
        Some(stuffcloud_app::metrics::OPENMETRICS)
    );
    let text = metrics.text();
    for line in [
        "stuffcloud_http_requests_total{method=\"GET\",route=\"/healthz\",status=\"200\"} 1",
        "stuffcloud_http_requests_total{method=\"GET\",route=\"/api/v1/settings/reserved-names\",status=\"404\"} 1",
        "stuffcloud_http_requests_total{method=\"GET\",route=\"unmatched\",status=\"404\"} 1",
    ] {
        assert!(text.contains(line), "missing {line} in\n{text}");
    }
    assert!(!text.contains("does-not-exist"));
    assert!(!text.contains("token"));
}

#[tokio::test]
async fn the_openapi_document_is_served() {
    let app = TestApp::new(Policy::Production);
    let reply = app.get("/api/v1/openapi.json").await;
    assert_eq!(reply.status.as_u16(), 200);
    let served = reply.json();
    let generated = serde_json::to_value(stuffcloud_app::openapi::document()).unwrap();
    assert_eq!(served, generated);
    assert!(served["paths"]["/api/v1/settings/reserved-names"]["put"].is_object());
}

#[tokio::test]
async fn unknown_routes_and_methods_are_problems() {
    let app = TestApp::new(Policy::Production);
    for path in [
        "/",
        "/api",
        "/api/v1",
        "/api/v2/settings/reserved-names",
        "/nope",
    ] {
        app.get(path).await.assert_problem(404, "not-found");
    }
    let post = app
        .send(
            Request::post("/api/v1/settings/reserved-names")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    post.assert_problem(405, "method-not-allowed");
    let allow = post.header("allow").unwrap_or_default().to_owned();
    for method in ["GET", "PUT", "DELETE"] {
        assert!(allow.contains(method), "{allow}");
    }
    let patch = app
        .send(
            Request::builder()
                .method(Method::PATCH)
                .uri("/healthz")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    patch.assert_problem(405, "method-not-allowed");
}

#[tokio::test]
async fn every_response_has_the_security_headers() {
    let app = TestApp::new(Policy::Production);
    let replies = [
        app.get("/healthz").await,
        app.get("/metrics").await,
        app.get("/api/v1/settings/reserved-names").await,
        app.get("/missing").await,
        app.put_json(
            "/api/v1/settings/reserved-names",
            &serde_json::json!({}),
            &[],
        )
        .await,
    ];
    for reply in replies {
        for (name, value) in SECURITY_HEADERS {
            assert_eq!(
                reply.header(name),
                Some(value),
                "{name} on {}",
                reply.status
            );
        }
    }
}

#[tokio::test]
async fn slow_requests_hit_the_time_limit() {
    let limits = Limits {
        request_timeout: Duration::ZERO,
        ..Limits::default()
    };
    let app = TestApp::with_limits(Policy::Production, limits);
    // The database call runs on the blocking pool and cannot finish within zero time.
    let problem = app
        .get("/api/v1/settings/reserved-names")
        .await
        .problem(503, "timeout");
    assert_eq!(problem["detail"], "the request took longer than 0 s");
}
