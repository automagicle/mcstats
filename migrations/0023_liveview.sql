-- Liveview (src/liveview.js): which sign-in emails have entered the server's keys.
--
-- The keys live on the Minecraft server (the mod keeps only their hashes) and the mod checks each one typed
-- on the dashboard. What's kept here is which key an account was let in with: the key's id, a random value
-- the mod gives each key, not the key. An account can watch while view_key is the server's current viewer
-- key, and can run commands and move items while control_key is its current control key; making a new key
-- in game (/liveview key viewer, /liveview key control) changes the id, so every account has to enter it again.
CREATE TABLE liveview_access (
  email       TEXT PRIMARY KEY,   -- the Cloudflare Access login, lowercased
  view_key    TEXT,               -- id of the viewer key this account entered, or NULL
  view_at     INTEGER,            -- when (unix seconds)
  control_key TEXT,               -- id of the control key this account entered, or NULL
  control_at  INTEGER
);
