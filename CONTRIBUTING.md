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
| `build` | Aggregate of every job in `.github/workflows/ci.yml`: rustfmt, clippy (warnings are errors), unit/property/regression/doc tests, rustdoc, coverage (95 % floor), mutation testing of the changed lines, 2-minute fuzz run per target, `cargo-deny`, CodeQL (`security-extended`, fails on any result), label-script tests, design PDF check |
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
