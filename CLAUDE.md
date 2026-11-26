# stuffcloud

Self-hosted toolbox (client-side tools) + one-click static hosting. Full spec: `docs/SPEC.md`.

## Type

Greenfield project (public, GPL-3.0).

## Stack

Rust backend (Cargo workspace: `axum`, `tokio`, SQLite) + Svelte/Vite frontend
(TypeScript strict), Caddy, Docker Compose. See `docs/SPEC.md` sections 4 and 14.
Exists so far: `crates/core` (validation, no I/O), `crates/db` (SQLite, migrations),
`crates/mail` (SMTP transport and message builder), `crates/app` (LAN API), `fuzz/` and the `web/` scaffold. `edge` and `cli` are added in the
phase that needs them; each new crate inherits `[workspace.lints]` (`[lints] workspace = true`).

## Structure

```
crates/core/    domain types + validation (SafeRelPath, Subdomain), API building blocks (etag,
                query, body + field errors, settings shapes), auth building blocks (token,
                authorization: the Authorization header (only a well-formed Bearer skips CSRF),
                cookie: `__Host-` cookies + `SetCookie` + Cookie lookup, csrf: Origin + CSRF
                check, session: timeouts, roles; authorisation: scope = permission names + token
                scopes, policy = the permission matrix + `decide`, hosting = zone rules `may_host`), account
                building blocks (account: login names, e-mail addresses, password policy, action bodies;
                throttle: backoff rule; client_ip: trusted proxies + X-Forwarded-For + unlisted-proxy detection),
                mail building blocks (smtp: the `smtp` settings group + secret references, mail: DE/EN mail
                texts, request document, retry schedule), no I/O
  tests/        properties.rs, api_properties.rs, auth_properties.rs, policy_properties.rs, account_properties.rs, mail_properties.rs (proptest), regression.rs (attack corpus)
crates/db/      SQLite (rusqlite, WAL): migrations/ + runner, resource store, audit log, bootstrap,
                auth.rs (users, hashed sessions, timeouts, rotation, session cap, security audit events),
                accounts.rs (passwords, registration, invitations, reset tokens, reset tokens for mail)
crates/mail/    optional mailer, delivery side (lettre): message.rs (the message, injection-proof), transport.rs
                (`Transport` seam, errors without server text, `Recording` for tests), smtp.rs (STARTTLS/TLS with
                rustls + ring, system roots); tests/transport (fake SMTP servers)
crates/app/     LAN API (axum): config (env + _FILE), resource conventions (resource.rs), problem
                details, access.rs (every route is registered with its requirement; guard, startup
                check against OpenAPI, permissions document), auth.rs (session cookie + CSRF middleware, the only place that sets
                cookies), sessions.rs (session endpoints), accounts.rs (login, register, reset, password
                change, profile), invitations.rs (admin invitations + reset links), password.rs (Argon2id,
                dummy hash, offline breached list), throttle.rs (login throttles), maintenance.rs (periodic
                purge), mail.rs (the optional mailer: in-memory queue, worker, retries, secret references),
                mail_api.rs (`GET /features`, `POST /auth/password-reset/request`), sampler.rs (rate-limited log lines),
                health/metrics, telemetry, bootstrap,
                OpenAPI (utoipa), CLI (`serve`, `healthcheck`, `openapi`, `permissions`, `reset-link`);
                tests/integration (router, auth: cookies/CSRF of every route, authz: permission matrix of
                every route x caller, accounts: enumeration, sign-up modes, throttles, reset, mail: the
                reset mail end to end + the `smtp` group, log redaction, process)
docker/app/     Dockerfile (distroless, non-root) + bootstrap.dev.json for the dev stack (reserved names, open sign-up, `smtp` group for Mailpit)
web/            pnpm workspace (Node 24, own lockfile; the backend never depends on it)
  apps/web/     Svelte + Vite SPA (static build): src/styles (fonts.css, theme.css: base styles and the few app-local `--sc-*` tokens; every other token is kern's `--k-*`),
                src/app (app shell, router, pages, mascot art URLs,
                tool registry + `ToolFrame`), src/tools/<id>/ (one directory per tool: manifest.ts + Tool.svelte),
                src/pdf (what the PDF tools share: engine on pdf-lib, workers + pools, pictures on pdf.js,
                page grid on kern's SelectGrid, ZIP writer; ADR 0013; the network scan covers it like src/tools),
                tools.config.json (disabled tools), perf-budgets.json (shell budgets + Lighthouse minimums), scripts/ (check-tools, new-tool, perf-budget + check-budgets, lighthouse),
                stryker.config.mjs + vitest.stryker.config.ts (mutation testing; shared options and the scope helper in web/stryker.shared.mjs),
                src/i18n (catalogues de/en, typed keys, CI check), src/gallery (component gallery),
                src/assets/fonts (self-hosted), bench/ (animation benchmark: `node bench/run.ts bench|verify|size`),
                perf/ (large-PDF measurement: `pnpm e2e:build && node perf/pdf-large.ts`),
                e2e/ (Playwright: specs/, support/ privacy check + axe gate + keyboard helpers, app/ test-only tools; README.md)
  packages/tools/       manifest schema + `defineTool`, capabilities, stickers, worker pool (`createWorkerPool`, `serveWorker`)
  packages/api-client/  typed client + OpenAPI generation script (generated file comes with app)
  tests/        lint-config test (a deliberate `any` must fail lint)
fuzz/           cargo-fuzz targets, seeds, dictionary (own workspace, nightly)
Cargo.toml      workspace, lint set, release profile (overflow checks on)
deny.toml       cargo-deny: advisories, GPL-compatible licenses, sources
rust-toolchain.toml  pinned stable (same as rust-version in Cargo.toml)
.github/        workflows (ci, deep-tests, claude review, workflow-lint, secret-scan), rulesets, templates
scripts/ci/     label script (opt-in via LABELS_ENABLED), npm license gate (license_gate.py,
                license-policy.toml), THIRD-PARTY.md generator (third_party.py), container
                hardening gate (check_container_hardening.py), dev stack smoke test
                (dev_stack_smoke.py), cookie scope gate (check_cookies.py: Rust, Cargo.toml, Caddyfiles, web/),
                crypto misuse gate (check_crypto.py: reviewed call sites of salts, literal keys, SHA-2;
                no MD5/SHA-1), operator-domain gate (check_operator_domains.py: domains and e-mail addresses
                from the Actions secret/variable STUFFCLOUD_FORBIDDEN_DOMAINS, reduced check without it), mutation
                gate (mutation_gate.py + requirements-mutmut.txt/.in: mutmut over these scripts, config in
                the root pyproject.toml), tests
compose.dev.yml local dev stack (Caddy, app, Mailpit; `edge` joins with H-19); docker/caddy/
                Caddyfile.dev, placeholder site, Dockerfile (web build baked in); .env.example
docs/           SPEC.md, ACCESSIBILITY.md (a11y gate, keyboard map), adr/ (architecture decision
                records), api/ (openapi.json generated from `app`, problems.md: the problem types),
                THIRD-PARTY.md (generated),
                THIRD-PARTY-ASSETS.md, design/ (frozen reference), TEMPLATE-SETUP.md
```

