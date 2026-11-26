"""Tests of check_crypto.py (the crypto misuse gate for product code, #148).

Every pattern has a fixture that must fail the gate, and one that shows where it does not look.
"""

from __future__ import annotations

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_crypto  # noqa: E402

PRODUCT = "crates/app/src/sessions.rs"
PASSWORD = "crates/app/src/password.rs"
REPOSITORY = Path(__file__).resolve().parents[2]

# One fixture per pattern; each must be a finding in product code.
FAILING = {
    "salted-hash": 'fn f() { argon2.hash_password_with_salt(p, b"fixed salt 16 b"); }',
    "literal-key": "fn f() -> Token { Token::from_bytes([7; 32]) }",
    "literal-key ": 'fn f() { let s = SaltString::from_b64("c2FsdHNhbHQ"); }',
    "literal-key  ": "fn f() { let s = Salt::from(x); }",
    "sha2": "fn f() { let d = Sha256::digest(password.as_bytes()); }",
    "sha2 ": "fn f() { let h = sha2::Sha512::new(); }",
    "sha2  ": "fn f() { let h = Sha384 :: default(); }",
    "weak-hash": "fn f() { let d = md5::compute(data); }",
    "weak-hash ": "fn f() { let h = <Sha1 as Digest>::new(); }",
    "weak-hash  ": "fn f() { let h = Md5::new(); }",
}


class PatternTest(unittest.TestCase):
    def test_every_pattern_fails_in_product_code(self) -> None:
        for label, source in FAILING.items():
            name = label.strip()
            with self.subTest(label):
                findings = check_crypto.check_file(PRODUCT, source)
                self.assertEqual(len(findings), 1, findings)
                self.assertIn(f"{PRODUCT}:1: {name} in product code", findings[0])

    def test_a_finding_names_its_line(self) -> None:
        source = "fn a() {}\n\nfn b() { Sha256::digest(x); Sha256::new(); }\n"
        self.assertEqual(
            [finding.split(" ")[0] for finding in check_crypto.check_file(PRODUCT, source)],
            [f"{PRODUCT}:3:", f"{PRODUCT}:3:"],
        )

    def test_comments_strings_and_lookalikes_are_ignored(self) -> None:
        source = (
            "// Sha256::digest(x) and hash_password_with_salt( in a comment\n"
            "/* md5:: from_bytes([1]) */\n"
            'fn f() { let s = "Sha256::new() md5::compute"; let t = r#"Sha1"#; }\n'
            "fn g() { my_hash_password_with_salt_x(); Sha256Digest::new(); from_bytes(buffer); }\n"
            "fn h() { let sha1_like = 1; let md5sum = 2; }\n"
        )
        self.assertEqual(check_crypto.check_file(PRODUCT, source), [])

    def test_test_code_is_not_scanned(self) -> None:
        bad = FAILING["sha2"]
        for relative in (
            "crates/app/tests/integration/accounts.rs",
            "crates/core/tests/regression.rs",
            "crates/app/benches/hash.rs",
            "crates/app/examples/demo.rs",
            "fuzz/fuzz_targets/account.rs",
            "crates/db/src/accounts_tests.rs",
        ):
            with self.subTest(relative):
                self.assertEqual(check_crypto.check_file(relative, bad), [])
        # The same file name outside a test location is product code.
        self.assertEqual(len(check_crypto.check_file("crates/app/src/tests_helper.rs", bad)), 1)

    def test_items_behind_cfg_test_are_not_scanned(self) -> None:
        source = (
            "fn product() {}\n"
            "#[cfg(test)]\n"
            "mod tests {\n"
            "    fn inner() { if x { Sha256::digest(b) } else { Token::from_bytes([1; 32]) } }\n"
            "}\n"
            "#[cfg(test)]\n"
            '#[path = "x_tests.rs"]\n'
            "mod more;\n"
            "#[cfg(test)]\n"
            '#[expect(clippy::unwrap_used, reason = "[test]")]\n'
            "fn helper() { md5::compute(x); }\n"
            "# [ cfg ( test ) ]\n"
            "impl Thing { fn f() { Sha512::new(); } }\n"
            "fn after() { Sha256::new(); }\n"
        )
        findings = check_crypto.check_file(PRODUCT, source)
        self.assertEqual(len(findings), 1, findings)
        self.assertTrue(findings[0].startswith(f"{PRODUCT}:14: sha2"), findings)

    def test_an_unterminated_test_item_blanks_to_the_end(self) -> None:
        self.assertEqual(check_crypto.check_file(PRODUCT, "#[cfg(test)]\nmod t { Sha256::new();"), [])
        self.assertEqual(check_crypto.check_file(PRODUCT, "#[cfg(test)]\n#[path"), [])
        self.assertEqual(check_crypto.without_test_items("#[cfg(test)]"), " " * 12)


