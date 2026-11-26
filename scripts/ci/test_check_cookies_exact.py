"""Exact-output tests of check_cookies.py: the scanner, the escapes and every finding's text.

`test_check_cookies.py` has one fixture per bypass; this file pins the details a mutation of
the code would change without breaking a bypass test: where a literal or comment ends, which
character an escape consumes, the line number and the wording of each finding.
"""

from __future__ import annotations

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_cookies as cc  # noqa: E402

BS = "\\"
APP = "crates/app/src/auth.rs"
OTHER = "crates/app/src/sessions.rs"
CORE = "crates/core/src/cookie.rs"
TESTS = "crates/app/tests/integration/common.rs"
MODULES = "crates/app/src/auth.rs"
BUILDERS = "crates/core/src/cookie.rs"


def lit(line: int, text: str, start: int, raw: bool = False) -> cc.Literal:
    return cc.Literal(line, text, start, raw)


class ScanTest(unittest.TestCase):
    def check(self, source: str, code: str, literals: list[cc.Literal]) -> None:
        scanned = cc.scan(source)
        self.assertEqual(scanned.code, code, source)
        self.assertEqual(list(scanned.literals), literals, source)

    def test_line_comments(self) -> None:
        self.check("a // b\nc", "a     \nc", [])
        self.check("a // b", "a     ", [])

    def test_block_comments(self) -> None:
        self.check("/**/x", "    x", [])
        self.check("/* a /* b */ c */x", " " * 17 + "x", [])
        self.check("/* open", " " * 7, [])
        self.check("/* a */", " " * 7, [])
        self.check("/* a\n b */x", "    \n     x", [])

    def test_raw_strings(self) -> None:
        self.check('r"abc" x', "       x", [lit(1, "abc", 0, True)])
        self.check('r#"a"b"# x', "         x", [lit(1, 'a"b', 0, True)])
        self.check('r##"a"#b"## y', " " * 12 + "y", [lit(1, 'a"#b', 0, True)])
        self.check('r#"abc', " " * 6, [lit(1, "abc", 0, True)])
        self.check('x r"y"', "x     ", [lit(1, "y", 2, True)])
        self.check('br"raw" z', "        z", [lit(1, "raw", 0, True)])
        self.check(' br"raw" z', "         z", [lit(1, "raw", 1, True)])
        self.check(' r"raw" z', "        z", [lit(1, "raw", 1, True)])
        self.check('\nr"y"', "\n    ", [lit(2, "y", 1, True)])

    def test_a_hash_without_a_quote_is_no_raw_string(self) -> None:
        self.check("r#", "r#", [])
        self.check("r#x", "r#x", [])
        self.check("r", "r", [])
        self.check("r = 1", "r = 1", [])
        self.check("b = 1", "b = 1", [])

    def test_a_prefix_letter_inside_an_identifier_is_no_prefix(self) -> None:
        self.check('xr"a"', "xr   ", [lit(1, "a", 2)])
        self.check('_r"a"', "_r   ", [lit(1, "a", 2)])
        self.check('7r"a"', "7r   ", [lit(1, "a", 2)])
        self.check(' r"a"', "     ", [lit(1, "a", 1, True)])
        self.check('.r"a"', ".    ", [lit(1, "a", 1, True)])
        self.assertEqual(cc._ident_before("ab", 0), False)
        self.assertEqual(cc._ident_before("ab", 1), True)
        self.assertEqual(cc._ident_before("_b", 1), True)
        self.assertEqual(cc._ident_before("1b", 1), True)
        self.assertEqual(cc._ident_before(" b", 1), False)
        self.assertEqual(cc._ident_before("a b", 2), False)
        self.assertEqual(cc._ident_before("(b", 1), False)
        self.assertEqual(cc._ident_before("b_", 0), False)
        self.assertEqual(cc._ident_before("ab ", 1), True)

    def test_a_raw_string_at_the_start_is_not_blocked_by_the_end_of_the_file(self) -> None:
        self.check('r"a" y', "     y", [lit(1, "a", 0, True)])

    def test_byte_strings_and_characters(self) -> None:
        self.check('b"abc" z', "       z", [lit(1, "abc", 1)])
        self.check("b'x' z", "     z", [])
        self.check('Bx"a"', "Bx   ", [lit(1, "a", 2)])
        self.check("b+1", "b+1", [])
        self.check("bx", "bx", [])
        self.check("b", "b", [])

    def test_strings_and_their_escapes(self) -> None:
        self.check('\n"a"', "\n   ", [lit(2, "a", 1)])
        self.check('"a' + BS + 'nb" z', "       z", [lit(1, "a" + BS + "nb", 0)])
        self.check('"a' + BS + '"b" z', "       z", [lit(1, "a" + BS + '"b', 0)])
        self.check('"' + BS + 'n" z', "     z", [lit(1, BS + "n", 0)])
        self.check('"a" "b"', "       ", [lit(1, "a", 0), lit(1, "b", 4)])
        self.check('"" "b"', "      ", [lit(1, "", 0), lit(1, "b", 3)])
        self.check('x = "";"Domain="', "x =   ;         ", [lit(1, "", 4), lit(1, "Domain=", 7)])

    def test_character_literals_and_lifetimes(self) -> None:
        self.check("'x' y", "    y", [])
        self.check("'x'", "   ", [])
        self.check("'x", "'x", [])
        self.check("'a>", "'a>", [])
        self.check("'", "'", [])
        self.check("'" + BS + "n' z", "     z", [])
        self.check("'" + BS + "'' z", "     z", [])
        self.check("'" + BS + BS + "' z", "     z", [])
        self.check("'" + BS + "u{41}' z", "         z", [])
        self.check("x'" + BS + "n'", "x    ", [])
        self.check("'" + BS + "'", "   ", [])
        self.check("'" + BS, "  ", [])
        self.check("'\"' \"a\"", "    " + "   ", [lit(1, "a", 4)])

    def test_a_string_quote_inside_a_character_literal_does_not_open_a_string(self) -> None:
        scanned = cc.scan("let q = '\"'; let s = \"Domain=x\";")
        self.assertEqual([item.text for item in scanned.literals], ["Domain=x"])

    def test_an_escaped_quote_character_literal_is_blanked_whole(self) -> None:
        scanned = cc.scan("let q = '" + BS + "''; let s = \"Domain=x\";")
        self.assertEqual(scanned.code, "let q =     ; let s =           ;")
        self.assertEqual([item.text for item in scanned.literals], ["Domain=x"])

    def test_line_numbers_follow_the_newlines_before_each_literal(self) -> None:
        scanned = cc.scan('\n\n"a"\n r"b" /* c\nd */ "e"')
        self.assertEqual([(item.line, item.text) for item in scanned.literals], [(3, "a"), (4, "b"), (5, "e")])
        self.assertEqual(cc._line_of("\nab", 0), 1)
        self.assertEqual(cc._line_of("\nab", 1), 2)
        self.assertEqual(cc._line_of("a\nb\nc", 4), 3)
        self.assertEqual(cc._line_of("a\n\n\nc", 3), 3)


