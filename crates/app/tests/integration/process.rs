//! The `stuffcloud-app` binary as a process: commands, exit codes, the committed OpenAPI
//! document, startup, bootstrap and graceful shutdown.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const BIN: &str = env!("CARGO_BIN_EXE_stuffcloud-app");
const PASSWORD: &str = "hunter2-but-much-longer-9c8b7a";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// A command for the binary without any `STUFFCLOUD_*` variable of the test environment
/// (other variables, such as the coverage profile path, stay).
fn command() -> Command {
    let mut command = Command::new(BIN);
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("STUFFCLOUD_") {
            let _ = command.env_remove(name);
        }
    }
    command
}

/// Runs the binary with `vars` on top of a clean `STUFFCLOUD_*` environment.
fn run(args: &[&str], vars: &[(&str, &str)]) -> Output {
    let mut command = command();
    let _ = command.args(args);
    for (name, value) in vars {
        let _ = command.env(name, value);
    }
    command.output().unwrap()
}

#[test]
fn the_committed_openapi_document_is_current() {
    let output = run(&["openapi"], &[]);
    assert!(output.status.success());
    let generated = String::from_utf8(output.stdout).unwrap();
    let committed = std::fs::read_to_string(repo_root().join("docs/api/openapi.json"))
        .unwrap_or_default()
        .replace("\r\n", "\n");
    assert!(
        generated == committed,
        "docs/api/openapi.json is stale: run `cargo run -p stuffcloud-app -- openapi > docs/api/openapi.json`, \
         then `pnpm --filter @stuffcloud/api-client generate -- --input ../../../docs/api/openapi.json` in web/"
    );
    let document: serde_json::Value = serde_json::from_str(&generated).unwrap();
    assert!(document["openapi"].as_str().unwrap().starts_with("3.1"));
}

#[test]
fn exit_codes() {
    let version = run(&["version"], &[]);
    assert_eq!(version.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(version.stdout).unwrap(),
        format!("stuffcloud-app {}\n", env!("CARGO_PKG_VERSION"))
    );
    let usage = run(&["frobnicate"], &[]);
    assert_eq!(usage.status.code(), Some(2));
    let config = run(&["serve"], &[]);
    assert_eq!(config.status.code(), Some(1));
    let stderr = String::from_utf8(config.stderr).unwrap();
    assert!(
        stderr.contains("STUFFCLOUD_APP_URL: is required"),
        "{stderr}"
    );
    let unhealthy = run(
        &["healthcheck"],
        &[(
            "STUFFCLOUD_LISTEN",
            &format!("127.0.0.1:{}", crate::common::free_port()),
        )],
    );
    assert_eq!(unhealthy.status.code(), Some(1));
}

#[test]
fn bootstrap_secrets_never_reach_the_output_or_the_disk() {
    let dir = tempfile::tempdir().unwrap();
    let secret_file = dir.path().join("admin-password");
    std::fs::write(&secret_file, PASSWORD).unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir(&data).unwrap();
    for vars in [
        vec![("STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD", PASSWORD)],
        vec![(
            "STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD_FILE",
            secret_file.to_str().unwrap(),
        )],
        vec![(
            "STUFFCLOUD_BOOTSTRAP_TOKEN_FILE",
            secret_file.to_str().unwrap(),
        )],
    ] {
        let mut all = vec![
            ("STUFFCLOUD_APP_URL", "http://stuff.localhost"),
            ("STUFFCLOUD_DATA_DIR", data.to_str().unwrap()),
        ];
        all.extend(vars);
        let output = run(&["serve"], &all);
        assert_eq!(output.status.code(), Some(1));
        let printed = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(printed.contains("STUFFCLOUD_BOOTSTRAP_"), "{printed}");
        assert!(!printed.contains(PASSWORD), "the secret leaked: {printed}");
    }
    assert_eq!(
        std::fs::read_dir(&data).unwrap().count(),
        0,
        "the app refused to start before creating a database"
    );
}