## Commands

```sh
cargo fmt --all && cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets          # unit, property, regression tests
cargo llvm-cov --workspace --fail-under-lines 95 --fail-under-regions 95
cargo mutants --workspace                     # every mutant must be caught
cargo deny check && cargo deny --manifest-path fuzz/Cargo.toml check
cargo +nightly-2026-11-01 fuzz run safe_rel_path fuzz/corpus/safe_rel_path \
    fuzz/seeds/safe_rel_path -- -dict=fuzz/dicts/stuffcloud.dict -max_total_time=60
python -m unittest discover -s scripts/ci -p "test_*.py"   # CI helper tests (Python 3.11+)
python -m pip install --require-hashes --no-deps -r scripts/ci/requirements-mutmut.txt   # once (Linux/macOS/WSL; mutmut needs fork)
python -m coverage run -m unittest discover -s scripts/ci -p "test_*.py" && python -m coverage report   # line + branch coverage of the helpers (pyproject.toml, floor 99 %)
mutmut run && mutmut export-cicd-stats && python scripts/ci/mutation_gate.py   # every mutant of scripts/ci/*.py must be caught (mutmut: pyproject.toml); `mutmut results`, `mutmut show <name>`
python scripts/ci/check_cookies.py            # no cookie with a Domain attribute, Set-Cookie only in app/src/auth.rs, no document.cookie
python scripts/ci/check_crypto.py             # crypto in product code only at the reviewed call sites (ALLOWLIST with reasons)
STUFFCLOUD_FORBIDDEN_DOMAINS=... python scripts/ci/check_operator_domains.py   # no operator domain or e-mail address in tracked files (list never in the repo; CONTRIBUTING.md)
python scripts/ci/license_gate.py             # npm license gate (needs pnpm; installs into a temp dir)
python scripts/ci/third_party.py --write      # regenerate docs/THIRD-PARTY.md after a lockfile change
cargo run -q -p stuffcloud-app -- permissions > docs/api/permissions.md   # after a route or matrix change (a test fails when stale)
cargo run -q -p stuffcloud-app -- openapi > docs/api/openapi.json   # after a handler change, then:
(cd web && pnpm --filter @stuffcloud/api-client generate -- --input ../../../docs/api/openapi.json)
docker compose -f compose.dev.yml up --build  # local dev stack (README, "Local development stack")
python scripts/ci/check_container_hardening.py static   # hardening gate (needs docker for the compose files)
```

