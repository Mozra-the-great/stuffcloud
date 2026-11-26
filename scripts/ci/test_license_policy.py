#!/usr/bin/env python3
"""Unit tests for license_policy.py (the decisions of the npm license gate).

Each test pins one decision that, if it silently inverted, would let an
incompatible license into the frontend or block a fine one. The failure cases come
first: the gate exists to say no.

    python3 -m unittest discover -s scripts/ci -p "test_*.py"
"""
from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import license_policy as lp  # noqa: E402
from license_policy import Package  # noqa: E402

POLICY_TEXT = """
allow = ["MIT", "ISC", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "MPL-2.0"]

[dev_only]
"BlueOak-1.0.0" = "permissive, dev tooling only"

[[exception]]
name = "odd-package"
license = "SEE LICENSE IN LICENSE.md"
reason = "LICENSE.md of 1.0.0 is MIT"
"""


def policy(text: str = POLICY_TEXT) -> lp.Policy:
    return lp.parse_policy(text)


def pkg(name: str, license_text: str, version: str = "1.0.0") -> Package:
    return Package(name, version, license_text)


def check(
    packages: list[Package],
    runtime: set[tuple[str, str]] | None = None,
    pol: lp.Policy | None = None,
) -> lp.Result:
    return lp.check(packages, runtime or set(), pol or policy())


class TestRejections(unittest.TestCase):
    def reasons(self, license_text: str, runtime: bool = True) -> list[str]:
        package = pkg("x", license_text)
        result = check([package], {("x", "1.0.0")} if runtime else set())
        return [v.reason for v in result.violations]

    def test_unlisted_license_fails(self):
        self.assertEqual(self.reasons("GPL-2.0-only"), ["not on the allowlist: GPL-2.0-only"])

    def test_strong_and_network_copyleft_are_not_allowed_by_default(self):
        for license_text in ("AGPL-3.0-only", "GPL-3.0-only", "LGPL-3.0-only", "SSPL-1.0"):
            with self.subTest(license_text):
                self.assertEqual(len(self.reasons(license_text)), 1)

    def test_missing_licenses_fail_with_a_clear_message(self):
        for license_text in ("Unknown", "unknown", "UNLICENSED", "", "  "):
            with self.subTest(repr(license_text)):
                self.assertEqual(self.reasons(license_text), ["no license declared"])

    def test_malformed_expressions_fail(self):
        for license_text in ("SEE LICENSE IN LICENSE", "MIT/Apache-2.0", "MIT OR", "Apache 2.0"):
            with self.subTest(license_text):
                (reason,) = self.reasons(license_text)
                self.assertTrue(reason.startswith("not a valid SPDX expression"), reason)

    def test_or_with_only_bad_alternatives_fails(self):
        self.assertEqual(
            self.reasons("GPL-2.0-only OR AGPL-3.0-only"),
            ["not on the allowlist: GPL-2.0-only, AGPL-3.0-only"],
        )

    def test_and_with_one_bad_part_fails(self):
        self.assertEqual(
            self.reasons("MIT AND GPL-2.0-only"), ["not on the allowlist: GPL-2.0-only"]
        )

    def test_exception_term_does_not_match_the_bare_license(self):
        self.assertEqual(len(self.reasons("MIT WITH Classpath-exception-2.0")), 1)
        self.assertEqual(self.reasons("Apache-2.0 WITH LLVM-exception"), [])
        # Only the exception form is listed, so the bare license of another
        # exception pair does not slip in through "Apache-2.0 WITH ...".
        self.assertEqual(len(self.reasons("Apache-2.0 WITH Other-exception")), 1)

    def test_dev_only_license_fails_for_a_runtime_dependency(self):
        (reason,) = self.reasons("BlueOak-1.0.0", runtime=True)
        self.assertEqual(
            reason,
            "BlueOak-1.0.0 is accepted for dev/build-only packages only, but this one is "
            "a runtime dependency",
        )

    def test_dev_only_message_is_not_used_for_unrelated_rejections(self):
        (reason,) = self.reasons("BlueOak-1.0.0 AND GPL-2.0-only", runtime=True)
        self.assertIn("BlueOak-1.0.0 is accepted for dev/build-only", reason)
        (reason,) = self.reasons("BlueOak-1.0.0 AND GPL-2.0-only", runtime=False)
        self.assertEqual(reason, "not on the allowlist: GPL-2.0-only")

    def test_every_violation_is_reported_sorted(self):
        result = check([pkg("b", "GPL-2.0-only"), pkg("a", "Unknown"), pkg("c", "MIT")])
        self.assertEqual([v.package.name for v in result.violations], ["a", "b"])

    def test_violation_text_names_package_scope_and_license(self):
        (violation,) = check([pkg("lib", "GPL-2.0-only", "2.3.4")], {("lib", "2.3.4")}).violations
        self.assertEqual(
            str(violation),
            "lib@2.3.4 (runtime): license 'GPL-2.0-only': not on the allowlist: GPL-2.0-only",
        )
        (violation,) = check([pkg("lib", "GPL-2.0-only", "2.3.4")]).violations
        self.assertIn("(dev/build)", str(violation))


