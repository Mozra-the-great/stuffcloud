#!/usr/bin/env python3
"""Unit tests for check_container_hardening.py.

The gate exists to say no, so every rule has a test where exactly that rule is broken and
nothing else, plus one test where everything is right. A rule that silently stopped firing
would let an unhardened container into the dev stack.

    python3 -m unittest discover -s scripts/ci -p "test_*.py"
"""
from __future__ import annotations

import copy
import json
import pathlib
import sys
import tempfile
import unittest
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import check_container_hardening as ch  # noqa: E402

DIGEST = "sha256:" + "a" * 64
PINNED = f"example/app:1.2.3@{DIGEST}"

GOOD_SERVICE: dict[str, Any] = {
    "image": PINNED,
    "user": "65532:65532",
    "read_only": True,
    "cap_drop": ["ALL"],
    "security_opt": ["no-new-privileges:true"],
    "healthcheck": {"test": ["CMD", "true"], "interval": "5s"},
    "ports": [{"target": 80, "published": "8080", "host_ip": "127.0.0.1", "protocol": "tcp"}],
    "volumes": [
        {"type": "bind", "source": "/repo/conf", "target": "/etc/conf", "read_only": True},
        {"type": "volume", "source": "data", "target": "/data"},
    ],
    "tmpfs": ["/tmp"],
}

GOOD_DOCKERFILE = f"""
# build
FROM node:24.1.0-slim@{DIGEST} AS build
RUN echo build
FROM caddy:2.11.9-alpine@{DIGEST}
COPY --from=build /out /srv
USER 65532:65532
"""


def service(**changes: Any) -> dict[str, Any]:
    """The good service with some keys replaced; a value of None removes the key."""
    result = copy.deepcopy(GOOD_SERVICE)
    for key, value in changes.items():
        if value is None:
            result.pop(key, None)
        else:
            result[key] = value
    return result


def findings(**changes: Any) -> list[str]:
    return ch.check_service("web", service(**changes))


class ImageTests(unittest.TestCase):
    def test_pinned_image_passes(self) -> None:
        self.assertIsNone(ch.image_problem(PINNED))
        self.assertIsNone(ch.image_problem(f"registry.example:5000/team/app:v1@{DIGEST}"))

    def test_tag_only_is_refused(self) -> None:
        self.assertIn("not pinned by digest", ch.image_problem("example/app:1.2.3") or "")

    def test_no_tag_is_refused(self) -> None:
        self.assertIn("no tag", ch.image_problem(f"example/app@{DIGEST}") or "")

    def test_port_in_registry_is_not_a_tag(self) -> None:
        self.assertIn("no tag", ch.image_problem(f"registry.example:5000/app@{DIGEST}") or "")

    def test_latest_is_refused(self) -> None:
        self.assertIn("latest", ch.image_problem(f"example/app:latest@{DIGEST}") or "")

    def test_short_or_malformed_digest_is_refused(self) -> None:
        self.assertIsNotNone(ch.image_problem("example/app:1@sha256:abc"))
        self.assertIsNotNone(ch.image_problem(f"example/app:1@sha256:{'A' * 64}"))


class UidTests(unittest.TestCase):
    def test_numeric_non_root_passes(self) -> None:
        self.assertIsNone(ch.uid_problem("65532:65532"))
        self.assertIsNone(ch.uid_problem(1000))

    def test_missing_user_is_refused(self) -> None:
        self.assertIn("no `user`", ch.uid_problem(None) or "")
        self.assertIn("no `user`", ch.uid_problem("  ") or "")

    def test_root_is_refused(self) -> None:
        for user in ("0", "0:0", 0, "00"):
            self.assertIn("root", ch.uid_problem(user) or "", user)

    def test_name_is_refused(self) -> None:
        self.assertIn("numeric", ch.uid_problem("node") or "")
        self.assertIn("numeric", ch.uid_problem("root") or "")


