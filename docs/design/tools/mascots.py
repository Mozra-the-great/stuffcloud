"""ASCII pixel sprites for the extra stuffcloud animals; writes one SVG per animal."""
import os
import sys

OUT = sys.argv[1]
S = {
    "cat": ([
        ".WW........WW.",
        ".WPW......WPW.",
        ".WWWWWWWWWWWW.",
        "WWWWWWWWWWWWWW",
        "WWKKWWWWWWKKWW",
        "WWKKWWWWWWKKWW",
        "WRRWWWNNWWWRRW",
        "WWWWWWWWWWWWWW",
        ".WWWWWWWWWWWW.",
        "..WWWWWWWWWW..",
        "..WWWWWWWWWW..",
        "..WW.WWWW.WW..",
    ], {"W": "#fff1e2", "P": "#ffb3c9", "K": "#2b1a14", "R": "#ffb3c9", "N": "#ff7aa6", "M": "#c4786a"}),
    "frog": ([
        "..GG......GG..",
        ".GWKG....GWKG.",
        ".GGGGGGGGGGGG.",
        "GGGGGGGGGGGGGG",
        "GGGGGGGGGGGGGG",
        "GGRRGGGGGGRRGG",
        "GGGGMMMMMMGGGG",
        "GGLLLLLLLLLLGG",
        ".GLLLLLLLLLLG.",
        "GGG........GGG",
    ], {"G": "#3ddc84", "W": "#ffffff", "K": "#101012", "R": "#ff7aa6", "M": "#0b3d22", "L": "#b8f5d3"}),
    "bunny": ([
        "..BB....BB..",
        "..BP....PB..",
        "..BP....PB..",
        "..BBBBBBBB..",
        ".BBBBBBBBBB.",
        ".BBKBBBBKBB.",
        ".BBBBPPBBBB.",
        ".BBBBBBBBBB.",
        "..BBBBBBBB..",
        ".BBBBBBBBBB.",
        ".BBBBBBBBBB.",
        ".BB.BBBB.BB.",
    ], {"B": "#f6eeff", "P": "#ff9ec4", "K": "#1a0b14"}),
    "jelly": ([
        "...CCCCCC...",
        ".CCCCCCCCCC.",
        "CCCCCCCCCCCC",
        "CCWKCCCCWKCC",
        "CCCCCCCCCCCC",
        "CCPPCCCCPPCC",
        ".CCCCCCCCCC.",
        "..T.T..T.T..",
        "..T.T..T.T..",
        ".T..T..T..T.",
        "..T...T...T.",
    ], {"C": "#6fd0ff", "W": "#ffffff", "K": "#101012", "P": "#ff9ec4", "T": "#a6e6ff"}),
    "penguin": ([
        "...KKKKKK...",
        "..KKKKKKKK..",
        ".KKWWKKWWKK.",
        ".KKWEKKWEKK.",
        ".KRKKOOKKRK.",
        "KKKKKKKKKKKK",
        "KKKWWWWWWKKK",
        "KKKWWWWWWKKK",
        ".KKWWWWWWKK.",
        "..KWWWWWWK..",
        "..OO....OO..",
    ], {"K": "#46569f", "W": "#f6f9ff", "E": "#101012", "R": "#ff9ec4", "O": "#ffb02e"}),
    "fox": ([
        "O............O",
        "OO..........OO",
        "OOOOOOOOOOOOOO",
        "OOWOOOOOOOOWOO",
        "OWWWOOOOOOWWWO",
        "OWKWWOOOOWWKWO",
        ".OWWWWKKWWWWO.",
        "..OWWWWWWWWO..",
        "...OOWWWWOO...",
        "....OOOOOO....",
    ], {"O": "#ff7a1a", "W": "#fff2dc", "K": "#2b1a14"}),
    "ghost": ([
        "...WWWWWW...",
        "..WWWWWWWW..",
        ".WWWWWWWWWW.",
        ".WWKKWWKKWW.",
        ".WWKKWWKKWW.",
        ".WWWWRRWWWW.",
        ".WWWWWWWWWW.",
        ".WWWWWWWWWW.",
        ".WWWWWWWWWW.",
        ".WW.WWWW.WW.",
        ".W...WW...W.",
    ], {"W": "#f6f9ff", "K": "#2b2b38", "R": "#ff9ec4"}),
    "cloudy": ([
        "....BBBB......",
        "..BBBBBBBB.BB.",
        ".BBBBBBBBBBBBB",
        "BBKBBBBBBKBBBB",
        "BBBBBBBBBBBBBB",
        "BPPBBBBBBPPBBB",
        ".BBBBMMBBBBBBB",
        "..BBBBBBBBBB..",
    ], {"B": "#6fd0ff", "K": "#101012", "P": "#ff9ec4", "M": "#1f6fa8"}),
}

for name, (rows, pal) in S.items():
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
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {len(rows)}" shape-rendering="crispEdges">{body}</svg>\n'
    with open(os.path.join(OUT, f"mascot-{name}.svg"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(svg)
    print(name, w, len(rows))
