#!/usr/bin/env python3
"""Unit tests for mutation_gate.py (the pass/fail decision on a mutmut run).

The gate is the only thing that turns a surviving mutant into a red check, because
`mutmut run` itself always exits 0. Each test pins one outcome that must fail the run,
and the one outcome that must pass.

    python3 -m unittest discover -s scripts/ci -p "test_*.py"
"""
from __future__ import annotations

import contextlib
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import mutation_gate as gate  # noqa: E402


def stats(**overrides: object) -> dict[str, object]:
    """A clean run of 10 mutants, 8 killed and 2 timeouts, with some counters changed."""
    base: dict[str, object] = {
        "killed": 8,
        "survived": 0,
        "total": 10,
        "no_tests": 0,
        "skipped": 0,
        "suspicious": 0,
        "timeout": 2,
        "check_was_interrupted_by_user": 0,
        "segfault": 0,
    }
    base.update(overrides)
    return base


def run_main(argv: list[str]) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = gate.main(argv)
    return code, out.getvalue(), err.getvalue()


class ProblemsTests(unittest.TestCase):
    def test_a_clean_run_has_no_problem(self) -> None:
        self.assertEqual(gate.problems(stats()), [])

    def test_timeouts_count_as_caught(self) -> None:
        self.assertEqual(gate.problems(stats(killed=0, timeout=10)), [])

    def test_a_survivor_fails(self) -> None:
        self.assertEqual(
            gate.problems(stats(killed=7, survived=1)),
            ["1 mutant(s) survived: no test failed"],
        )

    def test_a_mutant_without_a_test_fails(self) -> None:
        self.assertEqual(
            gate.problems(stats(killed=6, no_tests=2)),
            ["2 mutant(s) have no test: no test calls the mutated function"],
        )

    def test_a_suspicious_mutant_fails(self) -> None:
        self.assertEqual(
            gate.problems(stats(killed=7, suspicious=1)),
            ["1 mutant(s) are suspicious: the test run ended in an unexpected state"],
        )

    def test_a_skipped_mutant_fails(self) -> None:
        self.assertEqual(gate.problems(stats(killed=7, skipped=1)), ["1 mutant(s) were skipped"])

    def test_an_interrupted_run_fails(self) -> None:
        self.assertEqual(
            gate.problems(stats(killed=7, check_was_interrupted_by_user=1)),
            ["1 mutant(s) were interrupted"],
        )

    def test_a_crash_fails(self) -> None:
        self.assertEqual(
            gate.problems(stats(killed=7, segfault=1)),
            ["1 mutant(s) crashed the interpreter"],
        )

    def test_a_mutant_that_was_never_checked_fails(self) -> None:
        self.assertEqual(
            gate.problems(stats(killed=5)),
            ["3 mutant(s) were never checked (total 10, accounted 7)"],
        )

    def test_an_empty_run_fails(self) -> None:
        self.assertEqual(
            gate.problems(stats(killed=0, timeout=0, total=0)),
            ["no mutants were generated: the mutmut setup is broken"],
        )

    def test_every_problem_is_reported(self) -> None:
        found = gate.problems(stats(killed=4, survived=2, no_tests=1))
        self.assertEqual(len(found), 3, found)

    def test_a_counter_must_be_a_non_negative_integer(self) -> None:
        for bad in (-1, 1.5, "3", None, True):
            with self.subTest(value=bad), self.assertRaises(gate.StatsError) as caught:
                gate.problems(stats(survived=bad))
            self.assertEqual(str(caught.exception), f"'survived' is not a non-negative integer: {bad!r}")

    def test_a_missing_counter_is_an_error(self) -> None:
        data = stats()
        del data["segfault"]
        with self.assertRaises(gate.StatsError) as caught:
            gate.problems(data)
        self.assertEqual(str(caught.exception), "'segfault' is not a non-negative integer: None")

    def test_the_total_is_read_first(self) -> None:
        data = stats()
        del data["total"]
        with self.assertRaises(gate.StatsError) as caught:
            gate.problems(data)
        self.assertEqual(str(caught.exception), "'total' is not a non-negative integer: None")


