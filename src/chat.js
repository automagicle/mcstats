import { canonName, canonUuid, marks, playerGroup } from './aliases.js';
import { deathInsert } from './combat.js';
import { OPEN_ENDED } from './seasons.js';
import { json, UUID_RE, ingestDenied } from './util.js';
import { tellPresence } from './presence.js';
import { hiddenByRules, loadRules } from './chatrules.js';
import { tellRelay } from './discord/relay.js';

const KINDS = new Set(['chat', 'emote', 'say', 'join', 'leave', 'death', 'advancement', 'server', 'system']);
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_BODY = 512 * 1024;
const MAX_EVENTS = 200;
const MAX_TEXT = 1000;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_AGE_MS = 60 * 86400_000; // older messages (e.g. saved during a very long outage) are skipped

// Constant-time comparison; hashing first makes both sides the same length.
export async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// Control characters and leftover § color codes out; newlines stay.
const clean = (s, max) => s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]|§[0-9a-fk-or]/gi, '').trim().slice(0, max);

// The styled name: up to 8 pieces of text, each with an optional color. Anything else is dropped.
function cleanDisplay(d) {
  if (!Array.isArray(d) || !d.length || d.length > 8) return null;
  const out = [];
  for (const p of d) {
    if (!p || typeof p.t !== 'string') return null;
    const t = p.t.replace(/[\u0000-\u001f\u007f]|§[0-9a-fk-or]/gi, '').slice(0, 64);
    if (!t) continue;
    out.push(typeof p.c === 'string' && COLOR_RE.test(p.c) ? { t, c: p.c.toLowerCase() } : { t });
  }
  return out.length ? JSON.stringify(out) : null;
}

// The whole message as the game shows it: up to 32 pieces of text, each with an optional color
// and the name of the player it names (p), so the page can color and link every name in it.
// Pieces of an item's name are marked w; the first also carries the item's in-game tooltip (i).
const PLAYER_RE = /^[A-Za-z0-9_.-]{1,32}$/;

// An item's tooltip: up to 24 lines of up to 8 pieces { t, c?, i? (italic) }. An empty line stays (a gap).
export function cleanTooltip(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const out = [];
  for (const line of lines.slice(0, 24)) {
    if (!Array.isArray(line)) return null;
    const pieces = [];
    for (const p of line.slice(0, 8)) {
      if (!p || typeof p.t !== 'string') return null;
      const t = p.t.replace(/[\u0000-\u001f\u007f]|§[0-9a-fk-or]/gi, '').slice(0, 120);
      if (!t) continue;
      const piece = { t };
      if (typeof p.c === 'string' && COLOR_RE.test(p.c)) piece.c = p.c.toLowerCase();
      if (p.i === true) piece.i = 1;
      pieces.push(piece);
    }
    out.push(pieces);
  }
  return out;
}

function cleanRich(d) {
  if (!Array.isArray(d) || !d.length || d.length > 32) return null;
  const out = [];
  for (const p of d) {
    if (!p || typeof p.t !== 'string') return null;
    const t = p.t.replace(/[\u0000-\u0009\u000b-\u001f\u007f]|§[0-9a-fk-or]/gi, '').slice(0, 300);
    if (!t) continue;
    const piece = { t };
    if (typeof p.c === 'string' && COLOR_RE.test(p.c)) piece.c = p.c.toLowerCase();
    if (typeof p.p === 'string' && PLAYER_RE.test(p.p)) piece.p = p.p;
    if (p.w === true) {
      piece.w = 1;
      const lines = cleanTooltip(p.i);
      if (lines) piece.i = lines;
    }
    out.push(piece);
  }
  return out.length ? JSON.stringify(out) : null;
}

