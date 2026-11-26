-- mcstats accounts: one per email address, with a password. Signing in is site-wide (src/account.js); what an
-- account may do on a server is still that server's own business (its user_perms, by email).

CREATE TABLE accounts (
  id             TEXT PRIMARY KEY,        -- 32 hex characters, random. Never changes.
  email          TEXT NOT NULL UNIQUE,    -- lowercased; proven with an emailed code before the account exists
  pw_hash        TEXT,                    -- src/password.js: "v1$<rounds>$<salt>$<hash>". Never the password.
                                          -- NULL is for an account with no password (signing in with Google or
                                          -- Discord, later): it can't be signed in to with one.
  created_at     INTEGER NOT NULL,        -- unix seconds
  pw_changed_at  INTEGER
);

-- Where an account is signed in. The cookie holds a random token; only its SHA-256 is kept here, so reading
-- this table gives nobody a session. Deleting a row signs that browser out.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- Codes sent before accounts existed signed in by themselves; none of them should still work.
DELETE FROM login_codes;
