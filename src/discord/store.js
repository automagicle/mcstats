// What a server keeps about Discord, in its own database (src/tenant/schema.js v7). Everything takes a
// D1-shaped `db`, so it runs inside the server's Tenant (localDb) and from the Worker or the relay (remoteDb).
//
//   discord_link     the Discord server ("guild") this server is linked to: one at most
//   discord_codes    link codes made on Admin → Discord, for /mcstats setup (hashed, used once)
//   discord_config   share (what may go to Discord at all), commands, bridge: JSON each
//   discord_feeds    where each feed goes: its channel, its webhook, its options, how it's doing
//   discord_players  Discord users linked to players here
import { sha256Hex } from '../session.js';
import { isSnowflake } from './api.js';

export const FEEDS = ['status', 'events', 'chat', 'digest'];
export const EVENT_KINDS = ['joins', 'deaths', 'advancements', 'server', 'season'];
export const SHARE_KEYS = ['online', 'stats', 'deaths', 'advancements', 'chat', 'joinlink'];
const now = () => Math.floor(Date.now() / 1000);

// What a server shares until its owner says otherwise: a public server everything but chat (and its join link,
// which it doesn't need); a private one only who's online.
export function defaultShare(isPublic) {
  return { online: true, stats: !!isPublic, deaths: !!isPublic, advancements: !!isPublic, chat: false, joinlink: false };
}
const DEFAULT_COMMANDS = { on: true, ephemeral: false };
const DEFAULT_BRIDGE = { say: 'off' }; // off | linked | anyone

export const DEFAULT_OPTIONS = {
  status: {},
  events: Object.fromEntries(EVENT_KINDS.map((k) => [k, true])),
  chat: { teams: false },
  digest: { hour: 9 },
};

// The presets on Admin → Discord and in /mcstats setup (DISCORD.md, "Presets"): which feeds each switches on,
// and what each one needs shared.
export const PRESETS = {
  commands: { label: 'Just commands', feeds: [], needs: [] },
  status: { label: 'Status board', feeds: ['status', 'digest'], needs: ['online'] },
  community: { label: 'Community', feeds: ['status', 'events', 'digest'], needs: ['online'] },
  bridge: { label: 'Full bridge', feeds: ['status', 'events', 'chat', 'digest'], needs: ['online', 'chat'] },
};
// The channel each feed goes to when "Make the channels for me" makes them.
export const CHANNEL_NAMES = { status: 'server-status', events: 'mc-events', chat: 'mc-chat', digest: 'server-status' };

const parse = (s, fallback) => { try { return { ...fallback, ...JSON.parse(s) }; } catch { return { ...fallback }; } };

export async function getLink(db) {
  return (await db.prepare('SELECT guild_id, guild_name, guild_icon, linked_at, linked_by, broken FROM discord_link WHERE id = 1').first()) ?? null;
}

export async function setLink(db, { guild_id, guild_name = null, guild_icon = null, by }) {
  await db.prepare(
    `INSERT INTO discord_link (id, guild_id, guild_name, guild_icon, linked_at, linked_by, broken) VALUES (1, ?1, ?2, ?3, ?4, ?5, NULL)
     ON CONFLICT(id) DO UPDATE SET guild_id = excluded.guild_id, guild_name = excluded.guild_name, guild_icon = excluded.guild_icon,
       linked_at = CASE WHEN discord_link.guild_id = excluded.guild_id THEN discord_link.linked_at ELSE excluded.linked_at END,
       linked_by = excluded.linked_by, broken = NULL`
  ).bind(guild_id, guild_name, guild_icon, now(), by).run();
}

export async function setBroken(db, why) {
  await db.prepare('UPDATE discord_link SET broken = ? WHERE id = 1').bind(why ? String(why).slice(0, 200) : null).run();
}

// Unlinking forgets the feeds (their webhooks are deleted on Discord's side by the caller) but keeps what's
// shared and the linked players, so linking again carries on.
export async function clearLink(db) {
  await db.batch([db.prepare('DELETE FROM discord_link'), db.prepare('DELETE FROM discord_feeds')]);
}

export async function getConfig(db, isPublic) {
  const { results } = await db.prepare('SELECT key, value FROM discord_config').all();
  const raw = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return {
    share: parse(raw.share, defaultShare(isPublic)),
    commands: parse(raw.commands, DEFAULT_COMMANDS),
    bridge: parse(raw.bridge, DEFAULT_BRIDGE),
  };
}