// The game words a death from a translation key, and some (a kill with a named item by a damage type
// that has no ".item" wording, such as death.attack.generic.item) have no English text on the server,
// so the bare key is all that arrives. Those are worded here the way the game words the others, from
// what is known about the death: "<victim> was killed [by <who>] [using [<weapon>]]". Players get the
// team tag and colors the game gave them in their latest death message, and the weapon its color
// and tooltip from the gear the mod last reported for whoever held it.
//   d: { killer?, mob?, weapon? }  ->  { text, rich: [pieces] }
export const RAW_DEATH_RE = /^death\.[A-Za-z0-9_.]{1,80}$/;
export async function wordDeath(db, victim, d) {
  const str = (v, max) => (typeof v === 'string' ? clean(v, max) : '');
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  let by = str(d?.killer, 20);
  if (!PLAYER_RE.test(by) || same(by, victim)) by = ''; // (their own weapon)
  const mob = by ? '' : str(d?.mob, 64).replace(/^.*[:.]/, '').replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const weapon = str(d?.weapon, 60);

  // how the game last styled a player: "[RED] " and the name, in the team's color
  const styled = async (name) => {
    const row = await db.prepare(
      `SELECT rich FROM chat WHERE kind = 'death' AND instr(rich, ?1) > 0 AND instr(rich, '"c":') > 0 ORDER BY id DESC LIMIT 1`
    ).bind(`"p":${JSON.stringify(name)}`).first().catch(() => null);
    let pieces = [];
    try { pieces = JSON.parse(row?.rich || '[]'); } catch { /* plain, below */ }
    const from = pieces.findIndex((p) => p.p === name);
    const run = [];
    for (let i = from; i >= 0 && i < pieces.length && pieces[i].p === name; i++) run.push({ t: pieces[i].t, ...(pieces[i].c ? { c: pieces[i].c } : {}), p: name });
    return run.length ? run : [{ t: name, p: name }];
  };
  // the item of that name in someone's last gear report, with its tooltip (its first line is the name, colored)
  const held = async (names) => {
    for (const n of names) {
      const row = await db.prepare('SELECT data FROM gear WHERE name = ? COLLATE NOCASE').bind(n).first().catch(() => null);
      if (!row) continue;
      try {
        const g = JSON.parse(row.data);
        const it = [g.mainhand, g.offhand, ...(g.items || [])].find((x) => x && x.name === weapon);
        if (it) return it;
      } catch { /* the next holder */ }
    }
    return null;
  };

  const rich = [...await styled(victim), { t: by || mob || weapon ? ' was killed' : ' died' }];
  if (by) rich.push({ t: ' by ' }, ...await styled(by));
  else if (mob) rich.push({ t: ` by ${mob}` });
  if (weapon) {
    rich.push({ t: ' using ' });
    const it = await held([by, victim].filter(Boolean));
    // as an earlier death message showed that weapon (its colors and tooltip), unless the gear report has its tooltip
    const seen = it?.tip ? null : await db.prepare(
      `SELECT rich FROM chat WHERE kind = 'death' AND instr(rich, ?1) > 0 AND instr(rich, '"w":1') > 0 ORDER BY id DESC LIMIT 1`
    ).bind(`"t":${JSON.stringify(weapon)}`).first().catch(() => null);
    let run = [];
    try { run = JSON.parse(seen?.rich || '[]').filter((p) => p.w); } catch { /* colored by rarity, below */ }
    if (run.length && run.some((p) => p.c)) rich.push(...run);
    else {
      // else the color the game gives the item's rarity (a mace is epic, a trident rare; enchanting raises it)
      const base = it?.id === 'mace' ? 2 : it?.id === 'trident' ? 1 : 0;
      const c = it?.tip?.[0]?.find((p) => p.c)?.c ?? (it ? ['#ffffff', '#55ffff', '#ff55ff'][Math.min(2, base + (it.glint ? 1 : 0))] : null);
      const piece = (t, more) => ({ t, ...(c ? { c } : {}), w: 1, ...more });
      const tip = it?.tip ?? (c ? [[{ t: weapon, c, i: 1 }]] : null);
      rich.push(piece('[', tip ? { i: tip } : {}), piece(weapon), piece(']'));
    }
  }
  return { text: rich.map((p) => p.t).join(''), rich };
}

