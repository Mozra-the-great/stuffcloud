-- Auth data model (A-02, ADR 0005 and its addendum). Applied once by the migration runner;
-- never edit an applied migration, add a new file instead.
--
-- Times are Unix milliseconds (UTC). Secrets are never stored: session and CSRF tokens only as
-- SHA-256 hashes, passwords only as Argon2id hashes (A-03), recovery codes only as hashes.
-- No table stores a client IP address (SPEC 13).

-- Accounts. `login` is the natural key of the user resource (SPEC 10.2); its rules come with
-- the account flows (A-03, #33). `role` is one of the three stored roles (anonymous clients
-- have no account); the permission matrix is A-07 (#37). Service accounts (SPEC 10.4) have no
-- interactive login and therefore never get a session.
CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    login       TEXT    NOT NULL UNIQUE,
    kind        TEXT    NOT NULL CHECK (kind IN ('person', 'service')),
    role        TEXT    NOT NULL CHECK (role IN ('user', 'moderator', 'admin')),
    email       TEXT    UNIQUE,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
) STRICT;

-- Login credentials of an account (A-03 password, A-04 passkey, A-05 TOTP). `data` is the
-- kind-specific stored form (a password hash, a passkey's public key and counter, the TOTP
-- secret as decided in A-05), never a plaintext password.
CREATE TABLE credentials (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind          TEXT    NOT NULL CHECK (kind IN ('password', 'passkey', 'totp')),
    label         TEXT,
    data          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
) STRICT;
CREATE INDEX credentials_by_user ON credentials (user_id);

-- Accounts linked to an OIDC provider (A-06): one row per issuer and subject.
CREATE TABLE oidc_identities (
    id             INTEGER PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    issuer         TEXT    NOT NULL,
    subject        TEXT    NOT NULL,
    created_at     INTEGER NOT NULL,
    last_login_at  INTEGER,
    UNIQUE (issuer, subject)
) STRICT;
CREATE INDEX oidc_identities_by_user ON oidc_identities (user_id);

-- One-time recovery codes for the second factor (A-05), stored as hashes.
CREATE TABLE recovery_codes (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash   BLOB    NOT NULL CHECK (length(code_hash) = 32),
    created_at  INTEGER NOT NULL,
    used_at     INTEGER,
    UNIQUE (user_id, code_hash)
) STRICT;

-- Browser sessions. Ids are never reused (AUTOINCREMENT), so an id in the audit log always
-- names one session; the same holds for `users`. `token_hash` is SHA-256 of the session token
-- in the `__Host-` cookie, `csrf_hash` SHA-256 of the CSRF token bound to the session. The idle and absolute timeouts
-- are deployment configuration and are applied to `last_seen_at` and `created_at` on every
-- lookup, so a shorter timeout takes effect at once.
CREATE TABLE sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash    BLOB    NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    csrf_hash     BLOB    NOT NULL CHECK (length(csrf_hash) = 32),
    user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_by_user ON sessions (user_id);

-- Security events (logins, logouts, expiry, rotation, role changes) share the audit log with
-- the resource changes; `category` tells them apart. Rows hold internal ids only: no login
-- name, e-mail address, token or IP address.
ALTER TABLE audit_log ADD COLUMN category TEXT NOT NULL DEFAULT 'resource'
    CHECK (category IN ('resource', 'security'));
