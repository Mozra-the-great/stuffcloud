# stuffcloud — Specification

Status: draft 0.3 (2026-11-14; draft 0.2 of 2026-11-05 planned a Node.js backend).
Decisions below come from the requirements catalogue and the owner's answers; items still open are listed in
[Decisions](#16-decisions-on-the-former-open-questions). The context, consequences and rejected
alternatives of the core choices are recorded in the [architecture decision records](adr/README.md).

## 1. Vision

stuffcloud is a self-hosted, resource-frugal web app with two halves:

1. **Toolbox**: a collection of everyday utilities (PDF, images, converters,
   network helpers, generators) that run **in the browser** wherever possible.
2. **One-click hosting**: publish text, files or small websites in seconds on a
   random or chosen subdomain, temporary or permanent, internal or public.

Look and feel: black, console-like, clean, with small pixel-art animals and
stickers that add colour (see [Design](#12-design-and-ux)).

## 2. Goals and non-goals

Goals
- **Security first**: the instance is reachable from the internet; every design
  choice below is weighed against that before convenience or development speed.
- GPLv3 for the whole project; reuse existing open-source components with
  compatible licenses instead of rebuilding them.
- Low RAM/CPU footprint on a single homelab host; tools cost the server nothing.
- Safe-by-design hosting of untrusted user content.
- Privacy by default: no trackers, no stored IP addresses.

Non-goals (v1)
- Server-side execution of user code (no containers/functions for hosted sites).
- Third-party plugins. Tools are first-party modules.
- A file-sync product (this is not Nextcloud).
- Multi-tenant SaaS operation with billing.

## 3. License and reuse policy

- Project license: **GPL-3.0-or-later** (see `LICENSE`, `NOTICE`).
- A dependency is allowed if its license is GPLv3-compatible (MIT, BSD, Apache-2.0,
  LGPL, MPL-2.0 for linked use, GPL-3.0, AGPL-3.0 with the caveats below).
- Each new dependency gets its license checked at adoption time and is listed in
  `docs/THIRD-PARTY.md` (generated from the lockfiles; CI fails when it is stale).
  Assets in neither package tree (WASM builds, model weights, fonts, data files) are
  recorded by hand in `docs/THIRD-PARTY-ASSETS.md`. Candidates in section 7 are
  **not yet verified**; check the exact version before use. Watch for licenses
  that changed between major versions (e.g. `ua-parser-js` v2 is AGPL-3.0, v1 is
  MIT) and for copyleft WASM builds (e.g. Ghostscript is AGPL).
- Rust dependencies are checked by `cargo-deny` on every PR (`deny.toml`): only
  the licenses on its allow list pass, so a new license is a deliberate edit of
  that list. The frontend has the same gate (`scripts/ci/license_gate.py`, job
  `licenses`): all npm packages, production and dev, must match
  `scripts/ci/license-policy.toml`, whose allow list equals `deny.toml`'s (a unit test
  keeps them identical). Licenses that are acceptable only for dev/build tooling are
  listed separately with a reason; an unknown or missing license fails.
- Pixel-art mascots, stickers and easter eggs are original work and are licensed
  under **GPL-3.0-or-later** like the code; no third-party brand art (see section 12).

## 4. Architecture overview

```
 LAN DNS:    app address and *.<site base>  ─► Caddy LAN listener
 public DNS: *.<site base> (public zones)   ─► tunnel ─► Caddy tunnel listener (own port)

 LAN client ──► <app address>      ──► LAN listener ──► app (Rust/axum, SQLite; LAN only)
                                                     └► static frontend (Svelte/Vite)
 LAN client ──► <name>.<site base> ──► LAN listener ──► file_server (internal + public sites)
 Internet   ──► <name>.<site base> ── cloudflared ──► tunnel listener
                                                     ├► file_server (public sites only)
                                                     └► edge (Rust/axum, minimal;
                                                          forward_auth / few routes)
```

A *site base* is a zone or a zone's sub-level (section 5). The app address is not configured
on the tunnel listener at all; `edge` serves its routes on both listeners for the sites each
listener answers.

Components
- **Frontend**: Svelte + Vite single-page app, static build, tools lazy-loaded.
  TypeScript strict, no `any`. The API client is generated from the OpenAPI
  document of `app` (see section 10); CI fails when the generated client is stale.
- **app** (LAN only): Rust, `axum` on `tokio`. Login, accounts, uploads, site
  management, moderation, admin, jobs. SQLite (WAL) for metadata. Storage behind a
  trait; default backend is the local filesystem, an S3-compatible backend can be
  added without API changes.
- **edge** (the only stuffcloud process the internet can reach): a separate,
  deliberately small Rust binary that handles exactly what public sites need from
  a server: the site-password check, burn-after-reading and the abuse report
  (sections 8.3 and 8.6). Caddy asks it via `forward_auth` or proxies only those
  routes to it. It reads the database, writes only the few rows these features
  need, and has no upload, account or admin code linked in, so a bug there is not
  reachable from outside. It gets its own review checklist and fuzz targets.
- **core**: a Rust library shared by `app`, `edge` and `cli` with the domain types
  and every validation rule (paths, subdomains, quotas, roles, permissions). No I/O
  at all, so it can be tested exhaustively (section 14). Validated values are
  types that can only be built by their parser ("parse, don't validate"): code
  that holds a `SafeRelPath` or a `Subdomain` cannot have skipped the check.
- **Reverse proxy**: Caddy serves the app and all hosted sites directly from disk,
  routing by `Host` header, on two listeners: the LAN listener (app address and every
  site) and the tunnel listener (public sites and their `edge` routes only). Wildcard
  certificates per site base via DNS-01. Caddy, not stuffcloud, is the hot path for
  site traffic.
- **cloudflared**: connects **only** to the tunnel listener, so only public sites are
  reachable through it. The app address is never routed through the tunnel.
- **Jobs**: in-process scheduler in `app` for expiry cleanup, reminders, reports.
- **Deployment**: Docker Compose (app, edge, Caddy, cloudflared) in an LXC/VM on
  Proxmox; images published to GHCR; Ansible role in `homelab-infra` later.

Repository layout (Cargo workspace): `crates/core`, `crates/db`, `crates/app`,
`crates/edge`, `crates/cli`; `fuzz/` (cargo-fuzz targets, own workspace);
`web/` (pnpm workspace: `apps/web` Svelte + Vite SPA, `packages/tools`,
`packages/api-client`). Only `crates/core`, `fuzz/` and the `web/` scaffold exist
so far; the others are added in the phase that needs them (section 15).

Stack rationale (decision 9 in section 16): the instance is exposed, so security
and a small footprint outweigh "one language end to end". Rust gives memory
safety without a garbage collector, a small dependency tree that `cargo-deny`
can gate, one static binary per service in a `distroless` image without shell or
interpreter, CPU-heavy work (Argon2id, archive extraction, hashing) off the
request path via `spawn_blocking` instead of blocking an event loop, and a type
system that enforces validation and exhaustive permission checks. The frontend
stays Svelte/TypeScript because the tool libraries are JavaScript/WASM and run in
the browser anyway. The language does not prevent logic bugs (authorisation, path
handling, headers); those are what the test strategy in section 14 targets.

## 5. Network zones, domains and addressing

Decided in [ADR 0009](adr/0009-zone-model-and-shared-domain-isolation.md) (owner answer to
SF5, issue #117), which replaces the zone parts of ADR 0002. No domain, service name or
address is hard-coded anywhere: zones are admin data, the app address is deployment
configuration, and every example uses the RFC 2606 names (`example.com`, `example.org`,
`example.net`).

### 5.1 App address
- The app (tools, login, editor, admin) has its own address, set in deployment
  configuration (environment variable) because the proxy needs it at boot, for example
  `example.org` or `stuff.example.org`.
- It is served only on the LAN listener and never through the tunnel (section 5.4).
- It may share a registrable domain with site zones and may even be the apex of a zone.
  It can never be a site: if it lies inside a site base, its label is reserved in that
  zone automatically (derived from the configuration at runtime).
- Because sites can then be same-site with the app, the app is hardened instead of relying
  on a domain boundary (section 5.5).

### 5.2 Zones
- **Site zones** are an admin-managed list (**Admin > Zones**), any number per instance. A
  zone is a DNS zone the operator controls, for example `example.com`.
- Optional **sub-level** per zone: one label (for example `web`), so sites are
  `<name>.web.example.com` while the rest of the domain stays untouched. The *site base* is
  `<zone>` or `<sub-level>.<zone>`; the site base itself is never a site.
- Per-zone settings (each has a default; none is a special case in code):

  | Setting | Default | Meaning |
  |---|---|---|
  | Enabled | on | a disabled zone serves nothing and accepts no new sites |
  | Who may host | roles `user` and above | roles allowed to create sites; an optional allow-list of accounts replaces the role rule ("trusted accounts only") |
  | Anonymous hosting | off | anonymous clients may create (internal) sites here |
  | Public sites | off | sites in this zone may be `public`; needs public DNS and the tunnel |
  | Reserved names | empty | extra names for this zone, on top of the built-in and instance-wide lists |
  | Sub-level | none | see above |
  | Interstitial | on | warning page before public sites of this zone (section 16.7) |
  | DNS provider | none | reference to the DNS-01 credentials; the secret stays in deployment configuration |

- Recommendation (documentation, not code): on a zone that already carries other services
  with a login, allow only trusted accounts, no anonymous hosting, and reserve the names of
  those services (cookies those services set for the whole domain reach every site there;
  see section 8.5).
- The first-run setup asks for the first zone, unless the bootstrap configuration
  (section 10.7) already defines one.

### 5.3 Sites, names and visibility
- **Visibility is per site:** `internal` (served only to the LAN) or `public` (served to the
  LAN and through the tunnel). The owner chooses it when creating the site and can change
  it later, within the zone's settings. Public needs an account and a zone with public
  sites enabled; **anonymous sites are always internal** (section 6; open owner question
  SF10).
- Subdomain: randomly generated (10 symbols from a 32-symbol lowercase alphabet
  without `l`, `o`, `0`, `1`: 50 bits of entropy, above the 40-bit minimum) or, for
  accounts, a chosen name subject to the reserved names. Rules, implemented in
  `crates/core/src/subdomain.rs`: 3 to 63 characters of `a-z`, `0-9`, `-`; no
  hyphen at either end; no `--` at positions 3 and 4, so no Punycode (`xn--`)
  labels and no homograph look-alikes; ASCII only. User input is trimmed and
  lowercased before the check, nothing else is transliterated.
- Reserved names, all applied together: the built-in list in `core` (`www`, `app`,
  `admin`, `api`, `mail`, `wpad`, `autoconfig`, `mta-sts`, ...), the instance-wide list
  (admin settings), the zone's own list, and the app address's label when the app lies
  inside that site base.
- A name is unique per site base. Each site is its own origin.

### 5.4 Listeners, split-horizon DNS and the tunnel
- Caddy has two listeners. The **LAN listener** answers the app address and every enabled
  site. The **tunnel listener** is a separate port reachable only by the tunnel connector
  (an internal network, not published on the host); it answers only `public` sites and
  their `edge` routes.
- Whether a request came from the internet is decided by the listener it arrived on,
  **never by a header** (`Host`, `X-Forwarded-*`, `Forwarded`, tunnel headers). On the
  tunnel listener an internal site, the app address and an unknown name get the same
  response, so the tunnel reveals no internal names.
- Deployment pattern (documented, configured outside stuffcloud): LAN DNS resolves the app
  address and `*.<site base>` to the LAN listener; public DNS resolves `*.<site base>` to
  the tunnel, only for zones with public sites. The app address has no public record that
  points to the tunnel, and the tunnel ingress does not route it.
- Certificates: a wildcard per site base via DNS-01 (a sub-level needs its own
  `*.<sub-level>.<zone>`), plus one for the app address. The DNS provider is a Caddy plugin,
  configured per zone (Cloudflare first).

### 5.5 Isolation when the app shares a domain with sites
- Every cookie stuffcloud sets uses the `__Host-` prefix (`Secure`, `Path=/`, host-only):
  app sessions, CSRF, OIDC state and the `edge` site-password cookie. **No cookie carries a
  `Domain=` attribute**; a CI check enforces it (section 14).
- The app reads only its own `__Host-` cookie names and ignores all others, so cookies a
  hosted site sets for the parent domain ("cookie tossing") have no effect.
- Every state-changing request (methods other than `GET`, `HEAD`, `OPTIONS`) with cookie
  authentication needs an `Origin` header equal to the app origin and a valid CSRF token; a
  missing or foreign `Origin`, or a `Sec-Fetch-Site` other than `same-origin` when present,
  is refused. `SameSite=Lax` stays but is not a defence against same-site hosted sites.
- The app sends no CORS headers that allow a site origin.
- A **Public Suffix List** entry for a zone is optional, the operator's choice, and nothing
  depends on it; the project does not file one. The threat model (H-01) describes its
  effect.
- Accepted residual risk: a hosted site with scripts can fill a visitor's cookie jar for
  the parent domain so that their requests to the app fail until the cookies are cleared
  (denial of service, no data leak). Operators who host untrusted scripts on the app's
  domain can restrict that zone to trusted accounts, use a sub-level or another zone, or
  request a PSL entry.

## 6. Users, roles and authentication

Roles
- **Anonymous**: all tools; **internal sites only**, on zones that allow anonymous
  hosting; temporary only; smallest quota; no JavaScript in hosted content.
- **User**: everything anonymous can, plus public sites (where the zone allows them and
  its "who may host" setting includes the account), permanent hosting, JavaScript in
  sites, site management, builder projects, API tokens.
- **Moderator**: handles abuse reports, takedowns, blocklist entries.
- **Admin**: all of the above plus users, quotas, zones, tool toggles, settings.

Authentication
- Local accounts: e-mail + password (Argon2id), **passkeys (WebAuthn)**,
  **TOTP 2FA**, recovery codes.
- **OIDC**, generic, with **authentik as the primary and only tested provider**.
  In the homelab OIDC is the preferred login. Roles come from group claims
  (configurable mapping, e.g. `stuffcloud-admins` -> admin). Local accounts stay
  available; one local break-glass admin is required.
- Sign-up mode (setting): `open`, `invite-only`, or `oidc-only`.
- Sessions: `__Host-` prefixed, HttpOnly, Secure, SameSite=Lax cookies, host-only on the
  app address (no `Domain=` attribute); `Origin` check and CSRF token on every
  state-changing request (section 5.5). API tokens for the CLI and automation (hashed at
  rest, scoped incl. admin scopes, revocable) and service accounts without interactive login
  (section 10.4).
- E-mail is **optional** infrastructure (SMTP configurable). Without SMTP:
  no reminders, no self-service reset; an admin resets instead.

## 7. Toolbox

Each tool is a **module with a manifest** (id, category, i18n keys for name, description
and search keywords, sticker, lazy-loaded entry, `runsIn: client|server`, required browser
capabilities, size budget; ADR 0012). The registry builds navigation, search and routes from the
manifests, and a manifest that breaks the schema fails the build. Admins can disable tools (a
configuration file until the admin toggle of A-09). All v1 tools run **client-side**; nothing is
uploaded: the schema requires `fileContent: "stays-in-browser"` and refuses `runsIn: "server"`.

Library candidates (license must be verified per version before adoption):

| Area | Tool | Candidate libraries |
|---|---|---|
| PDF | merge, split, rotate/delete/reorder pages | pdf-lib, pdf.js |
| PDF | images to PDF, PDF to images | pdf-lib, pdf.js |
| PDF | set/remove password, edit metadata | qpdf (WASM), pdf-lib |
| PDF | compress | **light method first**: re-encode embedded images via pdf.js + pdf-lib, object-stream optimisation via qpdf. Ghostscript WASM (AGPL, very large) only as an optional, lazily loaded extra if the light method falls short; measured in spike T-13 |
| Image | resize, crop, rotate | Canvas, wasm-vips |
| Image | convert PNG/JPG/WebP/AVIF | wasm-vips or jSquash |
| Image | compress, strip EXIF | jSquash, exif libs |
| Image | background removal, pixel-art filter | **U²-Netp** (Apache-2.0 weights, about 5 MB) through ONNX Runtime Web (MIT) as default; **BiRefNet-lite** (MIT, about 114 MB) as an opt-in higher-quality download; own pixelate filter. Not used: `@imgly/background-removal` (GPL/AGPL, commercial dual license), MODNet (conflicting license statements). Exact weights are re-checked at adoption |
| Convert | JSON / YAML / XML | js-yaml, fast-xml-parser |
| Convert | Base64 encode/decode | native |
| Convert | colour picker + formats | colord |
| Convert | unit converter | convert-units or equivalent |
| Parse | CRON expression | cron-parser, cronstrue |
| Parse | user-agent | ua-parser-js v1 (MIT) or uap-core |
| Network | subnet calculator | ipaddr.js / ip-address |
| Network | MAC lookup | bundled IEEE OUI snapshot, updated by a CI job, offline |
| Text | lorem ipsum, UUID (v4/v7), QR code | native / qrcode |
| Text | diff viewer | jsdiff |
| Text | text manipulation (case, sort, dedupe, trim, count, ...) | own small functions |
| Extra | hash/checksum, password generator | WebCrypto |
| Extra | regex tester, URL encode/decode, JWT decoder, timestamp converter | native |
| Extra | Markdown preview, JSON formatter/validator, SQL formatter | marked + DOMPurify, native, sql-formatter |

Rules
- Large WASM/ML assets load only when the tool opens, are self-hosted, and show
  progress. A size budget per tool is documented in its manifest.
- Heavy work runs in Web Workers through the shared worker pool (progress and cancel built in);
  cancelling stops the worker. New tools start from `pnpm new-tool <id>`.
- Files never leave the browser for client-side tools. The UI says so.
- Tools may work offline once loaded (service-worker caching is optional).

## 8. Hosting engine

### 8.1 Input modes
1. **Text upload**: plain text with syntax highlighting; Markdown rendered through
   a sanitiser (no raw HTML); **multiple files per paste**; raw link per file.
   Editing is selectable per paste: *anyone with the edit link* or *only the
   logged-in creator*. Anonymous pastes use a secret edit token shown once.
2. **Code upload**: individual files or folders by drag and drop (the browser
   bundles them); CLI/API deploy (`stuffcloud deploy ./dist`). `index.html`
   required. Server-side hardening: path normalisation, no symlinks, size and
   file-count limits, MIME allow/deny list. Every file name passes `SafeRelPath`
   (`crates/core/src/path.rs`) before anything touches the disk: relative,
   `/`-separated, NFC-normalised; no `.`/`..`/empty components, no hidden
   components (this also keeps `.well-known/` and thus ACME HTTP-01 out of user
   sites), no backslashes or Windows-reserved characters, no control, invisible or
   bidirectional characters, no Windows device names, at most 1024 bytes, 255 per
   component and 32 levels. Archive entries that are links, devices or duplicates
   are refused by the unpacker.
3. **Drag-and-drop builder**: GrapesJS (BSD-3), **multi-page** sites; the project
   is saved per account and re-editable; publishing exports a static site.
4. **Templates**: link-in-bio / business card, invitation / event page,
   documentation page rendered from Markdown, under-construction pixel-art page.
   Templates are plain static sites with a small set of replaceable fields.

### 8.2 Lifetime
- Presets: 1 hour, 1 day, 7 days, 30 days. Custom date up to a configurable maximum.
- **Permanent**: accounts only.
- Extendable; with SMTP, a reminder is sent before expiry.
- Expired sites are unpublished immediately and deleted after a short grace period.

### 8.3 Access options per site
- Zone choice (within the zone's "who may host" setting) and visibility per site
  (`internal` or `public`); public needs an account and a zone with public sites enabled
  (section 5.3).
- Optional password (server-checked by `edge`, hashed; short-lived per-site
  cookie).
- Unlisted by default: unguessable name, `X-Robots-Tag: noindex`.
- **Burn after reading** (view once), mainly for text; enforced by `edge`.

### 8.4 Quotas (admin-adjustable defaults)
| | Anonymous | Account |
|---|---|---|
| Size per site | 10 MB | 200 MB |
| Total storage | n/a (temporary only) | 5 GB |
| Number of sites | rate-limited | 100 (extendable per user) |
| JavaScript in site | no | yes |
| Lifetime | temporary only | up to permanent |

Rate limits per IP (in memory, not persisted) and per account.

### 8.5 Sandbox and isolation (static-only)
- No server-side execution of user content. Files are served as static by Caddy.
- Each site has its own origin. Sites may share a registrable domain with the app and
  with each other; the app is protected by the cookie, `Origin` and CSRF rules of
  section 5.5, not by a domain boundary. Cookies that other services set for a whole
  zone (`Domain=.<zone>`) reach every site on it, which is why zones with such services
  should allow only trusted accounts (section 5.2).
- Response headers on sites: strict `Content-Security-Policy` (anonymous: no
  scripts; accounts: scripts allowed, with `form-action` and `frame-ancestors`
  restricted by default), `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Cross-Origin-Opener-Policy`; no cookies set by the platform except the optional
  site-password cookie.
- User-provided HTML is never rendered inside the app origin; previews use a
  sandboxed iframe from the site origin.
- Executables and dangerous types are refused or served as download only.
- Phishing mitigation: interstitial before public sites (per zone, on by default), a
  report button on every site, fast takedown.

### 8.6 Abuse handling
- Report button on every hosted site (rate-limited, no login needed); the report
  is received by `edge` and queued for the moderators in `app`.
- Moderator queue; actions: unpublish, delete, ban user, block hash/domain.
- Blocklist (content hashes, patterns) checked at publish time.
- Abuse contact and legal pages are configuration for public instances.
- Optional scanner integration is a later phase.

## 9. Data model (sketch)

`users` (login name, kind `person`/`service`), `credentials` (password/passkey/TOTP), `oidc_identities`, `sessions`,
`api_tokens` (owner, name, scopes, expiry), `sites` (id, owner?, zone, name, kind, expires_at, visibility,
password_hash?, burn_after_read, size_bytes, status), `site_files`, `pastes`
(edit mode, token hash), `builder_projects`, `reports`, `blocklist`, `zones` (domain,
sub-level?, enabled, hosting roles, anonymous allowed, public allowed, interstitial,
DNS provider reference), `zone_reserved_names`, `zone_hosters` (allow-list of accounts),
`settings`, `audit_log`. Every configurable row has a natural key and an ETag (section
10.2). Versioned migrations; SQLite WAL; a `StorageBackend`
interface (`put/get/delete/list/usage`).

## 10. API and CLI

Decided in [ADR 0010](adr/0010-api-first-and-configuration-as-code.md) (issue #116, owner
answer to SF9): stuffcloud is fully operable without the web UI, and the whole instance
configuration can be managed as code.

### 10.1 API-first
- REST + JSON under `/api/v1`. The OpenAPI document is generated from the Rust handlers
  (`utoipa`); the frontend's typed client is generated from it
  (`openapi-typescript` + `openapi-fetch`), and CI regenerates both and fails on a
  diff. Request bodies are deserialised into strict types
  (`deny_unknown_fields`) and then parsed into `core` types at the boundary.
- **No UI-only features.** The web UI uses only the generated client. Every action the UI
  offers on the instance has an API endpoint and a CLI command, added in the same pull
  request with tests (CLAUDE.md, "API-first"). Exceptions are only steps that need a browser
  by nature (WebAuthn ceremony, OIDC redirect); the CLI covers the actions around them.
  Client-side tools are not instance operations; their admin toggles are settings.
- `/api/v1` changes only additively; a breaking change needs `/api/v2`. Once a release
  contains the API, CI fails on a breaking change against the last release's OpenAPI
  document.
- From the internet only the tunnel listener is reachable: delivery of public sites
  (Caddy) and their `edge` routes (section 4). The API lives on the app address (LAN
  listener only), so automation runs from the LAN.

### 10.2 Resources and write semantics
- Every configurable object is a resource with a stable natural key: zone by domain, site by
  zone and name, user by login name, role by name (the four roles are read-only), OIDC group
  mapping by group, token by owner and name, blocklist entry by hash or pattern, settings
  groups by name (`signup`, `oidc`, `smtp`, `quotas`, `tools`, `reserved-names`, `legal`).
  Keys are immutable (a rename is an explicit action); internal IDs are returned but never
  needed.
- `PUT /api/v1/<collection>/<key>` creates or replaces with the full writable shape and is
  idempotent; the response says `created`, `updated` or `unchanged`, and an unchanged write
  changes nothing, not even a timestamp.
- `GET` returns exactly the writable shape plus a read-only `meta` object (ID, ETag,
  timestamps, derived values); `PUT` ignores `meta` and refuses any other unknown field.
- Actions that are not state (invite, reset, extend, rotate, take down, handle a report) are
  `POST` actions on the resource. `DELETE` of a missing resource is `404`.
- Every resource has a strong `ETag`; `PUT` and `DELETE` accept `If-Match` (`412` on a
  mismatch) and `If-None-Match: *` (create only). The web UI always sends `If-Match`.
- Every write accepts `?dry_run=true`: authentication, authorisation and validation run, the
  response carries a field-level diff, nothing changes.
- Errors are RFC 9457 problem details with a stable `type` and every invalid field at once
  (JSON Pointer per field).
- Secrets are never values in the API: settings that need one (OIDC client secret, SMTP
  password, DNS-01 credentials) hold a reference to deployment configuration (an environment
  variable or secret file name). Token secrets are the only secrets the API returns, once.
  Whether write-only secret values are added later is owner question SF12.

### 10.3 Zones and settings as resources
- A zone resource carries the policy of section 5.2: `domain` (key), `sub_level`, `enabled`,
  `hosting_roles`, `hosting_accounts`, `anonymous_hosting`, `public_sites`, `reserved_names`,
  `interstitial`, `dns_provider` (a reference). The app address's label inside a site base is
  derived and shown in `meta`.
- A write that would strand sites is refused with a problem detail listing them, so a plan
  shows it first: changing `sub_level` of a zone with sites, switching `public_sites` off
  while public sites exist, reserving a name in use. Disabling a zone is allowed.
- A site's visibility is a field of the site resource and passes the same `core` policy as
  in the UI; anonymous sites stay internal (section 5.3).
- Instance-wide settings (sign-up mode, OIDC, SMTP, quota defaults, tool toggles, reserved
  names, legal and abuse contact) are the settings groups of section 10.2.

### 10.4 Tokens and service accounts
- Token scopes are `<area>:<read|write>`: `sites`, `account`, `tokens`, and the admin areas
  `admin:zones`, `admin:users`, `admin:settings`, `admin:blocklist`, `admin:tokens`,
  `moderation`.
- What a token may do is the intersection of its scopes and its owner's role; it never
  exceeds the owner, and admin scopes stop working when the owner loses the admin role. A
  token can create tokens only with a subset of its own scopes. Admin-scoped tokens have an
  expiry (maximum set by the admin).
- **Service accounts** (user kind `service`) have no password, passkey or interactive login,
  only tokens; automation uses them. No automation path needs a browser login.

### 10.5 CLI
- The `cli` crate: one static binary per platform, using the same `core` types (and the same
  path checks) as the server. It covers every API operation: `deploy`, `site
  list|get|put|rm|extend`, `token`, `account`, and `admin
  zone|user|role|token|settings|blocklist ...`. A test fails for an OpenAPI operation without
  a CLI command (listed exceptions with a reason).
- `--output json|yaml|table`, `--dry-run` for writes; reads `STUFFCLOUD_URL`,
  `STUFFCLOUD_TOKEN` or `STUFFCLOUD_TOKEN_FILE`, and an optional CA file.
- Exit codes: `0` success, `1` error, `2` changes present (with `--detailed-exitcode`), `3`
  precondition failed (changed since read), `4` usage error.

### 10.6 Declarative configuration
- A configuration file (`stuffcloud.yaml`, YAML or JSON, with a `version` field) lists the
  desired resources in the API's writable shape; its JSON Schema is generated from the same
  types and published with each release. It never contains secrets or passwords.
- `stuffcloud validate -f` checks it offline; `stuffcloud plan -f` prints the diff from
  server-side dry runs and changes nothing; `stuffcloud apply -f` writes in dependency order,
  each `PUT` with the `If-Match` of its own read (a concurrent change stops the run with exit
  code `3`). A second `apply` reports nothing changed. A failed run stops at the first error
  and is safe to re-run. Resources not in the file are left alone unless `--prune` is given;
  the plan shows every deletion.

```yaml
version: 1
settings:
  signup: { mode: invite-only }
zones:
  - domain: example.com
    sub_level: web
    hosting_roles: [user, moderator, admin]
    anonymous_hosting: false
    public_sites: true
    reserved_names: [auth, vault]
    dns_provider: example-dns
```

### 10.7 Bootstrap
- The app address and all secrets come from environment variables, each also as a `_FILE`
  variant (section 11).
- On the first start with an empty database the app creates the first admin (the local
  break-glass admin, section 6) from `STUFFCLOUD_BOOTSTRAP_ADMIN_*`, optionally a service
  account with an admin-scoped token whose secret the operator supplies in a file (stored
  hashed), and applies an optional bootstrap configuration file once. Later starts ignore
  these inputs with a log line.
- The first-run setup in the UI uses the same API and is never the only path.

### 10.8 Ansible and OpenTofu
- An own Ansible collection (#119, when the API is stable) and an own OpenTofu provider (#120,
  only once the rest of the stack and the API are finished and stable), both on the public
  API only. Their repository location is decided when each is built; a separate repository
  is not assumed upfront.
- Until then Ansible uses the CLI (`apply`, `plan` for check mode) or plain HTTP against the
  idempotent `PUT`s; OpenTofu can use a generic REST provider.
- The operator's own deployment code stays in the operator's infrastructure repository.

## 11. Operations

- Docker Compose; configuration through environment variables; secrets from env or
  files (`_FILE` variants), never in the repo and never through the API; bootstrap without
  clicks (section 10.7).
- Containers: one static binary per service on a `distroless` (or `scratch`)
  base, no shell, non-root user, read-only root filesystem, all capabilities
  dropped, `no-new-privileges`; only the data directory is writable, and `edge`
  gets the database read-only apart from the tables it writes.
- Backups: a documented data directory (SQLite + site files) picked up by the
  homelab Restic job; temporary sites may be excluded. Built-in **per-user export**
  (ZIP of sites and account data) and account deletion.
- Observability: `/healthz`, Prometheus metrics, structured logs **without IP
  addresses**, optional OpenTelemetry tracing, **Wazuh integration** via log
  decoders/rules for auth failures, takedowns and rate-limit hits.
- Upgrades: versioned migrations, release notes in `CHANGELOG.md`.

## 12. Design and UX

- Visual reference and mockups: `docs/design/` (decisions, tokens, page list).
- Reference: screenshots in `docs/reference-images/` (local only, git-ignored:
  third-party material). Observed traits: near-black background (about `#101012`),
  thin grid lines, large white type, flat saturated accent blocks (orange, red,
  yellow), pixel-art stickers and small animals, tiny scene animations.
- **Dark only.** Black background, white text; colour comes mainly from pixel-art
  animals, stickers and small animations, not from large UI chrome.
- Typography: **pixel font for headings**, **monospace** for UI/code,
  **sans-serif for long text**; all fonts self-hosted (no external font requests).
- **One main mascot** (Stuffy, a pink pixel axolotl) plus **one sticker per tool**,
  and a small cast of extra animals for easter eggs; original pixel art under
  GPL-3.0-or-later, idle animations of two poses (ADR 0008). The mascot never speaks (no
  speech bubbles), and pages carry no filler copy.
- Palette: pink and violet for surfaces and accents; stickers keep their own bright
  colours so categories stay recognisable. Grid layout with thin cell lines.
  Tokens, page list and component decisions are in `docs/design/README.md`.
- Seasonal decorations (winter, autumn, Christmas with Advent, Easter, Halloween, harvest
  festival and special days such as New Year, Valentine's Day, carnival, Women's Day, Earth
  Day, Europe Day, Pride, Unity Day, Nicholas Day and Human Rights Day; none in spring and
  summer) are a purely visual layer chosen by date; the admin can set *auto*, a fixed set
  or *off*, visitors can switch it off, and it never blocks
  content (details in `docs/design/README.md`).
- QR codes offer two styles, *raw* and *stuffcloud* (violet modules, magenta
  finder squares, mascot in the centre); the stuffcloud style needs error-correction
  level H and an automatic scan test, falling back to raw.
- Destructive actions (delete site) need a typed confirmation; the 2FA code field is
  shown as `000-000` over one real input.
- Accessibility: WCAG 2.2 AA contrast, full keyboard use, visible focus,
  `prefers-reduced-motion` disables all animation, decorative mascots are
  `aria-hidden`, touch targets >= 44 px. The checks (axe on every state in CI, keyboard map,
  focus and live-region rules) are in [`docs/ACCESSIBILITY.md`](ACCESSIBILITY.md).
- Performance: mascot animations are CSS `transform` keyframes with `steps()` on the
  delivered SVG art (no canvas loop, no script per frame), drawn at integer scales
  with `image-rendering: pixelated`, paused when off-screen or when the tab is hidden
  (measurements and alternatives: [ADR 0008](adr/0008-pixel-art-animation-runtime.md)).
- Responsive from phone to desktop.

## 13. Internationalisation and privacy

- German and English from the start; default from the browser language
  (`navigator.languages`), a manual switch that applies at once without a reload and is
  remembered in this browser (`localStorage`, no cookie); message catalogues in the repo with
  typed keys, `{name}` placeholders, CLDR plural forms and `Intl` number and date formatting;
  CI fails on a missing, unused or inconsistent key and on literal text in the app shell
  ([ADR 0011](adr/0011-spa-routing-and-i18n.md)); code and docs in English.
- App shell: header with the tool navigation, search (Ctrl+K / Cmd+K) and the language switch,
  footer, skip link; path URLs with lazy-loaded routes and deep links per tool (the web server
  falls back to `index.html`); focus moves to the page heading and the title is announced on
  every navigation; 404, error and offline states (ADR 0011).
- No third-party trackers or analytics; no IP storage; only technically necessary
  cookies (no consent banner); privacy-policy template included; data export and
  deletion on request.

## 14. Quality, CI and testing

Principle: tests are part of the security design, not an afterthought, and they
are run more than seems necessary from the first line of code. A check is never
weakened to make a PR green; a lowered threshold needs a reason in the PR.

Required checks (ruleset): `build`, `workflow-lint`, `gitleaks`, `claude-review`.
`build` is an aggregate job in `ci.yml` that is green only when every job of the
workflow succeeded, so jobs can be added without touching the ruleset. CodeQL runs
as one of those jobs (advanced setup, `codeql.yml`, not the default setup in the
repo settings).

On every PR and push (`ci.yml`):

| Job | What it enforces |
|---|---|
| `fmt` | `rustfmt` on the workspace and the fuzz targets |
| `clippy` | pedantic lint set from `Cargo.toml`, every warning an error: `unsafe` forbidden, no `unwrap`/`expect`/`panic`/indexing/unchecked arithmetic in non-test code |
| `test` | unit, property (proptest, 4096 cases), regression and doc tests, in debug and release; `--locked` everywhere |
| `docs` | rustdoc without warnings or broken links |
| `coverage` | `cargo-llvm-cov`, fails below 95 % of lines and of regions |
| `mutants` | `cargo-mutants` on the lines the PR changes (all mutants on `main`); a surviving mutant fails |
| `fuzz` | every cargo-fuzz target for 2 minutes with AddressSanitizer, starting from the committed seeds and the nightly corpus |
| `e2e` | Playwright in Chromium and Firefox against the built app: app shell, tool registry, worker pool in a real browser, and the privacy test (no request carries file content, no request leaves the own origin or is anything but a `GET` of an own asset); no retries; axe joins with T-05 |
| `codeql` | CodeQL `security-extended` for Rust, Python and the workflows (JavaScript/TypeScript with `web/`); fails on any result, also weekly on `main` |
| `supply-chain` | `cargo-deny`: RustSec advisories (incl. unmaintained, unsound, yanked), licenses (section 3), crates.io only, no wildcard versions |
| `repo-checks` | label-script tests, design PDF is current |

Nightly and on demand (`deep-tests.yml`, not required, failures handled like a red
PR): fuzzing for 45 minutes per target that grows and minimises the shared
corpus, the full mutation run, Miri over the whole test suite, property tests with
500 000 cases, a fresh advisory check, and tests plus lints on the beta toolchain.

Test layers and what each must cover:
- **Unit tests** next to the code: every rule, every boundary on both sides
  (exactly at the limit and one past it), every error variant and its message.
- **Property tests** (`tests/properties.rs`): invariants for all inputs, for
  example "an accepted path joined onto the site root never leaves it" and
  "parsing is idempotent".
- **Regression corpus** (`tests/regression.rs`): known attack inputs (traversal,
  UNC and drive paths, NUL truncation, bidi spoofing, homographs, device names).
  Every bug and every fuzz finding becomes an entry here and a seed in
  `fuzz/seeds/`.
- **Fuzzing**: one target per parser of untrusted input (paths, subdomains, and
  later archive entries, multipart headers, Markdown, cookies, tokens, OpenAPI
  request bodies), each asserting invariants, not only "does not panic".
- **Mutation testing**: proves the tests check behaviour rather than just
  execute lines.
- **API integration tests** (from phase 2): every route against every role,
  including the negative cases (a user may not touch another user's site, an
  anonymous upload may not create a public site, an account outside a zone's
  "who may host" setting may not host there, a moderator may not change settings);
  authentication flows (password, passkey, TOTP, OIDC, recovery); rate limits; session
  and CSRF rules: every `Set-Cookie` of every route has the `__Host-` prefix and no
  `Domain=` attribute, every state-changing route refuses a missing or foreign `Origin`
  and a missing CSRF token, and cookies tossed for the parent domain are ignored.
- **Cookie check** (with the first cookie code, A-02): a CI check fails on any cookie
  with a `Domain=` attribute in `app` and `edge`, in addition to the per-route tests.
- **Listener tests** (hosting): on the tunnel listener the app address, internal sites
  and unknown names give the same response; forged `Host`, `X-Forwarded-*` and tunnel
  headers on the LAN listener never make a request count as coming from the internet.
- **Edge tests**: the public routes in isolation, with hostile `Host`, cookie and
  header combinations; the response headers (CSP, `nosniff`, COOP, `noindex`)
  asserted for every kind of hosted content.
- **Archive tests**: crafted ZIP/TAR files (zip slip, symlinks, hard links,
  duplicate and case-colliding names, absolute names, zip bombs, nested
  archives, files that exceed quota in the middle of extraction).
- **Frontend** (from phase 1): typecheck, unit tests, Playwright e2e for every
  tool, axe accessibility checks (zero violations of the WCAG 2.2 A/AA and best-practice rule
  sets in both browsers, a keyboard-only walk of every tool, a reduced-motion test), and a test
  that no tool sends a request with file content. The e2e job runs against the production build plus test-only tools
  (`web/apps/web/e2e/`); every e2e test fails at its end when the page sent anything
  but a `GET` of an own asset, and a test-only tool that leaks on purpose proves the
  check can fail. Visual checks are smoke screenshots attached to the report, never
  pixel comparisons.
- **Container**: the image runs as non-root with a read-only root filesystem;
  an image scan runs before publishing (phase 3).

Dependabot covers GitHub Actions and Cargo (workspace and fuzz); npm and Docker
are enabled with the frontend and the images. The Rust toolchain
(`rust-toolchain.toml`) and the pinned nightly in the workflows are bumped by
hand, together with `rust-version` in `Cargo.toml`.

Conventional commits, feature branches, PR review (existing repo rules).

## 15. Phases

1. **Tools + design**: app shell, design system, tool registry, all v1 tools,
   i18n, a11y baseline, CI test setup. No accounts, no hosting. The Rust
   workspace starts here with `crates/core` (path and subdomain rules) and the
   full test pipeline of section 14, so the pipeline exists before the code that
   needs it most.
2. **Accounts**: local auth, passkeys, TOTP, OIDC (authentik), roles, admin basics
   (`crates/db`, `crates/app`).
3. **Hosting**: zones and domains, text and code upload, expiry, passwords, burn,
   quotas, reports/takedown (`crates/edge`), CLI (`crates/cli`).
4. **Builder and templates**: multi-page GrapesJS, saved projects, four templates.

Hosting ships after auth and quotas on purpose: it is the security-critical part.

## 16. Decisions on the former open questions

1. **Mascot art:** original pixel art (Stuffy plus a cast of extra animals), licensed
   GPL-3.0-or-later like the repo. Extra animals and easter eggs are tracked in
   `docs/design/`.
2. **Root domains per zone:** entered by the operator in the admin settings (Admin >
   Zones, issue H-02), any number of zones per instance, nothing hard-coded; the DNS
   provider is Cloudflare first. The first-run setup asks for the first zone.
   Changed 2026-11-16 (SF5, ADR 0009): visibility is per site, zones carry their own
   hosting policy, and the app may share a domain with zones (section 5).
3. **PDF compression:** light method first, Ghostscript only as optional extra
   (section 7).
4. **Background removal:** U²-Netp by default, BiRefNet-lite opt-in (section 7).
5. **CLI distribution:** standalone binaries (Linux, Windows, macOS) attached to
   releases; no npm package (changed in draft 0.3, the CLI is Rust now).
6. **Retention:** audit log 12 months; handled reports 6 months after handling;
   unhandled reports until handled; no IP addresses in either.
7. **Public-site interstitial warning:** on by default, the admin can switch it off per
   zone (ADR 0009).
8. **Reference screenshots:** stay local and git-ignored (third-party material).
9. **Backend language (draft 0.3, 2026-11-14):** Rust (`axum`, `tokio`, SQLite)
   instead of Node.js/Fastify, because the instance is exposed and security and
   performance are the top priorities (rationale in section 4). The frontend stays
   Svelte/TypeScript with a client generated from OpenAPI. Considered and rejected:
   a Rust/WASM frontend (Leptos, Dioxus), because the tools depend on JavaScript
   and WASM libraries and the bundle-size budget; server-rendered pages for admin
   and hosting, because it would split the UI into two systems.
10. **Public surface (draft 0.3):** the server logic that public sites need
    (password, burn-after-reading, report) runs in the separate `edge` process,
    not in `app`, so the code reachable from the internet stays small and
    separately testable.
11. **Mascot animation runtime (2026-11-16):** CSS `transform` keyframes with `steps()` on
    the SVG art, paused off-screen and in hidden tabs, still pose under
    `prefers-reduced-motion`; canvas and background-position sprite sheets were measured
    and rejected ([ADR 0008](adr/0008-pixel-art-animation-runtime.md)).
12. **Zone model (2026-11-16, SF5):** any number of zones, each usable on the LAN and from
    the internet; visibility per site; per-zone hosting policy (who may host, anonymous,
    public sites, reserved names, sub-level, interstitial); the app on its own address,
    possibly on a domain shared with sites, protected by `__Host-` cookies without
    `Domain=`, an `Origin` check and CSRF tokens; internet origin decided by a separate
    tunnel listener, never by a header; a PSL entry optional
    ([ADR 0009](adr/0009-zone-model-and-shared-domain-isolation.md)).
13. **API-first and configuration as code (2026-11-16, #116, SF9):** no UI-only features;
    resources with natural keys, idempotent `PUT`, `ETag`/`If-Match`, dry-run; secrets only as
    references; scoped tokens incl. admin scopes and service accounts; full CLI parity with
    `validate`/`plan`/`apply -f`; bootstrap from environment and files; own Ansible collection
    and OpenTofu provider later, location decided when built (section 10,
    [ADR 0010](adr/0010-api-first-and-configuration-as-code.md)).

Architecture decision records for decisions 9, 10, 11, 12 and 13 and for the choices in sections 4 to 8
and 14 are in [`docs/adr/`](adr/README.md).