class TestAcceptance(unittest.TestCase):
    def ok(self, license_text: str, runtime: bool) -> bool:
        runtime_set = {("x", "1.0.0")} if runtime else set()
        return not check([pkg("x", license_text)], runtime_set).violations

    def test_allowed_licenses_pass_in_both_scopes(self):
        for license_text in ("MIT", "ISC", "Apache-2.0", "MPL-2.0"):
            for runtime in (True, False):
                with self.subTest(license_text, runtime=runtime):
                    self.assertTrue(self.ok(license_text, runtime))

    def test_matching_ignores_case(self):
        self.assertTrue(self.ok("mit", True))
        self.assertTrue(self.ok("apache-2.0 with llvm-exception", True))

    def test_or_needs_one_allowed_alternative(self):
        self.assertTrue(self.ok("(MIT OR CC0-1.0)", True))
        self.assertTrue(self.ok("GPL-2.0-only OR ISC", True))

    def test_and_needs_all_parts_allowed(self):
        self.assertTrue(self.ok("(MIT OR Apache-2.0) AND ISC", True))

    def test_dev_only_license_passes_for_dev_packages(self):
        self.assertTrue(self.ok("BlueOak-1.0.0", False))
        self.assertTrue(self.ok("BlueOak-1.0.0 OR GPL-2.0-only", False))

    def test_runtime_scope_is_per_version(self):
        packages = [pkg("m", "BlueOak-1.0.0", "1.0.0"), pkg("m", "BlueOak-1.0.0", "2.0.0")]
        result = check(packages, {("m", "2.0.0")})
        self.assertEqual([v.package.version for v in result.violations], ["2.0.0"])

    def test_no_packages_pass(self):
        self.assertEqual(check([]).violations, ())
        self.assertEqual(check([], pol=lp.parse_policy('allow = ["MIT"]')), lp.Result((), ()))


class TestExceptions(unittest.TestCase):
    def test_exception_lets_the_exact_license_text_pass(self):
        result = check([pkg("odd-package", "SEE LICENSE IN LICENSE.md")])
        self.assertEqual(result.violations, ())
        self.assertEqual(result.unused_exceptions, ())

    def test_exception_stops_matching_when_the_license_text_changes(self):
        result = check([pkg("odd-package", "SEE LICENSE IN NEW-LICENSE.md")])
        self.assertEqual(len(result.violations), 1)
        self.assertEqual(len(result.unused_exceptions), 1)

    def test_exception_does_not_apply_to_other_packages(self):
        result = check([pkg("other", "SEE LICENSE IN LICENSE.md")])
        self.assertEqual(len(result.violations), 1)

    def test_unused_exception_is_reported(self):
        result = check([pkg("a", "MIT")])
        (unused,) = result.unused_exceptions
        self.assertEqual(unused.name, "odd-package")

    def test_exception_applies_to_every_version(self):
        packages = [pkg("odd-package", "SEE LICENSE IN LICENSE.md", v) for v in ("1.0.0", "2.0.0")]
        self.assertEqual(check(packages).violations, ())


