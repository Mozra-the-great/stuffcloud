# Contributing

This is primarily a personal/solo-maintained project. If you're proposing a
change:

## Workflow

1. Never commit directly to `main` — create a feature branch.
2. Branch names: English, kebab-case, prefixed by type — `feat/...`,
   `fix/...`, `chore/...`, `docs/...`, `refactor/...`, `test/...`.
3. Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
   `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
4. Design change? Rebuild the PDF (`python docs/design/tools/pdf/build.py`, or the
   "Rebuild design PDF" workflow on your branch) and commit it with the PR; the
   `build` check fails while it is stale. See `docs/design/README.md`.
5. Add an entry under `[Unreleased]` in `CHANGELOG.md` (English, with the PR number).
6. Open a pull request against `main`. CI (and, where configured, Claude Code
   review) must pass before merge.
7. No `git push --force` on `main`.

## CI

Every PR runs the checks below (none has a `paths:` filter, so they run on
docs-only PRs too):

| Check | What it does |
|---|---|
| `build` | Aggregate of every job in `.github/workflows/ci.yml`: rustfmt, clippy (warnings are errors), unit/property/regression/doc tests, rustdoc, coverage (95 % floor), mutation testing of the changed lines, 2-minute fuzz run per target, frontend (`web/`: lint, svelte-check/tsc, Vitest with 95 % coverage floor, production build, frozen lockfile), npm license gate and `THIRD-PARTY.md` freshness, `cargo-deny`, CodeQL (`security-extended`, fails on any result), label-script tests, design PDF check |
| `workflow-lint` | actionlint + zizmor over the workflows and `dependabot.yml` |
| `gitleaks` | Secret scan over the PR range, using `.gitleaks.toml` |
| `claude-review` | Optional Claude Code review; needs the `CLAUDE_CODE_OAUTH_TOKEN` secret and is **skipped (green)** without it |

`deep-tests.yml` runs nightly and on demand (not required): long fuzzing, the
full mutation run, Miri, 500 000 property-test cases, fresh advisories and the
beta toolchain. Treat a red run like a red PR.

### Tests

Tests are part of the security design (`docs/SPEC.md`, section 14). A change to
Rust code comes with unit tests for both sides of every boundary; a new
invariant with a property test; a new parser of untrusted input with a fuzz
target; a fixed bug with an entry in `tests/regression.rs` and a seed in
`fuzz/seeds/`. Never lower a threshold or skip a check to get green.

### Frontend (`web/`)

The frontend is a pnpm workspace that only needs Node and pnpm; the Rust workspace
and its CI jobs do not depend on them. Use the Node version in `web/.nvmrc`
(`engine-strict` is on) and run `corepack enable` once, so pnpm matches the
`packageManager` field. From `web/`:

```sh
pnpm install --frozen-lockfile   # the lockfile is committed
pnpm lint        # ESLint (type-aware, `any` is an error) + Prettier --check
pnpm typecheck   # tsc / svelte-check
pnpm test        # Vitest; coverage floor 95 % in every package, never lower it
pnpm build       # Vite production build + package emit checks
pnpm format      # Prettier --write
```

Layout: `apps/web` (Svelte + Vite single-page app), `packages/tools` (tool modules),
`packages/api-client` (typed client; `pnpm --filter @stuffcloud/api-client generate
-- --input <openapi.json>` writes `src/generated/schema.d.ts` once `app` exports its
OpenAPI document). All settings come from `tsconfig.base.json` (`strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) and `eslint.config.js`.
The frontend jobs are part of `build`; run the commands above before opening a PR.

### Adding a dependency (license rules)

Every dependency needs a GPL-3.0-compatible license (`docs/SPEC.md`, section 3); two
CI gates enforce it and both run on every PR as part of `build`:

- **Rust:** `cargo deny check` (job `supply-chain`, `deny.toml`). A license that is not
  in `[licenses].allow` fails; exceptions are per crate, with a reason.
- **npm (`web/`):** `python3 scripts/ci/license_gate.py` (job `licenses`). It checks
  every package of the pnpm workspace, production and dev, including the native packages
  of other platforms, against `scripts/ci/license-policy.toml`. An unknown, missing or
  unlisted license fails.
  - The allow list there is the same list as in `deny.toml`; a unit test fails when they
    differ. Allowing a new license means: check that it is GPLv3-compatible, then add it
    to **both** files in the PR and say why in the PR description.
  - A license that is fine for tooling but not for shipped code (it is not in a
    production dependency tree) goes into `[dev_only]` with a reason.
  - A package with a missing or non-SPDX license field gets an `[[exception]]` (name and
    exact license text, with a reason) after you read its license file. It stops matching
    when the text changes.
- **`docs/THIRD-PARTY.md`** lists every runtime dependency with version, license and
  source. It is generated; after changing a lockfile run
  `python3 scripts/ci/third_party.py --write` (needs `cargo` and `pnpm`) and commit the
  result, or the `licenses` job fails with the diff.
- WASM modules, ML models, fonts and data files are in neither tree: add a row to
  `docs/THIRD-PARTY-ASSETS.md` in the same PR.

Run the tooling tests with `python3 -m unittest discover -s scripts/ci -p "test_*.py"`
(Python 3.11 or newer).

Workflow rules: actions are pinned by full commit SHA with a `# vX.Y.Z` comment,
event data (`github.event.*`, branch names, titles) goes through `env:` and
never into `run:` via `${{ }}`, and `permissions:` stays minimal. Run
`actionlint` and `zizmor` locally before pushing a workflow change; the setup
steps, costs and the open runner/ruleset decisions are in
[`docs/TEMPLATE-SETUP.md`](docs/TEMPLATE-SETUP.md).

## Reporting bugs / requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`.

## Security issues

Do not open a public issue — see [`SECURITY.md`](SECURITY.md).