class UnescapeTest(unittest.TestCase):
    def test_hex_escapes_take_either_case(self) -> None:
        self.assertEqual(cc.unescape(BS + "x4F"), "O")
        self.assertEqual(cc.unescape(BS + "x4f"), "O")
        self.assertEqual(cc.unescape(BS + "x41" + BS + "x42"), "AB")
        self.assertEqual(cc.unescape(BS + "x4g"), BS + "x4g")
        self.assertEqual(cc.unescape(BS + "x4"), BS + "x4")
        self.assertEqual(cc.unescape(BS + "xG1"), BS + "xG1")

    def test_unicode_escapes(self) -> None:
        self.assertEqual(cc.unescape(BS + "u{41}"), "A")
        self.assertEqual(cc.unescape(BS + "u{4_1}b"), "Ab")
        self.assertEqual(cc.unescape(BS + "u{_41}"), "A")
        self.assertEqual(cc.unescape(BS + "u{1F600}"), "\U0001f600")
        self.assertEqual(cc.unescape(BS + "u{41" + "}"), "A")
        self.assertEqual(cc.unescape(BS + "u41"), BS + "u41")
        self.assertEqual(cc.unescape(BS + "u{}"), BS + "u{}")

    def test_an_unicode_escape_out_of_range_is_kept_as_written(self) -> None:
        self.assertEqual(cc.unescape(BS + "u{110000}z"), BS + "u{110000}z")
        self.assertEqual(cc.unescape("a" + BS + "u{FFFFFFFF}bc"), "a" + BS + "u{FFFFFFFF}bc")
        self.assertEqual(cc.unescape(BS + "u{_}x"), BS + "u{_}x")

    def test_a_line_continuation_swallows_the_white_space_after_it(self) -> None:
        self.assertEqual(cc.unescape("a" + BS + "\n \t\r\n b"), "ab")
        self.assertEqual(cc.unescape("a" + BS + "\n  "), "a")
        self.assertEqual(cc.unescape("a" + BS + "\nb"), "ab")
        self.assertEqual(cc.unescape("a" + BS + "\n"), "a")
        self.assertEqual(cc.unescape("a" + BS + "\n x"), "ax")
        self.assertEqual(cc.unescape("a" + BS + "\nXb"), "aXb")

    def test_simple_escapes_and_unknown_ones(self) -> None:
        self.assertEqual(cc.unescape(BS + "n" + BS + "r" + BS + "t" + BS + "0" + BS + BS + BS + "'" + BS + '"'),
                         "\n\r\t\0" + BS + "'" + '"')
        self.assertEqual(cc.unescape(BS + "q"), BS + "q")
        self.assertEqual(cc.unescape("a" + BS), "a" + BS)
        self.assertEqual(cc.unescape(BS), BS)
        self.assertEqual(cc.unescape("ab"), "ab")
        self.assertEqual(cc.unescape(BS + "qx"), BS + "qx")
        self.assertEqual(cc.unescape("ab" + BS + "qcd"), "ab" + BS + "qcd")