class TestPolicyParsing(unittest.TestCase):
    def bad(self, text: str, message: str) -> None:
        with self.assertRaisesRegex(lp.PolicyError, message):
            lp.parse_policy(text)

    def test_valid_policy(self):
        pol = policy()
        self.assertEqual(
            pol.allow,
            frozenset({"mit", "isc", "apache-2.0", "apache-2.0 with llvm-exception", "mpl-2.0"}),
        )
        self.assertEqual(pol.dev_only, {"blueoak-1.0.0": "permissive, dev tooling only"})
        self.assertEqual(pol.exceptions[0].name, "odd-package")

    def test_minimal_policy_needs_only_allow(self):
        pol = lp.parse_policy('allow = ["MIT"]')
        self.assertEqual((pol.dev_only, pol.exceptions), ({}, ()))

    def test_invalid_toml(self):
        self.bad("allow = [", "invalid TOML")

    def test_unknown_top_level_key(self):
        self.bad('allow = ["MIT"]\nallowed = ["ISC"]', "unknown keys")

    def test_allow_must_be_a_non_empty_list(self):
        self.bad("", "`allow` must be a non-empty list")
        self.bad("allow = []", "`allow` must be a non-empty list")
        self.bad('allow = "MIT"', "`allow` must be a non-empty list")

    def test_allow_entries_must_be_single_valid_licenses(self):
        self.bad("allow = [1]", "must be a string")
        self.bad('allow = ["MIT OR ISC"]', "single license")
        self.bad('allow = ["MIT/ISC"]', "not an SPDX license")
        self.bad('allow = [""]', "not an SPDX license")

    def test_allow_duplicates(self):
        self.bad('allow = ["MIT", "mit"]', "twice")

    def test_dev_only_needs_a_reason(self):
        self.bad('allow = ["MIT"]\n[dev_only]\n"ISC" = ""', "non-empty reason")
        self.bad('allow = ["MIT"]\n[dev_only]\n"ISC" = 3', "non-empty reason")

    def test_dev_only_must_be_a_table(self):
        self.bad('allow = ["MIT"]\ndev_only = ["ISC"]', "table of license = reason")

    def test_dev_only_overlap_with_allow(self):
        self.bad('allow = ["MIT"]\n[dev_only]\n"mit" = "why"', "both `allow` and `dev_only`")

    def test_dev_only_case_duplicates(self):
        self.bad(
            'allow = ["MIT"]\n[dev_only]\n"ISC" = "a"\n"isc" = "b"', "differing only in case"
        )

    def test_exception_needs_all_three_keys(self):
        self.bad('allow = ["MIT"]\n[[exception]]\nname = "a"\nlicense = "x"', "exactly the keys")
        self.bad(
            'allow = ["MIT"]\n[[exception]]\nname = "a"\nlicense = "x"\nreason = "r"\nextra = 1',
            "exactly the keys",
        )

    def test_exception_fields_must_be_non_empty(self):
        for field in ("name", "license"):
            entry = {"name": "a", "license": "x", "reason": "r", field: " "}
            body = "\n".join(f'{k} = "{v}"' for k, v in entry.items())
            self.bad(f'allow = ["MIT"]\n[[exception]]\n{body}', f"`{field}` must be")
        self.bad(
            'allow = ["MIT"]\n[[exception]]\nname = "a"\nlicense = "x"\nreason = " "',
            "non-empty reason",
        )

    def test_exception_must_be_an_array(self):
        self.bad('allow = ["MIT"]\nexception = "x"', "array of tables")

    def test_duplicate_exception(self):
        entry = '[[exception]]\nname = "a"\nlicense = "x"\nreason = "r"\n'
        self.bad(f'allow = ["MIT"]\n{entry}{entry}', "twice")


class TestRepositoryPolicy(unittest.TestCase):
    """The committed policy, not a fixture."""

    def test_committed_policy_loads(self):
        self.assertIn("mit", lp.load_policy().allow)

    def test_allow_list_is_identical_to_deny_toml(self):
        # One list for Rust and npm: a license added to one gate must be a deliberate
        # edit of the other (docs/SPEC.md, section 3).
        self.assertEqual(lp.load_policy().allow, lp.deny_allow_list())

    def test_every_dev_only_license_is_documented_and_not_in_deny_toml(self):
        for license_text, reason in lp.load_policy().dev_only.items():
            with self.subTest(license_text):
                self.assertGreater(len(reason), 20)
                self.assertNotIn(license_text, lp.deny_allow_list())

    def test_known_copyleft_is_not_allowed(self):
        pol = lp.load_policy()
        accepted = pol.allow | set(pol.dev_only)
        for license_text in (
            "gpl-2.0-only",
            "gpl-3.0-only",
            "agpl-3.0-only",
            "agpl-3.0-or-later",
            "lgpl-3.0-only",
            "sspl-1.0",
            "unlicensed",
            "unknown",
        ):
            with self.subTest(license_text):
                self.assertNotIn(license_text, accepted)


