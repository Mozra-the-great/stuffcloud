"""Builds the design system book (HTML) and prints it to PDF with headless Chrome."""
import os
import sys

from playwright.sync_api import sync_playwright

from chrome import chrome_path
from shots import PAGES

WORK = os.path.abspath(sys.argv[1])    # work dir: copied prototypes, screenshots in out/
PDF = os.path.abspath(sys.argv[2])
THEME_TEXTS = os.path.abspath(sys.argv[3])
HERE = WORK
OUT = os.path.join(WORK, "out")
THEMES = []  # filled from THEME-TEXTS.md below


def lum(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


BG = "#101012"
COLORS = [
    ("Background", "#101012", "page background", "#f4f4f0"),
    ("Text", "#f4f4f0", "primary text, solid buttons", BG),
    ("Muted", "#a2a2ab", "labels, hints, secondary text", BG),
    ("Pink", "#ff79b0", "hover, active state, accent", BG),
    ("Pink strong", "#ff4f8b", "danger buttons, errors", BG),
    ("Lilac", "#c78bff", "links, addresses", BG),
    ("Violet", "#8b5cf6", "mascot panel surface", "#ffffff"),
    ("Green", "#3ddc84", "status: ok / LAN", BG),
    ("Line", "#26262b", "cell dividers", "#f4f4f0"),
    ("Line strong", "#3a3a42", "field and button borders", "#f4f4f0"),
]
STICKERS = [("doc", "PDF"), ("mtn", "Images"), ("conv", "Convert"), ("globe", "Network"), ("letter", "Text"), ("dice", "Dev extras"),
            ("lock", "Security"), ("folder", "Files & folders"), ("build", "Page builder"), ("tmpl", "Template")]
ANIMALS = [("axo", "Stuffy", "main mascot", "home, tools, forms"), ("mascot-cat", "Mochi", "cat", "Konami code: walks along the bottom edge"),
           ("mascot-frog", "Hop", "frog", "tool finished: hops across the result"), ("mascot-bunny", "Bun", "bunny", "rarely: peeks in from the edge"),
           ("mascot-jelly", "Bloop", "jellyfish", "long jobs: floats in the progress bar"), ("mascot-penguin", "Waddle", "penguin", "Dec to Feb: slides across the home page"),
           ("mascot-fox", "Ember", "fox", "burn after reading: appears when the page is consumed"), ("mascot-ghost", "Boo", "ghost", "expired and 404 pages"),
           ("mascot-cloudy", "Cumulo", "cloud", "site published; click the logo 5 times: drifts across")]

# themes from the repo texts
tt = open(THEME_TEXTS, encoding="utf-8").read()
for blk in tt.split("## ")[1:]:
    name, *rest = blk.strip().split("\n")
    THEMES.append((name.strip(), [r[2:] for r in rest if r.startswith("- ")]))
WINDOWS = {"Winter": "Jan 3 to Feb 28, Dec 27 to 30", "New Year": "Dec 31 to Jan 2", "Valentine's Day": "Feb 13 to 14", "Carnival": "Weiberfastnacht to Shrove Tuesday",
           "Women's Day": "Mar 8", "Earth Day": "Apr 22", "Easter": "two weeks before to Easter Monday", "Europe Day": "May 9", "Pride": "Jun 1 to 30",
           "Autumn": "Sep 1 to Nov 30", "Unity Day": "Oct 3", "Harvest festival": "week of the first Sunday in October", "Halloween": "Oct 24 to Nov 2",
           "Nicholas Day": "Dec 6", "Human Rights Day": "Dec 10", "Advent": "four Sundays before Christmas to Dec 23", "Christmas": "Dec 1 to Dec 26"}

css = """
@page{size:297mm 210mm;margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#101012;color:#f4f4f0;font-family:'Inter',system-ui,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pg{width:297mm;height:210mm;overflow:hidden;page-break-after:always;break-after:page;padding:14mm 16mm;display:flex;flex-direction:column;gap:16px;position:relative;border-bottom:1px solid #26262b}
.pg h1{margin:0;font-size:44px;font-weight:500;letter-spacing:-1px;line-height:1.05}
.pg h2{margin:0;font-size:26px;font-weight:500;letter-spacing:-.5px}
.pg h3{margin:0;font:12px 'JetBrains Mono',monospace;letter-spacing:1px;color:#a2a2ab;text-transform:uppercase;font-weight:400}
.pg p,.pg li{font-size:13px;line-height:1.55;color:#d8d8de;margin:0}
.pg ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:7px}
.pg li:before{content:"+ ";color:#c78bff;font-family:'JetBrains Mono',monospace}
.foot2{position:absolute;left:16mm;right:16mm;bottom:8mm;display:flex;justify-content:space-between;font:10px 'JetBrains Mono',monospace;color:#6a6a74}
.eyebrow2{font:11px 'JetBrains Mono',monospace;color:#a2a2ab;margin:0}
.cols{display:flex;gap:28px}
.cols>*{flex:1;min-width:0}
.sw{display:flex;gap:12px;align-items:stretch;border:1px solid #26262b}
.sw i{flex:0 0 56px;display:block}
.sw div{padding:6px 10px 6px 0;font:10.5px 'JetBrains Mono',monospace;color:#a2a2ab;line-height:1.4}
.sw b{display:block;font:600 13px 'Inter',sans-serif;color:#f4f4f0}
table.t{width:100%;border-collapse:collapse;font-size:11.5px}
table.t th{text-align:left;font:10px 'JetBrains Mono',monospace;letter-spacing:1px;color:#a2a2ab;padding:6px 8px;border-bottom:1px solid #3a3a42;text-transform:uppercase;font-weight:400}
table.t td{padding:5px 8px;border-bottom:1px solid #26262b;color:#d8d8de;vertical-align:top}
.shot{background:#000;border:1px solid #3a3a42;display:block}
.spr{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end}
.spr figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px;font:10px 'JetBrains Mono',monospace;color:#a2a2ab;text-align:center;min-width:70px}
.spr img{height:56px;width:auto;image-rendering:pixelated}
.demo{border:1px solid #26262b;padding:16px;display:flex;flex-direction:column;gap:14px;position:static}
"""
fonts = ("<link rel='preconnect' href='https://fonts.googleapis.com'>"
         "<link href='https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Silkscreen:wght@400;700&family=Inter:wght@400;500;600&display=swap' rel='stylesheet'>")

n = [0]


def page(inner, title=""):
    n[0] += 1
    return f'<section class="pg">{inner}<div class="foot2"><span>stuffcloud design system</span><span>{title} · {n[0]}</span></div></section>'


parts = []
# cover
parts.append(page(f"""<div style="display:flex;flex:1;gap:40px;align-items:center">
<div style="flex:1;display:flex;flex-direction:column;gap:18px"><img src="logo.svg" alt="" style="width:84px;height:42px"><h1 style="font-size:68px;font-family:'Silkscreen',monospace;letter-spacing:1px;line-height:1.1">stuffcloud<br>design<br>system</h1><p class="eyebrow2">november 2026 · GPL-3.0-or-later</p></div>
<div style="flex:0 0 120mm;height:150mm;background-color:#8b5cf6;background-image:linear-gradient(rgba(16,16,18,.18) 1px,transparent 1px),linear-gradient(90deg,rgba(16,16,18,.18) 1px,transparent 1px);background-size:50px 50px;position:relative;overflow:hidden">
<img src="axo.svg" alt="" style="position:absolute;left:50%;bottom:0;width:300px;margin-left:-150px"><img src="doc.svg" alt="" style="position:absolute;left:30px;top:90px;width:70px;transform:rotate(-8deg)"><img src="globe.svg" alt="" style="position:absolute;right:40px;top:60px;width:64px;transform:rotate(10deg)"><img src="mtn.svg" alt="" style="position:absolute;left:150px;top:40px;width:90px;transform:rotate(6deg)"></div></div>""", "cover"))

toc = ["Principles", "Colors", "Typography", "Layout and spacing", "Components", "Pixel art: stickers and mascots", "Seasonal decorations and theme button", "Motion, accessibility, responsive", "Page inventory", "Examples: desktop", "Examples: mobile", "License and sources"]
parts.append(page("<h1>Contents</h1><ul style='margin-top:10px;gap:11px'>" + "".join(f"<li style='font-size:17px'>{t}</li>" for t in toc) + "</ul>", "contents"))

parts.append(page("""<p class="eyebrow2">1 · principles</p><h1>Principles</h1>
<div class="cols" style="margin-top:8px"><ul>
<li><b>Grid look.</b> Thin 1 px lines divide the page into cells; one coloured grid panel carries the mascot and stickers.</li>
<li><b>Dark only.</b> Near-black background, white text. Colour comes from the pink and violet accents and from the pixel art.</li>
<li><b>Palette.</b> Pink and violet for surfaces and accents. Stickers keep their own bright colours (blue, green, yellow, red) so tool categories stay recognisable.</li>
<li><b>Mascot.</b> Stuffy, a pink pixel axolotl, plus a cast of extra animals. None of them ever speaks: no speech bubbles.</li>
</ul><ul>
<li><b>No filler copy.</b> Pages carry labels, state and data only, no marketing text.</li>
<li><b>Motion is small.</b> The mascot bobs in two steps; everything stops under reduced-motion.</li>
<li><b>Accessible by default.</b> WCAG 2.2 AA contrast, visible focus, touch targets of at least 44 px (48 px for icon buttons), real form controls and labels.</li>
<li><b>Two languages.</b> German and English from the start; fonts are self-hosted in the real app.</li>
</ul></div>""", "principles"))

sw = "".join(f'<div class="sw"><i style="background:{h}"></i><div><b>{nm}</b>{h} · {us}<br>{ratio(h, fg2):.1f} : 1 with {"light" if fg2 != BG else "dark"} text</div></div>' for nm, h, us, fg2 in COLORS)
extra = [("#f4f4f0", BG, "text on background"), ("#a2a2ab", BG, "muted text on background"), ("#ff79b0", BG, "pink on background"), ("#c78bff", BG, "lilac on background"), (BG, "#f4f4f0", "dark text on solid button")]
rows = "".join(f"<tr><td>{d}</td><td>{a} on {b}</td><td>{ratio(a, b):.1f} : 1</td><td>{'AA' if ratio(a, b) >= 4.5 else 'large text only'}</td></tr>" for a, b, d in extra)
parts.append(page(f"""<p class="eyebrow2">2 · colors</p><h1>Colors</h1>
<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">{sw}</div>
<table class="t" style="margin-top:6px"><thead><tr><th>Pair</th><th>Colors</th><th>Ratio</th><th>WCAG</th></tr></thead><tbody>{rows}</tbody></table>""", "colors"))

parts.append(page("""<p class="eyebrow2">3 · typography</p><h1>Typography</h1>
<div class="cols" style="margin-top:6px">
<div style="display:flex;flex-direction:column;gap:14px;border:1px solid #26262b;padding:16px"><h3>Silkscreen · pixel</h3><div style="font:700 40px 'Silkscreen',monospace;line-height:1.1">stuffcloud Small tools.</div><p>Wordmark and console-style headings. Never for body text. Open Font License (verify when self-hosting).</p></div>
<div style="display:flex;flex-direction:column;gap:14px;border:1px solid #26262b;padding:16px"><h3>JetBrains Mono · labels and code</h3><div style="font:500 28px 'JetBrains Mono',monospace;line-height:1.2">k3x9q2mf.sites.test<br>000-000</div><p>Labels (12 px, capitals, letter-spacing 1 px), addresses, code, numbers. Open Font License.</p></div>
<div style="display:flex;flex-direction:column;gap:14px;border:1px solid #26262b;padding:16px"><h3>Inter · interface and text</h3><div style="font:500 34px 'Inter',sans-serif;line-height:1.15;letter-spacing:-.8px">Your stuff, in your cloud.</div><p>Headings, buttons, long text. Open Font License.</p></div></div>
<table class="t" style="margin-top:8px"><thead><tr><th>Role</th><th>Desktop</th><th>Mobile</th><th>Weight</th></tr></thead><tbody>
<tr><td>Page title</td><td>48 px, line 1.05, -1.2 px</td><td>36 px</td><td>500</td></tr><tr><td>Section title</td><td>28 px</td><td>28 px</td><td>500</td></tr>
<tr><td>Body</td><td>15 to 16 px, line 1.5 to 1.7</td><td>15 px</td><td>400</td></tr><tr><td>Label</td><td>12 px mono, capitals</td><td>12 px</td><td>400</td></tr>
<tr><td>Input text</td><td>15 px mono</td><td>16 px (no zoom on iOS)</td><td>400</td></tr></tbody></table>""", "typography"))

parts.append(page("""<p class="eyebrow2">4 · layout and spacing</p><h1>Layout and spacing</h1>
<div class="cols" style="margin-top:6px"><ul>
<li><b>Frame.</b> One column, maximum width 1240 px, 1 px lines left and right. Header 64 px (56 px on mobile) with the wordmark cell, navigation cells and a right cell.</li>
<li><b>Cells.</b> Content areas are separated by 1 px lines (#26262b), not by shadows or boxes. Tool and template grids use cells of at least 280 px.</li>
<li><b>Split pages.</b> Main area plus a 360 px side column (settings, actions) with a violet grid panel at its foot.</li>
<li><b>Grid panel.</b> Violet #8b5cf6 with 65 px grid lines (32 px on mobile) and two or three translucent blocks. The mascot sits on its bottom edge, stickers are scattered above with a white outline.</li>
</ul><ul>
<li><b>Breakpoint.</b> One breakpoint at 760 px. Below it: menu button instead of navigation, single column, tables become cards, buttons stack, tab bars scroll with a fade.</li>
<li><b>Spacing scale.</b> 4, 8, 10, 12, 16, 20, 24, 28, 32, 40, 56 px. Page padding 40 px (16 px mobile).</li>
<li><b>Touch targets.</b> At least 44 px; icon buttons 48 px; fields 52 px; main buttons 52 to 56 px.</li>
<li><b>Footer.</b> Mono line with license and links, pinned at the page end.</li>
</ul></div>""", "layout"))

# components
parts.append(page("""<p class="eyebrow2">5 · components</p><h1>Buttons, fields, choices</h1>
<div class="demo"><h3>Buttons</h3><div style="display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="#">Solid</a><a class="btn btn-ghost" href="#">Ghost</a><button class="btn btn-danger" type="button">Danger</button><button class="btn" disabled type="button">Disabled</button><button class="btn btn-ghost btn-icon" type="button" aria-label="Remove"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l10 10M13 3L3 13"/></svg></button></div></div>
<div class="cols"><div class="demo"><h3>Field and select</h3><div class="fld"><label class="label" for="a1">E-mail</label><input class="field" id="a1" value="name@example.org"></div><div class="fld"><label class="label" for="a2">Domain</label><select class="field" id="a2"><option>sites.test · internal</option></select></div></div>
<div class="demo"><h3>Choice chips and toggles</h3><div class="row"><label style="position:relative"><input class="opt" type="radio" name="x"><span class="box">1d</span></label><label style="position:relative"><input class="opt" type="radio" name="x" checked><span class="box">7d</span></label><label style="position:relative"><input class="opt" type="radio" name="x" disabled><span class="box">forever</span></label></div><label class="toggle"><input type="checkbox" checked>Burn after reading</label></div></div>
<p>Buttons are rectangular, never rounded. Hover turns the solid button pink. Selected chips get a pink border. The danger button is the only filled pink.</p>""", "components 1"))

parts.append(page("""<p class="eyebrow2">5 · components</p><h1>Lists, tables, tabs, feedback</h1>
<div class="cols"><div class="demo"><h3>List with row actions</h3><ul class="list"><li><div class="grow">invoice-2026-10.pdf<div class="mono mut" style="font-size:11px">2 pages · 148 KB</div></div><button class="btn btn-ghost" style="min-height:40px;padding:0 14px" type="button">Remove</button></li><li><div class="grow">contract-signed.pdf<div class="mono mut" style="font-size:11px">12 pages · 1.4 MB</div></div><button class="btn btn-ghost" style="min-height:40px;padding:0 14px" type="button">Remove</button></li></ul></div>
<div class="demo"><h3>Tabs and badges</h3><div class="tabs" style="border:1px solid #26262b"><a href="#" aria-current="page">Merge</a><a href="#">Split</a><a href="#">Compress</a></div><div class="row"><span class="badge"><i class="dot"></i>LAN</span><span class="badge"><i class="dot pink"></i>Public</span><span class="badge"><i class="dot amber"></i>invited</span><span class="badge"><i class="dot gray"></i>disabled</span></div></div></div>
<div class="cols"><div class="demo"><h3>Table (cards on mobile)</h3><table class="tbl"><thead><tr><th>Address</th><th>Expires</th><th>Size</th></tr></thead><tbody><tr><td class="mono" style="color:#c78bff">k3x9q2mf.sites.test</td><td>in 7 days</td><td class="mono">1.2 MB</td></tr><tr><td class="mono" style="color:#c78bff">notes-m4r7.example.org</td><td>never</td><td class="mono">12 KB</td></tr></tbody></table></div>
<div class="demo"><h3>Stats, bar, alerts</h3><div class="stats"><div><span class="label">Sites</span><b>12</b></div><div><span class="label">Storage</span><b>1.2 GB</b><span class="bar"><i style="width:24%"></i></span></div></div><div style="border:1px solid #ff4f8b;background:#2a0f1a;padding:10px 12px;font-size:13px">That code is not valid. 2 attempts left.</div><div style="border:1px solid #ffb000;background:#2a200a;padding:10px 12px;font-size:13px">You used 5.0 of 5 GB.</div></div></div>""", "components 2"))

parts.append(page("""<p class="eyebrow2">5 · components</p><h1>Special components</h1>
<div class="cols"><div class="demo"><h3>Two-factor code: 000-000</h3><div style="display:flex;align-items:center;gap:6px"><span class="cell" style="width:42px;height:54px;border:1px solid #3a3a42;display:flex;align-items:center;justify-content:center;font:26px 'JetBrains Mono',monospace;padding:0;flex-direction:row">4</span><span class="cell" style="width:42px;height:54px;border:1px solid #3a3a42;display:flex;align-items:center;justify-content:center;font:26px 'JetBrains Mono',monospace;padding:0;flex-direction:row">8</span><span class="cell" style="width:42px;height:54px;border:1px solid #3a3a42;display:flex;align-items:center;justify-content:center;font:26px 'JetBrains Mono',monospace;padding:0;flex-direction:row">1</span><span style="width:16px;height:2px;background:#a2a2ab;margin:0 10px"></span><span class="cell" style="width:42px;height:54px;border:1px solid #3a3a42;display:flex;align-items:center;justify-content:center;font:26px 'JetBrains Mono',monospace;padding:0;flex-direction:row;color:#3a3a42">0</span><span class="cell" style="width:42px;height:54px;border:1px solid #3a3a42;display:flex;align-items:center;justify-content:center;font:26px 'JetBrains Mono',monospace;padding:0;flex-direction:row;color:#3a3a42">0</span><span class="cell" style="width:42px;height:54px;border:1px solid #3a3a42;display:flex;align-items:center;justify-content:center;font:26px 'JetBrains Mono',monospace;padding:0;flex-direction:row;color:#3a3a42">0</span></div><p>Six cells grouped 3 + 3 over one real input, so paste, autofill and screen readers keep working.</p></div>
<div class="demo"><h3>QR code styles</h3><div style="display:flex;gap:16px;align-items:flex-end"><figure style="margin:0;font:11px 'JetBrains Mono',monospace;color:#a2a2ab;text-align:center"><img src="qr.svg" alt="" style="width:110px;height:110px;filter:grayscale(1) contrast(3)"><br>raw</figure><figure style="margin:0;font:11px 'JetBrains Mono',monospace;color:#a2a2ab;text-align:center"><span style="position:relative;display:inline-block;width:110px;height:110px"><img src="qr.svg" alt="" style="width:110px;height:110px"><span style="position:absolute;left:50%;top:50%;width:44px;height:34px;margin:-17px 0 0 -22px;background:#fff;display:flex;align-items:center;justify-content:center"><img src="axo.svg" alt="" style="width:36px;height:auto"></span></span><br>stuffcloud</figure></div><p>Raw: black on white. stuffcloud: violet modules, magenta finder squares, mascot in the centre; needs error-correction level H and an automatic scan test, otherwise falls back to raw. PNG (1024 px) and SVG download.</p></div></div>
<div class="demo"><h3>Destructive action</h3><p>Delete site: a dialog with a typed confirmation of the subdomain; the pink button stays disabled until the text matches. The mascot sits on the dialog's top edge.</p></div>""", "components 3"))

# pixel art
st = "".join(f'<figure><img src="{f}.svg" alt=""><span>{nm}</span></figure>' for f, nm in STICKERS)
an = "".join(f'<tr><td><img src="{f}.svg" alt="" style="height:34px;width:auto"></td><td><b style="color:#f4f4f0">{nm}</b></td><td>{k}</td><td>{w}</td></tr>' for f, nm, k, w in ANIMALS)
parts.append(page(f"""<p class="eyebrow2">6 · pixel art</p><h1>Stickers and mascots</h1>
<div class="demo"><h3>Tool stickers (outlined in white when placed on the panel)</h3><div class="spr">{st}</div></div>
<table class="t"><thead><tr><th></th><th>Name</th><th>Animal</th><th>Easter egg trigger</th></tr></thead><tbody>{an}</tbody></table>""", "pixel art 1"))

STICKER_GROUPS = [("PDF", "pdf-merge pdf-split pdf-rotate pdf-compress pdf-protect"), ("Images", "img-resize img-crop img-convert img-background img-pixel img-exif"),
                  ("Convert", "json yaml xml base64 colour units"), ("Time and agents", "cron timestamp useragent"), ("Network", "subnet mac"),
                  ("Text and generators", "lorem uuid qr diff textops"), ("Dev", "hash password regex url jwt markdown sql"),
                  ("Hosting and misc", "paste site expiry report shield trash download burn")]
_listed = {k for _, ks in STICKER_GROUPS for k in ks.split()}
_all = sorted(f[8:-4] for f in os.listdir(WORK) if f.startswith("sticker-") and f.endswith(".svg"))
_extra = [k for k in _all if k not in _listed]
if _extra:
    STICKER_GROUPS.append(("Other", " ".join(_extra)))
sg = "".join(f'<div class="demo" style="padding:8px 12px;gap:6px"><h3>{g}</h3><div class="spr" style="gap:8px;align-items:flex-end">' + "".join(f'<figure><img src="sticker-{k}.svg" alt="" style="height:30px"><span>{k}</span></figure>' for k in ks.split()) + "</div></div>" for g, ks in STICKER_GROUPS)
parts.append(page(f"""<p class="eyebrow2">6 · pixel art</p><h1 style="font-size:34px">Tool stickers, one per tool</h1><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">{sg}</div>""", "pixel art 2"))

parts.append(page("""<p class="eyebrow2">6 · pixel art</p><h1>Rules for pixel art</h1>
<div class="cols"><ul>
<li><b>One character = one pixel.</b> Sprites are ASCII art plus a palette, turned into SVG by <span class="mono">docs/design/tools/mascots.py</span>, <span class="mono">seasons.py</span> and <span class="mono">stickers.py</span>.</li>
<li><b>Crisp.</b> SVG with <span class="mono">shape-rendering: crispEdges</span>; integer scaling where possible.</li>
<li><b>Friendly.</b> Small dark eyes, pink cheeks, soft colours; no pupil-less white eyes, no large dark masses (the first cat and penguin looked unfriendly).</li>
<li><b>Silent.</b> No speech bubbles; mascots express with pose only.</li>
</ul><ul>
<li><b>Outline.</b> Stickers on the violet panel get a 2 px white outline (drop-shadow in four directions).</li>
<li><b>Tilt.</b> Stickers rotate between -12 and +10 degrees for a scattered look.</li>
<li><b>Motion.</b> Two-step bob (4 px up and down every 1.2 s), paused under reduced-motion.</li>
<li><b>License.</b> Original art, GPL-3.0-or-later like the code.</li>
</ul></div>""", "pixel art 3"))

# seasons
rows = "".join(f"<tr><td><b style='color:#f4f4f0'>{nm}</b></td><td>{WINDOWS.get(nm, '')}</td><td>{' '.join(facts[:1])}</td></tr>" for nm, facts in THEMES)
parts.append(page(f"""<p class="eyebrow2">7 · seasons</p><h1>Seasonal decorations</h1>
<table class="t"><thead><tr><th>Set</th><th>Window (Germany)</th><th>Theme button text</th></tr></thead><tbody>{rows}</tbody></table>""", "seasons 1"))
parts.append(page("""<p class="eyebrow2">7 · seasons</p><h1>How decorations work</h1>
<div class="cols"><ul>
<li>Classes on an ancestor (<span class="mono">html</span> in production), for example <span class="mono">s-christmas s-advent-3</span>. No page needs changes.</li>
<li>Up to four parts: a few randomly scattered particles drifting slowly <b>behind</b> the content, a strip under the header or above the footer, a corner sprite, and an accessory on Stuffy. Extra animals wear the same accessory, scaled per animal.</li>
<li><b>Spring and summer have no decoration.</b></li>
<li>Priority: special days beat holidays, holidays beat seasons. Dec 6 and Dec 10 override Christmas; Advent adds the wreath on top of Christmas.</li>
</ul><ul>
<li>Moving dates are computed: Easter by the usual rule, Weiberfastnacht = Easter minus 52 days, Shrove Tuesday = Easter minus 47, Advent = the four Sundays before Dec 25 (one more candle per Sunday).</li>
<li><b>Theme button.</b> A small pill with the theme icon and name in the bottom right corner opens a card with a few positive facts and a switch to hide decorations. Built with details/summary, so it works without script; closes with Escape.</li>
<li>Admin setting: auto by date, fixed set, or off. Visitors can switch decorations off. Never blocks content, takes no focus, stands still under reduced-motion.</li>
</ul></div>""", "seasons 2"))

parts.append(page("""<p class="eyebrow2">8 · motion, accessibility, responsive</p><h1>Motion, accessibility, responsive</h1>
<div class="cols"><ul>
<li><b>Motion.</b> Mascot bob, easter eggs and decoration particles only; all disabled under <span class="mono">prefers-reduced-motion</span>.</li>
<li><b>Contrast.</b> Text 4.5 : 1 or more on its background (see the colors page). Muted grey is used only for labels and hints.</li>
<li><b>Keyboard.</b> Everything reachable and operable; focus is a 2 px white outline with 2 px offset; dialogs trap focus and close with Escape.</li>
<li><b>Forms.</b> Every control has a visible label (or an accessible name for icon buttons); errors use role=alert and are not colour-only.</li>
</ul><ul>
<li><b>Decorative images</b> (stickers, strips) have empty alt text; the mascot has a name as alt text.</li>
<li><b>Mobile.</b> Single column below 760 px, 16 px page padding, 16 px input text, menu button, tables as cards, action buttons on one row, tab bars scroll with a fade.</li>
<li><b>Performance.</b> Pixel art is SVG, a few hundred bytes each; heavy tool assets load lazily.</li>
<li><b>Privacy.</b> No trackers, no stored IP addresses.</li>
</ul></div>""", "a11y"))

# inventory
inv = "".join(f"<tr><td class='mono'>{f}</td><td>{t}</td><td class='mono'>{m or 'same file'}</td></tr>" for f, t, m in PAGES)
half = len(PAGES) // 2 + 1
rows1 = "".join(f"<tr><td class='mono'>{f}</td><td>{t}</td><td class='mono'>{m or 'same file'}</td></tr>" for f, t, m in PAGES[:half])
rows2 = "".join(f"<tr><td class='mono'>{f}</td><td>{t}</td><td class='mono'>{m or 'same file'}</td></tr>" for f, t, m in PAGES[half:])
parts.append(page(f"""<p class="eyebrow2">9 · inventory</p><h1>Page inventory</h1>
<div class="cols"><table class="t"><thead><tr><th>File</th><th>Page</th><th>Mobile</th></tr></thead><tbody>{rows1}</tbody></table><table class="t"><thead><tr><th>File</th><th>Page</th><th>Mobile</th></tr></thead><tbody>{rows2}</tbody></table></div>""", "inventory"))

# examples desktop
parts.append(page("<p class='eyebrow2'>10 · examples</p><h1>Examples: desktop</h1><p>All pages at 1280 px width, rendered from the mockups in <span class='mono'>docs/design/prototypes</span>.</p>", "examples desktop"))
from PIL import Image
for f, t, m in PAGES:
    im = Image.open(os.path.join(OUT, "desktop", f + ".png"))
    w, h = im.size
    cuts = [(0, h)] if h <= 1150 else []
    if not cuts:
        y = 0
        while y < h:
            end = min(y + 1000, h)
            if h - end < 300:
                end = h
            cuts.append((y, end))
            y = end
    for k, (a, b2) in enumerate(cuts):
        name = f if len(cuts) == 1 else f"{f}_p{k + 1}"
        if len(cuts) > 1:
            im.crop((0, a, w, b2)).save(os.path.join(OUT, "desktop", name + ".png"))
        part = "" if len(cuts) == 1 else f" · part {k + 1} of {len(cuts)}"
        parts.append(page(f"""<div style="display:flex;justify-content:space-between;align-items:baseline"><h2>{t}</h2><span class="eyebrow2">{f} · desktop 1280 px{part}</span></div>
<div style="flex:1;min-height:0;display:flex;align-items:flex-start;justify-content:center"><img class="shot" src="out/desktop/{name}.png" alt="{t}" style="max-width:100%;max-height:150mm;object-fit:contain"></div>""", t))

# examples mobile sheets
parts.append(page("<p class='eyebrow2'>11 · examples</p><h1>Examples: mobile</h1><p>First screen (390 x 844 px) of every page. The full pages are in the design canvas.</p>", "examples mobile"))
for i in range(0, len(PAGES), 4):
    grp = PAGES[i:i + 4]
    cells = "".join(f'<figure style="margin:0;display:flex;flex-direction:column;gap:6px;align-items:center"><img class="shot" src="out/mobile/{f}.png" alt="{t}" style="height:150mm;width:auto"><figcaption class="eyebrow2">{t} · {f}</figcaption></figure>' for f, t, m in grp)
    parts.append(page(f'<div style="display:flex;gap:18px;justify-content:center;align-items:flex-start;margin-top:4px">{cells}</div>', "mobile"))

parts.append(page("""<p class="eyebrow2">12 · license and sources</p><h1>License and sources</h1>
<ul style="margin-top:8px"><li>Design, pixel art, stickers, mascots and decoration sprites: GPL-3.0-or-later, like the project.</li>
<li>Fonts: Silkscreen, JetBrains Mono and Inter, all under the SIL Open Font License; self-hosted in the real app (verify license files when adding them).</li>
<li>The third-party screenshots used as a mood reference at the start are not included.</li>
<li>Source files: <span class="mono">docs/design/</span> in the repository (README, THEME-TEXTS.md, prototypes, sprite tools). Mockups open in a Design canvas and are references to build from, not production code.</li></ul>""", "license"))

html = f"<!doctype html><html lang='en'><head><meta charset='utf-8'><title>stuffcloud design system</title><link rel='stylesheet' href='stuff.css'><style>{css}</style>{fonts}</head><body>{''.join(parts)}</body></html>"
bp = os.path.join(HERE, "book.html")
open(bp, "w", encoding="utf-8").write(html)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=chrome_path(), headless=True)
    pg = b.new_page(viewport={"width": 1123, "height": 794})
    pg.goto("file:///" + bp.replace("\\", "/"))
    try:
        pg.wait_for_load_state("networkidle", timeout=10000)
    except Exception:
        pass
    pg.wait_for_timeout(800)
    pg.pdf(path=PDF, width="297mm", height="210mm", print_background=True, margin={"top": "0", "right": "0", "bottom": "0", "left": "0"})
    b.close()
print("pages", n[0])