class ServiceTests(unittest.TestCase):
    def test_good_service_has_no_findings(self) -> None:
        self.assertEqual(findings(), [])

    def assert_one(self, found: list[str], text: str) -> None:
        self.assertEqual(len(found), 1, found)
        self.assertIn(text, found[0])
        self.assertTrue(found[0].startswith("service web: "), found[0])

    def test_missing_user(self) -> None:
        self.assert_one(findings(user=None), "no `user`")

    def test_root_user(self) -> None:
        self.assert_one(findings(user="0"), "root")

    def test_writable_root_filesystem(self) -> None:
        self.assert_one(findings(read_only=None), "read_only")
        self.assert_one(findings(read_only=False), "read_only")

    def test_capabilities_not_dropped(self) -> None:
        self.assert_one(findings(cap_drop=None), "cap_drop")
        self.assert_one(findings(cap_drop=["NET_RAW"]), "cap_drop")

    def test_cap_drop_is_case_insensitive(self) -> None:
        self.assertEqual(findings(cap_drop=["all"]), [])

    def test_capability_added_back(self) -> None:
        self.assert_one(findings(cap_add=["NET_BIND_SERVICE"]), "cap_add")

    def test_no_new_privileges_missing(self) -> None:
        self.assert_one(findings(security_opt=None), "no-new-privileges")
        self.assert_one(findings(security_opt=["no-new-privileges:false"]), "no-new-privileges")

    def test_no_new_privileges_spellings(self) -> None:
        self.assertEqual(findings(security_opt=["no-new-privileges=true"]), [])
        self.assertEqual(findings(security_opt=["no-new-privileges"]), [])

    def test_unconfined_profile(self) -> None:
        found = findings(security_opt=["no-new-privileges:true", "seccomp=unconfined"])
        self.assert_one(found, "unconfined")

    def test_health_check_missing_or_disabled(self) -> None:
        self.assert_one(findings(healthcheck=None), "no health check")
        self.assert_one(findings(healthcheck={"disable": True}), "no health check")
        self.assert_one(findings(healthcheck={"test": ["NONE"]}), "disabled or empty")
        self.assert_one(findings(healthcheck={"interval": "5s"}), "disabled or empty")

    def test_privileged(self) -> None:
        self.assert_one(findings(privileged=True), "privileged")

    def test_host_namespaces(self) -> None:
        for key in ("network_mode", "pid", "ipc"):
            self.assert_one(findings(**{key: "host"}), f"`{key}: host`")

    def test_devices(self) -> None:
        self.assert_one(findings(devices=["/dev/kvm:/dev/kvm"]), "devices")

    def test_port_on_all_interfaces(self) -> None:
        port = {"target": 80, "published": "8080", "protocol": "tcp"}
        self.assert_one(findings(ports=[port]), "all interfaces")
        self.assert_one(findings(ports=[{**port, "host_ip": "0.0.0.0"}]), "0.0.0.0")

    def test_loopback_ports_pass(self) -> None:
        port = {"target": 80, "published": "8080", "protocol": "tcp"}
        self.assertEqual(findings(ports=[{**port, "host_ip": "::1"}]), [])

    def test_port_that_is_not_published_passes(self) -> None:
        self.assertEqual(findings(ports=[{"target": 8090, "protocol": "tcp"}]), [])
        self.assertEqual(findings(ports=["8090"]), [])

    def test_short_port_forms(self) -> None:
        self.assert_one(findings(ports=["8080:80"]), "all interfaces")
        self.assert_one(findings(ports=["0.0.0.0:8080:80/tcp"]), "0.0.0.0")
        self.assertEqual(findings(ports=["127.0.0.1:8080:80"]), [])
        self.assertEqual(findings(ports=["[::1]:8080:80"]), [])

    def test_writable_bind_mount(self) -> None:
        volume = {"type": "bind", "source": "/repo/data", "target": "/data"}
        self.assert_one(findings(volumes=[volume]), "writable")

    def test_short_volume_forms(self) -> None:
        self.assert_one(findings(volumes=["./data:/data"]), "writable")
        self.assertEqual(findings(volumes=["./conf:/conf:ro"]), [])
        self.assertEqual(findings(volumes=["data:/data"]), [])

    def test_docker_socket(self) -> None:
        volume = {"type": "bind", "source": "/var/run/docker.sock", "target": "/s", "read_only": True}
        self.assert_one(findings(volumes=[volume]), "Docker socket")

    def test_image_must_be_pinned_without_build(self) -> None:
        self.assert_one(findings(image="example/app:1.2.3"), "not pinned")
        self.assert_one(findings(image=None), "neither `image` nor `build`")

    def test_built_image_is_checked_in_its_dockerfile(self) -> None:
        self.assertEqual(findings(image="local/app:dev", build={"context": "."}), [])

    def test_several_findings_are_all_reported(self) -> None:
        found = findings(user=None, read_only=None, cap_drop=None)
        self.assertEqual(len(found), 3, found)


