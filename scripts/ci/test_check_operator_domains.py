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
        self.assertIn("entry 2, 3, 4 is neither a domain name", out)
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


class AddressParseTest(unittest.TestCase):
    def test_an_address_entry_is_kept_whole_and_lowercase(self) -> None:
        (entry,) = entries("Some.One+tag@Mail.Example")
        self.assertEqual(
            (entry.kind, entry.ascii_name, entry.unicode_name),
            ("email", "some.one+tag@mail.example", "some.one+tag@mail.example"),
        )
        self.assertEqual(entry.number, 1)

    def test_domains_stay_domains_and_numbers_count_both_kinds(self) -> None:
        parsed = gate.parse_entries("corp.example\nsomeone@mail.example\nother.example", **NOTHING_RESERVED)
        self.assertEqual([(e.number, e.kind) for e in parsed.entries], [(1, "domain"), (2, "email"), (3, "domain")])

    def test_the_domain_part_of_an_address_may_be_unicode(self) -> None:
        (entry,) = entries("someone@bücher.example")
        self.assertEqual(entry.ascii_name, "someone@xn--bcher-kva.example")
        self.assertEqual(entry.unicode_name, "someone@bücher.example")

    def test_malformed_addresses(self) -> None:
        for bad in (
            "@mail.example",
            "someone@",
            "someone@localhost",
            "someone@mail",
            "a@b@mail.example",
            ".someone@mail.example",
            "someone.@mail.example",
            "some..one@mail.example",
            "some*one@mail.example",
            "*@mail.example",
            "someone@*.mail.example",
            "someone@.mail.example",
            "someone@mail.example.",
            "someone@-mail.example",
            "someone@mail..example",
            "someone@mail_x.example",
            "söme@mail.example",
            "someone@mail.example/x",
            "<someone@mail.example>",
            "mailto:someone@mail.example",
            "x" * 65 + "@mail.example",
        ):
            parsed = gate.parse_entries(bad, **NOTHING_RESERVED)
            self.assertEqual(parsed.entries, (), bad)
            self.assertEqual(len(parsed.malformed), 1, bad)

    def test_the_local_part_may_be_64_characters_and_use_atext(self) -> None:
        for good in ("x" * 64 + "@mail.example", "a.b-c_d+e=f'g@mail.example", "{a|b}~!$&?^`/%@mail.example"):
            self.assertEqual(len(entries(good)), 1, good)

    def test_an_address_with_a_reserved_domain_is_ignored_like_a_reserved_domain(self) -> None:
        parsed = gate.parse_entries("someone@example.com\nsomeone@corp.example\nsomeone@real-looking.de")
        self.assertEqual(parsed.reserved, (1, 2))
        self.assertEqual([e.ascii_name for e in parsed.entries], ["someone@real-looking.de"])
        self.assertEqual(parsed.malformed, ())

    def test_a_hash_still_starts_a_comment(self) -> None:
        parsed = gate.parse_entries("someone@mail.example # not this@other.example", **NOTHING_RESERVED)
        self.assertEqual([e.ascii_name for e in parsed.entries], ["someone@mail.example"])


