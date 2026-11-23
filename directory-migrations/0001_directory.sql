-- The directory: which servers exist, and nothing they record. Every server's stats, chat, members and
-- settings live in its own Durable Object (src/tenant.js); this only finds that object.

CREATE TABLE servers (
  id          TEXT PRIMARY KEY,          -- 16 hex characters, random; names the server's objects. Never changes.
  slug        TEXT NOT NULL UNIQUE,      -- /s/<slug>/; lowercase letters, digits and dashes
  name        TEXT NOT NULL,             -- what it's called on its pages
  join_salt   TEXT NOT NULL,             -- PBKDF2-SHA256 of the join password (base64url salt and hash)
  join_hash   TEXT NOT NULL,
  join_iter   INTEGER NOT NULL,
  owner_email TEXT NOT NULL,             -- who made it (lowercased)
  created_at  INTEGER NOT NULL           -- unix seconds
);
CREATE INDEX servers_owner ON servers(owner_email);

-- The mod's current key for each server, as a SHA-256 hash. The server's own object keeps the copy that
-- uploads are checked against (so a new key takes over at once); this one is the directory's record.
CREATE TABLE api_keys (
  server_id   TEXT PRIMARY KEY REFERENCES servers(id),
  key_hash    TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- How far making each server has got on /new, so it can be picked up again.
CREATE TABLE wizard (
  server_id   TEXT PRIMARY KEY REFERENCES servers(id),
  step        INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Sign-in codes for /new (making and setting up servers), hashed; one waiting code per address.
CREATE TABLE login_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  tries       INTEGER NOT NULL DEFAULT 0
);
