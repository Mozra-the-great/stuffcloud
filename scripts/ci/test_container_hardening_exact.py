#!/usr/bin/env python3
"""Exact-output tests of check_container_hardening.py: every message, every boundary, every
command it would run.

`test_container_hardening.py` breaks one rule at a time and looks for a keyword. This file pins
what a mutation of the code would change without breaking that: the whole text of each finding,
how ports, volumes and image references are taken apart, and the exact `docker` commands. The
Docker calls go through `run`, which is replaced by a recorder here, so no Docker is needed.

    python3 -m unittest discover -s scripts/ci -p "test_*.py"
"""
from __future__ import annotations

import contextlib
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from typing import Any
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import check_container_hardening as ch  # noqa: E402
from test_container_hardening import COMPOSE_TEXT, DIGEST, GOOD_DOCKERFILE, GOOD_ENV, service  # noqa: E402


def findings(**changes: Any) -> list[str]:
    return ch.check_service("web", service(**changes))


class HostTests(unittest.TestCase):
    def test_reserved_names(self) -> None:
        for host in ("example.com", "EXAMPLE.COM", "example.com.", "a.example.org", "x.example.net", "box.test", "x.y.invalid", "app.localhost", "a.b.example"):
            self.assertTrue(ch.is_reserved_host(host), host)

    def test_other_names(self) -> None:
        for host in ("notexample.com", "example.com.evil.net", "app.example.de", "localhost.net", "corp"):
            self.assertFalse(ch.is_reserved_host(host), host)

    def test_a_single_label_is_not_reserved_by_its_tld_rule(self) -> None:
        self.assertFalse(ch.is_reserved_host("test"))
        self.assertFalse(ch.is_reserved_host("example"))
        self.assertFalse(ch.is_reserved_host("localhost"))


class ImageMessageTests(unittest.TestCase):
    def test_messages(self) -> None:
        self.assertEqual(
            ch.image_problem("example/app:1"),
            "'example/app:1' is not pinned by digest (name:tag@sha256:<64 hex digits>)",
        )
        self.assertEqual(
            ch.image_problem(f"example/app@{DIGEST}"),
            f"'example/app@{DIGEST}' has a digest but no tag (Dependabot and readers need the tag)",
        )
        self.assertEqual(
            ch.image_problem(f"example/app:latest@{DIGEST}"),
            f"'example/app:latest@{DIGEST}' uses the tag 'latest'; pin a version",
        )
        self.assertEqual(
            ch.image_problem(f"example/app:@{DIGEST}"),
            f"'example/app:@{DIGEST}' uses the tag '(empty)'; pin a version",
        )

    def test_the_tag_is_what_follows_the_first_colon_of_the_last_path_part(self) -> None:
        for name in ("app:latest:x", "app:x:latest", "reg.example:5000/team/app:latest:x", "reg.example:5000/team/app:1"):
            self.assertIsNone(ch.image_problem(f"{name}@{DIGEST}"), name)
        self.assertIsNotNone(ch.image_problem(f"a/b/c:latest@{DIGEST}"))
        self.assertIn("no tag", ch.image_problem(f"reg.example:5000/a/b/c@{DIGEST}") or "")
        self.assertIn("no tag", ch.image_problem(f"reg.example:5000/a/b@{DIGEST}") or "")


class UidMessageTests(unittest.TestCase):
    def test_messages(self) -> None:
        self.assertEqual(
            ch.uid_problem(None), "no `user` set (the container would run as the image default, often root)"
        )
        self.assertEqual(
            ch.uid_problem("node"), "user 'node' is not a numeric uid (a name cannot be checked without the image)"
        )
        self.assertEqual(ch.uid_problem("0:1000"), "user '0:1000' is root")

    def test_only_the_part_before_the_first_colon_is_the_uid(self) -> None:
        self.assertIsNone(ch.uid_problem("1000:0"))
        self.assertIsNone(ch.uid_problem("1000:a:b"))
        self.assertEqual(ch.uid_problem(" 0 :1"), "user ' 0 :1' is root")
        self.assertIsNotNone(ch.uid_problem("a:1000"))


