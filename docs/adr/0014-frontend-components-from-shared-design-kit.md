# ADR 0014: Frontend components from the shared design kit kern

- Status: Accepted
- Date: 2026-11-26
- Decided in: issue [#121](https://github.com/Mozra-the-great/stuffcloud/issues/121) (readiness
  re-check of 2026-11-26), kern's readiness programme
  ([kern#60](https://github.com/Mozra-the-great/kern/issues/60)), [SPEC 4](../SPEC.md#4-architecture-overview),
  [SPEC 12](../SPEC.md#12-design-and-ux)
- Supersedes: nothing. The design rules of [SPEC 12](../SPEC.md#12-design-and-ux) and
  [`docs/design/README.md`](../design/README.md), the animation runtime of
  [ADR 0008](0008-pixel-art-animation-runtime.md) and the test strategy of
  [ADR 0007](0007-test-strategy.md) stay as they are; this record only changes where the base
  components come from.

## Context

`web/apps/web/src/ui` holds the base components of the first build: Button, LinkButton, Card,
Checkbox, CodeBlock, Dialog, FileDropzone, Input, Progress, Select, Tabs, TabLinks, Tile, TileGrid,
ToastRegion and the Mascot, with their CSS, helpers and tests. The same components are needed by the
maintainer's other apps, and keeping a copy per app means every accessibility fix (#118, #124) has to
be ported by hand.

[kern](https://github.com/Mozra-the-great/kern) (`@mozra-the-great/kern`, Svelte 5,
GPL-3.0-or-later, no runtime dependencies) is the maintainer's shared kit. It has its own maintainer
agent and release process. Its theme `code` is drawn from this repository's `docs/design`; the
readiness programme of kern#60 (released in v0.2.0 to v0.11.0, aligned item by item in v0.12.0) closed
every gap the 2026-11-19 analysis found: tests with a coverage ratchet above 95 %, axe and keyboard
suites in every theme variant, forced colours, a machine-readable theme source with a drift check
against `docs/design`, visual regression of our components' look, and the Svelte path tested under a
policy with `style-src 'self'` and no `'unsafe-inline'` (kern#125, v0.12.2).

kern is not on the npm registry (the name `kern-ui` there belongs to someone else, kern#19). Each
release attaches a tarball plus its sha256 and sha512.

## Decision

1. **The base components come from kern.** New generic pieces go to kern as issues, not into
   `src/ui` (CLAUDE.md, "Tools"). The components of `src/ui` are replaced one or a few per pull
   request by their kern counterparts (mapping in kern's `docs/consumer-guide.md`, "Umstieg von
   stuffcloud", and the readiness comment on #121). `src/ui` is removed when the last one is gone;
   #121 stays open until then.
2. **Consumed as a pinned release tarball through pnpm.** `web/apps/web/package.json` names the
   release URL (`https://github.com/Mozra-the-great/kern/releases/download/vX.Y.Z/mozra-the-great-kern-X.Y.Z.tgz`),
   and `pnpm-lock.yaml` holds the same URL with its `integrity: sha512-…`. `pnpm install
   --frozen-lockfile` (CI, Docker build, license gate) fails when the file behind the URL changes.
   Before a version is pinned its sha512 is checked against the release notes ("Integrity") and the
   attached `.sha256`/`.sha512` files, as kern's consumer guide describes. No git dependency (it
   pins a commit, not content, and builds with kern's dev dependencies), no registry, no token.
3. **One theme, dark only.** The app imports `@mozra-the-great/kern/themes/code.css` (base tokens
   plus the Code brand only; kern's tests prove no other brand lands in it) and sets
   `data-theme="code"` on `<body>` (not `<html>`: the theme gives its element a px font size, which
   on the root would override the reader's default size for `rem`). kern's light, paper and contrast
   variants of `code` are not used: the UI is dark only (SPEC 12). The app's own `src/styles`
   (fonts, generated `tokens.css`, `theme.css`) stays for the app's layout, pages and tools;
   components read only kern's `--k-*` tokens.
4. **kern owns the Code theme; `docs/design` stays the design source.** kern generates the theme
   from `code.tokens.json`, whose every value names its source in `docs/design` (or in this app where
   the design has no value), and its drift check fails when a recorded design value changes. A design
   change here is followed by a kern issue to refresh the theme. Where the sources disagree, the
   design wins (kern `docs/themes.md`, "Code theme source").
5. **Accepted differences.** These remain between kern under `code` and the old `src/ui`, each for a
   reason that holds in every theme (kern `docs/themes.md`, "Remaining differences", #111), and are
   accepted here: the Modal keeps a visible close button; Progress shows its label unless `hideLabel`
   (our bare bar is `hideLabel`); the Toaster position is a prop (we pass `bottom-left`); the Tabs
   edge fades only while tabs are hidden behind it; FileDrop's edge turns solid as well as pink while
   dragging (a cue that does not rely on colour); FileDrop's picker is the secondary button; under
   forced colours the field error icon, the toast tone dot and kern's checkbox are drawn. The Modal
   follows the design's dialogs S and T (520 px, 32 px heading), not the old `Dialog.svelte`.
6. **Updates by hand, one version per pull request.** Dependabot cannot follow a URL dependency, so
   a bump is a pull request that: reads kern's `CHANGELOG.md` from the old to the new version (under
   1.0 a minor version may break, marked **BREAKING:**; patch versions never do), runs
   `pnpm --filter @stuffcloud/web add <new URL>`, checks that the diff is exactly one new URL in
   `package.json` and one new URL plus `integrity` in the lockfile, checks that sha512 against the
   release notes, regenerates `docs/THIRD-PARTY.md`, and passes the full `build` check (unit tests,
   Playwright with the axe gate in Chromium and Firefox). A breaking change is migrated in the same
   pull request. One copy of kern per app (`pnpm why @mozra-the-great/kern`).
7. **What stays local.** The app shell, router, pages, `ToolFrame`, the tool registry, the PDF
   engine and everything else only stuffcloud knows; the fonts (kern ships none); the mascot art in
   `docs/design` and the animation benchmark (`bench/`, ADR 0008), which measures runtime variants
   rather than a component. Each local test stays until its component is migrated, and is removed
   only where kern's test (kern `docs/testing.md`, "stuffcloud mapping") covers the same behaviour;
   app-level checks (axe on every state, keyboard walks, i18n catalogues, privacy check) always stay
   here and run against the kern components. Texts are passed from our catalogues as props; kern's
   own English defaults are never shown.

## Consequences

- Positive: one implementation of each base component, tested in kern (behaviour, axe, keyboard,
  forced colours, visual regression, strict CSP) and here (app states, both browsers). Fixes reach
  every app with a version bump instead of a port.
- Positive: the license gate covers kern like any npm package; it is GPL-3.0-or-later, already on
  the allow list of `scripts/ci/license-policy.toml` and `deny.toml`, so neither changes.
  `scripts/ci/npm_licenses.py` now reads tarball entries of the lockfile (key `name@<url>`, version on
  its own line) and fails on any entry key it does not understand, so a tarball dependency cannot slip
  past the completeness check; `docs/THIRD-PARTY.md` links such a package to its release, not to the
  registry.
- Negative: an external dependency on a kit with its own release cadence. A breaking minor version
  before 1.0 costs a migration here; kern's changelog marks each one.
- Negative: no automatic update pull requests. New kern releases are seen through kern's
  release notifications and the issues kern's agent opens here; a bump follows decision 6.
- Negative: the CSP of the app must keep `style-src 'self'` working for the Svelte path; kern's
  custom elements (`@mozra-the-great/kern/elements`) would need `'unsafe-inline'` and are therefore
  not used. Vite must not inline kern's assets as `data:` URIs (`assetsInlineLimit: 0` stays).

## Open points

None.

## Alternatives considered

- **Keep `src/ui` and port fixes by hand**: rejected; every fix lands twice and the copies drift (the
  #118 and #124 fixes had to be ported to kern by hand already).
- **Git dependency (`github:Mozra-the-great/kern#vX.Y.Z`)**: pins a commit, not the content, and
  runs kern's build with its dev dependencies at install time; the tarball with `integrity` is
  stricter and simpler.
- **Vendoring kern's sources into this repository**: no single source, no release notes to follow,
  and kern's tests would not run on the copy.
- **kern's custom elements instead of the Svelte package**: they need `style-src 'unsafe-inline'`
  (each element puts a `<style>` into its shadow root) and bring their own runtime; the app is
  Svelte already.

## Addendum: kern 0.13.1 (2026-11-26, #121, PR #183)

Decision 3 put `data-theme="code"` on `<body>` because kern's theme rule gave the themed element a px
font size, which on `<html>` would have frozen every `rem` at 16 px, and because the Code theme set a
fixed line height of 1.5 that the app overrode with `body[data-theme] { line-height: normal }`. Both
were kern defects found by this migration, and kern 0.13.0 fixed them: the root takes the reader's
default size (`calc(var(--k-root-scale) * 1rem)`, kern#144) and the Code theme's line height is
`normal` like the design's (`--k-leading-body`, kern#145). The original text above stays as the record
of the decision at the time; since 0.13.1 the app sets `data-theme="code"` on `<html>` and carries
neither workaround. The unnamed `<section>` around the search `Modal` (kern#154, fixed in 0.13.1: the
title row and footer are `role="none"`) went with them.

## Addendum: Checkbox and Textarea, `src/ui` removed (2026-11-26, #121, PR #185)

The last base components moved with kern 0.13.1: `Checkbox` (the box is its own hit target, kern#150, so
Playwright's `check()` works) and `Textarea` (reads the Code field tokens, kern#149); `src/ui` no longer
exists. One more difference is accepted under decision 5: a text area with `rows="1"` is 48.5 px high in
kern against the 52 px of the old `.sc-field` (no tool uses one row; from two rows on the heights agree).
Field errors are `role="alert"` in kern; a tool that already says the same message in its own status
region passes `announce={false}` (kern#148), and `tests/field-announce.test.ts` proves a screen reader
hears each error once. The app-local pieces that kern also has are not `src/ui` components; they move in later packages (see the next
addendum) and are tracked in #121.

## Addendum: app-local building blocks (2026-11-26, #121, PR #187)

Six of the app-local candidates moved to kern 0.13.1; the copies and the tests kern's own suite covers
(`tests/dom/skiplink.test.ts`, `tests/dom/online-status.test.ts`, `tests/unit/announcer*.test.ts`,
`tests/unit/download.test.ts`, `tests/dom/downloadbutton.test.ts`, `tests/components/visually-hidden.test.ts`;
kern `docs/testing.md` has no row for them yet) are gone. App-level checks stay: the shell test walks the
skip link and the offline notice, the e2e specs run axe and the keyboard gates, and a helper
(`tests/download-capture.ts`) reads the file behind the clicked download link.

| App-local | kern | Notes |
| --------- | ---- | ----- |
| `SkipLink` | `SkipLink` | `label` from the catalogue. kern moves focus to the target and gives it a temporary `tabindex="-1"`. |
| `LiveAnnouncer`, `announcer.svelte.ts` | `LiveAnnouncer`, `announce()` | `Outlet` calls `announce()` (page-wide announcer); the component renders a polite and an assertive region, both always present. |
| `OnlineStatus`, `OfflineNotice` | `OnlineStatus` (`bind:online`) | Title, text and the "back online" announcement come from the catalogue (`offline.title`, `offline.hint`, new `offline.back`). The live region is mounted before it, so a page that opens offline is announced too. |
| `CopyButton` | `CopyButton` | `src/app/CopyButton.svelte` stays as a thin wrapper: it passes the label and shows the confirming toast. kern's own spoken messages are set to `''` so a copy is announced once (by the toast region). |
| `download.ts` | `saveBlob`, `saveText`, `DownloadButton` | `src/app/DownloadButton.svelte` is the same kind of wrapper (secondary, small, visible label, texts from the catalogue). QR keeps calling `saveBlob`/`saveText` because it reports through its own status line. |
| `.visually-hidden` | `VisuallyHidden` | diff, MAC, subnet, timestamp. |

Accepted differences (decision 5): the copy button is an icon button whose accessible name stays the
tool's label ("Copy HEX"); the visible word "Copy" is gone, the icon turns into a check mark for two
seconds, and kern falls back to a hidden text area when the Clipboard API is refused. A download button
now carries an icon and says "Download started" or "Could not save the file." in a live region (new keys
`tool.downloadStarted`, `tool.downloadFailed`); kern cleans the file name (no path, no reserved Windows
names) and keeps the object URL for one second instead of one tick. The offline notice uses kern's
look (tokens, forced colours). Nothing leaves the browser: `saveBlob` is an object URL and a clicked link
as before, and the tools' source scan still covers every tool.

Still local, waiting for the operator's decision (SF18): `ToolStatus` (kern's `StatusMessage` is neutral
instead of green and 75 selectors depend on `.tool-status`), `ReorderList` and `PageGrid`
(`SortableList`, `SelectGrid`) and `Sticker` (`Mascot` with code art). `src/pdf/LiveStatus.svelte` keeps its
two regions with `ToolStatus`.

## Addendum: kern 0.13.4, short visible labels (2026-11-26, #121, PR #193)

kern 0.13.2 to 0.13.4 are additions and fixes only (pill-tab overflow kern#159; `accessibleLabel` on
`CopyButton` and `DownloadButton` kern#166; `copyAccessibleLabel` on `Code` and `CodeBlock` kern#168).
The two accepted differences of the previous addendum that came from the missing feature are gone: the
copy button shows the word "Copy" again (it is no longer an icon-only button; the icon stays next to the
word and turns into a check mark for two seconds), and a download button shows "Download", as in the
design. The tool's longer label ("Copy HEX", "Download result") is the accessible name, so a screen reader
still hears which value a button belongs to; `tests/button-names.test.ts` checks in both languages that
every such name contains the visible word (WCAG 2.5.3 Label in Name), which kern documents but does not
check. The gallery's code block uses `copyAccessibleLabel`.

## Addendum: status lines (2026-11-26, #121, PR #194)

`ToolStatus` is gone: the result and error line of every tool is kern's `StatusMessage` (`kind` status or
alert; rendered from the first paint, empty, so a screen reader has the region before its first text),
and so are the two regions of `src/pdf/LiveStatus.svelte`, which keeps its job (both regions always
present, the error in a box). This replaces the "still local" sentence about `ToolStatus` and `LiveStatus` in
the previous addendum. The result line is green as designed through `tone="ok"` (kern#173, filed by this
package, released in kern 0.14.0; until then one local rule did it). The tests and e2e specs no longer
select `.tool-status`: they use role plus the attribute `data-tool-status`, because kern's field errors are
`role="alert"` too and a role alone would also find them. kern's alert colour (`--k-danger`, `#ff4f8b`) is
the old `--pink2`.

## Addendum: stickers (2026-11-26, #121, PR #196)

`Sticker` is kern's `Mascot` with code art (`tool-stickers/sticker-<name>`), still and decorative, which
replaces the "still local" sentence about `Sticker` in the app-local addendum. The pixel grid is kern's
(`CODE_ART`, checked against the viewBox of every design file by a test), the SVG files stay in
`docs/design/prototypes` and are served by the app's own glob (decision 7: the art is the design's).
Accepted difference: `Mascot` draws at a whole-number scale, so a sticker is 44 to 50 px high (the scale
nearest to the old 48 px) with crisp pixels instead of a stretched 48 px image.

## Addendum: kern 0.14.0 (2026-11-26, #121, PR #198)

kern 0.14.0 closes the three gaps this package filed or met: `StatusMessage tone="ok"` (kern#173),
`SelectGrid` with an emptied list (kern#175) and a closed left edge of `TileGrid` (kern#172, the one
**BREAKING** item). The two grids of the app (tools page, gallery) have free space on their left, so the
new line shows once and nothing is set; a grid flush against a bordered container would set
`--k-tile-grid-left-w: 0`.

## Links

- Issue [#121](https://github.com/Mozra-the-great/stuffcloud/issues/121), kern
  [#60](https://github.com/Mozra-the-great/kern/issues/60) (readiness),
  [#111](https://github.com/Mozra-the-great/kern/issues/111) (alignment),
  [#125](https://github.com/Mozra-the-great/kern/issues/125) (strict CSP),
  [#142](https://github.com/Mozra-the-great/kern/issues/142) (readonly list props),
  [#144](https://github.com/Mozra-the-great/kern/issues/144) (root font size).
- kern `docs/consumer-guide.md`, `docs/themes.md`, `docs/testing.md`.
- [ADR 0007](0007-test-strategy.md), [ADR 0008](0008-pixel-art-animation-runtime.md),
  [SPEC 3](../SPEC.md#3-license-and-reuse-policy), [SPEC 12](../SPEC.md#12-design-and-ux).
