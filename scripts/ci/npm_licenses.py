#!/usr/bin/env python3
"""Inventory of every npm package in the web/ pnpm workspace, with its license.

The license gate and the THIRD-PARTY report both start here. `pnpm licenses` only
sees what is installed, and an install normally skips the native binaries of the
other platforms (`lightningcss-win32-x64-msvc`, `@rolldown/binding-linux-*`, ...).
A gate that reads such an install would check a different set on every OS and miss
a package that only exists for another platform. So the inventory:

1. copies the manifests (`package.json`, lockfile, workspace file, `.npmrc`) into a
   scratch directory, never touching `web/node_modules`;
2. adds `supportedArchitectures` with every os/cpu/libc value the lockfile names,
   so pnpm installs the packages of all platforms;
3. installs with `--frozen-lockfile --ignore-scripts` (no lifecycle script of a
   dependency runs, and a lockfile that does not match the manifests fails);
4. reads `pnpm -r licenses list --json` (all packages) and `--prod` (those in a
   production dependency tree);
5. checks that every package in the lockfile was found, so nothing slips through
   unchecked.

Needs `pnpm` (corepack) and network access to the registry or a warm store.
Standard library only.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass

from license_policy import Package

REPO = pathlib.Path(__file__).resolve().parents[2]
WEB = REPO / "web"
_COPIED_FILES = ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc")
_SKIPPED_DIRS = frozenset({"node_modules", ".git"})

# Runs `pnpm <args>` in a directory and returns stdout.
PnpmRunner = Callable[[list[str], pathlib.Path], str]


class InventoryError(RuntimeError):
    """The inventory could not be built or is incomplete."""


@dataclass(frozen=True)
class Inventory:
    packages: tuple[Package, ...]  # every package, runtime and dev
    runtime: frozenset[tuple[str, str]]  # (name, version) in a production tree


# -- pure parsing (unit-tested) --------------------------------------------------


def parse_licenses_json(text: str) -> list[Package]:
    """Flatten the `pnpm licenses list --json` output (license -> packages)."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as err:
        raise InventoryError(f"pnpm licenses did not print JSON: {err}") from err
    if not isinstance(data, dict):
        raise InventoryError("pnpm licenses JSON is not an object")
    found: set[Package] = set()
    for license_text, entries in data.items():
        if not isinstance(entries, list):
            raise InventoryError(f"pnpm licenses: entry for {license_text!r} is not a list")
        for entry in entries:
            name = entry.get("name") if isinstance(entry, dict) else None
            versions = entry.get("versions") if isinstance(entry, dict) else None
            if not isinstance(name, str) or not isinstance(versions, list) or not versions:
                raise InventoryError(f"pnpm licenses: malformed entry {entry!r}")
            for version in versions:
                if not isinstance(version, str):
                    raise InventoryError(f"pnpm licenses: malformed version in {entry!r}")
                found.add(Package(name, version, license_text))
    return sorted(found, key=lambda p: (p.name, p.version, p.license))


def _main_lockfile_document(text: str) -> str:
    """The project lockfile: pnpm 11+ puts the package manager's own lock first."""
    return re.split(r"^---\s*$", text, flags=re.MULTILINE)[-1]


def lockfile_packages(text: str) -> set[tuple[str, str]]:
    """(name, version) of every entry in the `packages:` section."""
    found: set[tuple[str, str]] = set()
    section = ""
    for line in _main_lockfile_document(text).splitlines():
        top = re.match(r"^([A-Za-z]\w*):", line)
        if top:
            section = top.group(1)
            continue
        if section != "packages":
            continue
        entry = re.match(r"^  '?(@?[^@'\s]+)@([^'\s:]+)'?:\s*$", line)
        if entry:
            found.add((entry.group(1), entry.group(2)))
    return found


