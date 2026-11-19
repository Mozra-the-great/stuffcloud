-- Initial schema (A-01). Applied once by the migration runner (src/migrate.rs); never edit
-- an applied migration, add a new file instead (the runner refuses a changed checksum).

-- Configurable resources that are stored as documents: the settings groups of ADR 0010.
-- `body` is the canonical JSON of the writable shape, `etag` the strong entity tag derived
-- from it. Times are Unix milliseconds (UTC).
CREATE TABLE resources (
    id          INTEGER PRIMARY KEY,
    kind        TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    etag        TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (kind, key)
) STRICT;

-- Every change of a resource. An unchanged write and a dry run add no row. `actor` is the
-- acting account once accounts exist (A-02); NULL for the bootstrap and the operator.
CREATE TABLE audit_log (
    id      INTEGER PRIMARY KEY,
    at      INTEGER NOT NULL,
    actor   TEXT,
    action  TEXT    NOT NULL,
    kind    TEXT    NOT NULL,
    key     TEXT    NOT NULL
) STRICT;

-- Facts about the instance itself, such as when the bootstrap ran (SPEC 10.7).
CREATE TABLE instance_state (
    name   TEXT PRIMARY KEY,
    value  TEXT NOT NULL
) STRICT;
