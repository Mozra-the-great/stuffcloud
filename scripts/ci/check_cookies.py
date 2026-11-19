#!/usr/bin/env python3
"""Cookie scope gate (SPEC 5.5 and 14, ADR 0009 decision 8, A-02 #32, hardened in #136).

The app may share a registrable domain with hosted sites, so no cookie of stuffcloud may carry
a `Domain` attribute: every cookie is a host-only `__Host-` cookie. This static check is
defense in depth, not a boundary (the boundary is the `SetCookie` type of
`stuffcloud_core::cookie`, which only `HostCookie::set` and `HostCookie::clear` can build, plus
the runtime test of every route); it makes a careless or sneaky bypass fail the build.

It scans, for every directory of the repository except build output and dependencies:

* every Rust file (all crates, `src/`, `tests/`, `benches/`, `examples/`, `build.rs`, the fuzz
  targets, crates that do not exist yet). It fails when
  1. a string literal contains a `Domain=` attribute (also after `\\x44` escapes, inside
     `concat!(...)`, in raw and byte strings);
  2. a literal is exactly `Domain` / `Domain=`, which is how a `format!("{}={}", "Domain", ..)`
     builds the attribute (a comparison such as `.contains("domain")` is fine);
  3. code calls a cookie builder's `domain(...)` / `set_domain(...)`, also when the call is
     split over several lines;
  4. code uses a cookie library API: `CookieJar` (also private and signed), `CookieBuilder`,
     `Cookie::new/build/parse/...`, `tower_cookies`, `axum_extra`, `cookie_store`, or builds a
     `SetCookie(...)` outside `crates/core/src/cookie.rs`;
  5. a file other than the cookie module names the `Set-Cookie` header (the `SET_COOKIE`
     constant, a `"set-cookie"` literal in any spelling, `concat!("set-", "cookie")`). Test
     files under `crates/*/tests/` may name it, they only read responses.
* every `Cargo.toml`: a dependency on a cookie or session library (`cookie`, `axum-extra`,
  `tower-cookies`, `cookie_store`, `tower-sessions`, ...) fails, so a new way to set cookies is
  reviewed and this check extended first.
* every `Caddyfile*` and `*.caddy`: a `Domain=` attribute or `cookie_domain` fails, and so does
  `Set-Cookie` outside `CADDY_SET_COOKIE_ALLOWLIST`.
* every script, component and page under `web/` (`.ts`, `.js`, `.svelte`, `.html`, ...):
  `document.cookie`, `cookieStore`, cookie libraries, a `Set-Cookie` string or a `Domain=`
  attribute fail outside `WEB_COOKIE_ALLOWLIST` (empty: the SPA never touches cookies, the
  server sets them `HttpOnly`).

Comments are ignored (the documentation explains the rule and mentions `Domain=`). The runtime
counterpart is the integration test `every_set_cookie_of_every_route_is_host_only` in
`crates/app/tests/integration/auth.rs`, which sends every route of the OpenAPI document and the
fallback, probe and metrics paths and checks every `Set-Cookie` it gets back.

Usage: python3 scripts/ci/check_cookies.py [repository root]
Exit code 0 when clean, 1 with one line per finding.
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# The files allowed to name the Set-Cookie header (relative to the repository root, with `/`).
COOKIE_MODULES = frozenset({"crates/app/src/auth.rs"})
# The only file that may construct a `SetCookie` (the type that cannot hold a Domain attribute).
SET_COOKIE_BUILDERS = frozenset({"crates/core/src/cookie.rs"})
# Rust test files read `Set-Cookie` from responses; they may name the header.
RUST_TESTS = re.compile(r"^crates/[^/]+/tests/")
# Caddy files that may set a cookie (a dev-only host-only probe, no Domain attribute).
CADDY_SET_COOKIE_ALLOWLIST = frozenset({"docker/caddy/Caddyfile.dev"})
# Files under web/ that may use document.cookie or the Cookie Store API (none).
WEB_COOKIE_ALLOWLIST: frozenset[str] = frozenset()

# Directories that hold build output, caches or third-party code.
SKIPPED_DIRECTORIES = frozenset(
    {
        ".git",
        "target",
        "node_modules",
        "coverage",
        "dist",
        "build",
        ".svelte-kit",
        ".vite",
        ".pnpm-store",
        "corpus",
        "artifacts",
        "playwright-report",
        "test-results",
        "__pycache__",
    }
)
WEB_EXTENSIONS = frozenset({".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".html"})

DOMAIN_ATTRIBUTE = re.compile(r"(?:^|;)\s*domain\s*=", re.IGNORECASE)
DOMAIN_WORD = re.compile(r"^\s*domain\s*=?\s*$", re.IGNORECASE)
DOMAIN_CALL = re.compile(r"\.\s*(?:set_)?domain\s*\(")
SET_COOKIE_IDENT = re.compile(r"\bSET_COOKIE\b")
SET_COOKIE_LITERAL = re.compile(r"set-cookie", re.IGNORECASE)
COOKIE_API = re.compile(
    r"\b(?:Private|Signed)?CookieJar\b"
    r"|\bCookieBuilder\b"
    r"|\bCookieManager(?:Layer)?\b"
    r"|\bCookie\s*::\s*\w+"
    r"|\b(?:tower_cookies|axum_extra|cookie_store)\b"
)
SET_COOKIE_CONSTRUCTION = re.compile(r"\bSetCookie\s*\(")
CONCAT = re.compile(r"\bconcat\s*!\s*\(")
# A literal that is only compared or searched, never written into a header.
READ_CONTEXT = re.compile(
    r"(?:\b(?:contains|starts_with|ends_with|find|strip_prefix|eq_ignore_ascii_case)\s*\(|[=!]=)$"
)

COOKIE_DEPENDENCIES = (
    "cookie",
    "cookie_store",
    "cookie-store",
    "axum-extra",
    "axum_extra",
    "tower-cookies",
    "tower_cookies",
    "tower-sessions",
    "tower_sessions",
    "axum-login",
    "axum_login",
    "axum-session",
    "axum_session",
    "actix-session",
    "actix_session",
    "async-session",
    "async_session",
)
DEPENDENCY_LINE = re.compile(
    r"^\s*(?:\[(?:[\w.-]*dependencies)\.(?P<table>[\w-]+)\]|(?P<key>[\w-]+)\s*(?:=|\.))", re.MULTILINE
)

CADDY_DOMAIN = re.compile(r"(?:^|[;\s\"'])domain\s*=|cookie[_ ]?domain\b", re.IGNORECASE)

WEB_COOKIE_API = re.compile(
    r"\bdocument\s*(?:\.\s*cookie\b|\[\s*['\"`]cookie['\"`]\s*\])"
    r"|\bcookieStore\b"
    r"|(?:from|require\s*\(|import\s*\()\s*['\"](?:js-cookie|universal-cookie|cookies-next|cookie)['\"]"
)
WEB_DOMAIN_ATTRIBUTE = re.compile(r"[;'\"`]\s*domain\s*=", re.IGNORECASE)
JS_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
JS_LINE_COMMENT = re.compile(r"(?m)(?:^|(?<=[\s;,(){}\[\]]))//.*$")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)


@dataclass(frozen=True)
class Literal:
    """A string literal: its line, its text as written, where it starts and whether it is raw."""

    line: int
    text: str
    start: int = 0
    raw: bool = False

    @property
    def value(self) -> str:
        """The text with the escapes of a normal string resolved."""
        return self.text if self.raw else unescape(self.text)


@dataclass(frozen=True)
class Scanned:
    """A Rust file split into code (literals and comments blanked) and its string literals."""

    code: str
    literals: tuple[Literal, ...]


_SIMPLE_ESCAPES = {"n": "\n", "r": "\r", "t": "\t", "0": "\0", "\\": "\\", "'": "'", '"': '"'}


def unescape(text: str) -> str:
    """Resolves `\\n`, `\\xNN`, `\\u{...}`, `\\\\` and line continuations of a Rust string.

    An escape that is not valid Rust is kept as written; the compiler rejects it anyway.
    """
    out: list[str] = []
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char != "\\" or index + 1 >= length:
            out.append(char)
            index += 1
            continue
        nxt = text[index + 1]
        if nxt in _SIMPLE_ESCAPES:
            out.append(_SIMPLE_ESCAPES[nxt])
            index += 2
        elif nxt == "x" and re.fullmatch(r"[0-9a-fA-F]{2}", text[index + 2 : index + 4]):
            out.append(chr(int(text[index + 2 : index + 4], 16)))
            index += 4
        elif nxt == "u" and (match := re.match(r"\{([0-9a-fA-F_]{1,13})\}", text[index + 2 :])):
            try:
                out.append(chr(int(match.group(1).replace("_", ""), 16)))
            except (ValueError, OverflowError):
                out.append(text[index : index + 2 + match.end()])
            index += 2 + match.end()
        elif nxt == "\n":
            index += 2
            while index < length and text[index] in " \t\r\n":
                index += 1
        else:
            out.append(char)
            index += 1
    return "".join(out)


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
    literals and lifetimes. Blanked parts keep their length and line breaks, so line numbers
    and offsets stay right.
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
                literals.append(
                    Literal(source.count("\n", 0, index) + 1, source[body:body_end], index, True)
                )
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
            literals.append(
                Literal(source.count("\n", 0, index) + 1, source[index + 1 : end - 1], index)
            )
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


def _line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _concatenated(scanned: Scanned) -> list[Literal]:
    """One literal per `concat!(...)` call: the pieces joined, as the compiler does."""
    joined: list[Literal] = []
    for match in CONCAT.finditer(scanned.code):
        depth = 1
        end = match.end()
        while end < len(scanned.code) and depth > 0:
            depth += {"(": 1, ")": -1}.get(scanned.code[end], 0)
            end += 1
        pieces = [lit for lit in scanned.literals if match.end() <= lit.start < end]
        if len(pieces) > 1:
            text = "".join(piece.value for piece in pieces)
            joined.append(Literal(_line_of(scanned.code, match.start()), text, match.start(), True))
    return joined


def _is_read(code: str, literal: Literal) -> bool:
    """Whether the literal is only compared or searched (`.contains("domain")`, `== "domain"`)."""
    return READ_CONTEXT.search(code[: literal.start].rstrip()) is not None


def check_file(relative: str, source: str) -> list[str]:
    """The findings for one Rust file (`relative` uses `/`)."""
    findings: list[str] = []
    scanned = scan(source)
    names_set_cookie_ok = relative in COOKIE_MODULES or RUST_TESTS.match(relative) is not None
    modules = ", ".join(sorted(COOKIE_MODULES))
    for literal in [*scanned.literals, *_concatenated(scanned)]:
        value = literal.value
        if DOMAIN_ATTRIBUTE.search(value):
            findings.append(f"{relative}:{literal.line}: a string sets a cookie Domain attribute")
        elif DOMAIN_WORD.match(value) and not _is_read(scanned.code, literal):
            findings.append(
                f"{relative}:{literal.line}: a string is the cookie Domain attribute name "
                "(a Domain attribute built from pieces)"
            )
        if not names_set_cookie_ok and SET_COOKIE_LITERAL.search(value):
            findings.append(
                f"{relative}:{literal.line}: names the Set-Cookie header outside the cookie module "
                f"({modules})"
            )
    for match in DOMAIN_CALL.finditer(scanned.code):
        findings.append(
            f"{relative}:{_line_of(scanned.code, match.start())}: calls a cookie domain(...) builder"
        )
    for match in COOKIE_API.finditer(scanned.code):
        findings.append(
            f"{relative}:{_line_of(scanned.code, match.start())}: uses a cookie library API "
            f"({' '.join(match.group(0).split())}); cookies are built by HostCookie only"
        )
    if relative not in SET_COOKIE_BUILDERS:
        for match in SET_COOKIE_CONSTRUCTION.finditer(scanned.code):
            findings.append(
                f"{relative}:{_line_of(scanned.code, match.start())}: constructs a SetCookie outside "
                f"{', '.join(sorted(SET_COOKIE_BUILDERS))}"
            )
    if not names_set_cookie_ok:
        for match in SET_COOKIE_IDENT.finditer(scanned.code):
            findings.append(
                f"{relative}:{_line_of(scanned.code, match.start())}: uses SET_COOKIE outside the "
                f"cookie module ({modules})"
            )
    return sorted(findings, key=_finding_order)


def _finding_order(finding: str) -> tuple[int, str]:
    """Findings sorted by line number, then text, for a stable output."""
    parts = finding.split(":", 2)
    return (int(parts[1]) if len(parts) > 2 and parts[1].isdigit() else 0, finding)


def check_manifest(relative: str, text: str) -> list[str]:
    """The findings for one `Cargo.toml`: dependencies that set or manage cookies."""
    findings: list[str] = []
    for match in DEPENDENCY_LINE.finditer(text):
        name = match.group("table") or match.group("key")
        if name in COOKIE_DEPENDENCIES:
            findings.append(
                f"{relative}:{_line_of(text, match.start())}: depends on {name}, a cookie or session "
                "library; review the cookies it sets and extend scripts/ci/check_cookies.py first"
            )
    return findings


def check_caddyfile(relative: str, text: str) -> list[str]:
    """The findings for one Caddy configuration file."""
    findings: list[str] = []
    for number, line in enumerate(text.split("\n"), start=1):
        content = re.sub(r"(?:^|\s)#.*$", "", line)
        if CADDY_DOMAIN.search(content):
            findings.append(f"{relative}:{number}: sets a cookie Domain attribute")
        if SET_COOKIE_LITERAL.search(content) and relative not in CADDY_SET_COOKIE_ALLOWLIST:
            findings.append(
                f"{relative}:{number}: names the Set-Cookie header in a Caddy file outside "
                f"{', '.join(sorted(CADDY_SET_COOKIE_ALLOWLIST))}"
            )
    return findings


def check_web(relative: str, source: str) -> list[str]:
    """The findings for one script, component or page of `web/`."""
    text = HTML_COMMENT.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), source)
    text = JS_BLOCK_COMMENT.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)
    text = JS_LINE_COMMENT.sub("", text)
    findings: list[str] = []
    if relative not in WEB_COOKIE_ALLOWLIST:
        for match in WEB_COOKIE_API.finditer(text):
            findings.append(
                f"{relative}:{_line_of(text, match.start())}: uses document.cookie, the Cookie Store "
                "API or a cookie library; the session cookies are HttpOnly and set by the server"
            )
    for match in WEB_DOMAIN_ATTRIBUTE.finditer(text):
        findings.append(f"{relative}:{_line_of(text, match.start())}: sets a cookie Domain attribute")
    for match in SET_COOKIE_LITERAL.finditer(text):
        findings.append(
            f"{relative}:{_line_of(text, match.start())}: names the Set-Cookie header in a web source"
        )
    return findings


def walk(root: Path) -> list[Path]:
    """Every file of the repository outside the skipped directories, sorted."""
    found: list[Path] = []
    for directory, names, files in os.walk(root):
        names[:] = sorted(name for name in names if name not in SKIPPED_DIRECTORIES)
        found.extend(Path(directory) / name for name in sorted(files))
    return sorted(found)


def sources(root: Path) -> list[Path]:
    """Every Rust source file of the repository (all crates and the fuzz targets), sorted."""
    return [path for path in walk(root) if path.suffix == ".rs"]


def check(root: Path) -> list[str]:
    """Every finding in the repository at `root`."""
    findings: list[str] = []
    for path in walk(root):
        relative = path.relative_to(root).as_posix()
        name = path.name
        if path.suffix == ".rs":
            findings.extend(check_file(relative, path.read_text(encoding="utf-8")))
        elif name == "Cargo.toml":
            findings.extend(check_manifest(relative, path.read_text(encoding="utf-8")))
        elif name.startswith("Caddyfile") or path.suffix == ".caddy":
            findings.extend(check_caddyfile(relative, path.read_text(encoding="utf-8")))
        elif relative.startswith("web/") and path.suffix in WEB_EXTENSIONS:
            findings.extend(check_web(relative, path.read_text(encoding="utf-8")))
    return findings


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parents[2]
    files = sources(root)
    if not files:
        print(f"check_cookies: no Rust sources under {root}", file=sys.stderr)
        return 1
    findings = check(root)
    for finding in findings:
        print(finding)
    if findings:
        print(f"check_cookies: {len(findings)} finding(s); every cookie must be a host-only __Host- cookie")
        return 1
    print(
        f"check_cookies: {len(files)} Rust files, manifests, Caddy files and web sources clean "
        "(no Domain attribute, Set-Cookie only in the cookie module)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
