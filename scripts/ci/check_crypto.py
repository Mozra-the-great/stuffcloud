#!/usr/bin/env python3
"""Crypto misuse gate for product code (#148).

CodeQL's `rust/hard-coded-cryptographic-value` and `rust/weak-sensitive-data-hashing` are
excluded for the whole repository (`.github/codeql/codeql-config.yml`, A-03 SF14 a): every hit
was test data or a legitimate SHA-256, and CodeQL cannot scope a filter to paths. This check
compensates: in product code (Rust outside tests) each of the patterns below may appear only at
the call sites listed in `ALLOWLIST`, each with its reason and the exact number of hits. A new
hit, in a new file or one more in a listed file, fails the build until it is reviewed and listed;
a listed site that went away fails too, so the list stays exact.

Patterns (searched in code only: comments and string literals are blanked first, with the
Rust scanner of `check_cookies.py`):

* `salted-hash`: `hash_password_with_salt(...)`: a password hash with a salt the caller chose.
  The only legitimate salt is a fresh random one per hash.
* `literal-key`: `from_bytes([...])`, `SaltString::from_b64(...)`, `Salt::from(...)`: a key,
  token or salt built from bytes written into the source.
* `sha2`: `Sha224`/`Sha256`/`Sha384`/`Sha512` hashing (`::digest`, `::new`, `::default`,
  `::new_with_prefix`): fine for keys, checksums and lookups, never for passwords.
* `weak-hash`: MD5, MD4 or SHA-1 in code (`md5::`, `Md5`, `sha1::`, `Sha1`, ...) and as a
  dependency in any `Cargo.toml` (`md5`, `md-5`, `md4`, `sha1`, `sha-1`, `sha1_smol`): never
  allowed, there is no allowlist for it.

Not product code, and not scanned: `crates/*/tests/`, `benches/`, `examples/`, `fuzz/`, files
named `*_tests.rs` (unit test modules included with `#[path]`), and every item behind
`#[cfg(test)]` (a module, a function, an `impl`).

Usage: python3 scripts/ci/check_crypto.py [repository root]
Exit code 0 when clean, 1 with one line per finding.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_cookies import scan, walk  # noqa: E402


@dataclass(frozen=True)
class Allowed:
    """A reviewed call site: how many hits the file has and why they are fine."""

    count: int
    reason: str


PATTERNS: dict[str, re.Pattern[str]] = {
    "salted-hash": re.compile(r"\bhash_password_with_salt\s*\("),
    "literal-key": re.compile(
        r"\bfrom_bytes\s*\(\s*\[|\bSaltString\s*::\s*from_b64\s*\(|\bSalt\s*::\s*from\s*\("
    ),
    "sha2": re.compile(r"\bSha(?:224|256|384|512)\s*::\s*(?:digest|new|default|new_with_prefix)\b"),
    "weak-hash": re.compile(
        r"\b(?:md5|md_5|md4|sha1|sha_1|sha1_smol)\s*::|\b(?:Md5|Md4|Sha1|Sha1Core|Md5Core)\b"
    ),
}

# (file, pattern) -> the hits it may have, with the reason. Keep it exact.
ALLOWLIST: dict[tuple[str, str], Allowed] = {
    ("crates/app/src/password.rs", "salted-hash"): Allowed(
        1, "hash_blocking: the salt is 16 fresh bytes from getrandom::fill for every hash"
    ),
    ("crates/app/src/password.rs", "sha2"): Allowed(
        1,
        "list_key: the lookup key into the operator's public offline breached-password list "
        "(the password itself is stored only as Argon2id)",
    ),
    ("crates/app/src/throttle.rs", "sha2"): Allowed(
        1, "account_key: in-memory throttle key of the typed login name, so no name is held"
    ),
    ("crates/db/src/auth.rs", "sha2"): Allowed(
        1,
        "token_hash: session, CSRF, invitation and reset tokens are 256 random bits, stored as "
        "SHA-256 (no salt or stretching needed at that entropy)",
    ),
    ("crates/db/src/store.rs", "sha2"): Allowed(
        1, "etag_for: the strong entity tag of a resource, a content hash and not a secret"
    ),
    ("crates/db/src/migrate.rs", "sha2"): Allowed(
        1, "migration checksums: detect an edited migration file"
    ),
}

WEAK_DEPENDENCIES = re.compile(
    r"^\s*(?:md5|md-5|md4|sha1|sha-1|sha1_smol)\s*(?:=|\.)", re.IGNORECASE | re.MULTILINE
)
WEAK_DEPENDENCY_TABLE = re.compile(
    r"^\s*\[[^\]]*dependencies\.(?:md5|md-5|md4|sha1|sha-1|sha1_smol)\s*\]", re.IGNORECASE | re.MULTILINE
)

NOT_PRODUCT = re.compile(r"^(?:crates/[^/]+/(?:tests|benches|examples)/|fuzz/)|_tests\.rs$")
CFG_TEST = re.compile(r"#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]")
ATTRIBUTE = re.compile(r"\s*#\s*!?\s*\[")


def _matching(code: str, open_index: int, opening: str, closing: str) -> int:
    """The index after the bracket that closes the one at `open_index` (the end when none)."""
    depth = 0
    for index in range(open_index, len(code)):
        if code[index] == opening:
            depth += 1
        elif code[index] == closing:
            depth -= 1
            if depth == 0:
                return index + 1
    return len(code)


def without_test_items(code: str) -> str:
    """`code` with every item behind `#[cfg(test)]` blanked (lengths and lines kept)."""
    out = list(code)
    position = 0
    while match := CFG_TEST.search(code, position):
        index = match.end()
        # Further attributes of the same item (`#[path = "..."]`, `#[expect(...)]`).
        while attribute := ATTRIBUTE.match(code, index):
            index = _matching(code, attribute.end() - 1, "[", "]")
        body = re.compile(r"[{;]").search(code, index)
        end = len(code) if body is None else (
            body.end() if body.group() == ";" else _matching(code, body.start(), "{", "}")
        )
        for blanked in range(match.start(), end):
            if out[blanked] != "\n":
                out[blanked] = " "
        position = end
    return "".join(out)


def hits(source: str) -> dict[str, list[int]]:
    """The lines of every pattern's hits in the product code of a Rust file."""
    code = without_test_items(scan(source).code)
    found: dict[str, list[int]] = {}
    for name, pattern in PATTERNS.items():
        lines = [code.count("\n", 0, match.start()) + 1 for match in pattern.finditer(code)]
        if lines:
            found[name] = lines
    return found


