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
   A decision that is expensive to reverse (stack, hosting model, storage, auth, public
   surface, test strategy) also gets an architecture decision record, see
   [Architecture decisions](#architecture-decisions).
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

### Operator-domain check (maintainers)

stuffcloud is instance-neutral (CLAUDE.md): no real domain of any operator may appear in a
tracked file. `scripts/ci/check_operator_domains.py` (step "No operator domain in tracked
files" of `repo-checks`, part of `build`) searches every tracked file and file name for the
domains and e-mail addresses of a list that is **not in the repository**. The list is read from the environment
variable `STUFFCLOUD_FORBIDDEN_DOMAINS`, which the workflow fills from the repository's Actions
secret of the same name (preferred) or, if there is no secret, from the Actions variable of
the same name.

Setting it (repository admin, once; **Settings > Secrets and variables > Actions**):

1. Tab **Secrets**, **New repository secret** (preferred; a secret is masked in logs and is not
   passed to pull requests from forks). Name: `STUFFCLOUD_FORBIDDEN_DOMAINS`.
   Alternatively tab **Variables**, **New repository variable**, same name; note that a
   variable is plain text and may be readable by workflows of fork pull requests, so use it
   only for names that may become known.
2. Value: the registrable domains and e-mail addresses to keep out, one per line or separated
   by commas, in the format `one.example, two.example, someone@mail.example` (placeholders:
   reserved names are ignored, so enter the real ones). `#` starts a comment.
   - **Domain entry** (no `@`): a leading `*.` is ignored, subdomains are covered
     automatically, matching is case-insensitive, an internationalised name is matched in its
     Unicode and its Punycode form.
   - **E-mail entry** (contains `@`): exactly one address, `local@domain`, with a dot in the
     domain. It protects that one mailbox without forbidding its provider: `someone@mail.example`
     does not make `mail.example`, `other@mail.example` or `www.mail.example` a violation.
     Matching is case-insensitive and on whole addresses only: `xsomeone@mail.example`,
     `first.someone@mail.example` and `someone@mail.example.org` are not hits. Also found: the `@`
     written as `%40`, `&#64;`, `&#x40;`, `&commat;` or `\u0040`, an address after a `%XX` escape
     (`a%20someone@mail.example`), and an address in a file name. Not found: `someone [at]
     mail.example`, split or reversed text, base64 or quoted-printable, a double-encoded `%2540`,
     and an address directly followed by a file extension in a file name
     (`someone@mail.example.json`, which looks like a longer domain). The local part is ASCII
     (letters, digits and ``! $ % & ' + / = ? ^ _ ` { | } ~ . -``, at most 64 characters, no
     leading, trailing or doubled dot; `#`, `*`, `,` and `;` are not allowed), the domain part
     may be internationalised. Enter the bare address, without a display name or `<...>`.
   - Names reserved for documentation (`example.com`, `example.org`, `example.net`,
     `*.example`, `*.test`, `*.invalid`, `*.localhost`) are always allowed and ignored if
     listed, as a domain or as the domain part of an address.
3. A malformed entry (neither a valid domain nor a valid address) fails the check (exit code 2)
   with the number of the entry, never its text. A finding prints `path:line: forbidden domain
   (entry N)`, for an e-mail entry `path:line: forbidden e-mail address (entry N)`: the listed
   domain or address and the offending line are never printed, because the logs of a public
   repository are public.

Without the secret or variable, or for pull requests that do not receive it (forks,
Dependabot), the step prints a notice and passes: a **reduced check**, nothing was searched
for. Own pull requests get the full check. Run it locally with the same variable:
`STUFFCLOUD_FORBIDDEN_DOMAINS=... python scripts/ci/check_operator_domains.py`. Its tests use
only reserved names (`*.example` placeholders, also for the addresses) (`python -m unittest discover -s scripts/ci -p "test_*.py"`).

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

A new tool starts with `pnpm new-tool <id>` (manifest, page, test, German and English texts;
`--worker` adds the worker setup); `pnpm check-tools` validates every manifest and `pnpm build`
fails on a bad one (ADR 0012).

Browser tests: `pnpm e2e` runs Playwright in Chromium and Firefox against the built app (once:
`pnpm --filter @stuffcloud/web exec playwright install chromium firefox`; details in
`web/apps/web/e2e/README.md`). Accessibility is checked on every PR: each e2e state calls
`a11y.check(page, '<state>')` (axe, WCAG 2.2 AA, zero violations), and every tool brings a spec that
also walks it with the keyboard alone (`pnpm new-tool` creates it). The gate, the keyboard map and
the focus and live-region rules are in [`docs/ACCESSIBILITY.md`](docs/ACCESSIBILITY.md); the
reduced-motion test needs no work from a tool as long as it does not animate on its own.

Layout: `apps/web` (Svelte + Vite single-page app), `packages/tools` (manifest schema, worker pool),
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

## Architecture decisions

Decisions that are expensive to reverse are written down as ADRs in
[`docs/adr/`](docs/adr/README.md): context, decision, consequences and alternatives
considered. Read the index before changing the stack, the hosting or auth model, storage, the
public surface or the test strategy. To add one, copy the template in
[`docs/adr/README.md`](docs/adr/README.md), take the next free number, add it to the index and
update `docs/SPEC.md` in the same PR if the decision changes what the SPEC says. Do not edit an
accepted ADR to change its decision: write a new one that supersedes it (an addendum that
only fills a gap, such as the SQLite driver in ADR 0001, is added to the original).

## Reporting bugs / requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`.

## Security issues

Do not open a public issue — see [`SECURITY.md`](SECURITY.md).
