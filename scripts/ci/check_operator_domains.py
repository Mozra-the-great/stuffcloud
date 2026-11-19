#!/usr/bin/env python3
"""Operator-domain gate (SC-D, SF11): no operator-specific domain in a tracked file.

stuffcloud is instance-neutral (CLAUDE.md): no real domain of any operator may appear in code,
tests, fixtures, docs, ADRs or issue templates, only the reserved names of RFC 2606 / RFC 6761.
The list of domains to keep out cannot live in the public repository (that would publish the
very names it protects), so it comes from the environment:

    STUFFCLOUD_FORBIDDEN_DOMAINS   the registrable domains, separated by newlines, commas,
                                   semicolons or spaces; `#` starts a comment; a leading `*.`
                                   or `.` and a trailing `.` are ignored

In CI the variable is filled from the repository's Actions secret or variable of the same name
(`.github/workflows/ci.yml`, job `repo-checks`). Setting it is described in CONTRIBUTING.md.

What it does:

* Every tracked file (`git ls-files`, or every file below the root when there is no git
  checkout) is scanned as text, line by line, and its path is scanned too. Files with a NUL byte
  are binary and skipped.
* An entry matches case-insensitively, as the domain itself and as any subdomain of it
  (`example.org` finds `example.org`, `www.example.org` and `example.org.pem`, not
  `notexample.org`). A non-ASCII entry is matched in its Unicode and its Punycode form.
* The names reserved for documentation (`example.com`, `example.org`, `example.net`, and
  everything below `.example`, `.test`, `.invalid`, `.localhost`) are always allowed: an entry
  that is such a name is ignored with a notice, because it can never be a violation.
* The output never contains a listed domain or the offending line: CI logs of a public
  repository are public. A finding is `path:line: forbidden domain (entry N)` where N counts
  the entries of the list; a path that itself matches is shown as `<file name hidden #K>`.

Without the variable (empty or unset: pull requests from forks and Dependabot do not receive
Actions secrets) the gate runs as a reduced check: it prints a notice and passes. A malformed
entry fails the gate (exit 2) instead of silently checking less.

Usage: python3 scripts/ci/check_operator_domains.py [repository root]
Exit code 0 when clean or reduced, 1 with one line per finding, 2 for a malformed list.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

ENV_VAR = "STUFFCLOUD_FORBIDDEN_DOMAINS"

# Names reserved for documentation and tests (RFC 2606, RFC 6761): never a violation.
RESERVED_DOMAINS = frozenset({"example.com", "example.org", "example.net"})
RESERVED_TLDS = frozenset({"example", "test", "invalid", "localhost"})

_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_SEPARATORS = re.compile(r"[\s,;]+")
_BINARY_PROBE = 8192


@dataclass(frozen=True)
class Entry:
    """One forbidden domain, as the number it has in the list and its ASCII form."""

    number: int
    ascii_name: str
    unicode_name: str


@dataclass(frozen=True)
class Parsed:
    """The result of reading the list: usable entries, ignored reserved names, bad entries."""

    entries: tuple[Entry, ...]
    reserved: tuple[int, ...]
    malformed: tuple[int, ...]


def is_reserved(domain: str) -> bool:
    """Whether `domain` (lowercase ASCII) is a name reserved for documentation."""
    labels = domain.split(".")
    if labels[-1] in RESERVED_TLDS:
        return True
    return ".".join(labels[-2:]) in RESERVED_DOMAINS


def _normalise(raw: str) -> tuple[str, str] | None:
    """The (ASCII, Unicode) form of one list item, or None when it is not a domain name."""
    name = raw.strip().lower()
    if name.startswith("*."):
        name = name[2:]
    name = name.strip(".")
    if not name or "." not in name:
        return None
    try:
        ascii_name = name.encode("idna").decode("ascii")
        unicode_name = ascii_name.encode("ascii").decode("idna")
    except UnicodeError:
        return None
    labels = ascii_name.split(".")
    if len(ascii_name) > 253 or not all(_LABEL.match(label) for label in labels):
        return None
    return ascii_name, unicode_name


def parse_entries(raw: str, reserved_check: Callable[[str], bool] | None = None) -> Parsed:
    """Read the list from the variable's value (`reserved_check` defaults to `is_reserved`)."""
    reserved_check = reserved_check or is_reserved
    items: list[str] = []
    for line in raw.splitlines():
        items.extend(part for part in _SEPARATORS.split(line.partition("#")[0]) if part)
    entries: list[Entry] = []
    reserved: list[int] = []
    malformed: list[int] = []
    for number, item in enumerate(items, start=1):
        names = _normalise(item)
        if names is None:
            malformed.append(number)
        elif reserved_check(names[0]):
            reserved.append(number)
        else:
            entries.append(Entry(number, *names))
    return Parsed(tuple(entries), tuple(reserved), tuple(malformed))