class AddressMatchTest(unittest.TestCase):
    ADDRESS = "someone@mail.example"

    def test_the_address_in_any_case_and_surroundings(self) -> None:
        for text in (
            "someone@mail.example",
            "SomeOne@Mail.Example",
            "SOMEONE@MAIL.EXAMPLE",
            "<someone@mail.example>",
            "mailto:someone@mail.example?subject=x",
            '"someone@mail.example"',
            "'someone@mail.example'",
            "(someone@mail.example)",
            "Mail me: someone@mail.example.",
            "a,someone@mail.example,b",
            "to=someone@mail.example",
            "someone@mail.example:25",
            "someone@mail.example/path",
            "\tsomeone@mail.example\\n",
        ):
            self.assertEqual(hits(text, self.ADDRESS), [(1, 1)], text)

    def test_not_inside_a_longer_address_or_word(self) -> None:
        for text in (
            "xsomeone@mail.example",
            "first.someone@mail.example",
            "first_someone@mail.example",
            "first-someone@mail.example",
            "first+someone@mail.example",
            "1someone@mail.example",
            "50%someone@mail.example",
            "someone@mail.example.org",
            "someone@mail.example.pem",
            "someone@mail.examples",
            "someone@mail.example-two",
            "someone@xmail.example",
            "someone@sub.mail.example",
            "someone@mail.exampl",
            "someonemail.example",
            "someone mail.example",
            "someone at mail.example",
            "someone[at]mail.example",
        ):
            self.assertEqual(hits(text, self.ADDRESS), [], text)

    def test_the_local_part_must_be_whole(self) -> None:
        for text in ("someone2@mail.example", "someon@mail.example", "omeone@mail.example", "some.one@mail.example"):
            self.assertEqual(hits(text, self.ADDRESS), [], text)

    def test_an_address_entry_never_forbids_its_domain(self) -> None:
        for text in ("mail.example", "www.mail.example", "https://mail.example/x", "other@mail.example", "x@sub.mail.example", "someone"):
            self.assertEqual(hits(text, self.ADDRESS), [], text)

    def test_a_domain_entry_beside_it_still_matches_the_domain(self) -> None:
        text = "someone@mail.example and other@mail.example"
        self.assertEqual(hits(text, self.ADDRESS), [(1, 1)])
        self.assertEqual(hits(text, self.ADDRESS, "mail.example"), [(1, 1), (1, 2)])
        self.assertEqual(hits("other@mail.example", self.ADDRESS, "mail.example"), [(1, 2)])

    def test_escaped_at_signs(self) -> None:
        for text in (
            "someone%40mail.example",
            "mailto:someone%40Mail.Example",
            "someone&#64;mail.example",
            "someone&#064;mail.example",
            "someone&#x40;mail.example",
            "someone&#X40;mail.example",
            "someone&commat;mail.example",
            '"someone\\u0040mail.example"',
            "?to=someone%40mail.example&x=1",
        ):
            self.assertEqual(hits(text, self.ADDRESS), [(1, 1)], text)

    def test_what_is_not_covered(self) -> None:
        for text in ("someone%2540mail.example", "someone=40mail.example", "someone＠mail.example", "someone&#65;mail.example"):
            self.assertEqual(hits(text, self.ADDRESS), [], text)

    def test_after_a_percent_escape_the_address_still_matches(self) -> None:
        for text in ("a%20someone@mail.example", "to%3Asomeone%40mail.example", "%0Asomeone@mail.example"):
            self.assertEqual(hits(text, self.ADDRESS), [(1, 1)], text)
        self.assertEqual(hits("a%2someone@mail.example", self.ADDRESS), [])

    def test_unicode_and_punycode_domain_forms(self) -> None:
        for text in ("someone@bücher.example", "SOMEONE@BÜCHER.example", "someone@xn--bcher-kva.example"):
            self.assertEqual(hits(text, "someone@bücher.example"), [(1, 1)], text)
        self.assertEqual(hits("someone@bücher.example", "someone@xn--bcher-kva.example"), [(1, 1)])
        self.assertEqual(hits("someone@übücher.example", "someone@bücher.example"), [])

    def test_regex_metacharacters_in_the_local_part_are_literal(self) -> None:
        for entry, text in (("a.b@mail.example", "aXb@mail.example"), ("a+@mail.example", "aa@mail.example"), ("a?b@mail.example", "b@mail.example")):
            self.assertEqual(hits(text, entry), [], text)
        self.assertEqual(hits("a.b+c@mail.example", "a.b+c@mail.example"), [(1, 1)])

    def test_several_address_entries_report_their_own_numbers(self) -> None:
        text = "one@mail.example\nnone\ntwo@mail.example one@mail.example\n"
        self.assertEqual(hits(text, "one@mail.example", "two@mail.example"), [(1, 1), (3, 1), (3, 2)])


class AddressTreeTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.root = Path(self._dir.name)

    def write(self, relative: str, content: str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_a_finding_names_file_line_and_entry_but_never_the_address(self) -> None:
        self.write("docs/a.md", "fine\nwrite to Someone@Mail.Example today\nwww.mail.example is fine\n")
        found = gate.check(self.root, entries("other.example", "someone@mail.example"))
        self.assertEqual(found, ["docs/a.md:2: forbidden e-mail address (entry 2)"])
        self.assertNotIn("someone", "\n".join(found))
        self.assertNotIn("mail.example", "\n".join(found).lower())

    def test_domain_and_address_findings_are_labelled_by_kind(self) -> None:
        self.write("a.txt", "see corp.example and someone@mail.example\n")
        self.assertEqual(
            gate.check(self.root, entries("corp.example", "someone@mail.example")),
            ["a.txt:1: forbidden domain (entry 1)", "a.txt:1: forbidden e-mail address (entry 2)"],
        )

    def test_a_file_name_with_the_address_is_hidden(self) -> None:
        self.write("exports/someone@mail.example", "nothing here\n")
        self.write("exports/Someone%40Mail.Example/readme.md", "clean\n")
        found = gate.check(self.root, entries("someone@mail.example"))
        self.assertEqual(len(found), 2)
        for line in found:
            self.assertNotIn("someone", line.lower())
            self.assertTrue(line.startswith("<file name hidden #"), line)
            self.assertIn("forbidden e-mail address (entry 1)", line)

    def test_other_addresses_and_the_domain_alone_pass(self) -> None:
        self.write("a.txt", "other@mail.example\nhttps://mail.example/\nsomeone@mail.example.org\nxsomeone@mail.example\n")
        self.assertEqual(gate.check(self.root, entries("someone@mail.example")), [])


class NameRulesTest(unittest.TestCase):
    """Boundaries of the name rules; every fixture is a reserved or stand-in name."""

    def test_the_tld_decides_at_any_depth(self) -> None:
        self.assertTrue(gate.is_reserved("a.b.c.test"))
        self.assertTrue(gate.is_reserved("x.corp.example"))
        self.assertFalse(gate.is_reserved("example.corp.de"))

    def test_the_reserved_check_sees_the_ascii_form_of_a_unicode_name(self) -> None:
        seen: list[str] = []

        def record(name: str) -> bool:
            seen.append(name)
            return False

        gate.parse_entries("bücher.corp", record)
        gate.parse_entries("someone@bücher.corp", record)
        self.assertEqual(seen, ["xn--bcher-kva.corp", "xn--bcher-kva.corp"])

    def test_edge_dots_and_wildcards_are_stripped(self) -> None:
        self.assertEqual(gate._normalise(".corp.example."), ("corp.example", "corp.example"))
        self.assertEqual(gate._normalise("*.corp.example"), ("corp.example", "corp.example"))
        self.assertEqual(gate._normalise("..corp.example.."), ("corp.example", "corp.example"))
        self.assertIsNone(gate._normalise("..."))
        self.assertIsNone(gate._normalise("corp"))

    def test_a_name_may_be_253_characters_long_and_not_254(self) -> None:
        def name(last: int) -> str:
            return ".".join(["a" * 63, "b" * 63, "c" * 63, "d" * last])

        self.assertEqual(len(name(61)), 253)
        self.assertIsNotNone(gate._normalise(name(61)))
        self.assertEqual(len(name(62)), 254)
        self.assertIsNone(gate._normalise(name(62)))

    def test_an_address_needs_exactly_one_at_sign(self) -> None:
        self.assertIsNone(gate._normalise_address("a@b@corp.example"))
        self.assertIsNone(gate._normalise_address("a@corp@example.test"))
        self.assertIsNone(gate._normalise_address("üser@corp.example"))
        self.assertEqual(gate._normalise_address("User@Corp.Example"), ("user@corp.example", "user@corp.example"))

    def test_the_entry_of_a_list_item_with_a_second_at_sign_is_malformed(self) -> None:
        self.assertEqual(gate.parse_entries("a@b@corp.example", **NOTHING_RESERVED).malformed, (1,))


class TrackedFilesTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.root = Path(self._dir.name)

    def test_the_listing_of_git_is_used_with_the_exact_command(self) -> None:
        (self.root / ".git").mkdir()
        done = subprocess.CompletedProcess([], 0, stdout=b"b/c.txt\0a.txt\0caf\xe9.txt\0\0")
        with mock.patch.object(gate.subprocess, "run", return_value=done) as run:
            found = gate.tracked_files(self.root)
        run.assert_called_once_with(
            ["git", "-C", str(self.root), "ls-files", "-z"], check=True, capture_output=True
        )
        # A name that is not UTF-8 survives as surrogate escapes instead of failing the run.
        self.assertEqual(found, ["a.txt", "b/c.txt", "caf\udce9.txt"])

    def test_without_a_checkout_files_below_a_git_directory_are_left_out(self) -> None:
        for relative in ("a.txt", "sub/.git/config", "sub/b.txt", ".gitignore"):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("x\n", encoding="utf-8")
        self.assertEqual(gate.tracked_files(self.root), [".gitignore", "a.txt", "sub/b.txt"])


class CheckDetailsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.root = Path(self._dir.name)

    def write(self, relative: str, content: bytes | str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))

    def test_hidden_file_names_are_numbered_from_one(self) -> None:
        self.write("a/corp.example", "x\n")
        self.write("b/corp.example", "x\n")
        self.write("c/corp.example", "x\n")
        self.assertEqual(
            gate.check(self.root, entries("corp.example")),
            [
                "<file name hidden #1>: the file name contains a forbidden domain (entry 1)",
                "<file name hidden #2>: the file name contains a forbidden domain (entry 1)",
                "<file name hidden #3>: the file name contains a forbidden domain (entry 1)",
            ],
        )

    def test_a_hidden_name_with_a_hit_inside_reports_both_under_the_same_number(self) -> None:
        self.write("a/corp.example", "see corp.example\n")
        self.assertEqual(
            gate.check(self.root, entries("corp.example")),
            [
                "<file name hidden #1>: the file name contains a forbidden domain (entry 1)",
                "<file name hidden #1>:1: forbidden domain (entry 1)",
            ],
        )

    def test_an_unreadable_file_does_not_stop_the_scan(self) -> None:
        self.write("a.txt", "see corp.example\n")
        self.write("b.txt", "see corp.example\n")
        real = Path.read_bytes

        def read_bytes(path: Path) -> bytes:
            if path.name == "a.txt":
                raise OSError("dangling")
            return real(path)

        with mock.patch.object(Path, "read_bytes", read_bytes):
            found = gate.check(self.root, entries("corp.example"))
        self.assertEqual(found, ["b.txt:1: forbidden domain (entry 1)"])

    def test_a_binary_file_does_not_stop_the_scan(self) -> None:
        self.write("a.bin", b"\0corp.example\n")
        self.write("b.txt", "see corp.example\n")
        self.assertEqual(gate.check(self.root, entries("corp.example")), ["b.txt:1: forbidden domain (entry 1)"])

    def test_a_clean_file_does_not_stop_the_scan(self) -> None:
        self.write("a.txt", "nothing\n")
        self.write("b.txt", "see corp.example\n")
        self.assertEqual(gate.check(self.root, entries("corp.example")), ["b.txt:1: forbidden domain (entry 1)"])


