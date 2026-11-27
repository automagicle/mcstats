// The numbers behind the bot's answers and posts, read from a server the way its dashboard reads them
// (src/discord/server.js: as a viewer, through its own API). A few things the dashboard works out in the
// browser (who's top for kills, each player's advancements) are worked out here instead.
import { canonName } from '../aliases.js';
import { notHidden } from '../hidden.js';
import { dayStart } from './text.js';

const DAY = 86400;
const NAME_RE = /^[A-Za-z0-9_.]{1,20}$/;
export const isName = (n) => typeof n === 'string' && NAME_RE.test(n);
const now = () => Math.floor(Date.now() / 1000);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// The API's query string for a period: today and this week are a time range; season is the current one; all
// is everything recorded.
export function periodQuery(srv, period) {
  const t = now();
  if (period === 'today') return `from=${dayStart(srv.tz, t)}&to=${t}`;
  if (period === 'week') return `from=${t - 7 * DAY}&to=${t}`;
  if (period === 'all') return `from=0&to=${t}`;
  return `season=${srv.season}`;
}
export const PERIOD_WORDS = { today: 'today', week: 'this week', season: 'this season', all: 'all time' };

// Teams this season: ign (lowercase) -> team name.
export async function teamsOf(srv) {
  try {
    const r = await srv.view(`/api/roster?season=${srv.season}`);
    const names = new Map((r.teams || []).map((t) => [String(t.id), t.name]));
    return new Map((r.players || []).filter((p) => p.team).map((p) => [p.ign.toLowerCase(), names.get(String(p.team)) || p.team]));
  } catch {
    return new Map();
  }
}

// Who's on now: { status, online, max, players: [{ name, uuid, since }] } (since: unix seconds, when known).
export async function onlineNow(srv) {
  const [now_, status] = await Promise.all([srv.stub.onlineNow(), srv.view(`/api/status?season=${srv.season}`).catch(() => null)]);
  const since = new Map((status?.online || []).map((p) => [p.name.toLowerCase(), p]));
  return {
    ...now_,
    players: now_.players.map((name) => ({ name, uuid: since.get(name.toLowerCase())?.uuid ?? null, since: since.get(name.toLowerCase())?.start_ts ?? null })),
    status_api: status,
  };
}

// Hourly averages for the last `hours` hours (oldest first), and the highest count in them.
export async function lastHours(srv, hours = 24) {
  const to = now();
  const from = Math.floor((to - hours * 3600) / 3600) * 3600;
  const r = await srv.view(`/api/hourly?from=${from}&to=${to}`);
  const by = new Map(r.rows.map(([ts, samples, , sum, peak]) => [ts, { avg: samples ? sum / samples : 0, peak }]));
  const out = [];
  let peak = 0;
  for (let ts = from + 3600; ts <= to; ts += 3600) {
    const h = by.get(Math.floor(ts / 3600) * 3600) || { avg: 0, peak: 0 };
    out.push(h.avg);
    peak = Math.max(peak, h.peak);
  }
  return { values: out.slice(-hours), peak };
}

// The leaderboard for a period: [{ uuid, name, first_seen, secs, sessions, last_seen }], most time first.
export async function leaderboard(srv, period = 'season') {
  return (await srv.view(`/api/leaderboard?${periodQuery(srv, period)}`)).players || [];
}

// Every counted death in the season, as [id, ts, victim, killer, cause, mob] (src/combat.js).
async function deaths(srv, period = 'season') {
  return (await srv.view(period === 'all' ? '/api/combat' : `/api/combat?season=${srv.season}`)).rows || [];
}

export function inPeriod(srv, period) {
  const t = now();
  if (period === 'today') return [dayStart(srv.tz, t), t + 1];
  if (period === 'week') return [t - 7 * DAY, t + 1];
  return [0, Infinity]; // the season (what /api/combat gives) or everything
}

