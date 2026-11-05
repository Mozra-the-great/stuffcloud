# stuffcloud design reference

Visual reference produced in the design exploration (November 2026). The files in
`prototypes/` are **mockups to build from, not production code**. The production UI
is built in Svelte (see `docs/SPEC.md`).

Explorations that were **not** chosen (console-only, terminal, combined and orange
variants) are intentionally not part of this folder.

## Direction

- **Layout:** the grid look. Thin 1 px lines divide the page into cells; a coloured
  grid panel carries the mascot and stickers.
- **Dark only.** Near-black background, white text.
- **Palette:** pink and violet for surfaces and accents. Stickers keep their own
  bright colours (blue, green, yellow, red) so tool categories stay recognisable.
- **Type:** Silkscreen (pixel) for the wordmark and headings in console contexts,
  JetBrains Mono for labels and code, Inter for UI text and long copy.
  Fonts are self-hosted in the real app (the mockups load them from Google Fonts).
- **Mascot:** Stuffy, a pink pixel axolotl, plus a cast of extra animals for easter
  eggs (see below). None of them ever speaks: no speech bubbles.
- **No filler copy.** Pages carry labels, state and data only, no marketing text.
- **Motion:** the mascot bobs in two steps; everything stops under
  `prefers-reduced-motion`.
- **Accessibility:** WCAG 2.2 AA contrast, visible focus, touch targets of at least
  44 px (48 px for icon buttons), real form controls and labels.

### Tokens

| Token | Value |
|---|---|
| Background | `#101012` |
| Text | `#f4f4f0` |
| Muted text | `#a2a2ab` |
| Lines | `#26262b`, `#3a3a42` |
| Pink accent | `#ff79b0` (hover, active), `#ff4f8b` (danger) |
| Lilac | `#c78bff` (links, addresses) |
| Violet panel | `#8b5cf6` |
| Status green | `#3ddc84` |

### Specific decisions

- **Code field (2FA):** six cells grouped 3 + 3 with a hyphen (`000-000`) over one
  real input, so paste, autofill and screen readers keep working.
- **QR code:** two styles, *raw* (plain black on white) and *stuffcloud* (violet
  modules, magenta finder squares, mascot in the centre). PNG and SVG download.
  The stuffcloud style must use error-correction level H and pass an automatic scan
  test, otherwise fall back to raw.
- **Delete site:** confirmation by typing the subdomain; the button stays disabled
  until it matches.
- **Mobile:** menu button instead of the navigation; tables become cards; action
  buttons stay on one row; tab bars scroll without a visible scrollbar.

## Mascots and easter eggs

All art is original pixel art, licensed **GPL-3.0-or-later** like the code
(`prototypes/axo.svg` and `prototypes/mascot-*.svg`). Eggs never block content or take
focus, and all motion stops under `prefers-reduced-motion`.

| Animal | Name | Where it shows up |
|---|---|---|
| Axolotl | Stuffy | main mascot: home, tools, forms |
| Cream cat | Mochi | Konami code: walks along the bottom edge |
| Frog | Hop | a tool finished: hops across the result |
| Bunny | Bun | rarely (1 in 20 page loads): peeks in from the edge |
| Jellyfish | Bloop | long jobs: floats in the progress bar |
| Penguin | Waddle | December to February: slides across the home page |
| Fox | Ember | burn after reading: appears when the page is consumed |
| Ghost | Boo | expired and 404 pages |
| Cloud | Cumulo | site published; click the logo 5 times: drifts across |

## Seasonal decorations

Seventeen sets that work on every page through classes on an ancestor (`<html>` in
production), for example `s-christmas s-advent-3`. The rules live at the end of
`prototypes/stuff.css`, the sprites are `prototypes/deco-*.svg`, all GPL-3.0-or-later.
**Spring and summer deliberately have no decoration.**

