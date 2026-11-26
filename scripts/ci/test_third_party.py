#!/usr/bin/env python3
"""Unit tests for third_party.py (the THIRD-PARTY.md generator) and the pnpm/cargo
process wrappers.

The staleness check in CI is only worth something if a stale file really fails and
an unchanged dependency set really gives the same bytes, so both are pinned here,
together with the rule that decides which crates count as runtime dependencies.

    python3 -m unittest discover -s scripts/ci -p "test_*.py"
"""
from __future__ import annotations

import contextlib
import io
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import npm_licenses as nl  # noqa: E402
import third_party as tp  # noqa: E402
from license_policy import Package  # noqa: E402

CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index"


def crate(name: str, license_text: str | None = "MIT", version: str = "1.0.0", source: str | None = CRATES_IO) -> dict:
    return {
        "id": f"{name}@{version}",
        "name": name,
        "version": version,
        "license": license_text,
        "source": source,
    }


def node(name: str, deps: list[tuple[str, list[str | None]]], version: str = "1.0.0") -> dict:
    return {
        "id": f"{name}@{version}",
        "deps": [
            {"name": dep, "pkg": f"{dep}@1.0.0", "dep_kinds": [{"kind": kind, "target": None} for kind in kinds]}
            for dep, kinds in deps
        ],
    }


def metadata(packages: list[dict], nodes: list[dict], members: list[str]) -> dict:
    return {
        "packages": packages,
        "resolve": {"nodes": nodes},
        "workspace_members": [f"{m}@1.0.0" for m in members],
    }


class TestRuntimeCrates(unittest.TestCase):
    def names(self, meta: dict) -> list[str]:
        return [c.name for c in tp.runtime_crates(meta)]

    def test_normal_and_build_dependencies_are_runtime(self):
        meta = metadata(
            [crate("me", "GPL-3.0-or-later", source=None), crate("lib"), crate("buildtool")],
            [node("me", [("lib", [None]), ("buildtool", ["build"])]), node("lib", []), node("buildtool", [])],
            ["me"],
        )
        self.assertEqual(self.names(meta), ["buildtool", "lib"])

    def test_dev_dependencies_are_excluded_with_everything_only_they_pull_in(self):
        meta = metadata(
            [crate("me", source=None), crate("proptest"), crate("rand"), crate("lib")],
            [
                node("me", [("proptest", ["dev"]), ("lib", [None])]),
                node("proptest", [("rand", [None])]),
                node("rand", []),
                node("lib", []),
            ],
            ["me"],
        )
        self.assertEqual(self.names(meta), ["lib"])

    def test_a_crate_that_is_dev_for_one_member_and_normal_for_another_is_runtime(self):
        meta = metadata(
            [crate("a", source=None), crate("b", source=None), crate("shared")],
            [node("a", [("shared", ["dev"])]), node("b", [("shared", [None])]), node("shared", [])],
            ["a", "b"],
        )
        self.assertEqual(self.names(meta), ["shared"])

    def test_an_edge_that_is_dev_and_normal_counts_as_runtime(self):
        meta = metadata(
            [crate("me", source=None), crate("both")],
            [node("me", [("both", ["dev", None])]), node("both", [])],
            ["me"],
        )
        self.assertEqual(self.names(meta), ["both"])

    def test_transitive_dependencies_are_followed(self):
        meta = metadata(
            [crate("me", source=None), crate("a"), crate("b"), crate("c")],
            [node("me", [("a", [None])]), node("a", [("b", [None])]), node("b", [("c", ["build"])]), node("c", [])],
            ["me"],
        )
        self.assertEqual(self.names(meta), ["a", "b", "c"])

    def test_diamonds_and_cycles_terminate_and_list_once(self):
        meta = metadata(
            [crate("me", source=None), crate("a"), crate("b"), crate("d")],
            [
                node("me", [("a", [None]), ("b", [None])]),
                node("a", [("d", [None])]),
                node("b", [("d", [None]), ("a", [None])]),
                node("d", [("a", [None])]),
            ],
            ["me"],
        )
        self.assertEqual(self.names(meta), ["a", "b", "d"])

    def test_workspace_members_are_not_listed(self):
        meta = metadata(
            [crate("me", "GPL-3.0-or-later", source=None), crate("other", "GPL-3.0-or-later", source=None)],
            [node("me", [("other", [None])]), node("other", [])],
            ["me", "other"],
        )
        self.assertEqual(self.names(meta), [])

    def test_two_versions_of_a_crate_are_listed_separately_and_sorted(self):
        packages = [crate("me", source=None), crate("dup", version="2.0.0"), crate("dup", version="1.0.0")]
        n = node("me", [])
        n["deps"] = [
            {"name": "dup", "pkg": "dup@2.0.0", "dep_kinds": [{"kind": None, "target": None}]},
            {"name": "dup", "pkg": "dup@1.0.0", "dep_kinds": [{"kind": None, "target": None}]},
        ]
        meta = metadata(packages, [n, {"id": "dup@2.0.0", "deps": []}, {"id": "dup@1.0.0", "deps": []}], ["me"])
        self.assertEqual([(c.name, c.version) for c in tp.runtime_crates(meta)], [("dup", "1.0.0"), ("dup", "2.0.0")])

    def test_a_crate_without_a_license_field_is_an_error(self):
        meta = metadata(
            [crate("me", source=None), crate("nolic", None)],
            [node("me", [("nolic", [None])]), node("nolic", [])],
            ["me"],
        )
        with self.assertRaisesRegex(tp.ReportError, "nolic 1.0.0 declares no license"):
            tp.runtime_crates(meta)

    def test_malformed_metadata_is_an_error(self):
        for bad in ({}, {"packages": []}, {"packages": [], "resolve": {"nodes": []}}):
            with self.subTest(bad), self.assertRaisesRegex(tp.ReportError, "unexpected `cargo metadata`"):
                tp.runtime_crates(bad)

    def test_nothing_to_report_for_a_workspace_without_dependencies(self):
        meta = metadata([crate("me", source=None)], [node("me", [])], ["me"])
        self.assertEqual(tp.runtime_crates(meta), [])


