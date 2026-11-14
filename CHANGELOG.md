# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Rust workspace with `crates/core`: `SafeRelPath` (upload path hardening: NFC,
  no traversal, no hidden, control, invisible or Windows-reserved names, length
  and depth limits) and `Subdomain` (label rules, reserved names, no Punycode,
  unbiased generation from caller-supplied random bytes), with unit, property
  (proptest) and regression tests; strict workspace lint set (`unsafe` forbidden,
  no `unwrap`/indexing/unchecked arithmetic), pinned toolchain, release profile
  with overflow checks.
- `fuzz/`: cargo-fuzz targets `safe_rel_path` and `subdomain` with invariant
  checks, seeds and a dictionary.
- `deny.toml`: cargo-deny gate for RustSec advisories, GPL-3.0-compatible
  licenses, crates.io-only sources and wildcard versions.
- `deep-tests.yml`: nightly long fuzzing with a cached, minimised corpus, full
  mutation run, Miri, 500 000 property-test cases, fresh advisories and the beta
  toolchain.
- Label `area/backend` with path rules for the Rust files.
- `codeql.yml` (CodeQL advanced setup, `security-extended`, Rust, Python and
  Actions): runs as job `codeql` inside `ci.yml`, so the required `build` check
  covers it, fails on any result, and runs weekly on `main`; config in
  `.github/codeql/codeql-config.yml`.
- `docs/SPEC.md`: project specification (draft 0.2) with the decisions of the
  requirements interviews. (#3, #76, #78)
- `docs/design/`: design reference with the final style (dark grid, pink and
  violet), tokens, page library for desktop and mobile in `prototypes/` (72 mockups,
  `stuff.css`), mascots and easter eggs, 17 seasonal and special-day decoration
  sets with the theme button, and `THEME-TEXTS.md`. (#75, #76, #80, #83, #84, #89)
- Sprite generators `docs/design/tools/mascots.py`, `seasons.py` and `stickers.py`
  (ASCII art to SVG) and 42 pixel tool stickers, one per tool. (#85, #87)
- Tool pages show their sticker beside the title (`.tt` in `stuff.css`). (#88)
- `docs/design/stuffcloud-design-system.pdf` and its build system
  (`docs/design/tools/pdf/`: `build.py`, `shots.py`, `build_book.py`); a design
  change must rebuild the PDF in the same PR, enforced by the `build` check
  (`source_hash.py`, `pdf-source.sha256`) and supported by the "Rebuild design PDF"
  workflow (`design-pdf.yml`); documented in `CLAUDE.md`, `CONTRIBUTING.md`, the PR
  template and `docs/design/README.md`. (#91, #92)
- Changelog rule: every PR with a visible change adds an entry under
  `[Unreleased]`; documented in `CLAUDE.md`, `CONTRIBUTING.md` and the PR template. (#90)
- CI building blocks from nagellacke and homelab-infra, stack-agnostic: `ci.yml`
  skeleton (job `build`), `workflow-lint.yml` (actionlint + zizmor),
  `secret-scan.yml` (gitleaks) with `.gitleaks.toml`, `dependabot.yml`, opt-in
  labels-as-code (`labels.json`, `labels.yml`, `scripts/ci/`) and a ruleset
  template under `.github/rulesets/` (not auto-applied).
- `docs/TEMPLATE-SETUP.md`: secrets, runner choice, rulesets and costs of a new repo.

### Changed
- `docs/SPEC.md` draft 0.3: backend in Rust (`axum`, SQLite) instead of
  Node.js/Fastify; new minimal `edge` process as the only stuffcloud code the
  internet reaches (site password, burn-after-reading, reports); shared `core`
  crate; OpenAPI-generated frontend client; standalone CLI binaries; hardened
  containers; subdomain and path rules spelled out; section 14 rewritten as a
  test strategy that errs on the side of too many tests.
- `ci.yml`: `build` is now an aggregate over fmt, clippy, tests (debug and
  release), rustdoc, coverage (95 % floor), mutation testing, a short fuzz run per
  target, cargo-deny and the repository checks. `dependabot.yml` enables cargo
  for the workspace and `fuzz/`. CLAUDE.md, README, CONTRIBUTING, the PR template
  and the ruleset README describe the new pipeline.
- `design-pdf.yml` pushes with a write deploy key (secret `DESIGN_PDF_DEPLOY_KEY`),
  so every required check including `claude-review` runs on the rebuilt commit.
  Without the secret it falls back to the workflow token and dispatches `ci.yml`,
  `workflow-lint.yml` and `secret-scan.yml` for the commit; only `claude-review`
  then needs a follow-up push. (#93, #94)
- Project placeholders filled in and `claude-review` added to the required checks of
  the ruleset. (#2)
- `docs/TEMPLATE-SETUP.md`, README and ruleset README: runner decisions of
  2026-11-04 (D1: hosted runners are the default, the own runner on CT121 only for
  private homelab jobs or as fallback; D2: hosted minutes for private repos are
  available; D6: workflows are copied per repo, no central reusable workflows).

### Fixed
- `SECURITY.md`: personal e-mail address removed. (#74)
- Mockups: Mochi redrawn as a cream cat, Ember's ears made symmetric, Waddle
  redrawn with friendlier eyes. (#77, #79)
- Mobile: stacked form rows no longer get a fixed height. (#86)
- `claude.yml`: the job only starts for `@claude` mentions from an `OWNER`,
  `MEMBER` or `COLLABORATOR` (job-level `author_association` gate), so drive-by
  mentions on a public repo cannot start a run. The action's own write-permission
  check remains as the second layer.
- `claude.yml`: explicit `claude_args` tool allowlist
  (`--allowedTools Skill,Bash,Read,Edit,Write,Grep,Glob`) instead of the action's
  unrestricted default; documented in `docs/TEMPLATE-SETUP.md`.

### Changed
- `claude-code-review.yml` replaced by the hardened nagellacke version
  (`--comment`, inline-comment allowlist, `--disallowedTools`, concurrency group,
  execution-log artifact, fail-on-findings). Both Claude workflows now skip
  green when `CLAUDE_CODE_OAUTH_TOKEN` is not set instead of failing red.
- All actions pinned by commit SHA.
