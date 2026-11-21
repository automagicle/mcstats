-- Rules an admin sets for which chat log lines are left out (src/chatrules.js). A line is hidden when
-- a "hide" rule matches it and no "show" rule does. Each rule can be limited to one kind of line, to
-- text that is / starts with / contains / ends with something, and to a stretch of time.
CREATE TABLE chat_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,            -- 'hide' | 'show'
  kind       TEXT,                     -- chat.kind, or NULL for every kind
  match      TEXT NOT NULL,            -- 'any' | 'exact' | 'starts' | 'contains' | 'ends'
  text       TEXT NOT NULL DEFAULT '', -- what to match (ignoring case); '' with match = 'any'
  from_ms    INTEGER,                  -- only lines at or after this (unix ms), or NULL
  to_ms      INTEGER,                  -- only lines before this, or NULL
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- 1 for a line the rules hide. Kept up to date when lines arrive and whenever the rules change, so
-- reading the log only has to skip them.
ALTER TABLE chat ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