class ComposeTests(unittest.TestCase):
    def test_every_service_is_checked_and_named(self) -> None:
        config = {"services": {"good": service(), "bad": service(read_only=None)}}
        found = ch.check_compose(config, "compose.test.yml")
        self.assertEqual(len(found), 1)
        self.assertIn("compose.test.yml: service bad:", found[0])

    def test_no_services_is_a_finding(self) -> None:
        self.assertEqual(len(ch.check_compose({}, "c.yml")), 1)
        self.assertEqual(len(ch.check_compose({"services": {}}, "c.yml")), 1)


class DockerfileTests(unittest.TestCase):
    def test_good_dockerfile_passes(self) -> None:
        self.assertEqual(ch.check_dockerfile(GOOD_DOCKERFILE), [])

    def test_unpinned_from(self) -> None:
        text = GOOD_DOCKERFILE.replace(f"caddy:2.11.9-alpine@{DIGEST}", "caddy:2.11.9-alpine")
        found = ch.check_dockerfile(text, "D")
        self.assertEqual(len(found), 1, found)
        self.assertIn("not pinned", found[0])

    def test_first_stage_unpinned(self) -> None:
        text = GOOD_DOCKERFILE.replace(f"node:24.1.0-slim@{DIGEST}", "node:24")
        self.assertEqual(len(ch.check_dockerfile(text)), 1)

    def test_scratch_and_earlier_stage_are_fine(self) -> None:
        text = f"FROM node:1@{DIGEST} AS base\nFROM base AS final\nUSER 1000\n"
        self.assertEqual(ch.check_dockerfile(text), [])
        self.assertEqual(ch.check_dockerfile("FROM scratch\nUSER 1000"), [])

    def test_stage_alias_is_case_insensitive(self) -> None:
        text = f"FROM node:1@{DIGEST} as Base\nFROM base\nUSER 1000\n"
        self.assertEqual(ch.check_dockerfile(text), [])

    def test_variable_image_is_refused(self) -> None:
        found = ch.check_dockerfile("ARG IMG\nFROM ${IMG}\nUSER 1000")
        self.assertEqual(len(found), 1)
        self.assertIn("variable", found[0])

    def test_platform_flag_is_skipped(self) -> None:
        text = f"FROM --platform=linux/amd64 node:1@{DIGEST}\nUSER 1000"
        self.assertEqual(ch.check_dockerfile(text), [])

    def test_missing_user(self) -> None:
        text = GOOD_DOCKERFILE.replace("USER 65532:65532", "")
        found = ch.check_dockerfile(text)
        self.assertEqual(len(found), 1)
        self.assertIn("no USER", found[0])

    def test_user_of_an_earlier_stage_does_not_count(self) -> None:
        text = f"FROM node:1@{DIGEST} AS a\nUSER 1000\nFROM node:1@{DIGEST}\nRUN true\n"
        self.assertIn("no USER", ch.check_dockerfile(text)[0])

    def test_root_user(self) -> None:
        for user in ("root", "0", "0:0", "ROOT"):
            text = GOOD_DOCKERFILE.replace("USER 65532:65532", f"USER {user}")
            found = ch.check_dockerfile(text)
            self.assertEqual(len(found), 1, user)
            self.assertIn("runs as", found[0])

    def test_last_user_wins(self) -> None:
        text = GOOD_DOCKERFILE + "USER root\n"
        self.assertEqual(len(ch.check_dockerfile(text)), 1)

    def test_named_user_passes(self) -> None:
        text = GOOD_DOCKERFILE.replace("USER 65532:65532", "USER nonroot")
        self.assertEqual(ch.check_dockerfile(text), [])

    def test_continuation_lines_and_comments(self) -> None:
        text = (
            f"FROM node:1@{DIGEST}\nRUN a \\\n# comment inside\n && b\n"
            "# USER root\nUSER 1000\n"
        )
        self.assertEqual(ch.check_dockerfile(text), [])

    def test_empty_file(self) -> None:
        self.assertEqual(ch.check_dockerfile("# nothing\n", "D"), ["D: no FROM instruction"])


COMPOSE_TEXT = """
services:
  a:
    environment:
      HOST: ${STUFF_HOST:-app.localhost}
      PORT: "${STUFF_PORT:-8080}"
      NODEFAULT: ${STUFF_PLAIN}
"""

