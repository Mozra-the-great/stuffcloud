# stuffcloud — Specification

Status: draft 0.2 (2026-11-05). Decisions below come from the requirements
catalogue and the owner's answers; items still open are listed in
[Decisions](#16-decisions-on-the-former-open-questions).

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
  `docs/THIRD-PARTY.md` (generated in CI later). Candidates in section 7 are
  **not yet verified**; check the exact version before use. Watch for licenses
  that changed between major versions (e.g. `ua-parser-js` v2 is AGPL-3.0, v1 is
  MIT) and for copyleft WASM builds (e.g. Ghostscript is AGPL).
- Pixel-art mascots, stickers and easter eggs are original work and are licensed
  under **GPL-3.0-or-later** like the code; no third-party brand art (see section 12).

## 4. Architecture overview

```
 LAN client ──► app.<internal-domain>  ──► Caddy ──► stuffcloud API (Fastify, SQLite)
                                                  └► static frontend (Svelte/Vite)
 LAN client ──► <random>.<internal-zone> ─────────► Caddy file_server (sites)
 Internet   ──► <random>.<public-zone> ── cloudflared ─► Caddy file_server (public sites only)
```

Components
- **Frontend**: Svelte + Vite single-page app, static build, tools lazy-loaded.
- **API**: Node.js + TypeScript (strict, no `any`) with Fastify. SQLite (WAL) for
  metadata. Storage behind an interface; default backend is the local filesystem,
  an S3-compatible backend can be added without API changes.
- **Reverse proxy**: Caddy serves the app and all hosted sites directly from disk,
  routing by `Host` header. Wildcard certificates per zone via DNS-01.
- **cloudflared**: exposes **only** the public zone(s). The app zone is never
  routed through the tunnel.
- **Jobs**: in-process scheduler for expiry cleanup, reminders, reports.
- **Deployment**: Docker Compose (app, Caddy, cloudflared) in an LXC/VM on Proxmox;
  image published to GHCR; Ansible role in `homelab-infra` later.

Stack rationale: one language end to end, small runtime, and most tool libraries
are JavaScript/WASM and run in the browser anyway.

## 5. Network zones, domains and addressing

- **App zone**: LAN only (for example `stuff.<internal-domain>`). Contains tools,
  login, editor, admin. Not reachable from the internet.
- **Site zones**: an admin-managed list of root domains. No domain is hard-coded:
  every operator enters their own, any number of zones, each with its own visibility
  and DNS provider settings, in the admin UI (**Admin > Zones**). Only the app zone's
  address is deployment configuration (environment variable), because the proxy needs
  it at boot. Each zone has a
  *visibility*: `internal` or `public`. A hosted site chooses a zone, so
  visibility follows the zone.
- Subdomain: randomly generated (>= 8 chars from a lowercase base32-like alphabet,
  about 40 bits of entropy minimum) or, for accounts, a chosen name subject to a
  reserved-names list (`www`, `app`, `admin`, `api`, `mail`, ...).
- Hosted sites live on **different registrable domains than the app** so that
  cookies and same-origin access can never leak between them (like
  `githubusercontent.com`). Each site is its own origin.
- Wildcard certificates per zone via DNS-01; the DNS provider is a Caddy plugin,
  configured per zone (Cloudflare first).
- Public-zone requests arrive through cloudflared; internal zones resolve through
  internal DNS (wildcard record).

## 6. Users, roles and authentication

Roles
- **Anonymous**: all tools; hosting to **internal zones only**; temporary only;
  smallest quota; no JavaScript in hosted content.
- **User**: everything anonymous can, plus public zones, permanent hosting,
  JavaScript in sites, site management, builder projects, API tokens.
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
- Sessions: HttpOnly, Secure, SameSite=Lax cookies scoped to the app zone only.
  API tokens for the CLI (hashed at rest, scoped, revocable).
- E-mail is **optional** infrastructure (SMTP configurable). Without SMTP:
  no reminders, no self-service reset; an admin resets instead.

## 7. Toolbox

Each tool is a **module with a manifest** (id, name, category, icon/sticker,
lazy-loaded entry, `runsIn: client|server`, required libs, a11y notes). Admins can
disable tools. All v1 tools run **client-side**; nothing is uploaded.

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
   file-count limits, MIME allow/deny list.
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
- Zone choice (internal vs public); public needs an account.
- Optional password (server-checked, hashed; short-lived per-site cookie).
- Unlisted by default: unguessable name, `X-Robots-Tag: noindex`.
- **Burn after reading** (view once), mainly for text.

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
- Each site has its own origin on a registrable domain separate from the app.
- Response headers on sites: strict `Content-Security-Policy` (anonymous: no
  scripts; accounts: scripts allowed, with `form-action` and `frame-ancestors`
  restricted by default), `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Cross-Origin-Opener-Policy`; no cookies set by the platform except the optional
  site-password cookie.
- User-provided HTML is never rendered inside the app origin; previews use a
  sandboxed iframe from the site origin.
- Executables and dangerous types are refused or served as download only.
- Phishing mitigation: optional interstitial on public zones, a report button on
  every site, fast takedown.

### 8.6 Abuse handling
- Report button on every hosted site (rate-limited, no login needed).
- Moderator queue; actions: unpublish, delete, ban user, block hash/domain.
- Blocklist (content hashes, patterns) checked at publish time.
- Abuse contact and legal pages are configuration for public instances.
- Optional scanner integration is a later phase.

## 9. Data model (sketch)

`users`, `credentials` (password/passkey/TOTP), `oidc_identities`, `sessions`,
`api_tokens`, `sites` (id, owner?, zone, name, kind, expires_at, visibility,
password_hash?, burn_after_read, size_bytes, status), `site_files`, `pastes`
(edit mode, token hash), `builder_projects`, `reports`, `blocklist`, `zones`,
`settings`, `audit_log`. Versioned migrations; SQLite WAL; a `StorageBackend`
interface (`put/get/delete/list/usage`).

## 10. API and CLI

- REST + JSON, OpenAPI document generated from route schemas (validation at the
  edge; no `any`).
- Token auth for the CLI: `stuffcloud deploy`, `list`, `rm`, `extend`. The CLI is
  a separate package in the repo.
- Only site delivery is reachable from the internet; everything else is on the app
  zone (LAN).

## 11. Operations

- Docker Compose; configuration through environment variables; secrets from env or
  files, never in the repo.
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
  GPL-3.0-or-later, idle animations of a few frames. The mascot never speaks (no
  speech bubbles), and pages carry no filler copy.
- Palette: pink and violet for surfaces and accents; stickers keep their own bright
  colours so categories stay recognisable. Grid layout with thin cell lines.
  Tokens, page list and component decisions are in `docs/design/README.md`.
- Seasonal decorations (winter, Christmas, Easter, autumn, Halloween, harvest
  festival; none in spring and summer) are a purely visual layer chosen by date; the admin can set
  *auto*, a fixed season or *off*, visitors can switch it off, and it never blocks
  content (details in `docs/design/README.md`).
- QR codes offer two styles, *raw* and *stuffcloud* (violet modules, magenta
  finder squares, mascot in the centre); the stuffcloud style needs error-correction
  level H and an automatic scan test, falling back to raw.
- Destructive actions (delete site) need a typed confirmation; the 2FA code field is
  shown as `000-000` over one real input.
- Accessibility: WCAG 2.2 AA contrast, full keyboard use, visible focus,
  `prefers-reduced-motion` disables all animation, decorative mascots are
  `aria-hidden`, touch targets >= 44 px.
- Performance: sprite-sheet or small canvas animations, paused when off-screen or
  when the tab is hidden.
- Responsive from phone to desktop.

## 13. Internationalisation and privacy

- German and English from the start; default from the browser language; message
  catalogues in the repo; code and docs in English.
- No third-party trackers or analytics; no IP storage; only technically necessary
  cookies (no consent banner); privacy-policy template included; data export and
  deletion on request.

## 14. Quality, CI and testing

- Existing gates stay: `build`, `workflow-lint`, `gitleaks`, `claude-review`.
- `build` will run lint, strict typecheck, unit tests and later e2e.
- Test layers: unit (tool logic, quota/expiry, path hardening), API integration
  (auth flows, roles, zones), e2e with Playwright (tools, hosting, builder),
  accessibility checks (axe), header/CSP tests for hosted sites, fuzz-style tests
  for upload paths.
- CodeQL default setup is enabled as soon as real code exists.
- Dependabot ecosystems (npm, docker) are enabled with the stack.
- Conventional commits, feature branches, PR review (existing repo rules).

## 15. Phases

1. **Tools + design**: app shell, design system, tool registry, all v1 tools,
   i18n, a11y baseline, CI test setup. No accounts, no hosting.
2. **Accounts**: local auth, passkeys, TOTP, OIDC (authentik), roles, admin basics.
3. **Hosting**: zones and domains, text and code upload, expiry, passwords, burn,
   quotas, reports/takedown, CLI.
4. **Builder and templates**: multi-page GrapesJS, saved projects, four templates.

Hosting ships after auth and quotas on purpose: it is the security-critical part.

## 16. Decisions on the former open questions

1. **Mascot art:** original pixel art (Stuffy plus a cast of extra animals), licensed
   GPL-3.0-or-later like the repo. Extra animals and easter eggs are tracked in
   `docs/design/`.
2. **Root domains per zone:** entered by the operator in the admin settings (Admin >
   Zones, issue H-02), any number of zones per instance, nothing hard-coded; the DNS
   provider is Cloudflare first. The first-run setup asks for the first zone.
3. **PDF compression:** light method first, Ghostscript only as optional extra
   (section 7).
4. **Background removal:** U²-Netp by default, BiRefNet-lite opt-in (section 7).
5. **CLI distribution:** npm package first; standalone binaries attached to releases
   later.
6. **Retention:** audit log 12 months; handled reports 6 months after handling;
   unhandled reports until handled; no IP addresses in either.
7. **Public-zone interstitial warning:** on by default, admin can switch it off.
8. **Reference screenshots:** stay local and git-ignored (third-party material).
