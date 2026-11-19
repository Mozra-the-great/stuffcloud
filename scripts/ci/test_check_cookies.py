"""Tests of check_cookies.py (the static cookie scope gate)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_cookies  # noqa: E402

APP = "crates/app/src/auth.rs"
OTHER = "crates/app/src/sessions.rs"


class ScanTest(unittest.TestCase):
    def test_literals_and_code_are_separated(self) -> None:
        source = 'let a = "one"; // "comment"\n/* "block /* nested */ still" */ let b = r#"raw "x""#;\n'
        scanned = check_cookies.scan(source)
        self.assertEqual([lit.text for lit in scanned.literals], ["one", 'raw "x"'])
        self.assertEqual([lit.line for lit in scanned.literals], [1, 2])
        self.assertNotIn("comment", scanned.code)
        self.assertNotIn("nested", scanned.code)
        self.assertIn("let b =", scanned.code)
        self.assertEqual(scanned.code.count("\n"), source.count("\n"))

    def test_escapes_bytes_chars_and_lifetimes(self) -> None:
        source = (
            "fn f<'a>(x: &'a str) -> char { let s = \"a\\\"b\"; let c = '\"'; let d = '\\''; "
            "let e = b\"bytes\"; let g = br\"raw bytes\"; let h = b'x'; 'q' }"
        )
        scanned = check_cookies.scan(source)
        self.assertEqual(
            [lit.text for lit in scanned.literals], ['a\\"b', "bytes", "raw bytes"]
        )
        self.assertIn("fn f<'a>(x: &'a str)", scanned.code)

    def test_identifiers_ending_in_r_or_b_are_not_prefixes(self) -> None:
        scanned = check_cookies.scan('let bar = for_r"x";')
        self.assertEqual([lit.text for lit in scanned.literals], ["x"])

    def test_unterminated_input_does_not_hang(self) -> None:
        for source in ['"open', 'r#"open', "/* open", "'\\", "// end"]:
            check_cookies.scan(source)
        self.assertIsNone(check_cookies._raw_string('r#x', 0))


class CheckFileTest(unittest.TestCase):
    def test_domain_attributes_in_literals_fail(self) -> None:
        for literal in [
            "a=b; Domain=example.com",
            "a=b;domain=.example.com",
            "Domain=example.com",
            "a=b; DOMAIN = example.com; Path=/",
        ]:
            with self.subTest(literal=literal):
                findings = check_cookies.check_file(APP, f'let x = "{literal}";\n')
                self.assertEqual(findings, [f"{APP}:1: a string sets a cookie Domain attribute"])

    def test_domain_in_raw_strings_fails(self) -> None:
        findings = check_cookies.check_file(OTHER, 'let x = 1;\nlet y = r#"a=b; Domain=x"#;\n')
        self.assertEqual(findings, [f"{OTHER}:2: a string sets a cookie Domain attribute"])

    def test_harmless_mentions_pass(self) -> None:
        source = (
            "// Never a Domain= attribute; see SPEC 5.5.\n"
            "/// The cookie has no `Domain=`.\n"
            'let text = "the domain of the zone";\n'
            'let pointer = "/domain";\n'
            "let domain = zone.domain_name();\n"
        )
        self.assertEqual(check_cookies.check_file(OTHER, source), [])

    def test_domain_builder_calls_fail(self) -> None:
        for call in ["cookie.domain(\"x\")", "c.set_domain(x)", "builder\n    . domain (x)"]:
            with self.subTest(call=call):
                findings = check_cookies.check_file(OTHER, f"fn f() {{ {call}; }}\n")
                self.assertEqual(len(findings), 1, findings)
                self.assertIn("calls a cookie domain(...) builder", findings[0])

    def test_set_cookie_only_in_the_cookie_module(self) -> None:
        source = 'use axum::http::header::SET_COOKIE;\nlet name = "Set-Cookie";\n'
        self.assertEqual(check_cookies.check_file(APP, source), [])
        findings = check_cookies.check_file(OTHER, source)
        self.assertEqual(
            findings,
            [
                f"{OTHER}:2: names the Set-Cookie header outside the cookie module ({APP})",
                f"{OTHER}:1: uses SET_COOKIE outside the cookie module ({APP})",
            ],
        )
        # A comment may talk about it.
        self.assertEqual(check_cookies.check_file(OTHER, "// sets SET_COOKIE \"set-cookie\"\n"), [])


class RepositoryTest(unittest.TestCase):
    def test_the_repository_is_clean(self) -> None:
        root = Path(__file__).resolve().parents[2]
        self.assertTrue(check_cookies.sources(root), "no Rust sources found")
        self.assertEqual(check_cookies.check(root), [])
        self.assertEqual(check_cookies.main(["check_cookies.py", str(root)]), 0)

    def test_findings_fail_and_an_empty_tree_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(check_cookies.main(["check_cookies.py", str(root)]), 1)
            source = root / "crates" / "edge" / "src"
            source.mkdir(parents=True)
            (source / "lib.rs").write_text('const C: &str = "s=1; Domain=example.org";\n', encoding="utf-8")
            self.assertEqual(
                check_cookies.check(root),
                ["crates/edge/src/lib.rs:1: a string sets a cookie Domain attribute"],
            )
            self.assertEqual(check_cookies.main(["check_cookies.py", str(root)]), 1)


if __name__ == "__main__":
    unittest.main()
