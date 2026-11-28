// The census behind the site analytics (/site-analytics): every server's data lives in its own objects
// (README, "How servers are kept apart"), so the site's totals are put together by asking each of them.
//
//   refreshCensus  asks the servers whose census is oldest (Tenant.census() and its ServerLink's status), a few
//                  at a time, and keeps each answer in server_census. Run every hour by the cron (src/index.js)
//                  and by the page's Refresh button, a batch per request, so a site with many servers never
//                  makes too many requests in one go.
//   aggregate      the site's totals now, from server_census and the directory's own tables.
//   snapshot       today's row of site_snapshots: the totals that can't be worked out later from created_at.
//
// Nothing here names a person or a server: the census holds counts, versions, and its members' emails as tags
// (session.js emailTag), which aggregate() matches against the accounts' own tags and then forgets.
import { emailTag } from './session.js';
import { tenantStub } from './tenantenv.js';
import { discord, discordReady } from './discord/api.js';
import { periodsOf, setCount, utcDay } from './sitecounts.js';

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
// at most this many servers asked at once, and this many per batch
const AT_ONCE = 6;
export const BATCH = 30;
// how old a census the hourly run lets be
export const STALE_SECONDS = 6 * 3600;

// What the server's mod connection says: { linked, version, minecraft }, or null when that couldn't be asked.
async function linkOf(env, serverId) {
  if (!env.LINK) return null;
  try {
    const res = await env.LINK.get(env.LINK.idFromName(serverId)).fetch('https://link/status');
    if (!res.ok) return null;
    const s = await res.json();
    return { linked: !!s.linked, version: s.last_version ?? null, minecraft: s.minecraft ?? null };
  } catch {
    return null;
  }
}

async function censusOf(env, serverId) {
  const [c, mod] = await Promise.all([tenantStub(env, serverId).census(), linkOf(env, serverId)]);
  return { ...c, mod };
}

// The Discord servers the bot is in, as Discord counts them (its application's approximate_guild_count), kept
// as today's discord:guilds. Null when the bot is off or Discord didn't say.
export async function refreshDiscordCount(env) {
  if (!discordReady(env)) return null;
  const r = await discord(env, 'GET', '/applications/@me').catch(() => null);
  const n = r?.ok ? Number(r.data?.approximate_guild_count) : NaN;
  if (!Number.isFinite(n)) return null;
  await setCount(env, utcDay(), 'discord:guilds', n);
  return n;
}

// Asks up to `max` servers whose census was taken before `before` (oldest first), and keeps the answers.
// A server that can't answer keeps its last census (marked failed) and is asked again next time.
// -> { asked, failed, left } (left: servers still older than `before`)
export async function refreshCensus(env, { before = now() - STALE_SECONDS, max = BATCH } = {}) {
  const db = env.DIRECTORY;
  const { results } = await db.prepare(
    `SELECT s.id FROM servers s LEFT JOIN server_census c ON c.server_id = s.id
     WHERE c.taken_at IS NULL OR c.taken_at < ?1 ORDER BY COALESCE(c.taken_at, 0), s.id LIMIT ?2`
  ).bind(before, max).all();
  let failed = 0;
  const writes = [];
  for (let i = 0; i < results.length; i += AT_ONCE) {
    const part = results.slice(i, i + AT_ONCE);
    const answers = await Promise.all(part.map(({ id }) => censusOf(env, id).then((data) => ({ id, data }), (err) => ({ id, err }))));
    for (const a of answers) {
      if (a.err) {
        failed += 1;
        console.error(`census ${a.id}:`, a.err.message);
        // keep what we had, so one broken server doesn't take its numbers out of the totals
        writes.push(db.prepare(
          `INSERT INTO server_census (server_id, data, taken_at) VALUES (?1, '{"failed":true}', ?2)
           ON CONFLICT (server_id) DO UPDATE SET taken_at = excluded.taken_at,
             data = json_set(server_census.data, '$.failed', json('true'))`
        ).bind(a.id, now()));
      } else {
        writes.push(db.prepare(
          'INSERT INTO server_census (server_id, data, taken_at) VALUES (?, ?, ?) ON CONFLICT (server_id) DO UPDATE SET data = excluded.data, taken_at = excluded.taken_at'
        ).bind(a.id, JSON.stringify(a.data), now()));
      }
    }
  }
  if (writes.length) await db.batch(writes);
  const left = await db.prepare(
    'SELECT COUNT(*) AS n FROM servers s LEFT JOIN server_census c ON c.server_id = s.id WHERE c.taken_at IS NULL OR c.taken_at < ?'
  ).bind(before).first('n');
  return { asked: results.length, failed, left: Number(left) || 0 };
}