class TestRender(unittest.TestCase):
    CRATES = [
        tp.CratePackage("tinyvec", "1.13.3", "Zlib OR Apache-2.0 OR MIT", CRATES_IO),
        tp.CratePackage("odd", "0.1.0", "MIT | ISC", "git+https://example.invalid/odd"),
    ]
    NPM = [Package("@scope/pkg", "1.2.3", "MIT"), Package("plain", "4.5.6", "(MIT OR CC0-1.0)")]

    def test_lists_every_dependency_with_name_version_license_and_source(self):
        text = tp.render(self.CRATES, self.NPM)
        self.assertIn(
            "| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/tinyvec/1.13.3) |",
            text,
        )
        self.assertIn(
            "| @scope/pkg | 1.2.3 | MIT | [npm](https://www.npmjs.com/package/@scope/pkg/v/1.2.3) |", text
        )
        self.assertIn("| plain | 4.5.6 | (MIT OR CC0-1.0) | [npm](", text)

    def test_counts_are_in_the_headings(self):
        text = tp.render(self.CRATES, self.NPM)
        self.assertIn("## Rust (2)", text)
        self.assertIn("## npm (2)", text)

    def test_pipes_are_escaped_and_foreign_sources_are_shown_verbatim(self):
        text = tp.render(self.CRATES, [])
        self.assertIn("| odd | 0.1.0 | MIT \\| ISC | git+https://example.invalid/odd |", text)

    def test_unknown_source_is_marked(self):
        self.assertEqual(tp.crate_source(tp.CratePackage("x", "1.0.0", "MIT", "")), "unknown")

    def test_sparse_registry_counts_as_crates_io(self):
        crate_pkg = tp.CratePackage("x", "1.0.0", "MIT", "sparse+https://index.crates.io/")
        self.assertEqual(tp.crate_source(crate_pkg), "[crates.io](https://crates.io/crates/x/1.0.0)")

    def test_empty_sections_say_so(self):
        text = tp.render([], [])
        self.assertIn("## Rust (0)\n\nNo runtime dependencies.", text)
        self.assertIn("## npm (0)\n\nNo runtime dependencies.", text)

    def test_header_marks_the_file_as_generated_and_points_to_the_assets_file(self):
        text = tp.render([], [])
        self.assertTrue(text.startswith("# Third-party dependencies\n"))
        self.assertIn("Generated by scripts/ci/third_party.py. Do not edit", text)
        self.assertIn("THIRD-PARTY-ASSETS.md", text)

    def test_output_is_deterministic_and_ends_with_one_newline(self):
        first = tp.render(self.CRATES, self.NPM)
        self.assertEqual(first, tp.render(self.CRATES, self.NPM))
        self.assertTrue(first.endswith("|\n"))
        self.assertFalse(first.endswith("\n\n"))
        self.assertNotIn("\r", first)


