# ADR 0010: API-first and configuration as code

- Status: Accepted
- Date: 2026-11-16 (owner requirements in issue #116 and owner answer to SF9; written down
  2026-11-18)
- Decided in: issue [#116](https://github.com/Mozra-the-great/stuffcloud/issues/116), owner
  question SF9 (queue, 2026-11-16), [SPEC 10](../SPEC.md#10-api-and-cli)
- Supersedes: nothing. It extends the token sentence of decision 5 of
  [ADR 0005](0005-auth-model.md) (admin scopes, service accounts) and turns the zones and
  settings of [ADR 0009](0009-zone-model-and-shared-domain-isolation.md) into API resources.

## Context

Until now the SPEC described the API as the backend of the web UI plus four CLI commands for
sites (`deploy`, `list`, `rm`, `extend`). Runtime configuration (zones and their policy,
roles, quotas, sign-up mode, OIDC, SMTP, blocklist, tool toggles) appeared only as admin UI.
An operator who runs the rest of the infrastructure as code (Ansible, OpenTofu, a GitOps
repository) could then install stuffcloud automatically but had to click through the admin
UI afterwards, and could neither review nor reproduce that configuration.

The owner requires that stuffcloud is fully operable without the web UI and that the whole
instance configuration can be managed as code (#116). SF9 adds that stuffcloud gets its own
Ansible collection and its own OpenTofu provider, the provider only once the rest of the stack
and the API are finished and stable, and that a separate repository is not required and not
assumed upfront.

This has to be decided before the API skeleton (A-01,
[#31](https://github.com/Mozra-the-great/stuffcloud/issues/31)), because the URL layout, the
error model, the write semantics and the OpenAPI generation follow from it.

## Decision

1. **API-first, no UI-only features.** The web UI is a client of the public, versioned REST
   API (`/api/v1/...`) and uses only the client generated from its OpenAPI document. Every
   action the UI offers on the instance, for users and admins, has an API endpoint and a CLI
   command. A pull request that adds a UI feature adds the endpoint, the CLI command and their
   tests in the same pull request (CLAUDE.md, "API-first"). The only exceptions are steps
   that need a browser by nature: the WebAuthn ceremony and the OIDC redirect. They still
   have API endpoints, and the CLI offers the surrounding actions (list and revoke passkeys,
   admin reset, token login). Client-side tools (ADR 0004) are not instance operations; their
   admin toggles are API resources like any setting.
2. **Resources with natural keys.** Every configurable object is a resource addressed by a
   stable natural key, not only by an internal ID:

   | Resource | Key | Notes |
   |---|---|---|
   | zone | its domain (`example.com`) | the policy of ADR 0009 decision 3 as fields (decision 9 below) |
   | site | zone and name (`example.com/docs`) | metadata only; files arrive by `deploy` |
   | user | unique login name | e-mail is an attribute; kind `person` or `service` (decision 5) |
   | role | its name | the four roles of SPEC 6 are fixed and read-only |
   | OIDC group mapping | group name | maps a group claim to a role |
   | API token | owner and token name | decision 5 |
   | blocklist entry | the hash or pattern itself | |
   | settings group | its name (`signup`, `oidc`, `smtp`, `quotas`, `tools`, `reserved-names`, `legal`) | singletons |

   Keys are immutable; a rename is an explicit action. The internal ID is returned but never
   needed to address a resource.
3. **Write semantics for desired-state tools.**
   - `PUT /api/v1/<collection>/<key>` creates or replaces the resource with its full writable
     shape and is idempotent. The response says `created`, `updated` or `unchanged`; an
     unchanged write changes nothing, not even a timestamp, and writes no audit entry.
   - `GET` returns exactly the writable shape plus one read-only `meta` object (ID, ETag,
     timestamps, derived values such as reserved names that come from the app address), so a
     tool can compare its desired state with a `GET` without side effects. `PUT` accepts a
     body with or without `meta` and ignores it; any other unknown field is refused
     (`deny_unknown_fields`).
   - Imperative operations that are not state (invite, password reset, extend a site, rotate
     a token, take down a site, handle a report) are `POST` actions on the resource; each has
     a CLI command.
   - `DELETE` removes a resource; deleting one that does not exist is `404`, which `apply`
     counts as unchanged.
   - Optimistic concurrency: every resource has a strong `ETag`. `PUT` and `DELETE` accept
     `If-Match` (mismatch: `412`) and `If-None-Match: *` (create only). The web UI always
     sends `If-Match` and shows a conflict instead of overwriting.
   - Every write accepts `?dry_run=true`: full authentication, authorisation and validation,
     no change, and the response says what would happen with a field-level diff.
   - Errors are RFC 9457 problem details with a stable `type` per error and every invalid
     field at once (JSON Pointer per field), so a plan can show all problems in one run.
4. **Secrets are references, not values.** Settings that need a secret (OIDC client secret,
   SMTP password, DNS-01 credentials of ADR 0009) hold a reference to deployment
   configuration (the name of an environment variable or a secret file) and never the secret
   itself. `GET` can then return the full writable shape, declarative files contain no
   secret, and the secret never enters the database, the audit log or an export. Token
   secrets are the only secrets the API hands out, once (decision 5).
5. **Scoped tokens for automation, including admin scopes.**
   - A token carries scopes of the form `<area>:<read|write>`: user areas (`sites`,
     `account`, `tokens`) and admin areas (`admin:zones`, `admin:users`, `admin:settings`,
     `admin:blocklist`, `admin:tokens`, `moderation`).
   - What a token may do is the intersection of its scopes and its owner's role (A-07 policy
     matrix): a token never exceeds its owner, and admin scopes stop working the moment the
     owner loses the admin role. A token can create tokens only with a subset of its own
     scopes.
   - **Service accounts** are users of kind `service`: created by an admin, no password, no
     passkey, no interactive login, only tokens. Automation uses them instead of a person's
     account.
   - Tokens are shown once, stored hashed (ADR 0005), revocable, and an admin-scoped token
     has an expiry (an admin setting sets the maximum).
   - No automation path needs a browser login.
6. **CLI with full parity.** The `cli` crate covers every API operation: site commands at the
   top level (`deploy`, `site list|get|put|rm|extend`), account commands (`token`,
   `account`), and administration under `admin` (`admin zone|user|role|token|settings|blocklist
   ...`). Every command offers `--output json` (and `yaml`, `table` for people) and `--dry-run`
   for writes. It reads `STUFFCLOUD_URL`, `STUFFCLOUD_TOKEN` or `STUFFCLOUD_TOKEN_FILE`, and an
   optional CA file for instances with a private CA. Exit codes are documented and fixed:
   `0` success, `1` error, `2` changes present (only with `--detailed-exitcode`), `3`
   precondition failed (the resource changed since it was read), `4` usage error. A test
   compares the OpenAPI document with the CLI's command table and fails for an operation
   without a command; exceptions (decision 1) are listed in that test with a reason.
7. **Declarative configuration: `validate`, `plan`, `apply`.**
   - A configuration file (`stuffcloud.yaml`, YAML or JSON, with a `version` field) lists the
     desired resources by type, in the same shape as the API's writable shape. Its JSON
     Schema is generated from the same Rust types and published with each release.
   - `stuffcloud validate -f <file>` checks it offline with the `core` rules.
   - `stuffcloud plan -f <file>` reads every listed resource, asks the server for a dry run of
     each write and prints the diff; it changes nothing.
   - `stuffcloud apply -f <file>` does the same and then writes in dependency order (settings,
     zones, users, mappings, tokens, sites), each `PUT` with the `If-Match` from its own
     read, so a resource that changed in between stops the run with exit code `3` instead of
     being overwritten. A second `apply` of the same file reports nothing changed. It stops
     at the first error and reports what it applied; re-running is safe because every write
     is idempotent.
   - Resources that are not in the file are left alone. `--prune` deletes resources of the
     types the file lists but that it does not contain; the plan shows every deletion first.
   - The file never contains secrets (decision 4); passwords are never part of it, users are
     created as invited, OIDC-linked or service accounts.
   - With `--output json` and `--detailed-exitcode`, Ansible can report `changed` correctly
     and run in check mode (`plan`).
8. **Bootstrap without clicks.** A new instance can be brought up without the setup wizard:
   - the app address and all secrets come from environment variables, each also as a
     `_FILE` variant that reads the value from a file (Ansible templates, SOPS, Docker
     secrets);
   - on the first start with an empty database, the app creates the first admin (the local
     break-glass admin of ADR 0005) from `STUFFCLOUD_BOOTSTRAP_ADMIN_*` variables, optionally
     a service account with an admin-scoped token whose secret the operator supplies in a
     file (stored hashed; the file can be removed afterwards), and applies an optional
     bootstrap configuration file (decision 7) once;
   - on every later start these inputs are ignored with a log line; later changes go through
     the API, the CLI or `apply`;
   - the first-run setup in the UI stays available and uses the same API, but is never the
     only path.
9. **Zones and settings of ADR 0009 as declarative resources.**
   - A zone resource has the fields of ADR 0009 decision 3: `domain` (the key), `sub_level`,
     `enabled`, `hosting_roles`, `hosting_accounts` (allow-list by user login name; when set it
     replaces the role rule), `anonymous_hosting`, `public_sites`, `reserved_names`,
     `interstitial` and `dns_provider` (a reference, decision 4). The app address's label, when
     the app lies inside the site base, is a derived value in `meta`, not a writable field.
   - A write that would strand existing sites is refused with a problem detail that lists the
     affected sites, so a plan shows it before anything is applied: changing `sub_level` while
     the zone has sites, switching `public_sites` off while public sites exist, or reserving a
     name a site already uses. Disabling a zone is allowed (it then serves nothing, ADR 0009).
   - A site's visibility (`internal`/`public`) is a field of the site resource and passes the
     same `core` policy function as in the UI; anonymous sites stay internal (ADR 0009
     decision 4).
   - Instance-wide settings (sign-up mode, OIDC, SMTP, quota defaults, tool toggles, the
     instance-wide reserved names, legal and abuse contact) are the settings groups of
     decision 2, with the same `PUT`, `ETag` and dry-run rules.
10. **Ansible collection and OpenTofu provider on top of this API (SF9).**
    - Both use only the public API of decisions 2 to 5; they add no server-side code paths.
    - The Ansible collection ([#119](https://github.com/Mozra-the-great/stuffcloud/issues/119))
      starts when the API is stable; check mode maps to dry runs, diff mode to the server's
      diff.
    - The OpenTofu provider ([#120](https://github.com/Mozra-the-great/stuffcloud/issues/120))
      is built only once the rest of the stack and the API are finished and stable.
    - Where each of them lives (this repository or a separate one) is decided when it is
      built. A separate repository is not required and not assumed upfront (owner answer
      SF9); the naming convention the public provider registries expect for provider
      repositories is one input to that decision.
    - Until they exist, Ansible uses the CLI (`apply`, `plan` for check mode) or plain HTTP
      calls against the idempotent `PUT`s, and OpenTofu can use a generic REST provider.
    - The operator's own deployment (roles, inventories, secrets) stays in the operator's
      infrastructure repository, never here.
11. **The API is versioned.** `/api/v1` changes only additively; a breaking change needs
    `/api/v2`. Once a release contains the API, CI compares the generated OpenAPI document
    with the one of the last release and fails on a breaking change in `v1`.

Everything stays instance-neutral (CLAUDE.md): examples, fixtures and the example
configuration use only RFC 2606 names.

## Consequences

- Positive: an instance can be installed, configured, reviewed and reproduced as code; the
  admin UI and the automation see the same behaviour because they use the same endpoints.
- Positive: the web UI cannot grow features the API lacks, and the OpenAPI document is a
  complete description of the instance, which the generated TypeScript client, the CLI and
  the future collection and provider all build on.
- Positive: secrets never pass through the API or the database, so exports, backups and audit
  logs cannot leak them.
- Negative: every UI feature costs an endpoint, a CLI command and their tests; the parity and
  breaking-change checks have to be built and maintained (A-01, H-13).
- Negative: `PUT` with full replacement, `ETag`, dry-run and field diffs are more work per
  endpoint than ad-hoc handlers; they are built once as shared extractors and middleware in
  A-01 and tested there.
- Negative: changing a secret (OIDC, SMTP, DNS-01) means changing deployment configuration
  and restarting or reloading, not typing it into the admin UI.
- Negative: `apply` is not atomic across resources; a failed run can leave part of the file
  applied. It is safe to re-run, and the plan shows the work up front.
- The data model grows: user kind and login name, token name, scopes and expiry, ETags
  (SPEC 9).

## Open points

- Marking resources as "managed as code" (so the UI can warn before an edit that the next
  `apply` would revert) is decided with the admin UI (A-09,
  [#39](https://github.com/Mozra-the-great/stuffcloud/issues/39)).
- The tool for the OpenAPI breaking-change check: chosen in A-01, see "Addendum: A-01"
  below; the check becomes active with the first release that contains the API.
- Repository location of the Ansible collection and the OpenTofu provider: decided when each
  is built (decision 10).
- Owner question SF12: secrets only as references (decision 4) or also as write-only values
  that can be typed into the admin UI. Decision 4 holds until it is answered; write-only
  values could be added later without changing the resource shapes.

## Alternatives considered

- **API only for what the UI needs, CLI for sites only (SPEC up to now):** rejected by the
  owner (#116); the instance could not be configured as code.
- **A setup wizard as the only bootstrap path:** rejected; it needs a browser and a person and
  cannot be reproduced.
- **`POST` to create plus `PATCH` to change:** rejected as the primary write; a desired-state
  tool would need its own create-or-update logic and could not detect "unchanged" reliably.
  Actions that are not state stay `POST`.
- **Applying the configuration file on every start (GitOps from the container):** rejected;
  it would silently revert every change made through the UI or the API. A one-time bootstrap
  file plus an explicit `apply` keeps it visible.
- **One transactional bulk endpoint for `apply`:** not chosen for v1. Per-resource `PUT`s are
  what the collection and the provider need anyway; a bulk endpoint can be added later
  without breaking `v1`.
- **Secrets as write-only API values:** not chosen for now (owner question SF12); they cannot
  be returned by `GET`, so a plan cannot diff them, and they would enter the database.
- **Only Ansible `uri` and a generic REST provider, no own collection or provider (SF9
  option a):** rejected by the owner (SF9 c); they stay the interim path.

## Links

- [SPEC 6](../SPEC.md#6-users-roles-and-authentication), [9](../SPEC.md#9-data-model-sketch), [10](../SPEC.md#10-api-and-cli), [11](../SPEC.md#11-operations), [16](../SPEC.md#16-decisions-on-the-former-open-questions)
- Issues [#116](https://github.com/Mozra-the-great/stuffcloud/issues/116), [#31](https://github.com/Mozra-the-great/stuffcloud/issues/31) (A-01), [#37](https://github.com/Mozra-the-great/stuffcloud/issues/37) (A-07), [#38](https://github.com/Mozra-the-great/stuffcloud/issues/38) (A-08), [#39](https://github.com/Mozra-the-great/stuffcloud/issues/39) (A-09), [#46](https://github.com/Mozra-the-great/stuffcloud/issues/46) (H-02), [#57](https://github.com/Mozra-the-great/stuffcloud/issues/57) (H-13), [#60](https://github.com/Mozra-the-great/stuffcloud/issues/60) (H-16), [#119](https://github.com/Mozra-the-great/stuffcloud/issues/119), [#120](https://github.com/Mozra-the-great/stuffcloud/issues/120)
- [ADR 0004](0004-client-side-tools.md), [ADR 0005](0005-auth-model.md), [ADR 0009](0009-zone-model-and-shared-domain-isolation.md)

## Addendum: A-01 (2026-11-19)

How A-01 ([#31](https://github.com/Mozra-the-great/stuffcloud/issues/31)) built the conventions
of decision 3, and the choices it left open:

- **Shared building blocks.** The pure parts live in `core` (entity tags and `If-Match` /
  `If-None-Match`, the strict write query, writable documents with every field error and a JSON
  Pointer, the settings shapes), each with property tests and a fuzz target; storage in `db`
  (create-or-replace in one transaction, content-derived strong ETag, audit row only on a real
  change, dry runs that run the same statements and roll back); HTTP in `app/src/resource.rs`.
  The first resource is the settings group `reserved-names`.
- **Problem types** are documented in `docs/api/problems.md`; each `type` is the URL of its
  section there (the project's own repository, the only project-specific URL allowed).
- **Unknown query parameters are refused** (400), so a misspelt `?dryrun=true` can never become
  a real write. Request bodies must be `application/json` (415 otherwise).
- **Writes need authentication, which does not exist yet.** Until accounts (A-02) and the
  policy matrix (A-07) arrive, the production access policy allows reads and answers every
  write, dry runs included, with 401; the integration tests use a test policy. The instance is
  configured through the bootstrap file meanwhile. (A-07 has replaced this interim policy by the
  permission matrix, see the addendum "authorisation" in ADR 0005; reads of the settings groups
  stay public, writes need `admin:settings:write`.)
- **Bootstrap (decision 8).** The configuration file is applied once, in one transaction, on the
  first start with an empty database; JSON only until the CLI's `validate`/`plan`/`apply`
  (H-13, #57) brings YAML for the same format. `STUFFCLOUD_BOOTSTRAP_ADMIN_*` and
  `STUFFCLOUD_BOOTSTRAP_TOKEN_FILE` stop the app with a clear message until accounts (A-03) and
  tokens (A-08) exist: ignoring them would leave an operator without the admin they asked for. (A-03 creates the
  first admin from `STUFFCLOUD_BOOTSTRAP_ADMIN_*` since 2026-11-19, see the ADR 0005 addendum "local
  accounts"; the token file stays refused until A-08.)
- **OpenAPI breaking-change check: [`oasdiff`](https://github.com/oasdiff/oasdiff)**
  (Apache-2.0, a single static binary, `oasdiff breaking --fail-on ERR <last release> <new>`).
  It becomes a job of `build` with the first release that contains the API; until then the
  `openapi` job only enforces that the committed document and the TypeScript client match the
  handlers. Alternatives: `openapi-diff` (Apache-2.0, needs a Java runtime in CI) and
  `openapi-changes` (MIT, reports but does not classify breaking changes by severity).

## Addendum: write-only secrets (2026-11-19, SF12)

Owner question SF12 (open point 4 above) is answered with option b: configuration may still use
only references, **and** a secret can also be set as a write-only value through the API and the
admin UI. The value is never returned and never appears in plain text in the database, the audit
log, an export or `plan` output. The owner left the storage open and accepted the queue's
recommendation, recorded here. This addendum fills the gap in decision 4; it replaces nothing:
a reference stays a first-class way to supply a secret, and the declarative file still carries
no secret value.

**Which fields.** A field is a secret only if its Rust type is `Secret` (the list is code, shown
in the OpenAPI document with `format: secret`): the OIDC client secret and the SMTP password
(settings groups `oidc`, `smtp`), and later secrets of the same kind. The DNS-01 credentials of a
zone (ADR 0009 decision 3) stay a reference: Caddy needs them at boot, outside `app`, so a value
in the database could not reach it; this is revisited only if `app` ever pushes configuration to
the proxy.

**Shape in the API.** A secret field is a tagged object with exactly one of these forms (anything
else is a field error):

| Form | Meaning | Where allowed |
|---|---|---|
| `{"ref": "STUFFCLOUD_SECRET_SMTP"}` | the secret is the named deployment variable or `_FILE` (decision 4); a stored value of the field is deleted | API, UI, declarative file |
| `{"value": "..."}` | write-only: store this value | API, UI, CLI; **refused in a declarative file** (`validate` and `plan` fail) |
| `{"stored": true}` | keep the stored value; this is what `GET` returns for a stored secret, so `GET` then `PUT` leaves it as it is | API, UI, declarative file ("the UI or API owns it") |
| absent or `null` | no secret | everywhere |

- `GET` never returns the value, the ciphertext, a hash, a length or a fingerprint (a hash of a
  low-entropy secret can be guessed offline). `meta` carries when the secret was set and the key
  id only.
- A `value` write is always reported `updated`: the stored value cannot be compared with the
  request, and the new ciphertext uses a fresh nonce. `{"stored": true}` and a `ref` equal to
  the current one stay `unchanged`. A dry run says "secret would be replaced" or "kept", never
  the value, and `plan` prints the same words; a plan therefore cannot show drift of the secret
  itself, which is the price of write-only.
- Requirements: `admin:settings:write` for the group, as for any field of it; nothing grants
  reading a value, so no scope or role can.
- **A secret is bound to what it authenticates against.** A `PUT` that keeps a stored secret
  (`{"stored": true}`) but changes a binding field of the same group (SMTP host and port, the
  OIDC issuer and endpoints) is refused with the problem `secret-needs-reentry`: otherwise an
  admin-scoped token that cannot read the secret could send it to a server of its choosing.
- **A reference resolves only names with the prefix `STUFFCLOUD_SECRET_`** (and the matching
  `_FILE` form), never the encryption key variable or any other variable of the process. A
  reference to another name is a field error. This closes the same exfiltration path for
  references that the binding rule closes for stored values (an admin could otherwise name any
  variable of the process as the "SMTP password").

**Storage: AEAD-encrypted in the database.**

- Table `secrets` (owner kind and key, field name, key id, nonce, ciphertext, version, set-at):
  one row per stored secret, written in the same transaction as the settings row that points to
  it, so the configuration stays consistent, and a backup or export of the database holds only
  ciphertext.
- Cipher: **XChaCha20-Poly1305** (RustCrypto `chacha20poly1305`, MIT or Apache-2.0; its licence
  is checked against `deny.toml` and the licence policy when it is added). A fresh 24-byte nonce
  from the operating system's random source per write (192 bits make random nonces safe).
  Associated data = format tag, owner kind and key, field name and key id, so a ciphertext cannot
  be moved to another field, group or zone and still decrypt.
- Plaintext lives only in memory while it is used (opening the SMTP connection, the OIDC token
  request), in a `Secret` type that prints as `[redacted]` in `Debug` and `Display`, refuses to
  serialise, is zeroised on drop and is never part of an error, a log line, a metric label or a
  trace. Request bodies are never logged (already true) and the problem details of an invalid
  secret field name the field, never the value.
- The ETag of a group with a secret derives from the row version, not from the secret.
- Audit: a secret write is a normal `resource` audit entry (`secret.set`, `secret.clear`, owner
  and field name, the actor's internal id) and says nothing about the value.
- Export: the per-user export (SPEC 11) and any configuration export contain no secrets and no
  ciphertext; the `secrets` table is not part of any API response.

**The key: deployment configuration only.**

- `STUFFCLOUD_SECRETS_KEY_FILE` (or `STUFFCLOUD_SECRETS_KEY`, discouraged; the `_FILE`
  convention of decision 8): one or more lines `<key id>:<32 random bytes, base64>`. The first
  line is the **active** key (used to encrypt), the others only decrypt. Key ids are
  `[a-z0-9-]{1,32}`. The key is never stored in the database, a backup, the declarative file or
  the API. `stuffcloud-app secrets generate-key <id>` prints a fresh line to standard output and
  stores nothing.
- **Rotation without downtime and without re-entering secrets:** (1) generate a new key, put it
  on the first line, keep the old one below it, restart; (2) `stuffcloud-app secrets rewrap`
  (also `POST /api/v1/admin/secrets/rewrap`, scope `admin:settings:write`, CLI
  `admin secrets rewrap`) re-encrypts every row under the active key, in batches of one
  transaction each, and is safe to repeat; (3) when `secrets status` (counts per key id, no
  secret material) shows no row under the old key, remove its line. Old backups need the key
  they were written under: keep an old key as long as such a backup may still be restored.
  After a suspected key leak, re-wrapping is not enough: the secrets themselves must be replaced
  at their providers, because a leaked key opens every ciphertext made with it.
- **Key lost or wrong:** ciphertext without its key cannot be recovered, by design. The app still
  starts. The affected secrets are reported as `unavailable` (`meta`, a log warning per group,
  metric `stuffcloud_secrets_unavailable`; `/readyz` stays ready), the features that need them
  fail closed (no mail, no OIDC login; the local break-glass admin still works), and the admin
  sets the values again or switches to references.
- **No key configured:** write-only secrets are **disabled**, not weakened. A `value` is refused
  with the problem `secrets-not-configured`, the UI shows the field as unavailable with the
  reason, and nothing is ever stored unencrypted as a fallback. References and every other
  setting work exactly as before, so an instance that wants no secret in its database simply
  never configures a key. A stored secret found while no key is configured is `unavailable` as
  above.

**Residual risks (documented, accepted).** Whoever has the key and a copy of the database can
read the secrets, so the key must live where the database does not (a secret store, another file
system or host); as an environment variable it is exactly as exposed as a referenced secret. An
attacker who can run code in the app process sees the plaintext while it is in use, as with a
reference. The app trusts its admin to set a secret of their choosing; the binding rule only
stops an admin from *exfiltrating* one.

**Consequences.**

- Positive: the admin UI and automation can set or rotate OIDC and SMTP secrets without a
  deployment change and restart; backups and exports stay free of plaintext secrets; an instance
  without a key keeps the stricter references-only behaviour.
- Negative: one more piece of key management (generation, keeping the key apart from the
  database backup, rotation) for operators who use it; a lost key means re-entering secrets;
  `plan` cannot see drift of a stored secret; the `Secret` type, the `secrets` table, rewrap and
  the canary tests (a distinctive value must be absent from every response, log line, metric,
  audit row, export and problem detail, and from the database file except as ciphertext) are new
  code to build and keep green.
- Implementation: [#152](https://github.com/Mozra-the-great/stuffcloud/issues/152); the first
  consumers are A-09 ([#39](https://github.com/Mozra-the-great/stuffcloud/issues/39)) and A-10
  ([#40](https://github.com/Mozra-the-great/stuffcloud/issues/40)). Nothing of this is
  implemented yet.

**Alternatives considered (for the storage).**

- **Encrypted files next to the database:** rejected; they need the same key, add a second
  storage path to back up and keep consistent with the settings row, and cannot be written in one
  transaction with it.
- **The key in the database, or derived from an admin password:** rejected; a copy of the
  database would carry its own key.
- **Envelope encryption with an external KMS or Vault:** not required for a self-hosted
  single-binary tool; the key file can be fed by one, and a provider interface can be added later
  without changing the resource shapes.
- **AES-256-GCM:** equally sound, but with 96-bit random nonces it needs a nonce-reuse argument
  at scale; XChaCha20-Poly1305 has no such limit and no hardware dependency.
- **Hashing instead of encrypting:** impossible; the app has to present the secret to the SMTP
  server and the OIDC provider.
- **Only references (SF12 option a) or only write-only values (option c):** a is the behaviour
  without a key; c would give up the secret-free declarative file and the choice of operators who
  want no secret in their database at all.