class TestExactMessages(unittest.TestCase):
    """The text of every policy error, character for character: the gate prints it."""

    def error(self, text: str) -> str:
        with self.assertRaises(lp.PolicyError) as caught:
            lp.parse_policy(text)
        return str(caught.exception)

    def test_allow_errors(self):
        self.assertEqual(self.error("allow = []"), "`allow` must be a non-empty list")
        self.assertEqual(self.error("allow = [1]"), "allow: license must be a string, got 1")
        self.assertEqual(
            self.error('allow = ["MIT OR ISC"]'),
            "allow: 'MIT OR ISC' must be a single license, not an expression",
        )
        self.assertEqual(
            self.error('allow = ["MIT/ISC"]'),
            "allow: 'MIT/ISC' is not an SPDX license: invalid license identifier 'MIT/ISC'",
        )
        self.assertEqual(self.error('allow = ["MIT", "mit"]'), "`allow` contains a license twice")

    def test_dev_only_errors(self):
        head = 'allow = ["MIT"]\n'
        self.assertEqual(
            self.error(head + "dev_only = 5"), "`dev_only` must be a table of license = reason"
        )
        self.assertEqual(
            self.error(head + '[dev_only]\n"BlueOak-1.0.0" = ""'),
            "dev_only.BlueOak-1.0.0: a non-empty reason is required",
        )
        self.assertEqual(
            self.error(head + '[dev_only]\n"MIT/ISC" = "x"'),
            "dev_only: 'MIT/ISC' is not an SPDX license: invalid license identifier 'MIT/ISC'",
        )
        self.assertEqual(
            self.error(head + '[dev_only]\nBlueOak = "x"\nblueoak = "y"'),
            "`dev_only` contains a license twice (differing only in case)",
        )
        self.assertEqual(
            self.error(head + '[dev_only]\nMIT = "x"'),
            "licenses in both `allow` and `dev_only`: ['mit']",
        )

    def test_exception_errors(self):
        head = 'allow = ["MIT"]\n'
        entry = '[[exception]]\nname = "a"\nlicense = "x"\nreason = "r"\n'
        self.assertEqual(self.error(head + "exception = 5"), "`exception` must be an array of tables")
        self.assertEqual(
            self.error(head + '[[exception]]\nname = "a"'),
            "exception[0]: exactly the keys name, license and reason are required",
        )
        self.assertEqual(
            self.error(head + entry + '[[exception]]\nname = ""\nlicense = "x"\nreason = "r"'),
            "exception[1]: `name` must be a non-empty string",
        )
        self.assertEqual(
            self.error(head + '[[exception]]\nname = "a"\nlicense = " "\nreason = "r"'),
            "exception[0]: `license` must be a non-empty string",
        )
        self.assertEqual(
            self.error(head + entry + '[[exception]]\nname = "b"\nlicense = "x"\nreason = " "'),
            "exception[1]: a non-empty reason is required",
        )
        self.assertEqual(
            self.error(head + entry + entry), "`exception` lists the same package and license twice"
        )

    def test_toml_and_key_errors(self):
        self.assertEqual(self.error("allow = ["), "invalid TOML: Invalid value (at end of document)")
        self.assertEqual(self.error('allow = ["MIT"]\nbad = 1'), "unknown keys: ['bad']")

    def test_reasons_are_stripped(self):
        pol = lp.parse_policy('allow = ["MIT"]\n[dev_only]\nBlueOak = "  because  "\n')
        self.assertEqual(pol.dev_only, {"blueoak": "because"})
        pol = lp.parse_policy(
            'allow = ["MIT"]\n[[exception]]\nname = "a"\nlicense = "x"\nreason = " why "\n'
        )
        self.assertEqual(pol.exceptions, (lp.PackageException("a", "x", "why"),))


