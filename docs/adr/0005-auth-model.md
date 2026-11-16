# ADR 0005: Auth model: local accounts, passkeys, TOTP and OIDC

- Status: Accepted
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
- The session store and the data model are in A-02 ([#32](https://github.com/Mozra-the-great/stuffcloud/issues/32)),
  the OIDC implementation and its end-to-end test against an authentik container in A-06
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
