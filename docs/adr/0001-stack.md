# ADR 0001: Stack: Rust backend, Svelte/Vite SPA frontend

- Status: Accepted (SQLite driver: `rusqlite`, see "Addendum: SQLite driver")
- Date: 2026-11-14 (Rust backend, SPEC draft 0.3); 2026-11-16 (Vite SPA variant, implemented in #106)
- Decided in: [SPEC 4 and 16.9](../SPEC.md#4-architecture-overview), [PR #101](https://github.com/Mozra-the-great/stuffcloud/pull/101), [PR #106](https://github.com/Mozra-the-great/stuffcloud/pull/106)

## Context

stuffcloud is reachable from the internet and runs on one small homelab host, so security and
a small footprint come before development speed ([SPEC 2](../SPEC.md#2-goals-and-non-goals)).
SPEC draft 0.2 (2026-11-05) planned a Node.js/Fastify backend with a Svelte frontend, "one
language end to end". The tool libraries (PDF, image, converters, see
[SPEC 7](../SPEC.md#7-toolbox)) are JavaScript or WASM and run in the browser regardless of
what the backend is written in.

Issue [#4](https://github.com/Mozra-the-great/stuffcloud/issues/4) (F-01) also left one frontend
question open: plain Vite single-page app (SPEC 4) or SvelteKit with `adapter-static`.

## Decision

1. **Backend: Rust.** A Cargo workspace with `axum` on `tokio` and SQLite (WAL mode) for
   metadata. Crates: `core`, `db`, `app`, `edge`, `cli`; only `core` exists today and each
   other crate is added in the phase that needs it
   ([SPEC 4](../SPEC.md#4-architecture-overview), [15](../SPEC.md#15-phases)). Every crate
   inherits the workspace lint set (`unsafe` forbidden, clippy pedantic, no
   `unwrap`/`expect`/`panic`/indexing/unchecked arithmetic outside tests); the toolchain is
   pinned (`rust-toolchain.toml` and `rust-version`). The reasons are those of
   [SPEC 4, "Stack rationale"](../SPEC.md#4-architecture-overview): memory safety without a
   garbage collector, a small dependency tree that `cargo-deny` can gate, one static binary
   per service in a `distroless` image, CPU-heavy work moved off the request path with
   `spawn_blocking`, and a type system that enforces validation and exhaustive permission
   checks.
2. **Frontend: Svelte 5 + Vite, TypeScript strict, static build.** A pnpm workspace under
   `web/` (`apps/web`, `packages/tools`, `packages/api-client`), Node 24 pinned. No `any`.
   Node and pnpm are used for `web/` only; the backend and its CI jobs never depend on them.
3. **Svelte variant: a plain Vite single-page app, not SvelteKit.** SPEC 4 describes "a
   Svelte + Vite single-page app, static build, tools lazy-loaded"; [#106](https://github.com/Mozra-the-great/stuffcloud/pull/106)
   implemented it that way and handed the written record to this ADR. Routing, i18n and the
   app shell are scoped in T-03 ([#11](https://github.com/Mozra-the-great/stuffcloud/issues/11)).
4. **API contract: generated.** The OpenAPI document is generated from the Rust handlers
   (`utoipa`); the TypeScript client is generated from it (`openapi-typescript` and
   `openapi-fetch`), and CI fails when the generated client is stale ([SPEC 10](../SPEC.md#10-api-and-cli);
   the skeleton is in `packages/api-client`, the generation step comes with `app` in A-01,
   [#31](https://github.com/Mozra-the-great/stuffcloud/issues/31)).

## Consequences

- Positive: a small, gateable dependency tree (`cargo-deny` and the npm license gate, SPEC 3);
  static binaries in minimal images; invalid input cannot reach code that skipped the
  validation, because `core` types are built only by their parser (see ADR 0006); the browser
  keeps the JavaScript/WASM tool ecosystem.
- Positive: with a plain SPA, the build output is static files that Caddy serves; the
  deployed system has no Node runtime.
- Negative: two language ecosystems with separate lockfiles, license gates and Dependabot
  groups, joined only by the generated OpenAPI client. A stale client is a CI failure, so the
  chain `utoipa` to `openapi-typescript` has to stay working.
- Negative: Rust does not prevent logic bugs (authorisation, path handling, headers). The
  test strategy compensates for that (ADR 0007).
- Negative: with a plain SPA the project writes its own routing and per-page loading
  (T-03) instead of using framework conventions; rationale recorded with this ADR, not in
  #106: SvelteKit's file-based routing, `load` functions and prerender/SSR modes would sit on
  top of an output that is static anyway, with no server runtime to use them.

## Open points

- **SQLite driver (`sqlx` or `rusqlite`):** decided in A-01
  ([#31](https://github.com/Mozra-the-great/stuffcloud/issues/31)): `rusqlite`, see
  "Addendum: SQLite driver" below. Constraints already set for it: SQLite in WAL mode, versioned migrations with
  a tested runner, CPU-heavy work on `spawn_blocking`, a licence that passes `cargo-deny`, a
  static `distroless` build. `edge` ([ADR 0006](0006-edge-and-core.md)) reads the same
  database, so the choice must work for both processes.
- The router for the SPA is not chosen yet (T-03, #11).

## Alternatives considered

- **Node.js/Fastify backend (SPEC draft 0.2):** rejected in SPEC 16.9. Security and
  performance of an exposed instance outweigh one language end to end.
- **Rust/WASM frontend (Leptos, Dioxus):** rejected in SPEC 16.9. The tools depend on
  JavaScript and WASM libraries, and the bundle-size budget argues against a second WASM
  runtime on top.
- **Server-rendered pages for admin and hosting:** rejected in SPEC 16.9. It would split the
  UI into two systems.
- **SvelteKit with `adapter-static`:** one of the two options of #4; not chosen (SPEC 4
  already specifies a single-page app with a static build, implemented in #106). Not
  evaluated further in the SPEC or #106; revisit by superseding this ADR if T-03 finds that
  routing needs more than a router library.

## Links

- [SPEC 4 (architecture and stack rationale)](../SPEC.md#4-architecture-overview), [16.9](../SPEC.md#16-decisions-on-the-former-open-questions)
- PR [#101](https://github.com/Mozra-the-great/stuffcloud/pull/101) (Rust switch), PR [#106](https://github.com/Mozra-the-great/stuffcloud/pull/106) (web scaffold, Vite SPA)
- Issues [#4](https://github.com/Mozra-the-great/stuffcloud/issues/4) (F-01), [#31](https://github.com/Mozra-the-great/stuffcloud/issues/31) (A-01)
- [ADR 0006](0006-edge-and-core.md), [ADR 0007](0007-test-strategy.md)

## Addendum: router and i18n (2026-11-19, T-03)

The open point "The router for the SPA is not chosen yet" is closed by
[ADR 0011](0011-spa-routing-and-i18n.md) (issue [#11](https://github.com/Mozra-the-great/stuffcloud/issues/11),
PR [#127](https://github.com/Mozra-the-great/stuffcloud/pull/127)): a small own History-API router
with lazy routes and typed i18n catalogues, no router library. The decision of this record
(plain Vite SPA, not SvelteKit) stands; T-03 found that client-side routing is all the shell needs.

## Addendum: SQLite driver (2026-11-19, A-01)

The open point "SQLite driver (`sqlx` or `rusqlite`)" is closed by A-01
([#31](https://github.com/Mozra-the-great/stuffcloud/issues/31)): **`rusqlite`** with the
`bundled` feature (SQLite compiled into the binary), in `crates/db`.

- **Synchronous by design.** SQLite has one writer and every call is a local file operation;
  an async driver only moves that work onto its own thread pool. `crates/db` is synchronous and
  reads no clock; `app` runs every database call through `tokio::task::spawn_blocking`
  (`AppState::db`), which is the rule this ADR already sets for CPU-heavy work. One connection
  behind a mutex is enough for the LAN API; a pool can be added behind the same methods.
- **Own migration runner** (`crates/db/src/migrate.rs`, about 100 lines with its tests): SQL
  files compiled into the binary, numbered from 1, each applied in its own transaction and
  recorded with a SHA-256 checksum. An edited applied migration and a schema newer than the
  build are refused at startup.
- **WAL is checked, not assumed:** `Database::open` sets `journal_mode = WAL` and fails when
  SQLite keeps another mode; foreign keys on, `trusted_schema` off, a busy timeout so `edge`
  (ADR 0006) can read the same file from its own process.
- **Static build:** `bundled` needs only a C compiler at build time (the Rust build image has
  one); the `distroless/cc` runtime image needs no `libsqlite3`. License: MIT (`rusqlite`,
  `libsqlite3-sys`), SQLite itself is public domain; `cargo deny` passes.

Alternatives considered:

- **`sqlx`:** async, compile-time checked queries and a migration runner. Rejected: the
  checked macros need a database or a committed offline cache at build time (one more thing to
  keep in sync in CI and in the Docker build), its SQLite driver runs on a worker thread anyway,
  its dependency tree is several times larger (more to audit and gate), and its migrator does
  not refuse edited migrations by default. The queries of stuffcloud are few and simple; the
  integration tests run each of them.
- **`rusqlite` with `rusqlite_migration` or `refinery`:** one more dependency for what the
  ~100-line runner does, with less control over the checks above.
- **A system `libsqlite3`:** rejected for the distroless image (no package manager, and the
  SQLite version would depend on the base image).
