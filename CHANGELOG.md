# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Mutation testing of the Python CI helpers (#161, ADR 0007 addendum): job `mutation-python` in `ci.yml` (part of
  `build`; it never skips itself) and the nightly `deep-tests.yml` run [mutmut](https://github.com/boxed/mutmut) 3
  over every `scripts/ci/*.py`, and `scripts/ci/mutation_gate.py` fails on any mutant no test noticed (`mutmut run`
  itself always exits 0). mutmut (BSD-3-Clause) is pinned with hashes in `scripts/ci/requirements-mutmut.txt` and kept
  fresh by a Dependabot `pip` entry; configuration in `pyproject.toml`. The first run found 1259 surviving mutants
  against 341 tests; about 270 new tests kill them all (exact messages, the `gh` and `docker` calls with the command
  line asserted, every boundary of the cookie gate's Rust lexer, the defaults of optional config keys), and the few
  equivalent mutants carry `# pragma: no mutate` with the proof. `coverage.py` measures line and branch coverage of
  the helpers in the same job (floor 99 %). Small changes to the helpers: their file walks skip the `mutants/`
  working copy, `check_crypto.py` reports the right line of a weak-hash dependency after a blank line, and the cookie
  gate's lexer blanks the character literal `'\''` completely. (#171)
- Shared design kit (#121, ADR 0014): the web app depends on kern (`@mozra-the-great/kern` 0.12.3, GPL-3.0-or-later), pinned as a release tarball with its sha512 in the lockfile, and selects kern's dark Code theme on `<body>`; the base components move to kern in the following pull requests. The npm license inventory reads tarball entries of the lockfile and fails on an entry it does not understand (it would have gone unchecked), and `docs/THIRD-PARTY.md` links such a package to its release. Kern issues for what the app still overrides: kern#144 (root font size), kern#145 (line height). (#169)
- Network tools (T-20, #25): **Subnet calculator** for IPv4 and IPv6 on `BigInt`, no dependency: details of a network (network, broadcast or last address, first and last usable address, netmask, wildcard mask, address and host counts with the `/31` (RFC 3021), `/32`, `/127` (RFC 6164) and `/128` cases, `/0`, the expanded IPv6 form and the IPv4-mapped form), split into N subnets or by prefix length (at most 4096 listed, a bigger split is refused instead of cut off), summary of networks, addresses and `start-end` ranges into the fewest networks plus the smallest single network that holds them all, and a contains check for an address or a network (an IPv4-mapped address is compared with IPv4 networks). **MAC address**: reads the colon, dash, dot (Cisco) and bare spellings and EUI-64, writes all of them, shows unicast, multicast or broadcast and universally or locally administered from the two bits of the first byte, the OUI prefix and the IPv6 link-local address built from it; several addresses at once. Vendor names come only from IEEE CSV files (`oui.csv`, `mam.csv`, `oui36.csv`) that the visitor downloads and chooses in the page: they are read in a worker, kept in memory and never sent anywhere, and **no IEEE data is bundled** because IEEE publishes no licence for it (SF17); the bundled snapshot and its CI refresh stay open in #25. Unit tests, an end-to-end spec per tool with the axe gate, keyboard route, live regions, 320 px reflow and German, and the privacy check on a chosen list. (#160)
- Text and generator tools (T-21, #26), five tools: **Lorem ipsum** (words, sentences or paragraphs, optional classic opening), **UUID** (v4 and v7, up to 1000 at once; every random bit from `crypto.getRandomValues`; v7 counts up inside a millisecond and over a clock that steps back, so UUIDs sort in the order they were made), **QR code** (text or URL, Wi-Fi, vCard; PNG and SVG; the *raw* and the *stuffcloud* style with the mascot in the middle at error-correction level H; every picture is decoded by `jsQR` before it is offered and the stuffcloud style falls back to raw when it does not scan; the encoded content is shown as text), **Text diff** (`diff` / jsdiff: lines or words, side by side or inline, ignore white space, folded unchanged lines; runs in a worker with a time limit, 1 MB texts in well under a second, two unrelated 1 MB texts are shown as replaced instead of freezing the page) and **Text tools** (case, sort, remove duplicates, trim, number lines, find and replace with regex in a worker with a time limit, slugs, counters). New dependencies `uqr` (MIT), `jsqr` (Apache-2.0) and `diff` (BSD-3-Clause), none with dependencies of their own; own PNG writer. Each tool has unit tests, an end-to-end spec with the axe gate, keyboard route, live regions and 320 px reflow; the downloaded QR PNG is decoded by a reader in the end-to-end test. (#159)
- Converters and formatters (T-17, #22; T-23, #28): five client-side tools, each with its a11y spec (axe in Chromium
  and Firefox, keyboard walk, 320 px reflow, German). **JSON, YAML and XML converter**: any direction, indentation,
  sorted keys, XML root name, declaration, typed XML values, swap and download; the conversion runs in a worker
  that is stopped after 10 seconds, every error names format, line and column, and the document is counted before
  it is written (every use of an alias counts again, indentation is estimated) so that a YAML alias bomb, a
  deeply nested document or a huge value count is refused. XML is read by our own reader without DTDs and without
  entities of its own (a DOCTYPE with an internal subset is refused with an explanation; nothing is ever fetched),
  compared against the browser's parser in the tests. **Base64**: text and files (a worker reads a file in pieces,
  with progress and cancel), standard and URL-safe alphabet, padding, 64/76 character lines, data URIs both ways,
  decoded text or a download, exact error positions. **JSON formatter and validator**: our own reader keeps the
  numbers as written, accepts comments and JSON5 on request (strict mode refuses them), shows the path at the
  cursor, finds a value by path, sorts keys, minifies and warns about duplicate keys. **Markdown preview**: `marked`
  (GFM, in a worker that is stopped after 8 seconds, because some texts take it minutes) and DOMPurify with a short
  allow list; the sanitised result is parsed in an inert document, pictures from
  the internet are replaced by their description (the e2e privacy check proves no request leaves), links get
  `noopener noreferrer`, headings are moved below the tool's own so the outline never skips a level, and "copy
  as HTML" copies the sanitised markup; tested against an XSS corpus of 97 payloads in jsdom and in both browsers. Decoded Base64 is never saved as
  a type a browser would run (HTML, SVG, XML, script).
  **SQL formatter**: our own tokenizer and layout (clause per line, nested queries indented, `BETWEEN` / `CASE` /
  `JOIN` aware, keyword case, 2/4/tab/one line) with a dialect choice for quotes, comments and parameters
  (standard, PostgreSQL, MySQL, SQLite, SQL Server, Oracle); only white space and keyword case change, which a
  property test checks on damaged input too. New dependencies `yaml` (ISC), `marked` (MIT) and `dompurify`
  (MPL-2.0 OR Apache-2.0); `js-yaml` and `sql-formatter` were not used because both pull `argparse`
  (Python-2.0 / PSF-2.0), which the license policy does not allow in a production tree. (#154)
- Operator-domain gate (SC-D, SF11): `scripts/ci/check_operator_domains.py` in `repo-checks` searches every
  tracked file and file name for the domains of a maintainer's list that is never in the repository: the
  Actions secret (or variable) `STUFFCLOUD_FORBIDDEN_DOMAINS` (one domain per line or comma separated; a
  secret wins). Matching is case-insensitive, includes subdomains and the Punycode form, and the reserved
  names of RFC 2606 / 6761 are always allowed; findings name file and line, never the domain. Without the
  list (pull requests from forks and Dependabot get no secrets) the step prints a notice and passes, a
  reduced check; a malformed entry fails it. Tests use reserved names only. How to set it:
  CONTRIBUTING.md, "Operator-domain check". (#153)
- Operator-domain gate: an entry of `STUFFCLOUD_FORBIDDEN_DOMAINS` that contains `@` is an exact e-mail
  address (`local@domain`, case-insensitive, whole addresses only, also with the `@` written `%40` or as an
  HTML entity), so a private address can be protected without forbidding every address at its provider; its
  domain part never becomes a forbidden domain. An invalid address fails the gate with the entry number only,
  findings read `forbidden e-mail address (entry N)` and never print the address. Tests use `*.example`
  placeholders and have a failing fixture per rule. (#156)
- ADR 0010 addendum "write-only secrets" (SF12, documentation only, implementation in #152): secret fields
  take a reference or a write-only value that is never returned and never in plain text in the database,
  audit log, export or `plan` output; stored AEAD-encrypted (XChaCha20-Poly1305) in the database under a key
  that only exists in deployment configuration (`STUFFCLOUD_SECRETS_KEY_FILE`, rotation with `secrets
  rewrap`); without a key the feature is off and references still work. SPEC 9, 10.2, 10.6, 10.7, 11, 14, 16.13
  follow; the issues #36, #39, #40, #46, #60, #119 and #120 are updated. (#153)
- ADR 0009 addendum "visibility" (SF10, documentation only): anonymous sites are always internal in every zone;
  signed-in users choose internal or public per site, only where the zone's "public sites allowed" switch
  (default off) is on. `core::hosting::may_host` already implements it; SPEC 5.2, 5.3 and the issues #45, #46,
  #54, #58, #61 and #111 are updated. (#153)
- Crypto misuse gate (#148; #151): `scripts/ci/check_crypto.py` in `repo-checks` lets salted
  password hashes, keys or salts from literal bytes and SHA-2 appear in product code only at
  the reviewed call sites (listed with reason and exact count), and fails on MD5, MD4 and SHA-1
  in code or as a dependency; it compensates the repository-wide CodeQL excludes of A-03.
- Local accounts (A-03, #33; ADR 0005 addendum "local accounts"): login with login name or
  e-mail address (`POST /api/v1/auth/login`), registration in the sign-up modes `open`,
  `invite-only` (the default; single-use admin invitations, optionally bound to an address) and
  `oidc-only` (settings group `signup`), password change (`POST /api/v1/account/password`, ends
  the other sessions), the own profile (`GET /api/v1/account`), and password reset without SMTP:
  an admin issues a single-use link valid for 60 minutes
  (`POST /api/v1/admin/users/{login}/password-reset`) or the operator runs
  `stuffcloud-app reset-link <login>`; redeeming it (`POST /api/v1/auth/password-reset`) ends
  every session. Passwords are hashed with Argon2id (OWASP defaults, `STUFFCLOUD_ARGON2_*`, the
  start-up log reports one hash's time for calibration; at most one hash per core at once) in
  NFKC form; the policy is length based (12 characters by default) with an optional offline
  breached-password list (`STUFFCLOUD_PASSWORD_BLOCKLIST_FILE`, no outside requests). An unknown
  account, a service account and a wrong password get byte-identical answers after exactly one
  Argon2id check (dummy hash), proven by the enumeration test. Failed logins are throttled in
  memory per client address (behind `STUFFCLOUD_TRUSTED_PROXIES`) and per typed login name, as a
  doubling backoff up to 15 minutes instead of a lockout, with an exemption for addresses that
  logged in before; registrations per address. Sessions per account are capped
  (`STUFFCLOUD_SESSION_MAX_PER_USER`, default 10, the oldest ends) and expired sessions and tokens
  are purged every 10 minutes. `STUFFCLOUD_BOOTSTRAP_ADMIN_*` now creates the first admin. New
  problem types `invalid-credentials`, `signup-closed`, `limit-reached`, `too-many-requests`,
  field error code `taken`, fuzz targets `account` and `forwarded_for`, migration
  `0003_accounts`; the `argon2` crate (MIT OR Apache-2.0) is the only new dependency. CodeQL: two query excludes with their reasons in `.github/codeql/codeql-config.yml` (`rust/hard-coded-cryptographic-value`: all hits are fixed test passwords; `rust/weak-sensitive-data-hashing`: SHA-256 is only the lookup key into the public offline breached-password list). `Writable` gets an associated `RULES` list (default: none) and a default `validate`, so a resource without rules (`signup`) needs no empty override. (#142)
- Developer extras (T-22, #27): six client-side tools, no new dependency. **Hash and checksum**
  hashes a text with WebCrypto (SHA-1, SHA-256, SHA-384, SHA-512) and a file of any size piece by
  piece in a worker, with progress and cancel: WebCrypto cannot hash a stream, so a file goes
  through incremental hashers of our own (constants derived from the FIPS 180-4 definition, every
  digest tested against `node:crypto` and WebCrypto, also past 512 MiB); about 10 MiB/s for all
  four at once. It compares the result with a pasted checksum and labels SHA-1 as a checksum for
  accidents, not for tampering. **Password generator** uses `crypto.getRandomValues` only, with
  rejection sampling (no modulo bias) and every chosen kind of character guaranteed; the entropy shown
  is exact (inclusion and exclusion over the kinds). **Regex tester** runs the match in a worker that
  is stopped after 2 seconds, so catastrophic backtracking cannot freeze the page, lists matches,
  groups and named groups, marks them in the text and explains the pattern part by part in German
  and English. **URL** encodes and decodes (component, whole URL, form data) with the position of a
  broken percent sequence, and parses a URL into its parts and query parameters; nothing is opened.
  **JWT decoder** shows header, payload and time claims, warns that nothing is verified and checks
  the signature (HS, RS, PS and ES 256 to 512) with a pasted key in WebCrypto: the key kind must fit
  the algorithm (a public key is never taken as an HMAC secret), `none` is never "valid", private
  keys are refused; tokens and keys are never logged, stored or sent (a test scans the sources,
  the Playwright privacy check watches them). **Timestamp converter** reads epoch seconds or
  milliseconds and ISO 8601, shows seconds, milliseconds, ISO in UTC and in a zone, the date in words,
  the HTTP date and the distance to now, resolving clock times in a zone (skipped hour is an error,
  repeated hour takes the earlier moment). Fixed on the way: the shared time zone helper read years
  below 100 as 19xx. New `TextArea` in `src/app` (kern candidate, #121). Tests: unit, property and
  component tests per tool (JWT keys and signatures are generated at run time, signatures come from
  `node:crypto`) and a Playwright spec per tool (axe gate in both browsers, keyboard routes, live
  regions, German, 320 px; a runaway pattern is stopped and the page works again afterwards). (#149)
- PDF merge, split and page tools (T-10, #15): three client-side tools (`pdf-merge`, `pdf-split`,
  `pdf-pages`) on pdf-lib 1.17.1 (MIT) for editing and pdf.js 6.5.438 (Apache-2.0) for page
  pictures, both in workers (two pools of two). Merge orders any number of files with
  buttons and keyboard; split cuts by page ranges (`1-3, 5, 8-`), every N pages or a selection
  and offers the results as single files or one ZIP (own stored-only ZIP writer); the page editor
  rotates, deletes and reorders pages in a keyboard-operable grid with undo and redo. The result is
  a new document (`copyPages`): bookmarks, form fields and metadata are not carried over, and the
  tool descriptions say so. Limits: 400 MiB, 10 000 pages, 1000 files (200 for merge); encrypted,
  broken, empty, too large and out-of-memory files each get their own message. Shared code lives in
  `src/pdf/` (ADR 0013). Measured in Chromium with 100 MB / 500 pages: merge 0.87 s, worst frame
  28 ms, no long task; page pictures for all 500 pages after 2.4 s, save 1.1 s. Licence policy:
  `0BSD` (tslib, a runtime dependency of pdf-lib) joins the allow list of `deny.toml` and
  `scripts/ci/license-policy.toml` and leaves `[dev_only]`; the unused `@napi-rs/canvas` binding
  of pdf.js is overridden out of the dependency graph. Tests: table-driven and property tests
  (all 31 page subsets of a five-page file), component tests and a Playwright spec per tool (axe
  gate in both browsers, keyboard routes, live regions, German, 320 px). (#144)
- CRON expression and user-agent parser (T-19, #24): two client-side tools, no new dependency
  (own code instead of cron-parser, cronstrue and ua-parser-js; v2 of that library is AGPL). The CRON
  tool reads the 5-field, 6-field (seconds first) and 7-field (year last) forms, the macros
  (`@daily` and friends) and the Quartz extras (`?`, `L`, `L-n`, `LW`, `nW`, `nL`, `n#k`), reports every
  wrong field with its range, explains the schedule in plain German and English, and lists the next
  1 to 50 runs in any time zone the browser knows (through `Intl`, no tz database): a time the clock
  skips is not run, a time that happens twice runs once unless the schedule runs in every hour, and
  the day-of-month and day-of-week fields combine as in Vixie cron (either, or both when one starts
  with `*`). The user-agent tool names browser, engine, operating system, device (type, maker,
  model) and CPU architecture, tells crawlers and HTTP tools apart, notes what browsers hide
  (Windows 10 and 11, macOS 10.15.7, reduced Android strings), reads the visitor's own string only
  when a button is pressed and copies the result as JSON. Tests: a corpus of 69 real user-agent
  strings and 108 CRON expressions with German and English text, seeded random inputs for both
  parsers, DST and half-hour zones, component tests and a Playwright spec per tool (axe gate in both
  browsers, keyboard routes, live regions, German, 320 px). (#143)
- Colour picker and unit converter (T-18, #23): two client-side tools, no new dependency. The
  colour picker reads and writes HEX, RGB, HSL, OKLCH and CMYK (an OKLCH colour outside sRGB loses
  chroma until it fits, and says so), copies each format, checks the WCAG 2.2 contrast of two
  colours (ratio cut, not rounded up, with the five AA/AAA requirements as text) and takes a palette
  from an image by median cut (decoded in the browser; the file never leaves it). The unit
  converter covers length, mass, temperature, data, time, speed, area and volume, searchable in
  English and German, with a significant-digits control, a table of every unit of the category,
  decimal (kB) and binary (KiB) data units kept apart, temperature offsets and absolute zero
  refused. Results are announced in live regions, copying is confirmed in the toast region, and both
  tools have table-driven tests, a Playwright spec with the axe gate and a keyboard route, and a
  German state. App-local `CopyButton` and `ToolStatus` are candidates for kern (kern#72). (#140)
- Roles and central authorisation (A-07, #37; ADR 0005 addendum "authorisation"): one pure
  decision function in `core` (`policy::decide`, deny by default) over the permission matrix of
  SPEC 6 (`<area>:<read|write>`, which is also the token scope), with the zone-level hosting
  rules of ADR 0009 (`hosting::may_host`: enabled flag, roles or an allow-list of accounts,
  anonymous hosting, public sites; anonymous sites are internal, temporary and script-free). A
  token has its scopes intersected with the role its owner has now, so it never exceeds its
  owner and admin scopes stop working when the owner loses the admin role; service accounts have
  tokens only and are refused as a session and at login. Routes are registered only together
  with their requirement (`public`, `session` or a permission), the guard in front of each one
  answers 401 or 403, and the application refuses to start when an OpenAPI operation has no
  declared policy. Refusals of authenticated accounts are audited with internal ids only (at
  most one row per minute per account and rule) and all refusals are counted. New
  `docs/api/permissions.md` (generated by `stuffcloud-app permissions`, a test keeps it
  current), matrix and property tests, a regression corpus of scope texts and the fuzz target
  `scope`. (#139)
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
- Mascots from kern (#121, ADR 0014): kern's `Mascot`, cast and motion constants replace `Mascot.svelte`, `mascots.ts` and `motion.ts`; the art stays the design's SVG files (`src/app/mascots.ts` passes their URLs), the benchmark takes kern's grid and bob. (#178)
- File drop zone and toasts from kern (#121, ADR 0014): the file tools use kern's `FileDrop` in `dispatch` mode (refused files still reported by each tool), and the shell shows notifications in kern's `Toaster` at the bottom left; `FileDropzone`, `accept.ts`, `ToastRegion`, the toast store and their tests go. (#177)
- Dialogs from kern (#121, ADR 0014): the search dialog and the gallery use kern's `Modal` (the design's dialog look, page scroll locked while open); `Dialog.svelte` and its tests go. kern#154 (the Modal's header is a second banner landmark) is worked around with an unnamed `<section>` until kern fixes it. (#175)
- Base components from kern (#121, ADR 0014), first batch: `Card`, `Tile`, `TileGrid`, `CodeBlock` and `Progress` (bare bar with `hideLabel`, the label stays its accessible name) replace the app's own copies, which go together with their tests. (#172)
- CI: `claude-review` is now a tiered Claude review. Agents with pinned models in
  `.claude/agents/review-*.md`: haiku triage, sonnet CLAUDE.md and documentation
  checks, two opus bug hunters, an opus security reviewer after Anthropic's
  `/security-review`, and an opus validator per finding; Sonnet only orchestrates
  and posts. Replaces the code-review plugin run (#155).
- Writes to the settings groups need the permission `admin:settings:write` (an admin session or
  a token with that scope owned by an admin) instead of the interim admin-session check; `403`
  is now documented for them and the `detail` of `401` and `403` names the permission. Reads of
  settings groups stay public. (#139)
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
- Hash tool tests: the length field of the SHA padding is a pure function tested on both sides of the 32-bit boundary instead of an end-to-end hash of 528 MiB that ran into its 120 s timeout on busy CI runners and failed `web (test)` on every pull request. (#170)
- **Nightly deep tests green again (#163).** Miri reported 18 leaks from a test helper in
  `core::cookie` that leaked every header on purpose; it now takes the `'static` literals it is
  given. The beta toolchain (1.101) adds lints that would break the build on the next stable:
  `chunks_exact` with a constant size is now `as_chunks` (`core::token`, `core::client_ip`; the
  unreachable odd-length branch in `Token::parse` is gone with it), `fetch_update` is
  `try_update`, and `assert!(x.is_empty())` in tests is `assert_eq!`/`assert_ne!`, which shows
  the value on failure. No check was relaxed.
- **Login throttles hold under parallel requests and behind a proxy (#145, #146, #147; #150).**
  Attempts are reserved before the password check, so a burst of parallel logins or password
  changes gets exactly the free failures plus one check per key instead of one check per
  request; the Argon2 queue is bounded (beyond 8 waiting requests per slot or 5 seconds: 429
  "busy", not counted). An account is counted under all its names (login name and address share
  10 free failures; the refusal is the usual 401). With an empty `STUFFCLOUD_TRUSTED_PROXIES` a
  private or loopback peer is treated as an unlisted proxy: no address is exempt from the
  account rule, and forwarding headers log a warning once an hour; `compose.dev.yml` now lists its
  network and the dev-stack smoke test proves per-client throttling through Caddy. Full throttle
  tables drop stale keys and the fewest failures first (never a running attempt, never by one
  key per insert), are swept every 10 minutes, and known addresses are capped per account. A
  password change deletes an open reset link, Argon2 parameters below OWASP's minimum pairs stop
  the start, and reset links for admin accounts come only from `stuffcloud-app reset-link`.
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
