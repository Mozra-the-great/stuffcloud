//! The shared resource conventions of ADR 0010 (acceptance criteria of A-01), exercised on
//! the settings group `reserved-names` through the full router and a temporary database.

use serde_json::json;

use crate::common::{Policy, TestApp};

const PATH: &str = "/api/v1/settings/reserved-names";

fn etag_of(reply: &crate::common::Reply) -> String {
    reply.header("etag").unwrap().to_owned()
}

#[tokio::test]
async fn get_of_a_group_never_written_is_404() {
    let app = TestApp::new(Policy::AllowAll);
    let problem = app.get(PATH).await.problem(404, "not-found");
    assert_eq!(
        problem["detail"],
        "settings \"reserved-names\" does not exist"
    );
}

#[tokio::test]
async fn put_creates_and_get_returns_the_writable_shape_plus_meta() {
    let app = TestApp::new(Policy::AllowAll);
    let created = app
        .put_json(PATH, &json!({"names": ["auth", "status"]}), &[])
        .await;
    assert_eq!(created.status.as_u16(), 201, "{}", created.text());
    let body = created.json();
    assert_eq!(body["result"], "created");
    assert_eq!(body["dry_run"], false);
    assert_eq!(
        body["diff"],
        json!([{"pointer": "/names", "after": ["auth", "status"]}])
    );
    let etag = etag_of(&created);
    assert!(
        etag.starts_with('"') && etag.ends_with('"') && etag.len() == 34,
        "{etag}"
    );
    assert_eq!(body["resource"]["meta"]["etag"], etag);

    let read = app.get(PATH).await;
    assert_eq!(read.status.as_u16(), 200);
    assert_eq!(etag_of(&read), etag);
    let document = read.json();
    assert_eq!(document["names"], json!(["auth", "status"]));
    let meta = &document["meta"];
    assert_eq!(meta["etag"], etag);
    assert_eq!(meta["created_at"], meta["updated_at"]);
    assert!(meta["id"].is_i64());
    assert_eq!(
        document.as_object().unwrap().keys().collect::<Vec<_>>(),
        vec!["meta", "names"]
    );
    assert_eq!(document, body["resource"]);
}

#[tokio::test]
async fn a_repeated_put_reports_unchanged_and_changes_nothing() {
    let app = TestApp::new(Policy::AllowAll);
    let document = json!({"names": ["auth"]});
    let first = app.put_json(PATH, &document, &[]).await;
    let before = app.get(PATH).await.json();
    let audit_before = app.audit_actions();

    let again = app.put_json(PATH, &document, &[]).await;
    assert_eq!(again.status.as_u16(), 200);
    let body = again.json();
    assert_eq!(body["result"], "unchanged");
    assert_eq!(body["diff"], json!([]));
    assert_eq!(etag_of(&again), etag_of(&first));

    // The clock moved on, yet no timestamp changed and no audit row was written.
    assert_eq!(app.get(PATH).await.json(), before);
    assert_eq!(app.audit_actions(), audit_before);
    assert_eq!(audit_before, vec!["created"]);

    // Sending the GET document back unchanged (with meta) is unchanged too.
    let round_trip = app.put_json(PATH, &before, &[]).await;
    assert_eq!(round_trip.json()["result"], "unchanged");
}

#[tokio::test]
async fn an_update_changes_the_etag_and_updated_at_only() {
    let app = TestApp::new(Policy::AllowAll);
    let first = app.put_json(PATH, &json!({"names": ["auth"]}), &[]).await;
    let created = app.get(PATH).await.json();
    let updated = app
        .put_json(PATH, &json!({"names": ["auth", "vault"]}), &[])
        .await;
    assert_eq!(updated.status.as_u16(), 200);
    let body = updated.json();
    assert_eq!(body["result"], "updated");
    assert_eq!(
        body["diff"],
        json!([{"pointer": "/names", "before": ["auth"], "after": ["auth", "vault"]}])
    );
    assert_ne!(etag_of(&updated), etag_of(&first));
    let now = app.get(PATH).await.json();
    assert_eq!(now["meta"]["id"], created["meta"]["id"]);
    assert_eq!(now["meta"]["created_at"], created["meta"]["created_at"]);
    assert_ne!(now["meta"]["updated_at"], created["meta"]["updated_at"]);
    assert_eq!(app.audit_actions(), vec!["created", "updated"]);
}

#[tokio::test]
async fn a_stale_if_match_gives_412_and_changes_nothing() {
    let app = TestApp::new(Policy::AllowAll);
    let first = app.put_json(PATH, &json!({"names": ["auth"]}), &[]).await;
    let etag = etag_of(&first);
    let _second = app.put_json(PATH, &json!({"names": ["vault"]}), &[]).await;
    let state = app.get(PATH).await.json();

    for path in [PATH.to_owned(), format!("{PATH}?dry_run=true")] {
        let refused_put = app
            .put_json(&path, &json!({"names": ["other"]}), &[("if-match", &etag)])
            .await;
        refused_put.assert_problem(412, "precondition-failed");
        let refused_delete = app.delete(&path, &[("if-match", &etag)]).await;
        refused_delete.assert_problem(412, "precondition-failed");
    }
    assert_eq!(app.get(PATH).await.json(), state);
    assert_eq!(app.audit_actions(), vec!["created", "updated"]);

    let current = state["meta"]["etag"].as_str().unwrap().to_owned();
    let fresh = app
        .put_json(
            PATH,
            &json!({"names": ["other"]}),
            &[("if-match", &current)],
        )
        .await;
    assert_eq!(fresh.json()["result"], "updated");
}

