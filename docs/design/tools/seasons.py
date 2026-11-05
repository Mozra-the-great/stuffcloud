"""Generates the seasonal decoration sprites (accessories, particle tiles, strips) as SVG files."""
import os
import sys

OUT = sys.argv[1]


def svg(name, rows, pal):
    w = len(rows[0])
    bad = [(i, len(r)) for i, r in enumerate(rows) if len(r) != w]
    if bad:
        sys.exit(f"{name}: width mismatch {bad} (expected {w})")
    paths = {}
    for y, row in enumerate(rows):
        x = 0
        while x < w:
            c = row[x]
            if c == ".":
                x += 1
                continue
            s = x
            while x < w and row[x] == c:
                x += 1
            paths.setdefault(c, []).append(f"M{s} {y}h{x - s}v1h-{x - s}z")
    body = "".join(f'<path fill="{pal[c]}" d="{"".join(p)}"/>' for c, p in paths.items())
    doc = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {len(rows)}" shape-rendering="crispEdges">{body}</svg>\n'
    with open(os.path.join(OUT, name + ".svg"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(doc)
    print(name, w, len(rows))


def canvas(w, h):
    return [["."] * w for _ in range(h)]


def stamp(cv, sprite, x, y, remap=None):
    for dy, row in enumerate(sprite):
        for dx, c in enumerate(row):
            if c != "." and 0 <= y + dy < len(cv) and 0 <= x + dx < len(cv[0]):
                cv[y + dy][x + dx] = (remap or {}).get(c, c)


def rows(cv):
    return ["".join(r) for r in cv]


# ---- accessories for Stuffy (units = axolotl pixels) -------------------------
svg("deco-santa", [
    ".....RWW.",
    "...RRRRR.",
    "..RRRRRRR",
    ".RRRRRRRR",
    "WWWWWWWWW",
    ".WWWWWWW.",
], {"R": "#e8321e", "W": "#ffffff"})
svg("deco-beanie", [
    "....W....",
    "..BBBBB..",
    ".BBBBBBB.",
    ".BBBBBBB.",
    "WWWWWWWWW",
], {"B": "#4f8cff", "W": "#ffffff"})
svg("deco-bunnyears", [
    ".WW..WW.",
    ".WP..PW.",
    ".WP..PW.",
    ".WW..WW.",
    "PPPPPPPP",
], {"W": "#ffffff", "P": "#ff9ec4"})
svg("deco-leaf", [
    "..O..",
    ".OOO.",
    "OOROO",
    ".OOO.",
    "..B..",
], {"O": "#ff7a1a", "R": "#e8321e", "B": "#8a4a2a"})
svg("deco-witch", [
    "....K....",
    "...KKK...",
    "..KKKKK..",
    "..KOOOK..",
    ".KKKKKKK.",
    "KKKKKKKKK",
], {"K": "#3a2a5a", "O": "#ff9a1a"})
svg("deco-apple", [
    "..BG.",
    ".RRR.",
    "RWRRR",
    "RRRRR",
    ".RRR.",
], {"R": "#e8321e", "B": "#8a4a2a", "G": "#3ddc84", "W": "#ff9a8a"})

# ---- particle tiles (80 x 80 units, tiled twice with different sizes by CSS) ------
import random


def scatter(name, sprites, pal, seed, count, size=80, gap=14):
    rnd = random.Random(seed)
    cv = canvas(size, size)
    placed = []
    tries = 0
    while len(placed) < count and tries < 4000:
        tries += 1
        sp, remap = rnd.choice(sprites)
        h, w = len(sp), len(sp[0])
        x, y = rnd.randrange(0, size - w), rnd.randrange(0, size - h)
        if any(abs(x - px) < gap and abs(y - py) < gap for px, py in placed):
            continue
        placed.append((x, y))
        stamp(cv, sp, x, y, remap)
    svg(name, rows(cv), pal)


plus = [".W.", "WWW", ".W."]
scatter("deco-snow", [(plus, None), (plus, None), (["W"], None), (["W"], None), (["W"], None), (["WW", "WW"], None)], {"W": "#eaf5ff"}, 11, 6)
leaf = [".O.", "OOO", ".R."]
scatter("deco-leaves", [(leaf, {"R": "B"}), (leaf, {"O": "Y", "R": "B"}), (leaf, {"O": "R", "R": "B"})],
        {"O": "#ff7a1a", "Y": "#ffd23f", "R": "#e8321e", "B": "#8a4a2a"}, 23, 4)
bat = ["K.....K", "KK.K.KK", ".KKKKK.", "..K.K.."]
scatter("deco-bats", [(bat, None)], {"K": "#7a5ac8"}, 31, 2, gap=26)

# ---- horizontal strips ---------------------------------------------------------
cv = canvas(24, 8)
for x in range(24):
    cv[0][x] = "K"
for x, c in [(3, "R"), (11, "G"), (19, "Y")]:
    stamp(cv, ["K.", "RR", "RR", ".R"], x, 0, {"R": c})
svg("deco-garland", rows(cv), {"K": "#5a5a64", "R": "#ff4f4f", "G": "#3ddc84", "Y": "#ffd23f"})

svg("deco-icicles", [
    "WWWWWWWWWWWWWWWW",
    "WWW.WW..WWW.WW..",
    ".W..WW...W..W...",
    ".W...W...W......",
    ".........W......",
], {"W": "#cfe8ff"})

cv = canvas(32, 7)
egg = ["..EE..", ".EEEE.", "EEPPEE", "EEEEEE", "EYYYYE", ".EEEE.", "..EE.."]
stamp(cv, egg, 2, 0)
stamp(cv, egg, 13, 0, {"E": "F", "P": "Q", "Y": "Z"})
stamp(cv, egg, 24, 0, {"E": "G", "P": "H", "Y": "I"})
svg("deco-eggs", rows(cv), {"E": "#ff9ec4", "P": "#ffffff", "Y": "#ffd23f", "F": "#8fdcff", "Q": "#ffffff", "Z": "#ff79b0", "G": "#c78bff", "H": "#ffffff", "I": "#ffd23f"})

cv = canvas(32, 6)
for x in range(32):
    cv[5][x] = "D"
    cv[4][x] = "ORYO"[x % 4] if x % 3 else "D"
    if x % 5 == 0:
        cv[3][x] = "YOR"[(x // 5) % 3]
svg("deco-leafpile", rows(cv), {"D": "#8a4a2a", "O": "#ff7a1a", "R": "#e8321e", "Y": "#ffd23f"})

cv = canvas(32, 8)
pump = ["....G....", "..OOGOO..", ".OOOOOOO.", "OOKOOOKOO", "OOOOKOOOO", ".OKKKKKO.", "..OOOOO.."]
stamp(cv, pump, 3, 1)
stamp(cv, pump, 20, 1)
stamp(cv, ["..G..", ".OOO.", "OOOOO", ".OOO."], 13, 4)
svg("deco-pumpkins", rows(cv), {"O": "#ff7a1a", "G": "#3ddc84", "K": "#2b1a14"})

cv = canvas(36, 8)
stamp(cv, ["..BG.", ".RRR.", "RWRRR", "RRRRR", ".RRR."], 2, 3)
stamp(cv, ["..Y..", ".YYY.", "..Y..", ".YYY.", "..Y..", "..B..", "..B.."], 10, 1)
stamp(cv, ["..G..", ".OOO.", "OOOOO", "OOOOO", ".OOO."], 16, 3)
stamp(cv, ["..BG.", ".RRR.", "RWRRR", "RRRRR", ".RRR."], 25, 3)
stamp(cv, ["..Y..", ".YYY.", "..Y..", ".YYY.", "..Y..", "..B..", "..B.."], 31, 1)
svg("deco-harvest", rows(cv), {"R": "#e8321e", "B": "#8a4a2a", "G": "#3ddc84", "W": "#ff9a8a", "Y": "#ffd23f", "O": "#ff7a1a"})

# hanging spider and sun
sp = ["...G..." for _ in range(9)] + ["..KKK..", ".KKKKK.", "K.KKK.K", "..K.K.."]
svg("deco-spider", sp, {"G": "#aaaab4", "K": "#7a5ac8"})

# ============================ special days (second batch) ============================
svg("deco-partyhat", [
    "...Y...",
    "...G...",
    "..GGG..",
    ".GBGBG.",
    "GGGGGGG",
], {"Y": "#ffffff", "G": "#ffd23f", "B": "#ff79b0"})
svg("deco-jester", [
    "Y.........Y",
    "RR.......BB",
    ".RRR...BBB.",
    "..RRRPBBB..",
    "YYYYYYYYYYY",
], {"Y": "#ffd23f", "R": "#ff4f8b", "B": "#4f8cff", "P": "#ffffff"})
svg("deco-heart", [
    ".RR.RR.",
    "RWRRRRR",
    "RRRRRRR",
    ".RRRRR.",
    "..RRR..",
    "...R...",
], {"R": "#ff4f8b", "W": "#ffb3cf"})
svg("deco-rainbow", [
    "...RRRRR...",
    "..RYYYYYR..",
    ".RYGGGGGYR.",
    "RYGBBBBBGYR",
    "RYGB...BGYR",
], {"R": "#ff4f4f", "Y": "#ffd23f", "G": "#3ddc84", "B": "#4f8cff"})
svg("deco-violet", [
    "..V..",
    ".VVV.",
    "VVYVV",
    ".VVV.",
    "..V..",
], {"V": "#b06cff", "Y": "#ffd23f"})
svg("deco-sprout", [
    "GG.GG",
    "GGSGG",
    "..S..",
    "..S..",
], {"G": "#3ddc84", "S": "#2a9d5c"})
svg("deco-eucrown", [
    "Y.Y.Y.Y.Y",
    ".Y.Y.Y.Y.",
    "BBBBBBBBB",
], {"Y": "#ffd23f", "B": "#2a5fc8"})
svg("deco-flagband", [
    "KKKKKKKKK",
    "RRRRRRRRR",
    "GGGGGGGGG",
], {"K": "#1a1a1a", "R": "#e8321e", "G": "#ffcc00"})
svg("deco-dove", [
    "...WW..",
    "..WWWKO",
    "WWWWWW.",
    ".WWWWW.",
    "..W.W..",
], {"W": "#ffffff", "K": "#101012", "O": "#ffb02e"})
svg("deco-mitre", [
    "...Y...",
    "..RYR..",
    ".RRRRR.",
    "RRRRRRR",
    "YYYYYYY",
], {"R": "#e8321e", "Y": "#ffd23f"})

# corner sprites
cv = canvas(11, 11)
cv[5][5] = "W"
for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)]:
    for k, c in ((2, "Y"), (3, "P"), (4, "C")):
        x, y = 5 + dx * k, 5 + dy * k
        if 0 <= x < 11 and 0 <= y < 11:
            cv[y][x] = c
svg("deco-fireworks", rows(cv), {"W": "#ffffff", "Y": "#ffd23f", "P": "#ff79b0", "C": "#8fdcff"})

for n in range(1, 5):
    cv = canvas(17, 11)
    for i in range(4):
        x = 2 + 4 * i
        for y in range(4, 8):
            cv[y][x] = cv[y][x + 1] = "R"
        if i < n:
            cv[2][x] = "Y"
            cv[3][x] = "Y"
            cv[2][x + 1] = "O"
    for x in range(1, 16):
        cv[8][x] = "G"
    for x in range(17):
        cv[9][x] = "G"
    for x in range(1, 16):
        cv[10][x] = "G"
    for x in (3, 9, 14):
        cv[9][x] = "B"
    svg(f"deco-advent-{n}", rows(cv), {"R": "#e8321e", "Y": "#ffd23f", "O": "#ff9a1a", "G": "#2a9d5c", "B": "#ff4f4f"})

svg("deco-venus", [
    "..VVVVV..",
    ".VV...VV.",
    "VV.....VV",
    "V.......V",
    "VV.....VV",
    ".VV...VV.",
    "..VVVVV..",
    "....V....",
    "....V....",
    "..VVVVV..",
    "....V....",
], {"V": "#b06cff"})

cv = canvas(15, 11)
for y in range(11):
    for x in range(15):
        cv[y][x] = "B"
import math
for k in range(12):
    a = k * math.pi / 6
    x, y = round(7 + 3.6 * math.sin(a)), round(5 - 3.6 * math.cos(a))
    cv[y][x] = "Y"
svg("deco-euflag", rows(cv), {"B": "#2a5fc8", "Y": "#ffd23f"})

cv = canvas(11, 11)
for y in range(11):
    for x in range(11):
        if (x - 5) ** 2 + (y - 5) ** 2 <= 22:
            cv[y][x] = "B"
for x, y in [(3, 3), (4, 3), (3, 4), (6, 6), (7, 6), (6, 7), (7, 7), (7, 3), (2, 6), (3, 7)]:
    cv[y][x] = "G"
svg("deco-earth", rows(cv), {"B": "#4f8cff", "G": "#3ddc84"})

# strips
cv = canvas(32, 6)
for x, y in [(3, 1), (14, 0), (25, 2)]:
    stamp(cv, [".Y.", "YYY", ".Y."], x, y)
for x, y in [(9, 4), (20, 4), (30, 0), (1, 5)]:
    stamp(cv, ["Y"], x, y)
svg("deco-sparks", rows(cv), {"Y": "#ffd23f"})

cv = canvas(24, 8)
for x in range(24):
    cv[0][x] = "K"
for x, c in [(1, "P"), (9, "Y"), (17, "B")]:
    stamp(cv, ["FFFFF", ".FFF.", "..F.."], x, 1, {"F": c})
svg("deco-bunting", rows(cv), {"K": "#5a5a64", "P": "#ff79b0", "Y": "#ffd23f", "B": "#4f8cff"})

cv = canvas(24, 8)
for x in range(24):
    cv[0][x] = "K"
for x, c in [(1, "R"), (9, "P"), (17, "R")]:
    stamp(cv, [".H.H.", "HHHHH", ".HHH.", "..H.."], x, 1, {"H": c})
svg("deco-hearts", rows(cv), {"K": "#5a5a64", "R": "#ff4f8b", "P": "#ffb3cf"})

svg("deco-rainbowline", ["RRRRRRRR", "OOOOOOOO", "YYYYYYYY", "GGGGGGGG", "BBBBBBBB", "VVVVVVVV"],
    {"R": "#ff4f4f", "O": "#ff9a1a", "Y": "#ffd23f", "G": "#3ddc84", "B": "#4f8cff", "V": "#b06cff"})
svg("deco-flagline", ["KKKKKKKK", "KKKKKKKK", "RRRRRRRR", "RRRRRRRR", "GGGGGGGG", "GGGGGGGG"],
    {"K": "#1a1a1a", "R": "#e8321e", "G": "#ffcc00"})

cv = canvas(32, 6)
for x in (3, 11, 19, 27):
    stamp(cv, [".V.", "VYV", ".V.", ".G.", ".G."], x, 0)
svg("deco-violets", rows(cv), {"V": "#b06cff", "Y": "#ffd23f", "G": "#3ddc84"})

cv = canvas(32, 7)
for x in range(32):
    cv[6][x] = "G"
    if x % 3 != 1:
        cv[5][x] = "G"
    if x % 5 == 2:
        cv[4][x] = "G"
stamp(cv, [".GGG.", "GGGGG", ".GGG.", "..B..", "..B.."], 6, 0)
stamp(cv, [".GGG.", "GGGGG", ".GGG.", "..B..", "..B.."], 22, 0)
svg("deco-grass", rows(cv), {"G": "#3ddc84", "B": "#8a4a2a"})

cv = canvas(32, 8)
for i, (head, body) in enumerate([("H", "P"), ("I", "Y"), ("J", "B"), ("K", "V")]):
    x = 2 + 8 * i
    stamp(cv, ["CC", "CC"], x + 1, 0, {"C": head})
    stamp(cv, ["BBBB", "BBBB", "BBBB", "BB.."], x, 2, {"B": body})
    stamp(cv, ["A.A."], x, 6, {"A": body}) if False else None
    for xx in range(x + 4, min(x + 8, 32)):
        cv[3][xx] = "A"
    cv[6][x] = cv[6][x + 2] = body
    cv[7][x] = cv[7][x + 2] = body
svg("deco-people", rows(cv), {"H": "#f6d2b8", "I": "#b8825a", "J": "#7a4a2e", "K": "#fff1e2", "P": "#ff79b0", "Y": "#ffd23f", "B": "#4f8cff", "V": "#b06cff", "A": "#e8e8ee"})

cv = canvas(32, 8)
boot = [".WWWW..", ".RRRR..", ".RRRR..", ".RRRR..", ".RRRRRR", ".RRRRRR", ".KKKKKK"]
stamp(cv, boot, 2, 1)
stamp(cv, boot, 20, 1)
stamp(cv, [".O.", "OOO", ".O."], 12, 4)
stamp(cv, ["NN", "NN"], 28, 5)
svg("deco-boots", rows(cv), {"W": "#ffffff", "R": "#e8321e", "K": "#2b1a14", "O": "#ff9a1a", "N": "#8a4a2a"})

# particle tiles
scatter("deco-confetti", [(["PP", "PP"], None), (["YY", "YY"], None), (["BB", "BB"], None), (["G"], None), (["PP"], None)],
        {"P": "#ff79b0", "Y": "#ffd23f", "B": "#6fd0ff", "G": "#3ddc84"}, 41, 5)
scatter("deco-heartdrift", [([".R.R.", "RRRRR", ".RRR.", "..R.."], None)], {"R": "#ff9ec4"}, 53, 3, gap=28)
