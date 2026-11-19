# ADR 0005: Auth model: local accounts, passkeys, TOTP and OIDC

- Status: Partly superseded by [ADR 0009](0009-zone-model-and-shared-domain-isolation.md)
  (the zone wording of decisions 1 and 6 and the second consequence: anonymous hosting is
  per site and per zone, session cookies are `__Host-` cookies with `Origin` and CSRF checks
  because sites may share the app's registrable domain; the other decisions stay accepted).
  Sessions, CSRF and the data model: see "Addendum: sessions, CSRF and the auth data model"; local
  accounts, sign-up modes and password reset: see "Addendum: local accounts"
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
  need an admin session (`AdminWritePolicy`). A-07 replaced this, see "Addendum: authorisation".

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

## Addendum: authorisation (2026-11-19, A-07)

A-07 ([#37](https://github.com/Mozra-the-great/stuffcloud/issues/37)) gives the roles of
decision 1 and the token scopes of
[ADR 0010](0010-api-first-and-configuration-as-code.md) decision 5 their meaning and replaces
the interim `AdminWritePolicy`. No decision above changes.

- **One pure decision function in `core`** (`stuffcloud_core::policy::decide`): (subject,
  requirement) to allow or deny, deny by default. The subject is anonymous, an account with a
  session, or an API token with its owner; a route's requirement is `public`, `session` or a
  permission. `app` only wires it to the router (`app::access`).
- **The matrix is data**: `policy::grant` names for each permission the lowest role that has
  it and whether anonymous clients do. It is a `match` without a wildcard, so a new area does
  not compile until its row is written. The roles are ordered; a higher role has everything a
  lower one has. `docs/api/permissions.md` is generated from the matrix and the route table
  (`stuffcloud-app permissions`), and a test fails when it is stale.
- **Permissions and scopes are one vocabulary**: `<area>:<read|write>`, areas as in SPEC 10.4.
  `write` includes `read` of the same area. Scopes are parsed exactly (no trimming, no case
  folding, no wildcards), with a fuzz target asserting the round trip.
- **Token = scopes intersected with the owner's role**, evaluated at every request with the
  owner's role as stored now. So a token never exceeds its owner, and an admin scope stops
  working when the owner loses the admin role without touching the token. A token may create
  tokens only within its own scopes (`Scopes::may_grant`, used by A-08).
- **Service accounts** have no session: a session of a service account is refused by the policy
  even if one existed (defence in depth), and `start_session` answers 403, counts the refusal
  and audits it (`login.refused`, internal id only).
- **Moderators** hold `moderation` and `admin:blocklist`, as SPEC 6 and 8.6 give them reports,
  takedowns and blocklist entries; every other `admin:*` area is admin only. Anonymous clients
  hold only `sites:write` (creating temporary internal sites where a zone allows it).
- **Zone rules** are a second pure function, `hosting::may_host`, over a `ZonePolicy` (ADR 0009
  decision 3): enabled flag, hosting roles or an allow-list of accounts that replaces them,
  anonymous hosting, public sites. Anonymous sites are internal, temporary and without
  JavaScript. The zone resource itself (H-02) only has to build the `ZonePolicy`.
- **Every route declares its requirement.** Routes are registered through `app::access::Endpoints`
  with the requirement next to the handler; a guard in front of the handler runs after
  authentication and refuses with 401 (not logged in) or 403. `access::verify` (called at startup) compares the
  table with the OpenAPI document at startup and fails the start for an operation without a
  declared policy; tests enumerate every operation against every kind of caller and check that
  `server.rs` registers no route another way. Handlers no longer authorise themselves: the
  resource helpers (`resource::get/put/delete`) assume the guard has run.
- **Audit of refusals**: an authenticated account that is refused gets an `access.denied` row
  (actor `user:<id>`, kind the permission area, key `<level>:<rule>`), at most once a minute per
  account, permission and rule (in-memory limiter, bounded), so a client that hammers a
  forbidden route cannot turn requests into database writes. Anonymous refusals are not audited
  (they could fill the log at will) but counted in `stuffcloud_auth_rejections_total{reason}`.
- **Session routes**: logout and "logout everywhere" require a browser session of a person
  (`session`); a token cannot end a session.
- **Reads of settings groups** the client needs before it logs in stay `public` (ADR 0010
  decision 4: the API is LAN-only and these hold no secret); a group that may hold anything
  private declares `admin:settings:read` for its `GET`.
- **Not yet decided here, left to the routes that need it**: object-level rules (an account may
  touch only its own sites and tokens, a moderator any site) are checked by the handlers of
  those routes next to the area permission; `Account` carries the login name so zone
  allow-lists can be applied without a second lookup.

Alternatives considered:

- **Authorising inside each handler** (what the interim policy did): rejected; a forgotten call
  is a hole, and nothing could enumerate the routes. The guard cannot be forgotten because the
  route cannot be registered without one.
- **A role column per route in the OpenAPI document**: the document describes the shape of the
  API; the table that enforces it is the code, and the document is checked against it.
- **Copying the scopes and the role into the token**: rejected; a role change would then need a
  token sweep, and a demoted admin's token would keep working until it expired.


## Addendum: local accounts (2026-11-19, A-03)

A-03 ([#33](https://github.com/Mozra-the-great/stuffcloud/issues/33)) implements decisions 2
(passwords; passkeys and TOTP follow in A-04/A-05), 4 (the break-glass admin), 5 (sign-up modes)
and 7 (reset without SMTP), and the session cap, login throttling and periodic purge asked for in
the security review of A-02. No decision above changes.

- **Argon2id** (`argon2` crate, RustCrypto, MIT OR Apache-2.0), version 19, 16-byte random salt,
  stored as a PHC string in `credentials` (at most one password per account). Defaults are
  OWASP's first recommendation (19 MiB, 2 iterations, 1 lane), configurable through
  `STUFFCLOUD_ARGON2_MEMORY_KIB` / `_ITERATIONS` / `_PARALLELISM` (memory 7 MiB to 1 GiB). The
  start-up log line "password hashing ready" reports how long one hash took (`hash_ms`); the
  operator raises the memory until it nears a few hundred milliseconds or lowers it on a small
  host, keeping one of OWASP's equivalent pairs (46 MiB x 1, 19 MiB x 2, 12 MiB x 3, 9 MiB x 4,
  7 MiB x 5). A hash made with other parameters is replaced at the next successful login.
  Hashing runs on the blocking pool (decision 8) behind a semaphore of as many slots as the host
  has cores (at most 16), so a login flood queues (and meets the request time limit) instead of
  exhausting memory. Passwords are hashed and compared in NFKC (NIST SP 800-63B).
- **No enumeration by answer or timing.** An unknown login name or address, a service account,
  an account without a password and a wrong password all get the same 401 `invalid-credentials`
  document after exactly one Argon2id check: accounts without a stored hash are checked against
  a dummy hash made at start-up with the current parameters. The failed-login audit row of an
  existing account is written in the background, so the answer does not wait for a write that an
  unknown account would not cause. The test counts the Argon2 checks per path instead of timing
  them (timing tests are flaky; the count is what makes the time equal). Residual: a hash made
  with older parameters takes a different time until the account's next login rehashes it.
  Registration tells whether a login name or address is taken (unavoidable without verifying the
  address by e-mail, A-10); in `invite-only` the invitation is checked first, so only holders of
  a valid invitation can ask, and registrations are throttled per client address.
- **Password policy**, length based: at least 12 characters (`STUFFCLOUD_PASSWORD_MIN_LENGTH`, 8
  to 128), at most 256 (1024 bytes, also the bound of every password field before hashing), not
  the login name, the address or its local part, not one repeated character. The breached-password
  check is an **offline** list the operator may supply (`STUFFCLOUD_PASSWORD_BLOCKLIST_FILE`, one
  password per line, kept in memory as 64-bit SHA-256 prefixes); stuffcloud never contacts a
  breach service (no k-anonymity request either: the API is LAN-only and must work without
  internet).
- **Throttling instead of lockout** (in memory, never stored or logged; `app::throttle`). Per
  client address (the TCP peer; behind the proxies listed in `STUFFCLOUD_TRUSTED_PROXIES` the
  right-most untrusted `X-Forwarded-For` entry; IPv6 by /64): 20 free failures (failed logins,
  wrong current passwords, unknown reset tokens), then waits of 1 s doubling to 15 minutes. Per
  typed login name or address (hashed, so the table holds no names): 10 free failures, then the
  same waits; it counts unknown names exactly like known ones. Registrations: 5 per address, then
  waits from one minute to an hour. A throttled attempt is answered 429 with `Retry-After`
  without being checked. **Trade-off of the per-account rule:** an attacker with a few addresses
  can keep an account waiting. It is bounded: the wait never exceeds 15 minutes and every attempt
  after it is checked again (no lockout an attacker could extend indefinitely), and an address
  that logged in to the account within the last 30 days skips the per-account rule (it keeps its
  own address rule), so the owner's usual devices are not affected. A client behind the same NAT
  as an attacker shares the address rule; that is the price of throttling by address at all.
  The tables are bounded (50 000 keys each; forgotten keys first, then the oldest) and forgotten
  on restart.
- **Sessions:** login and registration start the session through `auth::start_session` (the
  presented session ends: no fixation; the answer carries the new CSRF token). At most
  `STUFFCLOUD_SESSION_MAX_PER_USER` sessions per account (default 10): the oldest beyond it end
  (`session.evicted`). Expired sessions, invitations and reset tokens are purged every 10 minutes
  besides the purges on login, lookup and start.
- **Sign-up modes** (settings group `signup`, default `invite-only`): `open`, `invite-only`
  (single-use invitations created by an admin, 1 to 720 hours, optionally bound to one address,
  at most 1000 pending), `oidc-only` (no local registration; admins still have the break-glass
  account). Anonymous writes (login, register, reset) pass the `Origin` and CSRF checks like any
  write (#134).
- **Password reset without SMTP:** an admin asks for a link
  (`POST /api/v1/admin/users/{login}/password-reset`), or the operator runs
  `stuffcloud-app reset-link <login>` on the host (the break-glass path when no admin can log
  in). The token is 32 random bytes, stored as SHA-256, valid for 60 minutes, single use, one per
  account (a new one replaces the old); the link carries it after `#`, so it never reaches a
  server log or a `Referer`. Redeeming it sets the password and ends every session of the
  account. A-10 adds the self-service request over e-mail on the same table.
- **Bootstrap admin:** `STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN`, `_EMAIL` (optional) and `_PASSWORD`
  or `_PASSWORD_FILE` create the first admin in the bootstrap transaction on the first start; a
  weak or listed password stops the start. Later starts ignore the variables with a log line.
- **Audit:** `user.created`, `password.changed`, `password.reset_issued`, `password.reset`,
  `invitation.created`, `invitation.used`, `invitation.revoked`, `login.failed` (existing
  accounts only, at most once a minute per account), `session.evicted`,
  `session.ended_by_password_change`, `session.ended_by_password_reset`: internal ids only.

Alternatives considered:

- **Account lockout after N failures:** rejected; anyone could lock out any account by typing
  wrong passwords. The backoff with the known-address exemption limits guessing without that.
- **bcrypt or scrypt:** Argon2id is OWASP's first choice and memory hard; bcrypt truncates at 72
  bytes.
- **An online breach check (k-anonymity range queries):** rejected for now; the app runs in the
  LAN and must not depend on an outside service. The offline list gives the same check.
- **A timing test with a stopwatch:** rejected as flaky; counting the Argon2 checks proves the
  equal work deterministically.

## Addendum: hardening after the security review of A-03 (2026-11-19, #145 to #147)

The security review of the local accounts (PR #142) found a race in the throttles, a shared
throttle behind an unlisted proxy and a handful of smaller gaps. No decision above changes; the
throttling paragraph of the A-03 addendum is made precise as follows.

- **Attempts are reserved, not just checked
  ([#145](https://github.com/Mozra-the-great/stuffcloud/issues/145)).** The throttle used to
  read the wait before the Argon2 check and count the failure after it, so thousands of parallel
  requests (HTTP/2 multiplexing) all passed the check. Now `Throttles::reserve_login` takes the
  attempt's place in the address and account counts under the same lock that reads them; an
  attempt still being checked counts like a failure (`Rule::wait_in_flight`): while free failures
  remain each running attempt takes one, beyond them at most one attempt per key runs at a time.
  A key therefore gets exactly `free + 1` checks however the requests interleave (property test,
  and integration tests that send 60 logins or 40 password changes at once against a frozen
  clock and count the Argon2 checks: 11 per account, 21 per address). The reservation is
  settled when the answer is known: a failure is booked, a success refunds the place, a request
  that was never checked is refunded, and a reservation dropped unsettled (error, cancelled
  request) counts as a failure. The same applies to password changes and reset tokens (address
  only); registrations count at the check, under one lock.
- **The hashing queue is bounded.** At most `QUEUE_PER_SLOT` (8) requests per hashing slot wait,
  each for at most 5 seconds; beyond that the answer is 429 `too-many-requests` with
  `Retry-After: 1` and the detail "the server is busy checking other passwords" at once. Such a
  request was not checked and is not counted as a failure. A flood therefore costs legitimate
  logins a quick retry instead of a time-out.
- **One account, one count.** The account rule counted the typed text, so a login name and an
  e-mail address had 10 free failures each. After the lookup the attempt now also counts on the
  account's internal id. When that count refuses, the password is checked against the dummy
  hash only and the answer is the usual 401 `invalid-credentials`: a 429 would tell that the two
  names belong to one account. Unknown names keep their typed-text count only, as before.
- **Unlisted reverse proxies
  ([#146](https://github.com/Mozra-the-great/stuffcloud/issues/146)).** Without
  `STUFFCLOUD_TRUSTED_PROXIES` every client behind Caddy has Caddy's address: 20 failures by
  anyone throttle everybody, and one login made the proxy address "known" for the account.
  When the list is empty and the peer is on a local network (`client_ip::is_internal`: loopback,
  RFC 1918, RFC 6598, link-local, IPv6 ULA and link-local), the app now treats the peer as an
  unlisted proxy: no address is exempt from the account rule and no login makes one known, and a
  request that carries `X-Forwarded-For` or `Forwarded` logs a warning at most once an hour
  (naming no address). The rule does not depend on the headers, because a proxy may send none;
  a direct connection from a LAN address without a proxy is not a supported deployment (the app
  listens on loopback, its container is reachable only through Caddy), so it costs nothing
  there. `compose.dev.yml` gives the stack network a fixed subnet and lists it; the smoke test
  of the dev stack proves that a client inside the Caddy container is still checked while the
  host waits. The README tells every deployment behind a proxy to set the variable.
- **Throttle tables cannot be flushed
  ([#147](https://github.com/Mozra-the-great/stuffcloud/issues/147)).** A full table (50 000
  keys) used to drop the key with the oldest failure, so a flood of fresh keys could push out
  the counter of an account under attack. It now drops a sixteenth of the table at once (the scan
  runs once per 3 125 new keys instead of on every one): keys whose window has passed first,
  then the fewest failures, then the oldest, never a key with a running attempt. A flood with
  one failure per key therefore never reaches a counter that is actually throttling; to push it
  out an attacker would need 50 000 keys with more failures each. The periodic purge (every
  10 minutes) sweeps forgotten keys, so the drop under the lock is rare. Known addresses are
  capped at 16 per account (the account's own oldest one makes way), and when the table is full a
  new address stays unknown instead of removing someone else's: an attacker with an account of
  their own cannot log in often enough to strip another account's exemption.
- **A password change voids an open reset link.** `set_password` deletes the account's
  `password_resets` row in its transaction, so a link issued before the change (and perhaps
  leaked) cannot undo it. Redeeming a link already deleted it.
- **Argon2 floor.** The memory may no longer go below OWASP's minimum for the configured
  iterations (47104 KiB x 1, 19456 x 2, 12288 x 3, 9216 x 4, 7168 KiB with 5 or more); a weaker
  pair stops the start with the list of pairs. The defaults sit exactly on the second pair.
- **Admin reset links come from the host only.** Through the API a stolen admin session or
  admin token could issue a reset link for any other admin and take the account over for good.
  `POST /api/v1/admin/users/{login}/password-reset` now answers 403 for an admin account
  (including the caller's own; a password change is the way to change it); the operator's
  `stuffcloud-app reset-link <login>` on the host still issues one. A re-authentication step was
  considered and rejected: an API token has no password to repeat, and the host command is the
  break-glass path anyway.
- **Bootstrap secrets.** The docs recommend `STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD_FILE`, and the
  log line of every later start asks to remove the variables and the file from the deployment.

### Accepted residual risks

- **The known-address exemption is per address, not per device.** Anyone sharing the owner's
  address (the same NAT, CGNAT pool or IPv6 /64) inherits the owner's exemption from the account
  rule. They still have the address rule, which is shared with the owner and throttles both of
  them after 20 failures per hour, so the guesses stay bounded. Binding the exemption to a
  long-lived signed "known device" cookie would close this, but adds a third cookie with its own
  lifetime, revocation and privacy questions; it is left for the passkey work (A-04), where
  devices become first-class.
- **Throttles are per process and forgotten on restart**, as before: an attacker who can restart
  the app has other options.