def build_matcher(entries: Iterable[Entry]) -> re.Pattern[str] | None:
    """One pattern for all entries; the group `e<N>` says which entry matched.

    A hit is the name itself or a subdomain of it: not preceded by a letter, digit or hyphen
    (so `notexample.org` is not `example.org`) and not followed by a letter, digit or hyphen.
    A following dot and label is allowed on purpose: `example.org.pem` and `example.org.conf`
    are file names that carry the domain, and a false positive costs less than a leak.
    """
    groups = []
    for entry in entries:
        forms = {entry.ascii_name, entry.unicode_name}
        alternatives = "|".join(re.escape(form) for form in sorted(forms))
        groups.append(f"(?P<e{entry.number}>{alternatives})")
    if not groups:
        return None
    return re.compile(
        r"(?<!-)(?<![^\W_])(?:" + "|".join(groups) + r")(?!-)(?![^\W_])",
        re.IGNORECASE,
    )


def matched_entry(match: re.Match[str]) -> int:
    """The number of the entry that produced `match`."""
    group = match.lastgroup
    return int(group[1:]) if group else 0


def scan_text(text: str, matcher: re.Pattern[str]) -> Iterator[tuple[int, int]]:
    """(line number, entry number) of every hit in `text`; a line reports each entry once."""
    for number, line in enumerate(text.splitlines(), start=1):
        seen: set[int] = set()
        for match in matcher.finditer(line):
            entry = matched_entry(match)
            if entry not in seen:
                seen.add(entry)
                yield number, entry


def tracked_files(root: Path) -> list[str]:
    """Paths (relative, with `/`) of every tracked file; every file below `root` without git."""
    if (root / ".git").exists():
        done = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            check=True,
            capture_output=True,
        )
        return sorted(p for p in done.stdout.decode("utf-8", "surrogateescape").split("\0") if p)
    return sorted(
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and ".git" not in path.relative_to(root).parts
    )


def check(root: Path, entries: tuple[Entry, ...]) -> list[str]:
    """The findings for every tracked file below `root`, one line each, without any domain."""
    matcher = build_matcher(entries)
    if matcher is None:
        return []
    findings: list[str] = []
    hidden = 0
    for relative in tracked_files(root):
        name_hits = sorted({matched_entry(m) for m in matcher.finditer(relative)})
        if name_hits:
            hidden += 1
            shown = f"<file name hidden #{hidden}>"
            for entry in name_hits:
                findings.append(f"{shown}: the file name contains a forbidden domain (entry {entry})")
        else:
            shown = relative
        try:
            data = (root / relative).read_bytes()
        except OSError:
            continue  # a dangling symlink or a submodule path: nothing to read
        if b"\0" in data[:_BINARY_PROBE]:
            continue
        text = data.decode("utf-8", errors="replace")
        for line, entry in scan_text(text, matcher):
            findings.append(f"{shown}:{line}: forbidden domain (entry {entry})")
    return findings


def notice(message: str) -> None:
    """An annotation in GitHub Actions, a plain line elsewhere."""
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::notice title=Operator-domain check::{message}")
    else:
        print(f"notice: {message}")


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parents[2]
    raw = os.environ.get(ENV_VAR, "")
    parsed = parse_entries(raw)
    if parsed.malformed:
        numbers = ", ".join(str(n) for n in parsed.malformed)
        print(
            f"{ENV_VAR}: entry {numbers} is not a domain name (two or more labels of "
            "letters, digits and hyphens); fix the list in the repository's Actions settings"
        )
        return 2
    if parsed.reserved:
        numbers = ", ".join(str(n) for n in parsed.reserved)
        notice(f"entry {numbers} is a name reserved for documentation (RFC 2606) and is ignored")
    if not parsed.entries:
        notice(
            f"{ENV_VAR} has no usable entry (empty or not available: pull requests from forks and Dependabot get "
            "no Actions secrets): reduced check, no operator domain was searched for"
        )
        return 0
    findings = check(root, parsed.entries)
    for finding in findings:
        print(finding)
    if findings:
        print(
            f"{len(findings)} finding(s): an operator-specific domain must not be in the "
            "repository; use example.com, example.org, example.net or *.example / *.test "
            "(CLAUDE.md, Instance-neutral)"
        )
        return 1
    print(f"operator-domain check: {len(parsed.entries)} entries, no findings")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
