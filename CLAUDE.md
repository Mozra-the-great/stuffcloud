# stuffcloud

Self-hosted toolbox (client-side tools) + one-click static hosting. Full spec: `docs/SPEC.md`.

## Type
Greenfield project (public, GPL-3.0).

## Stack
Rust backend (Cargo workspace: `axum`, `tokio`, SQLite) + Svelte/Vite frontend
(TypeScript strict), Caddy, Docker Compose. See `docs/SPEC.md` sections 4 and 14.
Exists so far: `crates/core` (validation, no I/O), `fuzz/` and the `web/` scaffold.
`app`, `edge`, `db` and `cli` are added in the phase that needs them; each new crate
inherits `[workspace.lints]` (`[lints] workspace = true`).

## Structure
```
crates/core/    domain types + validation (SafeRelPath, Subdomain), no I/O
  tests/        properties.rs (proptest), regression.rs (attack corpus)
web/            pnpm workspace (Node 24, own lockfile; the backend never depends on it)
  apps/web/     Svelte + Vite SPA (static build)
  packages/tools/       tool modules (manifest type, id rules)
  packages/api-client/  typed client + OpenAPI generation script (generated file comes with app)
  tests/        lint-config test (a deliberate `any` must fail lint)
fuzz/           cargo-fuzz targets, seeds, dictionary (own workspace, nightly)
Cargo.toml      workspace, lint set, release profile (overflow checks on)
deny.toml       cargo-deny: advisories, GPL-compatible licenses, sources
rust-toolchain.toml  pinned stable (same as rust-version in Cargo.toml)
.github/        workflows (ci, deep-tests, claude review, workflow-lint, secret-scan), rulesets, templates
scripts/ci/     label script (opt-in via LABELS_ENABLED), npm license gate (license_gate.py,
                license-policy.toml), THIRD-PARTY.md generator (third_party.py), tests
docs/           SPEC.md, THIRD-PARTY.md (generated), THIRD-PARTY-ASSETS.md, design/, TEMPLATE-SETUP.md
```

## Commands
```sh
cargo fmt --all && cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets          # unit, property, regression tests
cargo llvm-cov --workspace --fail-under-lines 95 --fail-under-regions 95
cargo mutants --workspace                     # every mutant must be caught
cargo deny check && cargo deny --manifest-path fuzz/Cargo.toml check
cargo +nightly-2026-11-01 fuzz run safe_rel_path fuzz/corpus/safe_rel_path \
    fuzz/seeds/safe_rel_path -- -dict=fuzz/dicts/stuffcloud.dict -max_total_time=60
python -m unittest discover -s scripts/ci -p "test_*.py"   # CI helper tests (Python 3.11+)
python scripts/ci/license_gate.py             # npm license gate (needs pnpm; installs into a temp dir)
python scripts/ci/third_party.py --write      # regenerate docs/THIRD-PARTY.md after a lockfile change
```
Tools: `cargo install --locked cargo-llvm-cov cargo-mutants cargo-deny cargo-fuzz`
(CI pins their versions in the workflows).

Frontend, from `web/` (`corepack enable` once; Node per `.nvmrc`):
```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # coverage floor 95 % per package
```

## Tests (non-negotiable)
Tests are part of the security design; err on the side of too many (SPEC section 14).
- Every rule gets unit tests on both sides of every boundary, every error variant
  and message is asserted. Coverage floor 95 % lines and regions; never lower it to
  get green.
- Every invariant gets a property test; every parser of untrusted input gets a fuzz
  target that asserts invariants, not just "no panic".
- Every bug and fuzz finding becomes an entry in `tests/regression.rs` and a seed in
  `fuzz/seeds/<target>/`.
- A surviving mutant is a missing test: add the test, do not skip the mutant.
- Never weaken a check (`#[allow]`, `ignore`, lower thresholds, `continue-on-error`)
  to make CI pass; `#[expect(..., reason = "...")]` only where the reason is a proof.

## CI
`ci.yml` job `build` is the required check: an aggregate over fmt, clippy, test,
docs, coverage, mutants, fuzz, web (lint, typecheck, test, build of `web/`), licenses (npm
license gate + THIRD-PARTY.md freshness), supply-chain, codeql and repo-checks (add new jobs to its `needs`; no job skips itself on changed
paths, because the aggregate counts a skipped job as a failure). `deep-tests.yml` runs nightly: long fuzzing (grows the cached corpus),
full mutants, Miri, 500k proptest cases, fresh advisories, beta toolchain.
Toolchain bump: `rust-toolchain.toml` + `rust-version` in `Cargo.toml`; nightly
bump: `NIGHTLY` in both workflows. Dependabot handles actions, cargo and npm (`/web`,
minor/patch grouped; semver-major `@types/node` is ignored, it follows the Node major in
`web/.nvmrc` and is bumped by hand together with it).