class ConcatenatedTest(unittest.TestCase):
    def joined(self, source: str) -> list[cc.Literal]:
        return cc._concatenated(cc.scan(source))

    def test_the_pieces_of_one_call_are_joined(self) -> None:
        self.assertEqual(self.joined('concat!("Dom", "ain=")'), [lit(1, "Domain=", 0, True)])

    def test_the_join_reports_the_line_and_start_of_the_call(self) -> None:
        self.assertEqual(self.joined('\nx;\n  concat!("a", "b")'), [lit(3, "ab", 6, True)])

    def test_a_single_piece_is_not_a_join(self) -> None:
        self.assertEqual(self.joined('concat!("only")'), [])

    def test_literals_after_the_closing_parenthesis_are_not_pieces(self) -> None:
        self.assertEqual(self.joined('concat!("a", "b");\nlog("x");'), [lit(1, "ab", 0, True)])
        self.assertEqual(self.joined('concat!("a", "b")"c"'), [lit(1, "ab", 0, True)])
        self.assertEqual(self.joined('concat!("a", "b") + "c" + "d"'), [lit(1, "ab", 0, True)])

    def test_nested_parentheses_do_not_end_the_call_early(self) -> None:
        self.assertEqual(self.joined('concat!("a", f("x"), "b"); "later"'), [lit(1, "axb", 0, True)])
        self.assertEqual(self.joined('concat!("a", (1), "b"); ("later")'), [lit(1, "ab", 0, True)])

    def test_an_unterminated_call_reads_to_the_end(self) -> None:
        self.assertEqual(self.joined('concat!("a", "b"'), [lit(1, "ab", 0, True)])

    def test_escapes_are_resolved_before_joining(self) -> None:
        self.assertEqual(self.joined('concat!("a' + BS + 'x42", "c")'), [lit(1, "aBc", 0, True)])

    def test_several_calls_are_joined_separately(self) -> None:
        self.assertEqual(
            self.joined('concat!("a", "b"); concat!("c", "d")'),
            [lit(1, "ab", 0, True), lit(1, "cd", 19, True)],
        )


class FindingOrderTest(unittest.TestCase):
    def test_findings_sort_by_line_number_not_by_text(self) -> None:
        findings = ["f.rs:10: b", "f.rs:2: a", "f.rs:2: A", "f.rs:100: c"]
        self.assertEqual(sorted(findings, key=cc._finding_order), ["f.rs:2: A", "f.rs:2: a", "f.rs:10: b", "f.rs:100: c"])

    def test_a_finding_without_a_line_sorts_first(self) -> None:
        self.assertEqual(cc._finding_order("f.rs:7: x: y"), (7, "f.rs:7: x: y"))
        self.assertEqual(cc._finding_order("no line here"), (0, "no line here"))
        self.assertEqual(cc._finding_order("f.rs: x: y"), (0, "f.rs: x: y"))
        self.assertEqual(cc._finding_order("f.rs:x: y"), (0, "f.rs:x: y"))
        self.assertEqual(cc._finding_order("f.rs:7"), (0, "f.rs:7"))


