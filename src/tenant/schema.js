// Each server's own database: the migrations every Tenant object runs on its SQLite when it starts.
//
// The version reached is kept in _meta (schema_version). A migration runs in one transaction together with
// raising that number, so it either happens completely or not at all, and each is also written to be
// harmless if it ran again (IF NOT EXISTS, and columns added only when missing).
//
// Version 1 is the D1 database's tables as migrations/0001-0023 left them, in one step. Two of those
// migrations also put rows in for the first server (a hidden player, an alias); those are that server's data,
// so they aren't here: its rows arrive with the rest of its data (scripts/copy-tenant.mjs). The data repairs
// (0002, 0010, 0022) have nothing to repair in a new database and aren't here either.
// test/schema.test.js checks that version 1 gives every table the same columns as the D1 migrations do.
//
// To change the schema later: add { v: next number, up(sql) { ... } } at the end. Never edit one that's out.

const V1 = `
CREATE TABLE IF NOT EXISTS snapshots (
  ts      INTEGER PRIMARY KEY,
  up      INTEGER NOT NULL,
  online  INTEGER NOT NULL,
  max     INTEGER,
  listed  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hourly (
  hour_ts     INTEGER PRIMARY KEY,
  samples     INTEGER NOT NULL,
  up_samples  INTEGER NOT NULL,
  online_sum  INTEGER NOT NULL,
  peak        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  uuid        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  first_seen  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id        INTEGER PRIMARY KEY,
  uuid      TEXT NOT NULL,
  start_ts  INTEGER NOT NULL,
  end_ts    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_end ON sessions(end_ts);
CREATE INDEX IF NOT EXISTS sessions_uuid ON sessions(uuid, start_ts);

CREATE TABLE IF NOT EXISTS chat (
  id        INTEGER PRIMARY KEY,
  event_id  TEXT NOT NULL UNIQUE,
  ts_ms     INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  uuid      TEXT,
  name      TEXT,
  display   TEXT,
  text      TEXT NOT NULL,
  rich      TEXT,
  via       TEXT,
  hidden    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chat_ts ON chat(ts_ms, id);
CREATE INDEX IF NOT EXISTS chat_uuid ON chat(uuid, ts_ms);
CREATE INDEX IF NOT EXISTS chat_kind ON chat(kind, ts_ms);

CREATE TABLE IF NOT EXISTS roster (
  season INTEGER NOT NULL,
  ign TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  team TEXT NOT NULL,
  egg TEXT,
  PRIMARY KEY (season, ign)
);
CREATE TABLE IF NOT EXISTS gear (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  uuid TEXT,
  ts INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roster_email (
  season INTEGER NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  ign TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (season, email)
);

CREATE TABLE IF NOT EXISTS deaths (
  id          INTEGER PRIMARY KEY,
  ts_ms       INTEGER NOT NULL,
  victim      TEXT NOT NULL COLLATE NOCASE,
  victim_uuid TEXT,
  killer      TEXT COLLATE NOCASE,
  killer_uuid TEXT,
  mob         TEXT,
  cause       TEXT,
  weapon      TEXT,
  uncounted   INTEGER NOT NULL DEFAULT 0,
  attr_note   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS deaths_ts ON deaths(ts_ms);
CREATE INDEX IF NOT EXISTS deaths_todo ON deaths(id) WHERE cause IS NULL;

CREATE TABLE IF NOT EXISTS advancement_tree (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  ts   INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS advancements (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  uuid TEXT,
  ts   INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hidden_players (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  note TEXT
);
CREATE TABLE IF NOT EXISTS player_aliases (
  alias TEXT PRIMARY KEY COLLATE NOCASE,
  name  TEXT NOT NULL COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS server_online (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  ts       INTEGER NOT NULL,
  players  TEXT NOT NULL,
  stopping INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deleted_chat (
  event_id   TEXT PRIMARY KEY,
  id         INTEGER NOT NULL,
  ts_ms      INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL,
  chat       TEXT NOT NULL,
  death      TEXT
);
CREATE TABLE IF NOT EXISTS cache (
  key   TEXT PRIMARY KEY,
  ts    INTEGER NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whispers (
  id      INTEGER PRIMARY KEY,
  ts_ms   INTEGER NOT NULL,
  sender  TEXT NOT NULL COLLATE NOCASE,
  target  TEXT NOT NULL COLLATE NOCASE,
  text    TEXT NOT NULL,
  via     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS whispers_sender ON whispers (sender, ts_ms);
CREATE INDEX IF NOT EXISTS whispers_target ON whispers (target, ts_ms);

CREATE TABLE IF NOT EXISTS teams (
  season        INTEGER NOT NULL,
  id            TEXT NOT NULL,
  name          TEXT NOT NULL,
  short         TEXT NOT NULL,
  color         TEXT NOT NULL,
  color_dark    TEXT,
  sort          INTEGER NOT NULL DEFAULT 0,
  show_bar      INTEGER NOT NULL DEFAULT 1,
  show_chart    INTEGER NOT NULL DEFAULT 1,
  show_activity INTEGER NOT NULL DEFAULT 1,
  activity_with TEXT,
  PRIMARY KEY (season, id)
);
CREATE TABLE IF NOT EXISTS team_history (
  season INTEGER NOT NULL,
  ign    TEXT NOT NULL COLLATE NOCASE,
  until  INTEGER NOT NULL,
  team   TEXT NOT NULL,
  PRIMARY KEY (season, ign, until)
);

CREATE TABLE IF NOT EXISTS site_visits (
  day     TEXT    NOT NULL,
  visitor TEXT    NOT NULL,
  page    TEXT    NOT NULL,
  views   INTEGER NOT NULL DEFAULT 0,
  minutes INTEGER NOT NULL DEFAULT 0,
  mobile  INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER NOT NULL,
  PRIMARY KEY (day, visitor, page)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS site_visits_visitor ON site_visits (visitor, day);

CREATE TABLE IF NOT EXISTS chat_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  kind       TEXT,
  match      TEXT NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  from_ms    INTEGER,
  to_ms      INTEGER,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_perms (
  email       TEXT PRIMARY KEY,
  view        INTEGER NOT NULL DEFAULT 1,
  chat        INTEGER NOT NULL DEFAULT 1,
  admin       INTEGER NOT NULL DEFAULT 0,
  liveview    INTEGER NOT NULL DEFAULT 0,
  liveview_op INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);
`;

