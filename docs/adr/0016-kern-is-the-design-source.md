# ADR 0016: kern is the design source; `docs/design` is a frozen reference

- Status: Accepted
- Date: 2026-11-26
- Decided in: issue [#199](https://github.com/Mozra-the-great/stuffcloud/issues/199) (operator
  decision of 2026-11-26), kern companion issue
  [kern#181](https://github.com/Mozra-the-great/kern/issues/181), [SPEC 12](../SPEC.md#12-design-and-ux)
- Supersedes: decision 4 of [ADR 0014](0014-frontend-components-from-shared-design-kit.md) ("`docs/design`
  stays the design source") and the generated `tokens.css` of its decision 3. The rest of ADR 0014 (the
  components come from kern, the pinned tarball, the dark `code` theme, updates by hand) stays. The art
  and the theme texts of its decision 7 move in a later step (see decision 5); until then that decision
  holds as written.

## Context

Since #121 the UI is built from kern (ADR 0014). ADR 0014 still made `docs/design` the binding design:
kern's `code` theme was aligned with it item by item (kern#111), a drift check in kern failed when a
recorded design value changed, `pnpm tokens` generated `src/styles/tokens.css` from
`docs/design/prototypes/stuff.css`, and the build failed unless the design PDF and its source hash were
rebuilt in every PR that touched the design folder. That made every kern improvement expensive: it had to
be ported back into stuffcloud's mockups, README, tokens and the PDF before it could ship.

## Decision

1. **kern is the design source.** Everything that is not hyper-specific to stuffcloud lives in kern:
   tokens, components, patterns and the `code` theme. The `code` theme still orients on stuffcloud's
   design but no longer has to match `docs/design`; kern may improve it (accessibility, consistency)
   without a port back here.
2. **Tokens come from kern.** The app uses kern's `--k-*` tokens of the `code` theme
   (`<html data-theme="code">`) directly. `pnpm tokens`, `scripts/tokens.ts`, `scripts/gen-tokens.ts` and the
   generated `tokens.css` are gone, and so are the app-local copies of colours, fonts, spacing and
   control sizes (`--bg`, `--mut`, `--pink`, `--space-16`, `--control-h`, ...). A token the app needs that
   kern lacks is filed as a kern issue first (open and closed ones searched; kern is never changed from
   here). Until kern ships it the app keeps a minimal local `--sc-*` token in `src/styles/theme.css` with a
   "waiting for kern#N" comment. There is one today: `--sc-stage`, the violet panel behind the mascot
   ([kern#188](https://github.com/Mozra-the-great/kern/issues/188)).
3. **Contrast is still tested here.** `tests/contrast.test.ts` reads the values the app ships from the
   installed kern package (`dist/themes/base.css`, `dist/themes/brands/code.css`, the dark block) and keeps
   every pair it had: text 4.5:1, indicators 3:1, field borders 3:1 on every surface. kern's own theme
   contrast test covers each theme with its own pair list, not the pairs this app draws, so it does not
   replace this one; a kern bump that weakens a pair fails here. A second test resolves every
   `var(--name)` in the sources to a kern token or a `--sc-*` token, so a renamed or removed kern token
   fails the build instead of silently dropping a style.
4. **`docs/design` and the design PDF are a frozen reference.** They show the intent of the November 2026
   exploration to orient on, not a specification. No rebuild duty, no CI check: the "Design PDF is
   current" step, `source_hash.py` and `pdf-source.sha256`, the "Rebuild design PDF" workflow and its
   deploy-key secret, the PR template box and the CLAUDE.md and CONTRIBUTING rules are removed, and so is
   the PDF build tooling (`docs/design/tools/pdf/`): a frozen document needs no builder, an unmaintained one
   would rot under CodeQL's Python scan without a test or a dependency pin, and git history keeps it. The
   folder's README carries a banner.
5. **Art and theme texts move to kern (second step).** Stickers, mascots (Stuffy and the easter-egg cast),
   season and special-day sets and `THEME-TEXTS.md` are reusable, so they move to kern
   ([kern#182](https://github.com/Mozra-the-great/kern/issues/182) to
   [#185](https://github.com/Mozra-the-great/kern/issues/185)); stuffcloud then consumes them and deletes
   its copies. What stays here is what is truly stuffcloud-only: the page layouts, the tool-category to
   sticker mapping and the app's own copy. kern ships first; until then the files in `docs/design` keep
   working, and an addendum to this record notes the switch.

## Consequences

- Positive: a kern theme change reaches the app through a kern bump alone; no change under `docs/design`,
  no PDF, no token regeneration.
- Positive: one token vocabulary in the whole app (`--k-*`), no second palette to keep in step.
- Negative: the app's look now depends on kern releases. A kern bump can change a token value; the contrast
  test and the unresolved-variable test catch weakened or removed tokens, and the visual diff of the bump
  PR (ADR 0014, decision 6) is the check for the rest.
- Negative: until decision 5 is done, a sticker or mascot change still edits `docs/design` files, but
  without any PDF duty.
- Operator note: the Actions secret `DESIGN_PDF_DEPLOY_KEY` and the repository deploy key behind it are
  unused now and can be deleted.

## Open points

- The art, season sets and theme texts (decision 5) wait for kern's release of #182 to #185.
- `--sc-stage` waits for kern#188.

## Alternatives considered

- **Keep the PDF check but make it advisory**: still a duty nobody benefits from; the issue asks for none.
- **Keep the PDF tooling as an unmaintained tool**: the Python code and its unpinned requirements would stay
  under CodeQL for no use; a frozen PDF is not rebuilt. Rejected, deleted.
- **Keep the generated `tokens.css` but source it from kern**: a second copy of kern's values with its own
  drift to guard; kern's tokens are consumable directly.
- **Rely on kern's contrast test alone**: it tests kern's own pair list per theme, not the pairs this app
  draws; rejected (see decision 3).

## Links

- Issue [#199](https://github.com/Mozra-the-great/stuffcloud/issues/199), kern
  [#181](https://github.com/Mozra-the-great/kern/issues/181),
  [#188](https://github.com/Mozra-the-great/kern/issues/188).
- [ADR 0014](0014-frontend-components-from-shared-design-kit.md), [SPEC 12](../SPEC.md#12-design-and-ux).