Tools: `cargo install --locked cargo-llvm-cov cargo-mutants cargo-deny cargo-fuzz`
(CI pins their versions in the workflows).

Frontend, from `web/` (`corepack enable` once; Node per `.nvmrc`):

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # coverage floor 95 % per package
pnpm test:mutation                                       # StrykerJS: every mutant of the TypeScript logic must be caught (apps/web: tools + pdf, packages/tools); `pnpm --filter @stuffcloud/tools test:mutation` for one package
pnpm new-tool <id> [--category c] [--sticker s] [--name "N"] [--worker]   # scaffold a tool (ADR 0012)
pnpm check-tools                                         # validate all tool manifests (`vite build` runs the same check)
pnpm perf:build && pnpm check-budgets                    # production build with the Vite manifest, then the gzip budgets of the shell and every tool (docs/PERFORMANCE.md)
CHROME_PATH=... pnpm lighthouse                          # Lighthouse median of 5 runs on that build (needs Chrome or Chromium)
pnpm e2e                                                 # Playwright (Chromium + Firefox) against the built app; once: `pnpm --filter @stuffcloud/web exec playwright install chromium firefox`
CHROME_PATH=... node apps/web/bench/run.ts bench         # animation runtime benchmark (needs Chrome; ADR 0008)
```

## Tests (non-negotiable)

Tests are part of the security design; err on the side of too many (SPEC section 14).

- Every rule gets unit tests on both sides of every boundary, every error variant
  and message is asserted. Coverage floor 95 % lines and regions; never lower it to
  get green.
- Every invariant gets a property test; every parser of untrusted input gets a fuzz
  target that asserts invariants, not just "no panic".
- Every bug and fuzz finding becomes an entry in `tests/regression.rs` and a seed in
  `fuzz/seeds/<target>/`.
- A surviving mutant is a missing test: add the test, do not skip the mutant. This holds for the
  Python CI helpers in `scripts/ci/` too (mutmut, ADR 0007 addendum): an equivalent mutant gets
  `# pragma: no mutate` with the proof next to it, nothing else. And for the TypeScript logic of `web/`
  (StrykerJS, ADR 0007 addendum): an equivalent mutant gets `// Stryker disable next-line <mutator>: <reason>`
  with the proof as the reason; never exclude a file from the scope to get green.