const bucket = (n, edges) => {
  for (const [label, hi] of edges) if (n <= hi) return label;
  return edges[edges.length - 1][0];
};
const MEMBER_BUCKETS = [['1', 1], ['2–3', 3], ['4–10', 10], ['11–25', 25], ['26+', Infinity]];
const PLAYER_BUCKETS = [['0', 0], ['1–5', 5], ['6–20', 20], ['21–50', 50], ['51–200', 200], ['201+', Infinity]];
const tally = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };

// The site's totals as they stand: the directory's own tables (exact, as of now) and the latest census of each
// server (as of when it was taken; census.oldest says how old the oldest is).
export async function aggregate(env) {
  const db = env.DIRECTORY;
  const t = now();
  const today = utcDay(t);
  const p = periodsOf(today);
  const [servers, accounts, census, guilds] = await db.batch([
    db.prepare('SELECT s.id, s.created_at, s.has_password, w.step FROM servers s LEFT JOIN wizard w ON w.server_id = s.id'),
    db.prepare('SELECT email, created_at, seen_day FROM accounts'),
    db.prepare('SELECT server_id, data, taken_at FROM server_census'),
    db.prepare('SELECT COUNT(*) AS n FROM discord_guilds'),
  ]);

  const out = {
    servers: servers.results.length,
    servers_setup: 0, servers_public: 0, servers_address: 0, servers_paused: 0,
    servers_uploaded: 0, servers_active_1d: 0, servers_active_7d: 0, servers_active_30d: 0,
    servers_mod_now: 0, servers_mod_7d: 0, servers_online_now: 0, servers_discord: 0,
    accounts: accounts.results.length,
    accounts_active: { d: 0, w: 0, m: 0 },
    roles: { member: 0, admin: 0, owner: 0, mixed: 0, none: 0 },
    invited_no_account: 0,
    servers_per_account: { 1: 0, 2: 0, '3+': 0 },
    members_per_server: Object.fromEntries(MEMBER_BUCKETS.map(([l]) => [l, 0])),
    players_per_server: Object.fromEntries(PLAYER_BUCKETS.map(([l]) => [l, 0])),
    players: { total: 0, d1: 0, d7: 0, d30: 0 },
    online_now: 0,
    chat_7d: 0,
    mod_versions: {}, mc_versions: {},
    discord: { linked: Number(guilds.results[0]?.n) || 0, feeds: {}, players: 0 },
    census: { counted: 0, failed: 0, missing: 0, oldest: null, newest: null },
  };

  for (const s of servers.results) if (s.step == null || s.step >= 7) out.servers_setup += 1;

  for (const a of accounts.results) {
    const seen = a.seen_day || '';
    if (seen >= p.d) out.accounts_active.d += 1;
    if (seen >= p.w) out.accounts_active.w += 1;
    if (seen >= p.m) out.accounts_active.m += 1;
  }

  // email tag -> roles held, across every server
  const rolesOf = new Map();
  const known = new Set(servers.results.map((s) => s.id));
  const seenServers = new Set();
  for (const row of census.results) {
    if (!known.has(row.server_id)) continue;
    let c;
    try { c = JSON.parse(row.data); } catch { continue; }
    seenServers.add(row.server_id);
    if (c.failed) out.census.failed += 1;
    if (!c.members) continue; // never answered
    out.census.counted += 1;
    out.census.oldest = out.census.oldest == null ? row.taken_at : Math.min(out.census.oldest, row.taken_at);
    out.census.newest = out.census.newest == null ? row.taken_at : Math.max(out.census.newest, row.taken_at);

    if (c.public) out.servers_public += 1;
    if (c.address) out.servers_address += 1;
    if (c.paused) out.servers_paused += 1;
    if (c.first_upload_at) out.servers_uploaded += 1;
    // active: the mod uploaded, or a player was seen (by the mod or the address's ping), in that time
    const last = c.last_upload_at || 0;
    if (last >= t - DAY || c.players?.d1 > 0) out.servers_active_1d += 1;
    if (last >= t - 7 * DAY || c.players?.d7 > 0) out.servers_active_7d += 1;
    if (last >= t - 30 * DAY || c.players?.d30 > 0) out.servers_active_30d += 1;
    if (last >= t - 7 * DAY) out.servers_mod_7d += 1;
    // the mod: connected now (its web chat link), or uploaded in the last 10 minutes (as of the census)
    if (c.mod?.linked || last >= row.taken_at - 600) out.servers_mod_now += 1;
    if (c.online?.n > 0) out.servers_online_now += 1;
    out.online_now += c.online?.n || 0;
    if (c.discord?.linked) out.servers_discord += 1;
    for (const f of c.discord?.feeds || []) tally(out.discord.feeds, f);
    out.discord.players += c.discord?.players || 0;
    for (const k of ['total', 'd1', 'd7', 'd30']) out.players[k] += c.players?.[k] || 0;
    out.chat_7d += c.chat_7d || 0;
    tally(out.players_per_server, bucket(c.players?.total || 0, PLAYER_BUCKETS));
    // versions of the mod, and of Minecraft it said it runs on, for servers it has uploaded from
    if (c.first_upload_at) {
      tally(out.mod_versions, c.mod?.version || 'unknown');
      tally(out.mc_versions, c.mod?.minecraft || 'unknown');
    }

    let memberCount = 0;
    for (const role of ['owner', 'admin', 'member']) {
      for (const tag of c.members[role] || []) {
        memberCount += 1;
        if (!rolesOf.has(tag)) rolesOf.set(tag, { roles: new Set(), servers: 0 });
        const r = rolesOf.get(tag);
        r.roles.add(role);
        r.servers += 1;
      }
    }
    if (memberCount) tally(out.members_per_server, bucket(memberCount, MEMBER_BUCKETS));
  }
  out.census.missing = servers.results.filter((s) => !seenServers.has(s.id)).length;

  // Each account's roles across servers. Tags are worked out from the accounts' emails here and forgotten after.
  const accountTags = new Set();
  for (const a of accounts.results) {
    const tag = await emailTag(env, a.email);
    accountTags.add(tag);
    const r = rolesOf.get(tag);
    if (!r) { out.roles.none += 1; continue; }
    out.roles[r.roles.size > 1 ? 'mixed' : [...r.roles][0]] += 1;
    tally(out.servers_per_account, r.servers >= 3 ? '3+' : String(r.servers));
  }
  for (const tag of rolesOf.keys()) if (!accountTags.has(tag)) out.invited_no_account += 1;
  return out;
}

