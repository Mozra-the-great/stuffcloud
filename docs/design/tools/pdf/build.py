"""Rebuilds docs/design/stuffcloud-design-system.pdf from the mockups in docs/design/prototypes.

    pip install -r docs/design/tools/pdf/requirements.txt
    python docs/design/tools/pdf/build.py

Needs Chrome or Chromium (set CHROME to point at a specific binary) and internet
access for the Google Fonts the mockups load. The work happens in a temp folder;
only the PDF is written to the repo.
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DESIGN = os.path.abspath(os.path.join(HERE, "..", ".."))
PROTOS = os.path.join(DESIGN, "prototypes")
PDF = os.path.join(DESIGN, "stuffcloud-design-system.pdf")

sys.path.insert(0, HERE)
import shots  # noqa: E402


def check_coverage() -> None:
    """Warns about mockups that are not in shots.PAGES, so new pages do not slip out of the PDF."""
    known = set()
    for f, _, mob in shots.PAGES:
        known.add(f)
        if mob:
            known.add(mob)
    pages = sorted(f[:-8] for f in os.listdir(PROTOS) if f.endswith(".dc.html"))
    missing = [p for p in pages if p not in known]
    if missing:
        print("WARNING: not in the PDF (add them to PAGES in shots.py):", ", ".join(missing))


def main() -> None:
    check_coverage()
    with tempfile.TemporaryDirectory() as work:
        for f in os.listdir(PROTOS):
            shutil.copy(os.path.join(PROTOS, f), os.path.join(work, f))
        shutil.copy(os.path.join(DESIGN, "THEME-TEXTS.md"), os.path.join(work, "THEME-TEXTS.md"))
        shots.render(work, os.path.join(work, "out"))
        subprocess.run([sys.executable, os.path.join(HERE, "build_book.py"), work, PDF, os.path.join(work, "THEME-TEXTS.md")], check=True, cwd=HERE)
    print("wrote", PDF)


if __name__ == "__main__":
    main()
