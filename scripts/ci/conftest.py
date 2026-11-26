"""pytest setup for the mutation run (mutmut, `pyproject.toml`). The unittest run needs none of it.

The helpers run as scripts and import each other, and their tests import them, by plain file
name (`import check_cookies`). mutmut names every mutant after the path of its file
(`scripts.ci.check_cookies.x_scan__mutmut_1`) and expects the tests to run the module under that
name; with the plain name it finds no mutant for what the tests ran and stops. So each helper is
imported here once under its package name and registered under its plain name too, helpers that
others import first. The tests then get the very module mutmut mutated.

Skipped: `dev_stack_smoke` (it patches `socket.getaddrinfo` when imported and needs a running
Docker stack; it is not mutated) and, when `scripts.ci` cannot be imported (a plain `pytest` run
from another directory), everything: the tests then import the helpers by plain name as usual.
"""
from __future__ import annotations

import importlib
import importlib.util
import re
import sys
from pathlib import Path

PACKAGE = "scripts.ci"
HERE = Path(__file__).resolve().parent
SKIPPED = {"conftest", "dev_stack_smoke"}
IMPORT_LINE = re.compile(r"^(?:from|import)[ \t]+([A-Za-z_][A-Za-z0-9_]*)", re.MULTILINE)


def helper_names() -> list[str]:
    """The helper modules of this directory (not the tests), sorted."""
    return sorted(
        path.stem for path in HERE.glob("*.py") if not path.stem.startswith("test_") and path.stem not in SKIPPED
    )


def imports_of(name: str, known: set[str]) -> set[str]:
    """The helpers that helper `name` imports (a line-start scan: the mutated copies are megabytes
    and every pytest start runs this, so they are not parsed)."""
    text = (HERE / f"{name}.py").read_text(encoding="utf-8")
    return (set(IMPORT_LINE.findall(text)) & known) - {name}


def in_import_order(names: list[str]) -> list[str]:
    """`names` with every helper after the helpers it imports."""
    known = set(names)
    ordered: list[str] = []

    def visit(name: str) -> None:
        if name in ordered:
            return
        for dependency in sorted(imports_of(name, known)):
            visit(dependency)
        ordered.append(name)

    for name in names:
        visit(name)
    return ordered


def register_helpers_under_their_package_name() -> None:
    try:
        if importlib.util.find_spec(PACKAGE) is None:
            return
    except ImportError:
        return
    for name in in_import_order(helper_names()):
        sys.modules[name] = importlib.import_module(f"{PACKAGE}.{name}")


register_helpers_under_their_package_name()