// Words again the deaths that arrived as a bare key, or were worded before the colors were looked up
// (plain names, no item marked). Returns how many lines changed. (The admin action deaths.reword.)
export async function rewordDeaths(db) {
  const { results } = await db.prepare(
    `SELECT c.id, c.name, c.text, c.rich, d.killer, d.mob, d.weapon FROM chat c LEFT JOIN deaths d ON d.id = c.id
     WHERE c.kind = 'death' AND c.name IS NOT NULL
       AND ((c.text GLOB 'death.*' AND instr(c.text, ' ') = 0)
         OR (c.rich LIKE '[{"t":%' AND instr(c.rich, '" was killed') > 0 AND instr(c.rich, '"c":') = 0 AND instr(c.rich, '"p":') > 0))
     LIMIT 200`
  ).all();
  let changed = 0;
  for (const r of results) {
    const w = await wordDeath(db, r.name, r);
    const rich = JSON.stringify(w.rich);
    if (w.text === r.text && rich === r.rich) continue;
    await db.prepare('UPDATE chat SET text = ?, rich = ? WHERE id = ?').bind(w.text, rich, r.id).run();
    changed++;
  }
  return changed;
}

// POST /api/ingest/chat from the server mod: { events: [{ id, ts, kind, uuid?, name?, display?, rich?, text, via? }] }.
// via is 'web' for a message sent from the dashboard (see link.js), 'admin' for one an admin sent there.
// A death message can carry death: { cause, killer?, killer_uuid?, mob?, weapon? } (see combat.js).
// Cloudflare Access only lets it through with the service token; the bearer token is checked here too.
export async function ingestChat(request, env) {
  // the mod's key for this server was checked before the request got here (src/tenant.js)
  const denied = ingestDenied(env);
  if (denied) return denied;

  if (Number(request.headers.get('Content-Length')) > MAX_BODY) return json({ error: 'too large' }, 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, 413);
  let events;
  try {
    events = JSON.parse(raw).events;
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  if (!Array.isArray(events) || events.length > MAX_EVENTS) {
    return json({ error: `expected { events: [...] } with at most ${MAX_EVENTS} events` }, 400);
  }

  const now = Date.now();
  const rows = [];
  const deaths = []; // [event id, what's needed to say who did it]
  for (const e of events) {
    const valid = e && typeof e === 'object'
      && typeof e.id === 'string' && ID_RE.test(e.id)
      && Number.isSafeInteger(e.ts) && e.ts > now - MAX_AGE_MS && e.ts < now + 5 * 60_000
      && KINDS.has(e.kind)
      && typeof e.text === 'string'
      && (e.uuid == null || (typeof e.uuid === 'string' && UUID_RE.test(e.uuid)))
      && (e.name == null || typeof e.name === 'string');
    if (!valid) continue;
    const text = clean(e.text, MAX_TEXT);
    if (!text) continue;
    const name = e.name ? clean(e.name, 40) || null : null;
    let rich = cleanRich(e.rich);
    // a death the server had no wording for arrives as its bare key ("death.attack.generic.item")
    const worded = e.kind === 'death' && name && RAW_DEATH_RE.test(text) ? await wordDeath(env.DB, name, e.death) : null;
    if (worded) rich = JSON.stringify(worded.rich);
    rows.push([e.id, e.ts, e.kind, e.uuid ? e.uuid.toLowerCase() : null, name, worded ? worded.text : text, cleanDisplay(e.display), rich, ['web', 'admin', 'discord'].includes(e.via) ? e.via : null]);
    if (e.kind === 'death' && name) deaths.push([e.id, { name, text: worded ? worded.text : text, rich: rich ? JSON.parse(rich) : null, death: e.death }]);
  }

  if (rows.length) {
    // Server messages name a player without a UUID sometimes; fill it in from the players we know.
    // lines the admin page's rules hide are stored all the same, marked (src/chatrules.js)
    const rules = await loadRules(env.DB).catch(() => []);
    for (const r of rows) r.push(hiddenByRules(rules, { kind: r[2], text: r[5], ts: r[1] }) ? 1 : 0);
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO chat (event_id, ts_ms, kind, uuid, name, text, display, rich, via, hidden)
       SELECT ?1, ?2, ?3, COALESCE(?4, (SELECT uuid FROM players WHERE name = ?5 COLLATE NOCASE ORDER BY first_seen DESC LIMIT 1)), ?5, ?6, ?7, ?8, ?9, ?10
       WHERE NOT EXISTS (SELECT 1 FROM deleted_chat WHERE event_id = ?1)` // an admin deleted it; a resend stays out
    );
    // each death also goes in the deaths table, with who did it (after its message, in the same batch)
    await env.DB.batch([...rows.map((r) => stmt.bind(...r)), ...deaths.map(([id, m]) => deathInsert(env.DB, id, m))]);
    // open pages fetch the new lines at once, and joins, leaves and server starts/stops move the live
    // online badges (src/presence.js)
    const moves = rows.filter((r) => r[2] === 'join' || r[2] === 'leave' || r[2] === 'server')
      .map(([, ts, kind, uuid, name, text]) => ({ ts, kind, uuid, name, text }));
    await tellPresence(env, '/events', { events: moves });
    // and to Discord, where the server is linked to one (src/discord/relay.js)
    const deathOf = new Map(events.filter((e) => e?.kind === 'death' && e.death).map((e) => [e.id, e.death]));
    await tellRelay(env, rows.map(([event_id, ts, kind, uuid, name, text, , rich, via, hidden]) => ({
      event_id, ts, kind, uuid, name, text, rich, via, hidden, death: deathOf.get(event_id),
    })));
  }
  return json({ accepted: rows.length, skipped: events.length - rows.length });
}

// a death's killer, and whether an admin asked for "(by name)" after it (src/admin.js death.attribute)
const COLS = `id, ts_ms AS ts, kind, uuid, name, text, display, rich, via,
  CASE WHEN kind = 'death' THEN (SELECT killer FROM deaths WHERE deaths.id = chat.id) END AS killer,
  CASE WHEN kind = 'death' THEN (SELECT attr_note FROM deaths WHERE deaths.id = chat.id) END AS attr_note`;
const withDisplay = (rows) => rows.map((r) => ({
  ...r, display: r.display ? JSON.parse(r.display) : null, rich: r.rich ? JSON.parse(r.rich) : null,
}));
const TALK = "('chat', 'say', 'emote')"; // what counts as a message someone sent
const BIG = Number.MAX_SAFE_INTEGER;

// GET /api/chat — messages in time order, `limit` at a time:
//   (nothing)         the latest
//   before=TS:ID      older than a message      after=TS:ID   newer than a message
//   at=TS             up to and just after a moment (unix ms)
//   since_id=ID       stored after that id (live updates), whatever their time; add unread_since=ID for a count
// Only messages within the season's time span, and since its last chat reset, are returned, and none
// that the admin page's rules hide.
export async function readChat(env, url, season) {
  const q = url.searchParams;
  const db = env.DB;
  const lo = season.lo * 1000, hi = season.hi * 1000;
  const inSeason = (a, b) => `ts_ms >= ?${a} AND ts_ms < ?${b} AND hidden = 0`;
  const limit = Math.min(200, Math.max(1, Math.floor(Number(q.get('limit'))) || 100));
  const cursor = (v) => {
    const m = /^(\d+):(\d+)$/.exec(v || '');
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const older = (ts, id, n) => db.prepare(
    `SELECT ${COLS} FROM chat WHERE (ts_ms < ?1 OR (ts_ms = ?1 AND id < ?2)) AND ${inSeason(4, 5)} ORDER BY ts_ms DESC, id DESC LIMIT ?3`
  ).bind(ts, id, n + 1, lo, hi);
  const newer = (ts, id, n) => db.prepare(
    `SELECT ${COLS} FROM chat WHERE (ts_ms > ?1 OR (ts_ms = ?1 AND id > ?2)) AND ${inSeason(4, 5)} ORDER BY ts_ms, id LIMIT ?3`
  ).bind(ts, id, n + 1, lo, hi);
  // The newest message: for a season still going, simply the highest id (cheap); for one that's over,
  // its last message by time.
  const maxId = OPEN_ENDED(season)
    ? db.prepare('SELECT MAX(id) AS id FROM chat')
    : db.prepare('SELECT id FROM chat WHERE ts_ms < ? ORDER BY ts_ms DESC, id DESC LIMIT 1').bind(hi);

  if (q.has('since_id')) {
    const since = Math.max(0, Math.floor(Number(q.get('since_id'))) || 0);
    const [rows, max] = await db.batch([
      db.prepare(`SELECT ${COLS} FROM chat WHERE id > ?1 AND ${inSeason(3, 4)} ORDER BY id LIMIT ?2`)
        .bind(since, limit + 1, lo, hi),
      maxId,
    ]);
    const messages = withDisplay(rows.results.slice(0, limit)).sort((a, b) => a.ts - b.ts || a.id - b.id);
    const body = { messages, more_after: rows.results.length > limit, max_id: max.results[0]?.id ?? 0 };
    // after a chat reset, when the log starts (unix ms), so a page left open drops what's older
    if (season.reset) body.start = season.reset * 1000;
    // unread_since=ID: how many messages worth reading (chat, deaths, advancements; not joins or leaves) came after it, up to 1000
    if (q.has('unread_since')) {
      const seen = Math.max(0, Math.floor(Number(q.get('unread_since'))) || 0);
      body.unread = (await db.prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM chat WHERE id > ? AND kind IN ('chat', 'say', 'emote', 'death', 'advancement')
         AND ts_ms >= ? AND ts_ms < ? AND hidden = 0 LIMIT 1000)`
      ).bind(seen, lo, hi).first()).n;
    }
    return json(body);
  }

  let back = null, fwd = null;
  if (q.has('before')) {
    const c = cursor(q.get('before'));
    if (!c) return json({ error: 'bad cursor' }, 400);
    back = older(c[0], c[1], limit);
  } else if (q.has('after')) {
    const c = cursor(q.get('after'));
    if (!c) return json({ error: 'bad cursor' }, 400);
    fwd = newer(c[0], c[1], limit);
  } else if (q.has('at')) {
    const at = Math.floor(Number(q.get('at')));
    if (!Number.isSafeInteger(at)) return json({ error: 'bad time' }, 400);
    back = older(at, BIG, limit);
    fwd = newer(at, BIG, Math.ceil(limit / 2));
  } else {
    back = older(BIG, BIG, limit);
  }

  const res = await db.batch([back, fwd, maxId].filter(Boolean));
  const max = res.pop().results[0]?.id ?? 0;
  const b = back ? res.shift().results : [];
  const f = fwd ? res.shift().results : [];
  const bn = back && !q.has('after') ? limit : 0;
  const fn = q.has('after') ? limit : Math.ceil(limit / 2);
  return json({
    messages: withDisplay([...b.slice(0, bn).reverse(), ...f.slice(0, fn)]),
    more_before: b.length > bn,
    // "after" isn't asked for when loading the latest, so nothing newer is assumed.
    more_after: fwd ? f.length > fn : false,
    max_id: max,
  });
}