class SummaryTests(unittest.TestCase):
    def test_the_summary_names_every_counter(self) -> None:
        self.assertEqual(
            gate.summary(stats(killed=6, survived=1, no_tests=1)),
            "total 10, killed 6, timeout 2, survived 1, no tests 1, suspicious 0, skipped 0, "
            "check was interrupted by user 0, segfault 0",
        )


class LoadTests(unittest.TestCase):
    def write(self, directory: str, text: str) -> pathlib.Path:
        path = pathlib.Path(directory) / "stats.json"
        path.write_text(text, encoding="utf-8")
        return path

    def test_it_reads_the_json_object(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(gate.load(self.write(tmp, json.dumps(stats()))), stats())

    def test_a_missing_file_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(gate.StatsError) as caught:
            gate.load(pathlib.Path(tmp) / "absent.json")
        self.assertTrue(str(caught.exception).startswith("cannot read "), str(caught.exception))
        self.assertIn("absent.json", str(caught.exception))

    def test_invalid_json_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(gate.StatsError) as caught:
            gate.load(self.write(tmp, "{not json"))
        self.assertTrue(str(caught.exception).startswith("cannot read "), str(caught.exception))

    def test_anything_but_an_object_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(tmp, "[1, 2]")
            with self.assertRaises(gate.StatsError) as caught:
                gate.load(path)
            self.assertEqual(str(caught.exception), f"{path} is not a JSON object")

    def test_the_file_is_read_as_utf8(self) -> None:
        path = pathlib.Path("stats.json")
        with mock.patch.object(pathlib.Path, "read_text", autospec=True, return_value="{}") as spy:
            gate.load(path)
        spy.assert_called_once_with(path, encoding="utf-8")

    def test_the_default_file_is_the_one_mutmut_writes(self) -> None:
        self.assertEqual(gate.DEFAULT_STATS, pathlib.Path("mutants") / "mutmut-cicd-stats.json")


class MainTests(unittest.TestCase):
    def run_with(self, data: object) -> tuple[int, str, str]:
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "stats.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            return run_main(["mutation_gate.py", str(path)])

    def test_a_clean_run_passes(self) -> None:
        code, out, err = self.run_with(stats())
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertIn("mutmut: total 10, killed 8, timeout 2, survived 0", out)
        self.assertTrue(out.endswith("OK: every mutant was caught.\n"), out)

    def test_a_survivor_fails_with_the_fix(self) -> None:
        code, out, err = self.run_with(stats(killed=7, survived=1))
        self.assertEqual(code, 1)
        self.assertEqual(err, "")
        self.assertIn("::error::1 mutant(s) survived: no test failed\n", out)
        self.assertEqual(
            out,
            "mutmut: total 10, killed 7, timeout 2, survived 1, no tests 0, suspicious 0, skipped 0, "
            "check was interrupted by user 0, segfault 0\n"
            "::error::1 mutant(s) survived: no test failed\n"
            "Fix: add a test that fails for the mutant (`mutmut results`, `mutmut show <name>`); "
            "do not skip it. Only a mutant that provably cannot change behaviour gets "
            "`# pragma: no mutate` with the reason next to it (CONTRIBUTING.md).\n",
        )

    def test_a_missing_file_is_a_setup_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            code, out, err = run_main(["mutation_gate.py", str(pathlib.Path(tmp) / "absent.json")])
        self.assertEqual((code, out), (2, ""))
        self.assertTrue(err.startswith("error: cannot read "), err)

    def test_a_bad_counter_is_a_setup_error(self) -> None:
        code, out, err = self.run_with(stats(survived="x"))
        self.assertEqual((code, out), (2, ""))
        self.assertEqual(err, "error: 'survived' is not a non-negative integer: 'x'\n")

    def test_too_many_arguments_are_refused(self) -> None:
        code, out, err = run_main(["mutation_gate.py", "a", "b"])
        self.assertEqual((code, out), (2, ""))
        self.assertEqual(err, "usage: mutation_gate.py [stats.json]\n")

    def test_without_an_argument_the_default_file_is_read(self) -> None:
        stats_file = gate.DEFAULT_STATS
        if stats_file.exists():
            self.skipTest("a mutants/ directory exists in the working directory")
        code, out, err = run_main(["mutation_gate.py"])
        self.assertEqual((code, out), (2, ""))
        self.assertIn(str(stats_file), err)


if __name__ == "__main__":
    unittest.main()