class RustFindingTextTest(unittest.TestCase):
    def test_a_domain_attribute_in_a_string(self) -> None:
        self.assertEqual(
            cc.check_file(OTHER, 'fn f() {}\nlet a = "x; Domain=a";\n'),
            [f"{OTHER}:2: a string sets a cookie Domain attribute"],
        )

    def test_the_attribute_name_built_from_pieces(self) -> None:
        self.assertEqual(
            cc.check_file(OTHER, 'let a = "Domain";'),
            [f"{OTHER}:1: a string is the cookie Domain attribute name (a Domain attribute built from pieces)"],
        )

    def test_the_header_name_outside_the_cookie_module(self) -> None:
        self.assertEqual(
            cc.check_file(OTHER, 'let h = "Set-Cookie";'),
            [f"{OTHER}:1: names the Set-Cookie header outside the cookie module ({MODULES})"],
        )

    def test_a_domain_builder_call(self) -> None:
        self.assertEqual(
            cc.check_file(OTHER, "fn f() {}\nlet c = b.domain(x);\nfn g() {}\nfn h() {}"),
            [f"{OTHER}:2: calls a cookie domain(...) builder"],
        )

    def test_a_cookie_library_api_is_shown_with_single_spaces(self) -> None:
        self.assertEqual(
            cc.check_file(OTHER, "let c = Cookie  ::\n  new(x);\nlet j = CookieJar::new();"),
            [
                f"{OTHER}:1: uses a cookie library API (Cookie :: new); cookies are built by HostCookie only",
                f"{OTHER}:3: uses a cookie library API (CookieJar); cookies are built by HostCookie only",
            ],
        )

    def test_a_set_cookie_value_outside_core(self) -> None:
        self.assertEqual(
            cc.check_file(OTHER, "\nlet c = SetCookie(x);\n\nfn g() {}"),
            [f"{OTHER}:2: constructs a SetCookie outside {BUILDERS}"],
        )
        self.assertEqual(cc.check_file(CORE, "let c = SetCookie(x);"), [])

    def test_the_header_constant_outside_the_cookie_module(self) -> None:
        self.assertEqual(
            cc.check_file(OTHER, "use http::header::SET_COOKIE;"),
            [f"{OTHER}:1: uses SET_COOKIE outside the cookie module ({MODULES})"],
        )
        self.assertEqual(cc.check_file(APP, "use http::header::SET_COOKIE;"), [])
        self.assertEqual(cc.check_file(TESTS, "use http::header::SET_COOKIE;"), [])

    def test_findings_are_ordered_by_line(self) -> None:
        source = "\n" * 9 + 'let a = "x; Domain=a";\n' + 'let b = "y; domain=b";\n'
        source = 'let c = Cookie::new(1);\n' + "\n" * 7 + source
        self.assertEqual(
            [finding.split(" ")[0] for finding in cc.check_file(OTHER, source)],
            [f"{OTHER}:1:", f"{OTHER}:18:", f"{OTHER}:19:"],
        )
        ordered = cc.check_file(OTHER, 'let b = "b; Domain=1";\nlet a = "a; Domain=1";\n' + 'let h = "Set-Cookie";')
        self.assertEqual([finding.split(":")[1] for finding in ordered], ["1", "2", "3"])

    def test_a_comparison_with_the_attribute_name_passes_and_a_write_fails(self) -> None:
        self.assertEqual(cc.check_file(OTHER, 'if name.eq_ignore_ascii_case("Domain") {}'), [])
        self.assertEqual(cc.check_file(OTHER, 'if name == "Domain" {}'), [])
        self.assertEqual(len(cc.check_file(OTHER, 'push("Domain");')), 1)

    def test_a_concat_is_checked_as_one_string(self) -> None:
        self.assertEqual(
            cc.check_file(OTHER, 'let a = concat!("Dom", "ain=x");'),
            [
                f"{OTHER}:1: a string sets a cookie Domain attribute",
            ],
        )