// Kills and deaths per player in a period: Map lowercase name -> { name, kills, deaths, causes: { cause: n } }.
export async function combatTotals(srv, period = 'season') {
  const [lo, hi] = inPeriod(srv, period);
  const out = new Map();
  const get = (n) => out.get(n.toLowerCase()) || out.set(n.toLowerCase(), { name: n, kills: 0, deaths: 0, causes: {} }).get(n.toLowerCase());
  for (const [, ts, victim, killer, cause] of await deaths(srv, period)) {
    if (ts < lo || ts >= hi) continue;
    const v = get(victim);
    v.deaths++;
    v.causes[killer ? 'player' : cause] = (v.causes[killer ? 'player' : cause] || 0) + 1;
    if (killer) get(killer).kills++;
  }
  return out;
}

// Advancements made per player: Map lowercase name -> { name, done: Map id -> unix seconds }. Only those in the
// server's advancement tree (so no recipes), and only this season's, as the player page counts them.
export async function advancementTotals(srv) {
  const lo = (await seasonBounds(srv)).lo;
  const [tree, rows] = await srv.db.batch([
    srv.db.prepare('SELECT ts, data FROM advancement_tree WHERE id = 1'),
    srv.db.prepare(`SELECT ${canonName('name')} AS name, data FROM advancements WHERE ts >= ? AND ${notHidden('name')}`).bind(lo),
  ]);
  const titles = new Map();
  try {
    for (const a of JSON.parse(tree.results[0]?.data || '[]')) titles.set(a.id, { title: a.title, frame: a.frame });
  } catch { /* none */ }
  const out = new Map();
  for (const r of rows.results) {
    let data;
    try { data = JSON.parse(r.data); } catch { continue; }
    const p = out.get(r.name.toLowerCase()) || out.set(r.name.toLowerCase(), { name: r.name, done: new Map() }).get(r.name.toLowerCase());
    for (const [id, at] of Object.entries(data.done || {})) {
      if (!titles.has(id)) continue;
      if (!p.done.has(id) || at < p.done.get(id)) p.done.set(id, at);
    }
  }
  return { players: out, titles };
}

async function seasonBounds(srv) {
  const s = await srv.view(`/api/status?season=${srv.season}`).catch(() => null);
  return { lo: s?.season?.start || 0 };
}

// One player, for /player and /me: null when nobody of that name has played here.
export async function playerCard(srv, name) {
  const share = srv.config.share;
  const [season, all, online, teams] = await Promise.all([
    leaderboard(srv, 'season'), leaderboard(srv, 'all'), onlineNow(srv), teamsOf(srv),
  ]);
  const rank = season.findIndex((p) => same(p.name, name));
  const row = season[rank] || all.find((p) => same(p.name, name));
  if (!row) return null;
  const on = online.players.find((p) => same(p.name, row.name));
  const card = {
    name: row.name, uuid: row.uuid, team: teams.get(row.name.toLowerCase()) ?? null,
    first_seen: all.find((p) => same(p.name, row.name))?.first_seen ?? row.first_seen,
    last_seen: row.last_seen, online: !!on, since: on?.since ?? null,
    season_secs: rank >= 0 ? season[rank].secs : 0, season_rank: rank >= 0 ? rank + 1 : null, season_players: season.length,
    all_secs: all.find((p) => same(p.name, row.name))?.secs ?? row.secs,
  };
  if (share.deaths && srv.hasMod) {
    const c = (await combatTotals(srv, 'season')).get(row.name.toLowerCase()) || { kills: 0, deaths: 0, causes: {} };
    card.combat = c;
  }
  if (share.advancements && srv.hasMod) {
    const { players, titles } = await advancementTotals(srv);
    const done = players.get(row.name.toLowerCase())?.done || new Map();
    const newest = [...done.entries()].sort((a, b) => b[1] - a[1])[0];
    card.advancements = { count: done.size, of: titles.size, newest: newest ? { title: titles.get(newest[0])?.title || newest[0], at: newest[1] } : null };
  }
  return card;
}

