"""Draws the tool stickers as pixel art and writes one SVG per sticker (sticker-*.svg)."""
import math
import os
import sys

OUT = sys.argv[1]


class Cv:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.g = [["."] * w for _ in range(h)]

    def p(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.g[y][x] = c

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.p(x, y, c)

    def frame(self, x0, y0, x1, y1, c):
        for x in range(x0, x1 + 1):
            self.p(x, y0, c)
            self.p(x, y1, c)
        for y in range(y0, y1 + 1):
            self.p(x0, y, c)
            self.p(x1, y, c)

    def line(self, x0, y0, x1, y1, c):
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err = dx + dy
        while True:
            self.p(x0, y0, c)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def disc(self, cx, cy, r, c):
        for y in range(self.h):
            for x in range(self.w):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                    self.p(x, y, c)

    def ring(self, cx, cy, r, c, inner=None):
        inner = r - 1.2 if inner is None else inner
        for y in range(self.h):
            for x in range(self.w):
                d = (x - cx) ** 2 + (y - cy) ** 2
                if inner * inner < d <= r * r:
                    self.p(x, y, c)

    def art(self, x, y, rows, remap=None):
        for dy, row in enumerate(rows):
            for dx, ch in enumerate(row):
                if ch != ".":
                    self.p(x + dx, y + dy, (remap or {}).get(ch, ch))


def emit(name, cv, pal):
    ys = [y for y in range(cv.h) if any(ch != "." for ch in cv.g[y])]
    xs = [x for x in range(cv.w) if any(cv.g[y][x] != "." for y in range(cv.h))]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    rows = ["".join(cv.g[y][x0:x1 + 1]) for y in range(y0, y1 + 1)]
    paths = {}
    for y, row in enumerate(rows):
        x = 0
        while x < len(row):
            c = row[x]
            if c == ".":
                x += 1
                continue
            s = x
            while x < len(row) and row[x] == c:
                x += 1
            paths.setdefault(c, []).append(f"M{s} {y}h{x - s}v1h-{x - s}z")
    body = "".join(f'<path fill="{pal[c]}" d="{"".join(p)}"/>' for c, p in paths.items())
    with open(os.path.join(OUT, f"sticker-{name}.svg"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {len(rows[0])} {len(rows)}" shape-rendering="crispEdges">{body}</svg>\n')
    return name


PAGE = {"O": "#ffb000", "W": "#fff5d6", "A": "#ff4f8b", "R": "#e8321e", "B": "#4f8cff", "Y": "#ffd23f", "G": "#3ddc84", "K": "#2b2b38"}
made = []


def page(cv, x0, y0, x1, y1):
    cv.rect(x0, y0, x1, y1, "W")
    cv.frame(x0, y0, x1, y1, "O")


# ---- PDF ------------------------------------------------------------------------------
c = Cv(12, 12)
page(c, 0, 0, 7, 8)
page(c, 3, 3, 10, 11)
c.line(6, 7, 6, 9, "A"); c.line(5, 8, 8, 8, "A")
made.append(emit("pdf-merge", c, PAGE))

c = Cv(12, 12)
page(c, 2, 0, 9, 11)
for x in (2, 4, 6, 8):
    c.p(x, 5, "R")
c.p(0, 4, "R"); c.p(1, 5, "R"); c.p(0, 6, "R"); c.p(11, 4, "R"); c.p(10, 5, "R"); c.p(11, 6, "R")
made.append(emit("pdf-split", c, PAGE))

c = Cv(12, 12)
page(c, 3, 3, 8, 10)
c.ring(5.5, 6.5, 5.5, "A", 4.4)
for x, y in ((9, 1), (10, 2), (9, 3), (11, 1)):
    c.p(x, y, "A")
made.append(emit("pdf-rotate", c, PAGE))

c = Cv(12, 12)
page(c, 4, 1, 7, 10)
for y, x in ((4, 0), (5, 1), (6, 0)):
    c.p(x, y, "A")
for y, x in ((4, 11), (5, 10), (6, 11)):
    c.p(x, y, "A")
c.line(0, 5, 2, 5, "A"); c.line(9, 5, 11, 5, "A")
made.append(emit("pdf-compress", c, PAGE))

c = Cv(12, 12)
page(c, 0, 0, 7, 10)
c.rect(6, 6, 11, 11, "B"); c.rect(7, 7, 10, 10, "Y"); c.rect(8, 8, 9, 9, "K")
c.line(7, 5, 7, 4, "B"); c.line(10, 5, 10, 4, "B"); c.line(8, 3, 9, 3, "B")
made.append(emit("pdf-protect", c, PAGE))

# ---- images ----------------------------------------------------------------------------
IMG = {"B": "#4f8cff", "W": "#ffffff", "G": "#3ddc84", "Y": "#ffd23f", "A": "#ff4f8b", "K": "#2b2b38", "L": "#e6e6ee", "M": "#b8b8c8", "R": "#e8321e", "P": "#ffa6c4"}
c = Cv(12, 12)
c.frame(0, 2, 8, 10, "B"); c.rect(1, 3, 7, 9, "W"); c.line(5, 7, 10, 2, "A")
for x, y in ((6, 2), (7, 2), (8, 2), (9, 2), (10, 2), (10, 3), (10, 4)):
    c.p(x, y, "A")
c.p(0, 11, "B")
made.append(emit("img-resize", c, IMG))

c = Cv(12, 12)
c.rect(3, 0, 4, 8, "A"); c.rect(3, 7, 11, 8, "A"); c.rect(0, 3, 8, 4, "A"); c.rect(7, 3, 8, 11, "A")
made.append(emit("img-crop", c, IMG))

c = Cv(12, 12)
c.frame(0, 1, 7, 7, "B"); c.rect(1, 2, 6, 6, "W")
c.frame(4, 4, 11, 11, "G"); c.rect(5, 5, 10, 10, "W"); c.rect(6, 8, 9, 10, "G"); c.p(9, 6, "Y")
made.append(emit("img-convert", c, IMG))

c = Cv(10, 10)
for y in range(10):
    for x in range(10):
        c.p(x, y, "L" if (x // 2 + y // 2) % 2 == 0 else "M")
c.disc(4.5, 4.5, 2.8, "P"); c.disc(4.5, 4.5, 1.2, "A")
made.append(emit("img-background", c, IMG))

c = Cv(11, 11)
c.art(2, 2, [".AA.AA.", "AAAAAAA", "AAAAAAA", ".AAAAA.", "..AAA..", "...A..."])
c.frame(0, 0, 10, 10, "K")
for k in (3, 6):
    c.line(k + 1, 1, k + 1, 9, "K") if False else None
made.append(emit("img-pixel", c, IMG))

c = Cv(12, 9)
c.rect(0, 1, 11, 8, "A"); c.rect(3, 0, 6, 0, "A"); c.rect(9, 2, 10, 2, "Y")
c.disc(5.5, 5, 2.8, "W"); c.disc(5.5, 5, 1.4, "K")
c.line(1, 0, 10, 8, "R"); c.line(2, 0, 11, 8, "R")
made.append(emit("img-exif", c, IMG))

# ---- convert -------------------------------------------------------------------------------
CV = {"G": "#3ddc84", "Y": "#ffd23f", "C": "#6fd0ff", "P": "#ff79b0", "O": "#ff7a1a", "B": "#4f8cff", "W": "#ffffff", "K": "#2b2b38", "V": "#b06cff", "R": "#ff5c3a"}
c = Cv(12, 7)
c.art(0, 0, ["..GGG..GGG..", ".G........G.", ".G........G.", "G....YY....G", ".G........G.", ".G........G.", "..GGG..GGG.."])
made.append(emit("json", c, CV))

c = Cv(12, 7)
c.art(0, 0, ["Y.GGGGGGGG..", "............", "..Y.GGGGGG..", "............", "..Y.GGGGGG..", "............", "Y.GGGGGGGG.."])
made.append(emit("yaml", c, CV))

c = Cv(12, 7)
c.art(0, 0, ["...C....C...", "..C......C..", ".C........C.", "C....PP....C", ".C........C.", "..C......C..", "...C....C..."])
made.append(emit("xml", c, CV))

c = Cv(7, 5)
c.art(0, 0, ["GGG.G.G", "G...G.G", "GGG.GGG", "G.G...G", "GGG...G"])
made.append(emit("base64", c, CV))

c = Cv(11, 11)
cols = ["R", "O", "Y", "G", "C", "V"]
for y in range(11):
    for x in range(11):
        if (x - 5) ** 2 + (y - 5) ** 2 <= 25:
            a = (math.degrees(math.atan2(y - 5, x - 5)) + 360) % 360
            c.p(x, y, cols[int(a // 60)])
c.disc(5, 5, 1.5, "W")
made.append(emit("colour", c, CV))

c = Cv(12, 8)
c.rect(0, 2, 11, 7, "Y")
for x in range(1, 11, 2):
    c.rect(x, 2, x, 4 if x % 4 == 1 else 3, "K")
c.rect(0, 2, 11, 2, "O") if False else None
made.append(emit("units", c, CV))

# ---- parsers, time ------------------------------------------------------------------------------
T = {"W": "#ffffff", "K": "#2b2b38", "P": "#ff4f8b", "B": "#4f8cff", "R": "#e8321e", "G": "#3ddc84", "Y": "#ffd23f", "L": "#e6e6ee"}
c = Cv(12, 12)
c.disc(5.5, 5.5, 5.5, "K"); c.disc(5.5, 5.5, 4.4, "W")
c.line(5, 5, 5, 2, "P"); c.line(6, 6, 8, 6, "P"); c.p(5, 5, "K"); c.p(6, 5, "K")
made.append(emit("cron", c, T))

c = Cv(11, 11)
c.rect(0, 1, 10, 10, "W"); c.frame(0, 1, 10, 10, "K"); c.rect(1, 2, 9, 3, "R")
c.p(2, 0, "K"); c.p(8, 0, "K")
for y in (5, 7, 9):
    for x in (2, 4, 6, 8):
        c.p(x, y, "B")
made.append(emit("timestamp", c, T))

c = Cv(12, 10)
c.rect(0, 0, 11, 9, "W"); c.frame(0, 0, 11, 9, "K"); c.rect(1, 1, 10, 2, "B")
c.p(2, 1, "W"); c.p(4, 1, "W"); c.p(6, 1, "W")
c.p(4, 5, "K"); c.p(7, 5, "K"); c.line(4, 7, 7, 7, "K"); c.p(3, 6, "K"); c.p(8, 6, "K")
made.append(emit("useragent", c, T))

# ---- network ----------------------------------------------------------------------------------
N = {"B": "#4f8cff", "G": "#3ddc84", "K": "#2b2b38", "Y": "#ffd23f", "W": "#ffffff", "P": "#ff79b0"}
c = Cv(12, 11)
c.rect(5, 0, 6, 1, "Y"); c.line(5, 2, 5, 3, "K"); c.line(2, 3, 9, 3, "K"); c.line(2, 4, 2, 5, "K"); c.line(9, 4, 9, 5, "K")
c.rect(1, 5, 3, 6, "B"); c.rect(8, 5, 10, 6, "B")
c.line(2, 7, 2, 8, "K"); c.line(9, 7, 9, 8, "K"); c.line(0, 8, 4, 8, "K"); c.line(7, 8, 11, 8, "K")
for x in (0, 4, 7, 11):
    c.line(x, 8, x, 9, "K")
    c.rect(x - (1 if x in (4, 11) else 0), 9, x + (1 if x in (0, 7) else 0), 10, "G")
made.append(emit("subnet", c, N))

c = Cv(12, 12)
c.rect(2, 2, 9, 9, "K"); c.rect(3, 3, 8, 8, "B"); c.rect(5, 5, 6, 6, "Y")
for k in (3, 5, 7):
    c.rect(0, k, 1, k, "Y"); c.rect(10, k, 11, k, "Y"); c.rect(k, 0, k, 1, "Y"); c.rect(k, 10, k, 11, "Y")
made.append(emit("mac", c, N))

# ---- text and generators ---------------------------------------------------------------------------
X = {"W": "#ffffff", "K": "#2b2b38", "P": "#ff79b0", "V": "#b06cff", "G": "#3ddc84", "R": "#ff5c3a", "L": "#d8d8e4", "B": "#4f8cff", "Y": "#ffd23f"}
c = Cv(10, 12)
c.rect(0, 0, 9, 11, "W"); c.frame(0, 0, 9, 11, "K")
c.art(2, 2, ["V.V", "VVV", "V.V"]) if False else None
c.rect(2, 2, 3, 4, "V"); c.rect(5, 2, 7, 2, "L")
for y in (4, 6, 8, 10 - 1):
    c.rect(2, y, 7, y, "L")
made.append(emit("lorem", c, X))

c = Cv(12, 9)
c.rect(0, 0, 11, 8, "W"); c.frame(0, 0, 11, 8, "K")
c.rect(1, 1, 3, 4, "B"); c.rect(1, 5, 3, 7, "B")
c.rect(5, 2, 10, 2, "K"); c.rect(5, 4, 8, 4, "L"); c.rect(5, 6, 10, 6, "L")
made.append(emit("uuid", c, X))

c = Cv(9, 9)
c.art(1, 1, ["KKK.KKK", "K.K.K.K", "KKK.KKK", ".......", "KKK.K..", "K.K..K.", "KKK.K.K"])
c.frame(0, 0, 8, 8, "V")
made.append(emit("qr", c, X))

c = Cv(12, 10)
c.rect(0, 0, 5, 9, "L"); c.rect(6, 0, 11, 9, "L")
for y in (2, 5, 7):
    c.rect(1, y, 4, y, "R")
c.rect(7, 2, 10, 2, "G"); c.rect(7, 4, 10, 4, "G"); c.p(8, 6, "G"); c.p(9, 6, "G")
c.line(8, 7, 9, 7, "G") if False else None
made.append(emit("diff", c, X))

c = Cv(12, 10)
c.rect(0, 0, 11, 9, "W"); c.frame(0, 0, 11, 9, "K")
c.rect(2, 2, 7, 2, "L"); c.rect(2, 4, 9, 4, "L"); c.rect(2, 6, 5, 6, "L")
c.rect(6, 6, 6, 8, "V")
made.append(emit("textops", c, X))

# ---- dev ---------------------------------------------------------------------------------------------
D = {"G": "#3ddc84", "Y": "#ffd23f", "P": "#ff79b0", "B": "#4f8cff", "R": "#e8321e", "V": "#b06cff", "K": "#2b2b38", "W": "#ffffff", "O": "#ff9a1a"}
c = Cv(9, 9)
c.rect(3, 0, 3, 8, "G"); c.rect(6, 0, 6, 8, "G"); c.rect(0, 3, 8, 3, "G"); c.rect(0, 6, 8, 6, "G")
made.append(emit("hash", c, D))

c = Cv(12, 8)
c.ring(2.5, 3.5, 3.2, "Y", 1.6)
c.rect(5, 3, 11, 4, "Y"); c.rect(9, 5, 10, 7, "Y"); c.rect(11, 5, 11, 6, "Y")
made.append(emit("password", c, D))

c = Cv(12, 7)
c.art(5, 1, [".V.V.", "..V..", "VVVVV", "..V..", ".V.V."])
c.rect(1, 4, 2, 5, "P")
made.append(emit("regex", c, D))

c = Cv(12, 8)
c.frame(0, 2, 6, 5, "B"); c.rect(1, 3, 5, 4, "K") if False else None
c.frame(5, 2, 11, 5, "G")
c.rect(4, 3, 7, 4, "W")
made.append(emit("url", c, D))

c = Cv(12, 9)
c.rect(0, 1, 11, 7, "W"); c.frame(0, 1, 11, 7, "K")
c.rect(1, 2, 3, 6, "R"); c.rect(4, 2, 7, 6, "V"); c.rect(8, 2, 10, 6, "B")
c.p(0, 4, "."); c.p(11, 4, ".")
made.append(emit("jwt", c, D))

c = Cv(11, 6)
c.art(0, 0, ["V...V", "VV.VV", "V.V.V", "V...V", "V...V"])
c.art(7, 0, ["B.B", "B.B", "B.B", "BBB", ".B."]) if False else None
c.rect(8, 0, 8, 3, "B"); c.p(7, 3, "B"); c.p(9, 3, "B"); c.p(6, 2, "B"); c.p(10, 2, "B")
made.append(emit("markdown", c, D))

c = Cv(10, 12)
c.rect(0, 1, 9, 10, "B"); c.rect(1, 0, 8, 0, "B"); c.rect(1, 11, 8, 11, "B")
c.rect(1, 1, 8, 2, "Y")
for y in (5, 8):
    c.rect(0, y, 9, y, "K")
made.append(emit("sql", c, D))

# ---- hosting and misc -----------------------------------------------------------------------------------
H = {"Y": "#ffd23f", "O": "#ff9a1a", "W": "#ffffff", "K": "#2b2b38", "R": "#e8321e", "B": "#4f8cff", "G": "#3ddc84", "N": "#8a4a2a", "L": "#d8d8e4", "A": "#ff4f8b", "C": "#6fd0ff"}
c = Cv(11, 12)
c.rect(0, 1, 10, 11, "N"); c.rect(1, 2, 9, 10, "W"); c.rect(3, 0, 7, 2, "Y"); c.rect(4, 1, 6, 1, "K")
for y in (4, 6, 8):
    c.rect(2, y, 8, y, "L")
made.append(emit("paste", c, H))

c = Cv(12, 9)
c.art(0, 0, ["....RR......", "...RRRR.....", "..RRRRRR....", ".RRRRRRRR...", "RRRRRRRRRR..", ".WWWWWWWW...", ".WWWKKWWW...", ".WWWKKWWW..."]) if False else None
c.art(0, 0, ["....AA......", "..AAAAAA....", ".AAAAAAAA...", "AAAAAAAAAA..", ".WWWWWWWW...", ".WWWKKWWW...", ".WWWKKWWW..."]) if False else None
c.art(0, 0, [".....AA.....", "...AAAAAA...", ".AAAAAAAAAA.", "AAAAAAAAAAAA", ".WWWWWWWWWW.", ".WWWWKKWWWW.", ".WWWWKKWWWW."])
made.append(emit("site", c, H))

c = Cv(7, 7)
c.art(0, 0, ["NNNNNNN", ".YYYYY.", "..YYY..", "...Y...", "..YYY..", ".YYYYY.", "NNNNNNN"])
made.append(emit("expiry", c, H))

c = Cv(9, 11)
c.rect(1, 0, 1, 10, "N"); c.rect(2, 0, 8, 5, "A"); c.p(8, 1, "."); c.p(7, 2, "."); c.p(8, 3, "."); c.p(8, 5, "."); c.p(8, 0, ".")
made.append(emit("report", c, H))

c = Cv(10, 11)
c.art(0, 0, ["BBBBBBBBBB", "BWWWWWWWWB", "BWWWWWWWWB", "BWWWWWWWWB", "BWWWWWWWWB", ".BWWWWWWB.", ".BWWWWWWB.", "..BWWWWB..", "...BWWB...", "....BB...."])
c.line(3, 4, 4, 6, "G"); c.line(4, 6, 7, 2, "G")
made.append(emit("shield", c, H))

c = Cv(10, 11)
c.rect(1, 2, 8, 2, "L"); c.rect(3, 0, 6, 1, "L")
c.art(1, 3, ["BBBBBBBB", ".BCBCBB.", ".BCBCBB.", ".BCBCBB.", ".BCBCBB.", ".BCBCBB.", ".BBBBBB.", ".BBBBBB."])
made.append(emit("trash", c, H))

c = Cv(11, 11)
c.rect(5, 0, 5, 5, "A"); c.rect(4, 4, 6, 5, "A"); c.rect(3, 4, 7, 4, "A") if False else None
c.art(2, 4, ["A.....A", ".A...A.", "..A.A..", "...A..."]) if False else None
c.rect(4, 0, 6, 4, "A"); c.art(1, 4, ["AAAAAAAAA", ".AAAAAAA.", "..AAAAA..", "...AAA...", "....A...."])
c.rect(0, 10, 10, 10, "B"); c.rect(0, 8, 0, 10, "B"); c.rect(10, 8, 10, 10, "B")
made.append(emit("download", c, H))

c = Cv(7, 9)
c.art(0, 0, ["...R...", "...RR..", "..RRR..", ".RRORR.", "RRROORR", "RROOOOR", "RROYYOR", ".RRYYR.", "..RRR.."])
made.append(emit("burn", c, {"R": "#ff5c3a", "O": "#ff9a1a", "Y": "#ffd23f"}))
print(len(made), "stickers")
