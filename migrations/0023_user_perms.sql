-- What each sign-in may do, set by a super admin on Admin → Roles (src/roles.js). A row is only here for
-- someone whose permissions were changed: everyone else has the defaults (anyone let in can look and, if
-- they're on the roster, chat; the ADMIN_EMAIL logins also get the admin page and Liveview).
-- Super admins (the SUPER_ADMIN_EMAIL secret) can do everything, whatever is here.
--
-- Liveview has a second lock that isn't here: the Minecraft server keeps its own list of accounts that
-- may watch or control (the mod's config/mcstats-liveview.json). An account needs both.
CREATE TABLE user_perms (
  email       TEXT PRIMARY KEY,            -- the Cloudflare Access login, lowercased
  view        INTEGER NOT NULL DEFAULT 1,  -- see the dashboard at all
  chat        INTEGER NOT NULL DEFAULT 1,  -- send chat and whispers from it (still needs a roster email)
  admin       INTEGER NOT NULL DEFAULT 0,  -- the admin page: settings and analytics (not roles)
  liveview    INTEGER NOT NULL DEFAULT 0,  -- watch through Liveview, once the server lets the account in
  liveview_op INTEGER NOT NULL DEFAULT 0,  -- Liveview's controls, once the server allows them for the account
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);