class NoticeAndMainTest(unittest.TestCase):
    def run_main(
        self, argv: list[str], value: str | None, actions: str | None = None, reserved: bool = False
    ) -> tuple[int, str, list[Path]]:
        env = {k: v for k, v in os.environ.items() if k not in (gate.ENV_VAR, "GITHUB_ACTIONS")}
        if value is not None:
            env[gate.ENV_VAR] = value
        if actions is not None:
            env["GITHUB_ACTIONS"] = actions
        roots: list[Path] = []

        def fake_check(root: Path, found: tuple[gate.Entry, ...]) -> list[str]:
            roots.append(root)
            return []

        out = io.StringIO()
        with (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch.object(gate, "check", fake_check),
            mock.patch.object(gate, "is_reserved", gate.is_reserved if reserved else (lambda _name: False)),
            redirect_stdout(out),
        ):
            code = gate.main(argv)
        return code, out.getvalue(), roots

    def test_the_notice_format_depends_on_actions_being_exactly_true(self) -> None:
        for actions, expected in (
            ("true", "::notice title=Operator-domain check::hello\n"),
            ("false", "notice: hello\n"),
            ("TRUE", "notice: hello\n"),
            (None, "notice: hello\n"),
        ):
            with self.subTest(actions=actions), mock.patch.dict(os.environ, {"GITHUB_ACTIONS": actions or ""}):
                if actions is None:
                    os.environ.pop("GITHUB_ACTIONS")
                out = io.StringIO()
                with redirect_stdout(out):
                    gate.notice("hello")
                self.assertEqual(out.getvalue(), expected)

    def test_the_repository_is_the_default_root_and_an_argument_replaces_it(self) -> None:
        code, _, roots = self.run_main(["check_operator_domains.py"], "corp.example")
        self.assertEqual((code, roots), (0, [Path(gate.__file__).resolve().parents[2]]))
        code, _, roots = self.run_main(["check_operator_domains.py", "elsewhere"], "corp.example")
        self.assertEqual((code, roots), (0, [Path("elsewhere")]))

    def test_the_malformed_entry_message_is_exact(self) -> None:
        code, out, roots = self.run_main(["x", "r"], "fine.example\nnot a domain!")
        self.assertEqual((code, roots), (2, []))
        self.assertEqual(
            out,
            f"{gate.ENV_VAR}: entry 2, 3, 4 is neither a domain name (two or more labels of "
            "letters, digits and hyphens) nor an e-mail address (local@domain with a dot in the "
            "domain); fix the list in the repository's Actions settings\n",
        )

    def test_the_reduced_check_message_is_exact(self) -> None:
        code, out, _ = self.run_main(["x", "r"], "", actions="true")
        self.assertEqual(code, 0)
        self.assertEqual(
            out,
            f"::notice title=Operator-domain check::{gate.ENV_VAR} has no usable entry (empty or not "
            "available: pull requests from forks and Dependabot get no Actions secrets): reduced check, "
            "no operator domain was searched for\n",
        )

    def test_the_reserved_notice_is_exact(self) -> None:
        code, out, _ = self.run_main(["x", "r"], "example.com\ncorp.example", reserved=True)
        self.assertEqual(code, 0)
        self.assertTrue(
            out.startswith("notice: entry 1, 2 is a name reserved for documentation (RFC 2606) and is ignored\n"), out
        )

    def test_the_findings_message_is_exact(self) -> None:
        def fake_check(root: Path, found: tuple[gate.Entry, ...]) -> list[str]:
            return ["a.md:1: forbidden domain (entry 1)", "b.md:2: forbidden domain (entry 1)"]

        out = io.StringIO()
        with (
            mock.patch.dict(os.environ, {gate.ENV_VAR: "corp.example"}),
            mock.patch.object(gate, "check", fake_check),
            mock.patch.object(gate, "is_reserved", lambda _name: False),
            redirect_stdout(out),
        ):
            code = gate.main(["x", "r"])
        self.assertEqual(code, 1)
        self.assertEqual(
            out.getvalue(),
            "a.md:1: forbidden domain (entry 1)\n"
            "b.md:2: forbidden domain (entry 1)\n"
            "2 finding(s): an operator-specific domain or e-mail address must not be in the repository; "
            "use example.com, example.org, example.net or *.example / *.test (CLAUDE.md, Instance-neutral)\n",
        )

    def test_a_clean_run_reports_the_number_of_entries(self) -> None:
        code, out, _ = self.run_main(["x", "r"], "corp.example other.example")
        self.assertEqual((code, out), (0, "operator-domain check: 2 entries, no findings\n"))


class AddressMainTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.root = Path(self._dir.name)

    def run_main(self, value: str) -> tuple[int, str]:
        env = {k: v for k, v in os.environ.items() if k not in (gate.ENV_VAR, "GITHUB_ACTIONS")}
        env[gate.ENV_VAR] = value
        out = io.StringIO()
        with (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch.object(gate, "is_reserved", lambda _name: False),
            redirect_stdout(out),
        ):
            code = gate.main(["check_operator_domains.py", str(self.root)])
        return code, out.getvalue()

    def test_an_address_hit_fails_and_prints_no_address(self) -> None:
        (self.root / "b.md").write_text("contact: someone@mail.example\n", encoding="utf-8")
        code, out = self.run_main("someone@mail.example, other.example")
        self.assertEqual(code, 1)
        self.assertIn("b.md:1: forbidden e-mail address (entry 1)", out)
        self.assertNotIn("someone", out)
        self.assertNotIn("mail.example", out)

    def test_a_failing_fixture_per_rule(self) -> None:
        fixtures = {
            "exact.md": "someone@mail.example",
            "case.md": "SOMEONE@MAIL.EXAMPLE",
            "encoded.md": "someone%40mail.example",
            "entity.md": "someone&#64;mail.example",
            "sentence.md": "write to someone@mail.example.",
        }
        for name, content in fixtures.items():
            with self.subTest(name):
                (self.root / name).write_text(content + "\n", encoding="utf-8")
                code, out = self.run_main("someone@mail.example")
                self.assertEqual(code, 1, out)
                self.assertIn(f"{name}:1: forbidden e-mail address (entry 1)", out)
                (self.root / name).unlink()
        code, out = self.run_main("someone@mail.example")
        self.assertEqual(code, 0, out)

    def test_clean_neighbours_of_an_address_pass(self) -> None:
        (self.root / "c.md").write_text(
            "other@mail.example mail.example xsomeone@mail.example someone@mail.example.org\n", encoding="utf-8"
        )
        code, out = self.run_main("someone@mail.example")
        self.assertEqual(code, 0, out)
        self.assertIn("1 entries, no findings", out)

    def test_a_malformed_address_fails_without_printing_it(self) -> None:
        for bad in ("fine.example\nsomeone@localhost", "fine.example\nso..one@mail.example", "@mail.example"):
            code, out = self.run_main(bad)
            self.assertEqual(code, 2, bad)
            self.assertIn("is neither a domain name", out)
            self.assertNotIn("someone", out)
            self.assertNotIn("mail.example", out)
        code, out = self.run_main("fine.example\nsomeone@localhost")
        self.assertIn("entry 2 is neither", out)


if __name__ == "__main__":
    unittest.main()
