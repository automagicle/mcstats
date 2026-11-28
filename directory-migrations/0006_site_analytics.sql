-- Site analytics (/site-analytics, src/siteanalytics.js): numbers about mcstats itself, for the site's operators
-- (SUPER_ADMIN_EMAIL) and the accounts they let in. Nothing here names a visitor: devices are counted, never
-- identified, and the census of each server keeps hashes of its members' emails rather than the emails.

-- Accounts (besides the super admins) allowed to open /site-analytics. Only super admins change this.
CREATE TABLE site_viewers (
  email     TEXT PRIMARY KEY,           -- lowercased; access still needs a signed-in account with this address
  added_by  TEXT NOT NULL,
  added_at  INTEGER NOT NULL            -- unix seconds
);

-- Baselines the operator sets by hand for the account and server totals (their own test accounts, the servers
-- there were at launch…), drawn as a line on the charts and taken off for the "above baseline" numbers. The one
-- in force on a day is the latest from_day on or before it; a NULL from_day applies from the very start.
CREATE TABLE site_baselines (
  id        INTEGER PRIMARY KEY,
  metric    TEXT NOT NULL,              -- 'accounts' | 'servers'
  value     INTEGER NOT NULL,
  from_day  TEXT,                       -- YYYY-MM-DD (UTC), or NULL: from the start
  note      TEXT,
  set_by    TEXT NOT NULL,
  set_at    INTEGER NOT NULL
);
CREATE INDEX site_baselines_metric ON site_baselines (metric, from_day);

-- Counters by UTC day. A counter over a week or a month is kept on that period's first day (a Monday, the 1st):
--   dev:<a|s|b>:<d|w|m>  devices seen that day/week/month (a: any page, s: signed in, b: a server's dashboard),
--                        each counted once per period by the browser itself (public/visit.js)
--   dev:new              browsers seen for the first time
--   acct:<d|w|m>         accounts active that day/week/month (accounts.seen_day, src/account.js)
--   dl:<web|cli>:<file>  mod jar downloads from /downloads/ (one per address and file a day)
--   discord:guilds       Discord servers the bot is in, as Discord last said that day (set, not added to)
CREATE TABLE site_counts (
  day     TEXT NOT NULL,
  metric  TEXT NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
) WITHOUT ROWID;

-- The latest census of each server (src/census.js): counts and versions, as JSON, asked of its own objects.
CREATE TABLE server_census (
  server_id  TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  taken_at   INTEGER NOT NULL
);

-- The site's totals as they stood at the end of each UTC day (the last census of the day wins), for the
-- trends that can't be worked out afterwards from created_at alone.
CREATE TABLE site_snapshots (
  day       TEXT PRIMARY KEY,
  data      TEXT NOT NULL,
  taken_at  INTEGER NOT NULL
);

-- The last UTC day each account was signed in and used the site: how active accounts are counted. A day, not a time.
ALTER TABLE accounts ADD COLUMN seen_day TEXT;
