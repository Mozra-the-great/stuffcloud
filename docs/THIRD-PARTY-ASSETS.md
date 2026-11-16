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
| none yet | | | | | | |

The register is empty because no tool that needs one exists yet.

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
| Pixel font, monospace font, sans-serif font | fonts | font license (OFL or similar), self-hosted files | design system (the mockups still load Google Fonts) |