class PortTests(unittest.TestCase):
    def test_long_form(self) -> None:
        self.assertEqual(ch._port_host_ip({"published": "8080", "host_ip": "127.0.0.1"}), (True, "127.0.0.1"))
        self.assertEqual(ch._port_host_ip({"published": 8080}), (True, ""))
        self.assertEqual(ch._port_host_ip({"published": ""}), (False, ""))
        self.assertEqual(ch._port_host_ip({"published": None, "host_ip": "1.2.3.4"}), (False, "1.2.3.4"))
        self.assertEqual(ch._port_host_ip({"target": 80}), (False, ""))

    def test_short_form(self) -> None:
        self.assertEqual(ch._port_host_ip("8080"), (False, ""))
        self.assertEqual(ch._port_host_ip("8080/tcp"), (False, ""))
        self.assertEqual(ch._port_host_ip("8080:80"), (True, ""))
        self.assertEqual(ch._port_host_ip("8080:80/udp"), (True, ""))
        self.assertEqual(ch._port_host_ip("127.0.0.1:8080:80/tcp"), (True, "127.0.0.1"))
        self.assertEqual(ch._port_host_ip("[::1]:8080:80"), (True, "::1"))
        self.assertEqual(ch._port_host_ip("Xhost:8080:80"), (True, "Xhost"))
        self.assertEqual(ch._port_host_ip(8080), (False, ""))

    def test_as_list(self) -> None:
        self.assertEqual(ch._as_list(None), [])
        self.assertEqual(ch._as_list(["a"]), ["a"])
        self.assertEqual(ch._as_list("a"), ["a"])
        original = ["a"]
        self.assertIsNot(ch._as_list(original), original)


class ServiceMessageTests(unittest.TestCase):
    def test_every_rule_has_its_exact_text(self) -> None:
        cases: dict[str, tuple[dict[str, Any], list[str]]] = {
            "user": ({"user": None}, ["no `user` set (the container would run as the image default, often root)"]),
            "read_only": ({"read_only": None}, ["`read_only: true` is missing (root filesystem must be read-only)"]),
            "cap_drop": ({"cap_drop": ["NET_RAW"]}, ["`cap_drop: [ALL]` is missing"]),
            "cap_add": ({"cap_add": ["NET_ADMIN"]}, ["`cap_add` ['NET_ADMIN'] gives capabilities back"]),
            "no-new-privileges": ({"security_opt": None}, ["`security_opt: [no-new-privileges:true]` is missing"]),
            "unconfined": (
                {"security_opt": ["no-new-privileges:true", "seccomp=unconfined"]},
                ["security option 'seccomp:unconfined' switches a sandbox off"],
            ),
            "no health check": ({"healthcheck": None}, ["no health check"]),
            "disabled": ({"healthcheck": {"disable": True}}, ["no health check"]),
            "none": ({"healthcheck": {"test": ["NONE"]}}, ["health check is disabled or empty"]),
            "empty": ({"healthcheck": {"interval": "5s"}}, ["health check is disabled or empty"]),
            "privileged": ({"privileged": True}, ["`privileged: true`"]),
            "devices": ({"devices": ["/dev/kvm"]}, ["`devices` hands host devices to the container"]),
            "image": ({"image": None}, ["neither `image` nor `build`"]),
        }
        for label, (changes, expected) in cases.items():
            with self.subTest(label):
                self.assertEqual(findings(**changes), [f"service web: {text}" for text in expected])

    def test_every_host_namespace_key(self) -> None:
        for key in ("network_mode", "pid", "ipc", "userns_mode", "uts", "cgroup"):
            with self.subTest(key):
                self.assertEqual(
                    findings(**{key: "host"}), [f"service web: `{key}: host` shares the host namespace"]
                )
                self.assertEqual(findings(**{key: "HOST"}), [f"service web: `{key}: host` shares the host namespace"])
                self.assertEqual(findings(**{key: "bridge"}), [])
                self.assertEqual(findings(**{key: ""}), [])

    def test_a_published_port_names_where_it_is_published(self) -> None:
        port = {"target": 80, "published": "8080", "protocol": "tcp"}
        self.assertEqual(
            findings(ports=[port]),
            ["service web: port {'target': 80, 'published': '8080', 'protocol': 'tcp'} is published on all "
             "interfaces; bind it to 127.0.0.1"],
        )
        self.assertEqual(
            findings(ports=["Xhost:8080:80"]),
            ["service web: port 'Xhost:8080:80' is published on Xhost; bind it to 127.0.0.1"],
        )
        self.assertEqual(
            findings(ports=["localhost:8080:80", "[::1]:8080:80", "127.0.0.1:1:2"]), []
        )

    def test_volumes_in_both_forms(self) -> None:
        self.assertEqual(
            findings(volumes=[{"type": "bind", "source": "/data", "target": "/d"}]),
            ["service web: bind mount '/data' is writable; mount it read-only"],
        )
        self.assertEqual(
            findings(volumes=[{"type": "bind", "target": "/d", "read_only": True}]), []
        )
        self.assertEqual(
            findings(volumes=[{"type": "bind", "target": "/d"}]),
            ["service web: bind mount '' is writable; mount it read-only"],
        )
        self.assertEqual(
            findings(volumes=[{"type": "bind", "source": "/data", "target": "/d", "read_only": False}]),
            ["service web: bind mount '/data' is writable; mount it read-only"],
        )
        self.assertEqual(
            findings(volumes=[{"type": "volume", "source": "data", "target": "/d"}]), []
        )
        self.assertEqual(
            findings(volumes=[{"type": "volume", "target": "/d"}]), []
        )
        for source in ("/abs", "./rel", "~/home"):
            self.assertEqual(
                findings(volumes=[f"{source}:/d"]),
                [f"service web: bind mount {source!r} is writable; mount it read-only"],
            )
            self.assertEqual(findings(volumes=[f"{source}:/d:ro"]), [])
        self.assertEqual(findings(volumes=["named:/d"]), [])
        self.assertEqual(findings(volumes=["named:/d:ro"]), [])
        self.assertEqual(findings(volumes=["../up:/d"]), ["service web: bind mount '../up' is writable; mount it read-only"])
        self.assertEqual(findings(volumes=["namedvolume"]), [])

    def test_the_docker_socket_is_refused_in_either_form(self) -> None:
        expected = ["service web: the Docker socket is mounted (full control of the host)"]
        self.assertEqual(
            findings(volumes=[{"type": "bind", "source": "/var/run/docker.sock", "target": "/s", "read_only": True}]),
            expected,
        )
        self.assertEqual(findings(volumes=["/var/run/docker.sock:/s:ro"]), expected)
        self.assertEqual(findings(volumes=["docker.sock:/s"]), expected)

    def test_cap_drop_matches_all_in_any_case_among_others(self) -> None:
        self.assertEqual(findings(cap_drop=["NET_RAW", "all"]), [])
        self.assertEqual(findings(cap_drop="ALL"), [])

    def test_a_service_with_a_build_needs_no_image(self) -> None:
        self.assertEqual(findings(image=None, build={"context": "."}), [])

    def test_the_image_problem_is_reported_for_the_image(self) -> None:
        self.assertEqual(
            findings(image="example/app:1"),
            ["service web: 'example/app:1' is not pinned by digest (name:tag@sha256:<64 hex digits>)"],
        )

    def test_compose_findings_carry_the_file_and_are_sorted_by_service(self) -> None:
        config = {"services": {"b": service(read_only=None), "a": service(user=None)}}
        self.assertEqual(
            ch.check_compose(config, "c.yml"),
            [
                "c.yml: service a: no `user` set (the container would run as the image default, often root)",
                "c.yml: service b: `read_only: true` is missing (root filesystem must be read-only)",
            ],
        )
        self.assertEqual(ch.check_compose({}, "c.yml"), ["c.yml: no services"])
        self.assertEqual(ch.check_compose({"services": {}}), ["compose: no services"])
        self.assertEqual(ch.check_compose({"services": []}, "c.yml"), ["c.yml: no services"])


