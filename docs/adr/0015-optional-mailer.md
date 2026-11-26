# ADR 0015: The optional mailer

- Status: Accepted
- Date: 2026-11-26
- Decided in: issue [#40](https://github.com/Mozra-the-great/stuffcloud/issues/40) (A-10),
  [SPEC 6](../SPEC.md#6-users-roles-and-authentication) ("E-mail is optional infrastructure",
  "Password reset"), [SPEC 10.2](../SPEC.md#102-resources-and-write-semantics)
- Supersedes: nothing. It fills the gap that decision 7 of [ADR 0005](0005-auth-model.md) ("e-mail is
  optional infrastructure") and decision 4 of [ADR 0010](0010-api-first-and-configuration-as-code.md)
  ("secrets are references") leave: how mail is sent, what is queued, what is said. The write-only
  secrets of the ADR 0010 addendum ([#152](https://github.com/Mozra-the-great/stuffcloud/issues/152))
  are not part of it.

## Context

SPEC 6 says e-mail is optional: without SMTP there are no reminders and no self-service reset, an
admin hands out reset links (A-03). With SMTP "the account asks for it itself". #40 asks for the
SMTP configuration with TLS, templated German and English mails, a queue with retry and back-off,
feature flags that degrade gracefully, a mail catcher for tests and, as the acceptance criterion,
the password reset mail in the dev mailbox.

Three things make this more than a client library. A reset mail carries a one-time token that the
database keeps only as a hash. The request for a reset is anonymous, so it is a way to learn which
accounts exist and a way to send mail to a stranger. And the app has to run with no mail at all.

## Decision

1. **The configuration is the settings group `smtp`** (SPEC 10.2: `GET`/`PUT`/`DELETE
   /api/v1/settings/smtp`, `admin:settings:read` to read and `write` to change, ETag, dry run, part
   of the bootstrap file and later of the declarative file). A group that was never written means
   "no mail". Fields: `host`, `port`, `security` (`starttls`, `tls`, `none`), `username`,
   `password`, `from`, `from_name`. `GET /api/v1/features` (public) says `{"mail": true|false}`, so
   a client can offer "forgot your password?" or say why it does not.
2. **Transport security.** `starttls` upgrades before anything else is sent and **requires** the
   upgrade; `tls` wraps the connection from the first byte; `none` is plain text for a local mail
   catcher and is refused together with a username and password: credentials never travel
   unencrypted. The server's certificate and name are checked against the system's root
   certificates (`SSL_CERT_FILE` for a private CA). TLS is `rustls` with the `ring` provider
   (Apache-2.0 AND ISC); `native-tls` would need OpenSSL in a distroless image, `aws-lc-rs` brings
   the `OpenSSL` licence, which is not on the allow list. The client is `lettre` (MIT) in the new
   crate `crates/mail`, with the message builder, the transport and a recording transport for tests.
3. **The password is a reference, for now.** `{"ref": "STUFFCLOUD_SECRET_SMTP"}` names a variable of
   the deployment configuration (or, with `_FILE`, a file); only names with the prefix
   `STUFFCLOUD_SECRET_` are accepted, so a setting cannot name another variable of the process. The
   shape is the tagged secret of the ADR 0010 addendum, of which only `ref` exists until #152 adds
   `value` and `stored` without changing what is written here. A secret written where a reference
   belongs is refused with a fixed sentence: the error never repeats it. The secret is read when a
   mail is sent, never stored and never logged.
4. **The queue is in memory, on purpose.** A durable queue would have to keep the token (or the
   message) in clear text next to a database that stores tokens only as hashes. The queue holds what
   the person typed (login name or address, language) and nothing secret; the token is made when the
   job runs and lives in memory until the mail is delivered or given up. At most 4 mails are in
   flight and 64 requests wait; a full queue answers `429` with `Retry-After`. A restart drops what
   waits and the person asks again. The settings are read again for every attempt.
5. **Retries.** A transient failure (connection, timeout, TLS, a 4xx answer) is tried again after 15
   seconds, 1 minute, 5 minutes and 15 minutes; a rejection for good (5xx, a refused login), a
   message that cannot be built and the end of the schedule give the mail up. The last attempt is
   21 minutes after the first, well inside the 60 minutes a reset link lives.
6. **Asking for a reset link by e-mail** is `POST /api/v1/auth/password-reset/request` (public, with
   the CSRF checks of every anonymous write): `{"login": name-or-address, "language": "de"|"en"}`.
   - The answer is `202` with no body for every login name or address, whether or not it names an
     account, an admin, an account without an address or a service account; the work happens after
     the answer, so even the time does not tell. Without mail it is `409 mail-not-configured`, which
     depends on the instance only.
   - The client address is throttled for every request (5 free, then waits up to an hour), and an
     account gets at most one token per 5 minutes, so the endpoint cannot be used to flood a mailbox
     or to void the link in a person's inbox again and again.
   - The mail goes only to the address stored for the account, never to one from the request.
   - **Admin accounts get no link by mail** (the host command `stuffcloud-app reset-link` stays their
     way, as in #147): a hijacked mailbox would otherwise be enough to take over an admin account.
     This is a default the owner can change (one line in `db::issue_password_reset_for_mail`).
7. **The mail** is plain text, in German or English, with no HTML part, no image, no tracking link;
   the only link is the reset link, with the token after `#` so it never reaches a server log or a
   `Referer`. Headers cannot be injected: addresses are `Email` values (visible ASCII, one `@`), the
   sender's name is checked for control characters and `<>"\` when the settings are written and
   encoded by the message builder, the subject is a fixed text, and `Message-ID` and `EHLO` use the
   domain of the sender address, never the name of the host. `Auto-Submitted: auto-generated`
   (RFC 3834) keeps vacation replies out.
8. **Logs and metrics name no one.** A line says `sent`, `retry` or `failed`, the kind of failure and
   the SMTP status code; never an address, a name, a token or what the server said (that text may
   repeat the recipient). `stuffcloud_mail_deliveries_total{result}` counts the same words. The
   counters can be correlated with a request on a quiet instance; `/metrics` is not routed to the
   public listener (Caddyfile) and must stay that way.
9. **Test mode** is Mailpit in the dev compose (`mailpit:1025`, UI at `mail.localhost`): the dev
   bootstrap file sets the `smtp` group up for it and opens sign-up, and the smoke test registers an
   account, asks for a reset mail, reads it in Mailpit and redeems the link.

## Consequences

- Positive: the app runs without mail and says why; with mail, the reset flow works by itself and
  tells nothing about which accounts exist; no secret and no token is stored or logged because of
  mail; mail is a normal settings resource (API, dry run, ETag, bootstrap, later `plan`/`apply`).
- Negative: a mail that waits in the queue is lost on a restart; a person who is mailed at the
  moment of a restart asks again. The password cannot be set through the API until #152; an
  operator sets a variable or a file. An operator behind a private CA sets `SSL_CERT_FILE`. The
  dependency tree grows by `lettre`, `rustls`, `ring`, `rustls-native-certs` and a few small
  crates (all on the license allow list); `ring` compiles C and assembler, which the CI runners and
  the build image have.
- Follow-ups: [#152](https://github.com/Mozra-the-great/stuffcloud/issues/152) (write-only SMTP
  password), [#141](https://github.com/Mozra-the-great/stuffcloud/issues/141) (the account UI: a
  "forgot your password?" page that reads `GET /api/v1/features`), the reminder before a site
  expires (SPEC 8.2) reuses the queue with another kind of job, and the CLI commands for the
  `smtp` group and the reset request come with the `cli` crate (SPEC 10.5).

## Alternatives considered

- **Environment-only SMTP configuration:** simplest, but it is the one setting that could not be
  managed through the API (ADR 0010 decision 1) and would need a restart to change.
- **A durable outbox table:** survives restarts, but stores the token in clear text (or encrypted
  with a key the app holds, which is #152's problem and not worth it for a 60-minute token).
- **`native-tls` or `aws-lc-rs` for TLS:** OpenSSL in a distroless image, or a licence that is not
  GPL-compatible; `rustls` with `ring` has neither problem.
- **A hand-written SMTP client:** fewer dependencies, but the protocol, the TLS upgrade and the
  encodings are exactly where an injection or a downgrade hides; `lettre` is maintained for it.
- **Telling the client whether the account exists** ("no such account", "no address on file"): the
  convenience is not worth turning the endpoint into an account oracle.
- **Mailing admin accounts too:** the SPEC's sentence "the account asks for it itself" can be read
  that way; refused by default because the break-glass admin has the host command and a stolen
  mailbox should not be enough for the account that can do everything.
