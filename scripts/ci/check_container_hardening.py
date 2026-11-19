#!/usr/bin/env python3
"""CI gate: container hardening of the compose stacks and Dockerfiles (SPEC section 11).

Three checks, all stdlib only (Python 3.11+, `docker` for the first two):

    check_container_hardening.py static    # compose files + Dockerfiles + .env.example
    check_container_hardening.py runtime   # the running stack, via `docker inspect`

`static` finds every compose file (`compose*.yml`, `docker-compose*.yml`) and every Dockerfile
in the repository, so a new service or image is covered the moment it exists; nothing has to
be registered here. Compose files are resolved with `docker compose config --format json`, so
anchors, interpolation and defaults are what Docker will really use.

Rules for every service: an unprivileged numeric `user`, `read_only: true`, `cap_drop: [ALL]`
and no `cap_add`, `no-new-privileges`, a health check, no `privileged`, host namespaces,
device or Docker socket, published ports bound to the loopback address, bind mounts
read-only, images pinned by tag and digest (built images: the `FROM` lines of their
Dockerfile). Rules for every Dockerfile: every `FROM` pinned by tag and digest, and a final
stage that does not run as root. `.env.example` must document every variable the compose
files use, with the same defaults, hold no secret and use reserved host names only.

`runtime` inspects the containers of a running project and asserts the same facts on what
Docker actually applied (user, read-only root, capabilities, health, loopback bindings) and
that no process of a container runs as uid 0.

Exit codes: 0 pass, 1 findings, 2 setup error (docker missing, unreadable file).
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

REPO = pathlib.Path(__file__).resolve().parents[2]

LOOPBACK = {"127.0.0.1", "::1", "localhost"}
PINNED = re.compile(r"^(?P<name>[^@\s]+)@sha256:[0-9a-f]{64}$")
SKIP_DIRS = {".git", "node_modules", "target", "dist", "coverage", "__pycache__", ".venv"}
COMPOSE_NAME = re.compile(r"^(docker-)?compose([.-].+)?\.ya?ml$")
DOCKERFILE_NAME = re.compile(r"^(Dockerfile(\..+)?|.+\.Dockerfile|Containerfile)$")
# Reserved names (RFC 2606, RFC 6761): the only host names the repository may contain.
RESERVED_TLDS = {"localhost", "test", "example", "invalid"}
RESERVED_DOMAINS = {"example.com", "example.org", "example.net"}
SECRET_NAME = re.compile(r"(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE|CREDENTIAL|DSN)", re.IGNORECASE)
HOSTISH_NAME = re.compile(r"(_HOST|_HOSTNAME|_BASE|_DOMAIN)$")
VAR_WITH_DEFAULT = re.compile(r"\$\{(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?::?-(?P<default>[^}]*))?\}")
ENV_LINE = re.compile(r"^(?P<name>[A-Za-z_][A-Za-z0-9_]*)=(?P<value>.*)$")


class SetupError(Exception):
    """The check could not run (missing tool, unreadable input)."""


def is_reserved_host(host: str) -> bool:
    """True for names RFC 2606 / RFC 6761 reserve (whole labels, so `notexample.com` is not)."""
    labels = host.lower().rstrip(".").split(".")
    if labels[-1] in RESERVED_TLDS and len(labels) > 1:
        return True
    return ".".join(labels[-2:]) in RESERVED_DOMAINS


# ── Images ────────────────────────────────────────────────────────────────────────────────


def image_problem(ref: str) -> str | None:
    """Return why `ref` is not `name:tag@sha256:<digest>`, or None when it is."""
    match = PINNED.match(ref)
    if match is None:
        return f"{ref!r} is not pinned by digest (name:tag@sha256:<64 hex digits>)"
    name = match.group("name")
    last_part = name.rsplit("/", 1)[-1]
    if ":" not in last_part:
        return f"{ref!r} has a digest but no tag (Dependabot and readers need the tag)"
    tag = last_part.split(":", 1)[1]
    if tag in ("", "latest"):
        return f"{ref!r} uses the tag {tag or '(empty)'!r}; pin a version"
    return None


def uid_problem(user: object) -> str | None:
    """Static rule: the user must be set and a numeric, non-zero uid."""
    if user is None or str(user).strip() == "":
        return "no `user` set (the container would run as the image default, often root)"
    uid = str(user).split(":", 1)[0].strip()
    if not uid.isdigit():
        return f"user {user!r} is not a numeric uid (a name cannot be checked without the image)"
    if int(uid) == 0:
        return f"user {user!r} is root"
    return None


# ── Compose ───────────────────────────────────────────────────────────────────────────────


def _as_list(value: object) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return list(value)
    return [value]


def _port_host_ip(port: object) -> tuple[bool, str]:
    """Return (is_published, host_ip) for a port entry in long or short form."""
    if isinstance(port, Mapping):
        published = port.get("published") not in (None, "")
        return published, str(port.get("host_ip") or "")
    text = str(port)
    parts = text.split("/", 1)[0].split(":")
    if len(parts) == 1:  # "8080": container port only, not published
        return False, ""
    if len(parts) == 2:  # "8080:80": published on all interfaces
        return True, ""
    return True, ":".join(parts[:-2]).strip("[]")


def check_service(name: str, service: Mapping[str, Any]) -> list[str]:
    """Return one finding per violated rule of one compose service."""
    out: list[str] = []

    def bad(message: str) -> None:
        out.append(f"service {name}: {message}")

    problem = uid_problem(service.get("user"))
    if problem:
        bad(problem)
    if service.get("read_only") is not True:
        bad("`read_only: true` is missing (root filesystem must be read-only)")
    if "ALL" not in {str(c).upper() for c in _as_list(service.get("cap_drop"))}:
        bad("`cap_drop: [ALL]` is missing")
    if _as_list(service.get("cap_add")):
        bad(f"`cap_add` {_as_list(service.get('cap_add'))} gives capabilities back")
    security_opt = [str(o).replace("=", ":").lower() for o in _as_list(service.get("security_opt"))]
    if "no-new-privileges:true" not in security_opt and "no-new-privileges" not in security_opt:
        bad("`security_opt: [no-new-privileges:true]` is missing")
    for option in security_opt:
        if "unconfined" in option:
            bad(f"security option {option!r} switches a sandbox off")

    health = service.get("healthcheck")
    if not isinstance(health, Mapping) or health.get("disable") is True:
        bad("no health check")
    else:
        test = _as_list(health.get("test"))
        if not test or str(test[0]).upper() == "NONE":
            bad("health check is disabled or empty")

    if service.get("privileged") is True:
        bad("`privileged: true`")
    for key in ("network_mode", "pid", "ipc", "userns_mode", "uts", "cgroup"):
        if str(service.get(key) or "").lower() == "host":
            bad(f"`{key}: host` shares the host namespace")
    if _as_list(service.get("devices")):
        bad("`devices` hands host devices to the container")

    for port in _as_list(service.get("ports")):
        published, host_ip = _port_host_ip(port)
        if published and host_ip not in LOOPBACK:
            where = host_ip or "all interfaces"
            bad(f"port {port!r} is published on {where}; bind it to 127.0.0.1")

    for volume in _as_list(service.get("volumes")):
        if isinstance(volume, Mapping):
            kind, source = str(volume.get("type")), str(volume.get("source") or "")
            read_only = volume.get("read_only") is True
        else:  # short form "source:target[:ro]"
            parts = str(volume).split(":")
            source = parts[0]
            kind = "bind" if source.startswith(("/", ".", "~")) else "volume"
            read_only = parts[-1] == "ro"
        if "docker.sock" in source:
            bad("the Docker socket is mounted (full control of the host)")
        if kind == "bind" and not read_only:
            bad(f"bind mount {source!r} is writable; mount it read-only")

    if "build" not in service:
        image = service.get("image")
        problem = image_problem(str(image)) if image else "neither `image` nor `build`"
        if problem:
            bad(problem)
    return out


def check_compose(config: Mapping[str, Any], source: str = "compose") -> list[str]:
    """Check a resolved compose file (the JSON of `docker compose config`)."""
    services = config.get("services")
    if not isinstance(services, Mapping) or not services:
        return [f"{source}: no services"]
    findings: list[str] = []
    for name in sorted(services):
        findings.extend(f"{source}: {f}" for f in check_service(name, services[name]))
    return findings


# ── Dockerfiles ───────────────────────────────────────────────────────────────────────────


def logical_lines(text: str) -> list[str]:
    """Dockerfile instructions with continuations joined and comments removed."""
    lines: list[str] = []
    buffer = ""
    for raw in text.splitlines():
        stripped = raw.strip()
        if not buffer and (stripped == "" or stripped.startswith("#")):
            continue
        if buffer and stripped.startswith("#"):
            continue
        if stripped.endswith("\\"):
            buffer += stripped[:-1] + " "
            continue
        lines.append((buffer + stripped).strip())
        buffer = ""
    if buffer:
        lines.append(buffer.strip())
    return lines


def check_dockerfile(text: str, name: str = "Dockerfile") -> list[str]:
    """Every FROM is pinned (or a previous stage or `scratch`); the final stage is not root."""
    out: list[str] = []
    stages: set[str] = set()
    stage_count = 0
    final_user: str | None = None
    for line in logical_lines(text):
        keyword, _, rest = line.partition(" ")
        keyword = keyword.upper()
        if keyword == "FROM":
            tokens = [t for t in rest.split() if not t.startswith("--")]
            image = tokens[0] if tokens else ""
            alias = tokens[2].lower() if len(tokens) >= 3 and tokens[1].upper() == "AS" else None
            stage_count += 1
            final_user = None
            if image.lower() == "scratch" or image.lower() in stages:
                pass
            elif "$" in image:
                out.append(f"{name}: FROM {image!r} uses a variable; write the pinned reference out")
            else:
                problem = image_problem(image)
                if problem:
                    out.append(f"{name}: FROM {problem}")
            if alias:
                stages.add(alias)
        elif keyword == "USER":
            final_user = rest.strip()
    if stage_count == 0:
        return [f"{name}: no FROM instruction"]
    if final_user is None:
        out.append(f"{name}: the final stage has no USER instruction (it would run as root)")
    else:
        uid = final_user.split(":", 1)[0].strip().lower()
        if uid in ("root", "0", ""):
            out.append(f"{name}: the final stage runs as {final_user!r}")
        elif "$" in uid:
            out.append(f"{name}: USER {final_user!r} uses a variable; write the user out")
    return out


# ── .env.example ──────────────────────────────────────────────────────────────────────────


def parse_env_example(text: str) -> tuple[dict[str, str], list[str]]:
    """Return ({name: value}, findings). Every variable needs a comment line right above it."""
    values: dict[str, str] = {}
    findings: list[str] = []
    previous_is_comment = False
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        match = ENV_LINE.match(line)
        if match:
            name, value = match.group("name"), match.group("value").strip()
            if name in values:
                findings.append(f".env.example:{number}: {name} is defined twice")
            if not previous_is_comment:
                findings.append(f".env.example:{number}: {name} has no comment line above it")
            values[name] = value
        elif line and not line.startswith("#"):
            findings.append(f".env.example:{number}: not a comment and not NAME=value: {line!r}")
        previous_is_comment = line.startswith("#")
    return values, findings


def compose_variables(texts: Iterable[str]) -> dict[str, str | None]:
    """Variables the compose files interpolate, with their default (None: no default)."""
    found: dict[str, str | None] = {}
    for text in texts:
        for match in VAR_WITH_DEFAULT.finditer(text):
            name, default = match.group("name"), match.group("default")
            if found.get(name) is None:
                found[name] = default
    return found


def check_env_example(env_text: str, compose_texts: Sequence[str]) -> list[str]:
    values, findings = parse_env_example(env_text)
    used = compose_variables(compose_texts)
    for name in sorted(used):
        if name not in values:
            findings.append(f".env.example: {name} is used by a compose file but not documented")
        elif used[name] is not None and values[name] != used[name]:
            findings.append(
                f".env.example: {name}={values[name]!r} differs from the compose default {used[name]!r}"
            )
    for name in sorted(values):
        if name not in used:
            findings.append(f".env.example: {name} is documented but no compose file uses it")
    for name, value in values.items():
        if SECRET_NAME.search(name) and value and not name.endswith("_FILE"):
            findings.append(f".env.example: {name} looks like a secret and has a value; secrets never go here")
        if HOSTISH_NAME.search(name) and value and not is_reserved_host(value):
            findings.append(f".env.example: {name}={value!r} is not a reserved name (RFC 2606 / 6761)")
    return findings


# ── Runtime ───────────────────────────────────────────────────────────────────────────────


def check_container(info: Mapping[str, Any], process_uids: Sequence[str]) -> list[str]:
    """Check one `docker inspect` document and the uids of its processes."""
    labels = (info.get("Config") or {}).get("Labels") or {}
    name = labels.get("com.docker.compose.service") or str(info.get("Name", "?")).lstrip("/")
    out: list[str] = []

    def bad(message: str) -> None:
        out.append(f"container {name}: {message}")

    config = info.get("Config") or {}
    host = info.get("HostConfig") or {}
    state = info.get("State") or {}
    problem = uid_problem(config.get("User"))
    if problem:
        bad(problem)
    if host.get("ReadonlyRootfs") is not True:
        bad("root filesystem is writable")
    if "ALL" not in {str(c).upper() for c in host.get("CapDrop") or []}:
        bad("capabilities are not dropped (CapDrop lacks ALL)")
    if host.get("CapAdd"):
        bad(f"capabilities added back: {host.get('CapAdd')}")
    if not any(str(o).startswith("no-new-privileges") for o in host.get("SecurityOpt") or []):
        bad("no-new-privileges is not set")
    if host.get("Privileged"):
        bad("runs privileged")
    if str(host.get("NetworkMode")) == "host":
        bad("uses the host network")
    if state.get("Running") is not True:
        bad(f"is not running (status {state.get('Status')!r})")
    health = (state.get("Health") or {}).get("Status")
    if health != "healthy":
        bad(f"health status is {health!r}, expected 'healthy'")
    for bindings in (host.get("PortBindings") or {}).values():
        for binding in bindings or []:
            if (binding.get("HostIp") or "") not in LOOPBACK:
                bad(f"a port is published on {binding.get('HostIp') or 'all interfaces'!r}")
    if not process_uids:
        bad("no process found")
    for uid in sorted(set(process_uids)):
        if uid in ("0", "root"):
            bad("a process runs as uid 0")
    return out


def check_runtime(
    containers: Sequence[Mapping[str, Any]],
    process_uids: Mapping[str, Sequence[str]],
    expected_services: Sequence[str],
) -> list[str]:
    findings: list[str] = []
    seen: set[str] = set()
    for info in containers:
        labels = (info.get("Config") or {}).get("Labels") or {}
        seen.add(str(labels.get("com.docker.compose.service")))
        findings.extend(check_container(info, process_uids.get(str(info.get("Id")), [])))
    for service in expected_services:
        if service not in seen:
            findings.append(f"service {service}: no container is running")
    return findings


# ── Command line ──────────────────────────────────────────────────────────────────────────


def run(*args: str) -> str:
    try:
        done = subprocess.run(args, check=False, capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as err:
        raise SetupError(f"cannot run {' '.join(args)}: {err}") from err
    if done.returncode != 0:
        raise SetupError(f"{' '.join(args)} failed: {done.stderr.strip()}")
    return done.stdout


def find_files(root: pathlib.Path, pattern: re.Pattern[str]) -> list[pathlib.Path]:
    found: list[pathlib.Path] = []
    for directory, subdirs, files in os.walk(root):
        subdirs[:] = [d for d in subdirs if d not in SKIP_DIRS]
        found.extend(pathlib.Path(directory, f) for f in files if pattern.match(f))
    return sorted(found)


def static_check(root: pathlib.Path, resolved: Mapping[str, Mapping[str, Any]] | None) -> list[str]:
    """Check every compose file, Dockerfile and `.env.example` below `root`."""
    findings: list[str] = []
    compose_files = find_files(root, COMPOSE_NAME)
    dockerfiles = find_files(root, DOCKERFILE_NAME)
    if not compose_files and not dockerfiles:
        return ["nothing to check: no compose file and no Dockerfile found"]
    compose_texts: list[str] = []
    for path in compose_files:
        rel = path.relative_to(root).as_posix()
        compose_texts.append(path.read_text(encoding="utf-8"))
        if resolved is not None:
            config = resolved.get(rel)
            if config is None:
                findings.append(f"{rel}: no resolved configuration supplied")
                continue
        else:
            config = json.loads(run("docker", "compose", "-f", str(path), "config", "--format", "json"))
        findings.extend(check_compose(config, rel))
    for path in dockerfiles:
        findings.extend(check_dockerfile(path.read_text(encoding="utf-8"), path.relative_to(root).as_posix()))
    env_example = root / ".env.example"
    if compose_files:
        if not env_example.is_file():
            findings.append(".env.example is missing")
        else:
            findings.extend(check_env_example(env_example.read_text(encoding="utf-8"), compose_texts))
    return findings


def runtime_check(compose_file: pathlib.Path, project: str) -> list[str]:
    services = [s for s in run("docker", "compose", "-f", str(compose_file), "config", "--services").split() if s]
    ids = run("docker", "ps", "-a", "-q", "--filter", f"label=com.docker.compose.project={project}").split()
    if not ids:
        return [f"no container of project {project!r} found"]
    containers = json.loads(run("docker", "inspect", *ids))
    uids: dict[str, list[str]] = {}
    for info in containers:
        top = run("docker", "top", str(info["Id"]), "-eo", "uid").splitlines()
        uids[str(info["Id"])] = [line.strip() for line in top[1:] if line.strip()]
    return check_runtime(containers, uids, services)


def report(findings: Sequence[str], ok_message: str) -> int:
    if findings:
        print(f"{len(findings)} container hardening finding(s):")
        for finding in findings:
            print(f"::error::{finding}")
        print("Rules and reasons: scripts/ci/check_container_hardening.py (SPEC section 11).")
        return 1
    print(f"OK: {ok_message}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="mode", required=True)
    static = sub.add_parser("static", help="compose files, Dockerfiles and .env.example")
    static.add_argument("--root", type=pathlib.Path, default=REPO)
    static.add_argument(
        "--resolved",
        type=pathlib.Path,
        help="JSON {relative compose path: `docker compose config --format json` output} instead of running docker",
    )
    runtime = sub.add_parser("runtime", help="the running containers of a compose project")
    runtime.add_argument("--compose-file", type=pathlib.Path, default=REPO / "compose.dev.yml")
    runtime.add_argument("--project", default="stuffcloud-dev")
    args = parser.parse_args(argv)
    try:
        if args.mode == "static":
            resolved = json.loads(args.resolved.read_text(encoding="utf-8")) if args.resolved else None
            return report(static_check(args.root, resolved), "compose files, Dockerfiles and .env.example pass")
        return report(
            runtime_check(args.compose_file, args.project), f"running containers of {args.project} are hardened"
        )
    except (SetupError, OSError, json.JSONDecodeError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