Each set has up to four parts: a few randomly scattered particles that drift slowly
*behind* the content, a strip under the header or above the footer, a corner sprite
where it fits, and an accessory on Stuffy.

| Set | Window (Germany) | Parts |
|---|---|---|
| Winter | Jan 3 to Feb 28, Dec 27 to 30 | a few snowflakes, icicles, beanie |
| New Year | Dec 31 to Jan 2 | confetti, sparks, fireworks, party hat |
| Valentine's Day | Feb 13 to 14 | drifting hearts, heart garland, heart |
| Carnival | Weiberfastnacht to Shrove Tuesday | confetti, bunting, jester hat |
| Women's Day | Mar 8 | violets, Venus sign, violet flower |
| Earth Day | Apr 22 | grass and trees, globe, sprout |
| Easter | two weeks before to Easter Monday | eggs, bunny ears |
| Europe Day | May 9 | EU flag, star crown |
| Pride | Jun 1 to 30 | rainbow line under the header, rainbow |
| Autumn | Sep 1 to Nov 30 | a few leaves, leaf pile, leaf |
| Unity Day | Oct 3 | black-red-gold line, flag band |
| Harvest festival | week of the first Sunday in October | a few leaves, apples, wheat, pumpkin, apple |
| Halloween | Oct 24 to Nov 2 | bats, hanging spider, pumpkins, witch hat |
| Nicholas Day | Dec 6 | boots, nuts, mitre |
| Human Rights Day | Dec 10 | people holding hands, dove |
| Advent | four Sundays before Christmas to Dec 23 | wreath with 1 to 4 candles lit (here 3), on top of Christmas |
| Christmas | Dec 1 to Dec 26 | few snowflakes, light garland, Santa hat |

Rules:
- Priority: special days (single days) win over holidays (Christmas, Easter, Halloween,
  harvest festival), holidays win over seasons. Example: Dec 6 and Dec 10 override
  Christmas for that day; Advent adds the wreath on top of Christmas.
- Moving dates are computed: Easter Sunday by the usual rule, Weiberfastnacht = Easter
  minus 52 days, Shrove Tuesday = Easter minus 47 days; Advent Sundays are the four
  Sundays before Dec 25 (the wreath lights one more candle per Sunday).
- The admin chooses *auto by date*, *fixed set* or *off*, and visitors can switch
  decorations off.
- Decorations never block content, take no focus and stand still under
  `prefers-reduced-motion`.

**Theme button.** Whenever a themed set is active, a small pill with the theme icon and
name sits in the bottom right corner (`<details>`, so it works without script). It opens
a card with a few positive facts (texts in `THEME-TEXTS.md`) and a switch to hide
decorations. **Dressed-up mascots:** every extra animal wears the accessory of the active
set; hats are scaled per animal (`.mx` in `stuff.css`).

Pages `BE` (mascots in Christmas, Halloween, Easter and Pride outfits), `BW` (theme
button for every set), `BQ` (all sets), `BS` (Christmas) and `BU` (Halloween) show them; the mobile
boards use the same files.

## Files

Open them in a Design canvas (they use that runtime and need `support.js`; they do
not open in a plain browser). Shared assets live next to the pages: `stuff.css` and
the pixel sprites (`*.svg`).

The pages from `U` on are **responsive**: the same file is used for the desktop board
(1280 px) and the mobile board (390 px). The earlier pages (`J` to `T`) have a
separate mobile file each, listed below.