def lockfile_platforms(text: str) -> dict[str, list[str]]:
    """Every `os`, `cpu` and `libc` value some locked package is restricted to."""
    platforms: dict[str, set[str]] = {"os": set(), "cpu": set(), "libc": set()}
    for line in _main_lockfile_document(text).splitlines():
        match = re.match(r"^    (os|cpu|libc): \[(.*)\]\s*$", line)
        if match:
            values = (v.strip().strip("'\"") for v in match.group(2).split(","))
            platforms[match.group(1)].update(v for v in values if v)
    return {key: sorted(values) for key, values in platforms.items() if values}


def sandbox_workspace_file(original: str, platforms: dict[str, list[str]]) -> str:
    """The workspace file plus `supportedArchitectures` for every locked platform."""
    if re.search(r"^supportedArchitectures\s*:", original, flags=re.MULTILINE):
        raise InventoryError(
            "pnpm-workspace.yaml sets supportedArchitectures itself; the inventory "
            "cannot widen it. Remove it or teach npm_licenses.py to merge it."
        )
    lines = ["", "supportedArchitectures:"]
    for key in ("os", "cpu", "libc"):
        values = platforms.get(key)
        if values:
            lines.append(f"  {key}: [{', '.join(values)}]")
    return original.rstrip("\n") + "\n" + "\n".join(lines) + "\n"


def missing_from_install(
    locked: set[tuple[str, str]], installed: set[tuple[str, str]]
) -> list[tuple[str, str]]:
    """Locked packages that `pnpm licenses` did not report (they would go unchecked)."""
    return sorted(locked - installed)


# -- collection (runs pnpm) -------------------------------------------------------


def _run_pnpm(args: list[str], cwd: pathlib.Path) -> str:
    pnpm = shutil.which("pnpm")
    if pnpm is None:
        raise InventoryError("pnpm not found; run `corepack enable` (Node per web/.nvmrc)")
    env = {**os.environ, "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0", "CI": "true"}
    done = subprocess.run(  # fixed argument list, no shell
        [pnpm, *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if done.returncode != 0:
        raise InventoryError(
            f"`pnpm {' '.join(args)}` failed ({done.returncode}):\n{done.stderr.strip()}"
        )
    return done.stdout


def _copy_manifests(web: pathlib.Path, target: pathlib.Path) -> None:
    for name in _COPIED_FILES:
        source = web / name
        if source.is_file():
            shutil.copy2(source, target / name)
    for root, dirs, files in os.walk(web):
        dirs[:] = [d for d in dirs if d not in _SKIPPED_DIRS]
        relative = pathlib.Path(root).relative_to(web)
        if relative != pathlib.Path(".") and "package.json" in files:
            (target / relative).mkdir(parents=True, exist_ok=True)
            shutil.copy2(pathlib.Path(root) / "package.json", target / relative / "package.json")


def collect(web: pathlib.Path = WEB, run: PnpmRunner = _run_pnpm) -> Inventory:
    """Install every locked package into a scratch directory and read its license."""
    lock_text = (web / "pnpm-lock.yaml").read_text(encoding="utf-8")
    workspace_text = (web / "pnpm-workspace.yaml").read_text(encoding="utf-8")
    platforms = lockfile_platforms(lock_text)

    with tempfile.TemporaryDirectory(prefix="npm-license-inventory-", ignore_cleanup_errors=True) as tmp:
        sandbox = pathlib.Path(tmp)
        _copy_manifests(web, sandbox)
        (sandbox / "pnpm-workspace.yaml").write_text(
            sandbox_workspace_file(workspace_text, platforms), encoding="utf-8"
        )
        run(["install", "--frozen-lockfile", "--ignore-scripts"], sandbox)
        everything = parse_licenses_json(run(["-r", "licenses", "list", "--json"], sandbox))
        production = parse_licenses_json(run(["-r", "licenses", "list", "--json", "--prod"], sandbox))

    installed = {(p.name, p.version) for p in everything}
    missing = missing_from_install(lockfile_packages(lock_text), installed)
    if missing:
        listing = ", ".join(f"{name}@{version}" for name, version in missing)
        raise InventoryError(
            f"{len(missing)} locked package(s) were not found by the inventory and would "
            f"go unchecked: {listing}"
        )
    runtime = frozenset((p.name, p.version) for p in production)
    return Inventory(tuple(everything), runtime)