GOOD_ENV = """# The app host.
STUFF_HOST=app.localhost
# The port.
STUFF_PORT=8080
# Without a default.
STUFF_PLAIN=
"""


class EnvExampleTests(unittest.TestCase):
    def check(self, env: str, compose: str = COMPOSE_TEXT) -> list[str]:
        return ch.check_env_example(env, [compose])

    def test_good_file_passes(self) -> None:
        self.assertEqual(self.check(GOOD_ENV), [])

    def test_variable_not_documented(self) -> None:
        env = GOOD_ENV.replace("# The port.\nSTUFF_PORT=8080\n", "")
        found = self.check(env)
        self.assertEqual(len(found), 1, found)
        self.assertIn("STUFF_PORT is used", found[0])

    def test_documented_but_unused(self) -> None:
        found = self.check(GOOD_ENV + "# Extra.\nSTUFF_EXTRA=1\n")
        self.assertEqual(len(found), 1, found)
        self.assertIn("no compose file uses it", found[0])

    def test_default_must_match(self) -> None:
        found = self.check(GOOD_ENV.replace("STUFF_PORT=8080", "STUFF_PORT=9090"))
        self.assertEqual(len(found), 1, found)
        self.assertIn("differs", found[0])

    def test_comment_above_is_required(self) -> None:
        env = GOOD_ENV.replace("# The port.\n", "")
        found = self.check(env)
        self.assertEqual(len(found), 1, found)
        self.assertIn("no comment line", found[0])

    def test_blank_line_between_comment_and_variable_does_not_count(self) -> None:
        found = self.check(GOOD_ENV.replace("# The port.\n", "# The port.\n\n"))
        self.assertEqual(len(found), 1, found)

    def test_garbage_line(self) -> None:
        found = self.check(GOOD_ENV + "just words\n")
        self.assertTrue(any("not a comment" in f for f in found), found)

    def test_duplicate(self) -> None:
        found = self.check(GOOD_ENV + "# Again.\nSTUFF_PORT=8080\n")
        self.assertTrue(any("twice" in f for f in found), found)

    def test_secret_with_value(self) -> None:
        compose = COMPOSE_TEXT + "      X: ${STUFF_SMTP_PASSWORD:-}\n"
        for name in ("STUFF_SMTP_PASSWORD", "STUFF_API_KEY", "STUFF_TOKEN", "STUFF_CLIENT_SECRET"):
            compose_n = COMPOSE_TEXT + f"      X: ${{{name}:-hunter2}}\n"
            env = GOOD_ENV + f"# Secret.\n{name}=hunter2\n"
            found = self.check(env, compose_n)
            self.assertEqual(len(found), 1, (name, found))
            self.assertIn("secrets never go here", found[0])

    def test_secret_without_value_and_file_variant_pass(self) -> None:
        compose = COMPOSE_TEXT + "      X: ${STUFF_SMTP_PASSWORD}\n      Y: ${STUFF_SMTP_PASSWORD_FILE:-/run/secrets/smtp}\n"
        env = GOOD_ENV + "# Password.\nSTUFF_SMTP_PASSWORD=\n# Its file.\nSTUFF_SMTP_PASSWORD_FILE=/run/secrets/smtp\n"
        self.assertEqual(self.check(env, compose), [])

    def test_host_names_must_be_reserved(self) -> None:
        found = self.check(GOOD_ENV.replace("app.localhost", "app.realdomain.com"), COMPOSE_TEXT.replace("app.localhost", "app.realdomain.com"))
        self.assertEqual(len(found), 1, found)
        self.assertIn("not a reserved name", found[0])

    def test_reserved_host_names_pass(self) -> None:
        for host in ("a.localhost", "a.test", "example.com", "x.example.org", "a.invalid", "b.example", "sub.a.example.net"):
            env = GOOD_ENV.replace("app.localhost", host)
            self.assertEqual(self.check(env, COMPOSE_TEXT.replace("app.localhost", host)), [], host)

    def test_lookalike_of_reserved_name_is_refused(self) -> None:
        for host in ("notexample.com", "evil-localhost", "mylocalhost", "localhost", "example.com.evil.io"):
            env = GOOD_ENV.replace("app.localhost", host)
            found = self.check(env, COMPOSE_TEXT.replace("app.localhost", host))
            self.assertEqual(len(found), 1, host)

    def test_compose_variables(self) -> None:
        found = ch.compose_variables([COMPOSE_TEXT])
        self.assertEqual(found, {"STUFF_HOST": "app.localhost", "STUFF_PORT": "8080", "STUFF_PLAIN": None})

    def test_real_defaults_are_picked_up_from_a_later_file(self) -> None:
        found = ch.compose_variables(["${A}", "${A:-x}"])
        self.assertEqual(found, {"A": "x"})


