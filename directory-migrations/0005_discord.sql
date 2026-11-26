-- The Discord bot (DISCORD.md): which mcstats server each Discord server ("guild") is linked to. Every
-- interaction Discord sends names only its guild, so this is looked up before anything else, the way a page's
-- address is looked up in `servers`. Everything else about Discord is the server's own (its Tenant, schema v7).
CREATE TABLE discord_guilds (
  guild_id   TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL,
  linked_at  INTEGER NOT NULL,
  linked_by  TEXT NOT NULL
);
CREATE INDEX discord_guilds_server ON discord_guilds (server_id);