#[test]
fn the_dockerfile_builds_with_the_pinned_toolchain() {
    let toolchain = std::fs::read_to_string(repo_root().join("rust-toolchain.toml")).unwrap();
    let channel = toolchain
        .lines()
        .find_map(|line| line.strip_prefix("channel = "))
        .unwrap()
        .trim_matches('"')
        .to_owned();
    let dockerfile = std::fs::read_to_string(repo_root().join("docker/app/Dockerfile")).unwrap();
    let from = format!("FROM rust:{channel}-");
    assert!(
        dockerfile.lines().any(|line| line.starts_with(&from)),
        "docker/app/Dockerfile must build with rust:{channel} (rust-toolchain.toml)"
    );
}

#[cfg(unix)]
mod lifecycle {
    use std::io::{BufRead, BufReader};
    use std::net::SocketAddr;
    use std::process::{Child, Stdio};
    use std::time::{Duration, Instant};

    use super::*;
    use crate::common::{free_port, raw_http};

    fn start(data: &Path, bootstrap: &Path, port: u16) -> Child {
        command()
            .arg("serve")
            .env("STUFFCLOUD_APP_URL", "http://stuff.localhost:8080")
            .env("STUFFCLOUD_DATA_DIR", data)
            .env("STUFFCLOUD_LISTEN", format!("127.0.0.1:{port}"))
            .env("STUFFCLOUD_BOOTSTRAP_CONFIG", bootstrap)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    fn wait_ready(port: u16) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let probe = run(
                &["healthcheck"],
                &[("STUFFCLOUD_LISTEN", &format!("127.0.0.1:{port}"))],
            );
            if probe.status.success() {
                return;
            }
            assert!(Instant::now() < deadline, "the app did not become ready");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Sends SIGTERM and returns the exit status and the log lines.
    fn stop(mut child: Child) -> (Option<i32>, Vec<serde_json::Value>) {
        let killed = Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status()
            .unwrap();
        assert!(killed.success());
        let status = child.wait().unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap())
            .lines()
            .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
            .collect();
        (status.code(), lines)
    }

    fn messages(lines: &[serde_json::Value]) -> Vec<String> {
        lines
            .iter()
            .map(|line| {
                line["fields"]["message"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect()
    }

    #[test]
    fn serves_bootstraps_once_and_shuts_down_gracefully() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir(&data).unwrap();
        let bootstrap = dir.path().join("bootstrap.json");
        std::fs::write(
            &bootstrap,
            r#"{"version":1,"settings":{"reserved-names":{"names":["intranet","wiki"]}}}"#,
        )
        .unwrap();

        let port = free_port();
        let child = start(&data, &bootstrap, port);
        wait_ready(port);
        let address: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
        let answer = raw_http(
            address,
            "GET /api/v1/settings/reserved-names HTTP/1.1\r\nHost: stuff.localhost\r\nConnection: close\r\n\r\n",
        );
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        assert!(
            answer.contains(r#""names":["intranet","wiki"]"#),
            "{answer}"
        );
        let (code, lines) = stop(child);
        assert_eq!(code, Some(0), "graceful shutdown exits with 0");
        let first = messages(&lines);
        for expected in [
            "database ready",
            "first start: bootstrap applied",
            "listening",
            "stopped cleanly",
        ] {
            assert!(
                first.iter().any(|m| m == expected),
                "{expected:?} missing in {first:?}"
            );
        }

        // Second start with a different file: ignored with a log line, data unchanged.
        std::fs::write(
            &bootstrap,
            r#"{"version":1,"settings":{"reserved-names":{"names":["other"]}}}"#,
        )
        .unwrap();
        let port = free_port();
        let child = start(&data, &bootstrap, port);
        wait_ready(port);
        let address: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
        let answer = raw_http(
            address,
            "GET /api/v1/settings/reserved-names HTTP/1.1\r\nHost: stuff.localhost\r\nConnection: close\r\n\r\n",
        );
        assert!(
            answer.contains(r#""names":["intranet","wiki"]"#),
            "{answer}"
        );
        let (code, lines) = stop(child);
        assert_eq!(code, Some(0));
        let second = messages(&lines);
        assert!(
            second
                .iter()
                .any(|m| m.starts_with("the instance is already bootstrapped")),
            "{second:?}"
        );
        assert!(!second.iter().any(|m| m == "first start: bootstrap applied"));
    }
}
