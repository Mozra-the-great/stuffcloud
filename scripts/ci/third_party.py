#!/usr/bin/env python3
"""Generate docs/THIRD-PARTY.md: every runtime dependency with version, license, source.

    python3 scripts/ci/third_party.py --write    regenerate the file
    python3 scripts/ci/third_party.py --check    fail (exit 1) if the file is stale

Rust: `cargo metadata --locked` of the workspace, walking only normal and build
dependency edges from the workspace members, so dev-dependencies (proptest, ...)
and the separate fuzz workspace (`libfuzzer-sys`, never shipped) stay out.
npm: the production dependency trees of the web/ workspace, from the same
inventory the license gate uses (`npm_licenses.py`), so the report covers every
platform variant of native packages and does not depend on the OS it runs on.
Dev/build-only npm packages are checked by the gate but not listed.

The output has no timestamps, paths or tool versions, so regenerating an unchanged
dependency set gives a byte-identical file. CI runs `--check`.

Needs `cargo` and `pnpm`. Standard library only (Python 3.11+).
"""
from __future__ import annotations

import argparse
import difflib
import json
import pathlib
import subprocess
import sys
from dataclasses import dataclass

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import npm_licenses  # noqa: E402
from license_policy import Package  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]
OUTPUT = REPO / "docs" / "THIRD-PARTY.md"
_CRATES_IO_SOURCES = (
    "registry+https://github.com/rust-lang/crates.io-index",
    "sparse+https://index.crates.io/",
)
_RUNTIME_KINDS = frozenset({None, "build"})  # cargo: null = normal, "build", "dev"


class ReportError(RuntimeError):
    """The dependency data is unusable."""


@dataclass(frozen=True)
class CratePackage:
    name: str
    version: str
    license: str
    source: str  # as cargo reports it


# -- Rust --------------------------------------------------------------------------


def runtime_crates(metadata: dict) -> list[CratePackage]:
    """Crates that end up in a build: reachable through normal or build edges."""
    try:
        packages = {p["id"]: p for p in metadata["packages"]}
        nodes = {n["id"]: n for n in metadata["resolve"]["nodes"]}
        members = list(metadata["workspace_members"])
    except (KeyError, TypeError) as err:
        raise ReportError(f"unexpected `cargo metadata` output: missing {err}") from err

    seen: set[str] = set(members)
    stack = list(members)
    while stack:
        node = nodes.get(stack.pop())
        if node is None:
            continue
        for dep in node.get("deps", []):
            kinds = {kind.get("kind") for kind in dep.get("dep_kinds", [])}
            if kinds & _RUNTIME_KINDS and dep["pkg"] not in seen:
                seen.add(dep["pkg"])
                stack.append(dep["pkg"])

    result: list[CratePackage] = []
    for package_id in seen - set(members):
        pkg = packages[package_id]
        license_text = pkg.get("license")
        if not license_text:
            raise ReportError(
                f"{pkg['name']} {pkg['version']} declares no license field "
                "(cargo-deny checks its license file; list it in the report by hand "
                "once decided)"
            )
        result.append(
            CratePackage(pkg["name"], pkg["version"], license_text, pkg.get("source") or "")
        )
    return sorted(result, key=lambda c: (c.name, c.version))


