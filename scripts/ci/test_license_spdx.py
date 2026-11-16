#!/usr/bin/env python3
"""Unit tests for spdx.py (the expression parser behind the license gates).

A wrong `OR`/`AND` reading would let a copyleft package through or reject a fine
one, and every malformed form must be an error, never a pass:

    python3 -m unittest discover -s scripts/ci -p "test_*.py"
"""
from __future__ import annotations

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import spdx  # noqa: E402


def allowed(*licenses: str):
    lowered = {item.lower() for item in licenses}
    return lambda term: term.lower() in lowered


class TestParse(unittest.TestCase):
    def test_single_license(self):
        self.assertEqual(spdx.parse("MIT"), spdx.Term("MIT"))

    def test_or_and_and_keep_their_parts(self):
        self.assertEqual(
            spdx.parse("MIT OR Apache-2.0"),
            spdx.AnyOf((spdx.Term("MIT"), spdx.Term("Apache-2.0"))),
        )
        self.assertEqual(
            spdx.parse("MIT AND Zlib"), spdx.AllOf((spdx.Term("MIT"), spdx.Term("Zlib")))
        )

    def test_and_binds_tighter_than_or(self):
        self.assertEqual(
            spdx.parse("A OR B AND C"),
            spdx.AnyOf((spdx.Term("A"), spdx.AllOf((spdx.Term("B"), spdx.Term("C"))))),
        )

    def test_parentheses_override_precedence(self):
        self.assertEqual(
            spdx.parse("(A OR B) AND C"),
            spdx.AllOf((spdx.AnyOf((spdx.Term("A"), spdx.Term("B"))), spdx.Term("C"))),
        )

    def test_nested_and_redundant_parentheses(self):
        self.assertEqual(spdx.parse("((MIT))"), spdx.Term("MIT"))
        self.assertEqual(spdx.parse("(MIT OR CC0-1.0)"), spdx.parse("MIT OR CC0-1.0"))

    def test_with_exception_is_one_term(self):
        self.assertEqual(
            spdx.parse("Apache-2.0 WITH LLVM-exception"),
            spdx.Term("Apache-2.0 WITH LLVM-exception"),
        )

    def test_with_binds_tighter_than_or(self):
        self.assertEqual(
            spdx.parse("Apache-2.0 WITH LLVM-exception OR MIT"),
            spdx.AnyOf((spdx.Term("Apache-2.0 WITH LLVM-exception"), spdx.Term("MIT"))),
        )

    def test_keywords_and_whitespace_are_lenient(self):
        self.assertEqual(spdx.parse("  mit   or   isc "), spdx.parse("mit OR isc"))
        self.assertEqual(spdx.parse("(MIT)OR(ISC)"), spdx.parse("MIT OR ISC"))

    def test_plus_and_dots_are_part_of_an_identifier(self):
        self.assertEqual(spdx.parse("GPL-3.0+"), spdx.Term("GPL-3.0+"))
        self.assertEqual(spdx.parse("BSD-3-Clause-No-Nuclear-License-2014"),
                         spdx.Term("BSD-3-Clause-No-Nuclear-License-2014"))


class TestMalformed(unittest.TestCase):
    CASES = {
        "empty": "",
        "blank": "   ",
        "only operator": "OR",
        "leading operator": "OR MIT",
        "trailing or": "MIT OR",
        "trailing and": "MIT AND",
        "double operator": "MIT OR OR ISC",
        "missing operator": "MIT ISC",
        "unclosed paren": "(MIT OR ISC",
        "extra closing paren": "MIT)",
        "empty parens": "()",
        "dangling with": "Apache-2.0 WITH",
        "with without license": "WITH LLVM-exception",
        "with keyword as exception": "Apache-2.0 WITH OR",
        "slash separator": "MIT/Apache-2.0",
        "comma separator": "MIT, ISC",
        "see license in": "SEE LICENSE IN LICENSE.md",
        "unknown marker with text": "Custom License 1.0",
        "quote": "'MIT'",
    }

    def test_every_malformed_expression_raises(self):
        for label, text in self.CASES.items():
            with self.subTest(label), self.assertRaises(spdx.LicenseExpressionError):
                spdx.parse(text)

    def test_messages_name_the_problem(self):
        with self.assertRaisesRegex(spdx.LicenseExpressionError, "empty license expression"):
            spdx.parse("")
        with self.assertRaisesRegex(spdx.LicenseExpressionError, "unexpected end"):
            spdx.parse("MIT OR")
        with self.assertRaisesRegex(spdx.LicenseExpressionError, r"expected '\)'"):
            spdx.parse("(MIT ISC)")
        with self.assertRaisesRegex(spdx.LicenseExpressionError, "invalid license identifier"):
            spdx.parse("MIT/ISC")
        with self.assertRaisesRegex(spdx.LicenseExpressionError, "unexpected 'ISC'"):
            spdx.parse("MIT ISC")


class TestEvaluate(unittest.TestCase):
    def test_single(self):
        self.assertTrue(spdx.is_satisfied(spdx.parse("MIT"), allowed("MIT")))
        self.assertFalse(spdx.is_satisfied(spdx.parse("GPL-2.0-only"), allowed("MIT")))

    def test_or_needs_one(self):
        node = spdx.parse("GPL-2.0-only OR MIT")
        self.assertTrue(spdx.is_satisfied(node, allowed("MIT")))
        self.assertFalse(spdx.is_satisfied(node, allowed("ISC")))

    def test_and_needs_all(self):
        node = spdx.parse("MIT AND Zlib")
        self.assertTrue(spdx.is_satisfied(node, allowed("MIT", "Zlib")))
        self.assertFalse(spdx.is_satisfied(node, allowed("MIT")))
        self.assertFalse(spdx.is_satisfied(node, allowed("Zlib")))

    def test_mixed(self):
        node = spdx.parse("(MIT OR Apache-2.0) AND Unicode-3.0")
        self.assertTrue(spdx.is_satisfied(node, allowed("Apache-2.0", "Unicode-3.0")))
        self.assertFalse(spdx.is_satisfied(node, allowed("MIT", "Apache-2.0")))
        self.assertFalse(spdx.is_satisfied(node, allowed("Unicode-3.0")))

    def test_with_exception_does_not_match_the_bare_license(self):
        node = spdx.parse("Apache-2.0 WITH LLVM-exception")
        self.assertFalse(spdx.is_satisfied(node, allowed("Apache-2.0")))
        self.assertTrue(
            spdx.is_satisfied(node, allowed("Apache-2.0 WITH LLVM-exception"))
        )

    def test_terms_lists_every_license_in_order(self):
        self.assertEqual(
            spdx.terms(spdx.parse("(MIT OR ISC) AND Apache-2.0 WITH LLVM-exception")),
            ["MIT", "ISC", "Apache-2.0 WITH LLVM-exception"],
        )


if __name__ == "__main__":
    unittest.main()
