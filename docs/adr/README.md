# Architecture decision records

An architecture decision record (ADR) writes down a decision that is expensive to reverse:
the context it was taken in, what was decided, what follows from it and which alternatives
were considered. The ADRs do not replace [`docs/SPEC.md`](../SPEC.md); the SPEC says *what*
stuffcloud is, an ADR says *why* a core choice was made and what it costs.

## Index

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-stack.md) | Stack: Rust backend, Svelte/Vite SPA frontend | Accepted (SQLite driver open) | 2026-11-14 |
| [0002](0002-static-hosting-and-origin-isolation.md) | Static-only hosting and origin isolation | Partly superseded by ADR 0009 | 2026-11-05 |
| [0003](0003-storage-abstraction.md) | Storage abstraction with a filesystem default | Accepted | 2026-11-05 |
| [0004](0004-client-side-tools.md) | Client-side-first tool execution and asset loading | Accepted | 2026-11-05 |
| [0005](0005-auth-model.md) | Auth model: local accounts, passkeys, TOTP and OIDC | Partly superseded by ADR 0009 | 2026-11-05 |
| [0006](0006-edge-and-core.md) | Public surface: the minimal `edge` process and the shared `core` crate | Accepted | 2026-11-14 |
| [0007](0007-test-strategy.md) | Test strategy: err on the side of too many tests | Accepted | 2026-11-14 |
| [0008](0008-pixel-art-animation-runtime.md) | Pixel-art animation runtime: CSS transform keyframes with `steps()` | Accepted | 2026-11-16 |
| [0009](0009-zone-model-and-shared-domain-isolation.md) | Zone model: per-site visibility, per-zone policy, app on a shared domain | Accepted | 2026-11-16 |
| [0010](0010-api-first-and-configuration-as-code.md) | API-first and configuration as code | Accepted | 2026-11-16 |
| [0011](0011-spa-routing-and-i18n.md) | SPA routing, focus management and internationalisation | Accepted | 2026-11-19 |

ADRs 0001 to 0007 were written together (2026-11-16, issue
[#8](https://github.com/Mozra-the-great/stuffcloud/issues/8)) from decisions that had already
been taken in the SPEC drafts and the pull requests linked in each record. They add context,
consequences and alternatives; they do not change any decision. Where a record lists an
alternative that the SPEC does not name, the record says so.

## Status values

- **Proposed**: written down, not decided yet. The record names who decides and where.
- **Accepted**: decided; the code and the SPEC follow it.
- **Superseded by ADR NNNN**: replaced by a later record. The old record stays, with a link.
- **Partly superseded by ADR NNNN**: a later record replaces some of the decisions, named in
  the status line; the others stay accepted. The old record's text stays as it was.
- **Deprecated**: no longer applies and has no replacement.

A record can carry open points inside an accepted decision (for example the SQLite driver in
ADR 0001). They are listed under "Open points" with the issue that closes them.

## Numbering and adding a record

- Numbers are four digits, assigned in the order records are written. Never reuse or renumber
  one; links depend on it.
- Spike and decision records of later issues continue from `0008`: the animation runtime
  (T-02, [#10](https://github.com/Mozra-the-great/stuffcloud/issues/10), written as ADR 0008),
  the PDF compression
  spike (T-13, [#18](https://github.com/Mozra-the-great/stuffcloud/issues/18)), background
  removal (T-16, [#21](https://github.com/Mozra-the-great/stuffcloud/issues/21)), the GrapesJS
  spike (B-01, [#63](https://github.com/Mozra-the-great/stuffcloud/issues/63)) and any other
  decision that is expensive to reverse. The numbers are not reserved; the next free one wins.
- A decision that follows from an accepted record and only fills a gap in it (the SQLite
  driver, A-01 [#31](https://github.com/Mozra-the-great/stuffcloud/issues/31)) is an
  **Addendum** section at the end of that record, with its own date and PR, instead of a new
  record. The original text stays as it was.
- To change a decision, write a new record, set the old one to `Superseded by ADR NNNN` (or
  `Partly superseded by ADR NNNN`, naming the replaced decisions, when the rest still holds)
  and add the same note to the index. The new record lists what it supersedes under the
  status line.

How to add one:

1. Copy the template below to `docs/adr/NNNN-short-title.md` (lower-case, hyphens).
2. Fill every section. "Alternatives considered" names what was rejected and why; leave
   nothing as "TODO". If something is not decided, set the status to `Proposed` and say who
   decides and where.
3. Link the SPEC sections and the pull requests or issues the decision comes from.
4. Add a row to the index above, and, if the decision changes what the SPEC says, update the
   SPEC in the same PR.
5. Add a line under `[Unreleased]` in `CHANGELOG.md` (CONTRIBUTING.md, "Workflow").

Write in English, keep it short, and state facts that can be checked (SPEC section, PR,
issue). Do not record a decision here that has not been taken elsewhere first.

## Template

```markdown
# ADR NNNN: Title

- Status: Proposed | Accepted | Superseded by ADR NNNN | Deprecated
- Date: YYYY-MM-DD (when the decision was taken)
- Decided in: SPEC section, pull request or issue where the decision was taken

## Context

The forces at play: requirements, constraints, what the SPEC says, why a decision is needed.

## Decision

What is decided, in full sentences. One decision per record; list its parts if it has some.

## Consequences

- Positive: what gets easier or safer.
- Negative: what gets harder, what it costs, what has to be enforced elsewhere (tests, CI).

## Open points

Anything not decided yet, with the issue or owner question that decides it.
(Write "None." if there is nothing.)

## Alternatives considered

- **Alternative**: why it was rejected.

## Links

- SPEC sections, pull requests, issues, other ADRs.
```
