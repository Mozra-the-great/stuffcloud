#!/usr/bin/env python3
"""Unit tests for npm_licenses.py and license_gate.py (inventory and gate runner).

pnpm itself is replaced by a fake runner, so these tests need neither pnpm nor a
network. The point is the glue: a locked package the inventory cannot see must fail
loudly (it would otherwise go unchecked), the scratch install must never touch
web/node_modules, and a policy violation must turn into exit code 1.

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
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import license_gate  # noqa: E402
import license_policy as lp  # noqa: E402
import npm_licenses as nl  # noqa: E402
from license_policy import Package  # noqa: E402

LOCKFILE = """\
---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.21.0
        version: 12.21.0

packages:

  '@pnpm/exe.linux-x64@12.21.0':
    resolution: {integrity: sha512-aaa}
    cpu: [x64]
    os: [linux]

  pnpm@12.21.0:
    resolution: {integrity: sha512-bbb}

snapshots:

  pnpm@12.21.0: {}
---
lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      eslint:
        specifier: ^10.0.0
        version: 10.15.0

packages:

  '@babel/code-frame@7.29.7':
    resolution: {integrity: sha512-ccc}
    engines: {node: '>=6.9.0'}

  eslint@10.15.0:
    resolution: {integrity: sha512-ddd}

  lightningcss-linux-arm64-musl@1.33.0:
    resolution: {integrity: sha512-eee}
    cpu: [arm64]
    os: [linux]
    libc: [musl]

  lightningcss-win32-x64-msvc@1.33.0:
    resolution: {integrity: sha512-fff}
    cpu: [x64]
    os: [win32]

  '@rolldown/binding-wasm32-wasi@1.2.19':
    resolution: {integrity: sha512-ggg}
    cpu: [wasm32]

snapshots:

  eslint@10.15.0: {}

settings:
  autoInstallPeers: true