class DockerfileDetailTests(unittest.TestCase):
    def test_logical_lines(self) -> None:
        text = "# c\n\nFROM a\nRUN x \\\n  y \\\n# inside\n  z\n  # indented comment\nUSER 1\nCMD last \\"
        self.assertEqual(ch.logical_lines(text), ["FROM a", "RUN x  y  z", "USER 1", "CMD last"])
        self.assertEqual(ch.logical_lines("RUN a\\\nb"), ["RUN a b"])
        self.assertEqual(ch.logical_lines(""), [])
        self.assertEqual(ch.logical_lines("   \n\t\n"), [])
        self.assertEqual(ch.logical_lines("RUN a \\\n\nRUN b"), ["RUN a", "RUN b"])
        self.assertEqual(ch.logical_lines("A #not a comment"), ["A #not a comment"])

    def test_messages(self) -> None:
        self.assertEqual(ch.check_dockerfile("", "D"), ["D: no FROM instruction"])
        self.assertEqual(
            ch.check_dockerfile(f"FROM node:1@{DIGEST}\nRUN true\n", "D"),
            ["D: the final stage has no USER instruction (it would run as root)"],
        )
        self.assertEqual(
            ch.check_dockerfile(f"FROM node:1@{DIGEST}\nUSER root\n", "D"), ["D: the final stage runs as 'root'"]
        )
        self.assertEqual(
            ch.check_dockerfile(f"FROM node:1@{DIGEST}\nUSER $APP_USER\n", "D"),
            ["D: USER '$APP_USER' uses a variable; write the user out"],
        )
        self.assertEqual(
            ch.check_dockerfile("FROM ${IMG}\nUSER 1\n", "D"),
            ["D: FROM '${IMG}' uses a variable; write the pinned reference out"],
        )
        self.assertEqual(
            ch.check_dockerfile("FROM node:1\nUSER 1\n", "D"),
            ["D: FROM 'node:1' is not pinned by digest (name:tag@sha256:<64 hex digits>)"],
        )

    def test_the_user_is_the_part_before_the_first_colon_and_in_any_case(self) -> None:
        self.assertEqual(ch.check_dockerfile(f"FROM node:1@{DIGEST}\nUSER 1000:0\n"), [])
        self.assertEqual(ch.check_dockerfile(f"FROM node:1@{DIGEST}\nUSER app:root\n"), [])
        self.assertEqual(ch.check_dockerfile(f"FROM node:1@{DIGEST}\nUSER Root\n"), ["Dockerfile: the final stage runs as 'Root'"])
        self.assertEqual(
            ch.check_dockerfile(f"FROM node:1@{DIGEST}\nUSER ${{U}}:1\n"),
            ["Dockerfile: USER '${U}:1' uses a variable; write the user out"],
        )
        self.assertEqual(
            ch.check_dockerfile(f"FROM node:1@{DIGEST}\nUSER :1\n"), ["Dockerfile: the final stage runs as ':1'"]
        )

    def test_a_from_without_an_image_and_stage_counting(self) -> None:
        self.assertEqual(
            ch.check_dockerfile("FROM\nUSER 1\n", "D"),
            ["D: FROM '' is not pinned by digest (name:tag@sha256:<64 hex digits>)"],
        )
        # Two stages: the user of the first one does not count for the second.
        text = f"FROM node:1@{DIGEST}\nUSER 1\nFROM node:2@{DIGEST}\n"
        self.assertEqual(ch.check_dockerfile(text, "D"), ["D: the final stage has no USER instruction (it would run as root)"])
        # A Dockerfile without FROM never reports the USER problem.
        self.assertEqual(ch.check_dockerfile("USER root", "D"), ["D: no FROM instruction"])

    def test_an_alias_needs_as_in_the_third_position(self) -> None:
        text = f"FROM node:1@{DIGEST} AS base\nFROM base\nUSER 1\n"
        self.assertEqual(ch.check_dockerfile(text), [])
        text = f"FROM node:1@{DIGEST} base\nFROM base\nUSER 1\n"
        self.assertEqual(len(ch.check_dockerfile(text)), 1)


