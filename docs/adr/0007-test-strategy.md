# ADR 0007: Test strategy: err on the side of too many tests

- Status: Accepted
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

## Links

- [SPEC 4](../SPEC.md#4-architecture-overview), [14](../SPEC.md#14-quality-ci-and-testing), [15](../SPEC.md#15-phases)
- PR [#101](https://github.com/Mozra-the-great/stuffcloud/pull/101) (pipeline), [#107](https://github.com/Mozra-the-great/stuffcloud/pull/107) (frontend jobs in `build`), [#109](https://github.com/Mozra-the-great/stuffcloud/pull/109) (npm license gate)
- [ADR 0001](0001-stack.md), [ADR 0006](0006-edge-and-core.md)
