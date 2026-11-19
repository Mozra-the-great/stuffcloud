# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Auth data model, sessions and CSRF protection (A-02, #32; ADR 0005 addendum): migration
  `0002_auth` adds `users`, `credentials`, `oidc_identities`, `recovery_codes`, `sessions` and a
  `category` for security events in `audit_log`. Sessions use random tokens stored only as
  SHA-256 hashes, `__Host-` cookies (`Secure`, `HttpOnly`, `Path=/`, never `Domain`), idle and
  absolute timeouts (`STUFFCLOUD_SESSION_IDLE_MINUTES`, `STUFFCLOUD_SESSION_ABSOLUTE_HOURS`),
  rotation, a new session on every login (fixation), logout and logout everywhere
  (`GET`/`DELETE /api/v1/auth/session`, `DELETE /api/v1/auth/sessions`); a role change ends the
  account's sessions. Every state-changing request without an `Authorization` header needs an
  `Origin` equal to the app address, `Sec-Fetch-Site: same-origin` when sent and an
  `X-CSRF-Token` matching the CSRF cookie and the session (`403 csrf-rejected`); the app reads
  only its own cookie names, so cookies tossed by same-site hosted sites are ignored. Writes need
  an admin session until A-07 (`403 forbidden` otherwise); resource writes and security events
  are audited with internal ids only. The typed client sends the CSRF header (`csrfToken`
  option). CI: the static cookie gate `scripts/ci/check_cookies.py` in `repo-checks`, an
  integration test of every route's `Set-Cookie` and CSRF refusals, property tests, an attack
  corpus and the fuzz targets `cookie_header`, `origin` and `csrf_check`. (#133)
- API skeleton (A-01, #31): `crates/app` (axum) serves the LAN API under `/api/v1` with the
  resource conventions of ADR 0010 built once for every resource: idempotent `PUT`
  (`created` / `updated` / `unchanged`, an unchanged write touches nothing and writes no audit
  row), `GET` with the writable shape plus `meta`, strong `ETag` with `If-Match` /
  `If-None-Match` (`412`), `?dry_run=true` with a field diff, strict bodies (unknown fields
  other than `meta` refused) and RFC 9457 problem details listing every invalid field with a
  JSON Pointer (`docs/api/problems.md`). First resource: the settings group `reserved-names`;
  writes answer `401` until accounts exist. `crates/db`: SQLite via `rusqlite` in WAL mode with
  a checksummed migration runner, the resource store and the audit log (ADR 0001 addendum).
  Configuration from the environment, validated at startup with every problem listed, secrets
  also as `_FILE`; one-time bootstrap from a configuration file (SPEC 10.7). `/healthz`,
  `/readyz`, Prometheus `/metrics`, JSON logs without client addresses, tokens or query
  strings (redaction tests), security headers, body size and time limits, graceful shutdown on
  SIGTERM. The OpenAPI document is generated from the handlers (`docs/api/openapi.json`, also
  served at `/api/v1/openapi.json`) and the typed client of `web/packages/api-client` from it;
  the new CI job `openapi` fails when either is stale. New fuzz targets `entity_tags`,
  `write_query` and `writable_body`; `mutants` runs in six shards. Docker image `app`
  (multi-stage, pinned toolchain, distroless, non-root) joins the dev stack: Caddy proxies
  `/api/*` to it instead of the `501` placeholder, the smoke test drives the API. The OpenAPI
  breaking-change check will use `oasdiff` (ADR 0010 addendum) (#132).
- `web/`: accessibility baseline and automated checks (T-05, #13), `docs/ACCESSIBILITY.md`. The `a11y`
  gate of the e2e job now runs axe (`@axe-core/playwright`) after every state the specs put on screen,
  in Chromium and Firefox: any violation of the WCAG 2.0 to 2.2 A/AA or best-practice rules fails the
  build, whatever its impact, with the rule, element and help link in the report. New specs: `a11y`
  (the gate can fail; German, phone, every category tab, search dialog, error page, gallery with dialog
  and toasts, worker lab states, missing capability; reflow at 320 px), `keyboard` (every page walked
  with Tab in document order without a trap, visible and uncovered focus, search dialog, phone menu,
  tabs arrow keys, dialog focus return, drop zone and a tool used with the keyboard only, live
  regions) and `motion` (`prefers-reduced-motion`: no running animation, no timed transition, no smooth
  scroll on every page; the same pages move with the setting off; switching while open). axe also runs on
  every component and on the shell in the unit tests (`tests/a11y-components.test.ts`). The keyboard
  map, focus and live-region rules are documented; `pnpm new-tool` now also creates
  `e2e/specs/<id>.spec.ts` (axe + keyboard-only walk), and from now on every tool and page needs it.
  New dev dependencies `@axe-core/playwright` and `axe-core` (both MPL-2.0, already in the license
  allow list; dev tooling only, never shipped). (#131)
- `web/`: Playwright end-to-end tests in Chromium and Firefox (T-06, #14). New CI job `e2e` (in `needs` of
  `build`, no retries, report and smoke screenshots uploaded) runs against the built app: the app shell
  (focus on the `h1` and the live-region announcement after a navigation, 404, language switch without a
  reload, Ctrl/Cmd+K search, phone menu), the sample tool of the registry in navigation, search and
  routing, and the worker pool with real workers (queueing, progress, cancelling terminates the worker,
  upload, drop and download). Privacy test (SPEC 14): every e2e test fails when the page sends anything
  but a `GET` of an own asset or a piece of an uploaded file appears in any request (raw, hex, base64,
  base64url, percent-escaped; workers included); a test-only tool that leaks four ways proves the check
  can fail. `e2e/support/a11y.ts` is the seam for the axe gate of T-05 (off). New dev dependency
  `@playwright/test` (Apache-2.0). `docs/SPEC.md` 14. (#130)
- Dev environment (F-04, #7): `compose.dev.yml` starts Caddy and Mailpit with one command. Caddy
  serves the real web build on the app address with the index fallback for deep links (a missing
  asset stays a 404), a placeholder site on every name below the site base, the Mailpit UI, and a
  `501` problem document on `/api/*` until `app` exists; two listeners as in ADR 0009 (the tunnel
  listener is not published, every name that is not a public site gets the same `404`). Names are
  `*.localhost` only; `.env.example` documents every variable (checked against the compose file,
  no secrets, reserved names only), `secrets/` is git-ignored. Every service is non-root, read-only,
  `cap_drop: ALL`, `no-new-privileges`, health-checked, pinned by digest and bound to loopback; CI job
  `dev-stack` enforces this with `scripts/ci/check_container_hardening.py` for every compose file
  and Dockerfile it finds (and on the running containers), validates the Caddyfile and runs
  `scripts/ci/dev_stack_smoke.py` (deep link, cookie isolation between app and site origin, tunnel
  listener, SMTP into Mailpit). Dependabot gets the `docker` and `docker-compose` ecosystems. The
  Rust Dockerfiles follow with `app` (A-01) and `edge` (H-19), as decided in SF1.
- `web/`: tool registry, manifest schema, worker pool and `pnpm new-tool` (T-04, #12). A tool is a
  directory `src/tools/<id>/` with a `manifest.ts` (id, category, message keys for name, description
  and keywords, design sticker, `runsIn`, required capabilities, size budget, lazy `load()`); the
  registry builds navigation, search (id, name, keywords in both languages) and one lazy route per
  tool from the manifests alone, and `ToolFrame` gives every tool page its one `<h1>`, the sticker, the
  description, the "files stay in this browser" note and a notice when the browser lacks WebAssembly,
  Web Crypto or Workers. The schema reports every violated rule, rejects unknown fields, requires
  `fileContent: "stays-in-browser"` and refuses `runsIn: "server"`; a Vite plugin runs it over
  `src/tools` so a bad manifest fails `vite build`, and a source scan fails on any network API in a
  tool. `tools.config.json` disables tools until the admin toggle (A-09). `@stuffcloud/tools` gets a
  worker pool with progress, cancellation (aborting stops the worker), a FIFO queue and crash
  recovery, plus `serveWorker` for the worker side. `pnpm new-tool <id> [--worker]` scaffolds the tool,
  its test and both catalogue texts. No new external dependency. `docs/adr/0012-tool-registry-and-worker-pool.md`,
  addendum to ADR 0004, SPEC 7. (#128)
- `web/`: app shell, router and i18n (T-03, #11). Header with tool navigation, search dialog
  (Ctrl+K / Cmd+K) and language switch, footer, skip link, offline notice; a small History-API
  router with lazy-loaded pages and one lazy route per tool (`/tools/<id>`, deep links), not-found
  page with the ghost mascot, error state with retry (load and render failures); on every
  navigation focus moves to the page heading, the title is announced in a live region and
  `document.title` follows. German and English catalogues with typed keys, placeholders, CLDR
  plurals, `Intl` number/date formatting, browser-language default and a manual switch that
  applies without a reload; the `web` job fails on a missing, unused or inconsistent key and on
  literal text in the shell. No new dependency. `docs/adr/0011-spa-routing-and-i18n.md`, addendum
  to ADR 0001, SPEC 13. (#127)
- `docs/adr/0010-api-first-and-configuration-as-code.md`: API-first and configuration as code
  (#116, SF9). No UI-only features; resources with natural keys, idempotent `PUT`,
  `ETag`/`If-Match`, dry-run and RFC 9457 errors; secrets only as references to deployment
  configuration; scoped tokens with admin scopes and service accounts; full CLI parity with
  `validate`/`plan`/`apply -f`; bootstrap from environment and files; the zones and settings of
  ADR 0009 as declarative resources; own Ansible collection and OpenTofu provider later, their
  repository location decided when each is built. (#126)
- `CLAUDE.md`: rule "API-first (no UI-only features)": a PR that adds a UI action adds the API
  endpoint, the CLI command and their tests. (#126)
- `docs/adr/0009-zone-model-and-shared-domain-isolation.md`: the zone model of SF5. Any number of
  admin-managed zones, each usable on the LAN and from the internet; visibility per site
  (`internal`/`public`); per-zone policy (who may host, trusted-accounts allow-list, anonymous
  hosting, public sites, extra reserved names, optional sub-level, interstitial); the app on its
  own address that may share a registrable domain with sites, isolated by `__Host-` cookies
  without `Domain=`, an `Origin` check and CSRF tokens; the internet origin decided by a separate
  tunnel listener, never by a header; a PSL entry optional. (#125)
- `web/`: `Mascot` component and mascot catalogue for the nine animals of `docs/design` (SVG used
  from the design folder, one copy): integer scales only with `image-rendering: pixelated`, a
  reserved box (no layout shift), the design's two-pose bob as a `transform` keyframe animation
  with `steps(1)` (no script per frame), paused off-screen and in hidden tabs, the still pose
  under `prefers-reduced-motion`, decorative by default (`aria-hidden`), no text. Shown in the
  component gallery. (#113)
- `docs/adr/0008-pixel-art-animation-runtime.md`: the animation runtime decision of T-02 with
  measurements (CSS transform keyframes chosen over canvas loops and `background-position`
  sprite sheets: 1.5 % vs 18 to 22 % main-thread load for one mascot at a 6x CPU slowdown, no
  layout shift, no dropped frame), recorded in the ADR index and SPEC 12 and 16. (#113)
- `web/apps/web/bench/`: dependency-free animation benchmark (`node bench/run.ts bench`,
  `verify`, `size`) that drives a headless Chrome over the DevTools protocol and compares CSS,
  sprite-sheet and canvas variants (frame budget, main-thread time, layout and style
  recalculation counts, layout shift, code size); never part of the build, its logic is unit
  tested and counted in the coverage floor. (#113)
- `web/`: design tokens as CSS custom properties, generated from the `:root` rule of
  `docs/design/prototypes/stuff.css` (`pnpm tokens`; a unit test and `pnpm tokens:check` fail while
  `src/styles/tokens.css` is stale), plus `theme.css` for the colours the mockups use without a
  name, the spacing scale and the control sizes (a test checks that every literal exists in
  `docs/design`). Dark only, visible focus, `prefers-reduced-motion` and forced-colors handled. (#112)
- `web/`: self-hosted Silkscreen, Inter and JetBrains Mono (OFL-1.1, Latin and Latin Extended
  woff2, recorded with SHA-256 in `docs/THIRD-PARTY-ASSETS.md`); the build never inlines assets
  and a test builds the app and fails on any external or `data:` reference in CSS and HTML. (#112)
- `web/`: base Svelte components `Button`, `LinkButton`, `Input`, `Select`, `Checkbox`, `Tabs`,
  `TabLinks`, `Card`, `Tile`/`TileGrid`, `Dialog` (native modal `<dialog>`), toasts (`Toaster`,
  `ToastRegion`), `Progress`, `CodeBlock` and `FileDropzone`, following the mockups, with
  touch targets of at least 44 px (48 px icons), and a component gallery page (`gallery.html`).
  Automatic WCAG 2.2 AA contrast checks over the token pairs and 247 unit and component tests
  (coverage 99 % lines, 97 % branches). New dev dependencies: `@testing-library/svelte`,
  `@testing-library/dom`, `@testing-library/user-event` (MIT). (#112)
- `docs/adr/`: architecture decision records 0001 to 0007 (stack incl. the plain Vite SPA variant,
  static-only hosting and origin isolation, storage abstraction, client-side-first tools, auth
  model, the `edge` process and the shared `core` crate, test strategy), each with status,
  context, decision, consequences, open points and alternatives considered, plus an index with
  the template and the numbering rule. Linked from README, CONTRIBUTING, CLAUDE.md and SPEC.
  The SQLite driver (`sqlx` or `rusqlite`) stays open in ADR 0001 until A-01. (#110)
- CI: job `licenses` (part of the `build` gate) fails when any npm package of `web/`, production
  or dev and including the native packages of other platforms, has a license outside
  `scripts/ci/license-policy.toml` (same allow list as `deny.toml`, kept identical by a unit
  test; unknown or missing licenses fail; dev/build-only licenses and odd license fields need a
  documented entry). The inventory installs the locked packages with `--ignore-scripts` into a
  scratch directory and fails if a locked package would go unchecked. (#109)
- `docs/THIRD-PARTY.md`: generated list of every runtime dependency (Rust and npm) with version,
  license and source, from `Cargo.lock` and `web/pnpm-lock.yaml`; the `licenses` job fails when it
  is stale (`python3 scripts/ci/third_party.py --write`). `docs/THIRD-PARTY-ASSETS.md` records
  WASM modules, model weights, fonts and data files that are in neither package tree. (#109)
- Tests for the license tooling (SPDX parser, policy, inventory, report). (#109)
- CONTRIBUTING.md and CLAUDE.md: how to add a dependency and which license rules apply. (#109)
- CI: job `web` in `ci.yml` runs `pnpm lint`, `typecheck`, `test` (95 % coverage floor
  per package) and `build` for `web/` as four parallel checks (frozen lockfile, pnpm
  from corepack, cached pnpm store, Node from `.nvmrc`) and is part of the `build`
  gate, so `build` fails on any frontend lint, type or test error. CodeQL analyzes
  `javascript-typescript` (`security-extended`, fails on any result) and Dependabot
  opens grouped weekly npm PRs for `/web` (7-day cooldown). (#107)
- `web/` frontend workspace (pnpm 12, Node 24): `apps/web` (Svelte 5 + Vite single-page
  app), `packages/tools` (validated tool ids and manifest) and `packages/api-client`
  (`openapi-fetch` wrapper and the schema generation script; the generated client
  follows with `app`). TypeScript strict (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), type-aware ESLint with `no-explicit-any` as an error
  (proved by a test), Prettier, Vitest with a 95 % coverage floor in every package,
  committed lockfile; all dependencies are GPL-3.0-compatible. (#106)
- Rust workspace with `crates/core`: `SafeRelPath` (upload path hardening: NFC,
  no traversal, no hidden, control, invisible or Windows-reserved names, length
  and depth limits) and `Subdomain` (label rules, reserved names, no Punycode,
  unbiased generation from caller-supplied random bytes), with unit, property
  (proptest) and regression tests; strict workspace lint set (`unsafe` forbidden,
  no `unwrap`/indexing/unchecked arithmetic), pinned toolchain, release profile
  with overflow checks. (#101)
- `fuzz/`: cargo-fuzz targets `safe_rel_path` and `subdomain` with invariant
  checks, seeds and a dictionary. (#101)
- `deny.toml`: cargo-deny gate for RustSec advisories, GPL-3.0-compatible
  licenses, crates.io-only sources and wildcard versions. (#101)
- `deep-tests.yml`: nightly long fuzzing with a cached, minimised corpus, full
  mutation run, Miri, 500 000 property-test cases, fresh advisories and the beta
  toolchain. (#101)
- Label `area/api` (the backend label the issue backlog already uses) with path
  rules for the Rust files. (#101, #105)
- `codeql.yml` (CodeQL advanced setup, `security-extended`, Rust, Python and
  Actions): runs as job `codeql` inside `ci.yml`, so the required `build` check
  covers it, fails on any result, and runs weekly on `main`; config in
  `.github/codeql/codeql-config.yml`. (#103)
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
- `docs/SPEC.md`: section 10 rewritten for ADR 0010 (API-first, resources and write
  semantics, zones and settings as resources, tokens and service accounts, CLI parity and exit
  codes, declarative configuration, bootstrap, Ansible and OpenTofu); sections 5.2, 6, 9, 11
  and 16 follow it. (#126)
- `docs/SPEC.md`: section 5 rewritten for the zone model of ADR 0009 (app address, zones with
  per-zone settings, per-site visibility, listeners and split-horizon DNS, shared-domain
  isolation); sections 4, 6, 8.3, 8.5, 9, 10, 14 and 16 follow it. ADR 0002 and ADR 0005 are
  partly superseded by ADR 0009; the ADR index gains the status `Partly superseded`. (#125)
- `CLAUDE.md`: new section "Instance-neutral (open source)": no operator-specific domains, hosts, IPs or addresses anywhere in the repo, examples only with RFC 2606/6761 names and documentation IP ranges; the Claude review flags violations. (#115)
- Dependabot ignores semver-major `@types/node` updates in `/web`; the types follow the Node major
  in `web/.nvmrc` and are bumped by hand with it. (#109)
- `docs/SPEC.md` draft 0.3: backend in Rust (`axum`, SQLite) instead of
  Node.js/Fastify; new minimal `edge` process as the only stuffcloud code the
  internet reaches (site password, burn-after-reading, reports); shared `core`
  crate; OpenAPI-generated frontend client; standalone CLI binaries; hardened
  containers; subdomain and path rules spelled out; section 14 rewritten as a
  test strategy that errs on the side of too many tests. (#101)
- `ci.yml`: `build` is now an aggregate over fmt, clippy, tests (debug and
  release), rustdoc, coverage (95 % floor), mutation testing, a short fuzz run per
  target, cargo-deny and the repository checks. `dependabot.yml` enables cargo
  for the workspace and `fuzz/`. CLAUDE.md, README, CONTRIBUTING, the PR template
  and the ruleset README describe the new pipeline. (#101)
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
- Auth hardening after the security review of A-02 (#134 to #137): only a well-formed
  `Authorization: Bearer` header skips the Origin and CSRF checks, another scheme (`Basic`,
  `Digest`, `Negotiate`, ...) is ignored and a malformed `Bearer` header or several
  `Authorization` headers answer 401; `GET /api/v1/auth/session` binds a new CSRF token only for
  same-origin requests (`Sec-Fetch-Site`), session lookups of unknown or fresh sessions no
  longer take the write lock, refused requests are counted in
  `stuffcloud_auth_rejections_total{reason}` and logged at most once per 10 seconds, and the
  typed client repeats a write once with a fresh token (`refreshCsrfToken`); `HostCookie::set`
  and `clear` return a `SetCookie` that is the only value `append_cookie` takes;
  `scripts/ci/check_cookies.py` scans every Rust file (tests, `build.rs`, fuzz targets), escaped
  and `concat!`-ed names, cookie libraries, `Cargo.toml`, Caddy files and `web/`
  (`document.cookie`), each bypass with a failing fixture; an `Origin` port with a leading zero
  is refused; the ADR 0005 addendum documents the accepted residual risks (cookie tossing logs a
  user out, timeouts need a correct clock). New fuzz target `authorization`. (#138)
- `web/`: the indeterminate `Progress` bar animates `transform` only (stripes on a child one
  stripe period wider than the bar, moved by `translateX` in four steps) instead of
  `background-position`, so it no longer restyles and repaints at every display frame; style recalculations on
  the gallery page drop from about 350 to 2 to 4 per 2 s. Reduced motion and forced colours are
  unchanged; tests assert the transform-only keyframes. `bench/run.ts verify` now also reports style
  recalculation time and main-thread task time. (#124)
- Field borders (input, select, textarea, search and code cells) now reach 3:1 against the page
  background (WCAG 2.2 AA 1.4.11): new design token `--field-border` (`#6c6c76`, 3.7:1 on `--bg`,
  was `--line2` `#3a3a42` at 1.7:1) in `docs/design/prototypes/stuff.css`, the mockups, the token table
  and the design PDF; `web/` takes it through the generated `tokens.css`. The contrast test now
  covers field borders and fails when a field or a mockup control falls back to the hairline. 
  (#123, SF8)
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