class EnvExampleDetailTests(unittest.TestCase):
    def test_parse_messages_and_line_numbers(self) -> None:
        values, found = ch.parse_env_example("# c\nA=1\nA=2\nB=3\nnot a variable\n")
        self.assertEqual(values, {"A": "2", "B": "3"})
        self.assertEqual(
            found,
            [
                ".env.example:3: A is defined twice",
                ".env.example:3: A has no comment line above it",
                ".env.example:4: B has no comment line above it",
                ".env.example:5: not a comment and not NAME=value: 'not a variable'",
            ],
        )

    def test_the_first_line_needs_a_comment_above_it(self) -> None:
        self.assertEqual(
            ch.parse_env_example("A=1\n")[1], [".env.example:1: A has no comment line above it"]
        )
        self.assertEqual(ch.parse_env_example("# c\nA=1\n")[1], [])
        self.assertEqual(ch.parse_env_example("# c\n\nA=1\n")[1], [".env.example:3: A has no comment line above it"])

    def test_values_are_stripped(self) -> None:
        self.assertEqual(ch.parse_env_example("# c\n  A=  x  \n")[0], {"A": "x"})

    def test_compose_variables_keep_the_first_default(self) -> None:
        texts = ["${A:-one} ${B} ${C-x}", "${A:-two} ${B:-late}", "${D:-}"]
        self.assertEqual(ch.compose_variables(texts), {"A": "one", "B": "late", "C": "x", "D": ""})
        self.assertEqual(ch.compose_variables(["${B}", "${B:-1}", "${B:-2}"]), {"B": "1"})

    def test_messages(self) -> None:
        env = "# a\nSTUFF_HOST=app.localhost\n# b\nSTUFF_PORT=9090\n# c\nSTUFF_PASSWORD=hunter2\n# d\nOTHER_HOST=corp.example.de\n# e\nUNUSED=1\n# f\nSTUFF_TOKEN_FILE=/run/x\n"
        compose = "${STUFF_HOST:-app.localhost} ${STUFF_PORT:-8080} ${STUFF_PASSWORD} ${OTHER_HOST} ${MISSING} ${STUFF_TOKEN_FILE}"
        self.assertEqual(
            ch.check_env_example(env, [compose]),
            [
                ".env.example: MISSING is used by a compose file but not documented",
                ".env.example: STUFF_PORT='9090' differs from the compose default '8080'",
                ".env.example: UNUSED is documented but no compose file uses it",
                ".env.example: STUFF_PASSWORD looks like a secret and has a value; secrets never go here",
                ".env.example: OTHER_HOST='corp.example.de' is not a reserved name (RFC 2606 / 6761)",
            ],
        )

    def test_a_secret_file_reference_and_empty_values_are_fine(self) -> None:
        env = "# a\nSTUFF_TOKEN_FILE=/run/secrets/t\n# b\nSTUFF_PASSWORD=\n# c\nSTUFF_HOST=\n"
        compose = "${STUFF_TOKEN_FILE} ${STUFF_PASSWORD} ${STUFF_HOST}"
        self.assertEqual(ch.check_env_example(env, [compose]), [])

    def test_the_documented_example_passes(self) -> None:
        self.assertEqual(ch.check_env_example(GOOD_ENV, [COMPOSE_TEXT]), [])


