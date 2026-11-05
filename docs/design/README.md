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
| `BA` | API tokens | same file |
| `BC` | Admin tools | same file |

## Open points

- Mockups were reviewed in the canvas only; the mobile layouts of the responsive
  pages rely on breakpoints and are not tested on real devices.
- Tab bars on mobile have no scrollbar; a soft fade on the right edge hints that
  more tabs follow.
- The page builder on mobile shows the canvas and block bar only, without the style
  panel.
- The third-party screenshots used as a mood reference are not included (third-party
  material).
