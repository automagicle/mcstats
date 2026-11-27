// Which mcstats server a Discord request is about, and reading that server's stats.
//
// Which server is only ever decided here: from the guild an interaction came from (DIRECTORY.discord_guilds),
// or from the server's own address for the dashboard and the install callback. Nothing in a command's options
// picks a server.
//
// The bot reads a server as a viewer (DISCORD.md, "The bot is a viewer"): the same API the dashboard uses,
// asked with X-MCS-Who { viewer: true }, which only code inside the site can send (the Worker strips X-MCS-
// headers from every request that comes in). Hidden players, aliases, seasons, chat resets and deleted chat
// apply to Discord exactly as they do on the page. On top of that, what the server's owner doesn't share with
// Discord (discord_config.share) is never read at all.
import { serverById } from '../directory.js';
import { remoteDb } from '../sql.js';
import { tenantEnv, tenantStub } from '../tenantenv.js';
import { currentSeason } from '../seasons.js';
import { getConfig, getLink } from './store.js';

const VIEWER = JSON.stringify({ viewer: true, email: null });

export class ViewError extends Error {
  constructor(status) {
    super(`stats API answered ${status}`);
    this.status = status;
  }
}

export async function guildServerId(env, guildId) {
  if (!guildId) return null;
  const g = await env.DIRECTORY.prepare('SELECT server_id FROM discord_guilds WHERE guild_id = ?').bind(guildId).first();
  return g?.server_id ?? null;
}

// The server a guild is linked to, opened (below), or null. A link whose server's own record of it disagrees
// (unlinked there, or linked to another guild since) doesn't count.
export async function serverForGuild(env, guildId, origin) {
  const id = await guildServerId(env, guildId);
  const row = id ? await serverById(env, id) : null;
  if (!row) return null;
  const srv = await openServer(env, row, origin);
  if (srv.link?.guild_id !== guildId) return null;
  return srv;
}

// Everything a command needs about one server.
export async function openServer(env, row, origin) {
  const stub = tenantStub(env, row.id);
  const db = remoteDb(stub);
  const gate = await stub.gate({ viewer: true, email: null });
  const settings = gate.settings;
  const isPublic = settings.PUBLIC === '1';
  const [config, link] = await Promise.all([getConfig(db, isPublic), getLink(db)]);
  const season = currentSeason(settings);
  return {
    row, stub, db, settings, tenant: gate.tenant, config, link, isPublic, season,
    name: settings.NAME || row.name,
    tz: settings.TZ_NAME || 'UTC',
    hasMod: !!settings.FIRST_UPLOAD_AT,
    page: `${origin}/${row.slug}`,
    // this server's env, the way its own code expects it (link.js, roles.js and the rest)
    env: tenantEnv(env, gate.tenant, db, settings),
    view: (path) => view(stub, path),
  };
}

async function view(stub, path) {
  const res = await stub.fetch(new Request(`https://tenant${path}`, { headers: { 'X-MCS-Who': VIEWER } }));
  if (!res.ok) throw new ViewError(res.status);
  return res.json();
}

// Links a guild to a server in the directory. Refuses when the guild is already another server's.
// A server linked to another guild before is moved: its old guild's row goes.
export async function linkGuild(env, guildId, serverId, by) {
  const had = await guildServerId(env, guildId);
  if (had && had !== serverId) return { error: 'taken' };
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare('DELETE FROM discord_guilds WHERE server_id = ? AND guild_id != ?').bind(serverId, guildId),
    env.DIRECTORY.prepare(
      `INSERT INTO discord_guilds (guild_id, server_id, linked_at, linked_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET linked_by = excluded.linked_by`
    ).bind(guildId, serverId, Math.floor(Date.now() / 1000), by),
  ]);
  return { ok: true };
}

export async function unlinkGuild(env, serverId) {
  await env.DIRECTORY.prepare('DELETE FROM discord_guilds WHERE server_id = ?').bind(serverId).run();
}
