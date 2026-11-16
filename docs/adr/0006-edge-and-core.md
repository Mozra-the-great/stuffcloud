# ADR 0006: Public surface: the minimal `edge` process and the shared `core` crate

- Status: Accepted
- Date: 2026-11-14 (SPEC draft 0.3, decision 10)
- Decided in: [SPEC 4 and 16.10](../SPEC.md#4-architecture-overview), [PR #101](https://github.com/Mozra-the-great/stuffcloud/pull/101)

## Context

SPEC draft 0.2 said that from the internet only site delivery (Caddy) is reachable and
everything else is LAN only. Three features of public sites need server logic, though: the
site-password check, burn after reading and the abuse report
([SPEC 8.3 and 8.6](../SPEC.md#83-access-options-per-site)). Putting that logic into `app` would
make the large LAN-only service (accounts, uploads, admin, jobs) reachable from outside.
Several binaries (`app`, `edge`, `cli`) also need the same validation rules, and a path or
subdomain rule that exists in two versions is a security bug waiting to happen.

## Decision

1. **A separate, deliberately small Rust binary `edge` is the only stuffcloud process the
   internet can reach.** It handles exactly the password check, burn-after-reading and the
   abuse report. Caddy asks it through `forward_auth` or proxies only those routes to it.
2. **`edge` never depends on `app`.** It reads the database and writes only the few rows these
   features need; it has no upload, account or admin code linked in. The container gets the
   database read-only apart from the tables it writes ([SPEC 11](../SPEC.md#11-operations)).
3. **`edge` gets its own review checklist and fuzz targets,** and its public routes are tested
   in isolation with hostile `Host`, cookie and header combinations
   ([SPEC 14](../SPEC.md#14-quality-ci-and-testing), "Edge tests").
4. **`core` is a Rust library shared by `app`, `edge` and `cli`,** holding the domain types
   and every validation rule (paths, subdomains, quotas, roles, permissions). It performs no
   I/O at all, so it can be tested exhaustively. Validated values are types that only their
   parser can build ("parse, don't validate"): code holding a `SafeRelPath` or a `Subdomain`
   cannot have skipped the check. `core` exists today (PR #101) with these two types.
5. **`edge` and the CLI use the same `core` types as the server** ([SPEC 10](../SPEC.md#10-api-and-cli)),
   so the CLI applies the same path checks as the server before an upload.

## Consequences

- Positive: the code reachable from the internet is small, has no upload or account handling
  and can be reviewed and fuzzed on its own; a bug in `app` is not reachable from outside.
- Positive: one definition of every validation rule, tested exhaustively without I/O or
  mocks; the type system carries the "already validated" fact through the code.
- Negative: one more service to build, deploy, monitor and harden (its own image, Compose
  entry, health check, metrics and Wazuh rules in H-15 and H-16), and a database shared by
  two processes, whose write access must be restricted to specific tables.
- Negative: the contract between `app` and `edge` (which rows `app` writes and `edge` reads,
  for example a burn flag or report queue) has to be designed and tested; it is a schema,
  not only code.
- Negative: `core` must stay free of I/O and of dependencies that do I/O, or the exhaustive
  testing argument no longer holds. Review has to enforce that.

## Open points

- The `edge` service itself is implemented in H-19
  ([#104](https://github.com/Mozra-the-great/stuffcloud/issues/104)); the exact route set,
  the `forward_auth` versus proxy choice and how the "read-only except these tables"
  restriction is enforced are decided there. Its Dockerfile and compose entry depend on the
  scope of F-04 (open owner question SF1).
- The SQLite driver, which both processes use, is open in ADR 0001.
- Threat model entry for `edge`: H-01 ([#45](https://github.com/Mozra-the-great/stuffcloud/issues/45)).

## Alternatives considered

- **Password, burn and report handled inside `app`:** rejected by decision 10. It would make
  the whole of `app` reachable from the internet instead of three routes.
- **Only static delivery from the internet (draft 0.2):** replaced; those three features need
  a server, and the draft had left that open.
- **Validation rules per binary:** not chosen; SPEC 4 puts every rule in the shared `core`
  crate so the rules cannot drift. The SPEC does not describe a per-binary variant; this is
  the implicit alternative.

## Links

- [SPEC 4](../SPEC.md#4-architecture-overview), [8.3](../SPEC.md#83-access-options-per-site), [8.6](../SPEC.md#86-abuse-handling), [10](../SPEC.md#10-api-and-cli), [11](../SPEC.md#11-operations), [14](../SPEC.md#14-quality-ci-and-testing), [16.10](../SPEC.md#16-decisions-on-the-former-open-questions)
- PR [#101](https://github.com/Mozra-the-great/stuffcloud/pull/101); issues [#104](https://github.com/Mozra-the-great/stuffcloud/issues/104) (H-19), [#45](https://github.com/Mozra-the-great/stuffcloud/issues/45) (H-01)
- [ADR 0001](0001-stack.md), [ADR 0002](0002-static-hosting-and-origin-isolation.md), [ADR 0007](0007-test-strategy.md)
