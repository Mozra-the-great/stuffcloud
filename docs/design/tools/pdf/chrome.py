"""Finds a Chrome or Chromium binary: $CHROME first, then the usual install paths."""
import os
import shutil

CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]
NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]


def chrome_path() -> str:
    env = os.environ.get("CHROME")
    if env and os.path.exists(env):
        return env
    for c in CANDIDATES:
        if os.path.exists(c):
            return c
    for n in NAMES:
        found = shutil.which(n)
        if found:
            return found
    raise SystemExit("No Chrome/Chromium found. Install one or set the CHROME environment variable.")
