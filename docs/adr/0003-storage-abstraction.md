# ADR 0003: Storage abstraction with a filesystem default

- Status: Accepted
- Date: 2026-11-05 (SPEC draft 0.2; carried into draft 0.3 on 2026-11-14)
- Decided in: [SPEC 4 and 9](../SPEC.md#9-data-model-sketch)

## Context

Site files (and later builder exports) have to be stored somewhere, written safely from
untrusted uploads and served fast. The target is one homelab host with a documented data
directory that the Restic job backs up ([SPEC 11](../SPEC.md#11-operations)). Operators with
other needs may want an S3-compatible store later, and the application code should not have to
change for that.

## Decision

1. **All site storage goes through a `StorageBackend` trait** in the Rust backend. The SPEC
   sketch is `put/get/delete/list/usage`
   ([SPEC 9](../SPEC.md#9-data-model-sketch)); the H-04 task
   ([#48](https://github.com/Mozra-the-great/stuffcloud/issues/48)) refines it to an async,
   streaming trait with `stat`, typed errors and no `unwrap`.
2. **The default and only backend for now is the local filesystem.** An S3-compatible backend
   "can be added without API changes" ([SPEC 4](../SPEC.md#4-architecture-overview)); H-04
   states it as "prepare for S3 without building it now".
3. **The filesystem backend is hardened:** every path is a `core::SafeRelPath`, no symlinks,
   canonical paths, quota accounting, and an atomic publish through a temporary directory and
   `rename`, so a crash never leaves a half-published site.
4. **A contract test suite, written generic over the trait,** is what any backend must pass;
   a later S3 backend runs the same suite.
5. **Metadata stays in SQLite** (site rows, owners, expiry, quota counters); the backend
   stores files only. The data directory (SQLite plus site files) is what is backed up.

## Consequences

- Positive: Caddy can serve sites from disk (ADR 0002), no second moving part is needed, and
  backup and restore are plain files plus one SQLite database.
- Positive: handlers depend on the trait, so tests can use a backend that fails on demand
  (disk full, quota hit in the middle of an extraction).
- Negative: filesystem semantics (rename atomicity, case sensitivity, symlinks) are the
  reference behaviour; the contract tests have to pin down which of them a backend may rely
  on, or an S3 backend will behave differently.
- Negative: the trait is designed from one implementation; the S3 backend may need changes
  to it.

## Open points

- The exact trait signature is fixed in H-04 (#48); this ADR records the decision to have it.
- How sites stored in a non-filesystem backend would be served (the SPEC has Caddy reading
  from disk) is not decided. It is out of scope until an S3 backend is built; that work gets
  its own ADR.

## Alternatives considered

- **S3-compatible object storage from the start:** deferred (SPEC 4, H-04). It adds a service
  to a single-host homelab deployment and does not fit direct serving by Caddy from disk.
- **Direct filesystem calls without an abstraction:** not chosen; the SPEC puts storage behind
  a trait so that another backend needs no API change.
- Other options (for example file contents in SQLite) are not discussed in the SPEC or in the
  issues and were not evaluated.

## Links

- [SPEC 4](../SPEC.md#4-architecture-overview), [9](../SPEC.md#9-data-model-sketch), [11](../SPEC.md#11-operations)
- Issue [#48](https://github.com/Mozra-the-great/stuffcloud/issues/48) (H-04), [#31](https://github.com/Mozra-the-great/stuffcloud/issues/31) (A-01)
- [ADR 0002](0002-static-hosting-and-origin-isolation.md), [ADR 0006](0006-edge-and-core.md)