| File | Page | Mobile |
|---|---|---|
| `H` | Home | `J` |
| `F` | Tool page (merge PDF), pink and violet | `K` |
| `I` | Host something | `L` |
| `M` | Site published, with QR style and download | `N` |
| `O` | Log in | `P` |
| `Q` | Two-factor code | `R` |
| `S` | Delete site (confirmation) | `T` |
| `U` | Register | same file |
| `W` | Set up two-factor | same file |
| `Y` | My sites | same file |
| `AA` | Paste text | same file |
| `AC` | Report a site | same file |
| `AE` | Protected site (password) | same file |
| `AG` | Site expired | same file |
| `AI` | Account security | same file |
| `AK` | Moderation queue | same file |
| `AM` | Admin users | same file |
| `AO` | Admin zones | same file |
| `AQ` | Admin settings | same file |
| `AS` | Page builder | same file |
| `AU` | Templates | same file |
| `AW` | All tools | same file |
| `AY` | Recovery code (error state) | same file |
| `BE` | Mascots and easter eggs | same file |
| `BG` | Tool: JSON to YAML converter | same file |
| `BI` | Tool: QR code generator | same file |
| `BK` | Tool: resize image | same file |
| `BM` | Empty and error states | same file |
| `BO` | Docs page (CLI deploy) | same file |
| `BQ` | Seasonal decorations, all sets | same file |
| `BW` | Theme button and card for every set | same file |
| `BS` | All tools with the Christmas set | same file |
| `BU` | All tools with the Halloween set | same file |
| `BA` | API tokens | same file |
| `BC` | Admin tools | same file |

## Sprite sources

The mascot and decoration sprites are drawn as ASCII art and turned into SVG by two
small scripts, so edits stay reviewable and reproducible:

```sh
python docs/design/tools/mascots.py docs/design/prototypes   # mascot-*.svg
python docs/design/tools/seasons.py docs/design/prototypes   # deco-*.svg
python docs/design/tools/stickers.py docs/design/prototypes  # sticker-*.svg
```

Edit the ASCII rows (one character per pixel, `.` is empty) and the palette next to
them, run the script, and commit the changed SVGs.

## Open points

- Mockups were reviewed in the canvas only; the mobile layouts of the responsive
  pages rely on breakpoints and are not tested on real devices.
- Tab bars on mobile have no scrollbar; a soft fade on the right edge hints that
  more tabs follow.
- The page builder on mobile shows the canvas and block bar only, without the style
  panel.
- The third-party screenshots used as a mood reference are not included (third-party
  material).

## Tool stickers

Beyond the ten base stickers, every tool group has its own pixel sticker
(`prototypes/sticker-<name>.svg`, generated by `tools/stickers.py`). Shown with the
white 2px outline, slight tilt and two-step bob like the others.

| Group | Stickers |
|---|---|
| PDF | `pdf-merge`, `pdf-split`, `pdf-rotate`, `pdf-compress`, `pdf-protect` |
| Images | `img-resize`, `img-crop`, `img-convert`, `img-background`, `img-pixel`, `img-exif` |
| Convert | `json`, `yaml`, `xml`, `base64`, `colour`, `units` |
| Time and agents | `cron`, `timestamp`, `useragent` |
| Network | `subnet`, `mac` |
| Text and generators | `lorem`, `uuid`, `qr`, `diff`, `textops` |
| Dev | `hash`, `password`, `regex`, `url`, `jwt`, `markdown`, `sql` |
| Hosting and misc | `paste`, `site`, `expiry`, `report`, `shield`, `trash`, `download`, `burn` |

## Design PDF

`stuffcloud-design-system.pdf` (next to this file) is the whole design system as one
document: principles, colours with contrast ratios, typography, components, stickers,
mascots, seasonal sets, the page inventory and screenshots of every mockup (desktop
and the first mobile screen). It is generated, never edited by hand.

```sh
pip install -r docs/design/tools/pdf/requirements.txt   # once; Playwright and Pillow
python docs/design/tools/pdf/build.py                    # writes the PDF next to this file
```

Needs Chrome or Chromium (set `CHROME` for a specific binary) and internet access for
the Google Fonts. **Every design change must rebuild and commit the PDF in the same
PR.** The script warns when a mockup in `prototypes/` is missing from `PAGES` in
`tools/pdf/shots.py`; new sticker groups are listed in `STICKER_GROUPS` in
`tools/pdf/build_book.py`. The chapters themselves live in `build_book.py`.

