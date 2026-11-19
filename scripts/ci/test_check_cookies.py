"""Tests of check_cookies.py (the static cookie scope gate).

Every bypass the gate knows about has a fixture here that must fail it (#136).
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_cookies  # noqa: E402

APP = "crates/app/src/auth.rs"
OTHER = "crates/app/src/sessions.rs"
CORE = "crates/core/src/cookie.rs"
TESTS = "crates/app/tests/integration/common.rs"


def findings_of(relative: str, source: str) -> list[str]:
    return check_cookies.check_file(relative, source)


class ScanTest(unittest.TestCase):
    def test_literals_and_code_are_separated(self) -> None:
        source = 'let a = "one"; // "comment"\n/* "block /* nested */ still" */ let b = r#"raw "x""#;\n'
        scanned = check_cookies.scan(source)
        self.assertEqual([lit.text for lit in scanned.literals], ["one", 'raw "x"'])
        self.assertEqual([lit.line for lit in scanned.literals], [1, 2])
        self.assertEqual([lit.raw for lit in scanned.literals], [False, True])
        self.assertNotIn("comment", scanned.code)
        self.assertNotIn("nested", scanned.code)
        self.assertIn("let b =", scanned.code)
        self.assertEqual(scanned.code.count("\n"), source.count("\n"))
        self.assertEqual(len(scanned.code), len(source))

    def test_escapes_bytes_chars_and_lifetimes(self) -> None:
        source = (
            "fn f<'a>(x: &'a str) -> char { let s = \"a\\\"b\"; let c = '\"'; let d = '\\''; "
            "let e = b\"bytes\"; let g = br\"raw bytes\"; let h = b'x'; 'q' }"
        )
        scanned = check_cookies.scan(source)
        self.assertEqual([lit.text for lit in scanned.literals], ['a\\"b', "bytes", "raw bytes"])
        self.assertIn("fn f<'a>(x: &'a str)", scanned.code)

    def test_identifiers_ending_in_r_or_b_are_not_prefixes(self) -> None:
        scanned = check_cookies.scan('let bar = for_r"x";')
        self.assertEqual([lit.text for lit in scanned.literals], ["x"])

    def test_unterminated_input_does_not_hang(self) -> None:
        for source in ['"open', 'r#"open', "/* open", "'\\", "// end"]:
            check_cookies.scan(source)
        self.assertIsNone(check_cookies._raw_string("r#x", 0))

    def test_unescape(self) -> None:
        cases = {
            "plain": "plain",
            "a\\nb": "a\nb",
            "\\x53et-\\x43ookie": "Set-Cookie",
            "set\\u{2d}cookie": "set-cookie",
            "set\\u{2D}cookie": "set-cookie",
            "a\\\\b": "a\\b",
            'say \\"x\\"': 'say "x"',
            "it\\'s": "it's",
            "nul\\0": "nul\0",
            "tab\\t": "tab\t",
            "cr\\r": "cr\r",
            "set-\\\n      cookie": "set-cookie",
            # Not valid Rust: kept as written, the compiler rejects it anyway.
            "\\q": "\\q",
            "\\xZZ": "\\xZZ",
            "\\x4": "\\x4",
            "\\u{110000000000}": "\\u{110000000000}",
            "trailing\\": "trailing\\",
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(check_cookies.unescape(text), expected)

    def test_raw_literals_are_not_unescaped(self) -> None:
        scanned = check_cookies.scan('let a = r"\\x44omain=x"; let b = "\\x44omain=x";')
        self.assertEqual([lit.value for lit in scanned.literals], ["\\x44omain=x", "Domain=x"])


class DomainAttributeTest(unittest.TestCase):
    def test_domain_attributes_in_literals_fail(self) -> None:
        for literal in [
            "a=b; Domain=example.com",
            "a=b;domain=.example.com",
            "Domain=example.com",
            "a=b; DOMAIN = example.com; Path=/",
        ]:
            with self.subTest(literal=literal):
                findings = findings_of(APP, f'let x = "{literal}";\n')
                self.assertEqual(findings, [f"{APP}:1: a string sets a cookie Domain attribute"])

    def test_domain_in_raw_and_byte_strings_fails(self) -> None:
        for literal in ['r#"a=b; Domain=x"#', 'b"a=b; Domain=x"', 'br"a=b; Domain=x"']:
            with self.subTest(literal=literal):
                findings = findings_of(OTHER, f"let x = 1;\nlet y = {literal};\n")
                self.assertEqual(findings, [f"{OTHER}:2: a string sets a cookie Domain attribute"])

    def test_escaped_domain_attributes_fail(self) -> None:
        for literal in [
            "a=b; \\x44omain=x",
            "a=b; D\\u{6f}main=x",
            "a=b; \\u{44}\\u{6f}main = x",
            "a=b;\\x20Domain=x",
            "a=b; Do\\\n        main=x",
        ]:
            with self.subTest(literal=literal):
                findings = findings_of(OTHER, f'let x = "{literal}";\n')
                self.assertEqual(len(findings), 1, findings)
                self.assertIn("sets a cookie Domain attribute", findings[0])

    def test_domain_attributes_built_with_concat_fail(self) -> None:
        for source in [
            'let x = concat!("a=b; Dom", "ain=x");',
            'let x = concat!(\n    "a=b; Dom",\n    "ain=x",\n);',
        ]:
            with self.subTest(source=source):
                findings = findings_of(OTHER, source + "\n")
                self.assertEqual(len(findings), 1, findings)
                self.assertIn("sets a cookie Domain attribute", findings[0])

    def test_pieces_are_flagged_even_when_the_attribute_is_split_in_three(self) -> None:
        findings = findings_of(OTHER, 'let x = concat!("a=b; ", "Domain", "=x");\n')
        self.assertTrue(any("sets a cookie Domain attribute" in finding for finding in findings), findings)
        findings = findings_of(OTHER, 'let attribute = "Domain=";\n')
        self.assertEqual(findings, [f"{OTHER}:1: a string sets a cookie Domain attribute"])

    def test_a_domain_attribute_name_on_its_own_fails(self) -> None:
        # `format!("{}={}", "Domain", host)` builds the attribute from pieces.
        for source in [
            'let x = format!("a=b; {}={}", "Domain", host);',
            'let x = format!("a=b; {k}={v}", k = "domain", v = host);',
            'let x = format!("a=b; {}{}", " Domain ", "=");',
            'let attribute = b"DOMAIN";',
            'let x = concat!("Dom", "ain");',
        ]:
            with self.subTest(source=source):
                findings = findings_of(OTHER, source + "\n")
                self.assertEqual(len(findings), 1, findings)
                self.assertIn("cookie Domain attribute name", findings[0])

    def test_comparisons_with_domain_pass(self) -> None:
        source = (
            'assert!(!text.to_ascii_lowercase().contains("domain"));\n'
            'assert!(attribute.starts_with("domain"));\n'
            'assert!(attribute.ends_with("domain"));\n'
            'let found = text.find("domain");\n'
            'if name == "domain" || other != "Domain" {}\n'
            'let same = name.eq_ignore_ascii_case("domain");\n'
        )
        self.assertEqual(findings_of(OTHER, source), [])

    def test_domain_builder_calls_fail(self) -> None:
        for call in [
            'cookie.domain("x")',
            "c.set_domain(x)",
            "builder\n    . domain (x)",
            "builder\n    .\n    domain\n    (x)",
            "builder.set_domain\n(x)",
            "builder\n    // comment between\n    .domain(x)",
        ]:
            with self.subTest(call=call):
                findings = findings_of(OTHER, f"fn f() {{ {call}; }}\n")
                self.assertEqual(len(findings), 1, findings)
                self.assertIn("calls a cookie domain(...) builder", findings[0])

    def test_harmless_mentions_pass(self) -> None:
        source = (
            "// Never a Domain= attribute; see SPEC 5.5.\n"
            "/// The cookie has no `Domain=`.\n"
            'let text = "the domain of the zone";\n'
            'let pointer = "/domain";\n'
            "let domain = zone.domain_name();\n"
            'let json = r#"{"domain": "x"}"#;\n'
        )
        self.assertEqual(findings_of(OTHER, source), [])


class SetCookieHeaderTest(unittest.TestCase):
    def test_set_cookie_only_in_the_cookie_module(self) -> None:
        source = 'use axum::http::header::SET_COOKIE;\nlet name = "Set-Cookie";\n'
        self.assertEqual(findings_of(APP, source), [])
        findings = findings_of(OTHER, source)
        self.assertEqual(
            findings,
            [
                f"{OTHER}:1: uses SET_COOKIE outside the cookie module ({APP})",
                f"{OTHER}:2: names the Set-Cookie header outside the cookie module ({APP})",
            ],
        )
        # A comment may talk about it.
        self.assertEqual(findings_of(OTHER, '// sets SET_COOKIE "set-cookie"\n'), [])

    def test_disguised_header_names_fail(self) -> None:
        for source in [
            'let n = "set-cookie";',
            'let n = "SET-COOKIE";',
            'let n = b"Set-Cookie";',
            'let n = r"Set-Cookie";',
            'let n = "\\x53et-\\x43ookie";',
            'let n = "set\\u{2d}cookie";',
            'let n = "set-\\\n    cookie";',
            'let n = HeaderName::from_static(concat!("set-", "cookie"));',
            'let n = concat!("Set", "-", "Cookie");',
            "let n = SET_COOKIE;",
            "use axum::http::header::{ACCEPT, SET_COOKIE};",
        ]:
            with self.subTest(source=source):
                findings = findings_of(OTHER, source + "\n")
                self.assertEqual(len(findings), 1, findings)
                self.assertRegex(findings[0], r"Set-Cookie|SET_COOKIE")
                self.assertEqual(findings_of(APP, source + "\n"), [])

    def test_rust_tests_may_read_the_header(self) -> None:
        source = 'reply.headers.get_all("set-cookie");\nuse axum::http::header::SET_COOKIE;\n'
        self.assertEqual(findings_of(TESTS, source), [])
        self.assertEqual(findings_of("crates/edge/tests/cookies.rs", source), [])
        # ... but not outside a tests directory, and the other rules stay on in tests.
        self.assertNotEqual(findings_of("crates/app/benches/cookies.rs", source), [])
        self.assertNotEqual(findings_of(TESTS, 'let c = "a=b; Domain=example.com";'), [])
        self.assertNotEqual(findings_of(TESTS, "let c = Cookie::new(a, b);"), [])


class CookieLibraryTest(unittest.TestCase):
    def test_cookie_jars_and_builders_fail(self) -> None:
        for source in [
            "use axum_extra::extract::cookie::CookieJar;",
            "fn f(jar: CookieJar) -> CookieJar { jar }",
            "fn f(jar: PrivateCookieJar) {}",
            "fn f(jar: SignedCookieJar) {}",
            'let c = Cookie::new("a", "b");',
            'let c = Cookie::build(("a", "b"));',
            'let c = Cookie::parse("a=b");',
            'let c = Cookie :: from("a");',
            "let b: CookieBuilder = x;",
            "use tower_cookies::Cookies;",
            "let layer = CookieManagerLayer::new();",
            "use cookie_store::CookieStore;",
        ]:
            with self.subTest(source=source):
                for relative in (APP, OTHER, CORE):
                    findings = findings_of(relative, source + "\n")
                    self.assertTrue(findings, relative)
                    self.assertIn("cookie library API", findings[0])

    def test_host_cookie_is_fine(self) -> None:
        source = (
            "use stuffcloud_core::cookie::{HostCookie, SameSite};\n"
            'const C: HostCookie = HostCookie::new("__Host-x", SameSite::Lax);\n'
            "let value = C.set(&token, None);\n"
        )
        self.assertEqual(findings_of(OTHER, source), [])

    def test_a_set_cookie_value_cannot_be_constructed_outside_core(self) -> None:
        source = 'let c = SetCookie(String::from("a=b"));\n'
        self.assertEqual(findings_of(CORE, source), [])
        for relative in (APP, OTHER, TESTS):
            findings = findings_of(relative, source)
            self.assertEqual(len(findings), 1, findings)
            self.assertIn("constructs a SetCookie", findings[0])
        # Naming the type is fine.
        self.assertEqual(findings_of(OTHER, "fn f(c: &SetCookie) {}\n"), [])


class ManifestTest(unittest.TestCase):
    def test_cookie_dependencies_fail(self) -> None:
        for text in [
            'cookie = "0.18"\n',
            'axum-extra = { version = "0.10", features = ["cookie"] }\n',
            "axum-extra.workspace = true\n",
            "[dependencies.tower-cookies]\nversion = \"0.11\"\n",
            "[dev-dependencies.cookie_store]\nversion = \"0.21\"\n",
            'tower-sessions = "0.14"\n',
            'actix-session = "0.10"\n',
        ]:
            with self.subTest(text=text):
                findings = check_cookies.check_manifest("crates/x/Cargo.toml", "[dependencies]\n" + text)
                self.assertEqual(len(findings), 1, findings)
                self.assertIn("cookie or session library", findings[0])

    def test_other_dependencies_pass(self) -> None:
        text = (
            '[dependencies]\naxum = "0.8"\nserde = { workspace = true }\n'
            'cookies-are-nice-but-not-this = "1"\n[package]\ndescription = "uses cookie"\n'
        )
        self.assertEqual(check_cookies.check_manifest("Cargo.toml", text), [])


class CaddyTest(unittest.TestCase):
    def test_domain_attributes_fail(self) -> None:
        for line in [
            'header Set-Cookie "a=b; Domain=example.com"',
            'header_down +Set-Cookie "a=b; domain=.example.com"',
            "cookie_domain example.com",
            "cookie domain example.com",
        ]:
            with self.subTest(line=line):
                findings = check_cookies.check_caddyfile("docker/caddy/Caddyfile.dev", f"app.example.com {{\n  {line}\n}}\n")
                self.assertTrue(any("Domain attribute" in finding for finding in findings), findings)

    def test_set_cookie_only_where_allowed(self) -> None:
        text = 'handle /x {\n  header Set-Cookie "a=b; Path=/"\n}\n'
        self.assertEqual(check_cookies.check_caddyfile("docker/caddy/Caddyfile.dev", text), [])
        findings = check_cookies.check_caddyfile("deploy/Caddyfile", text)
        self.assertEqual(len(findings), 1, findings)
        self.assertIn("names the Set-Cookie header in a Caddy file", findings[0])
        self.assertEqual(len(check_cookies.check_caddyfile("deploy/site.caddy", "header -set-cookie\n")), 1)

    def test_comments_are_ignored(self) -> None:
        text = "# header Set-Cookie with Domain=example.com\nfoo bar # Domain=x\n"
        self.assertEqual(check_cookies.check_caddyfile("deploy/Caddyfile", text), [])


class WebTest(unittest.TestCase):
    def test_cookie_access_fails(self) -> None:
        for source in [
            "document.cookie = 'a=b';",
            "const c = document . cookie;",
            "const c = document['cookie'];",
            'const c = document["cookie"];',
            "await cookieStore.set('a', 'b');",
            "window.cookieStore.get('a');",
            "import Cookies from 'js-cookie';",
            'import Cookies from "universal-cookie";',
            "const c = require('js-cookie');",
            "const c = await import('cookies-next');",
        ]:
            with self.subTest(source=source):
                findings = check_cookies.check_web("web/apps/web/src/a.ts", source + "\n")
                self.assertEqual(len(findings), 1, findings)
                self.assertIn("document.cookie", findings[0])

    def test_set_cookie_and_domain_strings_fail(self) -> None:
        findings = check_cookies.check_web("web/apps/web/src/a.ts", "const h = 'Set-Cookie';\n")
        self.assertEqual(len(findings), 1, findings)
        findings = check_cookies.check_web("web/apps/web/src/a.ts", "const h = 'a=b; Domain=example.com';\n")
        self.assertEqual(len(findings), 1, findings)
        self.assertIn("Domain attribute", findings[0])

    def test_comments_and_urls_are_fine(self) -> None:
        source = (
            "// never document.cookie here\n"
            "/* document.cookie = 'x'; Set-Cookie; Domain=x\n   cookieStore */\n"
            "<!-- document.cookie -->\n"
            "const url = 'https://example.com/path';\n"
            "const text = 'the cookie banner';\n"
        )
        self.assertEqual(check_cookies.check_web("web/apps/web/src/a.svelte", source), [])

    def test_the_allowlist_admits_a_file(self) -> None:
        source = "document.cookie = 'theme=dark';\n"
        relative = "web/apps/web/src/theme.ts"
        self.assertEqual(len(check_cookies.check_web(relative, source)), 1)
        with mock.patch.object(check_cookies, "WEB_COOKIE_ALLOWLIST", frozenset({relative})):
            self.assertEqual(check_cookies.check_web(relative, source), [])
            # A Domain attribute is never allowed.
            self.assertEqual(len(check_cookies.check_web(relative, "x = '; Domain=a';")), 1)
        self.assertEqual(check_cookies.WEB_COOKIE_ALLOWLIST, frozenset())


class RepositoryTest(unittest.TestCase):
    def test_the_repository_is_clean(self) -> None:
        root = Path(__file__).resolve().parents[2]
        self.assertTrue(check_cookies.sources(root), "no Rust sources found")
        self.assertEqual(check_cookies.check(root), [])
        self.assertEqual(check_cookies.main(["check_cookies.py", str(root)]), 0)

    def test_the_allowlists_name_files_that_exist(self) -> None:
        root = Path(__file__).resolve().parents[2]
        for relative in (
            check_cookies.COOKIE_MODULES
            | check_cookies.SET_COOKIE_BUILDERS
            | check_cookies.CADDY_SET_COOKIE_ALLOWLIST
        ):
            self.assertTrue((root / relative).is_file(), relative)

    def write(self, root: Path, relative: str, text: str) -> None:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_findings_fail_and_an_empty_tree_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(check_cookies.main(["check_cookies.py", str(root)]), 1)
            self.write(root, "crates/edge/src/lib.rs", 'const C: &str = "s=1; Domain=example.org";\n')
            self.assertEqual(
                check_cookies.check(root),
                ["crates/edge/src/lib.rs:1: a string sets a cookie Domain attribute"],
            )
            self.assertEqual(check_cookies.main(["check_cookies.py", str(root)]), 1)

    def test_every_place_is_scanned_and_build_output_is_not(self) -> None:
        bypass = 'const C: &str = "s=1; Domain=example.org";\n'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root, "crates/app/src/lib.rs", "pub fn ok() {}\n")
            for relative in (
                "crates/edge/tests/cookies.rs",
                "crates/edge/build.rs",
                "crates/edge/benches/b.rs",
                "crates/edge/examples/e.rs",
                "fuzz/fuzz_targets/t.rs",
                "tools/xtask/src/main.rs",
            ):
                self.write(root, relative, bypass)
            self.write(root, "crates/edge/Cargo.toml", "[dependencies]\ntower-cookies = \"0.11\"\n")
            self.write(root, "deploy/Caddyfile.prod", 'header Set-Cookie "a=b"\n')
            self.write(root, "deploy/site.caddy", "cookie_domain example.org\n")
            self.write(root, "web/apps/web/src/a.svelte", "<script>document.cookie = 'a=b';</script>\n")
            self.write(root, "web/packages/x/src/b.ts", "const n = cookieStore;\n")
            # Build output, dependencies and other languages are not scanned.
            self.write(root, "target/debug/build/x/out.rs", bypass)
            self.write(root, "web/node_modules/pkg/index.js", "document.cookie = 'a=b';\n")
            self.write(root, "web/packages/x/coverage/lcov-report/theme.js", "document.cookie = 'a=b';\n")
            self.write(root, "docs/notes.md", "Set-Cookie: a=b; Domain=example.org\n")
            self.write(root, "scripts/x.py", "H = 'Set-Cookie'\n")
            found = sorted(finding.split(":")[0] for finding in check_cookies.check(root))
            self.assertEqual(
                found,
                sorted(
                    [
                        "crates/edge/tests/cookies.rs",
                        "crates/edge/build.rs",
                        "crates/edge/benches/b.rs",
                        "crates/edge/examples/e.rs",
                        "fuzz/fuzz_targets/t.rs",
                        "tools/xtask/src/main.rs",
                        "crates/edge/Cargo.toml",
                        "deploy/Caddyfile.prod",
                        "deploy/site.caddy",
                        "web/apps/web/src/a.svelte",
                        "web/packages/x/src/b.ts",
                    ]
                ),
            )
            self.assertEqual(check_cookies.main(["check_cookies.py", str(root)]), 1)


if __name__ == "__main__":
    unittest.main()