## Dependencies and licenses
A new dependency must have a GPL-3.0-compatible license. Rust: `cargo deny` (`deny.toml`).
npm: `scripts/ci/license_gate.py` against `scripts/ci/license-policy.toml` (prod and dev,
all platform variants; unknown or missing license fails). The allow list there equals
`deny.toml`'s (a unit test enforces it): add a new license to both, after checking it.
Dev-tooling-only licenses go into `[dev_only]`, odd license fields into `[[exception]]`,
each with a reason. After a lockfile change regenerate `docs/THIRD-PARTY.md` with
`python scripts/ci/third_party.py --write` (CI fails on a stale file). WASM, models, fonts
and data files go into `docs/THIRD-PARTY-ASSETS.md`. Details: CONTRIBUTING.md.

## Changelog
Every PR with a visible change (code, docs, design, CI) adds an entry under
`[Unreleased]` in `CHANGELOG.md` (Keep a Changelog: Added / Changed / Fixed /
Removed), written in English, with the PR number in parentheses. Add it in the
same PR, not afterwards. Pure typo fixes and dependency bumps by Dependabot are
exempt. A release moves `[Unreleased]` under the new version heading.

## Design PDF
`docs/design/stuffcloud-design-system.pdf` is generated from `docs/design/`. Any PR
that changes the design (mockups in `docs/design/prototypes/`, `stuff.css`, stickers,
mascots, decorations, `THEME-TEXTS.md`, tokens or rules in `docs/design/README.md`)
must regenerate and commit the PDF (and `docs/design/pdf-source.sha256`) in the same PR;
the `build` check fails when they are stale. Without a local Chrome run the
"Rebuild design PDF" workflow on the branch instead (`gh workflow run design-pdf.yml -f branch=<name>`).
Locally:
`pip install -r docs/design/tools/pdf/requirements.txt` once, then
`python docs/design/tools/pdf/build.py`. A new mockup also goes into `PAGES` in
`docs/design/tools/pdf/shots.py`; a new sticker group into `STICKER_GROUPS` in
`docs/design/tools/pdf/build_book.py` (unlisted stickers land in "Other").

## Notes
- Merge gate: ruleset in `.github/rulesets/default.json` (required checks: build,
  workflow-lint, gitleaks, claude-review). CodeQL is the advanced setup
  (`codeql.yml`, called by `ci.yml` as job `codeql`, so `build` covers it); it fails
  on any result. Do not enable the default setup in the repo settings (it blocks the
  uploads). False positives: dismiss in code scanning and exclude the query in
  `.github/codeql/codeql-config.yml` with a reason. Languages: rust, python, actions,
  javascript-typescript.
- Claude review needs the Actions secret `CLAUDE_CODE_OAUTH_TOKEN`; without it the job skips and stays green.

---

## Working rules

These rules apply regardless of what's above. They mirror the operator's global
Claude Code configuration so this repo behaves consistently even if opened on a
different machine or by a collaborator.

### Language
- Chat responses: German
- Everything that goes into the repo — code, comments, commit messages, branch
  names, PR descriptions, CHANGELOG: English (default, more compact)
- Respect a project's already-established language convention if one exists

### Approach — get it right once instead of fixing it ten times
1. Fully understand the task before starting
2. Think through the solution: edge cases, error handling, dependencies, blast radius
3. Only then implement it completely and correctly

No placeholders. No `// TODO` without a resolution attached. No half-finished
implementations.

For larger tasks: use Plan Mode before writing code. If something is fundamentally
unclear and would change the direction of the solution, ask once rather than
building in the wrong direction.

### Coding rules
- TypeScript: no `any`, explicit types
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- Follow the project's existing conventions over these defaults when they conflict

### Git workflow
- Never commit directly to `main`/`master` — always a feature branch
- Branch names in English, kebab-case (`feat/...`, `fix/...`)
- Before every push: check `git status` and `git diff --staged`
- No `git push --force` on main/master

### Security
- `.env`, `.env.*`, `*.pem`, `*.key`, `*.secret` — never read, log, or commit
- No credentials/tokens/passwords in code
- Secrets via environment variables or a secrets manager, never in plaintext

### Subagents — delegate proactively
Use these specialists without being asked each time, as soon as the situation fits:

- **test-runner** → right after writing or changing application code
- **security-reviewer** → after auth/input/dependency changes, and before any release
- **code-reviewer** → before a merge / after finishing a feature
- **debugger** → as soon as a test fails, a stack trace shows up, or behavior is unexpected

Run independent analyses (e.g. security + tests) in parallel. Skip subagents for
trivial changes — the overhead isn't worth it.