#[tokio::test]
async fn weak_and_wildcard_preconditions() {
    let app = TestApp::new(Policy::AllowAll);
    let document = json!({"names": ["auth"]});
    // If-Match on a missing resource fails, even with `*`.
    app.put_json(PATH, &document, &[("if-match", "*")])
        .await
        .assert_problem(412, "precondition-failed");
    // If-None-Match: * creates only.
    let created = app
        .put_json(PATH, &document, &[("if-none-match", "*")])
        .await;
    assert_eq!(created.status.as_u16(), 201);
    app.put_json(PATH, &document, &[("if-none-match", "*")])
        .await
        .assert_problem(412, "precondition-failed");
    // A weak tag never satisfies If-Match.
    let weak = format!("W/{}", etag_of(&created));
    app.put_json(PATH, &document, &[("if-match", &weak)])
        .await
        .assert_problem(412, "precondition-failed");
    // `*` and a list containing the current tag do.
    let list = format!("\"0000\", {}", etag_of(&created));
    for condition in ["*", list.as_str()] {
        let reply = app
            .put_json(PATH, &document, &[("if-match", condition)])
            .await;
        assert_eq!(reply.json()["result"], "unchanged", "{condition}");
    }
}

#[tokio::test]
async fn a_dry_run_changes_nothing_and_returns_the_diff() {
    let app = TestApp::new(Policy::AllowAll);
    let dry = format!("{PATH}?dry_run=true");

    let would_create = app.put_json(&dry, &json!({"names": ["auth"]}), &[]).await;
    assert_eq!(
        would_create.status.as_u16(),
        200,
        "dry runs never answer 201"
    );
    let body = would_create.json();
    assert_eq!(body["result"], "created");
    assert_eq!(body["dry_run"], true);
    assert_eq!(
        body["diff"],
        json!([{"pointer": "/names", "after": ["auth"]}])
    );
    app.get(PATH).await.assert_problem(404, "not-found");
    assert!(app.audit_actions().is_empty());

    let real = app.put_json(PATH, &json!({"names": ["auth"]}), &[]).await;
    assert_eq!(
        etag_of(&would_create),
        etag_of(&real),
        "the dry run predicted the ETag"
    );
    let state = app.get(PATH).await.json();

    let would_update = app.put_json(&dry, &json!({"names": ["vault"]}), &[]).await;
    let body = would_update.json();
    assert_eq!(body["result"], "updated");
    assert_eq!(
        body["diff"],
        json!([{"pointer": "/names", "before": ["auth"], "after": ["vault"]}])
    );
    assert_eq!(body["resource"]["names"], json!(["vault"]));

    let would_delete = app.delete(&dry, &[]).await;
    assert_eq!(would_delete.status.as_u16(), 200);
    let body = would_delete.json();
    assert_eq!(body["result"], "deleted");
    assert_eq!(body["dry_run"], true);
    assert_eq!(
        body["diff"],
        json!([{"pointer": "/names", "before": ["auth"]}])
    );
    assert!(body.get("resource").is_none());

    assert_eq!(app.get(PATH).await.json(), state);
    assert_eq!(app.audit_actions(), vec!["created"]);
}

#[tokio::test]
async fn unknown_fields_other_than_meta_are_refused() {
    let app = TestApp::new(Policy::AllowAll);
    let problem = app
        .put_json(PATH, &json!({"names": [], "extra": true}), &[])
        .await
        .problem(422, "validation-failed");
    assert_eq!(
        problem["errors"],
        json!([{"pointer": "/extra", "code": "unknown_field", "detail": "unknown field \"extra\""}])
    );
    let with_meta = app
        .put_json(
            PATH,
            &json!({"names": [], "meta": {"etag": "\"x\"", "id": 99}}),
            &[],
        )
        .await;
    assert_eq!(with_meta.status.as_u16(), 201, "{}", with_meta.text());
    assert_eq!(with_meta.json()["resource"]["names"], json!([]));
}

