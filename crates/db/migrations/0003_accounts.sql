-- Local accounts (A-03, ADR 0005 addendum "local accounts"). Applied once by the migration
-- runner; never edit an applied migration, add a new file instead.
--
-- Tokens are stored only as SHA-256 hashes, like session tokens. No table stores an IP address.

-- At most one password per account (`credentials.data` holds its Argon2id PHC string).
CREATE UNIQUE INDEX credentials_one_password ON credentials (user_id) WHERE kind = 'password';

-- Lookups by e-mail address (stored in lowercase) for the login form.
CREATE INDEX users_by_email ON users (email);

-- Invitations of the sign-up mode `invite-only`: single use (the row is deleted when an account
-- is registered with it or an admin revokes it), with an expiry, optionally for one e-mail
-- address only.
CREATE TABLE invitations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash  BLOB    NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    email       TEXT,
    created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
) STRICT;

-- Password reset tokens: single use (the row is deleted when redeemed), short-lived, at most
-- one per account (a new one replaces the old). Issued by an admin or the operator's CLI now,
-- by the self-service flow over e-mail with A-10.
CREATE TABLE password_resets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash  BLOB    NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    user_id     INTEGER NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
) STRICT;
