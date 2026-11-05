"""Renders every design page as a PNG (desktop 1280 wide, mobile 390x844) for the PDF."""
import os
import re

from chrome import chrome_path

PAGES = [  # (file, title, mobile file or None for same)  # (file, title, mobile file or None for same)
    ("H", "Home", "J"), ("F", "Tool page: merge PDF", "K"), ("I", "Host something", "L"), ("M", "Site published", "N"),
    ("O", "Log in", "P"), ("Q", "Two-factor code", "R"), ("S", "Delete site", "T"),
    ("U", "Register", None), ("W", "Set up two-factor", None), ("Y", "My sites", None), ("AA", "Paste text", None),
    ("AC", "Report a site", None), ("AE", "Protected site", None), ("AG", "Site expired", None),
    ("AI", "Account security", None), ("AK", "Moderation queue", None), ("AM", "Admin: users", None),
    ("AO", "Admin: zones", None), ("AQ", "Admin: settings", None), ("AS", "Page builder", None),
    ("AU", "Templates", None), ("AW", "All tools", None), ("AY", "Recovery code (error)", None),
    ("BA", "API tokens", None), ("BC", "Admin: tools", None), ("BE", "Mascots and easter eggs", None),
    ("BG", "Tool: converter", None), ("BI", "Tool: QR code", None), ("BK", "Tool: resize image", None),
    ("BM", "Empty and error states", None), ("BO", "Docs page", None), ("BQ", "Seasonal decorations", None),
    ("BS", "All tools in Christmas", None), ("BU", "All tools in Halloween", None), ("BW", "Theme button", None), ("BY", "Tool stickers", "BZ"),
]


def clean(src, name):
    s = open(os.path.join(src, name + ".dc.html"), encoding="utf-8").read()
    s = re.sub(r"<script[^>]*>.*?</script>", "", s, flags=re.S)
    s = s.replace("<x-dc>", "<div>").replace("</x-dc>", "</div>").replace("<helmet>", "").replace("</helmet>", "")
    s = re.sub(r"\{\{p\d\}\}", "0", s)
    s = re.sub(r"\{\{d\d\}\}", "", s)
    s = re.sub(r'value="\{\{(?:code|typed)\}\}"', 'value=""', s)
    s = re.sub(r'disabled="\{\{locked\}\}"', "disabled", s)
    s = re.sub(r'\s+on\w+="\{\{[^}]*\}\}"', "", s)
    path = os.path.join(src, "_static_" + name + ".html")
    open(path, "w", encoding="utf-8").write(s)
    return path


def render(src, out):
    from playwright.sync_api import sync_playwright
    os.makedirs(os.path.join(out, "desktop"), exist_ok=True)
    os.makedirs(os.path.join(out, "mobile"), exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=chrome_path(), headless=True)
        for f, title, mob in PAGES:
            for kind, name, w, h in (("desktop", f, 1280, 900), ("mobile", mob or f, 390, 844)):
                ctx = b.new_context(viewport={"width": w, "height": h}, reduced_motion="reduce", device_scale_factor=1 if kind == "desktop" else 2)
                pg = ctx.new_page()
                pg.goto("file:///" + clean(src, name).replace("\\", "/"))
                try:
                    pg.wait_for_load_state("networkidle", timeout=8000)
                except Exception:
                    pass
                pg.wait_for_timeout(400)
                pg.screenshot(path=os.path.join(out, kind, f + ".png"), full_page=(kind == "desktop"))
                ctx.close()
            print(f, title, flush=True)
        b.close()
