#!/usr/bin/env python3
"""Cookie scope gate (SPEC 5.5 and 14, ADR 0009 decision 8, A-02 #32).

The app may share a registrable domain with hosted sites, so no cookie of stuffcloud may carry
a `Domain` attribute: every cookie is a host-only `__Host-` cookie. This static check scans the
Rust sources of every crate (`crates/*/src/**/*.rs`, so `edge` is covered as soon as it exists)
and fails when

1. a string literal contains a `Domain=` cookie attribute (case-insensitive, at the start of the
   literal or after a `;`);
2. code calls a cookie builder's `domain(...)` / `set_domain(...)`;
3. a file other than the cookie modules listed in `COOKIE_MODULES` names the `Set-Cookie`
   header (the `SET_COOKIE` constant or a `"set-cookie"` literal), so every cookie goes through
   the one place that builds them.

Comments are ignored (the documentation explains the rule and mentions `Domain=`). The runtime
counterpart is the integration test `every_set_cookie_of_every_route_is_host_only` in
`crates/app/tests/integration/auth.rs`, which sends every route of the OpenAPI document and
checks every `Set-Cookie` it gets back.

Usage: python3 scripts/ci/check_cookies.py [repository root]
Exit code 0 when clean, 1 with one line per finding.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

# The files allowed to name the Set-Cookie header (relative to the repository root, with `/`).
COOKIE_MODULES = frozenset({"crates/app/src/auth.rs"})

DOMAIN_ATTRIBUTE = re.compile(r"(?:^|;)\s*domain\s*=", re.IGNORECASE)
DOMAIN_CALL = re.compile(r"\.\s*(?:set_)?domain\s*\(")
SET_COOKIE_IDENT = re.compile(r"\bSET_COOKIE\b")
SET_COOKIE_LITERAL = re.compile(r"set-cookie", re.IGNORECASE)


@dataclass(frozen=True)
class Literal:
    """A string literal: its line and its text (escapes are kept as written)."""

    line: int
    text: str


@dataclass(frozen=True)
class Scanned:
    """A Rust file split into code (literals and comments blanked) and its string literals."""

    code: str
    literals: tuple[Literal, ...]


def _raw_string(source: str, r_index: int) -> tuple[int, int, int] | None:
    """A raw string whose `r` is at `r_index`: (index after it, start of body, end of body)."""
    index = r_index + 1
    hashes = 0
    while index < len(source) and source[index] == "#":
        hashes += 1
        index += 1
    if index >= len(source) or source[index] != '"':
        return None
    body = index + 1
    closing = '"' + "#" * hashes
    body_end = source.find(closing, body)
    if body_end < 0:
        return len(source), body, len(source)
    return body_end + len(closing), body, body_end


def _ident_before(source: str, index: int) -> bool:
    """Whether the character before `index` belongs to an identifier."""
    return index > 0 and (source[index - 1].isalnum() or source[index - 1] == "_")


def scan(source: str) -> Scanned:
    """Splits Rust source into code without comments and literals, and the string literals.

    Handles line and (nested) block comments, plain, byte and raw strings, character
    literals and lifetimes. Blanked parts keep their line breaks, so line numbers stay right.
    """
    code: list[str] = []
    literals: list[Literal] = []
    index = 0
    length = len(source)

    def blank(text: str) -> str:
        return "".join("\n" if char == "\n" else " " for char in text)

    while index < length:
        char = source[index]
        pair = source[index : index + 2]
        if pair == "//":
            end = source.find("\n", index)
            end = length if end < 0 else end
            code.append(blank(source[index:end]))
            index = end
        elif pair == "/*":
            depth = 0
            end = index
            while end < length:
                if source.startswith("/*", end):
                    depth += 1
                    end += 2
                elif source.startswith("*/", end):
                    depth -= 1
                    end += 2
                    if depth == 0:
                        break
                else:
                    end += 1
            code.append(blank(source[index:end]))
            index = end
        elif char in "rb" and not _ident_before(source, index):
            r_index = index + 1 if source.startswith("br", index) else index
            raw = _raw_string(source, r_index) if source[r_index] == "r" else None
            if raw is not None:
                end, body, body_end = raw
                literals.append(Literal(source.count("\n", 0, index) + 1, source[body:body_end]))
                code.append(blank(source[index:end]))
                index = end
            elif char == "b" and source[index + 1 : index + 2] in {'"', "'"}:
                # A byte string or byte character: the next branch reads it.
                code.append(" ")
                index += 1
            else:
                code.append(char)
                index += 1
        elif char == '"':
            end = index + 1
            while end < length and source[end] != '"':
                end += 2 if source[end] == "\\" else 1
            end = min(end + 1, length)
            literals.append(Literal(source.count("\n", 0, index) + 1, source[index + 1 : end - 1]))
            code.append(blank(source[index:end]))
            index = end
        elif char == "'":
            # A character literal ('x', '\n', '\u{1F600}') or a lifetime ('a).
            if index + 1 < length and source[index + 1] == "\\":
                end = source.find("'", index + 2)
                end = length if end < 0 else end + 1
                code.append(blank(source[index:end]))
                index = end
            elif index + 2 < length and source[index + 2] == "'":
                code.append(blank(source[index : index + 3]))
                index += 3
            else:
                code.append(char)
                index += 1
        else:
            code.append(char)
            index += 1
    return Scanned("".join(code), tuple(literals))


def check_file(relative: str, source: str) -> list[str]:
    """The findings for one file (`relative` uses `/`)."""
    findings: list[str] = []
    scanned = scan(source)
    for literal in scanned.literals:
        if DOMAIN_ATTRIBUTE.search(literal.text):
            findings.append(f"{relative}:{literal.line}: a string sets a cookie Domain attribute")
        if relative not in COOKIE_MODULES and SET_COOKIE_LITERAL.search(literal.text):
            findings.append(
                f"{relative}:{literal.line}: names the Set-Cookie header outside the cookie module "
                f"({', '.join(sorted(COOKIE_MODULES))})"
            )
    for number, line in enumerate(scanned.code.split("\n"), start=1):
        if DOMAIN_CALL.search(line):
            findings.append(f"{relative}:{number}: calls a cookie domain(...) builder")
        if relative not in COOKIE_MODULES and SET_COOKIE_IDENT.search(line):
            findings.append(
                f"{relative}:{number}: uses SET_COOKIE outside the cookie module "
                f"({', '.join(sorted(COOKIE_MODULES))})"
            )
    return findings


def sources(root: Path) -> list[Path]:
    """Every Rust source file of every crate, sorted."""
    return sorted(root.glob("crates/*/src/**/*.rs"))


def check(root: Path) -> list[str]:
    """Every finding in the repository at `root`."""
    findings: list[str] = []
    for path in sources(root):
        relative = path.relative_to(root).as_posix()
        findings.extend(check_file(relative, path.read_text(encoding="utf-8")))
    return findings


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parents[2]
    files = sources(root)
    if not files:
        print(f"check_cookies: no Rust sources under {root}/crates", file=sys.stderr)
        return 1
    findings = check(root)
    for finding in findings:
        print(finding)
    if findings:
        print(f"check_cookies: {len(findings)} finding(s); every cookie must be a host-only __Host- cookie")
        return 1
    print(f"check_cookies: {len(files)} files clean (no Domain attribute, Set-Cookie only in the cookie module)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