"""


def licenses_json(groups: dict[str, list[tuple[str, list[str]]]]) -> str:
    return json.dumps(
        {
            license_text: [
                {"name": name, "versions": versions, "paths": ["/x"], "license": license_text}
                for name, versions in entries
            ]
            for license_text, entries in groups.items()
        }
    )


ALL_LOCKED = {
    "MIT": [("@babel/code-frame", ["7.29.7"]), ("eslint", ["10.15.0"])],
    "MPL-2.0": [
        ("lightningcss-linux-arm64-musl", ["1.33.0"]),
        ("lightningcss-win32-x64-msvc", ["1.33.0"]),
    ],
    "Apache-2.0": [("@rolldown/binding-wasm32-wasi", ["1.2.19"])],
}


class TestParsing(unittest.TestCase):
    def test_flattens_licenses_and_versions_sorted(self):
        text = licenses_json({"MIT": [("b", ["2.0.0", "1.0.0"]), ("a", ["1.0.0"])], "ISC": [("c", ["3.0.0"])]})
        self.assertEqual(
            nl.parse_licenses_json(text),
            [
                Package("a", "1.0.0", "MIT"),
                Package("b", "1.0.0", "MIT"),
                Package("b", "2.0.0", "MIT"),
                Package("c", "3.0.0", "ISC"),
            ],
        )

    def test_empty_output_is_an_empty_list(self):
        self.assertEqual(nl.parse_licenses_json("{}"), [])

    def test_same_package_under_two_licenses_keeps_both(self):
        text = licenses_json({"MIT": [("a", ["1.0.0"])], "Unknown": [("a", ["1.0.0"])]})
        self.assertEqual(len(nl.parse_licenses_json(text)), 2)

    def test_malformed_output_raises(self):
        bad_inputs = {
            "not json": "no packages",
            "array": "[]",
            "entries not a list": '{"MIT": {"name": "a"}}',
            "entry not an object": '{"MIT": ["a"]}',
            "missing name": '{"MIT": [{"versions": ["1.0.0"]}]}',
            "missing versions": '{"MIT": [{"name": "a"}]}',
            "empty versions": '{"MIT": [{"name": "a", "versions": []}]}',
            "version not a string": '{"MIT": [{"name": "a", "versions": [1]}]}',
        }
        for label, text in bad_inputs.items():
            with self.subTest(label), self.assertRaises(nl.InventoryError):
                nl.parse_licenses_json(text)


class TestLockfile(unittest.TestCase):
    def test_packages_come_from_the_project_document_only(self):
        self.assertEqual(
            nl.lockfile_packages(LOCKFILE),
            {
                ("@babel/code-frame", "7.29.7"),
                ("eslint", "10.15.0"),
                ("lightningcss-linux-arm64-musl", "1.33.0"),
                ("lightningcss-win32-x64-msvc", "1.33.0"),
                ("@rolldown/binding-wasm32-wasi", "1.2.19"),
            },
        )

    def test_snapshots_are_not_counted_as_packages(self):
        self.assertNotIn(("pnpm", "12.21.0"), nl.lockfile_packages(LOCKFILE))

    def test_single_document_lockfile(self):
        text = LOCKFILE.split("---\n")[-1]
        self.assertEqual(len(nl.lockfile_packages(text)), 5)

    def test_tarball_entry_takes_the_version_of_its_version_line(self):
        url = "https://example.com/releases/download/v0.12.3/kit-0.12.3.tgz"
        text = (
            "packages:\n\n"
            f"  '@scope/kit@{url}':\n"
            f"    resolution: {{integrity: sha512-hhh, tarball: {url}}}\n"
            "    version: 0.12.3\n"
            "    engines: {node: '>=22'}\n\n"
            "  eslint@10.15.0:\n"
            "    resolution: {integrity: sha512-ddd}\n"
            "    version: 9.9.9\n"
        )
        self.assertEqual(
            nl.lockfile_packages(text), {("@scope/kit", "0.12.3"), ("eslint", "10.15.0")}
        )
        self.assertEqual(nl.lockfile_tarballs(text), {("@scope/kit", "0.12.3"): url})

    def test_registry_packages_have_no_tarball(self):
        self.assertEqual(nl.lockfile_tarballs(LOCKFILE), {})

    def test_quoted_tarball_version_is_unquoted(self):
        text = "packages:\n  'kit@https://example.com/kit-1.0.0.tgz':\n    version: '1.0.0'\n"
        self.assertEqual(nl.lockfile_packages(text), {("kit", "1.0.0")})

    def test_tarball_entry_without_a_version_fails(self):
        followed = (
            "packages:\n"
            "  'kit@https://example.com/kit-1.0.0.tgz':\n"
            "    resolution: {integrity: sha512-hhh}\n"
            "  eslint@10.15.0:\n"
            "    resolution: {integrity: sha512-ddd}\n"
        )
        last = "packages:\n  'kit@https://example.com/kit-1.0.0.tgz':\n    resolution: {}\n"
        for label, text in {"followed by an entry": followed, "last entry": last}.items():
            with self.subTest(label), self.assertRaisesRegex(nl.InventoryError, "has no version"):
                nl.lockfile_packages(text)

    def test_an_entry_of_unknown_form_fails_instead_of_going_unchecked(self):
        keys = {
            "git": "  'kit@git+https://example.com/kit.git#abc':",
            "plain http tarball": "  'kit@http://example.com/kit-1.0.0.tgz':",
            "url without .tgz": "  'kit@https://example.com/kit':",
            "no version": "  kit:",
        }
        for label, key in keys.items():
            text = f"packages:\n{key}\n    resolution: {{}}\n    version: 1.0.0\n"
            with self.subTest(label), self.assertRaisesRegex(nl.InventoryError, "unrecognised"):
                nl.lockfile_packages(text)

    def test_the_web_lockfile_parses_and_lists_the_design_kit(self):
        text = (nl.WEB / "pnpm-lock.yaml").read_text(encoding="utf-8")
        self.assertIn(("@mozra-the-great/kern", "0.12.3"), nl.lockfile_packages(text))

    def test_platforms_are_the_union_over_the_project_packages(self):
        self.assertEqual(
            nl.lockfile_platforms(LOCKFILE),
            {"os": ["linux", "win32"], "cpu": ["arm64", "wasm32", "x64"], "libc": ["musl"]},
        )

    def test_no_platform_restrictions(self):
        self.assertEqual(nl.lockfile_platforms("packages:\n  a@1.0.0:\n    resolution: {}\n"), {})

    def test_quoted_platform_values(self):
        text = "packages:\n  a@1.0.0:\n    os: ['linux', \"darwin\"]\n"
        self.assertEqual(nl.lockfile_platforms(text), {"os": ["darwin", "linux"]})


class TestSandboxWorkspace(unittest.TestCase):
    def test_appends_all_locked_platforms(self):
        result = nl.sandbox_workspace_file(
            "packages:\n  - apps/*\n", {"os": ["linux", "win32"], "cpu": ["x64"]}
        )
        self.assertEqual(
            result,
            "packages:\n  - apps/*\n\nsupportedArchitectures:\n"
            "  os: [linux, win32]\n  cpu: [x64]\n",
        )

    def test_omits_empty_dimensions(self):
        result = nl.sandbox_workspace_file("packages: []\n", {"os": ["linux"]})
        self.assertNotIn("cpu", result)
        self.assertNotIn("libc", result)

    def test_refuses_to_override_an_existing_setting(self):
        with self.assertRaisesRegex(nl.InventoryError, "supportedArchitectures"):
            nl.sandbox_workspace_file("supportedArchitectures:\n  os: [linux]\n", {"os": ["win32"]})


class TestMissing(unittest.TestCase):
    def test_reports_locked_packages_nobody_inspected(self):
        locked = {("a", "1.0.0"), ("b", "1.0.0"), ("c", "2.0.0")}
        self.assertEqual(nl.missing_from_install(locked, {("a", "1.0.0")}), [("b", "1.0.0"), ("c", "2.0.0")])

    def test_extra_installed_packages_are_fine(self):
        self.assertEqual(nl.missing_from_install({("a", "1.0.0")}, {("a", "1.0.0"), ("z", "9.9.9")}), [])


class FakePnpm:
    """Stands in for pnpm: records the calls, answers the two licenses queries."""

    def __init__(self, everything: dict, production: dict) -> None:
        self.everything = licenses_json(everything)
        self.production = licenses_json(production)
        self.calls: list[tuple[list[str], pathlib.Path]] = []
        self.workspace_seen = ""
        self.manifests_seen: list[str] = []

    def __call__(self, args: list[str], cwd: pathlib.Path) -> str:
        self.calls.append((args, cwd))
        if args[0] == "install":
            self.workspace_seen = (cwd / "pnpm-workspace.yaml").read_text(encoding="utf-8")
            self.manifests_seen = sorted(
                str(p.relative_to(cwd)).replace("\\", "/") for p in cwd.rglob("package.json")
            )
            return ""
        return self.production if "--prod" in args else self.everything


def make_web(root: pathlib.Path) -> pathlib.Path:
    web = root / "web"
    for rel in ("", "apps/site", "packages/lib", "node_modules/dep", "apps/site/node_modules/x"):
        (web / rel).mkdir(parents=True, exist_ok=True)
        (web / rel / "package.json").write_text("{}", encoding="utf-8")
    (web / "pnpm-lock.yaml").write_text(LOCKFILE, encoding="utf-8")
    (web / "pnpm-workspace.yaml").write_text("packages:\n  - apps/*\n  - packages/*\n", encoding="utf-8")
    (web / ".npmrc").write_text("engine-strict=true\n", encoding="utf-8")
    return web


class TestCollect(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.web = make_web(pathlib.Path(self._tmp.name))

    def test_collects_everything_and_the_runtime_subset(self):
        fake = FakePnpm(ALL_LOCKED, {"MIT": [("eslint", ["10.15.0"])]})
        inventory = nl.collect(self.web, run=fake)
        self.assertEqual(len(inventory.packages), 5)
        self.assertEqual(inventory.runtime, frozenset({("eslint", "10.15.0")}))
        self.assertEqual(inventory.tarballs, {})
        self.assertEqual(
            [args for args, _ in fake.calls],
            [
                ["install", "--frozen-lockfile", "--ignore-scripts"],
                ["-r", "licenses", "list", "--json"],
                ["-r", "licenses", "list", "--json", "--prod"],
            ],
        )

    def test_installs_in_a_scratch_copy_with_every_platform(self):
        fake = FakePnpm(ALL_LOCKED, {})
        nl.collect(self.web, run=fake)
        sandbox = fake.calls[0][1]
        self.assertNotEqual(sandbox.resolve(), self.web.resolve())
        self.assertIn("os: [linux, win32]", fake.workspace_seen)
        self.assertIn("cpu: [arm64, wasm32, x64]", fake.workspace_seen)
        self.assertIn("libc: [musl]", fake.workspace_seen)
        self.assertFalse(sandbox.exists(), "scratch directory must be removed")

    def test_copies_workspace_manifests_but_not_node_modules(self):
        fake = FakePnpm(ALL_LOCKED, {})
        nl.collect(self.web, run=fake)
        self.assertEqual(
            fake.manifests_seen, ["apps/site/package.json", "package.json", "packages/lib/package.json"]
        )

    def test_the_real_workspace_file_is_left_untouched(self):
        before = (self.web / "pnpm-workspace.yaml").read_text(encoding="utf-8")
        nl.collect(self.web, run=FakePnpm(ALL_LOCKED, {}))
        self.assertEqual((self.web / "pnpm-workspace.yaml").read_text(encoding="utf-8"), before)
        self.assertTrue((self.web / "node_modules" / "dep" / "package.json").exists())

    def test_a_locked_package_the_inventory_cannot_see_fails(self):
        missing = {k: [e for e in v if e[0] != "lightningcss-win32-x64-msvc"] for k, v in ALL_LOCKED.items()}
        with self.assertRaisesRegex(
            nl.InventoryError, r"1 locked package\(s\).*lightningcss-win32-x64-msvc@1\.33\.0"
        ):
            nl.collect(self.web, run=FakePnpm(missing, {}))

    def test_pnpm_failure_propagates(self):
        def failing(args: list[str], cwd: pathlib.Path) -> str:
            raise nl.InventoryError("`pnpm install` failed (1)")

        with self.assertRaisesRegex(nl.InventoryError, "failed"):
            nl.collect(self.web, run=failing)


class TestExactErrors(unittest.TestCase):
    """The text of every inventory error, character for character: the gate prints it."""

    def parse_error(self, text: str) -> str:
        with self.assertRaises(nl.InventoryError) as caught:
            nl.parse_licenses_json(text)
        return str(caught.exception)

    def test_parse_errors(self):
        self.assertEqual(
            self.parse_error("no packages"),
            "pnpm licenses did not print JSON: Expecting value: line 1 column 1 (char 0)",
        )
        self.assertEqual(self.parse_error("[]"), "pnpm licenses JSON is not an object")
        self.assertEqual(
            self.parse_error('{"MIT": {"name": "a"}}'), "pnpm licenses: entry for 'MIT' is not a list"
        )
        self.assertEqual(self.parse_error('{"MIT": ["a"]}'), "pnpm licenses: malformed entry 'a'")
        self.assertEqual(
            self.parse_error('{"MIT": [{"name": "a", "versions": [1]}]}'),
            "pnpm licenses: malformed version in {'name': 'a', 'versions': [1]}",
        )

    def test_the_parse_error_keeps_its_cause(self):
        with self.assertRaises(nl.InventoryError) as caught:
            nl.parse_licenses_json("no packages")
        self.assertIsInstance(caught.exception.__cause__, json.JSONDecodeError)

    def test_an_existing_architecture_setting_is_refused_on_any_line(self):
        with self.assertRaises(nl.InventoryError) as caught:
            nl.sandbox_workspace_file("a: 1\nsupportedArchitectures:\n  os: [x]\n", {})
        self.assertEqual(
            str(caught.exception),
            "pnpm-workspace.yaml sets supportedArchitectures itself; the inventory cannot widen it. "
            "Remove it or teach npm_licenses.py to merge it.",
        )

    def test_only_newlines_are_trimmed_from_the_workspace_file(self):
        self.assertEqual(
            nl.sandbox_workspace_file("key: X  \n\n", {"os": ["linux"]}),
            "key: X  \n\nsupportedArchitectures:\n  os: [linux]\n",
        )
        self.assertEqual(
            nl.sandbox_workspace_file("key: X\n", {"os": ["linux"]}),
            "key: X\n\nsupportedArchitectures:\n  os: [linux]\n",
        )

    def test_a_missing_pnpm_is_explained(self):
        with mock.patch.object(nl.shutil, "which", return_value=None) as which:
            with self.assertRaises(nl.InventoryError) as caught:
                nl._run_pnpm(["install"], pathlib.Path("."))
        which.assert_called_once_with("pnpm")
        self.assertEqual(str(caught.exception), "pnpm not found; run `corepack enable` (Node per web/.nvmrc)")

    def test_several_missing_packages_are_listed_with_commas(self):
        locked = {
            "MIT": [("@babel/code-frame", ["7.29.7"])],
        }
        with tempfile.TemporaryDirectory() as tmp:
            web = make_web(pathlib.Path(tmp))
            with self.assertRaises(nl.InventoryError) as caught:
                nl.collect(web, run=FakePnpm(locked, {}))
        self.assertEqual(
            str(caught.exception),
            "4 locked package(s) were not found by the inventory and would go unchecked: "
            "@rolldown/binding-wasm32-wasi@1.2.19, eslint@10.15.0, "
            "lightningcss-linux-arm64-musl@1.33.0, lightningcss-win32-x64-msvc@1.33.0",
        )


class TestParsingDetails(unittest.TestCase):
    def test_a_top_level_key_with_a_capital_ends_the_packages_section(self):
        text = "packages:\n  a@1.0.0:\n    resolution: {}\n\nSnapshots:\n  b@2.0.0:\n    resolution: {}\n"
        self.assertEqual(nl.lockfile_packages(text), {("a", "1.0.0")})

    def test_entries_before_any_section_are_ignored(self):
        self.assertEqual(nl.lockfile_packages("  a@1.0.0:\n"), set())

    def test_platform_values_keep_their_capitals(self):
        text = "packages:\n  a@1.0.0:\n    os: ['XBSD', \"Xenix\"]\n"
        self.assertEqual(nl.lockfile_platforms(text), {"os": ["XBSD", "Xenix"]})


class TestRunPnpm(unittest.TestCase):
    def run_pnpm(self, returncode: int = 0, stdout: str = "out", stderr: str = " boom \n"):
        done = subprocess.CompletedProcess(["pnpm"], returncode, stdout, stderr)
        with mock.patch.object(nl.shutil, "which", return_value="/bin/pnpm") as which, mock.patch.object(
            nl.subprocess, "run", return_value=done
        ) as run, mock.patch.dict(nl.os.environ, {"KEEP_ME": "1"}, clear=True):
            try:
                result = nl._run_pnpm(["-r", "licenses"], pathlib.Path("/work"))
            except nl.InventoryError as err:
                result = err
        return which, run, result

    def test_pnpm_is_looked_up_by_name_and_started_without_a_shell(self):
        which, run, result = self.run_pnpm()
        which.assert_called_once_with("pnpm")
        self.assertEqual(result, "out")
        run.assert_called_once_with(
            ["/bin/pnpm", "-r", "licenses"],
            cwd=pathlib.Path("/work"),
            env={"KEEP_ME": "1", "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0", "CI": "true"},
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )

    def test_a_failing_pnpm_reports_command_status_and_stderr(self):
        _, _, result = self.run_pnpm(returncode=3)
        self.assertIsInstance(result, nl.InventoryError)
        self.assertEqual(str(result), "`pnpm -r licenses` failed (3):\nboom")


class TestCopyManifests(unittest.TestCase):
    def test_nested_manifests_are_copied_and_a_second_run_is_fine(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = make_web(pathlib.Path(tmp))
            target = pathlib.Path(tmp) / "copy"
            target.mkdir()
            nl._copy_manifests(web, target)
            # Running into a directory that already holds the copies must not fail.
            nl._copy_manifests(web, target)
            found = sorted(p.relative_to(target).as_posix() for p in target.rglob("*") if p.is_file())
        self.assertEqual(
            found,
            [".npmrc", "apps/site/package.json", "package.json", "packages/lib/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"],
        )

    def test_the_root_manifest_is_not_copied_twice_into_a_subdirectory(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = make_web(pathlib.Path(tmp))
            target = pathlib.Path(tmp) / "copy"
            target.mkdir()
            nl._copy_manifests(web, target)
            self.assertFalse((target / "." / "." / "package.json").is_dir())
            self.assertEqual(sorted(p.name for p in target.iterdir() if p.is_dir()), ["apps", "packages"])


class TestCollectDetails(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.web = make_web(pathlib.Path(self._tmp.name))

    def test_the_tarballs_of_the_lockfile_are_part_of_the_inventory(self):
        url = "https://example.com/releases/kit-1.0.0.tgz"
        lock = self.web / "pnpm-lock.yaml"
        text = lock.read_text(encoding="utf-8")
        entry = "  eslint@10.15.0:\n"
        self.assertIn(entry, text)
        lock.write_text(
            text.replace(entry, f"  'kit@{url}':\n    resolution: {{tarball: {url}}}\n    version: 1.0.0\n\n{entry}", 1),
            encoding="utf-8",
        )
        everything = {**ALL_LOCKED, "MIT": [*ALL_LOCKED["MIT"], ("kit", ["1.0.0"])]}
        inventory = nl.collect(self.web, run=FakePnpm(everything, {}))
        self.assertEqual(inventory.tarballs, {("kit", "1.0.0"): url})

    def test_a_tarball_entry_without_a_version_names_itself(self):
        text = "packages:\n  'kit@https://example.com/kit-1.0.0.tgz':\n    resolution: {}\n"
        with self.assertRaises(nl.InventoryError) as caught:
            nl.lockfile_entries(text)
        self.assertEqual(
            str(caught.exception),
            "pnpm-lock.yaml: tarball entry kit@https://example.com/kit-1.0.0.tgz has no version",
        )

    def test_every_pnpm_call_runs_in_the_scratch_directory(self):
        fake = FakePnpm(ALL_LOCKED, {})
        nl.collect(self.web, run=fake)
        sandboxes = {cwd for _, cwd in fake.calls}
        self.assertEqual(len(fake.calls), 3)
        self.assertEqual(len(sandboxes), 1)
        self.assertTrue(sandboxes.pop().name.startswith("npm-license-inventory-"))

    def test_the_scratch_directory_is_created_with_its_prefix_and_tolerant_cleanup(self):
        real = tempfile.TemporaryDirectory
        with mock.patch.object(nl.tempfile, "TemporaryDirectory", wraps=real) as made:
            nl.collect(self.web, run=FakePnpm(ALL_LOCKED, {}))
        made.assert_called_once_with(prefix="npm-license-inventory-", ignore_cleanup_errors=True)

    def test_every_file_is_read_and_written_as_utf8(self):
        calls: list[tuple[str, str, object]] = []
        real_read, real_write = pathlib.Path.read_text, pathlib.Path.write_text

        def read(path, *args, **kwargs):
            calls.append(("read", path.name, kwargs.get("encoding")))
            return real_read(path, *args, **kwargs)

        def write(path, data, *args, **kwargs):
            calls.append(("write", path.name, kwargs.get("encoding")))
            return real_write(path, data, *args, **kwargs)

        with mock.patch.object(pathlib.Path, "read_text", read), mock.patch.object(pathlib.Path, "write_text", write):
            nl.collect(self.web, run=FakePnpm(ALL_LOCKED, {}))
        self.assertEqual(
            sorted(set(calls)),
            [
                ("read", "pnpm-lock.yaml", "utf-8"),
                ("read", "pnpm-workspace.yaml", "utf-8"),
                ("write", "pnpm-workspace.yaml", "utf-8"),
            ],
        )


class TestGateRunner(unittest.TestCase):
    POLICY = 'allow = ["MIT", "MPL-2.0", "Apache-2.0"]\n'

    def run_gate(self, inventory: nl.Inventory | Exception, policy_text: str | None = None):
        with tempfile.TemporaryDirectory() as tmp:
            policy_file = pathlib.Path(tmp) / "policy.toml"
            policy_file.write_text(self.POLICY if policy_text is None else policy_text, encoding="utf-8")

            def collect(web: pathlib.Path) -> nl.Inventory:
                if isinstance(inventory, Exception):
                    raise inventory
                return inventory

            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = license_gate.run(policy_file, pathlib.Path(tmp), collect)
            return code, out.getvalue(), err.getvalue()

    def inv(self, *packages: Package, runtime: set[tuple[str, str]] | None = None) -> nl.Inventory:
        return nl.Inventory(tuple(packages), frozenset(runtime or set()))

    def test_all_allowed_passes(self):
        code, out, _ = self.run_gate(
            self.inv(Package("a", "1.0.0", "MIT"), Package("b", "2.0.0", "MPL-2.0"), runtime={("a", "1.0.0")})
        )
        self.assertEqual(code, 0)
        self.assertIn("OK: 2 npm packages (1 runtime)", out)

    def test_a_disallowed_license_fails_with_exit_code_1(self):
        code, out, _ = self.run_gate(
            self.inv(Package("good", "1.0.0", "MIT"), Package("bad", "3.1.0", "GPL-2.0-only"))
        )
        self.assertEqual(code, 1)
        self.assertIn("1 of 2 npm packages fail the license policy", out)
        self.assertIn("::error::bad@3.1.0 (dev/build): license 'GPL-2.0-only'", out)
        self.assertNotIn("good@", out)

    def test_every_violation_is_listed(self):
        code, out, _ = self.run_gate(
            self.inv(Package("a", "1.0.0", "Unknown"), Package("b", "1.0.0", "AGPL-3.0-only"))
        )
        self.assertEqual(code, 1)
        self.assertIn("2 of 2 npm packages", out)
        self.assertIn("a@1.0.0", out)
        self.assertIn("b@1.0.0", out)

    def test_unused_exception_warns_but_passes(self):
        policy_text = self.POLICY + '[[exception]]\nname = "gone"\nlicense = "x"\nreason = "was needed"\n'
        code, out, _ = self.run_gate(self.inv(Package("a", "1.0.0", "MIT")), policy_text)
        self.assertEqual(code, 0)
        self.assertIn("::warning::", out)
        self.assertIn("gone", out)

    def test_inventory_error_is_a_setup_error(self):
        code, out, err = self.run_gate(nl.InventoryError("pnpm not found"))
        self.assertEqual(code, 2)
        self.assertIn("error: pnpm not found", err)
        self.assertEqual(out, "")

    def test_broken_policy_is_a_setup_error(self):
        code, _, err = self.run_gate(self.inv(Package("a", "1.0.0", "MIT")), "allow = []")
        self.assertEqual(code, 2)
        self.assertIn("non-empty list", err)

    def test_an_empty_workspace_passes(self):
        code, out, _ = self.run_gate(self.inv())
        self.assertEqual(code, 0)
        self.assertIn("OK: 0 npm packages", out)

    def test_committed_policy_rejects_known_bad_licenses_and_accepts_known_good(self):
        pol = lp.load_policy()
        bad = [Package("p", "1.0.0", t) for t in ("GPL-2.0-only", "AGPL-3.0-only", "Unknown", "BUSL-1.1")]
        good = [Package("q", "1.0.0", t) for t in ("MIT", "(MIT OR CC0-1.0)", "Apache-2.0", "MPL-2.0", "ISC")]
        self.assertEqual(len(lp.check(bad, set(), pol).violations), 4)
        self.assertEqual(lp.check(good, set(), pol).violations, ())

    def test_the_failure_report_is_exact(self):
        code, out, err = self.run_gate(
            self.inv(Package("good", "1.0.0", "MIT"), Package("bad", "3.1.0", "GPL-2.0-only"))
        )
        self.assertEqual((code, err), (1, ""))
        self.assertEqual(
            out,
            "1 of 2 npm packages fail the license policy:\n"
            "::error::bad@3.1.0 (dev/build): license 'GPL-2.0-only': not on the allowlist: GPL-2.0-only\n"
            "Fix: replace the dependency, or (after checking GPLv3 compatibility, docs/SPEC.md section 3) "
            "extend scripts/ci/license-policy.toml and deny.toml.\n",
        )

    def test_the_pass_report_is_exact(self):
        policy_text = self.POLICY + '[[exception]]\nname = "gone"\nlicense = "x"\nreason = "was needed"\n'
        code, out, err = self.run_gate(self.inv(Package("a", "1.0.0", "MIT")), policy_text)
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(
            out,
            "::warning::license-policy.toml: exception for gone ('x') matches no installed package; remove it\n"
            "OK: 1 npm packages (0 runtime) all have an allowed license.\n",
        )

    def test_the_inventory_is_collected_from_the_given_web_directory(self):
        seen: list[pathlib.Path] = []

        def collect(web: pathlib.Path) -> nl.Inventory:
            seen.append(web)
            return self.inv()

        with tempfile.TemporaryDirectory() as tmp:
            policy_file = pathlib.Path(tmp) / "policy.toml"
            policy_file.write_text(self.POLICY, encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                license_gate.run(policy_file, pathlib.Path(tmp) / "web", collect)
        self.assertEqual([path.name for path in seen], ["web"])


if __name__ == "__main__":
    unittest.main()
