# Third-party assets (not in a package manager)

`THIRD-PARTY.md` lists what Cargo and pnpm resolve, and the license gates (`cargo deny`,
`scripts/ci/license_gate.py`) check exactly that. Some things stuffcloud ships or loads
are in neither tree: WASM modules built from native libraries, machine-learning model
weights, bundled data files and fonts. They bypass both gates, so each one is
recorded here by hand, with the license checked at adoption (`docs/SPEC.md`, section 3).

## Rules

- **Check the license of the exact artifact, not of the project name.** A WASM build can
  carry other licenses than its npm wrapper (the wrapper may be MIT while the compiled
  library is LGPL or AGPL), and a model's code license says nothing about its weights.
  Re-check at every version bump.
- **Only GPLv3-compatible licenses**, the same set as `deny.toml` (SPEC, section 3).
  Copyleft WASM builds are decided case by case (Ghostscript is AGPL: SPEC, section 7,
  only as an optional lazily loaded extra, if at all) and need an entry below with the
  reason it is acceptable.
- **Pin and verify.** Every entry names the exact version and a SHA-256 of the file in
  the repository or the build input, so a swapped file is noticed.
- **Self-hosted.** Assets load from our own origin (SPEC, section 7 and 12); no CDN, no
  external font requests.
- **One row per file or file set**, added in the same PR that adds the asset. A PR that
  adds an asset without a row here is not complete.
- Original artwork (pixel-art stickers, mascots, easter eggs, `docs/design/`) is ours and
  GPL-3.0-or-later like the code (SPEC, section 12); it is not listed.

## Register

| Asset | Kind | Version | SHA-256 | License | Source | Used by |
|---|---|---|---|---|---|---|
| `inter-latin-ext-wght-normal.woff2` (Inter variable (wght), Latin Extended) | font | 5.3.0 (Inter v20) | `34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956` | OFL-1.1 (Copyright 2016 The Inter Project Authors; text in `web/apps/web/src/assets/fonts/OFL-*.txt`) | npm tarball of `@fontsource-variable/inter`, unmodified woff2 | UI text and long copy; `web/apps/web/src/styles/fonts.css` |
| `inter-latin-wght-normal.woff2` (Inter variable (wght), Latin) | font | 5.3.0 (Inter v20) | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` | OFL-1.1 (Copyright 2016 The Inter Project Authors; text in `web/apps/web/src/assets/fonts/OFL-*.txt`) | npm tarball of `@fontsource-variable/inter`, unmodified woff2 | UI text and long copy; `web/apps/web/src/styles/fonts.css` |
| `jetbrains-mono-latin-ext-wght-normal.woff2` (JetBrains Mono variable (wght), Latin Extended) | font | 5.3.0 | `79bfdab9ba467e26eea4122e6f2567e188dd8a09a8c730d501fc487c4ab99c6e` | OFL-1.1 (Copyright 2020 The JetBrains Mono Project Authors; text in `web/apps/web/src/assets/fonts/OFL-*.txt`) | npm tarball of `@fontsource-variable/jetbrains-mono`, unmodified woff2 | labels and code; `web/apps/web/src/styles/fonts.css` |
| `jetbrains-mono-latin-wght-normal.woff2` (JetBrains Mono variable (wght), Latin) | font | 5.3.0 | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` | OFL-1.1 (Copyright 2020 The JetBrains Mono Project Authors; text in `web/apps/web/src/assets/fonts/OFL-*.txt`) | npm tarball of `@fontsource-variable/jetbrains-mono`, unmodified woff2 | labels and code; `web/apps/web/src/styles/fonts.css` |
| `silkscreen-latin-400-normal.woff2` (Silkscreen Regular, Latin) | font | 5.3.0 | `e6c72ea4702249202bcdd79d3343057e4e25ef1f04e3fcffd8602ab53b40b4cc` | OFL-1.1 (Copyright 2001 The Silkscreen Project Authors; text in `web/apps/web/src/assets/fonts/OFL-*.txt`) | npm tarball of `@fontsource/silkscreen`, unmodified woff2 | wordmark and console headings; `web/apps/web/src/styles/fonts.css` |
| `silkscreen-latin-700-normal.woff2` (Silkscreen Bold, Latin) | font | 5.3.0 | `5741b7f01a127f40ed70281fa2f686e8fc2cfe241930a120e4d1a1cebe78f995` | OFL-1.1 (Copyright 2001 The Silkscreen Project Authors; text in `web/apps/web/src/assets/fonts/OFL-*.txt`) | npm tarball of `@fontsource/silkscreen`, unmodified woff2 | wordmark and console headings; `web/apps/web/src/styles/fonts.css` |

The fonts are the Google Fonts builds of the three families the design chose
(`docs/design/README.md`), taken unmodified from the Fontsource npm tarballs (Latin and Latin
Extended subsets, variable fonts for Inter and JetBrains Mono, Silkscreen in regular and
bold). They sit in the repository, not in `package.json`, so the npm license gate does not see
them: the OFL-1.1 check is this table plus the OFL texts next to the files. OFL-1.1 is not in the `deny.toml` list
(that list is for code that is linked into the GPL-3.0-or-later program); it is accepted here
because the fonts are separate data files the browser loads, an aggregate with the program and
not a combined work, and issue #9 names OFL as the license of all three. The OFL allows
bundling and redistribution with software; the fonts are not sold on their own and are not
renamed, and none of the three declares a Reserved Font Name. A unit
test (`web/apps/web/tests/fonts.test.ts`) fails when a file's SHA-256 differs from its row or
a font file has no row.

## Candidates (not adopted, license not yet verified)

These come from SPEC section 7. They are not dependencies; each needs a row above and a
license check of the exact artifact before use.

| Candidate | Kind | What to verify | Planned for |
|---|---|---|---|
| qpdf (WASM) | WASM | license of the compiled build and its bundled libraries | PDF tools |
| wasm-vips / jSquash codecs | WASM | libvips is LGPL: linking terms of the WASM build; codec licenses (libwebp, libavif, mozjpeg) | image tools |
| Ghostscript (WASM) | WASM | AGPL-3.0: only as an optional extra, decided in spike T-13 | PDF compression |
| U²-Netp | model weights | Apache-2.0 per SPEC; confirm for the exact weights file | background removal |
| BiRefNet-lite | model weights | MIT per SPEC; confirm for the exact weights file | background removal (opt-in) |
| ONNX Runtime Web | WASM | MIT per SPEC; also covered by `THIRD-PARTY.md` as an npm package, check the shipped `.wasm` files | background removal |
| IEEE OUI snapshot | data | terms of use of the IEEE registry data | MAC lookup |