class AllowlistTest(unittest.TestCase):
    def test_every_entry_has_a_reason_and_a_count(self) -> None:
        for (file, name), allowed in check_crypto.ALLOWLIST.items():
            with self.subTest(file):
                self.assertIn(name, check_crypto.PATTERNS)
                self.assertNotEqual(name, "weak-hash")
                self.assertGreaterEqual(allowed.count, 1)
                self.assertGreater(len(allowed.reason), 20)

    def test_a_listed_site_passes_with_its_count_only(self) -> None:
        one = "fn list_key() { Sha256::digest(x) }\n"
        self.assertEqual(check_crypto.check_file(PASSWORD, one), [])
        two = one + "fn store(p: &str) { Sha256::digest(p) }\n"
        findings = check_crypto.check_file(PASSWORD, two)
        self.assertEqual(len(findings), 1)
        self.assertIn("sha2 has 2 hit(s), ALLOWLIST expects 1", findings[0])
        # The allowance is per pattern: another pattern in the same file is a finding.
        literal = one + "fn k() -> Token { Token::from_bytes([1; 32]) }\n"
        self.assertEqual(len(check_crypto.check_file(PASSWORD, literal)), 1)

    def test_weak_hashes_are_never_allowed(self) -> None:
        listed = {(PASSWORD, "weak-hash"): check_crypto.Allowed(1, "a reason that is long enough")}
        with mock.patch.dict(check_crypto.ALLOWLIST, listed):
            self.assertEqual(len(check_crypto.check_file(PASSWORD, FAILING["weak-hash"])), 1)


class ManifestTest(unittest.TestCase):
    def test_weak_hash_dependencies_fail(self) -> None:
        for manifest in (
            '[dependencies]\nmd5 = "0.7"\n',
            '[dependencies]\nmd-5 = { version = "0.10" }\n',
            '[dev-dependencies]\nsha1 = "0.10"\n',
            "[dependencies]\nsha-1.workspace = true\n",
            '[workspace.dependencies]\nsha1_smol = "1"\n',
            '[dependencies.md4]\nversion = "0.10"\n',
            '[target.\'cfg(unix)\'.dependencies.sha1]\nversion = "0.10"\n',
        ):
            with self.subTest(manifest):
                findings = check_crypto.check_manifest("crates/x/Cargo.toml", manifest)
                self.assertEqual(len(findings), 1, findings)
                self.assertIn("weak-hash dependency", findings[0])

    def test_other_dependencies_pass(self) -> None:
        manifest = '[dependencies]\nsha2 = "0.11"\nmd5-lookalike-free = "1"\nargon2.workspace = true\n'
        self.assertEqual(check_crypto.check_manifest("Cargo.toml", manifest), [])


