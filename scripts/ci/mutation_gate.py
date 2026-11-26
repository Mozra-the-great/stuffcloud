#!/usr/bin/env python3
"""CI gate: mutation testing of the Python helpers in scripts/ci must leave no mutant alive (#161).

`mutmut run` exits 0 whatever it found, so this script reads the summary that
`mutmut export-cicd-stats` writes (`mutants/mutmut-cicd-stats.json`) and decides. Like
`cargo mutants` for the Rust code, a surviving mutant is a missing test (ADR 0007, CLAUDE.md
"Tests"): the run fails when a mutant

* survived (no test failed),
* has no test at all (no test calls the mutated function),
* is suspicious, was skipped or interrupted, or crashed the interpreter,
* was never checked (the counts do not add up to the total), or when
* there is nothing to check (an empty run is a broken setup, not a pass).

A mutant that makes the tests hang (an endless loop) is reported as a timeout. That is a
caught mutant, as with cargo-mutants' time limit, and is shown in the summary.

    python3 scripts/ci/mutation_gate.py [mutants/mutmut-cicd-stats.json]

Standard library only (Python 3.11+); mutmut itself is only needed to produce the file.
"""
from __future__ import annotations

import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

DEFAULT_STATS = Path("mutants") / "mutmut-cicd-stats.json"

# The counters of the summary and what each one means for the gate. `killed` and `timeout`
# are the only good outcomes.
GOOD = ("killed", "timeout")
BAD = {
    "survived": "survived: no test failed",
    "no_tests": "have no test: no test calls the mutated function",
    "suspicious": "are suspicious: the test run ended in an unexpected state",
    "skipped": "were skipped",
    "check_was_interrupted_by_user": "were interrupted",
    "segfault": "crashed the interpreter",
}


class StatsError(Exception):
    """The summary file is missing or not what `mutmut export-cicd-stats` writes."""


def counter(stats: Mapping[str, object], key: str) -> int:
    value = stats.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise StatsError(f"{key!r} is not a non-negative integer: {value!r}")
    return value


def load(path: Path) -> dict[str, object]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise StatsError(f"cannot read {path}: {err}") from err
    if not isinstance(data, dict):
        raise StatsError(f"{path} is not a JSON object")
    return data


def problems(stats: Mapping[str, object]) -> list[str]:
    """What is wrong with this run; empty when every mutant was caught."""
    total = counter(stats, "total")
    found: list[str] = []
    if total == 0:
        found.append("no mutants were generated: the mutmut setup is broken")
    for key, meaning in BAD.items():
        count = counter(stats, key)
        if count:
            found.append(f"{count} mutant(s) {meaning}")
    accounted = sum(counter(stats, key) for key in (*GOOD, *BAD))
    if accounted != total:
        found.append(f"{total - accounted} mutant(s) were never checked (total {total}, accounted {accounted})")
    return found


def summary(stats: Mapping[str, object]) -> str:
    parts = [f"{key.replace('_', ' ')} {counter(stats, key)}" for key in ("total", *GOOD, *BAD)]
    return ", ".join(parts)


def main(argv: Sequence[str]) -> int:
    if len(argv) > 2:
        print("usage: mutation_gate.py [stats.json]", file=sys.stderr)
        return 2
    path = Path(argv[1]) if len(argv) == 2 else DEFAULT_STATS
    try:
        stats = load(path)
        found = problems(stats)
        line = summary(stats)
    except StatsError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    print(f"mutmut: {line}")
    if found:
        for finding in found:
            print(f"::error::{finding}")
        print(
            "Fix: add a test that fails for the mutant (`mutmut results`, `mutmut show <name>`); "
            "do not skip it. Only a mutant that provably cannot change behaviour gets "
            "`# pragma: no mutate` with the reason next to it (CONTRIBUTING.md)."
        )
        return 1
    print("OK: every mutant was caught.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
