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
  CI enforces the rule twice: `scripts/ci/check_cookies.py` (job `repo-checks`, static scan of
  every crate) and an integration test that sends every route of the OpenAPI document and
  checks every `Set-Cookie`.
- **CSRF:** every request other than `GET`, `HEAD`, `OPTIONS` that has no `Authorization`
  header must carry exactly one `Origin` equal to the app address (`STUFFCLOUD_APP_URL`),
  `Sec-Fetch-Site: same-origin` when the browser sends it, and an `X-CSRF-Token` header equal
  to the CSRF cookie (double submit, compared in constant time). With a session, the token must
  also be the one bound to it (its hash is stored in the session). The check runs for every
  path, also without a session, so the login form is covered. `GET /api/v1/auth/session` hands
  out the token. A request with an `Authorization` header (API tokens, A-08) is never
  authenticated by cookie and skips these checks: a browser cannot add that header cross-site
  without a CORS preflight, which the app never allows.
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
