#!/usr/bin/env python3
"""CI gate: every npm dependency of web/ must have an acceptable license.

Checks all packages of the pnpm workspace (production and dev, every platform
variant of native packages) against `scripts/ci/license-policy.toml` and exits 1
listing each package that fails. See `license_policy.py` for the rules and
`npm_licenses.py` for how the inventory is built.

    python3 scripts/ci/license_gate.py

The Rust side is gated by `cargo deny check` (deny.toml).

Standard library only (Python 3.11+).
"""
from __future__ import annotations

import pathlib
import sys
from collections.abc import Callable

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import license_policy  # noqa: E402
import npm_licenses  # noqa: E402


def run(
    policy_file: pathlib.Path = license_policy.POLICY_FILE,
    web: pathlib.Path = npm_licenses.WEB,
    collect: Callable[[pathlib.Path], npm_licenses.Inventory] = npm_licenses.collect,
) -> int:
    """Return the process exit code: 0 pass, 1 license violations, 2 setup error."""
    try:
        policy = license_policy.load_policy(policy_file)
        inventory = collect(web)
    except (license_policy.PolicyError, npm_licenses.InventoryError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 2

    result = license_policy.check(list(inventory.packages), set(inventory.runtime), policy)
    for exception in result.unused_exceptions:
        # Not an error: a dependency update may drop the package. Tidy the policy.
        print(
            f"::warning::license-policy.toml: exception for {exception.name} "
            f"({exception.license!r}) matches no installed package; remove it"
        )
    total = len(inventory.packages)
    if result.violations:
        print(f"{len(result.violations)} of {total} npm packages fail the license policy:")
        for violation in result.violations:
            print(f"::error::{violation}")
        print(
            "Fix: replace the dependency, or (after checking GPLv3 compatibility, "
            "docs/SPEC.md section 3) extend scripts/ci/license-policy.toml and deny.toml."
        )
        return 1
    runtime_count = len(inventory.runtime)
    print(f"OK: {total} npm packages ({runtime_count} runtime) all have an allowed license.")
    return 0


if __name__ == "__main__":
    sys.exit(run())