class ContainerMessageTests(unittest.TestCase):
    GOOD: dict[str, Any] = {
        "Name": "/stuff-web-1",
        "Config": {"User": "65532:65532", "Labels": {"com.docker.compose.service": "web"}},
        "HostConfig": {
            "ReadonlyRootfs": True,
            "CapDrop": ["ALL"],
            "SecurityOpt": ["no-new-privileges:true"],
            "NetworkMode": "default",
            "PortBindings": {"80/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]},
        },
        "State": {"Running": True, "Status": "running", "Health": {"Status": "healthy"}},
    }

    def info(self, **paths: Any) -> dict[str, Any]:
        import copy

        result = copy.deepcopy(self.GOOD)
        for path, value in paths.items():
            section, _, key = path.partition("__")
            if section == "top":
                target = result
            else:
                target = result[section]
            if value is None:
                target.pop(key, None)
            else:
                target[key] = value
        return result

    def test_a_good_container_has_no_finding(self) -> None:
        self.assertEqual(ch.check_container(self.GOOD, ["65532"]), [])

    def test_every_rule_has_its_exact_text(self) -> None:
        cases = {
            "writable": (self.info(HostConfig__ReadonlyRootfs=False), "container web: root filesystem is writable"),
            "capdrop": (
                self.info(HostConfig__CapDrop=["NET_RAW"]),
                "container web: capabilities are not dropped (CapDrop lacks ALL)",
            ),
            "capadd": (
                self.info(HostConfig__CapAdd=["NET_ADMIN"]),
                "container web: capabilities added back: ['NET_ADMIN']",
            ),
            "nnp": (self.info(HostConfig__SecurityOpt=[]), "container web: no-new-privileges is not set"),
            "privileged": (self.info(HostConfig__Privileged=True), "container web: runs privileged"),
            "host": (self.info(HostConfig__NetworkMode="host"), "container web: uses the host network"),
            "stopped": (
                self.info(State__Running=False, State__Status="exited"),
                "container web: is not running (status 'exited')",
            ),
            "unhealthy": (
                self.info(State__Health={"Status": "starting"}),
                "container web: health status is 'starting', expected 'healthy'",
            ),
            "nohealth": (
                self.info(State__Health=None),
                "container web: health status is None, expected 'healthy'",
            ),
            "root": (self.info(Config__User="0"), "container web: user '0' is root"),
        }
        for label, (info, expected) in cases.items():
            with self.subTest(label):
                self.assertEqual(ch.check_container(info, ["65532"]), [expected])

    def test_ports_name_where_they_are_published(self) -> None:
        for host_ip, where in (("0.0.0.0", "'0.0.0.0'"), ("", "'all interfaces'"), (None, "'all interfaces'")):
            with self.subTest(host_ip):
                info = self.info(HostConfig__PortBindings={"80/tcp": [{"HostIp": host_ip, "HostPort": "80"}]})
                if host_ip in ("", None):
                    # An empty host address means every interface.
                    self.assertEqual(
                        ch.check_container(info, ["65532"]), [f"container web: a port is published on {where}"]
                    )
                else:
                    self.assertEqual(
                        ch.check_container(info, ["65532"]), [f"container web: a port is published on {where}"]
                    )
        for host_ip in ("127.0.0.1", "::1", "localhost"):
            info = self.info(HostConfig__PortBindings={"80/tcp": [{"HostIp": host_ip}]})
            self.assertEqual(ch.check_container(info, ["65532"]), [], host_ip)
        self.assertEqual(
            ch.check_container(self.info(HostConfig__PortBindings={"80/tcp": None}), ["65532"]), []
        )

    def test_the_processes_are_checked(self) -> None:
        self.assertEqual(ch.check_container(self.GOOD, []), ["container web: no process found"])
        self.assertEqual(
            ch.check_container(self.GOOD, ["65532", "0", "0", "root"]),
            ["container web: a process runs as uid 0", "container web: a process runs as uid 0"],
        )

    def test_the_name_is_the_compose_service_or_else_the_container_name(self) -> None:
        info = self.info(Config__Labels={}, HostConfig__ReadonlyRootfs=False)
        self.assertEqual(ch.check_container(info, ["1"]), ["container stuff-web-1: root filesystem is writable"])
        info = self.info(Config__Labels={}, HostConfig__ReadonlyRootfs=False)
        del info["Name"]
        self.assertEqual(ch.check_container(info, ["1"]), ["container ?: root filesystem is writable"])
        info = self.info(Config__Labels={}, HostConfig__ReadonlyRootfs=False, top__Name="//a/b")
        self.assertEqual(ch.check_container(info, ["1"]), ["container a/b: root filesystem is writable"])
        info = self.info(Config__Labels={}, HostConfig__ReadonlyRootfs=False, top__Name="/Xweb")
        self.assertEqual(ch.check_container(info, ["1"]), ["container Xweb: root filesystem is writable"])
        info = self.info(Config__Labels={}, HostConfig__ReadonlyRootfs=False, top__Name="a/")
        self.assertEqual(ch.check_container(info, ["1"]), ["container a/: root filesystem is writable"])

    def test_check_runtime_matches_processes_by_id_and_names_missing_services(self) -> None:
        good = {**self.GOOD, "Id": "abc"}
        self.assertEqual(ch.check_runtime([good], {"abc": ["65532"]}, ["web"]), [])
        self.assertEqual(
            ch.check_runtime([good], {"abc": ["65532"]}, ["web", "db"]), ["service db: no container is running"]
        )
        self.assertEqual(ch.check_runtime([good], {}, ["web"]), ["container web: no process found"])
        self.assertEqual(ch.check_runtime([good], {"other": ["1"]}, ["web"]), ["container web: no process found"])
        bad = {**self.info(HostConfig__ReadonlyRootfs=False), "Id": "def"}
        self.assertEqual(
            ch.check_runtime([good, bad], {"abc": ["1"], "def": ["1"]}, ["web"]),
            ["container web: root filesystem is writable"],
        )
        self.assertEqual(ch.check_runtime([], {}, []), [])


class FakeDocker:
    """Replaces `run`: records every command and answers from a table."""

    def __init__(self, answers: dict[tuple[str, ...], str]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, *args: str) -> str:
        self.calls.append(args)
        return self.answers[args]


class CommandTests(unittest.TestCase):
    def test_run_passes_the_arguments_and_returns_stdout(self) -> None:
        done = subprocess.CompletedProcess([], 0, stdout="out", stderr="")
        with mock.patch.object(ch.subprocess, "run", return_value=done) as run:
            self.assertEqual(ch.run("docker", "ps"), "out")
        run.assert_called_once_with(
            ("docker", "ps"), check=False, capture_output=True, text=True, timeout=300
        )

    def test_a_failing_command_is_a_setup_error_with_its_stderr(self) -> None:
        done = subprocess.CompletedProcess([], 1, stdout="", stderr=" no daemon \n")
        with mock.patch.object(ch.subprocess, "run", return_value=done), self.assertRaises(ch.SetupError) as caught:
            ch.run("docker", "ps", "-a")
        self.assertEqual(str(caught.exception), "docker ps -a failed: no daemon")

    def test_a_missing_or_stuck_command_is_a_setup_error(self) -> None:
        for error in (OSError("not found"), subprocess.TimeoutExpired(["docker"], 300)):
            with self.subTest(error):
                with mock.patch.object(ch.subprocess, "run", side_effect=error), self.assertRaises(ch.SetupError) as caught:
                    ch.run("docker", "ps")
                self.assertEqual(str(caught.exception), f"cannot run docker ps: {error}")
                self.assertIs(caught.exception.__cause__, error)

    def test_parse_top_uids_skips_the_header_and_takes_the_second_column(self) -> None:
        output = "PID UID\n1 0\n7 65532\n\nnonsense\n9 1000 extra\n"
        self.assertEqual(ch.parse_top_uids(output), ["0", "65532", "1000"])
        self.assertEqual(ch.parse_top_uids("PID UID\n"), [])
        self.assertEqual(ch.parse_top_uids(""), [])
        self.assertEqual(ch.parse_top_uids("5 6\n"), [])

    def test_find_files_skips_build_output_and_the_mutation_copy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            for relative in ("compose.yml", "sub/compose.dev.yml", "node_modules/compose.yml", "mutants/compose.yml", ".git/compose.yml", "x/target/compose.yml", "notcompose.yml"):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("x", encoding="utf-8")
            found = ch.find_files(root, ch.COMPOSE_NAME)
        self.assertEqual([path.relative_to(root).as_posix() for path in found], ["compose.yml", "sub/compose.dev.yml"])

    def test_the_runtime_check_runs_exactly_these_commands(self) -> None:
        compose = pathlib.Path("some") / "compose.yml"
        info = [{**ContainerMessageTests.GOOD, "Id": "id1"}, {**ContainerMessageTests.GOOD, "Id": "id2"}]
        fake = FakeDocker(
            {
                ("docker", "compose", "-f", str(compose), "config", "--services"): "web\n\nweb\n",
                ("docker", "ps", "-a", "-q", "--filter", "label=com.docker.compose.project=proj"): "id1\nid2\n",
                ("docker", "inspect", "id1", "id2"): json.dumps(info),
                ("docker", "top", "id1", "-eo", "pid,uid"): "PID UID\n1 65532\n",
                ("docker", "top", "id2", "-eo", "pid,uid"): "PID UID\n1 0\n",
            }
        )
        with mock.patch.object(ch, "run", fake):
            found = ch.runtime_check(compose, "proj")
        self.assertEqual(found, ["container web: a process runs as uid 0"])
        self.assertEqual(
            fake.calls,
            [
                ("docker", "compose", "-f", str(compose), "config", "--services"),
                ("docker", "ps", "-a", "-q", "--filter", "label=com.docker.compose.project=proj"),
                ("docker", "inspect", "id1", "id2"),
                ("docker", "top", "id1", "-eo", "pid,uid"),
                ("docker", "top", "id2", "-eo", "pid,uid"),
            ],
        )

    def test_a_project_without_containers_is_reported(self) -> None:
        compose = pathlib.Path("compose.yml")
        fake = FakeDocker(
            {
                ("docker", "compose", "-f", str(compose), "config", "--services"): "web\n",
                ("docker", "ps", "-a", "-q", "--filter", "label=com.docker.compose.project=proj"): "\n",
            }
        )
        with mock.patch.object(ch, "run", fake):
            self.assertEqual(ch.runtime_check(compose, "proj"), ["no container of project 'proj' found"])
        self.assertEqual(len(fake.calls), 2)


class StaticCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.root = pathlib.Path(self._dir.name)

    def write(self, relative: str, text: str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_nothing_to_check(self) -> None:
        self.assertEqual(ch.static_check(self.root, None), ["nothing to check: no compose file and no Dockerfile found"])

    def test_one_kind_of_file_alone_is_enough(self) -> None:
        self.write("Dockerfile", GOOD_DOCKERFILE)
        self.assertEqual(ch.static_check(self.root, None), [])
        self.write("Dockerfile", "")
        (self.root / "Dockerfile").unlink()
        self.write("compose.yml", COMPOSE_TEXT)
        self.write(".env.example", GOOD_ENV)
        self.assertEqual(ch.static_check(self.root, {"compose.yml": {"services": {"web": service()}}}), [])

    def test_a_compose_file_is_resolved_with_docker_when_nothing_is_supplied(self) -> None:
        self.write("compose.yml", COMPOSE_TEXT)
        self.write(".env.example", GOOD_ENV)
        fake = FakeDocker(
            {("docker", "compose", "-f", str(self.root / "compose.yml"), "config", "--format", "json"): json.dumps({"services": {"web": service(read_only=None)}})}
        )
        with mock.patch.object(ch, "run", fake):
            found = ch.static_check(self.root, None)
        self.assertEqual(found, ["compose.yml: service web: `read_only: true` is missing (root filesystem must be read-only)"])
        self.assertEqual(len(fake.calls), 1)

    def test_a_missing_resolved_configuration_does_not_stop_the_other_files(self) -> None:
        self.write("compose-a.yml", COMPOSE_TEXT)
        self.write("compose.yml", COMPOSE_TEXT)
        self.write(".env.example", GOOD_ENV)
        found = ch.static_check(self.root, {"compose.yml": {"services": {"web": service(user=None)}}})
        self.assertEqual(
            found,
            [
                "compose-a.yml: no resolved configuration supplied",
                "compose.yml: service web: no `user` set (the container would run as the image default, often root)",
            ],
        )

    def test_the_env_example_is_required_next_to_compose_files(self) -> None:
        self.write("compose.yml", COMPOSE_TEXT)
        self.assertEqual(
            ch.static_check(self.root, {"compose.yml": {"services": {"web": service()}}}), [".env.example is missing"]
        )

    def test_the_files_are_read_as_utf8(self) -> None:
        self.write("compose.yml", COMPOSE_TEXT)
        self.write("Dockerfile", GOOD_DOCKERFILE)
        self.write(".env.example", GOOD_ENV)
        real = pathlib.Path.read_text
        seen: list[tuple[str, object]] = []

        def spy(path: pathlib.Path, *args: object, **kwargs: object) -> str:
            seen.append((path.name, kwargs.get("encoding")))
            return real(path, *args, **kwargs)

        with mock.patch.object(pathlib.Path, "read_text", spy):
            ch.static_check(self.root, {"compose.yml": {"services": {"web": service()}}})
        self.assertEqual(sorted(seen), [(".env.example", "utf-8"), ("Dockerfile", "utf-8"), ("compose.yml", "utf-8")])

    def test_dockerfile_findings_carry_the_relative_path(self) -> None:
        self.write("docker/app/Dockerfile", f"FROM node:1@{DIGEST}\nRUN true\n")
        self.assertEqual(
            ch.static_check(self.root, None),
            ["docker/app/Dockerfile: the final stage has no USER instruction (it would run as root)"],
        )


class MainTests(unittest.TestCase):
    def run_main(self, argv: list[str]) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ch.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_report(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(ch.report([], "all good"), 0)
            self.assertEqual(ch.report(["a", "b"], "all good"), 1)
        self.assertEqual(
            out.getvalue(),
            "OK: all good\n"
            "2 container hardening finding(s):\n"
            "::error::a\n"
            "::error::b\n"
            "Rules and reasons: scripts/ci/check_container_hardening.py (SPEC section 11).\n",
        )

    def test_static_mode_with_a_resolved_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "compose.yml").write_text(COMPOSE_TEXT, encoding="utf-8")
            (root / ".env.example").write_text(GOOD_ENV, encoding="utf-8")
            resolved = root / "resolved.json"
            resolved.write_text(json.dumps({"compose.yml": {"services": {"web": service()}}}), encoding="utf-8")
            code, out, err = self.run_main(["static", "--root", str(root), "--resolved", str(resolved)])
        self.assertEqual((code, out, err), (0, "OK: compose files, Dockerfiles and .env.example pass\n", ""))

    def test_static_mode_defaults_to_the_repository(self) -> None:
        seen: list[Any] = []

        def fake(root: pathlib.Path, resolved: Any) -> list[str]:
            seen.append((root, resolved))
            return []

        with mock.patch.object(ch, "static_check", fake):
            self.assertEqual(self.run_main(["static"])[0], 0)
        self.assertEqual(seen, [(ch.REPO, None)])

    def test_the_resolved_file_is_read_as_utf8(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            resolved = pathlib.Path(tmp) / "resolved.json"
            resolved.write_text("{}", encoding="utf-8")
            with (
                mock.patch.object(ch, "static_check", return_value=[]),
                mock.patch.object(pathlib.Path, "read_text", autospec=True, return_value="{}") as read,
            ):
                self.run_main(["static", "--resolved", str(resolved)])
        read.assert_called_once_with(resolved, encoding="utf-8")

    def test_runtime_mode_defaults(self) -> None:
        seen: list[Any] = []

        def fake(compose: pathlib.Path, project: str) -> list[str]:
            seen.append((compose, project))
            return []

        with mock.patch.object(ch, "runtime_check", fake):
            code, out, _ = self.run_main(["runtime"])
        self.assertEqual((code, out), (0, "OK: running containers of stuffcloud-dev are hardened\n"))
        self.assertEqual(seen, [(ch.REPO / "compose.dev.yml", "stuffcloud-dev")])
        with mock.patch.object(ch, "runtime_check", fake):
            self.run_main(["runtime", "--compose-file", "x.yml", "--project", "p"])
        self.assertEqual(seen[-1], (pathlib.Path("x.yml"), "p"))

    def test_setup_errors_exit_with_two_and_go_to_stderr(self) -> None:
        for error in (ch.SetupError("no docker"), OSError("gone"), json.JSONDecodeError("bad", "x", 0)):
            with self.subTest(error), mock.patch.object(ch, "runtime_check", side_effect=error):
                code, out, err = self.run_main(["runtime"])
                self.assertEqual((code, out, err), (2, "", f"error: {error}\n"))

    def test_a_mode_is_required_and_the_help_names_the_modes(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            ch.main([])
        out = io.StringIO()
        with mock.patch.dict("os.environ", {"COLUMNS": "400"}), contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit):
                ch.main(["--help"])
        text = out.getvalue()
        self.assertIn("CI gate: container hardening of the compose stacks and Dockerfiles", text)
        # The description keeps its line breaks (RawDescriptionHelpFormatter).
        self.assertIn(
            "    check_container_hardening.py static    # compose files + Dockerfiles + .env.example\n"
            "    check_container_hardening.py runtime   # the running stack, via `docker inspect`\n",
            text,
        )
        self.assertRegex(text, r"\n    static\s+compose files, Dockerfiles and \.env\.example\n")
        self.assertRegex(text, r"\n    runtime\s+the running containers of a compose project\n")
        out = io.StringIO()
        with mock.patch.dict("os.environ", {"COLUMNS": "400"}), contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit):
                ch.main(["static", "--help"])
        self.assertRegex(
            out.getvalue(),
            r"--resolved RESOLVED\s+JSON \{relative compose path: `docker compose config --format json` "
            r"output\} instead of running docker\n",
        )


if __name__ == "__main__":
    unittest.main()