// patch: { share?, commands?, bridge? }, each merged over what's there. Unknown keys are dropped.
export async function setConfig(db, isPublic, patch) {
  const have = await getConfig(db, isPublic);
  const out = [];
  if (patch.share) {
    const share = { ...have.share };
    for (const k of SHARE_KEYS) if (typeof patch.share[k] === 'boolean') share[k] = patch.share[k];
    share.online = true; // the least a linked server shares: who's online (otherwise there's nothing to link)
    out.push(['share', share]);
  }
  if (patch.commands) {
    const c = { ...have.commands };
    if (typeof patch.commands.on === 'boolean') c.on = patch.commands.on;
    if (typeof patch.commands.ephemeral === 'boolean') c.ephemeral = patch.commands.ephemeral;
    out.push(['commands', c]);
  }
  if (patch.bridge) {
    const b = { ...have.bridge };
    if (['off', 'linked', 'anyone'].includes(patch.bridge.say)) b.say = patch.bridge.say;
    out.push(['bridge', b]);
  }
  if (out.length) {
    const stmt = db.prepare('INSERT INTO discord_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    await db.batch(out.map(([k, v]) => stmt.bind(k, JSON.stringify(v))));
  }
  return getConfig(db, isPublic);
}

// Feeds: { feed: { channel_id, webhook_id, webhook_token, options, last_ok, last_error, last_error_at } }.
// secrets: false leaves the webhook token out (for anything that goes to a page).
export async function getFeeds(db, { secrets = false } = {}) {
  const { results } = await db.prepare('SELECT * FROM discord_feeds').all();
  const out = {};
  for (const r of results) {
    if (!FEEDS.includes(r.feed)) continue;
    out[r.feed] = {
      channel_id: r.channel_id, webhook_id: r.webhook_id, options: parse(r.options, DEFAULT_OPTIONS[r.feed]),
      last_ok: r.last_ok, last_error: r.last_error, last_error_at: r.last_error_at,
      ...(secrets ? { webhook_token: r.webhook_token } : {}),
    };
  }
  return out;
}

// Options for one feed, with only the keys it has.
export function cleanOptions(feed, o = {}) {
  const base = DEFAULT_OPTIONS[feed];
  const out = { ...base };
  for (const [k, v] of Object.entries(o || {})) {
    if (!(k in base)) continue;
    if (k === 'hour') {
      const h = Number(v);
      if (Number.isInteger(h) && h >= 0 && h <= 23) out.hour = h;
    } else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export async function putFeed(db, feed, { channel_id, webhook_id = null, webhook_token = null, options }) {
  if (!FEEDS.includes(feed) || !isSnowflake(channel_id)) throw new Error('bad feed');
  await db.prepare(
    `INSERT INTO discord_feeds (feed, channel_id, webhook_id, webhook_token, options) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(feed) DO UPDATE SET channel_id = excluded.channel_id, webhook_id = excluded.webhook_id,
       webhook_token = excluded.webhook_token, options = excluded.options, last_error = NULL, last_error_at = NULL`
  ).bind(feed, channel_id, webhook_id, webhook_token, JSON.stringify(cleanOptions(feed, options))).run();
}

export async function setFeedOptions(db, feed, options) {
  await db.prepare('UPDATE discord_feeds SET options = ? WHERE feed = ?').bind(JSON.stringify(cleanOptions(feed, options)), feed).run();
}

export async function dropFeed(db, feed) {
  await db.prepare('DELETE FROM discord_feeds WHERE feed = ?').bind(feed).run();
}

// How a feed's last post went.
export async function noteFeed(db, feed, error = null) {
  if (error) await db.prepare('UPDATE discord_feeds SET last_error = ?, last_error_at = ? WHERE feed = ?').bind(String(error).slice(0, 200), now(), feed).run();
  else await db.prepare('UPDATE discord_feeds SET last_ok = ?, last_error = NULL, last_error_at = NULL WHERE feed = ?').bind(now(), feed).run();
}

// ---- link codes (Way 2: /mcstats setup server: code:) ----

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const CODE_MINUTES = 15;
const codeHash = (code) => sha256Hex(`discord-link\u0000${code}`);
export const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// A new code like K7QM-2XPA; any earlier one stops working.
export async function newCode(db, by) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const raw = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  await db.batch([
    db.prepare('DELETE FROM discord_codes'),
    db.prepare('INSERT INTO discord_codes (hash, made_by, expires_at) VALUES (?, ?, ?)').bind(await codeHash(raw), by, now() + CODE_MINUTES * 60),
  ]);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

// Uses the code up if it's this server's and still good: the email of whoever made it, or null.
export async function useCode(db, code) {
  const c = cleanCode(code);
  if (c.length !== 8) return null;
  const row = await db.prepare('SELECT made_by, expires_at FROM discord_codes WHERE hash = ?').bind(await codeHash(c)).first();
  if (!row || row.expires_at < now()) return null;
  await db.prepare('DELETE FROM discord_codes').run();
  return row.made_by;
}

// ---- players ----

export async function playerOf(db, discordId) {
  return (await db.prepare('SELECT uuid, name, how, at FROM discord_players WHERE discord_id = ?').bind(discordId).first()) ?? null;
}

export async function linkPlayer(db, discordId, { uuid, name, how }) {
  await db.prepare(
    `INSERT INTO discord_players (discord_id, uuid, name, how, at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(discord_id) DO UPDATE SET uuid = excluded.uuid, name = excluded.name, how = excluded.how, at = excluded.at`
  ).bind(discordId, uuid, name, how, now()).run();
}

export async function unlinkPlayer(db, discordId) {
  const r = await db.prepare('DELETE FROM discord_players WHERE discord_id = ?').bind(discordId).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function playersLinked(db) {
  return (await db.prepare('SELECT discord_id, uuid, name, how, at FROM discord_players ORDER BY name COLLATE NOCASE').all()).results;
}