class TestGenerate(unittest.TestCase):
    def test_only_runtime_npm_packages_are_listed_sorted(self):
        meta = metadata([crate("me", source=None)], [node("me", [])], ["me"])
        inventory = nl.Inventory(
            (Package("zeta", "1.0.0", "MIT"), Package("dev-tool", "9.0.0", "MIT"), Package("alpha", "2.0.0", "ISC")),
            frozenset({("zeta", "1.0.0"), ("alpha", "2.0.0")}),
        )
        text = tp.generate(meta, inventory)
        self.assertIn("## npm (2)", text)
        self.assertNotIn("dev-tool", text)
        self.assertLess(text.index("alpha"), text.index("zeta"))


class TestCheckMode(unittest.TestCase):
    FRESH = "# Third-party dependencies\n\n| a | 1 |\n"

    def run_main(self, args: list[str], committed: str | None):
        with tempfile.TemporaryDirectory() as tmp:
            output = pathlib.Path(tmp) / "THIRD-PARTY.md"
            if committed is not None:
                output.write_text(committed, encoding="utf-8")
            out, err = io.StringIO(), io.StringIO()
            with (
                mock.patch.object(tp, "generate", return_value=self.FRESH),
                contextlib.redirect_stdout(out),
                contextlib.redirect_stderr(err),
            ):
                code = tp.main([*args, "--output", str(output)])
            written = output.read_text(encoding="utf-8") if output.exists() else None
            return code, out.getvalue(), err.getvalue(), written

    def test_current_file_passes(self):
        code, out, _, _ = self.run_main(["--check"], self.FRESH)
        self.assertEqual(code, 0)
        self.assertIn("is current", out)

    def test_stale_file_fails_and_shows_the_diff(self):
        code, out, _, _ = self.run_main(["--check"], self.FRESH.replace("| a | 1 |", "| a | 0 |"))
        self.assertEqual(code, 1)
        self.assertIn("-| a | 0 |", out)
        self.assertIn("+| a | 1 |", out)
        self.assertIn("::error::docs/THIRD-PARTY.md is stale", out)

    def test_missing_file_fails(self):
        code, out, _, _ = self.run_main(["--check"], None)
        self.assertEqual(code, 1)
        self.assertIn("stale", out)

    def test_extra_line_in_the_committed_file_fails(self):
        code, _, _, _ = self.run_main(["--check"], self.FRESH + "| manual edit | x |\n")
        self.assertEqual(code, 1)

    def test_write_creates_the_file_and_check_then_passes(self):
        code, _, _, written = self.run_main(["--write"], None)
        self.assertEqual(code, 0)
        self.assertEqual(written, self.FRESH)

    def test_write_replaces_a_stale_file(self):
        _, _, _, written = self.run_main(["--write"], "old\n")
        self.assertEqual(written, self.FRESH)

    def test_a_mode_is_required(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            tp.main([])

    def test_data_errors_are_setup_errors(self):
        for error in (tp.ReportError("no cargo"), nl.InventoryError("no pnpm")):
            with self.subTest(error), tempfile.TemporaryDirectory() as tmp:
                err = io.StringIO()
                with mock.patch.object(tp, "generate", side_effect=error), contextlib.redirect_stderr(err):
                    code = tp.main(["--check", "--output", str(pathlib.Path(tmp) / "x.md")])
                self.assertEqual(code, 2)
                self.assertIn(f"error: {error}", err.getvalue())

    def test_check_text_is_empty_for_equal_texts(self):
        self.assertEqual(tp.check_text("a\nb\n", "a\nb\n"), [])


class TestProcessWrappers(unittest.TestCase):
    def completed(self, code: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(args=[], returncode=code, stdout=stdout, stderr=stderr)

    def test_cargo_metadata_is_parsed(self):
        with mock.patch.object(subprocess, "run", return_value=self.completed(0, '{"packages": []}')) as run:
            self.assertEqual(tp.collect_cargo(pathlib.Path(".")), {"packages": []})
        self.assertEqual(run.call_args.args[0], ["cargo", "metadata", "--locked", "--format-version", "1"])
        self.assertFalse(run.call_args.kwargs.get("shell", False))

    def test_cargo_failure_is_reported_with_its_message(self):
        with mock.patch.object(subprocess, "run", return_value=self.completed(101, stderr="lock file needs update")):
            with self.assertRaisesRegex(tp.ReportError, "lock file needs update"):
                tp.collect_cargo(pathlib.Path("."))

    def test_pnpm_missing_is_reported(self):
        with mock.patch("shutil.which", return_value=None):
            with self.assertRaisesRegex(nl.InventoryError, "pnpm not found"):
                nl._run_pnpm(["install"], pathlib.Path("."))

    def test_pnpm_failure_is_reported_with_its_message(self):
        with (
            mock.patch("shutil.which", return_value="/bin/pnpm"),
            mock.patch.object(subprocess, "run", return_value=self.completed(1, stderr="ERR_PNPM_LOCKFILE")),
        ):
            with self.assertRaisesRegex(nl.InventoryError, r"(?s)`pnpm install --frozen-lockfile` failed \(1\).*ERR_PNPM_LOCKFILE"):
                nl._run_pnpm(["install", "--frozen-lockfile"], pathlib.Path("."))

    def test_pnpm_success_returns_stdout_and_runs_without_a_shell(self):
        with (
            mock.patch("shutil.which", return_value="/bin/pnpm"),
            mock.patch.object(subprocess, "run", return_value=self.completed(0, "{}")) as run,
        ):
            self.assertEqual(nl._run_pnpm(["-r", "licenses"], pathlib.Path(".")), "{}")
        self.assertEqual(run.call_args.args[0], ["/bin/pnpm", "-r", "licenses"])
        self.assertFalse(run.call_args.kwargs.get("shell", False))
        self.assertEqual(run.call_args.kwargs["env"]["COREPACK_ENABLE_DOWNLOAD_PROMPT"], "0")


HEADER = [
    "# Third-party dependencies",
    "",
    "<!-- Generated by scripts/ci/third_party.py. Do not edit: CI fails when this file is stale. "
    "Regenerate with `python3 scripts/ci/third_party.py --write`. -->",
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
]


class TestGolden(unittest.TestCase):
    """The whole generated file, line for line: it is committed, so every character counts."""

    def test_the_rendered_file(self):
        crates = [
            tp.CratePackage("tinyvec", "1.13.3", "Zlib OR Apache-2.0 OR MIT", CRATES_IO),
            tp.CratePackage("odd", "0.1.0", "MIT | ISC", "git+https://example.invalid/odd"),
        ]
        npm = [Package("@scope/pkg", "1.2.3", "MIT"), Package("plain", "4.5.6", "(MIT OR CC0-1.0)")]
        expected = [
            *HEADER,
            "## Rust (2)",
            "",
            "| Name | Version | License | Source |",
            "|---|---|---|---|",
            "| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/tinyvec/1.13.3) |",
            "| odd | 0.1.0 | MIT \\| ISC | git+https://example.invalid/odd |",
            "",
            "## npm (2)",
            "",
            "| Name | Version | License | Source |",
            "|---|---|---|---|",
            "| @scope/pkg | 1.2.3 | MIT | [npm](https://www.npmjs.com/package/@scope/pkg/v/1.2.3) |",
            "| plain | 4.5.6 | (MIT OR CC0-1.0) | [npm](https://www.npmjs.com/package/plain/v/4.5.6) |",
        ]
        self.assertEqual(tp.render(crates, npm), "\n".join(expected) + "\n")

    def test_the_rendered_empty_file(self):
        expected = [
            *HEADER,
            "## Rust (0)",
            "",
            "No runtime dependencies.",
            "",
            "## npm (0)",
            "",
            "No runtime dependencies.",
        ]
        self.assertEqual(tp.render([], []), "\n".join(expected) + "\n")

    def test_a_table_is_a_header_a_rule_and_one_row_per_entry(self):
        self.assertEqual(
            tp._table([("a", "1", "MIT", "s"), ("b|c", "2", "x|y", "t")]),
            [
                "| Name | Version | License | Source |",
                "|---|---|---|---|",
                "| a | 1 | MIT | s |",
                "| b\\|c | 2 | x\\|y | t |",
            ],
        )
        self.assertEqual(tp._table([]), ["| Name | Version | License | Source |", "|---|---|---|---|"])


class TestRuntimeCratesDetails(unittest.TestCase):
    def test_a_member_without_a_node_does_not_stop_the_walk(self):
        # "gone" is popped first (the stack is last in, first out) and has no node at all.
        meta = metadata(
            [crate("a", source=None), crate("gone", source=None), crate("lib")],
            [node("a", [("lib", [None])]), node("lib", [])],
            ["a", "gone"],
        )
        self.assertEqual([c.name for c in tp.runtime_crates(meta)], ["lib"])

    def test_nodes_and_edges_may_lack_their_lists(self):
        bare_node = {"id": "me@1.0.0"}
        meta = metadata([crate("me", source=None)], [bare_node], ["me"])
        self.assertEqual(tp.runtime_crates(meta), [])
        edge_without_kinds = {"id": "me@1.0.0", "deps": [{"name": "lib", "pkg": "lib@1.0.0"}]}
        meta = metadata([crate("me", source=None), crate("lib")], [edge_without_kinds, {"id": "lib@1.0.0"}], ["me"])
        self.assertEqual(tp.runtime_crates(meta), [])

    def test_a_crate_is_reported_with_all_four_fields(self):
        meta = metadata(
            [crate("me", source=None), crate("lib", "MIT OR ISC", "2.3.4"), crate("local", "MIT", "0.1.0", None)],
            [
                {"id": "me@1.0.0", "deps": [
                    {"name": "lib", "pkg": "lib@2.3.4", "dep_kinds": [{"kind": None}]},
                    {"name": "local", "pkg": "local@0.1.0", "dep_kinds": [{"kind": "build"}]},
                ]},
                {"id": "lib@2.3.4"},
                {"id": "local@0.1.0"},
            ],
            ["me"],
        )
        self.assertEqual(
            tp.runtime_crates(meta),
            [tp.CratePackage("lib", "2.3.4", "MIT OR ISC", CRATES_IO), tp.CratePackage("local", "0.1.0", "MIT", "")],
        )

    def test_the_missing_license_message_is_exact(self):
        meta = metadata(
            [crate("me", source=None), crate("nolic", None)],
            [node("me", [("nolic", [None])]), node("nolic", [])],
            ["me"],
        )
        with self.assertRaises(tp.ReportError) as caught:
            tp.runtime_crates(meta)
        self.assertEqual(
            str(caught.exception),
            "nolic 1.0.0 declares no license field (cargo-deny checks its license file; "
            "list it in the report by hand once decided)",
        )

    def test_the_malformed_metadata_message_names_the_missing_key(self):
        with self.assertRaises(tp.ReportError) as caught:
            tp.runtime_crates({})
        self.assertEqual(str(caught.exception), "unexpected `cargo metadata` output: missing 'packages'")


class TestCollectCargoCall(unittest.TestCase):
    def test_cargo_runs_in_the_repository_with_captured_utf8_text(self):
        done = subprocess.CompletedProcess([], 0, stdout="{}", stderr="")
        with mock.patch.object(subprocess, "run", return_value=done) as run:
            tp.collect_cargo(pathlib.Path("somewhere"))
        run.assert_called_once_with(
            ["cargo", "metadata", "--locked", "--format-version", "1"],
            cwd=pathlib.Path("somewhere"),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )

    def test_the_failure_message_is_exact(self):
        done = subprocess.CompletedProcess([], 101, stdout="", stderr="  lock file needs update \n")
        with mock.patch.object(subprocess, "run", return_value=done), self.assertRaises(tp.ReportError) as caught:
            tp.collect_cargo(pathlib.Path("."))
        self.assertEqual(str(caught.exception), "`cargo metadata` failed:\nlock file needs update")


class TestGenerateDefaults(unittest.TestCase):
    def test_missing_arguments_are_collected_and_given_ones_are_not(self):
        meta = metadata([crate("me", source=None)], [node("me", [])], ["me"])
        inventory = nl.Inventory((), frozenset())
        with (
            mock.patch.object(tp, "collect_cargo", return_value=meta) as cargo,
            mock.patch.object(nl, "collect", return_value=inventory) as npm,
        ):
            tp.generate()
            self.assertEqual((cargo.call_count, npm.call_count), (1, 1))
            tp.generate(meta, inventory)
            self.assertEqual((cargo.call_count, npm.call_count), (1, 1))
            tp.generate(None, inventory)
            self.assertEqual((cargo.call_count, npm.call_count), (2, 1))
            tp.generate(meta, None)
            self.assertEqual((cargo.call_count, npm.call_count), (2, 2))


class TestCheckTextDiff(unittest.TestCase):
    def test_the_diff_names_both_files_and_has_no_line_endings(self):
        self.assertEqual(
            tp.check_text("a\nb\n", "a\nc\n"),
            [
                "--- docs/THIRD-PARTY.md (committed)",
                "+++ docs/THIRD-PARTY.md (regenerated)",
                "@@ -1,2 +1,2 @@",
                " a",
                "-c",
                "+b",
            ],
        )


class TestCommandLine(unittest.TestCase):
    def run_main(self, args: list[str], committed: str | None, fresh: str = "new\n", **env: str):
        with tempfile.TemporaryDirectory() as tmp:
            output = pathlib.Path(tmp) / "THIRD-PARTY.md"
            if committed is not None:
                output.write_text(committed, encoding="utf-8")
            out = io.StringIO()
            with (
                mock.patch.object(tp, "generate", return_value=fresh),
                mock.patch.object(tp, "OUTPUT", output),
                mock.patch.dict("os.environ", env),
                contextlib.redirect_stdout(out),
            ):
                code = tp.main(args)
            written = output.read_bytes() if output.exists() else None
            return code, out.getvalue(), written, output

    def test_write_reports_the_path_and_writes_utf8_with_unix_line_endings(self):
        code, out, written, output = self.run_main(["--write"], None, fresh="café\nx\n")
        self.assertEqual((code, written), (0, "café\nx\n".encode("utf-8")))
        self.assertEqual(out, f"wrote {output}\n")

    def test_write_uses_unix_line_endings_whatever_the_platform(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = pathlib.Path(tmp) / "x.md"
            with mock.patch.object(tp, "generate", return_value="a\nb\n"), contextlib.redirect_stdout(io.StringIO()):
                with mock.patch.object(pathlib.Path, "write_text", autospec=True) as write:
                    tp.main(["--write", "--output", str(output)])
        write.assert_called_once_with(output, "a\nb\n", encoding="utf-8", newline="\n")

    def test_the_default_output_is_docs_third_party(self):
        code, out, _, _ = self.run_main(["--check"], "new\n")
        self.assertEqual((code, out), (0, "docs/THIRD-PARTY.md is current.\n"))

    def test_the_committed_file_is_read_as_utf8(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = pathlib.Path(tmp) / "x.md"
            output.write_text("café\n", encoding="utf-8")
            real = pathlib.Path.read_text
            seen: list[object] = []

            def spy(path, *args, **kwargs):
                seen.append(kwargs.get("encoding"))
                return real(path, *args, **kwargs)

            with (
                mock.patch.object(tp, "generate", return_value="café\n"),
                mock.patch.object(pathlib.Path, "read_text", spy),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(tp.main(["--check", "--output", str(output)]), 0)
        self.assertEqual(seen, ["utf-8"])

    def test_a_stale_file_prints_the_diff_and_the_fix(self):
        code, out, _, _ = self.run_main(["--check"], "old\n", fresh="new\n")
        self.assertEqual(code, 1)
        self.assertEqual(
            out,
            "--- docs/THIRD-PARTY.md (committed)\n"
            "+++ docs/THIRD-PARTY.md (regenerated)\n"
            "@@ -1 +1 @@\n"
            "-old\n"
            "+new\n"
            "::error::docs/THIRD-PARTY.md is stale. Run "
            "`python3 scripts/ci/third_party.py --write` and commit the result.\n",
        )

    def test_a_missing_file_is_compared_as_empty(self):
        code, out, _, _ = self.run_main(["--check"], None, fresh="new\n")
        self.assertEqual(code, 1)
        self.assertTrue(
            out.startswith(
                "--- docs/THIRD-PARTY.md (committed)\n"
                "+++ docs/THIRD-PARTY.md (regenerated)\n"
                "@@ -0,0 +1 @@\n"
                "+new\n"
                "::error::"
            ),
            out,
        )

    def test_a_long_diff_is_cut_after_200_lines(self):
        fresh = "".join(f"line {n}\n" for n in range(500))
        code, out, _, _ = self.run_main(["--check"], "", fresh=fresh)
        self.assertEqual(code, 1)
        lines = out.splitlines()
        self.assertEqual(len(lines), 201)
        self.assertEqual(lines[0], "--- docs/THIRD-PARTY.md (committed)")
        self.assertEqual(lines[199], "+line 196")
        self.assertTrue(lines[200].startswith("::error::"), lines[200])

    def test_the_help_describes_the_modes(self):
        out = io.StringIO()
        with mock.patch.dict("os.environ", {"COLUMNS": "400"}), contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit) as caught:
                tp.main(["--help"])
        self.assertEqual(caught.exception.code, 0)
        text = out.getvalue()
        self.assertIn("Generate docs/THIRD-PARTY.md: every runtime dependency with version, license, source.", text)
        self.assertRegex(text, r"--write\s+regenerate docs/THIRD-PARTY\.md\s*\n")
        self.assertRegex(text, r"--check\s+fail if docs/THIRD-PARTY\.md is stale\s*\n")
        self.assertNotIn("--output", text)

    def test_both_modes_at_once_are_refused(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            tp.main(["--write", "--check"])


if __name__ == "__main__":
    unittest.main()