#[tokio::test]
async fn all_field_errors_come_back_in_one_response() {
    let app = TestApp::new(Policy::AllowAll);
    let problem = app
        .put_json(
            PATH,
            &json!({"names": ["auth", "Docs", "ab", "auth"], "zzz": 1, "aaa": 2}),
            &[],
        )
        .await
        .problem(422, "validation-failed");
    let errors: Vec<(String, String)> = problem["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["pointer"].as_str().unwrap().to_owned(),
                e["code"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        errors,
        vec![
            ("/aaa".to_owned(), "unknown_field".to_owned()),
            ("/zzz".to_owned(), "unknown_field".to_owned()),
            ("/names/1".to_owned(), "invalid_value".to_owned()),
            ("/names/2".to_owned(), "invalid_value".to_owned()),
            ("/names/3".to_owned(), "duplicate".to_owned()),
        ]
    );
    assert_eq!(problem["detail"], "5 invalid fields");
    assert!(app.audit_actions().is_empty());

    let missing = app
        .put_json(PATH, &json!({}), &[])
        .await
        .problem(422, "validation-failed");
    assert_eq!(missing["errors"][0]["code"], "missing_field");
    let wrong_type = app
        .put_json(PATH, &json!({"names": "auth"}), &[])
        .await
        .problem(422, "validation-failed");
    assert_eq!(wrong_type["errors"][0]["pointer"], "/names");
    assert_eq!(wrong_type["errors"][0]["code"], "invalid_type");
}

#[tokio::test]
async fn delete_removes_and_a_missing_resource_is_404() {
    let app = TestApp::new(Policy::AllowAll);
    app.delete(PATH, &[]).await.assert_problem(404, "not-found");
    let created = app.put_json(PATH, &json!({"names": ["auth"]}), &[]).await;
    let deleted = app.delete(PATH, &[("if-match", &etag_of(&created))]).await;
    assert_eq!(deleted.status.as_u16(), 200, "{}", deleted.text());
    assert_eq!(deleted.json()["result"], "deleted");
    app.get(PATH).await.assert_problem(404, "not-found");
    assert_eq!(app.audit_actions(), vec!["created", "deleted"]);
}

#[tokio::test]
async fn request_problems() {
    let app = TestApp::new(Policy::AllowAll);
    let send = |content_type: Option<&'static str>, body: &'static str| {
        let mut builder = axum::http::Request::put(PATH);
        if let Some(value) = content_type {
            builder = builder.header("content-type", value);
        }
        builder.body(axum::body::Body::from(body)).unwrap()
    };
    let malformed = app
        .send(send(Some("application/json"), "{\"names\":"))
        .await;
    let json = malformed.problem(400, "malformed-body");
    assert!(
        json["detail"]
            .as_str()
            .unwrap()
            .starts_with("the body is not valid JSON")
    );
    app.send(send(Some("text/plain"), "{}"))
        .await
        .assert_problem(415, "unsupported-media-type");
    app.send(send(None, "{}"))
        .await
        .assert_problem(415, "unsupported-media-type");
    let query = app
        .put_json(&format!("{PATH}?dryrun=true"), &json!({"names": []}), &[])
        .await
        .problem(400, "bad-request");
    assert_eq!(query["detail"], "unknown query parameter \"dryrun\"");
    app.put_json(&format!("{PATH}?dry_run=yes"), &json!({"names": []}), &[])
        .await
        .assert_problem(400, "bad-request");
    app.put_json(PATH, &json!({"names": []}), &[("if-match", "no-quotes")])
        .await
        .assert_problem(400, "bad-request");
    app.delete(&format!("{PATH}?force=true"), &[])
        .await
        .assert_problem(400, "bad-request");
    app.delete(PATH, &[("if-match", "x")])
        .await
        .assert_problem(400, "bad-request");
    assert!(
        app.audit_actions().is_empty(),
        "no refused request wrote anything"
    );
}

#[tokio::test]
async fn bodies_above_the_limit_are_refused() {
    let limits = stuffcloud_app::config::Limits {
        max_body_bytes: 1024,
        ..stuffcloud_app::config::Limits::default()
    };
    let app = TestApp::with_limits(Policy::AllowAll, limits);
    let names: Vec<String> = (0..200).map(|i| format!("name{i:04}")).collect();
    let problem = app
        .put_json(PATH, &json!({"names": names}), &[])
        .await
        .problem(413, "payload-too-large");
    assert_eq!(problem["detail"], "the body is larger than 1024 bytes");
    let small = app.put_json(PATH, &json!({"names": ["auth"]}), &[]).await;
    assert_eq!(small.status.as_u16(), 201);
}

#[tokio::test]
async fn the_production_policy_refuses_every_write() {
    let app = TestApp::new(Policy::Production);
    let document = json!({"names": ["auth"]});
    let problem = app
        .put_json(PATH, &document, &[])
        .await
        .problem(401, "unauthenticated");
    assert!(
        problem["detail"]
            .as_str()
            .unwrap()
            .contains("STUFFCLOUD_BOOTSTRAP_CONFIG")
    );
    app.put_json(&format!("{PATH}?dry_run=true"), &document, &[])
        .await
        .assert_problem(401, "unauthenticated");
    // Authorisation comes first: even an invalid request learns nothing more.
    app.put_json(&format!("{PATH}?bogus"), &json!({"x": 1}), &[])
        .await
        .assert_problem(401, "unauthenticated");
    app.delete(PATH, &[])
        .await
        .assert_problem(401, "unauthenticated");
    // Reads are allowed.
    app.get(PATH).await.assert_problem(404, "not-found");
    assert!(app.audit_actions().is_empty());
}