- Never weaken a check (`#[allow]`, `ignore`, lower thresholds, `continue-on-error`)
  to make CI pass; `#[expect(..., reason = "...")]` only where the reason is a proof.

## CI

`ci.yml` job `build` is the required check: an aggregate over fmt, clippy, test,
docs, coverage, mutants (6 shards), mutation-python (mutmut over `scripts/ci/*.py`, gate in `mutation_gate.py`), web-mutants (StrykerJS over the scoped `.ts` files the PR changes, 2 legs: `apps/web`, `packages/tools`), fuzz, web (lint, typecheck, test, build of `web/`), e2e (Playwright +
axe a11y gate, no retries), perf-budgets (gzip size of the shell and every tool against `perf-budgets.json` and the manifests' `budget`, `docs/PERFORMANCE.md`), lighthouse (median of 5 runs on the shell: performance, accessibility, best practices >= 95), openapi (committed OpenAPI document and generated TS client match the
handlers), licenses (npm
license gate + THIRD-PARTY.md freshness), dev-stack (container hardening gate on every compose file
and Dockerfile, Caddyfile check, smoke test of the dev stack), supply-chain, codeql and repo-checks (add new jobs to its `needs`; no job skips itself on changed
paths, because the aggregate counts a skipped job as a failure). `deep-tests.yml` runs nightly: long fuzzing (grows the cached corpus),
full mutants, full mutmut run (with report artifact), the full StrykerJS run (`web-mutants-full`, report artifacts; on demand until the survivors listed in #162 are closed), Miri, 500k proptest cases, fresh advisories, beta toolchain.
Toolchain bump: `rust-toolchain.toml` + `rust-version` in `Cargo.toml` + the `rust:` image in
`docker/app/Dockerfile` (a test enforces it); nightly
bump: `NIGHTLY` in both workflows. Dependabot handles actions, cargo, npm (`/web`,
minor/patch grouped; semver-major `@types/node` is ignored, it follows the Node major in
`web/.nvmrc` and is bumped by hand together with it) and the Docker images (`docker`, `docker-compose`;
every image reference is `name:tag@sha256:digest`) and pip (`/scripts/ci`: mutmut, hash-locked in `requirements-mutmut.txt`
from `requirements-mutmut.in` with `pip-compile --generate-hashes`). A new service in a compose file copies the `x-hardened`
block, a new Dockerfile directory gets a Dependabot entry; the hardening gate fails otherwise.

## Dependencies and licenses

A new dependency must have a GPL-3.0-compatible license. Rust: `cargo deny` (`deny.toml`).
npm: `scripts/ci/license_gate.py` against `scripts/ci/license-policy.toml` (prod and dev,
all platform variants; unknown or missing license fails). The allow list there equals
`deny.toml`'s (a unit test enforces it): add a new license to both, after checking it.
Dev-tooling-only licenses go into `[dev_only]`, odd license fields into `[[exception]]`,
each with a reason. After a lockfile change regenerate `docs/THIRD-PARTY.md` with
`python scripts/ci/third_party.py --write` (CI fails on a stale file). WASM, models, fonts
and data files go into `docs/THIRD-PARTY-ASSETS.md`. CI-only Python tooling (mutmut and what it pulls in,
`scripts/ci/requirements-mutmut.txt`) is in no shipped tree and in neither gate: its licenses are checked by
hand when a pin changes (CONTRIBUTING.md). Details: CONTRIBUTING.md.

## Architecture decisions

Decisions that are expensive to reverse go into `docs/adr/` (index, status values, template
and numbering rule in `docs/adr/README.md`). Do not change an accepted ADR's decision: write a
new one that supersedes it; a gap-filling addendum (SQLite driver, A-01) is appended to the
original. Update the index and `docs/SPEC.md` in the same PR.

## Tools

A tool is a directory `web/apps/web/src/tools/<id>/` created with `pnpm new-tool <id>` (ADR 0012):
`manifest.ts` (schema-checked; a bad one fails `vite build`), `Tool.svelte` (always a `<ToolFrame>`,
which owns the one `<h1>`) and its test. Name, description and keywords are catalogue keys
(`tool.<id>.name|description|keywords`, German and English), never literals. A tool never sends file
content anywhere: `fileContent: 'stays-in-browser'`, no network API in tool sources (a test scans
them). Heavy work runs in a worker through `createWorkerPool`/`serveWorker`. New generic pieces
go to kern; the base components come from `@mozra-the-great/kern` (ADR 0014; #121 is done, its final addendum lists what stays local and what is still plain markup, follow-up #202) and `src/ui` is gone. A tool gets an e2e spec in `web/apps/web/e2e/specs/` (import `test`
from `../support/fixtures.ts`: it fails the test when the page sends anything but `GET`s of its own
assets; call `net.watch(file)` so a piece of an uploaded file in any request fails it too, and
`a11y.check(page, '<state>')` after each state: that runs axe).

## Accessibility (gate for every tool and page)

WCAG 2.2 AA is checked on every PR (`docs/ACCESSIBILITY.md`: gate, keyboard map, focus rules, live
regions, motion). `a11y.check` fails the `e2e` job (and so `build`) on any axe violation of the
WCAG A/AA and best-practice rule sets, in Chromium and Firefox, whatever the impact; never switch a
rule off or lower the bar to get green. `pnpm new-tool` creates the spec with the axe check and a
keyboard-only walk (`expectKeyboardOnly` from `e2e/support/keyboard.ts`). A tool or page PR extends it
with `a11y.check` after every state, the keyboard route for each action, a live region for results
that appear, and honours `prefers-reduced-motion`. Reviewers flag a tool PR without its a11y spec.

## API-first (no UI-only features)

stuffcloud must be fully operable without the web UI (SPEC §10, ADR 0010). Flag every
violation in review.

- The web UI talks to the server only through the generated API client; no hand-built API
  calls, no server logic reachable only from the UI.
- A PR that adds or changes a UI action on the instance (user or admin) adds or changes, in
  the same PR, the API endpoint, the CLI command and their tests (API integration test, CLI
  test, UI test). The CLI/OpenAPI parity test must stay green; an exception (only steps that
  need a browser by nature, such as the WebAuthn ceremony or the OIDC redirect) is listed
  in that test with a reason.
- Configurable objects are resources with a natural key: idempotent `PUT` with the full
  writable shape, `GET` returning that shape plus `meta`, `ETag`/`If-Match`, `?dry_run=true`,
  RFC 9457 errors. They also appear in the declarative config (`stuffcloud plan/apply -f`)
  and its JSON Schema.
- Secrets are references to deployment configuration, never values in the API or the
  declarative file.
- Authorisation is central (A-07): a new route is added only in `crates/app/src/server.rs`
  (`table`), together with its requirement (`public`, `session` or a permission of the matrix in
  `crates/core/src/policy.rs`); a handler never authorises itself, and a new permission area or
  rule extends the matrix, its tests and `docs/api/permissions.md` in the same PR.

## Changelog

Every PR with a visible change (code, docs, design, CI) adds an entry under
`[Unreleased]` in `CHANGELOG.md` (Keep a Changelog: Added / Changed / Fixed /
Removed), written in English, with the PR number in parentheses. Add it in the
same PR, not afterwards. Pure typo fixes and dependency bumps by Dependabot are
exempt. A release moves `[Unreleased]` under the new version heading.

## Design

kern is the design source (ADR 0016, #199). Follow its `code` theme: every colour, font, space and
size in the app is a kern `--k-*` token (`<html data-theme="code">`), and a kern bump alone carries a
theme change into the app. Rules:

- No colour or size literal in a component and no local copy of a kern token. A generic token or
  component the app lacks goes to kern as an issue first (search open and closed ones, never change kern
  from here); until it ships, the app keeps a minimal local `--sc-*` token in `src/styles/theme.css`
  with a "waiting for kern#N" comment, and the contrast and token tests cover it.
- Reusable art (stickers, mascots, season sets, theme texts) belongs in kern (kern#181); until kern ships
  it the copies in `docs/design/` keep working. Only what is truly stuffcloud-only stays here: the page
  layouts, the tool-category to sticker mapping and the app's own copy.
- `docs/design/` (mockups, `stuff.css`, README, `stuffcloud-design-system.pdf`) is a **frozen reference**
  to orient on, not a specification. There is no PDF to rebuild and no CI check on it; do not update it
  after a design change.

## Notes

- Merge gate: ruleset in `.github/rulesets/default.json` (required checks: build,
  workflow-lint, gitleaks, claude-review). CodeQL is the advanced setup
  (`codeql.yml`, called by `ci.yml` as job `codeql`, so `build` covers it); it fails
  on any result. Do not enable the default setup in the repo settings (it blocks the
  uploads). False positives: dismiss in code scanning and exclude the query in
  `.github/codeql/codeql-config.yml` with a reason. Languages: rust, python, actions,
  javascript-typescript.
- Claude review needs the Actions secret `CLAUDE_CODE_OAUTH_TOKEN`; without it the job skips and stays green.

## Instance-neutral (open source)

stuffcloud is open source and must work for any operator. Flag every violation in review.

- No real domain, hostname, IP address, e-mail address or other operator-specific value
  in code, tests, fixtures, default config, docs, ADRs or issue templates. Zones and the
  app address come from admin settings or deployment configuration (SPEC §5), never
  from code.
- Examples and test data use the reserved names from RFC 2606 / RFC 6761
  (`example.com`, `example.org`, `example.net`, `*.example`, `*.test`, `*.invalid`)
  and the documentation IP ranges (`192.0.2.0/24`, `198.51.100.0/24`,
  `203.0.113.0/24`, `2001:db8::/32`).
- CI enforces it: `scripts/ci/check_operator_domains.py` searches every tracked file for the
  domains and e-mail addresses of the maintainer's list (Actions secret/variable
  `STUFFCLOUD_FORBIDDEN_DOMAINS`, not in the repo; an entry with `@` is one exact address; pull
  requests without access to it get a notice and a reduced check). Never write a real domain or
  address into a test or doc to "test" it: use a reserved name.
- The only allowed project-specific URLs are the project's own links (repository,
  issue tracker, licence, release/update source) — and only where they are needed.

---

## Working rules

These rules apply regardless of what's above. They mirror the operator's global
Claude Code configuration so this repo behaves consistently even if opened on a
different machine or by a collaborator.

### Language

- Chat responses: German
- Everything that goes into the repo — code, comments, commit messages, branch
  names, PR descriptions, CHANGELOG: English (default, more compact)
- Respect a project's already-established language convention if one exists

### Approach — get it right once instead of fixing it ten times

1. Fully understand the task before starting
2. Think through the solution: edge cases, error handling, dependencies, blast radius
3. Only then implement it completely and correctly

No placeholders. No `// TODO` without a resolution attached. No half-finished
implementations.

For larger tasks: use Plan Mode before writing code. If something is fundamentally
unclear and would change the direction of the solution, ask once rather than
building in the wrong direction.

### Coding rules

- TypeScript: no `any`, explicit types
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- Follow the project's existing conventions over these defaults when they conflict

### Git workflow

- Never commit directly to `main`/`master` — always a feature branch
- Branch names in English, kebab-case (`feat/...`, `fix/...`)
- Before every push: check `git status` and `git diff --staged`
- No `git push --force` on main/master

### Security

- `.env`, `.env.*`, `*.pem`, `*.key`, `*.secret` — never read, log, or commit
- No credentials/tokens/passwords in code
- Secrets via environment variables or a secrets manager, never in plaintext

### Subagents — delegate proactively

Use these specialists without being asked each time, as soon as the situation fits:

- **test-runner** → right after writing or changing application code
- **security-reviewer** → after auth/input/dependency changes, and before any release
- **code-reviewer** → before a merge / after finishing a feature
- **debugger** → as soon as a test fails, a stack trace shows up, or behavior is unexpected

Run independent analyses (e.g. security + tests) in parallel. Skip subagents for
trivial changes — the overhead isn't worth it.