def inspect_doc(**overrides: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "Id": "abc",
        "Name": "/proj-web-1",
        "Config": {"User": "65532:65532", "Labels": {"com.docker.compose.service": "web"}},
        "HostConfig": {
            "ReadonlyRootfs": True,
            "CapDrop": ["ALL"],
            "CapAdd": None,
            "SecurityOpt": ["no-new-privileges:true"],
            "Privileged": False,
            "NetworkMode": "proj_default",
            "PortBindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]},
        },
        "State": {"Running": True, "Status": "running", "Health": {"Status": "healthy"}},
    }
    for path, value in overrides.items():
        target = doc
        *parents, last = path.split(".")
        for part in parents:
            target = target[part]
        target[last] = value
    return doc


class RuntimeTests(unittest.TestCase):
    def one(self, uids: list[str] | None = None, **overrides: Any) -> list[str]:
        return ch.check_container(inspect_doc(**overrides), ["65532"] if uids is None else uids)

    def test_good_container(self) -> None:
        self.assertEqual(self.one(), [])

    def test_each_runtime_rule(self) -> None:
        cases = {
            "Config.User": ("", "no `user`"),
            "HostConfig.ReadonlyRootfs": (False, "writable"),
            "HostConfig.CapDrop": (None, "not dropped"),
            "HostConfig.CapAdd": (["SYS_ADMIN"], "added back"),
            "HostConfig.SecurityOpt": ([], "no-new-privileges"),
            "HostConfig.Privileged": (True, "privileged"),
            "HostConfig.NetworkMode": ("host", "host network"),
            "State.Running": (False, "not running"),
            "State.Health": ({"Status": "unhealthy"}, "'unhealthy'"),
            "HostConfig.PortBindings": ({"80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "80"}]}, "published on"),
        }
        for path, (value, text) in cases.items():
            found = self.one(**{path: value})
            self.assertEqual(len(found), 1, (path, found))
            self.assertIn(text, found[0], path)
            self.assertTrue(found[0].startswith("container web: "), found[0])

    def test_no_health_check_is_a_finding(self) -> None:
        found = self.one(**{"State.Health": {}})
        self.assertEqual(len(found), 1)
        self.assertIn("None", found[0])

    def test_empty_host_ip_means_all_interfaces(self) -> None:
        found = self.one(**{"HostConfig.PortBindings": {"80/tcp": [{"HostIp": "", "HostPort": "80"}]}})
        self.assertEqual(len(found), 1)

    def test_unpublished_port_is_fine(self) -> None:
        self.assertEqual(self.one(**{"HostConfig.PortBindings": {"80/tcp": None}}), [])

    def test_process_as_root(self) -> None:
        for uid in ("0", "root"):
            found = self.one(uids=["65532", uid])
            self.assertEqual(len(found), 1, uid)
            self.assertIn("uid 0", found[0])

    def test_no_process_is_a_finding(self) -> None:
        found = self.one(uids=[])
        self.assertEqual(found, ["container web: no process found"])

    def test_missing_service_container(self) -> None:
        found = ch.check_runtime([inspect_doc()], {"abc": ["65532"]}, ["web", "mail"])
        self.assertEqual(found, ["service mail: no container is running"])

    def test_all_services_present(self) -> None:
        self.assertEqual(ch.check_runtime([inspect_doc()], {"abc": ["65532"]}, ["web"]), [])


class StaticCheckTests(unittest.TestCase):
    def make_repo(self, root: pathlib.Path, service_changes: dict[str, Any] | None = None) -> dict[str, Any]:
        (root / "docker").mkdir()
        (root / "docker" / "Dockerfile").write_text(GOOD_DOCKERFILE, encoding="utf-8")
        (root / "compose.dev.yml").write_text(COMPOSE_TEXT, encoding="utf-8")
        (root / ".env.example").write_text(GOOD_ENV, encoding="utf-8")
        return {"compose.dev.yml": {"services": {"web": service(**(service_changes or {}))}}}

    def test_good_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            resolved = self.make_repo(pathlib.Path(tmp))
            self.assertEqual(ch.static_check(pathlib.Path(tmp), resolved), [])

    def test_bad_service_is_found(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            resolved = self.make_repo(pathlib.Path(tmp), {"read_only": None})
            found = ch.static_check(pathlib.Path(tmp), resolved)
            self.assertEqual(len(found), 1, found)
            self.assertIn("compose.dev.yml: service web", found[0])

    def test_new_unhardened_dockerfile_is_found_without_registering_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            resolved = self.make_repo(root)
            (root / "crates" / "app").mkdir(parents=True)
            (root / "crates" / "app" / "Dockerfile").write_text("FROM rust:1\n", encoding="utf-8")
            found = ch.static_check(root, resolved)
            self.assertEqual(len(found), 2, found)  # unpinned FROM and no USER
            self.assertTrue(all("crates/app/Dockerfile" in f for f in found))

    def test_new_compose_file_needs_a_resolved_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            resolved = self.make_repo(root)
            (root / "compose.prod.yml").write_text("services: {}\n", encoding="utf-8")
            found = ch.static_check(root, resolved)
            self.assertIn("compose.prod.yml: no resolved configuration supplied", found)

    def test_missing_env_example(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            resolved = self.make_repo(root)
            (root / ".env.example").unlink()
            self.assertEqual(ch.static_check(root, resolved), [".env.example is missing"])

    def test_vendor_directories_are_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            resolved = self.make_repo(root)
            (root / "web" / "node_modules" / "pkg").mkdir(parents=True)
            (root / "web" / "node_modules" / "pkg" / "Dockerfile").write_text("FROM x\n", encoding="utf-8")
            self.assertEqual(ch.static_check(root, resolved), [])

    def test_empty_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(len(ch.static_check(pathlib.Path(tmp), {})), 1)

    def test_file_name_patterns(self) -> None:
        for name in ("compose.yml", "compose.dev.yml", "docker-compose.yaml", "docker-compose.prod.yml"):
            self.assertTrue(ch.COMPOSE_NAME.match(name), name)
        for name in ("composer.json", "compose.md", "my-compose.yml"):
            self.assertFalse(ch.COMPOSE_NAME.match(name), name)
        for name in ("Dockerfile", "Dockerfile.edge", "app.Dockerfile", "Containerfile"):
            self.assertTrue(ch.DOCKERFILE_NAME.match(name), name)
        for name in ("dockerfile-notes", "NotADockerfile", "Dockerfilex"):
            self.assertFalse(ch.DOCKERFILE_NAME.match(name), name)


class RepositoryTests(unittest.TestCase):
    """The real dev stack of this repository, without Docker: the compose file as text."""

    def test_env_example_matches_compose_dev(self) -> None:
        compose = (ch.REPO / "compose.dev.yml").read_text(encoding="utf-8")
        env = (ch.REPO / ".env.example").read_text(encoding="utf-8")
        self.assertEqual(ch.check_env_example(env, [compose]), [])

    def test_dockerfiles_of_the_repository_pass(self) -> None:
        paths = ch.find_files(ch.REPO, ch.DOCKERFILE_NAME)
        self.assertTrue(paths, "expected at least docker/caddy/Dockerfile")
        for path in paths:
            self.assertEqual(ch.check_dockerfile(path.read_text(encoding="utf-8"), path.name), [], str(path))

    def test_secrets_directory_is_ignored_by_git(self) -> None:
        lines = (ch.REPO / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("/secrets/", lines)
        self.assertIn(".env", lines)
        self.assertIn("!.env.example", lines)


class CommandLineTests(unittest.TestCase):
    def test_static_with_resolved_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            resolved = StaticCheckTests().make_repo(root)
            resolved_file = root / "resolved.json"
            resolved_file.write_text(json.dumps(resolved), encoding="utf-8")
            code = ch.main(["static", "--root", str(root), "--resolved", str(resolved_file)])
            self.assertEqual(code, 0)
            resolved["compose.dev.yml"]["services"]["web"].pop("user")
            resolved_file.write_text(json.dumps(resolved), encoding="utf-8")
            code = ch.main(["static", "--root", str(root), "--resolved", str(resolved_file)])
            self.assertEqual(code, 1)

    def test_unreadable_resolved_file_is_a_setup_error(self) -> None:
        self.assertEqual(ch.main(["static", "--resolved", "/nonexistent/resolved.json"]), 2)


if __name__ == "__main__":
    unittest.main()
