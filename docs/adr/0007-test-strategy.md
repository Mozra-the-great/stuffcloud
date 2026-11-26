# ADR 0007: Test strategy: err on the side of too many tests

- Status: Accepted (Python CI helpers and the TypeScript logic of web/ under the mutation rule: see the addenda "Python CI helpers" and "TypeScript logic of web/")
- Date: 2026-11-14 (SPEC draft 0.3, section 14 rewritten)
- Decided in: [SPEC 14](../SPEC.md#14-quality-ci-and-testing), [PR #101](https://github.com/Mozra-the-great/stuffcloud/pull/101), `CLAUDE.md` ("Tests (non-negotiable)")

## Context

stuffcloud hosts untrusted content on an exposed instance, and the security of the whole
system rests on a few rules: which paths and names are accepted, who may do what, which
headers a site gets. Rust prevents memory errors but not logic errors in exactly these rules
([SPEC 4](../SPEC.md#4-architecture-overview), "Stack rationale"). The project is
solo-maintained (CONTRIBUTING.md), so the safety net has to be automatic and strict from the
first line of code, not added later.

## Decision

Tests are part of the security design. The pipeline is built before the code that needs it
most (SPEC 15, phase 1) and is run more than seems necessary.

1. **Required checks** (ruleset): `build`, `workflow-lint`, `gitleaks`, `claude-review`.
   `build` is an aggregate job in `ci.yml` that is green only when every job of the workflow
   succeeded (a skipped or cancelled job counts as a failure), so new jobs join its `needs`
   and never the ruleset. No job has a path filter. CodeQL runs as one of those jobs.
2. **Per PR and push:** `fmt`, `clippy` (pedantic set, every warning an error), `test`
   (unit, property with 4096 cases, regression and doc tests, debug and release, `--locked`),
   `docs`, `coverage` (at least 95 % of lines and of regions), `mutants` (on the changed
   lines; a surviving mutant fails), `fuzz` (every target for 2 minutes with AddressSanitizer),
   `codeql`, `supply-chain` (`cargo-deny`), the frontend jobs (`web`, `licenses`) and
   `repo-checks`.
3. **Nightly** (`deep-tests.yml`, not required, failures handled like a red PR): 45 minutes of
   fuzzing per target with a growing corpus, the full mutation run, Miri, 500 000 property
   cases, fresh advisories, the beta toolchain.
4. **Test layers:** unit tests on both sides of every boundary with every error variant and
   message asserted; property tests for every invariant; a regression corpus where every bug
   and fuzz finding becomes an entry plus a fuzz seed; fuzz targets for every parser of
   untrusted input that assert invariants, not only "does not panic"; mutation testing;
   API integration tests for every route against every role; edge tests; archive tests;
   frontend unit, Playwright and axe tests, plus a test that no tool sends file content;
   container checks. Which layers apply from which phase is stated in SPEC 14.
5. **A check is never weakened to make a PR green:** no `#[allow]`, `ignore`, lowered
   threshold or `continue-on-error`; `#[expect(..., reason = "...")]` only where the reason
   is a proof. A lowered threshold needs a reason in the PR. A surviving mutant is a missing
   test.

## Consequences

- Positive: rules that protect the system (paths, subdomains, later archive entries, headers,
  permissions) are specified by tests on both sides of every boundary, not by reading code;
  regressions of fixed attacks cannot come back unnoticed.
- Positive: mutation testing shows when tests execute lines without checking behaviour; the
  coverage floor alone cannot show this.
- Negative: slower and more expensive PRs (mutation, fuzzing, ASan runs) and a nightly job
  that needs attention.
- Negative: contributors, human or AI, spend a large part of each change on tests, and
  every new crate or parser needs coverage, mutation and fuzz wiring.
- Negative: the strictness is only as good as its enforcement: the `build` aggregate and the
  rule "never weaken a check" have to be kept in review.

## Open points

- Playwright and axe jobs join `build` with T-06 ([#14](https://github.com/Mozra-the-great/stuffcloud/issues/14))
  and T-05 ([#13](https://github.com/Mozra-the-great/stuffcloud/issues/13)); the OpenAPI drift
  check with A-01 ([#31](https://github.com/Mozra-the-great/stuffcloud/issues/31)).
- The image scan is scheduled for phase 3 in SPEC 14, but T-26
  ([#30](https://github.com/Mozra-the-great/stuffcloud/issues/30)) pulls it forward for the
  v0.1.0 image; to be reconciled there.

## Alternatives considered

- **Rely on the language's safety and a lighter pipeline (tests and a coverage number):**
  rejected in SPEC 4 and 14: Rust does not prevent logic bugs in authorisation, path handling
  or headers, and coverage alone does not show that tests check behaviour.
- **Path-filtered CI jobs:** not used; the `build` aggregate counts a skipped job as a
  failure and a filter could give a false green (CLAUDE.md, "CI").

## Addendum: Python CI helpers (2026-11-26, #161)

Decision 2 and 5 name mutation testing and "a surviving mutant is a missing test" for the Rust code.
The Python helpers in `scripts/ci/` fall under the same rule: several of them are security gates
whose only visible output is "pass" (the cookie, crypto and operator-domain gates, the npm license
gate, the container hardening gate), and a regression that makes one of them pass everything (an
inverted comparison, a `return True` on an error path, a regex that matches nothing) stays invisible,
because the tests execute the line and coverage does not check what it does.

- **Tool:** [mutmut](https://github.com/boxed/mutmut) 3 (BSD-3-Clause), pinned with hashes in
  `scripts/ci/requirements-mutmut.txt` (generated from `requirements-mutmut.in` with
  `pip-compile --generate-hashes`, installed with `--require-hashes`) and updated by Dependabot
  (`pip`, `/scripts/ci`). It is CI tooling only: nothing of it ships and the helpers stay
  standard-library only. Configuration is in the repository's `pyproject.toml` (`[tool.mutmut]`).
- **What is mutated:** every function of `scripts/ci/*.py` except the tests and
  `dev_stack_smoke.py`. That script drives a running Docker stack, has no pure function worth
  testing and patches `socket.getaddrinfo` when imported; the CI job `dev-stack` runs it for real.
  The Docker calls of `check_container_hardening.py` go through one function (`run`), which the tests
  replace, so that file is mutated completely.
- **Gate:** `mutmut run` always exits 0, so `scripts/ci/mutation_gate.py` reads
  `mutmut export-cicd-stats` and fails on a surviving mutant, a mutant without a test, a suspicious,
  skipped or interrupted one, a crash, a mutant that was never checked, and an empty run. A mutant
  that makes the tests hang (an endless loop) is a timeout and counts as caught, as with the time
  limit of `cargo mutants`.
- **CI:** job `mutation-python` in `ci.yml`, part of `build`. It never skips itself (decision 1):
  on a PR that touches neither `scripts/ci/` nor `pyproject.toml` its steps pass with nothing to do;
  every push to `main` and the nightly run (`deep-tests.yml`, with the report as an artifact) run the
  whole directory. The whole directory, not only the changed files, because a changed test or script
  can let a mutant of another file live and the full run is affordable (see Cost). The
  same job measures line and branch coverage of the helpers first (`coverage.py`, floor in
  `pyproject.toml`).
- **Equivalent mutants:** a mutant that provably cannot change behaviour gets `# pragma: no mutate`
  with the proof in a comment next to it, nothing else. Where a small change of the code removes the
  equivalent mutant (`rpartition` instead of `rsplit(...)[-1]`, a comparison with `== -1` instead of
  `< 0` for `str.find`), the code is changed instead of the mutant ignored.
- **Layout:** mutmut runs the tests in a copy (`mutants/`); the helpers find the repository from their
  own location, so `also_copy` in `pyproject.toml` copies the files their tests read. `mutants/` is
  ignored by git and by the helpers' own file walks. The helpers and their tests import each other
  by plain file name while mutmut names mutants after the file path (`scripts.ci.check_cookies`), so
  a pytest-only `scripts/ci/conftest.py` registers every helper under both names; the `unittest`
  run does not use it.
- **Cost:** 4 188 mutants, 16 minutes on a hosted runner with four cores (the job `e2e` runs 12 minutes
  in parallel). Measured first, as the issue asked: too long to run on every PR, short enough to run in
  full whenever the helpers change.
- **Alternatives considered:** mutating only the changed files on a PR (not chosen: a changed test or
  helper can let a mutant of another file live, and the helpers change rarely; mutmut accepts
  `mutmut run "scripts.ci.<module>.*"`, so it remains an optimisation if the run ever hurts);
  skipping the job on PRs that do not touch the helpers (not allowed, decision 1: the aggregate counts
  a skipped job as a failure, so the steps no-op instead); leaving the helpers to coverage alone
  (rejected: the first mutation run found 1 259 surviving mutants against 341 passing tests).

## Addendum: TypeScript logic of web/ (2026-11-26, #162)

The only gate of the frontend besides Playwright and axe is Vitest with a 95 % coverage floor, which shows
that a line ran and not that a wrong line would be noticed. `web/` has about 21 000 lines of non-test
TypeScript, and the logic that matters is in it: the Markdown sanitiser (`render.ts`: DOMPurify, the inert
re-parse, blocking remote pictures), the own parsers and encoders (JSON, JSON5, XML without DTD or
entities, Base64, the PNG writer, the SQL tokenizer), the arithmetic with many boundaries (subnet, UUID v7
ordering, units, timestamps, cron), the time limits of the workers, `src/pdf/` and `packages/tools`. The
rule of decisions 2 and 5 holds for it: a surviving mutant is a missing test.

- **Tool:** [StrykerJS](https://stryker-mutator.io/) 10 (`@stryker-mutator/core` and `vitest-runner`,
  Apache-2.0, already on the allow list), a `devDependency` of `apps/web` and `packages/tools`, in the
  pnpm lockfile and so in the npm license gate. `caniuse-lite` (CC-BY-4.0) comes with it through
  browserslist; it is data, in no production tree, and sits in `[dev_only]` of the policy with that
  reason.
- **What is mutated:** `apps/web/src/tools/*/**/*.ts`, `apps/web/src/pdf/**/*.ts` and
  `packages/tools/src/**/*.ts` without tests, the `manifest.ts` of each tool (static data checked by the manifest schema,
  which is mutated, and by `pnpm check-tools`) and `.d.ts` files. Not yet: `packages/api-client`
  (generated), `src/i18n/messages` (catalogues), `src/styles` (generated tokens) and the `.svelte`
  components (they render, the e2e specs with axe cover them); the components are to be revisited when the
  logic is clean. Every exclusion has its reason in the config, and a file is never excluded to get green.
- **Gate:** `thresholds.break: 100` with `coverageAnalysis: "perTest"`. A survivor, a mutant that no test
  covers and a run that mutated nothing fail it (a scope that matches no file throws); a mutant that makes
  the tests hang is a timeout and counts as caught, as with `cargo mutants`. String-literal mutants are not
  switched off. An equivalent mutant gets `// Stryker disable next-line <mutator>: <reason>` with the proof as
  the reason, nothing else; where a small change of the code removes it, the code changes.
- **CI:** job `web-mutants` in `ci.yml`, part of `build`, one leg per package. It never skips itself
  (decision 1): it mutates the scoped files the PR changes, with `--incremental` and the report cached from
  the last push to `main`, and a PR without such a file passes with nothing to do. Changed files, not the
  whole scope, because the full run takes much longer than a PR can wait (see Cost), and because the scope
  has survivors that other PRs do not own; every file a PR touches must therefore be clean. What that
  leaves out (a changed test or a shared helper that lets a mutant of an untouched file live) is what the
  full run in `deep-tests.yml` (`web-mutants-full`, sharded by file size, HTML and JSON reports as
  artifacts) finds. It runs on demand until the progress list in #162 is empty: a scheduled job that is red
  every night, or one that is allowed to fail, would weaken the check. The commit that kills the last
  survivor removes its `if:` line.
- **Layout:** the tests read files outside their package (`docs/design`, `packages/tools/src`), so Stryker
  instruments in place instead of in a sandbox copy. `vitest.stryker.config.ts` is the normal config with
  longer test timeouts, no coverage run and `STRYKER_SLOWDOWN`, which the tests that bound their run time
  (`timeBudget` in `tests/time-budget.ts`) multiply their limit by: the instrumented code is several times
  slower, and no other run changes. `STRYKER_TESTS` runs only the named test files while a survivor is being
  killed (never in CI).
- **Cost:** measured first, as the issue asked (figures per run in #162). The scope is 16 768 mutants in
  `apps/web` and 939 in `packages/tools`. The initial run (every test once, instrumented, with the coverage of
  every mutant) takes 11 minutes for `apps/web`, against two minutes for the plain Vitest run; the mutants then
  run at about 1.5 per second on six local workers, an endless-loop mutant costing its time limit. One run of
  the whole scope is therefore hours, which is why the PR job takes the changed files and the full run is
  sharded. The tests that hash megabytes in pure JavaScript had to learn to work in small pieces (the
  instrumented loops are far slower), see `hash-task.test.ts`.
- **Alternatives considered:** the whole scope on every PR (not chosen: hours); `ignoreStatic` and
  disabling string-literal mutants (rejected by the issue and by decision 5: they hide exactly the missing
  assertions); a sandbox copy instead of in-place instrumentation (does not work: the tests read files
  outside their package); the TypeScript checker plugin, which drops mutants that do not compile (not
  needed so far; `pnpm typecheck` is its own gate, and it can be added if type-invalid survivors turn out
  to dominate).

## Links

- [SPEC 4](../SPEC.md#4-architecture-overview), [14](../SPEC.md#14-quality-ci-and-testing), [15](../SPEC.md#15-phases)
- PR [#101](https://github.com/Mozra-the-great/stuffcloud/pull/101) (pipeline), [#107](https://github.com/Mozra-the-great/stuffcloud/pull/107) (frontend jobs in `build`), [#109](https://github.com/Mozra-the-great/stuffcloud/pull/109) (npm license gate), PR [#171](https://github.com/Mozra-the-great/stuffcloud/pull/171) (Python CI helpers, addendum), PR [#180](https://github.com/Mozra-the-great/stuffcloud/pull/180) (TypeScript logic of web/, addendum)
- [ADR 0001](0001-stack.md), [ADR 0006](0006-edge-and-core.md)