// The names autocomplete offers: whoever's online first, then the most recent players, matching what's typed.
export async function suggestNames(srv, typed) {
  const t = String(typed || '').replace(/[^A-Za-z0-9_.]/g, '').slice(0, 20);
  const { results } = await srv.db.prepare(
    `SELECT ${canonName('p.name')} AS name, MAX(s.end_ts) AS last FROM players p LEFT JOIN sessions s ON s.uuid = p.uuid
     WHERE p.name LIKE ? ESCAPE '\\' AND ${notHidden(canonName('p.name'))}
     GROUP BY lower(${canonName('p.name')}) ORDER BY last DESC NULLS LAST LIMIT 25`
  ).bind(`%${t.replace(/_/g, '\\_')}%`).all();
  const on = new Set((await srv.stub.onlineNow()).players.map((n) => n.toLowerCase()));
  const starts = (n) => n.toLowerCase().startsWith(t.toLowerCase());
  return results.map((r) => r.name)
    .sort((a, b) => (on.has(b.toLowerCase()) - on.has(a.toLowerCase())) || (starts(b) - starts(a)))
    .slice(0, 25);
}

// The closest known name to a misspelled one, for "Did you mean Steve?".
export async function closest(srv, name) {
  const names = (await leaderboard(srv, 'all')).map((p) => p.name);
  let best = null, score = Infinity;
  for (const n of names) {
    const d = distance(n.toLowerCase(), name.toLowerCase());
    if (d < score) { best = n; score = d; }
  }
  return score <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// The last `n` deaths (optionally of, or by, one player), worded as on Combat: [{ ts, text, name, killer }].
export async function recentDeaths(srv, player = null, n = 10) {
  const q = new URLSearchParams({ season: String(srv.season), limit: String(n) });
  if (player) q.set('player', player);
  const r = await srv.view(`/api/combat/log?${q}`);
  return r.results.map((d) => ({ ts: Math.floor(d.ts / 1000), text: d.text, name: d.name, killer: d.killer }));
}

// A day's summary, for the daily post: the day before `at` in the server's time zone. null when nobody played.
export async function daySummary(srv, at = now()) {
  const to = dayStart(srv.tz, at);
  const from = dayStart(srv.tz, to - 3600);
  const lb = (await srv.view(`/api/leaderboard?from=${from}&to=${to}`)).players || [];
  if (!lb.length) return null;
  const hourly = await srv.view(`/api/hourly?from=${from}&to=${to - 1}`);
  let peak = 0, peakAt = null;
  for (const [ts, , , , p] of hourly.rows) if (p > peak) { peak = p; peakAt = ts; }
  const out = {
    from, to, players: lb.length, secs: lb.reduce((n, p) => n + p.secs, 0), top: lb.slice(0, 3), peak, peak_at: peakAt,
    new_players: lb.filter((p) => p.first_seen >= from && p.first_seen < to).map((p) => p.name),
  };
  if (srv.config.share.deaths && srv.hasMod) {
    let deathsN = 0;
    const kills = new Map();
    for (const [, ts, , killer] of await deaths(srv)) {
      if (ts < from || ts >= to) continue;
      deathsN++;
      if (killer) kills.set(killer, (kills.get(killer) || 0) + 1);
    }
    const best = [...kills.entries()].sort((a, b) => b[1] - a[1])[0];
    out.deaths = deathsN;
    out.top_killer = best ? { name: best[0], kills: best[1] } : null;
  }
  if (srv.config.share.advancements && srv.hasMod) {
    const { players } = await advancementTotals(srv);
    let n = 0;
    for (const p of players.values()) for (const at2 of p.done.values()) if (at2 >= from && at2 < to) n++;
    out.advancements = n;
  }
  return out;
}