def check_file(relative: str, source: str) -> list[str]:
    """The findings of one Rust file (nothing for test code)."""
    if NOT_PRODUCT.search(relative):
        return []
    findings: list[str] = []
    for name, lines in hits(source).items():
        allowed = ALLOWLIST.get((relative, name))
        if allowed is None or name == "weak-hash":
            findings.extend(
                f"{relative}:{line}: {name} in product code; review it and list the call site in "
                "ALLOWLIST of scripts/ci/check_crypto.py with its reason"
                for line in lines
            )
        elif len(lines) != allowed.count:
            findings.append(
                f"{relative}:{lines[0]}: {name} has {len(lines)} hit(s), ALLOWLIST expects "
                f"{allowed.count} ({allowed.reason}); review the new one and update the entry"
            )
    return findings


def check_manifest(relative: str, text: str) -> list[str]:
    """A weak hash crate as a dependency of any manifest."""
    lines = [
        text.count("\n", 0, match.start()) + 1
        for pattern in (WEAK_DEPENDENCIES, WEAK_DEPENDENCY_TABLE)
        for match in pattern.finditer(text)
    ]
    return [f"{relative}:{line}: weak-hash dependency (MD5, MD4 or SHA-1)" for line in sorted(lines)]


def check(root: Path) -> list[str]:
    """Every finding in the repository at `root`, and every allowlist entry that went stale."""
    findings: list[str] = []
    seen: set[tuple[str, str]] = set()
    for path in walk(root):
        relative = path.relative_to(root).as_posix()
        if path.suffix == ".rs":
            source = path.read_text(encoding="utf-8")
            findings.extend(check_file(relative, source))
            if not NOT_PRODUCT.search(relative):
                seen.update((relative, name) for name in hits(source))
        elif path.name == "Cargo.toml":
            findings.extend(check_manifest(relative, path.read_text(encoding="utf-8")))
    findings.extend(
        f"{file}: ALLOWLIST lists {name} ({allowed.reason}), but the file has no such hit any "
        "more; remove the entry"
        for (file, name), allowed in sorted(ALLOWLIST.items())
        if (file, name) not in seen
    )
    return findings


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parents[2]
    findings = check(root)
    for finding in findings:
        print(finding)
    if findings:
        print(f"check_crypto: {len(findings)} finding(s)")
        return 1
    print(f"check_crypto: product code clean ({len(ALLOWLIST)} reviewed call sites)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