class TestCheckDetails(unittest.TestCase):
    POLICY = lp.parse_policy(
        'allow = ["MIT"]\n[dev_only]\nBlueOak = "a"\n"Python-2.0" = "b"\n'
        '[[exception]]\nname = "aaa"\nlicense = "SEE LICENSE IN X"\nreason = "r"\n'
    )

    def test_an_exception_does_not_stop_the_checks_of_the_next_packages(self):
        # "aaa" sorts first and is excused; "bbb" after it must still be checked.
        result = lp.check([pkg("bbb", "GPL-2.0-only"), pkg("aaa", "SEE LICENSE IN X")], set(), self.POLICY)
        self.assertEqual([v.package.name for v in result.violations], ["bbb"])

    def test_a_missing_license_does_not_stop_the_checks_of_the_next_packages(self):
        result = lp.check([pkg("aaa", "Unknown"), pkg("bbb", "GPL-2.0-only")], set(), self.POLICY)
        self.assertEqual([v.package.name for v in result.violations], ["aaa", "bbb"])

    def test_a_malformed_license_does_not_stop_the_checks_of_the_next_packages(self):
        result = lp.check([pkg("aaa", "MIT/ISC"), pkg("bbb", "GPL-2.0-only")], set(), self.POLICY)
        self.assertEqual([v.package.name for v in result.violations], ["aaa", "bbb"])

    def test_an_allowed_license_does_not_stop_the_checks_of_the_next_packages(self):
        result = lp.check([pkg("aaa", "MIT"), pkg("bbb", "GPL-2.0-only")], set(), self.POLICY)
        self.assertEqual([v.package.name for v in result.violations], ["bbb"])

    def test_a_violation_keeps_package_and_scope_for_every_reason(self):
        packages = [pkg("a", "Unknown"), pkg("b", "MIT/ISC"), pkg("c", "GPL-2.0-only")]
        for runtime in (True, False):
            with self.subTest(runtime=runtime):
                keys = {(p.name, p.version) for p in packages} if runtime else set()
                result = lp.check(packages, keys, self.POLICY)
                self.assertEqual(
                    [(v.package, v.runtime) for v in result.violations],
                    [(p, runtime) for p in packages],
                )

    def test_the_reason_of_a_malformed_license_carries_the_parser_message(self):
        (violation,) = lp.check([pkg("b", "MIT/ISC")], set(), self.POLICY).violations
        self.assertEqual(
            violation.reason,
            "not a valid SPDX expression (invalid license identifier 'MIT/ISC')",
        )

    def test_several_dev_only_licenses_are_listed_with_a_comma(self):
        runtime = {("x", "1.0.0")}
        (violation,) = lp.check([pkg("x", "BlueOak AND Python-2.0")], runtime, self.POLICY).violations
        self.assertEqual(
            violation.reason,
            "BlueOak, Python-2.0 is accepted for dev/build-only packages only, "
            "but this one is a runtime dependency",
        )

    def test_several_rejected_licenses_are_listed_with_a_comma(self):
        (violation,) = lp.check([pkg("x", "GPL-2.0-only AND AGPL-3.0-only")], set(), self.POLICY).violations
        self.assertEqual(violation.reason, "not on the allowlist: GPL-2.0-only, AGPL-3.0-only")


class TestFileEncoding(unittest.TestCase):
    def test_the_policy_and_deny_files_are_read_as_utf8(self):
        with tempfile.TemporaryDirectory() as tmp:
            policy_file = pathlib.Path(tmp) / "policy.toml"
            deny_file = pathlib.Path(tmp) / "deny.toml"
            policy_file.write_text(POLICY_TEXT, encoding="utf-8")
            deny_file.write_text('[licenses]\nallow = ["MIT", "ISC"]\n', encoding="utf-8")
            real = pathlib.Path.read_text
            seen: list[object] = []

            def spy(path, *args, **kwargs):
                seen.append(kwargs.get("encoding"))
                return real(path, *args, **kwargs)

            with mock.patch.object(pathlib.Path, "read_text", autospec=True, side_effect=spy):
                self.assertEqual(lp.load_policy(policy_file), policy())
                self.assertEqual(lp.deny_allow_list(deny_file), frozenset({"mit", "isc"}))
        self.assertEqual(seen, ["utf-8", "utf-8"])


if __name__ == "__main__":
    unittest.main()
