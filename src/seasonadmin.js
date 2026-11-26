// Admin → Server → Seasons: a server's seasons, made and moved from its dashboard by its admins.
//
//   GET  /api/admin/seasons   { current, now, tz, seasons: [{ n, start, opens, end, started, ended }] }
//   POST /api/admin/seasons   { action: 'create', start?, copy?, confirm: 'Season N' }   a new season, after the current one
//                             { action: 'update', n, start, opens? }                     when season n starts (and officially opens)
//                             { action: 'remove', confirm: 'Season N' }                  undo the newest season
//
// A season is only a stretch of time (src/seasons.js): season n runs from its start to the next season's
// start, and season 1 from the first recording. So nothing here copies or deletes what was recorded. Making a
// season, moving a start or removing the newest season only changes which season each moment counts towards,
// and every one of them can be put back. What's stored is the server's own settings: CURRENT_SEASON,
// SEASONn_START and SEASONn_OPENS.
//
// The main page shows the newest season from the moment it's made, even if it starts later: until then the
// page is empty and says when it starts, the season before keeps recording, and the new season's teams can be
// set up. Teams, players and their sign-in emails are per season; making a season can bring them over.
import { json } from './util.js';
import { loadPerms } from './roles.js';
import { currentSeason, parseStart } from './seasons.js';
import { tellSeason } from './discord/relay.js';

const MAX_SEASONS = 99;
const YEAR = 366 * 86400;
const now = () => Math.floor(Date.now() / 1000);
const iso = (ts) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
const startOf = (settings, n) => (n <= 1 ? 0 : parseStart(settings[`SEASON${n}_START`]));

export function seasonsState(t) {
  const s = t.settings;
  const current = currentSeason(s);
  const at = now();
  const seasons = [];
  for (let n = 1; n <= current; n++) {
    const start = startOf(s, n);
    const end = n < current ? startOf(s, n + 1) : null;
    const opens = n > 1 ? parseStart(s[`SEASON${n}_OPENS`]) : null;
    seasons.push({
      n,
      start: n === 1 ? null : start, // season 1 starts at the first recording
      opens: start != null && opens != null && opens > start ? opens : null,
      end,
      started: start != null && start <= at,
      ended: end != null && end <= at,
    });
  }
  return { current, now: at, tz: s.TZ_NAME || 'UTC', seasons };
}

// A time sent by the page: whole unix seconds, within reason. null when it isn't one.
const time = (v) => (Number.isInteger(v) && v > 946684800 && v < now() + 5 * YEAR ? v : null);
const typed = (v, n) => typeof v === 'string' && v.trim().replace(/\s+/g, ' ').toLowerCase() === `season ${n}`;

export async function handleSeasons(t, request, url, who) {
  const env = t.serverEnv();
  const perms = await loadPerms(env, who);
  if (!who.email || !perms.admin) return json({ error: 'forbidden' }, 403);
  if (request.method === 'GET') return json(seasonsState(t));
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);
  let b;
  try {
    const raw = await request.text();
    if (raw.length > 1024) return json({ error: 'too large' }, 413);
    b = JSON.parse(raw);
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  if (!b || typeof b !== 'object') return json({ error: 'bad json' }, 400);
  const bad = (error, field) => json({ error, ...(field && { field }) }, 400);
  const s = t.settings;
  const current = currentSeason(s);
  const at = now();
  const apply = async (patch) => {
    const out = await t.updateSettings(patch);
    return out.error ? bad(out.error) : json(seasonsState(t));
  };

  if (b.action === 'create') {
    const n = current + 1;
    if (n > MAX_SEASONS) return bad(`A server can have up to ${MAX_SEASONS} seasons.`);
    if (!typed(b.confirm, n)) return bad(`Type “Season ${n}” to confirm.`, 'confirm');
    const prev = startOf(s, current);
    // a season that hasn't begun can't be followed by another: there'd be nothing between them
    if (prev == null || prev > at) return bad(`Season ${current} hasn’t started yet. Set when it starts, or remove it, before making another.`);
    const start = b.start == null ? at : time(b.start);
    if (start == null) return bad('That isn’t a time.', 'start');
    if (start <= prev) return bad(`Season ${n} has to start after Season ${current} did.`, 'start');
    if (start > at + YEAR) return bad('That’s more than a year away.', 'start');
    const out = await t.updateSettings({ CURRENT_SEASON: String(n), [`SEASON${n}_START`]: iso(start), [`SEASON${n}_OPENS`]: '' });
    if (out.error) return bad(out.error);
    if (b.copy === true) {
      // Teams, players and who may chat as them, as they stand now. Anything the new season already has
      // (it was made before, and removed) is left as it is.
      await t.db.batch([
        t.db.prepare(
          `INSERT OR IGNORE INTO teams (season, id, name, short, color, color_dark, sort, show_bar, show_chart, show_activity, activity_with)
           SELECT ?1, id, name, short, color, color_dark, sort, show_bar, show_chart, show_activity, activity_with FROM teams WHERE season = ?2`
        ).bind(n, current),
        t.db.prepare('INSERT OR IGNORE INTO roster (season, ign, name, team, egg) SELECT ?1, ign, name, team, egg FROM roster WHERE season = ?2').bind(n, current),
        t.db.prepare('INSERT OR IGNORE INTO roster_email (season, email, ign) SELECT ?1, email, ign FROM roster_email WHERE season = ?2').bind(n, current),
      ]);
    }
    console.log(`seasons: ${who.email} made season ${n} of ${s.SLUG}, starting ${iso(start)}`);
    if (start <= at) await tellSeason(t.serverEnv(), n); // a linked Discord hears about it (src/discord/relay.js)
    return json(seasonsState(t));
  }

  if (b.action === 'update') {
    const n = b.n;
    if (!Number.isInteger(n) || n < 2 || n > current) return bad('Season 1 starts at the first recording; later seasons can be moved.');
    const start = time(b.start);
    if (start == null) return bad('That isn’t a time.', 'start');
    const prev = startOf(s, n - 1);
    const next = n < current ? startOf(s, n + 1) : null;
    if (prev == null) return bad(`Set when Season ${n - 1} starts first.`, 'start');
    if (start <= prev) return bad(`Season ${n} has to start after Season ${n - 1} does.`, 'start');
    if (next != null && start >= next) return bad(`Season ${n} has to start before Season ${n + 1} does.`, 'start');
    let opens = '';
    if (b.opens != null && b.opens !== '') {
      const o = time(b.opens);
      if (o == null) return bad('That isn’t a time.', 'opens');
      if (o <= start) return bad('The official opening comes after the start. Leave it empty if they’re the same.', 'opens');
      if (next != null && o >= next) return bad(`It has to open before Season ${n + 1} starts.`, 'opens');
      opens = iso(o);
    }
    console.log(`seasons: ${who.email} set season ${n} of ${s.SLUG} to start ${iso(start)}`);
    return apply({ [`SEASON${n}_START`]: iso(start), [`SEASON${n}_OPENS`]: opens });
  }

  if (b.action === 'remove') {
    if (current < 2) return bad('Season 1 can’t be removed.');
    if (!typed(b.confirm, current)) return bad(`Type “Season ${current}” to confirm.`, 'confirm');
    // Its time goes back to the season before, which becomes the current one again. Its teams and players
    // stay in the database, for if it's made again.
    console.log(`seasons: ${who.email} removed season ${current} of ${s.SLUG}`);
    return apply({ CURRENT_SEASON: String(current - 1), [`SEASON${current}_START`]: '', [`SEASON${current}_OPENS`]: '' });
  }

  return bad('unknown action');
}