class RepositoryTest(unittest.TestCase):
    def write(self, root: Path, relative: str, text: str) -> None:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_the_repository_is_clean(self) -> None:
        self.assertEqual(check_crypto.check(REPOSITORY), [])

    def test_a_stale_entry_and_new_hits_are_reported(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.write(root, PASSWORD, "fn list_key() { Sha256::digest(x) }\n")
            self.write(root, PRODUCT, FAILING["literal-key"])
            self.write(root, "target/debug/build.rs", FAILING["sha2"])
            self.write(root, "crates/x/Cargo.toml", '[dependencies]\nmd5 = "0.7"\n')
            listed = {
                (PASSWORD, "sha2"): check_crypto.Allowed(1, "the breached-list lookup key"),
                ("crates/gone.rs", "sha2"): check_crypto.Allowed(1, "a site that was removed"),
            }
            with mock.patch.dict(check_crypto.ALLOWLIST, listed, clear=True):
                findings = check_crypto.check(root)
                with redirect_stdout(io.StringIO()) as out:
                    self.assertEqual(check_crypto.main(["check_crypto.py", str(root)]), 1)
        self.assertEqual(len(findings), 3, findings)
        self.assertTrue(findings[0].startswith(f"{PRODUCT}:1: literal-key"), findings)
        self.assertTrue(findings[1].startswith("crates/x/Cargo.toml:2: weak-hash"), findings)
        self.assertTrue(findings[2].startswith("crates/gone.rs: ALLOWLIST lists sha2"), findings)
        self.assertIn("check_crypto: 3 finding(s)", out.getvalue())

    def test_main_passes_on_a_clean_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.write(root, PRODUCT, "fn f() {}\n")
            with mock.patch.dict(check_crypto.ALLOWLIST, {}, clear=True):
                with redirect_stdout(io.StringIO()) as out:
                    self.assertEqual(check_crypto.main(["check_crypto.py", str(root)]), 0)
        self.assertIn("product code clean (0 reviewed call sites)", out.getvalue())


class BracketTest(unittest.TestCase):
    def test_matching_returns_the_index_after_the_closing_bracket(self) -> None:
        self.assertEqual(check_crypto._matching("a{b}c", 1, "{", "}"), 4)
        self.assertEqual(check_crypto._matching("{a{b}c}d", 0, "{", "}"), 7)
        self.assertEqual(check_crypto._matching("#[x]", 1, "[", "]"), 4)

    def test_matching_starts_at_the_given_bracket(self) -> None:
        # The pair before the start index is not the one asked for.
        self.assertEqual(check_crypto._matching("{}{x}", 2, "{", "}"), 5)

    def test_matching_without_a_closing_bracket_returns_the_end(self) -> None:
        self.assertEqual(check_crypto._matching("a{b", 1, "{", "}"), 3)

    def test_a_cfg_test_module_declared_in_another_file_ends_at_the_semicolon(self) -> None:
        source = "#[cfg(test)]\nmod more;\nfn after() { Sha256::new(); }\n"
        findings = check_crypto.check_file(PRODUCT, source)
        self.assertEqual(len(findings), 1, findings)
        self.assertTrue(findings[0].startswith(f"{PRODUCT}:3: sha2"), findings)

    def test_attributes_after_cfg_test_are_skipped_up_to_their_own_bracket(self) -> None:
        source = '#[cfg(test)]\n#[path = "a]b"]\nmod more;\nfn after() { Sha256::new(); }\n'
        # The `]` inside the string would end the attribute early if the scan started elsewhere;
        # either way the module line is test code and `after` is product code.
        findings = check_crypto.check_file(PRODUCT, source)
        self.assertEqual(len(findings), 1, findings)
        self.assertTrue(findings[0].startswith(f"{PRODUCT}:4: sha2"), findings)


class LineNumberTest(unittest.TestCase):
    def test_a_hit_after_a_leading_blank_line_is_on_line_two(self) -> None:
        self.assertEqual(check_crypto.hits("\nfn f() { Sha256::new(); }"), {"sha2": [2]})

    def test_every_hit_has_its_own_line(self) -> None:
        source = "fn a() { Sha256::new(); }\n\nfn b() { Md5::new(); }\nfn c() { Sha512::new(); }\n"
        self.assertEqual(check_crypto.hits(source), {"sha2": [1, 4], "weak-hash": [3]})

    def test_manifest_lines_are_counted_from_the_first_character(self) -> None:
        self.assertEqual(
            check_crypto.check_manifest("c/Cargo.toml", '\nmd5 = "1"\n\n[dev-dependencies]\nsha1 = "1"\n'),
            [
                "c/Cargo.toml:2: weak-hash dependency (MD5, MD4 or SHA-1)",
                "c/Cargo.toml:5: weak-hash dependency (MD5, MD4 or SHA-1)",
            ],
        )

    def test_a_manifest_table_is_reported_on_its_header_line(self) -> None:
        self.assertEqual(
            check_crypto.check_manifest("c/Cargo.toml", '\n\n[dependencies.md4]\nversion = "1"\n[dependencies]\nsha1 = "1"\n'),
            [
                "c/Cargo.toml:3: weak-hash dependency (MD5, MD4 or SHA-1)",
                "c/Cargo.toml:6: weak-hash dependency (MD5, MD4 or SHA-1)",
            ],
        )


class MessageTest(unittest.TestCase):
    def test_an_unlisted_hit_is_reported_with_the_fix(self) -> None:
        self.assertEqual(
            check_crypto.check_file(PRODUCT, "\n" + FAILING["sha2"]),
            [
                f"{PRODUCT}:2: sha2 in product code; review it and list the call site in "
                "ALLOWLIST of scripts/ci/check_crypto.py with its reason"
            ],
        )

    def test_a_wrong_count_names_the_first_hit_and_both_counts(self) -> None:
        source = "fn a() { Sha256::new(); }\nfn b() {}\nfn c() { Sha256::digest(x); }\n"
        self.assertEqual(
            check_crypto.check_file(PASSWORD, source),
            [
                f"{PASSWORD}:1: sha2 has 2 hit(s), ALLOWLIST expects 1 "
                f"({check_crypto.ALLOWLIST[(PASSWORD, 'sha2')].reason}); "
                "review the new one and update the entry"
            ],
        )

    def test_a_stale_entry_is_reported_with_its_reason(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            listed = {("crates/gone.rs", "sha2"): check_crypto.Allowed(1, "a site that was removed")}
            with mock.patch.dict(check_crypto.ALLOWLIST, listed, clear=True):
                findings = check_crypto.check(root)
        self.assertEqual(
            findings,
            [
                "crates/gone.rs: ALLOWLIST lists sha2 (a site that was removed), but the file has no such "
                "hit any more; remove the entry"
            ],
        )

    def test_main_prints_every_finding_and_the_count(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / PRODUCT
            path.parent.mkdir(parents=True)
            path.write_text("fn f() { Md5::new(); }\n", encoding="utf-8")
            with mock.patch.dict(check_crypto.ALLOWLIST, {}, clear=True):
                with redirect_stdout(io.StringIO()) as out:
                    code = check_crypto.main(["check_crypto.py", str(root)])
        self.assertEqual(code, 1)
        self.assertEqual(
            out.getvalue(),
            f"{PRODUCT}:1: weak-hash in product code; review it and list the call site in "
            "ALLOWLIST of scripts/ci/check_crypto.py with its reason\n"
            "check_crypto: 1 finding(s)\n",
        )


class RootTest(unittest.TestCase):
    def run_main(self, argv: list[str]) -> list[Path]:
        roots: list[Path] = []

        def fake_check(root: Path) -> list[str]:
            roots.append(root)
            return []

        with mock.patch.object(check_crypto, "check", fake_check), redirect_stdout(io.StringIO()):
            self.assertEqual(check_crypto.main(argv), 0)
        return roots

    def test_without_an_argument_the_repository_is_checked(self) -> None:
        self.assertEqual(self.run_main(["check_crypto.py"]), [REPOSITORY])

    def test_an_argument_names_the_root(self) -> None:
        self.assertEqual(self.run_main(["check_crypto.py", "somewhere"]), [Path("somewhere")])


class EncodingTest(unittest.TestCase):
    def test_sources_and_manifests_are_read_as_utf8(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for relative, text in ((PRODUCT, "fn f() {}\n"), ("crates/app/Cargo.toml", "[package]\n")):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")
            real = Path.read_text
            seen: list[object] = []

            def spy(path: Path, *args: object, **kwargs: object) -> str:
                seen.append(kwargs.get("encoding"))
                return real(path, *args, **kwargs)

            with mock.patch.object(Path, "read_text", spy), mock.patch.dict(check_crypto.ALLOWLIST, {}, clear=True):
                self.assertEqual(check_crypto.check(root), [])
        self.assertEqual(seen, ["utf-8", "utf-8"])


if __name__ == "__main__":
    unittest.main()
