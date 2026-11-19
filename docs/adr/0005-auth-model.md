# ADR 0005: Auth model: local accounts, passkeys, TOTP and OIDC

- Status: Partly superseded by [ADR 0009](0009-zone-model-and-shared-domain-isolation.md)
  (the zone wording of decisions 1 and 6 and the second consequence: anonymous hosting is
  per site and per zone, session cookies are `__Host-` cookies with `Origin` and CSRF checks
  because sites may share the app's registrable domain; the other decisions stay accepted).
  Sessions, CSRF and the data model: see "Addendum: sessions, CSRF and the auth data model"
- Date: 2026-11-05 (SPEC draft 0.2; carried into draft 0.3 on 2026-11-14)
- Decided in: [SPEC 6](../SPEC.md#6-users-roles-and-authentication)

## Context

The app zone (LAN only) holds accounts, uploads, moderation and admin functions. The primary
deployment is a homelab with an identity provider (authentik) in front of other services, but
stuffcloud must also work without one, and must not lock the operator out if the provider is
down. Anonymous use of tools and of restricted hosting is a product requirement, so the
system has four roles from the start.

## Decision

1. **Roles:** anonymous, user, moderator, admin, with the capabilities in
   [SPEC 6](../SPEC.md#6-users-roles-and-authentication) (anonymous: all tools, internal
   zones, temporary hosting, no JavaScript in sites; user: public zones, permanent hosting,
   JavaScript, API tokens; moderator: reports and takedowns; admin: users, quotas, zones,
   settings).
2. **Local accounts** with e-mail and password (Argon2id), **passkeys (WebAuthn)**, **TOTP 2FA**
   and recovery codes.
3. **Generic OIDC with authentik as the primary and only tested provider.** In the homelab OIDC
   is the preferred login. Roles come from group claims through a configurable mapping (for
   example `stuffcloud-admins` to admin).
4. **Local accounts always remain available, and one local break-glass admin is required,**
   so the instance does not depend on the identity provider.
5. **Sign-up mode** is a setting: `open`, `invite-only` or `oidc-only`.
6. **Sessions** are HttpOnly, Secure, SameSite=Lax cookies scoped to the app zone only.
   **API tokens** for the CLI are hashed at rest, scoped and revocable.
7. **E-mail is optional infrastructure** (SMTP configurable). Without SMTP there are no
   reminders and no self-service reset; an admin resets instead.
8. **CPU-heavy hashing (Argon2id) runs on `spawn_blocking`,** never on the async workers
   (A-01, [#31](https://github.com/Mozra-the-great/stuffcloud/issues/31)).

## Consequences

- Positive: the homelab gets single sign-on and group-based roles, while a standalone
  instance still has full local authentication with phishing-resistant passkeys.
- Positive: session cookies scoped to the app zone cannot reach hosted sites, which live on
  other registrable domains (ADR 0002).
- Negative: three credential types plus OIDC are many flows to test: password, passkey, TOTP,
  OIDC and recovery, each against every role and with negative cases (SPEC 14, "API
  integration tests"; security review A-13, [#43](https://github.com/Mozra-the-great/stuffcloud/issues/43)).
- Negative: only authentik is tested; other OIDC providers are supported by the generic
  implementation but unverified.
- Negative: without SMTP, an admin must reset passwords by hand, and there are no expiry
  reminders.

## Open points

- The Rust WebAuthn library is chosen in A-04 ([#34](https://github.com/Mozra-the-great/stuffcloud/issues/34))
  after checking its licence against `deny.toml` and its native dependencies against the
  static, distroless build.
- The session store and the data model are in A-02 ([#32](https://github.com/Mozra-the-great/stuffcloud/issues/32);
  done, see the addendum below), the OIDC implementation and its end-to-end test against an authentik container in A-06
  ([#36](https://github.com/Mozra-the-great/stuffcloud/issues/36)). Wiring the authentik
  Application in the homelab is infrastructure and belongs in `homelab-infra` (open owner
  question SF3).

## Alternatives considered

The SPEC states the decision, not the rejected options; the following follow from its text.

- **OIDC as the only login:** not chosen as the default. It exists as the sign-up mode
  `oidc-only`, but local accounts and a break-glass admin always remain.
- **Local accounts only:** not chosen; in the homelab OIDC is the preferred login.
- **E-mail as required infrastructure:** rejected; SMTP is optional and the admin resets
  credentials without it.

## Links

- [SPEC 6](../SPEC.md#6-users-roles-and-authentication), [14](../SPEC.md#14-quality-ci-and-testing), [15](../SPEC.md#15-phases)
- Issues [#32](https://github.com/Mozra-the-great/stuffcloud/issues/32) (A-02), [#33](https://github.com/Mozra-the-great/stuffcloud/issues/33) (A-03), [#34](https://github.com/Mozra-the-great/stuffcloud/issues/34) (A-04), [#35](https://github.com/Mozra-the-great/stuffcloud/issues/35) (A-05), [#36](https://github.com/Mozra-the-great/stuffcloud/issues/36) (A-06), [#43](https://github.com/Mozra-the-great/stuffcloud/issues/43) (A-13)
- [ADR 0002](0002-static-hosting-and-origin-isolation.md)

## Addendum: sessions, CSRF and the auth data model (2026-11-19, A-02)

The open point "The session store and the data model are in A-02" is closed by A-02
([#32](https://github.com/Mozra-the-great/stuffcloud/issues/32)). It implements decision 6 as
amended by [ADR 0009](0009-zone-model-and-shared-domain-isolation.md) decision 8; nothing of
either record changes.

- **Data model** (`crates/db/migrations/0002_auth.sql`): `users` (login as the natural key,
  kind `person`/`service`, role `user`/`moderator`/`admin`; anonymous clients have no row),
  `credentials` (password, passkey, TOTP; filled by A-03 to A-05), `oidc_identities` (A-06),
  `recovery_codes` (hashes), `sessions`, and a `category` column (`resource`/`security`) on
  `audit_log`. No table stores an IP address.
- **Session tokens:** 32 random bytes from the operating system (`getrandom`), 64 lowercase hex
  digits in the cookie, stored only as SHA-256 (a plain hash suffices for 256-bit random
  values; a slow hash would only cost time on every request). A copy of the database holds no
  usable session.
- **Cookies:** `__Host-stuffcloud-session` (`SameSite=Lax`, `Max-Age` = remaining absolute
  lifetime) and `__Host-stuffcloud-csrf` (`SameSite=Strict`), both `Secure`, `HttpOnly`,
  `Path=/`, never `Domain`. The `core` type `HostCookie` cannot express a `Domain` attribute,
  the app reads only these two names byte for byte, and a name given twice counts as absent.
  CI enforces the rule twice: `scripts/ci/check_cookies.py` (job `repo-checks`, static scan,
  widened in the follow-up below) and an integration test that sends every route of the OpenAPI
  document and the fallback, probe and metrics paths and checks every `Set-Cookie`.
- **CSRF:** every request other than `GET`, `HEAD`, `OPTIONS` that is not an API-token request
  (a well-formed `Authorization: Bearer` header, see the follow-up below) must carry exactly one `Origin` equal to the app address (`STUFFCLOUD_APP_URL`),
  `Sec-Fetch-Site: same-origin` when the browser sends it, and an `X-CSRF-Token` header equal
  to the CSRF cookie (double submit, compared in constant time). With a session, the token must
  also be the one bound to it (its hash is stored in the session). The check runs for every
  path, also without a session, so the login form is covered. `GET /api/v1/auth/session` hands
  out the token. A request with a well-formed `Authorization: Bearer` header (API tokens, A-08) is
  never authenticated by cookie and skips these checks: a browser cannot add that header
  cross-site without a CORS preflight, which the app never allows.
- **Lifetimes:** idle timeout (`STUFFCLOUD_SESSION_IDLE_MINUTES`, default 480) and absolute
  timeout (`STUFFCLOUD_SESSION_ABSOLUTE_HOURS`, default 168), applied on every lookup; expired
  sessions are deleted when seen, on every login and at startup. Use is recorded at most once a
  minute.
- **Fixation and rotation:** a login always creates a new session and ends the one the request
  presented; `rotate_session` gives a session new tokens when its privilege changes (second
  factor, A-05); a role change ends every session of the account. Logout ends one session,
  "logout everywhere" all sessions of the account.
- **Audit:** security events (`user.created`, `user.role_changed`, `session.created`,
  `session.replaced`, `session.rotated`, `session.ended`, `session.ended_all`,
  `session.ended_by_role_change`, `session.expired`) carry internal ids only (`user:<id>` as
  the actor), never a login name, e-mail address, token, hash or IP address. Resource writes
  record the acting account the same way.
- **Interim authorisation:** until the permission matrix of A-07
  ([#37](https://github.com/Mozra-the-great/stuffcloud/issues/37)), reads stay open and writes
  need an admin session (`AdminWritePolicy`).

Alternatives considered:

- **Signed (stateless) session cookies:** rejected; logout, "logout everywhere", role changes
  and timeouts need server-side state anyway, and a leaked signing key would forge every
  session.
- **A CSRF token in a readable (non-`HttpOnly`) cookie for the SPA to copy:** not needed; the
  token comes in the JSON of `GET /api/v1/auth/session`, so both cookies stay `HttpOnly`.
- **`Origin` check alone:** the issue and ADR 0009 require a token as well; the token also
  covers clients that strip `Origin` on some requests.
- **Trusting `SameSite`:** rejected by ADR 0009: hosted sites may be same-site with the app.


## Addendum: hardening after the security review of A-02 (2026-11-19, #134 to #137)

The review of [#133](https://github.com/Mozra-the-great/stuffcloud/pull/133) found no way to
read or forge a session, and four points that this addendum closes or accepts. Nothing in the
decisions above changes; the paragraphs "CSRF" and "Cookies" are made precise.

- **Only a well-formed bearer token skips the CSRF checks
  ([#134](https://github.com/Mozra-the-great/stuffcloud/issues/134)).** The first version
  skipped Origin, `Sec-Fetch-Site` and CSRF token for *any* `Authorization` header. Browsers
  attach cached HTTP credentials (`Basic`, `Digest`, `Negotiate`, `NTLM`) on their own, also to
  cross-site form posts, for example when a reverse proxy in front of the app asks for a
  login; such a request would have run anonymously without a CSRF check. The reasoning "a
  browser cannot add the header cross-site without a preflight" holds for one credential only,
  an explicit `Authorization: Bearer <token>`. `stuffcloud_core::authorization::classify` now
  sorts the header: **exactly one** field, the scheme `Bearer` (any case), one space and a
  `token68` credential of at most 512 bytes is an API client (cookies ignored, no CSRF check).
  Any **other scheme** is ignored: the request is handled as if it had no `Authorization`
  header (cookies work, writes need the CSRF proof), so a proxy that adds `Basic` neither breaks
  sessions nor opens a hole. A **malformed `Bearer`** header (no or bad credential) or **several
  fields** are refused with 401, never read as anonymous and never rescued by a cookie. Until
  the token store of A-08 ([#38](https://github.com/Mozra-the-great/stuffcloud/issues/38)) exists
  the credential syntax is the only check; A-08 narrows `is_credential` to the real token format
  and answers 401 for a well-formed token that names no token (never anonymous).
- **No CSRF rebinding by a cross-site `GET`
  ([#135](https://github.com/Mozra-the-great/stuffcloud/issues/135)).** `GET /api/v1/auth/session`
  used to bind a new CSRF token to the session whenever the browser sent the session cookie
  without a matching CSRF cookie. A cross-site top-level navigation does exactly that (the Lax
  session cookie is sent, the Strict CSRF cookie is not), so any page could invalidate the token
  of every open tab (a nuisance, no leak). Chosen fix: **`Sec-Fetch-Site`**. A new token is
  stored (database and cookie) only when the request is `same-origin` or `none` (typed address,
  bookmark) or carries no `Sec-Fetch-Site` at all (browsers before 2023 and non-browser clients,
  which no third party can steer); for anything else the endpoint answers the same JSON but
  stores nothing and sets no cookie. Rejected alternative: a deterministic token (HMAC of the
  session secret). It would need a server key with its own rotation and storage, and the stored
  hash of the session would become redundant; the header check needs no new secret and no
  state, and the residual case (a browser without fetch metadata) is the situation before the
  fix, restricted to old browsers. The typed client retries a write **once** with a fresh token
  when the server refuses it for its CSRF token (`refreshCsrfToken` option; origin and fetch
  metadata refusals are never retried).
- **Session lookups no longer take the write lock for nothing
  ([#135](https://github.com/Mozra-the-great/stuffcloud/issues/135)).** `find_session` reads in a
  deferred (read-only) transaction first; an unknown token and a valid session whose last use
  is less than a minute old are answered without a write. Only a touch or the deletion of an
  expired session opens a write transaction, which looks the row up again (the session may have
  ended in between). A client that sends random session cookies therefore cannot queue writers
  behind each other or behind `edge`.
- **Refusals are counted, their log line is rate limited
  ([#135](https://github.com/Mozra-the-great/stuffcloud/issues/135)).** Every refusal increments
  `stuffcloud_auth_rejections_total{reason}` (`reason` is a rule name such as
  `missing_origin`, `token_mismatch` or `invalid_authorization`, never a request value) and
  logs one `warn` line per 10 seconds with the number of lines suppressed in between.
- **A `Set-Cookie` can only be built by `HostCookie`
  ([#136](https://github.com/Mozra-the-great/stuffcloud/issues/136)).** `HostCookie::set` and
  `clear` return a `SetCookie`, a newtype with a private field that is the only type the helper
  `append_cookie` accepts, so no module can attach an arbitrary cookie string. The static gate
  `scripts/ci/check_cookies.py` is defense in depth and now also scans tests, `build.rs`,
  benches, fuzz targets and future crates (every `*.rs` of the repository), reads escaped,
  `concat!`-ed and raw names, sees multi-line `.domain(` calls, `CookieJar`/`Cookie::new`-style
  library APIs and cookie libraries in `Cargo.toml`, scans `Caddyfile*`/`*.caddy` for
  `Set-Cookie` and `Domain=`, and `web/` for `document.cookie`, `cookieStore` and cookie
  libraries (allowlist `WEB_COOKIE_ALLOWLIST`, empty). Every bypass has a failing fixture in
  `scripts/ci/test_check_cookies.py`. What it cannot see (a header name or attribute assembled
  at run time from non-literal pieces) is the reason the type, not the scan, is the boundary.
  The runtime test now also sends the probe, metrics, fallback and bare-prefix paths.
- **Origin ports are canonical ([#137](https://github.com/Mozra-the-great/stuffcloud/issues/137)).**
  `Origin::parse` refuses a port with a leading zero (`:0443`): browsers never send one, and
  accepting it would have made a non-canonical text equal to the app origin.

### Accepted residual risks

- **Cookie tossing can log a user out.** A cookie name that appears twice counts as absent and
  the app clears the session cookie in its answer. A sibling host under the same registrable
  domain (a hosted site with scripts) can plant a second `__Host-stuffcloud-session` for the
  parent domain in browsers that do not enforce the `__Host-` rules for such a cookie, or with
  the nameless-cookie trick, and so end the user's session on their next request. It reads
  nothing and gives no access; it is the denial of service already accepted in SPEC 5.5, and
  the mitigations there apply (restrict the zone to trusted accounts, use a sub-level or
  another zone, or request a PSL entry). Not sending a clear for an ambiguous cookie would
  not help: the session would still not be found, and the stale cookie would stay.
- **Timeouts depend on the wall clock.** Idle and absolute timeouts compare the stored Unix
  times with the system clock (`SystemClock`). A clock that jumps forward ends sessions early,
  one that jumps back extends them until it catches up; an operator who needs the timeouts to
  hold keeps the host in sync (NTP or chrony). The database stores no monotonic time because it
  must survive restarts and be shared with `edge`.
- **Browsers without `Sec-Fetch-Site`** still let a cross-site navigation rebind the CSRF token
  of a session whose CSRF cookie is missing, as before the fix (see above); the effect is a
  failed write that the client repeats with a fresh token.