const SEARCH_KINDS = {
  chat: "kind IN ('chat', 'say', 'emote')",
  death: "kind = 'death'",
  advancement: "kind = 'advancement'",
  joins: "kind IN ('join', 'leave')",
};
const likeArg = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// GET /api/chat/search — newest first, `limit` at a time:
//   q=TEXT      words to find; in=all (text or name, the default) | text | name
//   from=UUID   only messages from (or about) this player
//   kind=chat | death | advancement | joins
//   before=TS:ID  the next page
export async function searchChat(env, url, season) {
  const q = url.searchParams;
  const limit = Math.min(50, Math.max(1, Math.floor(Number(q.get('limit'))) || 30));
  const text = (q.get('q') || '').trim().slice(0, 100);
  const where = [], args = [];
  const bounds = ['ts_ms >= ?', 'ts_ms < ?', 'hidden = 0'];
  if (text) {
    const field = q.get('in');
    if (field === 'text') where.push("text LIKE ? ESCAPE '\\'");
    else if (field === 'name') where.push("name LIKE ? ESCAPE '\\'");
    else { where.push("(text LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')"); args.push(likeArg(text)); }
    args.push(likeArg(text));
  }
  const from = q.get('from');
  if (from) {
    if (!UUID_RE.test(from)) return json({ error: 'bad uuid' }, 400);
    // all of their accounts (src/aliases.js)
    const uuids = (await playerGroup(env.DB, { uuid: from.toLowerCase() }))?.uuids || [from.toLowerCase()];
    where.push(`uuid IN (${marks(uuids)})`);
    args.push(...uuids);
  }
  const kind = q.get('kind');
  if (kind && SEARCH_KINDS[kind]) where.push(SEARCH_KINDS[kind]);
  if (!where.length) return json({ error: 'nothing to search for' }, 400);
  where.push(...bounds);
  args.push(season.lo * 1000, season.hi * 1000);
  const before = /^(\d+):(\d+)$/.exec(q.get('before') || '');
  if (before) {
    where.push('(ts_ms < ? OR (ts_ms = ? AND id < ?))');
    args.push(Number(before[1]), Number(before[1]), Number(before[2]));
  }
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM chat WHERE ${where.join(' AND ')} ORDER BY ts_ms DESC, id DESC LIMIT ?`
  ).bind(...args, limit + 1).all();
  return json({ results: withDisplay(results.slice(0, limit)), more: results.length > limit });
}

// GET /api/chat/players — everyone who played in the season, with how many messages they sent in it, for the search filter.
export async function chatPlayers(env, season) {
  const { results } = await env.DB.prepare(
    `SELECT ${canonUuid('p.name', 'p.uuid')} AS uuid, ${canonName('p.name')} AS name, COUNT(c.id) AS n FROM players p
     LEFT JOIN chat c ON c.uuid = p.uuid AND c.kind IN ${TALK} AND c.ts_ms >= ?1 * 1000 AND c.ts_ms < ?2 * 1000
     WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.uuid = p.uuid AND s.end_ts >= ?1 AND s.start_ts < ?2)
     GROUP BY lower(${canonName('p.name')}) ORDER BY n DESC, name COLLATE NOCASE`
  ).bind(season.lo, season.hi).all();
  return json({ players: results });
}

// GET /api/chat/player?uuid=… (or name=…) — one player's chat at a glance:
//   their name as chat last showed it, messages sent (all time and since today=UNIX_SECONDS),
//   and with events=1 their messages, deaths and advancements: [id, ts, kind, text] in time order.
export async function playerChat(env, url, season) {
  const q = url.searchParams;
  const db = env.DB;
  const lo = season.lo * 1000, hi = season.hi * 1000;
  const uuid = q.get('uuid');
  if (uuid && !UUID_RE.test(uuid)) return json({ error: 'bad uuid' }, 400);
  // all of their accounts (src/aliases.js), shown as the main one
  const group = await playerGroup(db, uuid ? { uuid: uuid.toLowerCase() } : { name: q.get('name') || '' });
  if (!group) return json({ error: 'not found' }, 404);
  const ids = group.uuids, inIds = `uuid IN (${marks(ids)})`;
  const today = Math.floor(Number(q.get('today')) || 0) * 1000;
  const stmts = [
    // their name as chat showed it by the end of the season (or before it, if they haven't talked in it)
    db.prepare(`SELECT display FROM chat WHERE ${inIds} AND display IS NOT NULL AND ts_ms < ? ORDER BY ts_ms DESC LIMIT 1`)
      .bind(...ids, Math.max(hi, lo + 1)),
    db.prepare(`SELECT COUNT(*) AS total, SUM(ts_ms >= ?) AS today FROM chat WHERE ${inIds} AND kind IN ${TALK} AND ts_ms >= ? AND ts_ms < ?`)
      .bind(today, ...ids, lo, hi),
    db.prepare('SELECT MIN(ts_ms) AS ts FROM chat WHERE ts_ms >= ? AND ts_ms < ?').bind(lo, hi),
  ];
  if (q.get('events') === '1') {
    stmts.push(db.prepare(
      `SELECT id, ts_ms, kind, substr(text, 1, 200) FROM chat
       WHERE ${inIds} AND kind IN ('chat', 'say', 'emote', 'death', 'advancement') AND ts_ms >= ? AND ts_ms < ? AND hidden = 0
       ORDER BY ts_ms DESC LIMIT 20000`
    ).bind(...ids, lo, hi));
  }
  const [d, counts, first, events] = await db.batch(stmts);
  const body = {
    uuid: group.uuid,
    name: group.name,
    display: d.results[0] ? JSON.parse(d.results[0].display) : null,
    total: counts.results[0].total,
    today: counts.results[0].today ?? 0,
    data_start: first.results[0].ts,
  };
  if (events) body.events = events.results.map((r) => Object.values(r)).reverse();
  return json(body);
}
