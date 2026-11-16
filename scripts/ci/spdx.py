#!/usr/bin/env python3
"""Parser and evaluator for SPDX license expressions.

npm packages and Rust crates declare their license as an SPDX expression such as
`MIT`, `(MIT OR CC0-1.0)` or `Apache-2.0 WITH LLVM-exception`. The license gate has
to answer one question about it: given the set of licenses the project accepts, may
this package be used? `OR` is a choice (one acceptable alternative is enough), `AND`
a duty (every part must be acceptable), `WITH` binds an exception to a license and
is matched as one unit (`Apache-2.0 WITH LLVM-exception`), exactly as `deny.toml`
lists it. Precedence is the SPDX one: `WITH` binds tighter than `AND`, `AND` tighter
than `OR`.

The parser is strict on purpose. Anything that is not a well-formed expression
(`Unknown`, `SEE LICENSE IN LICENSE.md`, `MIT/Apache-2.0`, a dangling operator,
unbalanced parentheses) raises `LicenseExpressionError`, and the gate treats that
as "not allowed": an unreadable license is never a pass.

Standard library only.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

_ID = re.compile(r"[A-Za-z0-9.+-]+")
_KEYWORDS = frozenset({"and", "or", "with"})


class LicenseExpressionError(ValueError):
    """The text is not a well-formed SPDX license expression."""


@dataclass(frozen=True)
class Term:
    """One license, optionally with an exception: `MIT`, `GPL-2.0-only WITH Classpath-exception-2.0`."""

    text: str


@dataclass(frozen=True)
class AllOf:
    """`A AND B`: every part must be acceptable."""

    parts: tuple[Node, ...]


@dataclass(frozen=True)
class AnyOf:
    """`A OR B`: one acceptable part is enough."""

    parts: tuple[Node, ...]


Node = Term | AllOf | AnyOf


def tokenize(expression: str) -> list[str]:
    """Split into identifiers, keywords and parentheses. Empty input has no tokens."""
    return re.findall(r"\(|\)|[^\s()]+", expression)


class _Parser:
    def __init__(self, tokens: list[str]) -> None:
        self._tokens = tokens
        self._pos = 0

    def _peek(self) -> str | None:
        return self._tokens[self._pos] if self._pos < len(self._tokens) else None

    def _peek_keyword(self, keyword: str) -> bool:
        token = self._peek()
        return token is not None and token.lower() == keyword

    def _next(self) -> str:
        token = self._peek()
        if token is None:
            raise LicenseExpressionError("unexpected end of expression")
        self._pos += 1
        return token

    def parse(self) -> Node:
        node = self._or()
        leftover = self._peek()
        if leftover is not None:
            raise LicenseExpressionError(f"unexpected {leftover!r}")
        return node

    def _or(self) -> Node:
        parts = [self._and()]
        while self._peek_keyword("or"):
            self._pos += 1
            parts.append(self._and())
        return parts[0] if len(parts) == 1 else AnyOf(tuple(parts))

    def _and(self) -> Node:
        parts = [self._primary()]
        while self._peek_keyword("and"):
            self._pos += 1
            parts.append(self._primary())
        return parts[0] if len(parts) == 1 else AllOf(tuple(parts))

    def _primary(self) -> Node:
        token = self._next()
        if token == "(":
            node = self._or()
            if self._next() != ")":
                raise LicenseExpressionError("expected ')'")
            return node
        license_id = self._identifier(token)
        if self._peek_keyword("with"):
            self._pos += 1
            exception = self._identifier(self._next())
            return Term(f"{license_id} WITH {exception}")
        return Term(license_id)

    @staticmethod
    def _identifier(token: str) -> str:
        if token.lower() in _KEYWORDS or token in ("(", ")"):
            raise LicenseExpressionError(f"unexpected {token!r}")
        if not _ID.fullmatch(token):
            raise LicenseExpressionError(f"invalid license identifier {token!r}")
        return token


def parse(expression: str) -> Node:
    """Parse an SPDX expression; raises `LicenseExpressionError` when malformed."""
    tokens = tokenize(expression)
    if not tokens:
        raise LicenseExpressionError("empty license expression")
    return _Parser(tokens).parse()


def terms(node: Node) -> list[str]:
    """Every license term in the expression, in order of appearance."""
    if isinstance(node, Term):
        return [node.text]
    return [text for part in node.parts for text in terms(part)]


def is_satisfied(node: Node, permitted: Callable[[str], bool]) -> bool:
    """True if the expression can be met using only terms `permitted` accepts."""
    if isinstance(node, Term):
        return permitted(node.text)
    if isinstance(node, AllOf):
        return all(is_satisfied(part, permitted) for part in node.parts)
    return any(is_satisfied(part, permitted) for part in node.parts)
