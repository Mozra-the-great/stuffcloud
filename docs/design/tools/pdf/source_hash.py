"""Fingerprint of everything the design PDF is built from.

    python docs/design/tools/pdf/source_hash.py --check   # CI: fails when the PDF is stale
    python docs/design/tools/pdf/source_hash.py --write   # done by build.py after a rebuild

The hash covers the mockups, THEME-TEXTS.md and the build scripts, with line endings
normalised so Windows and Linux agree. It is stored in docs/design/pdf-source.sha256
next to the PDF; a design change that does not update it fails the `build` check.
Standard library only.
"""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DESIGN = os.path.abspath(os.path.join(HERE, "..", ".."))
HASH_FILE = os.path.join(DESIGN, "pdf-source.sha256")


def sources() -> list[str]:
    files = [os.path.join(DESIGN, "THEME-TEXTS.md")]
    protos = os.path.join(DESIGN, "prototypes")
    files += [os.path.join(protos, f) for f in os.listdir(protos)]
    files += [os.path.join(HERE, f) for f in os.listdir(HERE) if f.endswith(".py") and f != "source_hash.py"]
    files.append(os.path.join(HERE, "requirements.txt"))
    return sorted(files)


def compute() -> str:
    h = hashlib.sha256()
    for path in sources():
        rel = os.path.relpath(path, DESIGN).replace(os.sep, "/")
        with open(path, "rb") as fh:
            data = fh.read().replace(b"\r\n", b"\n")
        h.update(rel.encode() + b"\0" + hashlib.sha256(data).digest())
    return h.hexdigest()


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    current = compute()
    if mode == "--write":
        with open(HASH_FILE, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(current + "\n")
        print("wrote", HASH_FILE)
        return 0
    stored = open(HASH_FILE, encoding="utf-8").read().strip() if os.path.exists(HASH_FILE) else ""
    if stored == current:
        print("design PDF is current")
        return 0
    print("::error title=Design PDF is stale::docs/design changed but stuffcloud-design-system.pdf was not rebuilt. "
          "Run `python docs/design/tools/pdf/build.py` and commit the PDF and docs/design/pdf-source.sha256, "
          "or run the 'Rebuild design PDF' workflow for this branch.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
