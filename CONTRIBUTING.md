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
| `build` | Aggregate of every job in `.github/workflows/ci.yml`: rustfmt, clippy (warnings are errors), unit/property/regression/doc tests, rustdoc, coverage (95 % floor), mutation testing of the changed lines, mutation testing of the Python CI helpers (`mutation-python`), mutation testing of the TypeScript logic of the files a PR changes (`web-mutants`), 2-minute fuzz run per target, frontend (`web/`: lint, svelte-check/tsc, Vitest with 95 % coverage floor, production build, frozen lockfile), npm license gate and `THIRD-PARTY.md` freshness, `cargo-deny`, CodeQL (`security-extended`, fails on any result), label-script tests, design PDF check |
| `workflow-lint` | actionlint + zizmor over the workflows and `dependabot.yml` |
| `gitleaks` | Secret scan over the PR range, using `.gitleaks.toml` |
| `claude-review` | Optional Claude Code review; needs the `CLAUDE_CODE_OAUTH_TOKEN` secret and is **skipped (green)** without it |

`deep-tests.yml` runs nightly and on demand (not required): long fuzzing, the
full mutation run (Rust and the Python CI helpers; the TypeScript logic of `web/` on demand until its survivors are closed), Miri, 500 000 property-test cases, fresh
advisories and the beta toolchain. Treat a red run like a red PR.

### Tests

Tests are part of the security design (`docs/SPEC.md`, section 14). A change to
Rust code comes with unit tests for both sides of every boundary; a new
invariant with a property test; a new parser of untrusted input with a fuzz
target; a fixed bug with an entry in `tests/regression.rs` and a seed in
`fuzz/seeds/`. Never lower a threshold or skip a check to get green.

### Mutation testing of the Python CI helpers

