"""Tests of check_operator_domains.py (the operator-domain gate, SC-D).

Every fixture uses reserved names only (`*.example`, `*.test`, `example.com` ...). The gate
ignores reserved names as list entries, so the tests that need a "forbidden" name switch that
rule off (`reserved_check=lambda _: False`, or patching `is_reserved`) and use `corp.example`
style names as stand-ins; the rule itself is tested with the real function.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_operator_domains as gate  # noqa: E402

NOTHING_RESERVED = {"reserved_check": lambda _name: False}


def entries(*names: str) -> tuple[gate.Entry, ...]:
    """Entries for stand-in names, numbered from 1, without the reserved-name rule."""
    return gate.parse_entries("\n".join(names), **NOTHING_RESERVED).entries


def hits(text: str, *names: str) -> list[tuple[int, int]]:
    matcher = gate.build_matcher(entries(*names))
    assert matcher is not None
    return list(gate.scan_text(text, matcher))


class ReservedNamesTest(unittest.TestCase):
    def test_documentation_names_are_reserved(self) -> None:
        for name in (
            "example.com",
            "www.example.com",
            "example.org",
            "a.b.example.net",
            "corp.example",
            "host.test",
            "x.invalid",
            "box.localhost",
        ):
            self.assertTrue(gate.is_reserved(name), name)

    def test_other_names_are_not(self) -> None:
        for name in ("example.com.evil.net", "notexample.com", "example.de", "corp.local", "a.io"):
            self.assertFalse(gate.is_reserved(name), name)


class ParseTest(unittest.TestCase):
    def test_separators_comments_and_decoration(self) -> None:
        raw = "# my domains\nOne.example, two.example;three.example  *.four.example\n.five.example. # tail\n\n"
        parsed = gate.parse_entries(raw, **NOTHING_RESERVED)
        self.assertEqual(
            [e.ascii_name for e in parsed.entries],
            ["one.example", "two.example", "three.example", "four.example", "five.example"],
        )
        self.assertEqual([e.number for e in parsed.entries], [1, 2, 3, 4, 5])
        self.assertEqual(parsed.reserved, ())
        self.assertEqual(parsed.malformed, ())

    def test_windows_line_endings(self) -> None:
        parsed = gate.parse_entries("one.example\r\ntwo.example\r\n", **NOTHING_RESERVED)
        self.assertEqual([e.ascii_name for e in parsed.entries], ["one.example", "two.example"])

    def test_reserved_entries_are_ignored_but_counted(self) -> None:
        parsed = gate.parse_entries("example.com\ncorp.example\nreal-looking.de")
        self.assertEqual([e.ascii_name for e in parsed.entries], ["real-looking.de"])
        self.assertEqual(parsed.reserved, (1, 2))
        self.assertEqual(parsed.malformed, ())

    def test_malformed_entries(self) -> None:
        for bad in ("localhost-only", "a..example", "-a.example", "a-.example", "a b.example/x", "a.example/path",
                    "http://a.example", "a_b.example", "x" * 64 + ".example", ".", "..", "a." + "b" * 250 + ".c"):
            parsed = gate.parse_entries(bad.replace(" ", "_"), **NOTHING_RESERVED)
            self.assertEqual(parsed.entries, (), bad)
            self.assertEqual(len(parsed.malformed), 1, bad)

    def test_entry_numbers_count_every_item(self) -> None:
        parsed = gate.parse_entries("good.example\nbad_entry!\nexample.org\nlast.example", reserved_check=lambda d: d.startswith("example."))
        self.assertEqual(parsed.malformed, (2,))
        self.assertEqual(parsed.reserved, (3,))
        self.assertEqual([(e.number, e.ascii_name) for e in parsed.entries], [(1, "good.example"), (4, "last.example")])

    def test_empty_values(self) -> None:
        for raw in ("", "   ", "\n\n", "# only a comment", ",;,"):
            parsed = gate.parse_entries(raw)
            self.assertEqual((parsed.entries, parsed.reserved, parsed.malformed), ((), (), ()), raw)

    def test_unicode_entry_has_both_forms(self) -> None:
        (entry,) = entries("bücher.example")
        self.assertEqual(entry.ascii_name, "xn--bcher-kva.example")
        self.assertEqual(entry.unicode_name, "bücher.example")
        (entry,) = entries("xn--bcher-kva.example")
        self.assertEqual(entry.unicode_name, "bücher.example")

    def test_no_entries_means_no_matcher(self) -> None:
        self.assertIsNone(gate.build_matcher(()))


class MatchTest(unittest.TestCase):
    def test_the_domain_itself_in_any_case(self) -> None:
        for text in ("corp.example", "CORP.EXAMPLE", "Corp.Example", "see https://corp.example/x?y=1", "mail@corp.example", "<a href='//corp.example'>"):
            self.assertEqual(hits(text, "corp.example"), [(1, 1)], text)

    def test_subdomains_at_any_depth(self) -> None:
        for text in ("www.corp.example", "a.b.c.corp.example", "https://AUTH.corp.example:8443/"):
            self.assertEqual(hits(text, "corp.example"), [(1, 1)], text)

    def test_end_of_sentence_and_punctuation_still_match(self) -> None:
        for text in ("see corp.example.", "(corp.example)", "corp.example, and", "'corp.example'", "corp.example\\n", "corp.example:443", "corp.example/"):
            self.assertEqual(hits(text, "corp.example"), [(1, 1)], text)

    def test_a_domain_inside_a_longer_name_or_file_name_matches(self) -> None:
        for text in ("corp.example.pem", "corp.example.other.test", "corp.example.de", "corp.example.conf:1"):
            self.assertEqual(hits(text, "corp.example"), [(1, 1)], text)

    def test_other_names_do_not_match(self) -> None:
        for text in (
            "notcorp.example",
            "my-corp.example",
            "corp.examples",
            "corp.example-two",
            "xcorp.example",
            "corp_example",
            "corp-example",
            "corp.exampl",
            "1corp.example",
        ):
            self.assertEqual(hits(text, "corp.example"), [], text)

    def test_lines_are_numbered_and_each_entry_counts_once_per_line(self) -> None:
        text = "clean\nfirst.example and again first.example\nsecond.example\n\nboth first.example second.example"
        self.assertEqual(
            hits(text, "first.example", "second.example"),
            [(2, 1), (3, 2), (5, 1), (5, 2)],
        )

    def test_unicode_and_punycode_forms(self) -> None:
        self.assertEqual(hits("host.bücher.example", "bücher.example"), [(1, 1)])
        self.assertEqual(hits("host.BÜCHER.example", "bücher.example"), [(1, 1)])
        self.assertEqual(hits("host.xn--bcher-kva.example", "bücher.example"), [(1, 1)])
        self.assertEqual(hits("bücher.example", "xn--bcher-kva.example"), [(1, 1)])
        self.assertEqual(hits("übücher.example", "bücher.example"), [])

    def test_regex_metacharacters_in_names_are_literal(self) -> None:
        self.assertEqual(hits("corpXexample", "corp.example"), [])

    def test_reserved_names_never_match_unless_listed(self) -> None:
        self.assertEqual(hits("www.example.com example.org a.test", "corp.example"), [])


class TreeTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.root = Path(self._dir.name)

    def write(self, relative: str, content: bytes | str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))

    def test_findings_name_file_and_line_but_never_the_domain(self) -> None:
        self.write("docs/a.md", "fine\nvisit www.corp.example now\n")
        self.write("src/b.rs", "// clean\n")
        found = gate.check(self.root, entries("other.example", "corp.example"))
        self.assertEqual(found, ["docs/a.md:2: forbidden domain (entry 2)"])
        self.assertNotIn("corp", "\n".join(found))

    def test_a_file_name_that_matches_is_hidden(self) -> None:
        self.write("notes/corp.example", "nothing here\n")
        self.write("corp.example/readme.md", "mentions corp.example\n")
        found = gate.check(self.root, entries("corp.example"))
        self.assertEqual(len(found), 3)
        for line in found:
            self.assertNotIn("corp", line)
            self.assertTrue(line.startswith("<file name hidden #"), line)

    def test_binary_files_are_skipped(self) -> None:
        self.write("logo.png", b"\x89PNG\r\n\x00\x00corp.example\x00")
        self.assertEqual(gate.check(self.root, entries("corp.example")), [])

    def test_invalid_utf8_is_still_scanned(self) -> None:
        self.write("legacy.txt", b"caf\xe9 at corp.example\n")
        self.assertEqual(gate.check(self.root, entries("corp.example")), ["legacy.txt:1: forbidden domain (entry 1)"])

    def test_a_clean_tree_and_an_empty_list(self) -> None:
        self.write("a.txt", "www.example.com and host.test and 192.0.2.1\n")
        self.assertEqual(gate.check(self.root, entries("corp.example")), [])
        self.assertEqual(gate.check(self.root, ()), [])

    def test_a_broken_checkout_is_an_error_not_an_empty_scan(self) -> None:
        self.write(".git/config", "not a repository\n")
        with self.assertRaises(subprocess.CalledProcessError):
            gate.tracked_files(self.root)

    def test_without_git_every_file_is_listed(self) -> None:
        self.write("a.txt", "clean\n")
        self.write("sub/b.txt", "clean\n")
        self.assertEqual(gate.tracked_files(self.root), ["a.txt", "sub/b.txt"])

    @unittest.skipUnless(shutil.which("git"), "git is not installed")
    def test_only_tracked_files_are_scanned_in_a_checkout(self) -> None:
        def git(*args: str) -> None:
            subprocess.run(
                ["git", "-C", str(self.root), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                check=True,
                capture_output=True,
            )

        git("init", "-q")
        self.write("tracked.md", "uses corp.example\n")
        self.write("untracked.md", "uses corp.example\n")
        git("add", "tracked.md")
        self.assertEqual(gate.tracked_files(self.root), ["tracked.md"])
        self.assertEqual(
            gate.check(self.root, entries("corp.example")), ["tracked.md:1: forbidden domain (entry 1)"]
        )


class MainTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.root = Path(self._dir.name)
        (self.root / "a.md").write_text("see corp.example\n", encoding="utf-8")

    def run_main(self, value: str | None, *, actions: bool = False) -> tuple[int, str]:
        env = {k: v for k, v in os.environ.items() if k not in (gate.ENV_VAR, "GITHUB_ACTIONS")}
        if value is not None:
            env[gate.ENV_VAR] = value
        if actions:
            env["GITHUB_ACTIONS"] = "true"
        out = io.StringIO()
        with (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch.object(gate, "is_reserved", lambda _name: False),
            redirect_stdout(out),
        ):
            code = gate.main(["check_operator_domains.py", str(self.root)])
        return code, out.getvalue()

    def test_unset_and_empty_are_a_reduced_check_that_passes(self) -> None:
        for value in (None, "", "  \n"):
            code, out = self.run_main(value)
            self.assertEqual(code, 0, value)
            self.assertIn("reduced check", out)

    def test_the_notice_is_an_annotation_in_actions(self) -> None:
        code, out = self.run_main(None, actions=True)
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("::notice title=Operator-domain check::"), out)
        _, plain = self.run_main(None)
        self.assertTrue(plain.startswith("notice: "), plain)

    def test_a_hit_fails_and_prints_no_domain(self) -> None:
        code, out = self.run_main("corp.example")
        self.assertEqual(code, 1)
        self.assertIn("a.md:1: forbidden domain (entry 1)", out)
        self.assertNotIn("corp", out)

    def test_a_clean_tree_passes(self) -> None:
        code, out = self.run_main("other.example,\nthird.example")
        self.assertEqual(code, 0)
        self.assertIn("2 entries, no findings", out)

    def test_a_malformed_entry_fails_without_printing_it(self) -> None:
        code, out = self.run_main("fine.example\nnot a domain!")
        self.assertEqual(code, 2)
        self.assertIn("entry 2, 3, 4 is not a domain name", out)
        self.assertNotIn("domain!", out)

    def test_reserved_entries_are_noticed_and_ignored(self) -> None:
        env = {gate.ENV_VAR: "example.com\ncorp.example"}
        out = io.StringIO()
        # The real reserved-name rule: both entries are documentation names.
        with mock.patch.dict(os.environ, env), redirect_stdout(out):
            code = gate.main(["x", str(self.root)])
        self.assertEqual(code, 0)
        self.assertIn("entry 1, 2 is a name reserved for documentation", out.getvalue())
        self.assertIn("reduced check", out.getvalue())


if __name__ == "__main__":
    unittest.main()