// The part of the totals kept for each day (site_snapshots), so the page can draw how they changed.
export function snapshotOf(a) {
  return {
    servers: a.servers, servers_setup: a.servers_setup, servers_uploaded: a.servers_uploaded,
    servers_active_1d: a.servers_active_1d, servers_active_7d: a.servers_active_7d, servers_active_30d: a.servers_active_30d,
    servers_mod_now: a.servers_mod_now, servers_mod_7d: a.servers_mod_7d, servers_online_now: a.servers_online_now, servers_discord: a.servers_discord,
    accounts: a.accounts, accounts_active: a.accounts_active, roles: a.roles, invited_no_account: a.invited_no_account,
    players: a.players, online_now: a.online_now, chat_7d: a.chat_7d, discord_linked: a.discord.linked,
    mod_versions: a.mod_versions,
  };
}

export async function saveSnapshot(env, a) {
  await env.DIRECTORY.prepare(
    'INSERT INTO site_snapshots (day, data, taken_at) VALUES (?, ?, ?) ON CONFLICT (day) DO UPDATE SET data = excluded.data, taken_at = excluded.taken_at'
  ).bind(utcDay(), JSON.stringify(snapshotOf(a)), now()).run();
}

// The hourly run (src/index.js scheduled): the stalest batch of servers, the bot's Discord count, then today's snapshot.
export async function hourlyCensus(env) {
  await refreshCensus(env);
  await refreshDiscordCount(env).catch((err) => console.error('census discord:', err.message));
  await saveSnapshot(env, await aggregate(env));
}