def collect_cargo(repo: pathlib.Path = REPO) -> dict:
    done = subprocess.run(  # fixed argument list, no shell
        ["cargo", "metadata", "--locked", "--format-version", "1"],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if done.returncode != 0:
        raise ReportError(f"`cargo metadata` failed:\n{done.stderr.strip()}")
    return json.loads(done.stdout)


# -- rendering ---------------------------------------------------------------------


def _cell(text: str) -> str:
    return text.replace("|", "\\|")


def crate_source(crate: CratePackage) -> str:
    if crate.source.startswith(_CRATES_IO_SOURCES):
        url = f"https://crates.io/crates/{crate.name}/{crate.version}"
        return f"[crates.io]({url})"
    return _cell(crate.source or "unknown")


def npm_source(package: Package, tarballs: dict[tuple[str, str], str] | None = None) -> str:
    """The registry page, or the release tarball a package is pinned to (ADR 0014)."""
    tarball = (tarballs or {}).get((package.name, package.version))
    if tarball is not None:
        return f"[release]({tarball})"
    url = f"https://www.npmjs.com/package/{package.name}/v/{package.version}"
    return f"[npm]({url})"


def _table(rows: list[tuple[str, str, str, str]]) -> list[str]:
    lines = ["| Name | Version | License | Source |", "|---|---|---|---|"]
    lines += [f"| {_cell(n)} | {_cell(v)} | {_cell(lic)} | {src} |" for n, v, lic, src in rows]
    return lines


def render(
    crates: list[CratePackage],
    npm_runtime: list[Package],
    tarballs: dict[tuple[str, str], str] | None = None,
) -> str:
    """The complete docs/THIRD-PARTY.md."""
    lines = [
        "# Third-party dependencies",
        "",
        "<!-- Generated by scripts/ci/third_party.py. Do not edit: CI fails when this "
        "file is stale. Regenerate with `python3 scripts/ci/third_party.py --write`. -->",
        "",
        "Every runtime dependency of stuffcloud with its version, license and source,",
        "read from `Cargo.lock` and `web/pnpm-lock.yaml`. All of them passed the license",
        "gate (`deny.toml` for Rust, `scripts/ci/license-policy.toml` for npm; policy in",
        "`docs/SPEC.md`, section 3). Build and test tooling that never ships (Rust",
        "dev-dependencies, the `fuzz/` workspace, npm `devDependencies`) is checked by the",
        "same gates but not listed. WASM modules, ML models, fonts and data files that",
        "come from neither package manager are in",
        "[`THIRD-PARTY-ASSETS.md`](THIRD-PARTY-ASSETS.md).",
        "",
        f"## Rust ({len(crates)})",
        "",
    ]
    if crates:
        lines += _table([(c.name, c.version, c.license, crate_source(c)) for c in crates])
    else:
        lines.append("No runtime dependencies.")
    lines += ["", f"## npm ({len(npm_runtime)})", ""]
    if npm_runtime:
        lines += _table([(p.name, p.version, p.license, npm_source(p, tarballs)) for p in npm_runtime])
    else:
        lines.append("No runtime dependencies.")
    return "\n".join(lines) + "\n"


def generate(
    cargo_metadata: dict | None = None, inventory: npm_licenses.Inventory | None = None
) -> str:
    metadata = cargo_metadata if cargo_metadata is not None else collect_cargo()
    npm = inventory if inventory is not None else npm_licenses.collect()
    npm_runtime = sorted(
        (p for p in npm.packages if (p.name, p.version) in npm.runtime),
        key=lambda p: (p.name, p.version),
    )
    return render(runtime_crates(metadata), npm_runtime, npm.tarballs)


def check_text(expected: str, actual: str) -> list[str]:
    """Unified diff lines between the committed file and a fresh render (empty if equal)."""
    return list(
        difflib.unified_diff(
            actual.splitlines(),
            expected.splitlines(),
            fromfile="docs/THIRD-PARTY.md (committed)",
            tofile="docs/THIRD-PARTY.md (regenerated)",
            lineterm="",
        )
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="regenerate docs/THIRD-PARTY.md")
    mode.add_argument("--check", action="store_true", help="fail if docs/THIRD-PARTY.md is stale")
    parser.add_argument("--output", type=pathlib.Path, default=OUTPUT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    try:
        fresh = generate()
    except (ReportError, npm_licenses.InventoryError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 2

    if args.write:
        args.output.write_text(fresh, encoding="utf-8", newline="\n")
        print(f"wrote {args.output}")
        return 0

    committed = args.output.read_text(encoding="utf-8") if args.output.exists() else ""
    diff = check_text(fresh, committed)
    if diff:
        print("\n".join(diff[:200]))
        print(
            "::error::docs/THIRD-PARTY.md is stale. Run "
            "`python3 scripts/ci/third_party.py --write` and commit the result."
        )
        return 1
    print("docs/THIRD-PARTY.md is current.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