// What only a server of its own needs: who belongs to it (user_perms gains a role: owner, admin, member),
// its settings (what used to be the Worker's vars and secrets), its mod keys, and sign-in codes.
const V2 = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- The mod's key, as a SHA-256 hash. Making a new one deletes the old row in the same transaction.
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash   TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
-- Sign-in codes sent by email, hashed; one waiting code per address.
CREATE TABLE IF NOT EXISTS login_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0
);
`;

const hasColumn = (sql, table, column) => sql.exec(`PRAGMA table_info(${table})`).toArray().some((c) => c.name === column);

export const MIGRATIONS = [
  { v: 1, up(sql) { sql.exec(V1); } },
  {
    v: 2,
    up(sql) {
      sql.exec(V2);
      if (!hasColumn(sql, 'user_perms', 'role')) sql.exec("ALTER TABLE user_perms ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
    },
  },
  {
    // Eggs became an add-on (src/addons.js). The first server (the one copied in from before servers had
    // their own) is Egg SMP, which had them all along: it keeps them. Any other server starts without.
    v: 3,
    up(sql) {
      sql.exec("INSERT OR IGNORE INTO settings (key, value) SELECT 'ADDONS', 'eggsmp' FROM settings WHERE key = 'LEGACY' AND value = '1'");
    },
  },
  {
    // The server's icon, uploaded on Admin → Server (src/layout.js): one square PNG, served at /api/icon.
    v: 4,
    up(sql) {
      sql.exec('CREATE TABLE IF NOT EXISTS server_icon (id INTEGER PRIMARY KEY CHECK (id = 1), png BLOB NOT NULL, updated_at INTEGER NOT NULL)');
    },
  },
  {
    // Players connecting their mcstats account from in game (/mcstats connect, src/connect.js): one row per
    // player, with the email they typed. It counts once someone signed in with that email says yes on the
    // website (confirmed_at); until then it's only a request. tries/tries_day: requests made today.
    v: 5,
    up(sql) {
      playerAccounts(sql);
    },
  },
  {
    // Who chats from the dashboard as Admin is picked on Admin → Roles (src/roles.js): 1 here means this
    // member sends as Admin whatever player their email is linked to.
    // Both this and player_accounts were first written as version 5, on two branches: a database that ran
    // either one as its 5 gets the other here (each only adds what's missing).
    v: 6,
    up(sql) {
      playerAccounts(sql);
      if (!hasColumn(sql, 'user_perms', 'chat_admin')) sql.exec('ALTER TABLE user_perms ADD COLUMN chat_admin INTEGER NOT NULL DEFAULT 0');
    },
  },
];

// The table behind /mcstats connect (src/connect.js). Only adds what is missing.
function playerAccounts(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS player_accounts (
    uuid          TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL COLLATE NOCASE,
    requested_at  INTEGER NOT NULL,
    confirmed_at  INTEGER,
    tries         INTEGER NOT NULL DEFAULT 0,
    tries_day     INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS player_accounts_email ON player_accounts (email)');
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].v;

// Brings this object's database up to date. Returns the version it was at before.
export function migrate(storage) {
  const sql = storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = sql.exec("SELECT value FROM _meta WHERE key = 'schema_version'").toArray()[0];
  const from = row ? Number(row.value) : 0;
  for (const m of MIGRATIONS) {
    if (m.v <= from) continue;
    storage.transactionSync(() => {
      m.up(sql);
      sql.exec("INSERT INTO _meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(m.v));
    });
  }
  return from;
}

// Every table that holds the server's data (for copying it in and counting it), in an order where nothing
// refers to a table that comes later.
export const DATA_TABLES = [
  'snapshots', 'hourly', 'players', 'sessions', 'chat', 'roster', 'gear', 'roster_email', 'deaths',
  'advancement_tree', 'advancements', 'hidden_players', 'player_aliases', 'server_online', 'deleted_chat',
  'whispers', 'teams', 'team_history', 'site_visits', 'chat_rules', 'user_perms',
];