The helpers in `scripts/ci/` are security gates whose only visible output is "pass", so the
rule of the Rust code holds for them too (ADR 0007, addendum): a surviving mutant is a
missing test. [mutmut](https://github.com/boxed/mutmut) 3 changes every function of
`scripts/ci/*.py` one small step at a time (an inverted comparison, a `return None`, a changed
string or number) and reruns the tests that call it; a mutant that no test notices fails the
check. `mutmut run` itself always exits 0, so `scripts/ci/mutation_gate.py` reads its summary
and fails on a survivor, on a mutant without any test, and on an empty run.

- **CI:** job `mutation-python` in `ci.yml` (part of `build`) runs the whole directory when a PR
  touches `scripts/ci/` or `pyproject.toml`, and on every push to `main`; the job never skips
  itself, on any other PR its steps pass with nothing to do. `deep-tests.yml` runs it
  every night and keeps the report (`mutmut-report`: summary, list of survivors with their diffs,
  the per-file results) as an artifact. The full run is 4 188 mutants and takes about 16 minutes on
  the four cores of a hosted runner (about 4.5 mutants per second; 46 mutants are endless loops
  that end at mutmut's time limit and count as caught), plus about a minute of set-up and
  coverage. That is why the PR job runs only when the helpers changed, and always the whole directory.
- **Locally** (mutmut needs `fork`: Linux, macOS or WSL, not native Windows):
  `python -m pip install --require-hashes --no-deps -r scripts/ci/requirements-mutmut.txt`, then
  `mutmut run && mutmut export-cicd-stats && python scripts/ci/mutation_gate.py` from the repository
  root. `mutmut results` lists what survived, `mutmut show <name>` shows the change. mutmut reruns only
  functions whose source changed, so a second run after a fix is fast. The `mutants/` directory is a
  copy of the tree (ignored by git).
- **A survivor is fixed with a test**, never by skipping it. Only a mutant that provably cannot change
  behaviour gets `# pragma: no mutate` on its line (or `# pragma: no mutate block` on a `def`), and the
  comment says why it is equivalent.
- **Scope:** every `scripts/ci/*.py` except the tests and `conftest.py`. `dev_stack_smoke.py` drives a
  running Docker stack and is not mutated (the CI job `dev-stack` runs it for real; importing it also
  patches `socket.getaddrinfo`). `check_container_hardening.py` is mutated completely: its Docker calls
  all go through `run`, which the tests replace by a recorder, so no Docker is needed.
- **Layout:** the helpers find the repository from their own location, so `pyproject.toml`
  (`[tool.mutmut]`) copies the files the tests read into `mutants/` (`also_copy`). A new helper or a
  test that reads another part of the repository adds it there. The helpers and their tests import each
  other by plain file name, mutmut names mutants after the path (`scripts.ci.check_cookies`), so
  `scripts/ci/conftest.py` (pytest only, not used by `unittest`) registers every helper under both names.
- **Windows:** mutmut does not run natively on Windows (it needs `fork`). The unit tests, the mutation
  gate and the coverage run do; for the mutation run use WSL or let CI do it.
- **mutmut itself** is CI tooling: pinned with hashes (`requirements-mutmut.txt`, generated from
  `requirements-mutmut.in` with `pip-compile --generate-hashes`, installed with `--require-hashes`) and
  updated by Dependabot (`pip`, `/scripts/ci`). Nothing of it is shipped and the helpers stay
  standard-library only. It is in neither license gate (they read `Cargo.lock` and the pnpm lockfile),
  so no policy file changes; the licenses are checked by hand when a pin changes. Checked for the
  current pins (PyPI metadata): BSD-3-Clause (mutmut, click, setproctitle), BSD-2-Clause (pygments, colorama),
  MIT (pytest, rich, textual, libcst, pluggy, pyyaml, markdown-it-py and its plugins, ...),
  Apache-2.0 (coverage), Apache-2.0 OR BSD-2-Clause (packaging) and PSF-2.0 (typing-extensions, and the
  parts of libcst derived from the standard library); all are GPL-3.0-compatible and tooling only. Look at
  the licenses of every package a Dependabot PR adds before merging.
- `coverage.py` (installed with mutmut) measures the line and branch coverage of the helpers in the
  same job (floor in `ci.yml`), which shows untested branches before the mutation run starts.

### Mutation testing of the TypeScript logic

The rule of the Rust code holds for the logic in `web/` too (ADR 0007, addendum): a surviving
mutant is a missing test. Coverage shows that a line ran, not that a wrong line would be
noticed, and a flipped comparison in the subnet calculator or a sanitiser branch no test asserts on
passes the 95 % floor. [StrykerJS](https://stryker-mutator.io/) 10 (Apache-2.0) changes the code one
small step at a time (an inverted comparison, a removed statement, a changed string or number) and
reruns the Vitest tests that cover that line; a mutant that no test notices fails the check.

- **Scope:** the `.ts` files of `web/apps/web/src/tools/<id>/` and `web/apps/web/src/pdf/`, and of
  `web/packages/tools/src/`, without tests, the `manifest.ts` of each tool (static data that the manifest schema, which is
  mutated, and `pnpm check-tools` check) and `.d.ts` files. The scope and its exclusions, each with its reason,
  are in `web/apps/web/stryker.config.mjs`, `web/packages/tools/stryker.config.mjs` and
  `web/stryker.shared.mjs`. Not in scope for now: `packages/api-client` (generated), `src/i18n/messages`
  (catalogues, string literals only), `src/styles` (generated tokens) and the `.svelte` components (they
  mostly render, and the e2e specs with axe cover them); the components are worth another look once the
  logic is clean.
- **Locally**, from `web/`: `pnpm test:mutation` runs both packages, `pnpm --filter @stuffcloud/tools test:mutation`
  one. A single file: `pnpm exec stryker run --mutate src/tools/subnet/net.ts` in the package directory.
  `STRYKER_CHANGED_FILES_FILE=<list>` restricts a run to the listed files (paths relative to `web/`, one per
  line) and `STRYKER_SHARD=<index>/<count>` to one share of the scope, split by file size; the HTML
  report is `reports/mutation/mutation.html`. While a survivor is being killed,
  `STRYKER_TESTS="tests/tools/subnet*.test.ts"` runs only those test files (seconds instead of minutes for the
  initial run); the final check runs them all. Stryker instruments the files in place (the tests read
  files outside their package) and puts them back at the end; do not edit sources while it runs.
- **CI:** the job `web-mutants` in `ci.yml` (part of `build`, one leg per package) mutates the scoped files
  the PR changes, with `--incremental` and the report that the last push to `main` cached; it never skips
  itself, a PR without a scoped file runs its steps and passes with nothing to do.
  `thresholds.break: 100` fails the job on any survivor, on a mutant that no test covers and on a
  run that mutated nothing. The full run of every file is the job `web-mutants-full` in `deep-tests.yml`
  (8 shards of `apps/web` and one of `packages/tools`, sharded by file size, HTML and JSON reports as
  artifacts). It runs on demand until the last survivor of the progress list in #162 is closed; the
  commit that closes it removes its `if:` line and the job joins the nightly run.
- **A survivor is fixed with a test**, never by excluding the file or lowering the threshold: assert both
  sides of the boundary, the exact message, the value that was lost. Only a mutant that provably cannot
  change behaviour gets `// Stryker disable next-line <mutator>: <reason>`, with the proof as the reason.
  Where a small change of the code removes the equivalent mutant (a type guard that is exactly
  `Number.isFinite` instead of a `typeof` check next to it), change the code instead.
- **Timing tests:** the instrumented code is several times slower, so a test that bounds its run time
  writes the limit as `timeBudget(ms)` (`tests/time-budget.ts`); `vitest.stryker.config.ts` multiplies it
  under Stryker and leaves it alone everywhere else. A mutant that makes a run endless ends at the time
  limit of Stryker (`timeoutMS`) and counts as caught, like with `cargo mutants`.
- **Stryker itself** is a `devDependency` of both packages (`@stryker-mutator/core`, `vitest-runner`),
  in the lockfile and the npm license gate like every other dev tool. It brings in `caniuse-lite`
  (CC-BY-4.0, browser support data, never shipped), which is in `[dev_only]` of
  `scripts/ci/license-policy.toml` with that reason. `docs/THIRD-PARTY.md` lists runtime dependencies
  only and does not change.

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

Size budgets (T-25): `pnpm perf:build && pnpm check-budgets` builds the app with the Vite manifest and checks the
gzip size of the shell and of every tool against `web/apps/web/perf-budgets.json` and the `budget` of each manifest
(CI job `perf-budgets`); `pnpm lighthouse` (with `CHROME_PATH` set) runs the Lighthouse gate on that build (CI job
`lighthouse`, performance, accessibility and best practices at least 95). A new tool sets its `budget` to the measured
size plus 15 %; a bigger budget is a reviewed change with the reason in the PR. Numbers and rules:
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

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