class ListedNamesTest(unittest.TestCase):
    """Several allowed files are listed with commas in the messages."""

    def test_the_cookie_modules_are_listed_in_order(self) -> None:
        with mock.patch.object(cc, "COOKIE_MODULES", frozenset({"b/auth.rs", "a/auth.rs"})):
            self.assertEqual(
                cc.check_file(OTHER, 'let h = "Set-Cookie";\nuse x::SET_COOKIE;'),
                [
                    f"{OTHER}:1: names the Set-Cookie header outside the cookie module (a/auth.rs, b/auth.rs)",
                    f"{OTHER}:2: uses SET_COOKIE outside the cookie module (a/auth.rs, b/auth.rs)",
                ],
            )

    def test_the_set_cookie_builders_are_listed_in_order(self) -> None:
        with mock.patch.object(cc, "SET_COOKIE_BUILDERS", frozenset({"z/cookie.rs", "y/cookie.rs"})):
            self.assertEqual(
                cc.check_file(OTHER, "let c = SetCookie(x);"),
                [f"{OTHER}:1: constructs a SetCookie outside y/cookie.rs, z/cookie.rs"],
            )

    def test_the_caddy_allowlist_is_listed_in_order(self) -> None:
        with mock.patch.object(cc, "CADDY_SET_COOKIE_ALLOWLIST", frozenset({"two/Caddyfile", "one/Caddyfile"})):
            self.assertEqual(
                cc.check_caddyfile("other/Caddyfile", "header Set-Cookie x\n"),
                ["other/Caddyfile:1: names the Set-Cookie header in a Caddy file outside one/Caddyfile, two/Caddyfile"],
            )


class CommentHandlingTest(unittest.TestCase):
    def test_a_caddy_comment_is_cut_off_without_leaving_text_behind(self) -> None:
        self.assertEqual(
            cc.check_caddyfile("c", "cookie_domain # a note\n"),
            ["c:1: sets a cookie Domain attribute"],
        )

    def test_a_comment_inside_an_expression_does_not_hide_document_cookie(self) -> None:
        self.assertEqual(len(cc.check_web("web/a.ts", "document/* x */.cookie;\n")), 1)
        self.assertEqual(len(cc.check_web("web/a.ts", "document<!-- x -->.cookie;\n")), 1)

    def test_a_line_comment_is_removed_without_leaving_text_behind(self) -> None:
        self.assertEqual(
            cc.check_web("web/a.ts", "const a = '; domain // c\n= x';\n"),
            ["web/a.ts:1: sets a cookie Domain attribute"],
        )


class OtherFileKindsTest(unittest.TestCase):
    def test_manifest_findings_name_the_library_and_the_line(self) -> None:
        self.assertEqual(
            cc.check_manifest("crates/x/Cargo.toml", '[package]\nname = "x"\n\n[dependencies]\ncookie = "0.18"\n'),
            [
                "crates/x/Cargo.toml:5: depends on cookie, a cookie or session library; "
                "review the cookies it sets and extend scripts/ci/check_cookies.py first"
            ],
        )
        self.assertEqual(
            cc.check_manifest("c/Cargo.toml", "[dependencies.tower-cookies]\nversion = \"1\"\n")[0].split(": ")[0],
            "c/Cargo.toml:1",
        )

    def test_caddy_findings_are_numbered_from_one_and_name_the_allowlist(self) -> None:
        self.assertEqual(
            cc.check_caddyfile("docker/caddy/Caddyfile", "a\nheader Set-Cookie x\ncookie_domain y\n"),
            [
                "docker/caddy/Caddyfile:2: names the Set-Cookie header in a Caddy file outside docker/caddy/Caddyfile.dev",
                "docker/caddy/Caddyfile:3: sets a cookie Domain attribute",
            ],
        )
        self.assertEqual(
            cc.check_caddyfile("docker/caddy/Caddyfile.dev", "header Set-Cookie x\n"),
            [],
        )
        self.assertEqual(
            cc.check_caddyfile("c", "Domain=x # a comment\nhost # Domain=y\n"),
            ["c:1: sets a cookie Domain attribute"],
        )
        self.assertEqual(cc.check_caddyfile("c", "# Domain=x\n"), [])

    def test_web_findings_keep_their_line_numbers_across_comments(self) -> None:
        source = (
            "<!-- document.cookie\n  in a comment -->\n"
            "/* document.cookie\n   in a block */\n"
            "// document.cookie in a line comment\n"
            "const a = document.cookie;\n"
        )
        self.assertEqual(
            cc.check_web("web/a.ts", source),
            [
                "web/a.ts:6: uses document.cookie, the Cookie Store API or a cookie library; "
                "the session cookies are HttpOnly and set by the server"
            ],
        )

    def test_web_domain_and_header_findings(self) -> None:
        self.assertEqual(
            cc.check_web("web/a.ts", "\nconst a = '; Domain=x';\nconst h = 'Set-Cookie';\n"),
            [
                "web/a.ts:2: sets a cookie Domain attribute",
                "web/a.ts:3: names the Set-Cookie header in a web source",
            ],
        )

    def test_a_line_comment_marker_inside_a_url_is_not_a_comment(self) -> None:
        self.assertEqual(
            len(cc.check_web("web/a.ts", "const u = 'https://example.com/'; document.cookie;\n")), 1
        )

    def test_the_web_allowlist_silences_only_the_api_finding(self) -> None:
        with mock.patch.object(cc, "WEB_COOKIE_ALLOWLIST", frozenset({"web/a.ts"})):
            self.assertEqual(cc.check_web("web/a.ts", "document.cookie;\n"), [])
            self.assertEqual(len(cc.check_web("web/a.ts", "'; Domain=x';\n")), 1)


class WalkAndMainTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.root = Path(self._dir.name)

    def write(self, relative: str, text: str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_sources_lists_only_rust_files(self) -> None:
        self.write("a.rs", "")
        self.write("b.txt", "")
        self.write("sub/c.rs", "")
        self.assertEqual([path.name for path in cc.sources(self.root)], ["a.rs", "c.rs"])

    def test_every_kind_of_file_is_read_as_utf8(self) -> None:
        self.write("crates/a/src/lib.rs", "fn f() {}\n")
        self.write("crates/a/Cargo.toml", "[package]\n")
        self.write("docker/Caddyfile", "x\n")
        self.write("web/a.ts", "export {};\n")
        real = Path.read_text
        seen: list[tuple[str, object]] = []

        def spy(path: Path, *args: object, **kwargs: object) -> str:
            seen.append((path.name, kwargs.get("encoding")))
            return real(path, *args, **kwargs)

        with mock.patch.object(Path, "read_text", spy):
            self.assertEqual(cc.check(self.root), [])
        self.assertEqual(
            sorted(seen),
            [("Caddyfile", "utf-8"), ("Cargo.toml", "utf-8"), ("a.ts", "utf-8"), ("lib.rs", "utf-8")],
        )

    def run_main(self, argv: list[str]) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cc.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_no_rust_sources_is_an_error_on_stderr(self) -> None:
        code, out, err = self.run_main(["check_cookies.py", str(self.root)])
        self.assertEqual((code, out), (1, ""))
        self.assertEqual(err, f"check_cookies: no Rust sources under {self.root}\n")

    def test_findings_are_printed_with_the_summary(self) -> None:
        self.write("crates/a/src/lib.rs", 'let a = "x; Domain=a";\n')
        code, out, err = self.run_main(["check_cookies.py", str(self.root)])
        self.assertEqual((code, err), (1, ""))
        self.assertEqual(
            out,
            "crates/a/src/lib.rs:1: a string sets a cookie Domain attribute\n"
            "check_cookies: 1 finding(s); every cookie must be a host-only __Host- cookie\n",
        )

    def test_a_clean_tree_reports_the_number_of_rust_files(self) -> None:
        self.write("crates/a/src/lib.rs", "fn f() {}\n")
        self.write("crates/a/src/other.rs", "fn g() {}\n")
        code, out, err = self.run_main(["check_cookies.py", str(self.root)])
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(
            out,
            "check_cookies: 2 Rust files, manifests, Caddy files and web sources clean "
            "(no Domain attribute, Set-Cookie only in the cookie module)\n",
        )

    def test_the_repository_is_the_default_root(self) -> None:
        roots: list[Path] = []

        def fake_sources(root: Path) -> list[Path]:
            roots.append(root)
            return [Path("a.rs")]

        with mock.patch.object(cc, "sources", fake_sources), mock.patch.object(cc, "check", lambda root: []):
            self.assertEqual(self.run_main(["check_cookies.py"])[0], 0)
            self.assertEqual(self.run_main(["check_cookies.py", "elsewhere"])[0], 0)
        self.assertEqual(roots, [Path(cc.__file__).resolve().parents[2], Path("elsewhere")])


if __name__ == "__main__":
    unittest.main()
