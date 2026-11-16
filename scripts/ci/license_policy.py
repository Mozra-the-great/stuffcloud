#!/usr/bin/env python3
"""License policy for the npm dependencies of web/ and the check that applies it.

The policy lives in `scripts/ci/license-policy.toml` and has three parts:

* `allow`: SPDX licenses any package may use. It is the same list as
  `[licenses].allow` in `deny.toml` (the Rust gate); a unit test keeps the two
  identical, so a new license is one deliberate edit in both places (docs/SPEC.md,
  section 3).
* `[dev_only]`: licenses accepted only for packages that are not part of any
  production dependency tree (linters, test runners, build tooling), each with its
  reason. The same license on a runtime dependency fails.
* `[[exception]]`: one package whose declared license is not a valid SPDX
  expression (a missing field, `SEE LICENSE IN ...`), matched by name and by the
  exact license text. When the package changes its license text the exception
  stops matching and the gate fails again.

A package passes when its license expression can be satisfied with permitted
licenses (`OR` needs one, `AND` needs all, see `spdx.py`). Anything unreadable,
missing (`Unknown`) or not on a list fails.

Standard library only (Python 3.11+ for `tomllib`).
"""
from __future__ import annotations

import pathlib
import tomllib
from dataclasses import dataclass, field

import spdx

REPO = pathlib.Path(__file__).resolve().parents[2]
POLICY_FILE = REPO / "scripts" / "ci" / "license-policy.toml"
DENY_FILE = REPO / "deny.toml"

# What npm and pnpm report for a package without a usable license field.
_MISSING = frozenset({"", "unknown", "unlicensed"})


class PolicyError(ValueError):
    """The policy file is malformed."""


@dataclass(frozen=True)
class PackageException:
    name: str
    license: str
    reason: str


@dataclass(frozen=True)
class Policy:
    allow: frozenset[str]  # lower-cased SPDX terms
    dev_only: dict[str, str]  # lower-cased SPDX term -> reason
    exceptions: tuple[PackageException, ...]


@dataclass(frozen=True)
class Package:
    name: str
    version: str
    license: str


@dataclass(frozen=True)
class Violation:
    package: Package
    runtime: bool
    reason: str

    def __str__(self) -> str:
        scope = "runtime" if self.runtime else "dev/build"
        pkg = self.package
        return f"{pkg.name}@{pkg.version} ({scope}): license {pkg.license!r}: {self.reason}"


@dataclass(frozen=True)
class Result:
    violations: tuple[Violation, ...] = ()
    unused_exceptions: tuple[PackageException, ...] = field(default_factory=tuple)


def _term(value: object, where: str) -> str:
    if not isinstance(value, str):
        raise PolicyError(f"{where}: license must be a string, got {value!r}")
    try:
        node = spdx.parse(value)
    except spdx.LicenseExpressionError as err:
        raise PolicyError(f"{where}: {value!r} is not an SPDX license: {err}") from err
    if not isinstance(node, spdx.Term):
        raise PolicyError(f"{where}: {value!r} must be a single license, not an expression")
    return value.lower()


def _reason(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PolicyError(f"{where}: a non-empty reason is required")
    return value.strip()


def parse_policy(text: str) -> Policy:
    """Validate and load a policy from TOML text."""
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as err:
        raise PolicyError(f"invalid TOML: {err}") from err
    unknown = set(data) - {"allow", "dev_only", "exception"}
    if unknown:
        raise PolicyError(f"unknown keys: {sorted(unknown)}")

    raw_allow = data.get("allow")
    if not isinstance(raw_allow, list) or not raw_allow:
        raise PolicyError("`allow` must be a non-empty list")
    allow = [_term(item, "allow") for item in raw_allow]
    if len(set(allow)) != len(allow):
        raise PolicyError("`allow` contains a license twice")

    raw_dev = data.get("dev_only", {})
    if not isinstance(raw_dev, dict):
        raise PolicyError("`dev_only` must be a table of license = reason")
    dev_only = {
        _term(key, "dev_only"): _reason(reason, f"dev_only.{key}")
        for key, reason in raw_dev.items()
    }
    if len(dev_only) != len(raw_dev):
        raise PolicyError("`dev_only` contains a license twice (differing only in case)")
    both = set(allow) & set(dev_only)
    if both:
        raise PolicyError(f"licenses in both `allow` and `dev_only`: {sorted(both)}")

    raw_exceptions = data.get("exception", [])
    if not isinstance(raw_exceptions, list):
        raise PolicyError("`exception` must be an array of tables")
    exceptions: list[PackageException] = []
    for index, entry in enumerate(raw_exceptions):
        where = f"exception[{index}]"
        if not isinstance(entry, dict) or set(entry) != {"name", "license", "reason"}:
            raise PolicyError(f"{where}: exactly the keys name, license and reason are required")
        for key in ("name", "license"):
            if not isinstance(entry[key], str) or not entry[key].strip():
                raise PolicyError(f"{where}: `{key}` must be a non-empty string")
        exceptions.append(
            PackageException(entry["name"], entry["license"], _reason(entry["reason"], where))
        )
    keys = [(e.name, e.license) for e in exceptions]
    if len(set(keys)) != len(keys):
        raise PolicyError("`exception` lists the same package and license twice")

    return Policy(frozenset(allow), dev_only, tuple(exceptions))


def load_policy(path: pathlib.Path = POLICY_FILE) -> Policy:
    return parse_policy(path.read_text(encoding="utf-8"))


def deny_allow_list(path: pathlib.Path = DENY_FILE) -> frozenset[str]:
    """`[licenses].allow` of deny.toml, lower-cased (what the Rust gate accepts)."""
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    return frozenset(item.lower() for item in data["licenses"]["allow"])


def check(
    packages: list[Package],
    runtime: set[tuple[str, str]],
    policy: Policy,
) -> Result:
    """Apply the policy to every package.

    `runtime` holds the (name, version) pairs that are in a production dependency
    tree; everything else counts as dev/build-only.
    """
    violations: list[Violation] = []
    used: set[PackageException] = set()
    by_key = {(e.name, e.license): e for e in policy.exceptions}

    for pkg in sorted(packages, key=lambda p: (p.name, p.version, p.license)):
        is_runtime = (pkg.name, pkg.version) in runtime
        exception = by_key.get((pkg.name, pkg.license))
        if exception is not None:
            used.add(exception)
            continue
        if pkg.license.strip().lower() in _MISSING:
            violations.append(Violation(pkg, is_runtime, "no license declared"))
            continue
        try:
            node = spdx.parse(pkg.license)
        except spdx.LicenseExpressionError as err:
            violations.append(
                Violation(pkg, is_runtime, f"not a valid SPDX expression ({err})")
            )
            continue

        def permitted(term: str, is_runtime: bool = is_runtime) -> bool:
            key = term.lower()
            return key in policy.allow or (not is_runtime and key in policy.dev_only)

        if spdx.is_satisfied(node, permitted):
            continue
        rejected = [t for t in spdx.terms(node) if not permitted(t)]
        dev_only_hit = [t for t in rejected if t.lower() in policy.dev_only]
        if dev_only_hit:
            reason = (
                f"{', '.join(dev_only_hit)} is accepted for dev/build-only packages "
                "only, but this one is a runtime dependency"
            )
        else:
            reason = f"not on the allowlist: {', '.join(rejected)}"
        violations.append(Violation(pkg, is_runtime, reason))

    unused = tuple(e for e in policy.exceptions if e not in used)
    return Result(tuple(violations), unused)
