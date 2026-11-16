# ADR 0004: Client-side-first tool execution and asset loading

- Status: Accepted
- Date: 2026-11-05 (SPEC draft 0.2; decisions 3 and 4 in SPEC 16)
- Decided in: [SPEC 1, 2, 7 and 13](../SPEC.md#7-toolbox)

## Context

The toolbox (PDF, images, converters, network helpers, generators) is one half of the product.
The instance runs on one small host, and the people using it hand it private files. The tool
libraries that exist are JavaScript or WASM and run in the browser. Some assets are large
(WASM builds, ML model weights).

## Decision

1. **Every v1 tool runs in the browser.** Files never leave it, nothing is uploaded, and the
   UI says so ([SPEC 7](../SPEC.md#7-toolbox), "Rules"). A test asserts that no tool sends a
   request carrying file content ([SPEC 14](../SPEC.md#14-quality-ci-and-testing), "Frontend").
2. **Each tool is a first-party module with a manifest:** id, name, category, icon/sticker,
   lazy-loaded entry, `runsIn: client|server`, required libraries, accessibility notes and a
   size budget. `runsIn: server` exists in the schema; no v1 tool uses it. Third-party
   plugins are a non-goal. Admins can disable tools.
3. **Large assets load only when the tool opens,** are self-hosted (no external requests,
   fonts included), and show progress. Heavy work belongs in Web Workers (tool registry, T-04,
   [#12](https://github.com/Mozra-the-great/stuffcloud/issues/12)).
4. **Offline use is optional:** tools may work offline once loaded; service-worker caching is
   optional (T-25, [#29](https://github.com/Mozra-the-great/stuffcloud/issues/29)).
5. **Library choices follow the SPEC 7 table, with the licence checked per version before
   adoption** (SPEC 3). Two choices made there: PDF compression uses a light method first
   and Ghostscript WASM only as an optional lazily loaded extra (16.3); background removal
   uses U²-Netp by default and BiRefNet-lite as an opt-in download (16.4).
6. **Privacy by default:** no trackers, no IP storage, only technically necessary cookies
   ([SPEC 13](../SPEC.md#13-internationalisation-and-privacy)).

## Consequences

- Positive: tools cost the server nothing, scale with visitors for free and keep user files
  on the device; the server cannot leak what it never receives.
- Positive: the backend stays small and has no tool-related code to attack.
- Negative: capability and speed depend on the visitor's device (memory for big PDFs and
  images, WASM support); heavy tools need budgets, progress UI and cancellation.
- Negative: every tool needs its own bundle budget, an accessibility check and an end-to-end
  test, and its dependencies need their licences checked, including copyleft WASM builds and
  licences that changed between major versions (SPEC 3: `ua-parser-js` v2, Ghostscript).
- Negative: a tool that really needs a server (none in v1) would have to go through the
  `server` manifest value and the whole auth and hosting threat model, not slip in as a
  client tool.

## Open points

- The PDF compression approach is measured in the spike T-13
  ([#18](https://github.com/Mozra-the-great/stuffcloud/issues/18)); background removal quality
  and size in T-16 ([#21](https://github.com/Mozra-the-great/stuffcloud/issues/21)); the
  animation runtime in T-02 ([#10](https://github.com/Mozra-the-great/stuffcloud/issues/10)).
  Each writes its own ADR from 0008 on.
- Performance budgets and the optional service worker: T-25 (#29).

## Alternatives considered

- **Server-side processing of files:** contradicts the goals of low server cost and privacy by
  default (SPEC 2) and would put untrusted file parsing on the exposed host. The manifest
  value `runsIn: server` only keeps the door open.
- **`@imgly/background-removal`:** not used (GPL/AGPL with a commercial dual licence, SPEC 7).
  MODNet: not used (conflicting licence statements).
- **Ghostscript WASM as the default PDF compressor:** not chosen (AGPL, very large); only as
  an optional extra if the light method falls short (SPEC 16.3).

## Links

- [SPEC 1](../SPEC.md#1-vision), [2](../SPEC.md#2-goals-and-non-goals), [3](../SPEC.md#3-license-and-reuse-policy), [7](../SPEC.md#7-toolbox), [13](../SPEC.md#13-internationalisation-and-privacy), [16](../SPEC.md#16-decisions-on-the-former-open-questions)
- Issues [#12](https://github.com/Mozra-the-great/stuffcloud/issues/12) (T-04), [#18](https://github.com/Mozra-the-great/stuffcloud/issues/18) (T-13), [#21](https://github.com/Mozra-the-great/stuffcloud/issues/21) (T-16), [#29](https://github.com/Mozra-the-great/stuffcloud/issues/29) (T-25)
- [ADR 0001](0001-stack.md), [ADR 0007](0007-test-strategy.md)
