'use strict';

/* ---------- small DOM helpers ---------- */

const $ = (sel) => document.querySelector(sel);
const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
}

function sv(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// Looked up by name: servers in offline mode (or query-only player lists) report
// made-up v3 UUIDs that skin services don't know, which renders everyone as Steve.
// minotar renders current skins reliably (incl. slim/newer skins mc-heads shows as Steve).
const head = (name, size) => `https://minotar.net/helm/${encodeURIComponent(name)}/${size}`;
const headFallback = (name, size) => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/${size}`;

// One-shot fallback to a second skin service if the first fails to load.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.name || img.dataset.fellBack) return;
  img.dataset.fellBack = '1';
  img.src = headFallback(img.dataset.name, img.dataset.size);
}, true);

function headImg(name, size, attrs = {}) {
  const img = el('img', { src: head(name, size), alt: '', loading: 'lazy', ...attrs });
  img.dataset.name = name;
  img.dataset.size = size;
  return img;
}

/* ---------- seasons ---------- */

// Every server has its own pages under /<server> (BASE): the main page shows the server's current
// season, and BASE/s1 (and later /s2, …) show past ones. The Worker tells the page which server it's on and
// its current season (window.MCS, from src/index.js). A season that's over is shown as of its end: the
// page's clock stops there.
const MCS = window.MCS || { base: '', name: 'mcstats', season: 1 };
const BASE = MCS.base || '';
const CURRENT_SEASON = Number(MCS.season) || 1;
const SEASON = Number(location.pathname.slice(BASE.length).match(/^\/s(\d+)\/?$/)?.[1]) || CURRENT_SEASON;
const SITE = SEASON < CURRENT_SEASON ? `Season ${SEASON} · ${MCS.name || 'mcstats'}` : (MCS.name || 'mcstats');
// A season's page: BASE for the current one, BASE/sN for an earlier one.
const seasonHref = (n) => (n === CURRENT_SEASON ? BASE : `${BASE}/s${n}`);
// ?dummydata on the main page fills it with made-up activity (public/dummy.js). The chat log stays empty.
const DUMMY = SEASON === CURRENT_SEASON && new URLSearchParams(location.search).has('dummydata');
let clockStop = Infinity; // the last moment of a finished season (unix seconds)
const archived = () => clockStop !== Infinity;

/* ---------- time helpers (everything shown in the server's configured zone) ---------- */

let TZ = 'America/Los_Angeles';
let POLL = 60;
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtCache = new Map();
const hourCache = new Map();

function setTz(tz) {
  if (tz === TZ && fmtCache.size) return;
  TZ = tz;
  fmtCache.clear();
  hourCache.clear();
}

function formatter(opts) {
  const key = JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

const fmt = (ts, opts) => formatter(opts).format(ts * 1000);

// Local date/hour/weekday for an hour. Pacific offsets are whole hours, so a UTC hour
// is also exactly one local hour.
function hourInfo(ts) {
  const h = Math.floor(ts / 3600) * 3600;
  let v = hourCache.get(h);
  if (!v) {
    const p = {};
    const f = formatter({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
    for (const { type, value } of f.formatToParts(h * 1000)) p[type] = value;
    v = { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, dow: DOWS.indexOf(p.weekday) };
    hourCache.set(h, v);
  }
  return v;
}

const nowSec = () => Math.floor(Math.min(Date.now() / 1000, clockStop));
const todayStr = () => hourInfo(nowSec()).date;

function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const dowOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const fmtDay = (d, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

function startOfTodayTs() {
  const now = nowSec();
  return Math.floor(now / 3600) * 3600 - hourInfo(now).hour * 3600;
}

function hourName(h, short) {
  const ap = h < 12 ? (short ? 'a' : ' AM') : (short ? 'p' : ' PM');
  return `${h % 12 || 12}${ap}`;
}

function dur(secs) {
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h >= 100) return `${h.toLocaleString()}h`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function ago(ts) {
  if (archived()) return fmt(ts, { month: 'short', day: 'numeric', year: 'numeric' }); // "3h ago" means little once it's over
  const s = nowSec() - ts;
  if (s < 150) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return fmt(ts, { month: 'short', day: 'numeric', year: 'numeric' });
}

const fmtHours = (h) => (h >= 100 ? Math.round(h).toLocaleString() : h >= 10 ? h.toFixed(0) : h.toFixed(1));

// Split [start, end) into pieces that each fall inside one hour.
function eachHourChunk(start, end, fn) {
  let t = start;
  while (t < end) {
    const h = Math.floor(t / 3600) * 3600;
    const e = Math.min(end, h + 3600);
    fn(h, e - t);
    t = e;
  }
}

/* ---------- API ---------- */

class AuthError extends Error {}
// The database's free plan ran out of reads for the day; nothing loads until it resets.
class DbLimitError extends Error {}
function dbLimitMessage(resetsAt) {
  const at = new Date((resetsAt || Math.ceil(Date.now() / 86_400_000) * 86_400) * 1000)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  return `The site hit its database’s free-plan daily limit, so nothing can load until about ${at} today, when the limit resets. No data is lost; please check back then.`;
}

// Every request is for this page's season.
async function api(path) {
  if (DUMMY && !path.startsWith('/api/roster')) return (await dummyApi())(path);
  const url = `${path}${path.includes('?') ? '&' : '?'}season=${SEASON}`;
  const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (res.status === 401) {
    // not let in on this server (any more): its join page
    if (MCS.slug) location.assign(`/join?server=${encodeURIComponent(MCS.slug)}`);
    throw new AuthError('unauthorized');
  }
  if (res.status === 503) {
    const body = await res.json().catch(() => null);
    if (body?.error === 'db_limit') {
      const msg = dbLimitMessage(body.resets_at);
      showError(msg);
      throw new DbLimitError(msg);
    }
  }
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

// The sample data's generator, loaded only when it's asked for. It answers the same requests the server would.
let dummy = null;
function dummyApi() {
  dummy ??= new Promise((resolve, reject) => {
    const script = el('script', { src: '/dummy.js' });
    script.onload = () => rosterLoad.then((players) => resolve(window.createDummyApi({ roster: players, tz: TZ, ...Object.assign({}, ...addons('sampleData')) })));
    script.onerror = () => reject(new Error('couldn’t load the sample data'));
    document.head.append(script);
  });
  return dummy;
}

/* ---------- teams and real names ---------- */

// The season's teams, from the server (its roster table, so real names stay out of the repository).
const roster = new Map(); // lowercased IGN -> { ign, name, team }
const rosterAliases = new Map(); // another account's lowercased name -> its player's lowercased IGN
let nameMode = recall('nameMode') === 'real' ? 'real' : 'ign'; // what the IGN / Name switch shows

// The season's teams, in their order: [{ id, name, short, color, color_dark, bar, middle, chart,
// activity, activity_with }] (the admin page edits them). bar and chart say how much of the Combat
// page a team is part of (middle: in the scoreboard bar, but between its two sides rather than as a
// side of its own), activity whether the Activity page's by-team charts show it as a series, and
// activity_with the team whose series its playtime counts in instead. Everything colored by team gets
// its color from a stylesheet written here (the page's own carries red and blue until this loads).
let teams = [];
const teamById = new Map();
const teamInfo = (id) => teamById.get(id) || null;
const teamLabel = (id) => teamInfo(id)?.name || id;
const teamShort = (id) => teamInfo(id)?.short || id;
const teamVar = (id) => `var(--team-${id})`;
// The teams with a series of their own in the Activity page's charts, and the one a team's playtime
// counts in there: itself, the team it's grouped with, or none (left out of those charts).
const activityTeams = () => teams.filter((t) => t.activity && !t.activity_with);
function activityTeam(id) {
  const t = teamById.get(id);
  if (!t) return null;
  if (!t.activity_with) return t.activity ? t.id : null;
  const w = teamById.get(t.activity_with);
  return w && w.activity && !w.activity_with ? w.id : null;
}
const TEAM_DEFAULTS = {
  red: { name: 'Red Faction', short: 'Red', color: '#d93a33', color_dark: '#f27a72' },
  blue: { name: 'Blue Faction', short: 'Blue', color: '#2a6fe3', color_dark: '#6ea8f5' },
};
const TEAM_ID = /^[a-z][a-z0-9-]{0,19}$/;
const HEX = /^#[0-9a-f]{6}$/i;

function setTeams(list, players) {
  const out = (list || []).filter((t) => t && TEAM_ID.test(t.id) && HEX.test(t.color || ''));
  // a team the roster names that isn't listed (an older dashboard, or one not set up yet) still shows
  for (const p of players || []) {
    if (!TEAM_ID.test(p.team || '') || out.some((t) => t.id === p.team)) continue;
    const d = TEAM_DEFAULTS[p.team];
    const name = p.team[0].toUpperCase() + p.team.slice(1);
    out.push({ id: p.team, name: d?.name || name, short: d?.short || name, color: d?.color || '#7a7f87', color_dark: d?.color_dark || null, bar: true, middle: false, chart: true, activity: true, activity_with: null });
  }
  teams = out;
  teamById.clear();
  for (const t of teams) teamById.set(t.id, t);
  writeTeamStyles();
}

// On a dark page a team's color is its own dark one, or the light one lifted toward white.
const darkOf = (t) => (HEX.test(t.color_dark || '') ? t.color_dark : `color-mix(in oklab, ${t.color} 62%, white)`);
function writeTeamStyles() {
  let sheet = document.getElementById('team-styles');
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = 'team-styles';
    document.head.append(sheet);
  }
  const vars = (pick) => teams.map((t) => `--team-${t.id}:${pick(t)};`).join('');
  const rules = teams.map(({ id }) => {
    const c = `var(--team-${id})`;
    return `.team-${id}{color:${c}}.team-dot.team-${id},.bar.team-${id},.fb-kills.fb-${id},.fb-key.fb-kills.fb-${id}{background:${c}}`
      + `.dbar.team-${id}{fill:${c}}.line-${id}{fill:none;stroke:${c};stroke-width:1.25;stroke-linejoin:round;stroke-linecap:round}`
      + `.area-${id}{fill:${c};opacity:.3}.fb-own.fb-${id},.fb-other.fb-${id},.fb-all.fb-${id}{--c:${c}}.fb-count.fb-${id} strong,.fb-end.fb-${id} strong{color:${c}}`
      + `.dl-row.by-${id}{border-left-color:${c}}.dl-row.by-${id} .dl-icon,.adm-team-${id} .adm-ign{color:${c}}`
      + `.heat-${id}{--lv1:color-mix(in oklab,${c} 30%,var(--lv0));--lv2:color-mix(in oklab,${c} 55%,var(--lv0));--lv3:color-mix(in oklab,${c} 78%,var(--lv0));--lv4:${c}}`;
  }).join('\n');
  sheet.textContent = `:root{${vars((t) => t.color)}}\n`
    + `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${vars(darkOf)}}}\n`
    + `:root[data-theme="dark"]{${vars(darkOf)}}\n${rules}`;
}

const rosterLoad = api('/api/roster').then((r) => {
  for (const a of r.aliases || []) rosterAliases.set(a.alias.toLowerCase(), a.name.toLowerCase());
  setTeams(r.teams, r.players);
  setTeamHistory(r.history);
  return r.players;
}, () => []).then((players) => {
  for (const p of players) roster.set(p.ign.toLowerCase(), p);
  syncNameToggle();
  syncHeatToggle();
  return players;
});

// A player's earlier teams, when a team change was made to count only from then on (the admin page):
// lowercased IGN -> [{ until (unix seconds), team }], oldest first. Before `until` they were on `team`.
const teamHistory = new Map();
function setTeamHistory(list) {
  teamHistory.clear();
  for (const h of list || []) {
    const key = h.ign.toLowerCase();
    if (!teamHistory.has(key)) teamHistory.set(key, []);
    teamHistory.get(key).push({ until: h.until, team: h.team });
  }
  for (const entries of teamHistory.values()) entries.sort((a, b) => a.until - b.until);
}
const historyOf = (ign) => (ign ? teamHistory.get(ign.toLowerCase()) ?? teamHistory.get(rosterAliases.get(ign.toLowerCase())) : null);
// The team a player was on at a time (unix seconds): what the by-team charts and Combat count by.
// Names show the team they're on now.
function teamAt(ign, ts) {
  const h = historyOf(ign);
  if (h) for (const e of h) if (ts < e.until) return e.team;
  return rosterOf(ign)?.team ?? null;
}
// A stretch of a player's time, cut where they changed teams: [[team, from, to], …].
function teamSpans(ign, from, to) {
  const now = rosterOf(ign)?.team ?? null;
  const h = historyOf(ign);
  if (!h) return [[now, from, to]];
  const out = [];
  let t = from;
  for (const e of h) {
    if (t >= to) break;
    if (t < e.until) {
      out.push([e.team, t, Math.min(to, e.until)]);
      t = Math.min(to, e.until);
    }
  }
  if (t < to) out.push([now, t, to]);
  return out;
}

const rosterOf = (ign) => (ign ? roster.get(ign.toLowerCase()) ?? roster.get(rosterAliases.get(ign.toLowerCase())) : null);
const realName = (ign) => rosterOf(ign)?.name ?? null;
const shownName = (ign) => (nameMode === 'real' && realName(ign)) || ign;
// the name that isn't shown, for hovering
const otherName = (ign) => (realName(ign) ? (nameMode === 'real' ? ign : realName(ign)) : null);

// A styled name ([{ t, c }] pieces, as chat shows it) with the IGN swapped for the real name when that's shown.
// The game puts a team tag ([RED], [BLUE], …) before each name; the name's color already says it.
const noTag = (t) => t.replace(/\[([A-Z0-9_-]{2,20})\]\s*/g, (tag, word) => (word === 'RED' || word === 'BLUE'
  || teams.some((x) => x.id.toUpperCase() === word || x.short.toUpperCase() === word) ? '' : tag));
function swapParts(parts, ign) {
  const real = nameMode === 'real' && ign && realName(ign);
  return parts
    .map((p) => ({ ...p, t: real && p.t.includes(ign) ? noTag(p.t).replace(ign, real) : noTag(p.t) }))
    .filter((p) => p.t);
}

// Colors a name by team, with the other name on hover.
function teamName(node, ign) {
  const r = rosterOf(ign);
  if (r) node.classList.add('team', `team-${r.team}`);
  const other = otherName(ign);
  if (other) node.title = other;
  return node;
}

function syncNameToggle() {
  const t = $('#name-toggle');
  t.hidden = !roster.size;
  for (const b of t.children) b.setAttribute('aria-pressed', String(b.dataset.v === nameMode));
}
$('#name-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === nameMode) return;
  nameMode = b.dataset.v;
  remember('nameMode', nameMode);
  syncNameToggle();
  rerenderNames();
});

/* ---------- add-ons ---------- */

// Features only some servers have live apart from this file, in public/addons/<id>/ (src/addons.js): the
// Worker puts a server's add-ons on its page ahead of this script, and each adds itself to
// window.MCS_ADDONS as { id, setup(api), …hooks }. setup gets the helpers below once. The hooks, all
// optional, are asked at the places they name:
//   playerTags(name, gear) -> [nodes]    after the team on a player's page
//   modelLines(name, gear) -> [nodes]    lines under the player's 3D model
//   modelSpec(name, gear)  -> { offhand?, aura? }  what the model holds in its off hand, and its particles
//   playerCard(name, gear) -> node|null  a card beside Combat on the player's page
//   rosterColumn()         -> { key, title, plural, none, options: [[value, label]], label(value) }
//                             a column on Admin → Teams' roster and in Players, kept in the roster row's `key`
//   sampleData()           -> options for the sample data's generator (public/dummy.js)
// With no add-ons, every one of those places is simply empty.
const ADDONS = Array.isArray(window.MCS_ADDONS) ? window.MCS_ADDONS : [];
let addonsSetUp = false;
function addons(hook, ...args) {
  if (!addonsSetUp) {
    addonsSetUp = true;
    for (const a of ADDONS) a.setup?.({ el, $, icon, recall, remember, ago, rosterOf, BASE });
  }
  const out = [];
  for (const a of ADDONS) {
    try {
      const r = a[hook]?.(...args);
      if (r != null) out.push(r);
    } catch (err) {
      console.error(`add-on ${a.id}, ${hook}:`, err);
    }
  }
  return out;
}

/* ---------- layout: how each page's sections and number tiles are arranged (Admin → Layout) ---------- */

// The same pages, sections and tiles as src/layout.js, as the admin page names them.
//   section: [id, name, glyph (the little drawing Admin → Layout shows), renamable, note?]
const LAYOUT_PAGES = {
  home: {
    name: 'Activity', href: '#/',
    sections: [
      ['about', 'About the server', 'about', false, 'Icon, name and description from Server. Shown when Server → Header is on (on by default once there’s an icon).'],
      ['now', 'Right now', 'tiles', false, 'The number tiles and who’s online'],
      ['timeline', 'Players online', 'line', true],
      ['daily', 'Daily activity', 'bars', true],
      ['leaderboard', 'Leaderboard', 'rows', true],
      ['busiest', 'Busiest times', 'grid', true],
      ['commands', 'In-game commands', 'rows', true],
    ],
    tiles: [['online', 'Online now'], ['peak', 'Peak today'], ['played', 'Total played'], ['seen', 'Players seen']],
  },
  player: {
    name: 'Player', href: null,
    sections: [
      ['addon', 'Add-on card', 'card', false, 'What the server’s add-ons show beside Combat. Only there with an add-on.'],
      ['combat', 'Combat', 'score', true],
      ['activity', 'Activity', 'bars', true],
      ['when', 'When they play', 'grid', true],
      ['recent', 'Recent sessions', 'rows', true],
      ['advancements', 'Advancements', 'tree', true, 'Shows once the mod has sent their advancements.'],
    ],
    tiles: [['total', 'Total played'], ['sessions', 'Sessions'], ['longest', 'Longest session'], ['chat', 'Chat messages']],
  },
  combat: {
    name: 'Combat', href: '#/combat',
    sections: [['score', 'Teams', 'score', true], ['chart', 'Kills and deaths over time', 'bars', true], ['leaderboard', 'Leaderboard', 'rows', true]],
    tiles: null,
  },
};
const LAYOUT_DEFAULT_W = {
  home: { about: 'full', now: 'full', timeline: 'full', daily: 'full', leaderboard: 'wide', busiest: 'narrow', commands: 'full' },
  player: { addon: 'narrow', combat: 'wide', activity: 'full', when: 'narrow', recent: 'wide', advancements: 'full' },
  combat: { score: 'full', chart: 'full', leaderboard: 'full' },
};
const LAYOUT_SPAN = { full: 6, wide: 4, half: 3, narrow: 2 };

// Every page and tile, in a layout's order, filled in where it says nothing (as src/layout.js cleanLayout).
function fullLayout(l) {
  const out = { tiles: {} };
  for (const [page, info] of Object.entries(LAYOUT_PAGES)) {
    const ids = info.sections.map(([id]) => id);
    const given = (Array.isArray(l?.[page]) ? l[page] : []).filter((s) => ids.includes(s?.id));
    const rows = given.map((s) => ({ id: s.id, w: LAYOUT_SPAN[s.w] ? s.w : LAYOUT_DEFAULT_W[page][s.id], ...(s.hide && { hide: true }), ...(s.title && { title: s.title }) }));
    for (const id of ids) if (!rows.some((r) => r.id === id)) rows.push({ id, w: LAYOUT_DEFAULT_W[page][id] });
    out[page] = rows;
    if (info.tiles) {
      const tids = info.tiles.map(([id]) => id);
      const t = (Array.isArray(l?.tiles?.[page]) ? l.tiles[page] : []).filter((x) => tids.includes(x?.id)).map((x) => ({ id: x.id, ...(x.hide && { hide: true }) }));
      for (const id of tids) if (!t.some((x) => x.id === id)) t.push({ id });
      out.tiles[page] = t;
    }
  }
  return out;
}
const defaultLayout = () => fullLayout({});
let layoutSaved = fullLayout(MCS.layout); // as everyone sees it

// A section's heading, where it can be renamed.
const layoutHeading = (node) => node.querySelector(':scope > .card-head h2');

// Rows of sections in a 6-column grid: each takes its width, and the last one in a row grows to fill it,
// so a section that's switched off (or has nothing to show yet, like Advancements) leaves no hole.
function packLayout(box) {
  const items = [...box.children].filter((n) => n.dataset.sec && !n.hidden && !n.classList.contains('lay-off'));
  let row = [], used = 0;
  const close = () => {
    if (!row.length) return;
    row.at(-1)[1] += 6 - used;
    for (const [n, span] of row) {
      n.style.setProperty('--span', span);
      n.classList.toggle('lay-solo', row.length === 1);
    }
    row = [];
    used = 0;
  };
  for (const n of items) {
    const span = LAYOUT_SPAN[n.dataset.w] || 6;
    if (used + span > 6) close();
    row.push([n, span]);
    used += span;
  }
  close();
}

// Puts a layout on the page: the saved one, or Admin → Layout's while it's being changed.
function applyLayout(layout, { redraw = true } = {}) {
  for (const page of Object.keys(LAYOUT_PAGES)) {
    const box = document.querySelector(`.lay[data-page="${page}"]`);
    if (!box) continue;
    for (const s of layout[page]) {
      const node = box.querySelector(`:scope > [data-sec="${s.id}"]`);
      if (!node) continue;
      box.append(node);
      node.dataset.w = s.w;
      node.classList.toggle('lay-off', !!s.hide);
      const h = layoutHeading(node);
      if (h) {
        h.dataset.title0 ??= h.textContent;
        h.textContent = s.title || h.dataset.title0;
      }
    }
    packLayout(box);
  }
  for (const [page, tiles] of Object.entries(layout.tiles)) {
    const box = document.querySelector(`[data-tiles="${page}"]`);
    if (!box) continue;
    for (const t of tiles) {
      const node = box.querySelector(`:scope > [data-tile="${t.id}"]`);
      if (node) { box.append(node); node.classList.toggle('lay-off', !!t.hide); }
    }
    const shown = [...box.children].filter((n) => !n.classList.contains('lay-off'));
    box.dataset.n = String(shown.length);
    // in a row of two, an odd one out takes the whole row
    for (const n of box.children) n.classList.toggle('tile-wide', shown.length % 2 === 1 && n === shown.at(-1));
  }
  if (redraw) redrawCharts();
}
// a section that shows or hides itself (no add-on card, no advancements yet) is packed again
for (const box of document.querySelectorAll('.lay')) {
  const mo = new MutationObserver(() => packLayout(box));
  for (const n of box.children) mo.observe(n, { attributes: true, attributeFilter: ['hidden'] });
}
applyLayout(layoutSaved, { redraw: false });

// The top of the Activity page: the server's icon, name and description (Admin → Server), as saved, or as
// they're being changed there.
// Shown only when the owner switches it on; until they choose, it's on once there's an icon.
const bannerOn = (setting, iconUrl) => (setting === '1' ? true : setting === '0' ? false : !!iconUrl);
function renderAbout() {
  const f = srv.draft;
  const about = f ? f.about.trim() : MCS.about || '';
  const iconUrl = f && f.icon !== undefined ? f.icon || null : MCS.icon || null;
  const img = $('#about-icon');
  $('#about-card').hidden = !bannerOn(f ? f.banner : MCS.banner || '', iconUrl) || (!about && !iconUrl);
  $('#about-name').textContent = (f?.name.trim() || MCS.name || '');
  $('#about-desc').textContent = about;
  $('#about-desc').hidden = !about;
  img.hidden = !iconUrl;
  if (iconUrl && img.getAttribute('src') !== iconUrl) img.src = iconUrl;
}

// What players can type in game: the mod's /mcstats commands (mod McstatsCommands.HELP). Keep them in step with the mod.
//   [command, what it does, id]: the id is what Admin → Mod and commands switches it off by (src/commands.js);
//   help has none, and can't be switched off.
const MC_COMMANDS = [
  ['/mcstats', 'Open the mcstats menu', 'view'],
  ['/mcstats profile', 'Choose what you hold and your particles on the website', 'profile'],
  ['/mcstats stats', 'Every player’s stats', 'stats'],
  ['/mcstats stats <player>', 'One player’s stats', 'stats'],
  ['/mcstats top', 'Leaderboards', 'top'],
  ['/mcstats link', 'A link to your page on the website', 'link'],
  ['/mcstats connect', 'Connect your mcstats account, to chat as yourself here', 'connect'],
  ['/mcstats disconnect', 'Disconnect your mcstats account', 'disconnect'],
  ['/mcstats particle <name>', 'Set your particles (or none)', 'particle'],
  ['/mcstats reset', 'Go back to the automatic look', 'reset'],
  ['/mcstats help', 'This list, in game', null],
];
// The mod's /liveview commands (LiveviewCommands.java), for Admin → Mod and commands. op: operators only.
const LIVEVIEW_COMMANDS = [
  ['/liveview help', 'List these commands in game', false],
  ['/liveview who', 'Who is watching right now', true],
  ['/liveview access', 'Which dashboard accounts may use Liveview', true],
  ['/liveview access viewer <account>', 'Let an account watch', true],
  ['/liveview access control <account>', 'Let an account watch and use controls', true],
  ['/liveview access remove <account>', 'Take an account off the list', true],
  ['/liveview key viewer', 'Make a new viewer key (the old one stops working)', true],
  ['/liveview key control', 'Make a new control key (the old one stops working)', true],
];
// The In-game commands box on the Activity page: the commands that are on (MCS.commands.off are the ones the
// server's admins switched off), each a button that copies it. Unless the admins chose otherwise the box
// starts closed, and its heading opens it. open: what this visitor did with it since the page loaded.
let commandsOpen = null;
function renderCommands() {
  const list = $('#cmd-list');
  if (!list) return;
  const off = MCS.commands?.off || [];
  const fold = MCS.commands ? MCS.commands.fold !== false : true;
  const rows = MC_COMMANDS.filter(([, , id]) => !id || !off.includes(id));
  list.replaceChildren(...rows.map(([cmd, what]) => {
    // up to the first "<": the part that can be typed as it is, as the mod's own help does
    const typed = cmd.includes('<') ? cmd.slice(0, cmd.indexOf('<')) : cmd;
    const btn = el('button', { type: 'button', class: 'cmd-code', title: `Copy ${typed.trim()}`, text: cmd });
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(typed);
        toast(`Copied ${typed.trim()}`);
      } catch {
        toast('Couldn’t copy. Type it in Minecraft chat.', { error: true });
      }
    });
    return el('li', { class: 'cmd-row' }, btn, el('span', { class: 'cmd-what', text: what }));
  }));
  const card = list.closest('.card'), head = card?.querySelector('.card-head');
  if (!head) return;
  const open = !fold || commandsOpen === true;
  card.classList.toggle('cmd-fold', fold);
  card.classList.toggle('cmd-closed', !open);
  list.hidden = !open;
  const sub = head.querySelector('.card-sub');
  if (sub) sub.textContent = open ? 'type these in Minecraft chat · click one to copy it' : 'what players can type in Minecraft chat · click to show';
  if (fold) {
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', String(open));
    head.setAttribute('aria-controls', 'cmd-list');
  } else for (const a of ['role', 'tabindex', 'aria-expanded', 'aria-controls']) head.removeAttribute(a);
  if (!head.dataset.fold) {
    head.dataset.fold = '1';
    const flip = () => {
      if (!card.classList.contains('cmd-fold')) return;
      commandsOpen = card.classList.contains('cmd-closed');
      renderCommands();
    };
    head.addEventListener('click', flip);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
  }
}

/* ---------- gear ---------- */

// The best weapon they carry: mace, then trident, sword, spear, axe, pickaxe, shovel; better material first.
const WEAPON_KINDS = ['mace', 'trident', 'sword', 'spear', 'axe', 'pickaxe', 'shovel'];
const TOOL_MATERIALS = ['netherite', 'diamond', 'iron', 'copper', 'stone', 'golden', 'wooden'];
function weaponRank(it) {
  if (!it || it.egg) return null; // an item the server mod marks as an egg (Egg SMP) is never the weapon
  const kind = WEAPON_KINDS.indexOf(it.id === 'mace' || it.id === 'trident' ? it.id : it.id.split('_').pop());
  if (kind < 0) return null;
  const mat = TOOL_MATERIALS.indexOf(it.id.split('_')[0]);
  return kind * 100 + (mat < 0 ? 50 : mat * 2) + (it.glint ? 0 : 1);
}
function bestWeapon(gear) {
  let best = null, bestRank = Infinity;
  for (const it of [gear?.mainhand, gear?.offhand, ...(gear?.items || [])]) {
    const r = weaponRank(it);
    if (r != null && r < bestRank) [best, bestRank] = [it, r];
  }
  return best;
}
const itemKind = (it) => it.id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const itemName = (it) => it.name || itemKind(it);

// Every weapon and tool they carry, best first; the same item twice is one entry with a count.
// (The held item is also in the inventory list, unless that list was cut short.)
const gearKey = (it) => JSON.stringify([it.id, it.name || '', !!it.glint, it.model || '']);
function carriedWeapons(gear) {
  const seen = new Map();
  for (const it of [gear?.offhand, ...(gear?.items || [])]) {
    if (weaponRank(it) == null) continue;
    const k = gearKey(it);
    if (seen.has(k)) seen.get(k).count++;
    else seen.set(k, { item: it, key: k, count: 1 });
  }
  const held = gear?.mainhand;
  if (weaponRank(held) != null && !seen.has(gearKey(held))) seen.set(gearKey(held), { item: held, key: gearKey(held), count: 1 });
  return [...seen.values()].sort((a, b) => weaponRank(a.item) - weaponRank(b.item));
}

// An item's name in the game's colors, and its tooltip: as the server mod sent it with the gear (1.9.0
// and newer); else as a death message in the chat log showed it (gear.styles); else in the color the
// game gives its rarity (aqua when it's enchanted).
const RARITY = { common: '#ffffff', uncommon: '#ffff55', rare: '#55ffff', epic: '#ff55ff' };
function itemRarity(it) {
  const base = it.id === 'mace' ? 'epic' : it.id === 'trident' ? 'rare' : 'common';
  if (!it.glint) return base;
  return base === 'epic' || base === 'rare' ? 'epic' : 'rare';
}
function gearItemLook(it, styles) {
  // the tooltip the server mod sent with the gear (1.9.0 and newer): its first line is the name in its colors
  if (it.tip?.[0]?.length) return { name: it.tip[0].map(({ t, c }) => ({ t, ...(c ? { c } : {}) })), tip: it.tip, note: null };
  const known = it.name && styles?.[it.name];
  const color = RARITY[itemRarity(it)];
  if (known) {
    return {
      name: known.name,
      tip: known.tip,
      note: known.tip ? `As a death message showed it, ${fmt(known.ts / 1000, { month: 'short', day: 'numeric' })}` : null,
    };
  }
  return {
    name: [{ t: itemName(it), c: color }],
    // a custom name is slanted in the game's tooltips
    tip: [[{ t: itemName(it), c: color, ...(it.name ? { i: 1 } : {}) }]],
    note: it.name
      ? 'Its enchantments show here once a death message in the chat log names it.'
      : it.glint ? 'Enchanted. Which enchantments shows here once the server runs mcstats-chat 1.9.0.' : null,
  };
}

/* ---------- tooltip ---------- */

const tip = $('#tooltip');
// Clicking what a tooltip is for freezes it where it is (tipPinned), so it can be read, scrolled and
// selected; it stays until a click anywhere outside it (or Escape). While it's frozen nothing else
// shows or hides a tooltip.
let tipPinned = false;
let tipSkipPin = false; // the click that closed a frozen tooltip doesn't freeze another

// rows: [{ value, label, color }]
function showTip(x, y, rows) {
  if (tipPinned) return;
  tip.replaceChildren(
    ...rows.map((r) => {
      if (r.players) return playerList(r.players);
      if (r.node) return r.node;
      const row = el('div', { class: 'row' });
      if (r.color) row.append(el('span', { class: 'key', style: `background:${r.color}` }));
      if (r.value != null) row.append(el('span', { class: 'tv', text: r.value }));
      if (r.label) row.append(el('span', { class: 'tl', text: r.label }));
      return row;
    })
  );
  tip.classList.toggle('tip-item', rows.some((r) => r.node && !r.adv)); // an item's tooltip looks like the game's
  tip.classList.toggle('tip-adv', rows.some((r) => r.adv)); // and an advancement's like the advancements screen's
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = x + 14;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  let top = y - h - 10;
  if (top < 8) top = y + 18;
  // one too tall to fit below the pointer either keeps as much of itself on screen as it can
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}
const hideTip = () => { if (!tipPinned) tip.hidden = true; };
// Hides it even when it's frozen (the page under it changed).
function closeTip() {
  tipPinned = false;
  tip.classList.remove('pinned');
  tip.hidden = true;
}
document.addEventListener('click', (e) => {
  const skip = tipSkipPin;
  tipSkipPin = false;
  // (a click whose own handler hid the tooltip, or one on a link, isn't a click to keep it)
  if (skip || tipPinned || tip.hidden || tip.contains(e.target) || e.target.closest?.('a[href]')) return;
  tipPinned = true;
  tip.classList.add('pinned');
  const r = tip.getBoundingClientRect();
  if (r.bottom > window.innerHeight - 8) tip.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
});
document.addEventListener('pointerdown', (e) => {
  if (!tipPinned || tip.contains(e.target)) return;
  closeTip();
  tipSkipPin = true;
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tipPinned) closeTip(); });
// scrolling anything else moves what it was for out from under it
document.addEventListener('wheel', (e) => { if (tipPinned && !tip.contains(e.target)) closeTip(); }, { passive: true, capture: true });

const TIP_PLAYERS = 10;
const tipHeads = new Map(); // reused across tooltip redraws so heads don't blink while moving
function playerList(names) {
  const list = el('div', { class: 'tip-players' });
  // red team first, then blue, then anyone on neither; each in the order given
  const rank = (name) => { const i = teams.findIndex((t) => t.id === rosterOf(name)?.team); return i < 0 ? teams.length : i; };
  names = names.map((name, i) => [rank(name), i, name]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  for (const name of names.slice(0, TIP_PLAYERS)) {
    if (!tipHeads.has(name)) tipHeads.set(name, headImg(name, 14, { width: 14, height: 14, loading: 'eager' }));
    list.append(el('div', { class: 'tip-player' }, tipHeads.get(name), teamName(el('span', { text: shownName(name) }), name)));
  }
  if (names.length > TIP_PLAYERS) list.append(el('div', { class: 'tip-more', text: `+${names.length - TIP_PLAYERS} more` }));
  return list;
}

function attachCellTips(root, selector, getRows) {
  const handler = (e) => {
    const t = e.target.closest(selector);
    if (!t || !root.contains(t)) return hideTip();
    showTip(e.clientX, e.clientY, getRows(t));
  };
  root.addEventListener('pointermove', handler);
  root.addEventListener('pointerdown', handler);
  root.addEventListener('pointerleave', hideTip);
}

/* ---------- color levels ---------- */

function quantileLevels(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  return (v) => (v <= 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4);
}

function scaleLegend(lowLabel = 'Less', highLabel = 'More') {
  const s = el('div', { class: 'scale' }, el('span', { class: 'lbl', text: lowLabel }));
  for (let i = 0; i < 5; i++) s.append(el('span', { class: `sw lv${i}` }));
  s.append(el('span', { class: 'lbl', text: highLabel }));
  return s;
}

/* ---------- GitHub-style calendar heatmap ---------- */

// days: Map<'YYYY-MM-DD', number>, describe(date, value) -> tooltip rows
function renderHeatmap(root, days, describe) {
  root.replaceChildren();
  const end = todayStr();
  let start = addDays(end, -364);
  start = addDays(start, -dowOf(start));

  const dates = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  const cols = Math.ceil(dates.length / 7);

  const cell = 11, gap = 3, left = 30, top = 18;
  const W = left + cols * (cell + gap);
  const H = top + 7 * (cell + gap);
  const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Activity per day for the past year' });

  const level = quantileLevels(dates.map((d) => days.get(d) || 0));
  let lastMonth = '';
  dates.forEach((d, i) => {
    const col = Math.floor(i / 7);
    const row = i % 7;
    if (row === 0) {
      const month = d.slice(5, 7);
      if (month !== lastMonth && Number(d.slice(8)) <= 7 && col < cols - 1) {
        const t = sv('text', { x: left + col * (cell + gap), y: 11, class: 'axis-text' });
        t.textContent = fmtDay(d, { month: 'short' });
        svg.append(t);
        lastMonth = month;
      }
    }
    const v = days.get(d) || 0;
    const r = sv('rect', {
      x: left + col * (cell + gap), y: top + row * (cell + gap), width: cell, height: cell,
      class: `cell lv${level(v)}`,
    });
    r.dataset.d = d;
    svg.append(r);
  });

  [['Mon', 1], ['Wed', 3], ['Fri', 5]].forEach(([name, row]) => {
    const t = sv('text', { x: 0, y: top + row * (cell + gap) + 9, class: 'axis-text' });
    t.textContent = name;
    svg.append(t);
  });

  root.append(svg, scaleLegend());
  attachCellTips(root, 'rect.cell', (r) => describe(r.dataset.d, days.get(r.dataset.d) || 0));
  root.scrollLeft = root.scrollWidth; // most recent weeks visible on narrow screens
}

/* ---------- update effects ---------- */

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const FX = {
  green: ['#0ca30c', '#3ddc84', '#9af0b0', '#e3ffe9'],
  red: ['#d03b3b', '#ff6b6b', '#ffb0b0', '#ffe3e3'],
  blue: ['#2a78d6', '#5598e7', '#9ec5f4', '#e3f0ff'],
};

// Square "pixel" particles drawn on one full-screen canvas that only runs while particles exist.
const fx = (() => {
  const cv = el('canvas', { class: 'fx-canvas', 'aria-hidden': 'true' });
  document.body.append(cv);
  const ctx = cv.getContext('2d');
  let parts = [], raf = 0, last = 0, dpr = 1;
  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(window.innerWidth * dpr);
    cv.height = Math.round(window.innerHeight * dpr);
  };
  resize();
  window.addEventListener('resize', resize);
  const rand = (a, b) => a + Math.random() * (b - a);

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, cv.width, cv.height);
    parts = parts.filter((p) => now - p.born < p.life);
    for (const p of parts) {
      p.vx *= 1 - 2 * dt;
      p.vy = p.vy * (1 - 2 * dt) + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const age = (now - p.born) / p.life;
      const twinkle = p.twinkle ? 0.55 + 0.45 * Math.sin(now / 45 + p.phase) : 1;
      ctx.globalAlpha = Math.max(0, (1 - age * age) * twinkle);
      ctx.fillStyle = p.color;
      const s = Math.max(1, Math.round(p.size * dpr));
      ctx.fillRect(Math.round(p.x * dpr), Math.round(p.y * dpr), s, s);
    }
    ctx.globalAlpha = 1;
    raf = parts.length ? requestAnimationFrame(frame) : 0;
  }

  const api = {
    // One particle at viewport coordinates (x, y). Ranges are [min, max].
    spark(x, y, { colors, vx = [-20, 20], vy = [-40, -10], g = 0, life = [500, 900], size = [2, 3] }) {
      if (reducedMotion()) return;
      parts.push({
        x, y, vx: rand(...vx), vy: rand(...vy), g,
        born: performance.now(), life: rand(...life), size: Math.round(rand(...size)),
        color: colors[Math.floor(Math.random() * colors.length)],
        twinkle: Math.random() < 0.6, phase: Math.random() * 6.28,
      });
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    },
    burst(rect, { count = 16, ...opts }) {
      for (let i = 0; i < count; i++) {
        api.spark(rect.left + Math.random() * rect.width, rect.top + Math.random() * rect.height, opts);
      }
    },
  };
  return api;
})();

const burstUp = (node) => fx.burst(node.getBoundingClientRect(), {
  colors: FX.green, count: 18, vx: [-60, 60], vy: [-120, -30], g: 40, life: [600, 1100], size: [2, 4],
});
const burstDown = (node) => fx.burst(node.getBoundingClientRect(), {
  colors: FX.red, count: 18, vx: [-60, 60], vy: [-30, 30], g: 160, life: [600, 1100], size: [2, 4],
});

// A grid of square tiles on a canvas over `target` (inside `host`, which must be position: relative).
// mode 'clear': starts filled with `color`, tiles vanish one by one (a tint dissolving away).
// mode 'cover': tiles fill in with `color` one by one (the element disintegrating into the page).
function pixelTiles({ host, target, mode, color, tile = 4, pad = 0, hold = 0, duration = 800, sweep = 0.4, spark, onDone }) {
  if (reducedMotion()) { onDone?.(); return; }
  const hr = host.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  const w = Math.ceil(r.width + 2 * pad), h = Math.ceil(r.height + 2 * pad);
  const dpr = window.devicePixelRatio || 1;
  const cv = el('canvas', { class: 'fx-local', 'aria-hidden': 'true' });
  cv.width = Math.ceil(w * dpr);
  cv.height = Math.ceil(h * dpr);
  Object.assign(cv.style, {
    left: `${r.left - hr.left + host.scrollLeft - pad}px`,
    top: `${r.top - hr.top + host.scrollTop - pad}px`,
    width: `${w}px`, height: `${h}px`,
  });
  host.append(cv);
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = color;
  if (mode === 'clear') ctx.fillRect(0, 0, w, h);

  const cols = Math.ceil(w / tile), rows = Math.ceil(h / tile);
  const tiles = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      tiles.push({ x: x * tile, y: y * tile, at: hold + duration * ((x / cols) * sweep + Math.random() * (1 - sweep)) });
    }
  }
  tiles.sort((a, b) => a.at - b.at);

  let i = 0;
  const t0 = performance.now();
  const step = (now) => {
    const t = now - t0;
    const cr = cv.getBoundingClientRect();
    while (i < tiles.length && tiles[i].at <= t) {
      const tl = tiles[i++];
      if (mode === 'clear') ctx.clearRect(tl.x, tl.y, tile, tile);
      else ctx.fillRect(tl.x, tl.y, tile, tile);
      if (spark && Math.random() < spark.chance) fx.spark(cr.left + tl.x, cr.top + tl.y, spark);
    }
    if (i < tiles.length && cv.isConnected) requestAnimationFrame(step);
    else { cv.remove(); onDone?.(); }
  };
  requestAnimationFrame(step);
}

/* ---------- rolling counters ---------- */

const ROLL_MS = 650;

// Renders `text` with each digit in a vertical strip (0-9 twice) that can roll to a new digit.
function buildOdometer(node, text, fromText) {
  const fromDigits = fromText ? fromText.replace(/\D/g, '') : '';
  const digitCount = text.replace(/\D/g, '').length;
  let di = 0;
  const odo = el('span', { class: 'odo', 'aria-hidden': 'true' });
  for (const c of text) {
    if (/\d/.test(c)) {
      // right-align old digits against new ones; brand-new leading digits start at 0
      const oi = fromDigits.length - (digitCount - di);
      const start = fromText == null ? Number(c) : oi >= 0 ? Number(fromDigits[oi]) : 0;
      const strip = el('span', { class: 'odo-strip' });
      for (let k = 0; k < 20; k++) strip.append(el('span', { text: String(k % 10) }));
      strip.style.transform = `translateY(${-start * 1.2}em)`;
      strip.dataset.pos = start;
      odo.append(el('span', { class: 'odo-col' }, strip));
      di++;
    } else {
      odo.append(el('span', { class: 'odo-static', text: c }));
    }
  }
  node.replaceChildren(odo, el('span', { class: 'sr-only', text }));
}

function rollOdometer(node, text, up) {
  const targets = text.replace(/\D/g, '');
  const strips = node.querySelectorAll('.odo-strip');
  strips.forEach((strip, i) => {
    const t = Number(targets[i]);
    const cur = Number(strip.dataset.pos);
    if (t === cur) return;
    let to = t;
    if (up && t < cur) to = t + 10; // keep rolling forward through 9 -> 0
    if (!up && t > cur) {
      // jump to the identical digit in the second half, then roll backward
      strip.style.transition = 'none';
      strip.style.transform = `translateY(${-(cur + 10) * 1.2}em)`;
      void strip.offsetHeight;
    }
    const delay = (strips.length - 1 - i) * 60; // ones column moves first, like a clicker
    strip.style.transition = `transform ${ROLL_MS}ms cubic-bezier(.2,.8,.25,1) ${delay}ms`;
    strip.style.transform = `translateY(${-to * 1.2}em)`;
    strip.dataset.pos = t;
    if (to !== t) {
      strip.addEventListener('transitionend', () => {
        strip.style.transition = 'none';
        strip.style.transform = `translateY(${-t * 1.2}em)`;
      }, { once: true });
    }
  });
}

// Sets a tile's value. On live updates digits roll and particles burst green (up) or red (down).
function setCounter(node, text, value, animate) {
  const prevText = node.dataset.text;
  const prevValue = node.dataset.value === undefined || node.dataset.value === '' ? null : Number(node.dataset.value);
  node.dataset.text = text;
  node.dataset.value = value ?? '';
  if (prevText === text && node.querySelector('.odo')) return;

  const changed = animate && prevValue != null && value != null && value !== prevValue;
  if (!changed || reducedMotion()) {
    buildOdometer(node, text, null);
    return;
  }
  const up = value > prevValue;
  const shape = (s) => s.replace(/\d/g, '0');
  if (!node.querySelector('.odo') || shape(prevText) !== shape(text)) buildOdometer(node, text, prevText);
  requestAnimationFrame(() => rollOdometer(node, text, up));
  (up ? burstUp : burstDown)(node);
}

/* ---------- chart tweening ---------- */

const TWEEN_MS = 650;
const chartPrev = new Map(); // root -> what was last drawn, to tween from
const tweens = new Map();
const lerp = (a, b, e) => a + (b - a) * e;
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

function stopTween(root) {
  cancelAnimationFrame(tweens.get(root));
  tweens.delete(root);
}

function tween(root, draw) {
  stopTween(root);
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / TWEEN_MS);
    draw(easeInOut(k));
    if (k < 1) tweens.set(root, requestAnimationFrame(step));
    else tweens.delete(root);
  };
  draw(0);
  tweens.set(root, requestAnimationFrame(step));
}

// Paging with ‹ ›: the old drawing scrolls out as the new one scrolls in from the side it came from.
const SLIDE_MS = 450;
const sliding = new Map(); // root -> slides in progress
let slideClips = 0;
// shift: how far the content moves, in widths of the plot (-1 = a whole width earlier).
// Charts that keep their y-axis still (a .slide group inside a .slide-clip one) scroll like one long
// strip behind the plot's edges, by exactly the time the range moved: where the old and new drawings
// cover the same time only the new one shows, so a part-way step is a plain scroll too. Other
// charts slide whole, and cross-fade on a part-way step since the two drawings overlap.
function slideIn(root, old, shift) {
  const cur = root.firstElementChild;
  if (!old || !cur || !shift || reducedMotion()) return;
  const W = root.clientWidth;
  Object.assign(old.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
  root.style.overflow = 'hidden';
  sliding.set(root, (sliding.get(root) || 0) + 1);
  root.append(old);
  const opts = { duration: SLIDE_MS, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' };
  morphAxis(old, cur, opts);
  // Earlier (negative shift) moves content right, like scrolling back along a timeline.
  const oldBody = old.querySelector('.slide-clip > .slide'), curBody = cur.querySelector('.slide-clip > .slide');
  const box = root.plotBox;
  const strip = !!(oldBody && curBody && box);
  const dist = strip ? Math.max(1, Math.max(280, W) - box.l - box.r) : W;
  const fade = !strip && Math.abs(shift) < 0.999;
  const clips = [];
  if (strip) {
    const clip = (svg, node, x0, x1) => {
      const id = `slide-clip-${++slideClips}`;
      const c = sv('clipPath', { id });
      c.append(sv('rect', { x: x0, y: -50, width: Math.max(0, x1 - x0), height: 5000 }));
      svg.append(c);
      node.setAttribute('clip-path', `url(#${id})`);
      clips.push([c, node]);
    };
    // both drawings stay inside the plot, and the old one shows only the time the new one doesn't cover
    for (const [svg, body] of [[old, oldBody], [cur, curBody]]) clip(svg, body.parentNode, box.l - 1, box.l + dist + 1);
    if (shift < 0) clip(old, oldBody, box.l + dist * (1 + shift), box.l + dist + 1);
    else clip(old, oldBody, box.l - 1, box.l + dist * shift);
  }
  (oldBody && strip ? oldBody : old).animate([
    { transform: 'translateX(0)', opacity: 1 },
    { transform: `translateX(${-shift * dist}px)`, opacity: fade ? 0 : 1 },
  ], opts);
  (curBody && strip ? curBody : cur).animate([
    { transform: `translateX(${shift * dist}px)`, opacity: fade ? 0 : 1 },
    { transform: 'translateX(0)', opacity: 1 },
  ], opts).finished
    .catch(() => {})
    .finally(() => {
      old.remove();
      for (const [c, node] of clips) { c.remove(); node.removeAttribute('clip-path'); }
      const n = sliding.get(root) - 1;
      if (n) sliding.set(root, n);
      else { sliding.delete(root); root.style.overflow = ''; }
    });
}

// When a slide changes the y scale, the gridlines glide from where their values sat on the old
// scale to the new one (a 10 line moves from the top to the middle when the peak doubles).
// Lines only on the old scale fade out; lines only on the new one fade in.
function morphAxis(old, cur, opts) {
  const a = old.querySelector(':scope > .yaxis'), b = cur.querySelector(':scope > .yaxis');
  if (!a || !b) return;
  const top = Number(cur.dataset.top), ph = Number(cur.dataset.ph);
  const oldMax = Number(old.dataset.ymax), newMax = Number(cur.dataset.ymax);
  if (oldMax === newMax || Number(old.dataset.ph) !== ph) return;
  const yOld = (v) => top + ph - (v / oldMax) * ph;
  const yNew = (v) => top + ph - (v / newMax) * ph;
  const ticks = (g) => [...g.querySelectorAll('.ytick')];
  const newVals = new Set(ticks(b).map((t) => t.dataset.v));
  const oldVals = new Set(ticks(a).map((t) => t.dataset.v));
  for (const t of ticks(a)) {
    const v = Number(t.dataset.v);
    if (newVals.has(t.dataset.v)) { t.style.visibility = 'hidden'; continue; } // the new one covers it
    t.animate([
      { transform: 'translateY(0)', opacity: 1 },
      { transform: `translateY(${yNew(v) - yOld(v)}px)`, opacity: 0 },
    ], opts);
  }
  for (const t of ticks(b)) {
    const v = Number(t.dataset.v);
    t.animate([
      { transform: `translateY(${yOld(v) - yNew(v)}px)`, opacity: oldVals.has(t.dataset.v) ? 1 : 0 },
      { transform: 'translateY(0)', opacity: 1 },
    ], opts);
  }
}

/* ---------- hour × weekday grid ---------- */

const weekPrev = new Map();

// grid[dow][hour] = number, laid out like a week calendar: days across, hours running down.
// cellColor(d, h), when given, colors each cell itself (instead of the five levels), with its own legend.
// describe(value, label, d, h) -> tooltip rows
function renderWeekGrid(root, grid, describe, { animate = false, cellColor = null, legend = null } = {}) {
  root.replaceChildren();
  const max = Math.max(0, ...grid.flat());
  const level = (v) => (v <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));
  const g = el('div', { class: 'weekgrid', role: 'img', 'aria-label': 'Activity by weekday and hour' });

  g.append(el('span'));
  for (let d = 0; d < 7; d++) g.append(el('span', { class: 'dlabel', text: DOWS[d] }));
  const cells = [];
  for (let h = 0; h < 24; h++) {
    g.append(el('span', { class: 'hlabel', text: h % 3 ? '' : hourName(h, true) }));
    for (let d = 0; d < 7; d++) {
      const c = el('span', { class: cellColor ? 'wcell' : `wcell lv${level(grid[d][h])}` });
      if (cellColor) c.style.background = cellColor(d, h);
      c.dataset.d = d;
      c.dataset.h = h;
      g.append(c);
      cells.push(c);
    }
  }
  root.append(g, legend || scaleLegend());
  attachCellTips(root, '.wcell', (c) => {
    const d = Number(c.dataset.d), h = Number(c.dataset.h);
    return describe(grid[d][h], `${DOWS[d]} ${hourName(h)}–${hourName((h + 1) % 24)}`, d, h);
  });

  const prev = weekPrev.get(root);
  weekPrev.set(root, grid.map((row) => row.slice()));
  if (!animate || !prev) return;
  cells.forEach((c) => {
    const d = Number(c.dataset.d), h = Number(c.dataset.h);
    if (Math.abs(prev[d][h] - grid[d][h]) < 1e-9) return;
    const r = c.getBoundingClientRect();
    fx.burst({ left: r.left - 6, top: r.top - 6, width: r.width + 12, height: r.height + 12 }, {
      colors: FX.blue, count: 12, vx: [-35, 35], vy: [-50, -10], life: [600, 1100], size: [2, 3],
    });
  });
}

/* ---------- "no data yet" block ---------- */

// Where charts mark the season as beginning. Normally that's the first recorded check; when the
// season has an official start later than that (recording began early, to test), it's the official
// start: what was recorded before it still shows, drawn over the hatching.
const seasonOpens = () => state.status?.season?.opens ?? null;
const chartStart = () => Math.max(state.dataStart ?? 0, seasonOpens() ?? 0) || null;
function hatchText() {
  const opens = seasonOpens();
  if (!opens || opens <= (state.dataStart ?? 0)) return 'No data yet';
  return nowSec() < opens ? `Season starts ${fmt(opens, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Before the season';
}

// A quiet grey rectangle with sparse diagonal lines, covering x0..x1 of a plot.
function noDataBlock(svg, parent, id, x0, x1, top, height, { label = true, text = hatchText() } = {}) {
  const w = x1 - x0;
  if (w < 1) return;
  if (!svg.querySelector(`#${CSS.escape(id)}`)) {
    const pattern = sv('pattern', { id, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pattern.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'nodata-line' }));
    svg.append(pattern);
  }
  parent.append(
    sv('rect', { x: x0, y: top, width: w, height, class: 'nodata-fill' }),
    sv('rect', { x: x0, y: top, width: w, height, fill: `url(#${id})` })
  );
  if (label && w >= 70) {
    const t = sv('text', { x: x0 + w / 2, y: top + 16, 'text-anchor': 'middle', class: 'axis-text nodata-text' });
    t.textContent = w >= 150 ? text : text.replace(/^Season starts /, 'Starts ');
    parent.append(t);
  }
}

/* ---------- line chart with crosshair ---------- */

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// Charts sized to their container re-render on resize.
const redraws = new Map();

function lineTarget(opts) {
  let vmax = opts.yMin || 0;
  // (points past the edges, drawn for scrolling into view, don't set the scale)
  const lo = opts.from - opts.step, hi = opts.to + opts.step;
  for (const s of opts.series) for (const p of s.pts) if (p.v > vmax && p.t >= lo && p.t <= hi) vmax = p.v;
  let ystep = niceStep(Math.max(1, Math.max(vmax, 4) / (opts.ticks || 4)));
  let ymax = Math.max(4, Math.ceil(vmax / ystep) * ystep);
  if (opts.yScale) ({ ymax, ystep } = opts.yScale(vmax));
  return { from: opts.from, to: opts.to, ymax, ystep, vals: opts.series.map((s) => s.pts.map((p) => p.v)) };
}

// opts: { key, from, to, step, series: [{ name, cls, color, area, pts: [{t, v, down}] }], fmtValue, fmtTime,
//         ticks?, yMin? (the y-axis reaches at least this), whoAt?(t), onPick?(t) when the plot is clicked,
//         onDraw?(geometry) after every frame }
// With animate, morphs from the previous drawing of the same range (domain, scale and values).
function renderLineChart(root, opts, { animate = false, slide = 0 } = {}) {
  const prev = chartPrev.get(root);
  const old = slide ? root.firstElementChild : null;
  const target = lineTarget(opts);
  chartPrev.set(root, { key: opts.key, opts, frame: target });
  redraws.set(root, () => drawLineChart(root, opts, target));

  const canTween = animate && prev && prev.key === opts.key
    && opts.series[0].pts.length && prev.opts.series[0].pts.length;
  if (!canTween) {
    stopTween(root);
    drawLineChart(root, opts, target);
    slideIn(root, old, slide);
    return;
  }

  const start = {
    ...prev.frame,
    vals: opts.series.map((s, k) => {
      const oldPts = prev.opts.series[k]?.pts || [];
      const oldVals = prev.frame.vals[k] || [];
      const byT = new Map(oldPts.map((p, i) => [p.t, oldVals[i]]));
      const tail = oldVals.length ? oldVals[oldVals.length - 1] : 0; // new points grow out of the last one
      return s.pts.map((p) => (byT.has(p.t) ? byT.get(p.t) : tail));
    }),
  };
  tween(root, (e) => drawLineChart(root, opts, {
    from: lerp(start.from, target.from, e),
    to: lerp(start.to, target.to, e),
    ymax: lerp(start.ymax, target.ymax, e),
    ystep: e < 0.5 ? start.ystep : target.ystep,
    vals: target.vals.map((vs, k) => vs.map((v, i) => lerp(start.vals[k][i], v, e))),
  }));
}

function drawLineChart(root, opts, f) {
  root.replaceChildren();
  const { step, series } = opts;
  const { from, to, ymax, ystep } = f;
  const pts0 = series[0].pts;
  if (!pts0.some((p) => p.t >= from - step && p.t <= to + step)) {
    root.append(el('div', { class: 'empty-chart', text: 'No data in this range yet' }));
    opts.onDraw?.(null);
    return;
  }

  const W = Math.max(280, root.clientWidth);
  const H = root.clientHeight || 240;
  const m = { l: opts.fmtTick ? 40 : 30, r: 10, t: 10, b: 24 };
  root.plotBox = { l: m.l, r: m.r }; // for pinch zoom
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  const x = (t) => m.l + ((t - from) / (to - from)) * pw;
  const y = (v) => m.t + ph - (v / ymax) * ph;

  const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Players online over time' });

  // The y-axis stays put while paging slides the rest (.slide) sideways; see slideIn.
  const yaxis = sv('g', { class: 'yaxis' });
  const body = sv('g', { class: 'slide' });
  const bodyClip = sv('g', { class: 'slide-clip' }); // clipped to the plot while a slide is under way
  bodyClip.append(body);
  svg.append(yaxis, bodyClip);
  svg.dataset.top = m.t;
  svg.dataset.ph = ph;
  svg.dataset.ymax = ymax;
  for (let v = 0; v <= ymax + 1e-9; v += ystep) {
    const tick = sv('g', { class: 'ytick' });
    tick.dataset.v = v;
    if (v > 0) tick.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'gridline' }));
    const t = sv('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = opts.fmtTick ? opts.fmtTick(v) : Number.isInteger(v) ? v : v.toFixed(1);
    tick.append(t);
    yaxis.append(tick);
  }
  yaxis.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'baseline' }));

  // x ticks: local hours for short ranges, local midnights for long ones
  // Which ones get a label depends on the clock, not on where the range starts, so they stay the
  // same ones as the chart is scrolled along. Half a width past each edge is labelled as well
  // (.overscan, hidden until a scroll brings it into view; see pinchZoom).
  const days = (to - from) / 86400;
  const apart = days <= 0.6 ? 3600 : days <= 1.5 ? 3 * 3600 : 86400; // seconds between the hours that can have one
  const maxTicks = Math.max(2, Math.floor(pw / 80));
  const every = Math.max(1, Math.ceil((to - from) / apart / maxTicks));
  const beyond = sv('g', { class: 'overscan', visibility: 'hidden' });
  for (let h = Math.ceil((from - (to - from) / 2) / 3600) * 3600; h < to + (to - from) / 2; h += 3600) {
    const info = hourInfo(h);
    if (!(days <= 0.6 || (days <= 1.5 ? info.hour % 3 === 0 : info.hour === 0))) continue;
    if (Math.round(h / apart) % every) continue;
    const t = sv('text', { x: x(h), y: H - 6, 'text-anchor': 'middle', class: 'axis-text' });
    t.textContent = days <= 1.5 ? hourName(info.hour, false)
      : days <= 8 ? fmt(h, { weekday: 'short' })
      : fmt(h, { month: 'short', day: 'numeric' });
    (h >= from && h < to ? body : beyond).append(t); // the end itself would hang off the edge
  }
  body.append(beyond);

  // lines, broken wherever there is missing data; clipped to the plot while the domain slides
  const clipId = `${root.id}-clip`;
  const clip = sv('clipPath', { id: clipId, class: 'plot-clip' });
  clip.append(sv('rect', { x: m.l, y: 0, width: pw, height: m.t + ph + 1 }));
  body.append(clip);
  const plot = sv('g', { 'clip-path': `url(#${clipId})` });
  body.append(plot);

  // hatched block for the time before tracking started
  if (opts.dataStart && opts.dataStart > from) {
    noDataBlock(svg, plot, `${root.id}-hatch`, m.l, Math.min(m.l + pw, x(opts.dataStart)), m.t, ph);
  }
  // (and past the left edge, for scrolling into view)
  if (opts.dataStart && x(opts.dataStart) > m.l - pw) {
    noDataBlock(svg, plot, `${root.id}-hatch`, m.l - pw, Math.min(m.l, x(opts.dataStart)), m.t, ph, { label: false });
  }

  // the shading between a stacked line and the one under it (the same points), broken at gaps as the lines are
  const bandPath = (pts, upper, lower) => {
    let d = '';
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        d += seg.map((i, j) => `${j ? 'L' : 'M'}${x(pts[i].t)},${y(upper[i])}`).join('');
        d += seg.slice().reverse().map((i) => `L${x(pts[i].t)},${y(lower[i])}`).join('') + 'Z';
      }
      seg = [];
    };
    pts.forEach((p, i) => {
      if (i && p.t - pts[i - 1].t > step * 2.5) flush();
      seg.push(i);
    });
    flush();
    return d;
  };

  series.forEach((s, k) => {
    const vals = f.vals[k];
    let line = '', area = '', segStart = null, prev = null;
    const closeArea = () => {
      if (s.area && segStart !== null) area += `L${x(prev.t)},${y(0)}L${x(segStart.t)},${y(0)}Z`;
    };
    s.pts.forEach((p, i) => {
      const py = y(vals[i]);
      const gap = !prev || p.t - prev.t > step * 2.5;
      if (gap) {
        closeArea();
        line += `M${x(p.t)},${py}`;
        if (s.area) area += `M${x(p.t)},${py}`;
        segStart = p;
      } else {
        line += `L${x(p.t)},${py}`;
        if (s.area) area += `L${x(p.t)},${py}`;
      }
      prev = p;
    });
    closeArea();
    if (s.area) plot.append(sv('path', { d: area, class: `area-${s.areaCls || s.cls}` }));
    if (s.band != null) plot.append(sv('path', { d: bandPath(s.pts, vals, f.vals[s.band]), class: `area-${s.areaCls || s.cls}` }));
    plot.append(sv('path', { d: line, class: `line-${s.cls}` }));
  });

  // crosshair + tooltip
  const cross = sv('line', { y1: m.t, y2: m.t + ph, class: 'crosshair', visibility: 'hidden' });
  const markers = series.map((s) => sv('circle', { r: s.noMarker ? 0 : 4, style: `fill:${s.color}`, class: 'marker', visibility: 'hidden' }));
  body.append(cross, ...markers);
  const hit = sv('rect', { x: m.l, y: 0, width: pw, height: H, fill: 'transparent' });
  body.append(hit);

  const nearest = (t) => {
    let lo = 0, hi = pts0.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts0[mid].t < t) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && t - pts0[lo - 1].t < pts0[lo].t - t) lo--;
    return lo;
  };
  const move = (e) => {
    const rect = svg.getBoundingClientRect();
    const t = from + ((e.clientX - rect.left - m.l) / pw) * (to - from);
    const i = nearest(t);
    const p = pts0[i];
    const px = x(p.t);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    series.forEach((s, k) => {
      markers[k].setAttribute('cx', px);
      markers[k].setAttribute('cy', y(f.vals[k][i]));
      markers[k].setAttribute('visibility', 'visible');
    });
    // a stacked line's own amount (s.raw), not its height on the stack
    const rows = series.filter((s) => !s.pts[i].down || s === series[0]).map((s) => ({
      value: s.pts[i].down ? 'Server offline' : opts.fmtValue(s.raw ? s.raw[i] : s.pts[i].v),
      label: s.pts[i].down ? null : s.name,
      color: series.length > 1 ? s.color : null,
    }));
    rows.push({ label: opts.fmtTime(p.t) });
    const who = opts.whoAt?.(p.t);
    if (who?.length) rows.push({ players: who });
    showTip(e.clientX, e.clientY, rows);
  };
  const leave = () => {
    cross.setAttribute('visibility', 'hidden');
    markers.forEach((mk) => mk.setAttribute('visibility', 'hidden'));
    hideTip();
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
  if (opts.onPick) {
    hit.style.cursor = 'pointer';
    hit.addEventListener('click', (e) => {
      const t = from + ((e.clientX - svg.getBoundingClientRect().left - m.l) / pw) * (to - from);
      hideTip(); // this click goes somewhere; it isn't one to keep the tooltip
      opts.onPick(Math.max(from, Math.min(to, t)));
    });
  }

  root.append(svg);
  opts.onDraw?.({
    from, to, top: m.t, height: ph, x,
    // the line's height at t (nearest point), or null where there's no data
    yAt: (t) => {
      if (t < pts0[0].t - step || t > pts0.at(-1).t + step) return null;
      const i = nearest(t);
      return Math.abs(pts0[i].t - t) > step * 2.5 ? null : y(f.vals[0][i]);
    },
  });
}

/* ---------- bar chart over time buckets ---------- */

function barScale(vals) {
  const vmax = Math.max(0, ...vals);
  const ystep = vmax > 0 ? niceStep(vmax / 4) : 1;
  const ymax = vmax > 0 ? Math.ceil(vmax / ystep) * ystep : 4;
  return { ymax, ystep };
}

// spec: {
//   buckets: [{ key, start, end, date }]   contiguous time slots, one bar each
//   vals, fmtTick, describe(i) -> tooltip rows, labels: 'hour' | 'day',
//   windowKey   tween only between drawings of the same window
//   dataStart   hatch everything before it
//   strip?      { intervals: [[start, end]], describe(t, interval) } — a when-online bar under the plot
//   scale?      { ymax, ystep } — fixed y-axis instead of fitting the values
//   split?      [[[class, share], …]] — each bar's stack from the bottom: a team's class and its share (0 to 1)
// }
// grow: bars rise from zero (first drawing for a newly opened page).
function renderBars(root, spec, { animate = false, slide = 0, grow = false } = {}) {
  const old = slide ? root.firstElementChild : null;
  const scale = (vals) => spec.scale || barScale(vals);
  const target = { vals: spec.vals, ...scale(spec.vals) };
  const prev = chartPrev.get(root);
  chartPrev.set(root, { windowKey: spec.windowKey, byKey: new Map(spec.buckets.map((b, i) => [b.key, spec.vals[i]])) });
  redraws.set(root, () => drawBars(root, spec, target));

  if (grow && reducedMotion()) grow = false;
  const startVals = grow ? spec.buckets.map(() => 0)
    : prev && prev.windowKey === spec.windowKey ? spec.buckets.map((b) => prev.byKey.get(b.key) ?? 0) : null;
  const same = startVals && startVals.every((v, i) => Math.abs(v - spec.vals[i]) < 1e-9);
  if (!(animate || grow) || !startVals || same) {
    stopTween(root);
    drawBars(root, spec, target);
    slideIn(root, old, slide);
    return;
  }
  const start = grow ? target : scale(startVals);
  tween(root, (e) => drawBars(root, spec, {
    vals: spec.vals.map((v, i) => lerp(startVals[i], v, e)),
    ymax: lerp(start.ymax, target.ymax, e),
    ystep: e < 0.5 ? start.ystep : target.ystep,
  }));
}

function drawBars(root, spec, f) {
  root.replaceChildren();
  const { buckets, fmtTick, strip, chatStrip } = spec;
  const n = buckets.length;
  const W = Math.max(280, root.clientWidth);
  const H = root.clientHeight || 200;
  const m = { l: chatStrip ? 46 : 34, r: 4, t: 10, b: strip ? (chatStrip ? 80 : 48) : 24 };
  root.plotBox = { l: m.l, r: m.r }; // for pinch zoom
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const { ymax, ystep } = f;
  const y = (v) => m.t + ph - (v / ymax) * ph;
  const slot = pw / n;
  const from = buckets[0].start, to = buckets[n - 1].end;

  // time <-> x, linear within each slot so bars, hatching and the strip line up exactly
  const xAt = (t) => {
    if (t <= from) return m.l;
    if (t >= to) return m.l + pw;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (buckets[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    const b = buckets[lo];
    return m.l + slot * (lo + (t - b.start) / (b.end - b.start));
  };
  const tAt = (px) => {
    const u = Math.min(n - 1e-9, Math.max(0, (px - m.l) / slot));
    const i = Math.floor(u);
    const b = buckets[i];
    return b.start + (u - i) * (b.end - b.start);
  };

  const root_svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Activity over time' });

  // The y-axis (and the strips' names) stays put while paging slides the rest (.slide) sideways; see slideIn.
  const yaxis = sv('g', { class: 'yaxis' });
  const svg = sv('g', { class: 'slide' });
  const bodyClip = sv('g', { class: 'slide-clip' });
  bodyClip.append(svg);
  root_svg.append(yaxis, bodyClip);
  root_svg.dataset.top = m.t;
  root_svg.dataset.ph = ph;
  root_svg.dataset.ymax = ymax;
  for (let v = 0; v <= ymax + 1e-9; v += ystep) {
    const tick = sv('g', { class: 'ytick' });
    tick.dataset.v = Math.round(v * 1000) / 1000;
    if (v > 0) tick.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'gridline' }));
    const t = sv('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = fmtTick(Math.round(v * 100) / 100);
    tick.append(t);
    yaxis.append(tick);
  }
  yaxis.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'baseline' }));

  const hatchId = `${root.id}-hatch`;
  // a bar stands for its whole bucket, so the hatch stops at the start of the one the data (or season) begins in
  const firstBar = spec.dataStart && (buckets.find((bk) => spec.dataStart < bk.end)?.start ?? spec.dataStart);
  if (spec.dataStart && firstBar > from) noDataBlock(root_svg, svg, hatchId, m.l, xAt(firstBar), m.t, ph);

  const gap = slot >= 8 ? 2 * Math.max(2, slot * 0.15) : slot * 0.3;
  const bw = Math.min(40, slot - gap);
  const hourly = spec.labels === 'hour';
  const labelEvery = hourly
    ? (slot >= 36 ? 1 : slot >= 18 ? 2 : slot >= 12 ? 3 : 6)
    : (slot >= 44 ? 1 : slot >= 22 ? 2 : slot >= 14 ? 3 : slot >= 7 ? 7 : 14);
  const bars = [];

  buckets.forEach((b, i) => {
    const cx = m.l + slot * (i + 0.5);
    const top = Math.max(m.t, y(f.vals[i])), base = y(0);
    const h = base - top;
    if (h > 0.5) {
      // rounded top, square base; with spec.split the bar is stacked: the teams from the bottom in their order, then the rest
      const x0 = cx - bw / 2, x1 = cx + bw / 2;
      const sp = spec.split?.[i];
      const segs = (sp ? [...sp, ['', Math.max(0, 1 - sp.reduce((n, [, share]) => n + share, 0))]] : [['', 1]])
        .filter(([, share]) => share * h > 0.5);
      const bar = sv('g', { class: 'dbar-stack' });
      let from = base;
      segs.forEach(([cls, share], k) => {
        const last = k === segs.length - 1;
        const to = last ? top : from - share * h;
        const r = last ? Math.min(4, from - to, bw / 2) : 0;
        bar.append(sv('path', {
          d: `M${x0},${from}V${to + r}Q${x0},${to} ${x0 + r},${to}H${x1 - r}Q${x1},${to} ${x1},${to + r}V${from}Z`,
          class: `dbar ${cls}`,
        }));
        from = to;
      });
      svg.append(bar);
      bars[i] = bar;
    }

    // Labels are counted back from the newest slot so the latest one is always labelled.
    if ((n - 1 - i) % labelEvery === 0) {
      const t = sv('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'axis-text' });
      if (hourly) {
        t.textContent = hourName(hourInfo(b.start).hour, true);
      } else {
        const day = Number(b.date.slice(8));
        t.textContent = b.date === todayStr() && !archived() ? 'Today'
          : day === 1 || slot >= 44 || i < labelEvery || labelEvery >= 7 ? fmtDay(b.date, { month: 'short', day: 'numeric' })
          : String(day);
      }
      svg.append(t);
    }

    const hit = sv('rect', { x: m.l + slot * i, y: m.t, width: slot, height: ph, fill: 'transparent', class: 'dbar-hit' });
    hit.dataset.i = i;
    svg.append(hit);
  });

  // when-online strip, sharing the bars' time scale
  let stripCross = null, chatCross = null, chatMarks = [];
  if (strip) {
    const sy = m.t + ph + 8, sh = 14;
    svg.append(sv('rect', { x: m.l, y: sy, width: pw, height: sh, rx: 3, class: 'strip-bg' }));
    if (spec.dataStart && spec.dataStart > from) noDataBlock(root_svg, svg, hatchId, m.l, xAt(spec.dataStart), sy, sh, { label: false });
    for (const [a, e] of strip.intervals) {
      const x0 = xAt(Math.max(a, from));
      svg.append(sv('rect', { x: x0, y: sy, width: Math.max(1.5, xAt(Math.min(e, to)) - x0), height: sh, class: 'strip-on' }));
    }
    let bottom = sy + sh;
    stripCross = sv('line', { y1: sy - 3, y2: sy + sh + 3, class: 'crosshair strip-cross', visibility: 'hidden' });
    const stripHit = sv('rect', { x: m.l, y: sy - 4, width: pw, height: sh + 7, fill: 'transparent', class: 'strip-hit' });

    // chat strip: a line per message, a red diamond per death, a yellow star per advancement
    if (chatStrip) {
      const cy = sy + sh + 6, ch = 24, mid = cy + ch / 2;
      bottom = cy + ch;
      for (const [label, y0, cls] of [['Online', sy, 'strip-label-on'], ['Chat', cy, 'strip-label-chat']]) {
        const t = sv('text', { x: m.l - 6, y: y0 + (y0 === sy ? sh : ch) / 2 + 3.5, 'text-anchor': 'end', class: `axis-text strip-label ${cls}` });
        t.textContent = label;
        yaxis.append(t);
      }
      svg.append(sv('rect', { x: m.l, y: cy, width: pw, height: ch, rx: 3, class: 'strip-bg' }));
      if (chatStrip.dataStart && chatStrip.dataStart > from) noDataBlock(root_svg, svg, hatchId, m.l, xAt(chatStrip.dataStart), cy, ch, { label: false });
      const talk = [], marks = [];
      for (const ev of chatStrip.events) {
        const x = xAt(ev[1] / 1000);
        chatMarks.push({ ev, x });
        if (ev[2] === 'death') marks.push(sv('rect', { x: x - 3.5, y: mid - 3.5, width: 7, height: 7, transform: `rotate(45 ${x} ${mid})`, class: 'chat-death' }));
        else if (ev[2] === 'advancement') marks.push(sv('path', { d: starPath(x, mid, 7.5), class: 'chat-adv' }));
        else talk.push(`M${x},${cy + 3}V${cy + ch - 3}`);
      }
      if (talk.length) svg.append(sv('path', { d: talk.join(''), class: 'chat-tick' }));
      svg.append(...marks); // symbols on top of the lines
      chatCross = sv('line', { y1: cy - 3, y2: cy + ch + 3, class: 'crosshair strip-cross', visibility: 'hidden' });
      svg.append(chatCross, sv('rect', { x: m.l, y: cy - 3, width: pw, height: ch + 6, fill: 'transparent', class: 'chat-hit' }));
    }
    if (slot >= 4) {
      for (let i = 0; i <= n; i++) {
        const tx = m.l + slot * i;
        svg.append(sv('line', { x1: tx, x2: tx, y1: bottom + 1, y2: bottom + 5, class: 'strip-tick' }));
      }
    }
    svg.append(stripCross, stripHit);
  }

  // the chat mark nearest the pointer (symbols win when close, since they're bigger targets)
  const chatAt = (px) => {
    let best = null, bestD = 9;
    for (const c of chatMarks) {
      const d = Math.abs(c.x - px) - (c.ev[2] === 'death' || c.ev[2] === 'advancement' ? 3 : 0);
      if (d < bestD) { best = c; bestD = d; }
    }
    return best;
  };

  let hovered = null;
  const clearHover = () => {
    hovered?.classList.remove('hover');
    hovered = null;
    stripCross?.setAttribute('visibility', 'hidden');
    chatCross?.setAttribute('visibility', 'hidden');
  };
  const move = (e) => {
    if (e.target.classList.contains('chat-hit')) {
      clearHover();
      const c = chatAt(e.clientX - root_svg.getBoundingClientRect().left);
      if (!c) return hideTip();
      chatCross.setAttribute('x1', c.x);
      chatCross.setAttribute('x2', c.x);
      chatCross.setAttribute('visibility', 'visible');
      const [, ts, kind, text] = c.ev;
      const what = CHAT_KINDS[kind] || CHAT_KINDS.chat;
      showTip(e.clientX, e.clientY, [
        { value: what.label, color: what.color },
        { label: fmt(ts / 1000, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) },
        { label: text.length > 70 ? `${text.slice(0, 70)}…` : text },
        { label: 'Click to preview' },
      ]);
      return;
    }
    if (e.target.classList.contains('strip-hit')) {
      clearHover();
      const px = e.clientX - root_svg.getBoundingClientRect().left;
      const t = Math.floor(tAt(px) / 60) * 60;
      const iv = strip.intervals.find(([a, b]) => t >= a && t < b) || null;
      stripCross.setAttribute('x1', xAt(t));
      stripCross.setAttribute('x2', xAt(t));
      stripCross.setAttribute('visibility', 'visible');
      showTip(e.clientX, e.clientY, strip.describe(t, iv));
      return;
    }
    const hit = e.target.closest('.dbar-hit');
    if (!hit) {
      clearHover();
      hideTip();
      return;
    }
    const i = Number(hit.dataset.i);
    if (hovered !== bars[i]) {
      clearHover();
      hovered = bars[i] || null;
      hovered?.classList.add('hover');
    }
    showTip(e.clientX, e.clientY, spec.describe(i));
  };
  root_svg.addEventListener('pointermove', move);
  root_svg.addEventListener('pointerdown', move);
  root_svg.addEventListener('pointerleave', () => { clearHover(); hideTip(); });
  if (chatStrip) {
    root_svg.addEventListener('click', (e) => {
      if (!e.target.classList.contains('chat-hit')) return;
      const c = chatAt(e.clientX - root_svg.getBoundingClientRect().left);
      if (!c) return;
      hideTip();
      const box = root_svg.getBoundingClientRect();
      chatStrip.onPick(c.ev, box.left + c.x, Number(chatCross.getAttribute('y2')) + box.top);
    });
  }

  root.append(root_svg);
}

const CHAT_KINDS = {
  chat: { label: 'Chat message', color: 'var(--series-2)' },
  say: { label: '/say', color: 'var(--series-2)' },
  emote: { label: '/me', color: 'var(--series-2)' },
  death: { label: 'Died', color: 'var(--critical)' },
  advancement: { label: 'Advancement', color: 'var(--warning)' },
};

function starPath(cx, cy, r) {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    d += `${i ? 'L' : 'M'}${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`;
  }
  return `${d}Z`;
}

// Every chart drawn again at the size it has now (after Admin → Layout changed how wide its section is).
function redrawCharts() {
  for (const [root, redraw] of redraws) {
    if (!root.isConnected) redraws.delete(root);
    else if (root.offsetParent && !tweens.has(root)) redraw();
  }
}

let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const [root, redraw] of redraws) {
      if (!root.isConnected) redraws.delete(root);
      else if (root.offsetParent && !tweens.has(root)) redraw();
    }
  }, 120);
}).observe(document.body);

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function withAlpha(hex, a) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* ---------- time windows ---------- */

// A chart's window is `count` units ending at `end`, where end = null follows "now" (live).
//   unit 'sec'  — end is a timestamp
//   unit 'hour' — end is an hour boundary (exclusive); one bucket per hour
//   unit 'day'  — end is the last date shown (YYYY-MM-DD); one bucket per local day
// preset is the matching preset key, or 'custom'.

function zonedParts(ts) {
  const p = {};
  const f = formatter({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (const { type, value } of f.formatToParts(ts * 1000)) p[type] = value;
  return p;
}

// Timestamp of a wall-clock time in the dashboard's time zone.
function zonedTs(date, hour = 0, minute = 0) {
  const [y, mo, d] = date.split('-').map(Number);
  const want = Date.UTC(y, mo - 1, d, hour, minute) / 1000;
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(t);
    const got = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) / 1000;
    if (got === want) break;
    t += want - got;
  }
  return t;
}

// 'YYYY-MM-DDTHH:MM' for <input type="datetime-local">, in the dashboard's time zone.
function localInput(ts) {
  const p = zonedParts(ts);
  return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, '0')}:${p.minute}`;
}

const currentHourEnd = () => (Math.floor(nowSec() / 3600) + 1) * 3600;

function resolveWindow(w) {
  if (w.unit === 'all') return { from: state.dataStart ?? 0, to: nowSec(), live: true };
  if (w.unit === 'day') {
    const last = w.end ?? todayStr();
    const buckets = [];
    for (let d = addDays(last, -(w.count - 1)); d <= last; d = addDays(d, 1)) {
      buckets.push({ key: d, date: d, start: zonedTs(d), end: zonedTs(addDays(d, 1)) });
    }
    return { from: buckets[0].start, to: buckets.at(-1).end, live: w.end == null, buckets };
  }
  if (w.unit === 'hour') {
    const to = w.end ?? currentHourEnd();
    const buckets = [];
    for (let i = w.count; i > 0; i--) {
      const start = to - i * 3600;
      buckets.push({ key: start, start, end: start + 3600, date: hourInfo(start).date });
    }
    return { from: buckets[0].start, to, live: w.end == null, buckets };
  }
  const to = w.end ?? nowSec();
  return { from: to - w.count, to, live: w.end == null };
}

function shiftWindow(w, dir) {
  if (w.unit === 'all') return w;
  if (w.byDay) {
    // live 24h -> yesterday -> the day before ...; stepping forward past yesterday returns to live 24h
    const last = w.unit === 'day' ? addDays(w.end, dir) : dir < 0 ? addDays(todayStr(), -1) : null;
    if (last == null || last >= todayStr()) return { unit: 'sec', count: 86400, end: null, preset: w.preset, byDay: true };
    return { unit: 'day', count: 1, end: last, preset: w.preset, byDay: true };
  }
  if (w.unit === 'day') {
    const last = addDays(w.end ?? todayStr(), dir * w.count);
    return { ...w, end: last >= todayStr() ? null : last };
  }
  const size = w.unit === 'hour' ? w.count * 3600 : w.count;
  const end = resolveWindow(w).to + dir * size;
  // the clock moves between clicks, so "within a couple of minutes of now" counts as now
  const liveEnd = w.unit === 'hour' ? currentHourEnd() : nowSec() - 120;
  return { ...w, end: end >= liveEnd ? null : end };
}

const presetWindow = (p) => ({ unit: p.unit, count: p.count, end: null, preset: p.v, ...(p.byDay && { byDay: true }) });
const windowKey = (w) => `${w.unit}:${w.count}:${w.end ?? 'live'}`;
const matchPreset = (presets, unit, count) => presets.find((p) => p.unit === unit && p.count === count)?.v ?? 'custom';

function windowLabel(w, r, presets) {
  const p = presets.find((x) => x.v === w.preset);
  if (r.live && p) return archived() ? finalLabel(p.long) : p.long;
  const md = { month: 'short', day: 'numeric' };
  if (w.unit === 'day') {
    const first = r.buckets[0].date, last = r.buckets.at(-1).date;
    return first === last ? fmtDay(first, md) : `${fmtDay(first, md)} – ${fmtDay(last, md)}`;
  }
  const full = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const start = fmt(r.from, full);
  if (r.live) return `${start} – ${archived() ? 'end' : 'now'}`;
  const sameDay = hourInfo(r.from).date === hourInfo(r.to - 1).date;
  return `${start} – ${fmt(r.to, sameDay ? { hour: 'numeric', minute: '2-digit' } : full)}`;
}

// In a finished season, "Last 7 days" are its final 7 days.
const finalLabel = (s) => (s === 'Today' ? 'Final day' : s.replace(/^Last /, 'Final '));

const TL_PRESETS = [
  { v: '6h', label: '6h', unit: 'sec', count: 6 * 3600, long: 'Last 6 hours' },
  // Live it's the last 24 hours; stepping back pages through whole days (midnight to midnight).
  { v: '24h', label: '24h', unit: 'sec', count: 86400, long: 'Last 24 hours', byDay: true },
  { v: '7d', label: '7d', unit: 'sec', count: 7 * 86400, long: 'Last 7 days' },
  { v: '30d', label: '30d', unit: 'sec', count: 30 * 86400, long: 'Last 30 days' },
  { v: '90d', label: '90d', unit: 'sec', count: 90 * 86400, long: 'Last 90 days' },
];
const dayPreset = (n) => ({ v: `${n}d`, label: `${n}d`, unit: 'day', count: n, long: `Last ${n} days` });
const DAILY_PRESETS = [7, 14, 30, 90].map(dayPreset);
const PLAYER_PRESETS = [
  { v: '6h', label: '6h', unit: 'hour', count: 6, long: 'Last 6 hours' },
  { v: '24h', label: '24h', unit: 'hour', count: 24, long: 'Last 24 hours' },
  ...[7, 14, 30].map(dayPreset),
];

// Custom ranges from the date picker. Each returns a window, or an error message.
function pickSeconds(presets) {
  return (from, to) => {
    if (to - from < 600) return 'Pick a range of at least 10 minutes.';
    const count = to - from;
    return { unit: 'sec', count, end: to >= nowSec() - 90 ? null : to, preset: matchPreset(presets, 'sec', count) };
  };
}

function pickDays(presets) {
  return (fromDate, toDate) => {
    const today = todayStr();
    const last = toDate > today ? today : toDate;
    if (fromDate > last) return 'The start date must be on or before the end date.';
    let count = 0;
    for (let d = fromDate; d <= last; d = addDays(d, 1)) count++;
    if (count > 366) return 'Pick a range of a year or less.';
    return { unit: 'day', count, end: last >= today ? null : last, preset: matchPreset(presets, 'day', count) };
  };
}

// Player chart: up to two days shows hourly bars, longer ranges daily bars.
function pickPlayerRange(from, to) {
  if (to <= from) return 'The end must be after the start.';
  if (to - from <= 48 * 3600) {
    const start = Math.floor(from / 3600) * 3600;
    const end = Math.ceil(to / 3600) * 3600;
    const count = (end - start) / 3600;
    return { unit: 'hour', count, end: end >= currentHourEnd() ? null : end, preset: matchPreset(PLAYER_PRESETS, 'hour', count) };
  }
  return pickDays(PLAYER_PRESETS)(hourInfo(from).date, hourInfo(to - 1).date);
}

/* ---------- range control: [calendar] [presets | Custom] [‹] [›] ---------- */

function icon(paths, size = 16) {
  const s = sv('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  for (const d of paths) s.append(sv('path', { d }));
  return s;
}
const calendarIcon = () => icon(['M2.5 4.5h11v9h-11z', 'M2.5 7.5h11', 'M5.5 2.5v3', 'M10.5 2.5v3']);
const chevronIcon = (dir) => icon([dir < 0 ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5']);

// picker: 'datetime' | 'date'. fromPicker(a, b) turns picked values into a window (or an error string).
function rangeControl(host, { presets, picker, fromPicker, onChange }) {
  let w = null;
  let pop = null;

  const cal = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Choose a date range', title: 'Choose a date range' }, calendarIcon());
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' });
  const presetBtns = presets.map((p) => {
    const b = el('button', { type: 'button', text: p.label });
    b.addEventListener('click', () => set(presetWindow(p), true));
    seg.append(b);
    return [p.v, b];
  });
  const custom = el('button', { type: 'button', text: 'Custom', hidden: '' });
  custom.addEventListener('click', () => toggle());
  seg.append(custom);
  const prev = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Earlier', title: 'Earlier' }, chevronIcon(-1));
  const next = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Later', title: 'Later' }, chevronIcon(1));
  prev.addEventListener('click', () => set(shiftWindow(w, -1), true, -1));
  next.addEventListener('click', () => set(shiftWindow(w, 1), true, 1));
  cal.addEventListener('click', () => toggle());
  host.replaceChildren(cal, seg, prev, next);

  // Re-check button states; time passing can change what's possible.
  function sync() {
    for (const [v, b] of presetBtns) b.setAttribute('aria-pressed', String(w?.preset === v));
    custom.hidden = w?.preset !== 'custom';
    custom.setAttribute('aria-pressed', String(w?.preset === 'custom'));
    if (!w) return;
    next.disabled = w.end == null;
    prev.disabled = state.dataStart != null && resolveWindow(w).from <= state.dataStart;
  }

  // dir: -1 / 1 when stepping with ‹ ›, so charts can scroll that way
  function set(nw, notify, dir = 0) {
    const prev = w;
    w = nw;
    close();
    sync();
    if (notify) onChange(w, dir, prev);
  }

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey);
  }
  function onOutside(e) {
    if (!host.contains(e.target)) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function toggle() {
    if (pop) return close();
    const r = resolveWindow(w);
    const dates = picker === 'date';
    const type = dates ? 'date' : 'datetime-local';
    const now = nowSec();
    const max = dates ? todayStr() : localInput(now);
    const min = state.dataStart ? (dates ? hourInfo(state.dataStart).date : localInput(state.dataStart)) : null;
    const fromIn = el('input', { type, max, min, value: dates ? r.buckets[0].date : localInput(r.from) });
    const toIn = el('input', { type, max, min, value: dates ? r.buckets.at(-1).date : localInput(Math.min(r.to, now)) });
    const error = el('div', { class: 'range-error', role: 'alert', hidden: '' });
    const apply = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Apply' });
    const cancel = el('button', { type: 'button', class: 'btn', text: 'Cancel' });
    cancel.addEventListener('click', close);

    pop = el('form', { class: 'range-pop', 'aria-label': 'Choose a date range' },
      el('label', {}, el('span', { text: 'From' }), fromIn),
      el('label', {}, el('span', { text: 'To' }), toIn),
      error,
      el('div', { class: 'range-actions' }, cancel, apply)
    );
    pop.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!fromIn.value || !toIn.value) {
        error.textContent = 'Pick both a start and an end.';
        error.hidden = false;
        return;
      }
      const parse = (v) => {
        if (dates) return v;
        const [d, t] = v.split('T');
        const [h, mi] = t.split(':').map(Number);
        return zonedTs(d, h, mi);
      };
      const res = fromPicker(parse(fromIn.value), parse(toIn.value));
      if (typeof res === 'string') {
        error.textContent = res;
        error.hidden = false;
        return;
      }
      set(res, true);
    });
    host.append(pop);
    fromIn.focus();
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
  }

  return { get: () => w, set: (nw) => set(nw, false), sync };
}

/* ---------- app state ---------- */

const state = {
  status: null,
  hourly: [], // [hour_ts, samples, up_samples, online_sum, peak]
  hourlyFrom: 0, // state.hourly covers hourlyFrom..now
  snaps: { since: 0, rows: [] }, // cached minute rows [ts, up, online] from `since` to now
  dataStart: null, // first recorded check (unix seconds)
  rangesChosen: false,
};

const HOURLY_DAYS = 92; // longest range anything on the page needs
const LB_PRESETS = [
  { v: '1d', label: '1d', unit: 'day', count: 1, long: 'Today' },
  { v: '24h', label: '24h', unit: 'sec', count: 86400, long: 'Last 24 hours' },
  { v: '7d', label: '7d', unit: 'sec', count: 7 * 86400, long: 'Last 7 days' },
  { v: 'all', label: 'All', unit: 'all', count: 0, long: 'All time' },
];

const dataSpan = () => (state.dataStart ? nowSec() - state.dataStart : 0);

// Default ranges: the smallest preset that shows all the data.
const presetByKey = (presets, v) => presets.find((p) => p.v === v);

function fittingTimelineWindow() {
  return presetWindow(presetByKey(TL_PRESETS, '24h'));
}

function daysCovered(since) {
  if (!since) return 1;
  let n = 0;
  for (let d = hourInfo(since).date, today = todayStr(); d <= today && n < 400; d = addDays(d, 1)) n++;
  return n;
}

function fittingDailyWindow() {
  const n = daysCovered(state.dataStart);
  return presetWindow(DAILY_PRESETS.find((p) => n <= p.count) || DAILY_PRESETS.at(-1));
}

const playerDefaultWindow = () => presetWindow(presetByKey(PLAYER_PRESETS, '24h'));

// Smallest leaderboard range that covers all the data.
// Smallest preset that covers all the data; wider ones get the red "Data starts on" note.
function fittingLeaderboardRange() {
  const span = dataSpan();
  return LB_PRESETS.find((p) => p.unit === 'all' || (p.unit === 'sec' && span <= p.count));
}

const defaultLeaderboardRange = () => presetByKey(LB_PRESETS, archived() ? 'all' : '1d');

function showError(msg) {
  const e = $('#error');
  e.textContent = msg;
  e.hidden = !msg;
}

/* ---------- live status ---------- */

// The server stops while nobody's on; the mod's last word before that is "Server stopped".
function pausedSince() {
  const st = state.status;
  const now = onlineNow();
  if (now.live) return now.stopping ? now.reportAt : null; // the live list knows at once
  const ev = st?.server_event;
  if (ev?.text !== 'Server stopped' || (st.last?.up && st.last.online > 0)) return null;
  return Math.floor(ev.ts / 1000);
}

function renderLive() {
  const st = state.status;
  const live = $('#live');
  const text = $('#live-text');
  const { last } = onlineNow();
  const paused = pausedSince();
  live.title = paused ? `Server stopped ${ago(paused)}` : '';
  if (archived()) {
    live.dataset.state = 'archived';
    text.textContent = `Ended ${fmt(clockStop, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    live.title = `Season ${SEASON} is over. This is how it ended.`;
  } else if (st.season && !st.season.started) {
    live.dataset.state = 'none';
    text.textContent = 'Not started';
  } else if (!last) {
    live.dataset.state = 'none';
    text.textContent = 'Waiting for first check';
  } else if (paused) {
    live.dataset.state = 'paused';
    text.textContent = 'Paused';
  } else if (nowSec() - last.ts > 300) {
    live.dataset.state = 'none';
    text.textContent = `No data since ${ago(last.ts)}`;
  } else if (!last.up) {
    live.dataset.state = 'down';
    text.textContent = 'Server offline';
  } else {
    live.dataset.state = 'up';
    text.textContent = `${last.online} online`;
  }
  // on a phone the status is cut short beside the server's name, so the whole of it is a hover away
  if (!live.title) live.title = text.textContent;

  const zone = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' })
    .formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value || TZ;
  // The footer is drawn again every minute; the season picker beside it is made once and left alone, so it
  // doesn't close under someone who has it open.
  const foot = $('#foot');
  if (!foot.firstChild) {
    foot.append(el('span', { class: 'foot-info', id: 'foot-info' }));
    const picker = seasonPicker();
    if (picker) foot.append(picker);
  }
  $('#foot-info').replaceChildren(
    `Times in ${zone}`
      + (archived() ? ` · Season ${SEASON} archive` : last ? ` · updated ${fmt(last.ts, { hour: 'numeric', minute: '2-digit' })}` : '')
      + (DUMMY ? ' · sample data' : ''),
    ...(site.admin ? [' · ', el('a', { href: '#/admin', text: 'Admin' })] : []),
    // for whoever runs a server and came looking: said plainly, so players know it isn't for them
    ' · ', el('a', { href: '/mod', text: 'Server owners: get the mod' }));
  renderSeasonNote();
}

// Switching seasons: a menu at the far end of the footer, away from its links, so it takes two deliberate
// steps and can't be hit by a stray click. Only there once the server has more than one season.
function seasonPicker() {
  if (CURRENT_SEASON < 2) return null;
  const select = el('select', { class: 'tile-select foot-season-select', id: 'season-pick', 'aria-label': 'Season' });
  for (let n = CURRENT_SEASON; n >= 1; n--) {
    const o = el('option', { value: String(n), text: n === CURRENT_SEASON ? `Season ${n} (current)` : `Season ${n}` });
    o.selected = n === SEASON;
    select.append(o);
  }
  select.addEventListener('change', () => {
    // the same page of the other season, where there is one (Admin belongs to the server, not a season)
    const hash = location.hash.startsWith('#/admin') ? '' : location.hash;
    location.href = seasonHref(Number(select.value)) + hash;
  });
  // coming back with the browser's Back button restores the page as it was left: show the season it is
  window.addEventListener('pageshow', () => { select.value = String(SEASON); });
  return el('label', { class: 'foot-season' }, el('span', { text: 'Season' }), select);
}

const seasonSpan = () => {
  const day = { month: 'short', day: 'numeric', year: 'numeric' };
  return state.dataStart ? `${fmt(state.dataStart, day)} – ${fmt(nowSec(), day)}` : '';
};

// The line at the top: sample data, no data yet this season, or which season's archive this is.
function renderSeasonNote() {
  const note = $('#season-note');
  const st = state.status;
  let kids = null;
  if (DUMMY) {
    kids = [el('strong', { text: 'Sample data.' }), ' This activity is made up, to show how the page looks. The chat log is left empty. ',
      el('a', { href: seasonHref(CURRENT_SEASON), text: 'Show real data' })];
  } else if (st && SEASON === CURRENT_SEASON && !st.data_start) {
    const s = st.season;
    const when = s?.start && !s.started
      ? ` It starts ${fmt(s.start, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : '';
    // a server's first season has no season before it to point to
    kids = SEASON > 1
      ? [el('strong', { text: `No Season ${SEASON} data yet.` }), `${when} `,
        el('a', { href: seasonHref(SEASON - 1), text: `See Season ${SEASON - 1}’s archived stats →` })]
      : [el('strong', { text: 'No data yet.' }), ' Stats show up here once the server’s first upload or status check comes in.'];
  } else if (st && SEASON === CURRENT_SEASON && seasonOpens() && nowSec() < seasonOpens()) {
    kids = [el('strong', { text: `Season ${SEASON} starts ${fmt(seasonOpens(), { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` })];
  } else if (st && SEASON < CURRENT_SEASON && !$('#view-home').hidden) {
    kids = [el('strong', { text: `Season ${SEASON} archive` }),
      archived() ? ` · ${seasonSpan()}. ` : ` · still recording until Season ${SEASON + 1} starts. `,
      el('a', { href: seasonHref(SEASON + 1), text: `Go to Season ${SEASON + 1} →` })];
  }
  note.classList.toggle('dummy', DUMMY);
  note.hidden = !kids;
  if (kids) note.replaceChildren(...kids);
}

function makeChip(p) {
  knownNames.set(p.uuid, p.name);
  const chip = playerLink(el('a', { class: 'chip', title: otherName(p.name) },
    headImg(p.name, 24),
    colorName(el('span', { class: 'chip-name', text: shownName(p.name) }), p.uuid, p.name),
    el('span', { class: 'since', text: `since ${fmt(p.start_ts, { hour: 'numeric', minute: '2-digit' })}` })
  ), p.uuid, p.name);
  chip.addEventListener('focus', () => prefetchPlayer(p.uuid));
  return chip;
}

// The player disintegrates into the page in pixels, then the gap closes.
function removeChip(chip, bg) {
  chip.classList.add('leaving');
  const list = chip.parentNode;
  const muted = [cssVar('--ink-2'), cssVar('--muted'), cssVar('--axis')];
  pixelTiles({
    host: list, target: chip, mode: 'cover', color: cssVar(bg),
    tile: 3, pad: 2, duration: 700, sweep: 0.6,
    spark: { chance: 0.12, colors: muted, vx: [10, 50], vy: [-35, -5], life: [400, 800], size: [1, 2] },
    onDone: () => {
      chip.style.width = `${chip.offsetWidth}px`;
      chip.classList.add('collapsing');
      requestAnimationFrame(() => chip.classList.add('collapsed'));
      setTimeout(() => chip.remove(), 260);
    },
  });
}

// Keeps a row of chips in step with who's online; on live updates players pop in and pixel out.
// bg: the color behind the row, which leaving chips dissolve into.
function syncChips(list, players, bg = '--surface') {
  const animate = live();
  const current = new Map([...list.querySelectorAll('.chip:not(.leaving)')].map((c) => [c.dataset.uuid, c]));
  const wanted = new Set(players.map((p) => p.uuid));

  for (const [uuid, chip] of current) {
    if (wanted.has(uuid)) continue;
    if (animate) removeChip(chip, bg);
    else chip.remove();
  }
  for (const p of players) {
    const existing = current.get(p.uuid);
    if (existing) {
      colorName(existing.querySelector('.chip-name'), p.uuid, p.name).textContent = shownName(p.name);
      if (otherName(p.name)) existing.title = otherName(p.name);
      else existing.removeAttribute('title');
      continue;
    }
    const chip = makeChip(p);
    list.append(chip);
    if (animate) chip.classList.add('chip-enter');
  }
}

function renderOnlineChips() {
  const now = onlineNow();
  syncChips($('#online-list'), archived() ? [] : now.online);
  const warn = $('#sample-warning');
  const last = state.status.last;
  // (with the live list working, the mod is installed and its list is complete)
  if (!archived() && !now.live && last && last.up && last.online > last.listed) {
    warn.replaceChildren(
      `The server reports ${last.online} players but only lists ${last.listed} by name, so some playtime isn't being counted. `,
      'Installing ', el('a', { href: '/mod', text: 'the mcstats mod' }), ' (1.7.0 or newer) on the server gives the full list: the mod reports everyone in the tab list.'
    );
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

/* ---------- home ---------- */

function renderTiles() {
  const st = state.status;
  if (archived()) return renderArchiveTiles();
  const { last, live: isLive } = onlineNow();
  const fresh = last && nowSec() - last.ts <= 300;
  const animate = live();
  setCounter($('#t-online'), fresh ? (last.up ? String(last.online) : 'Offline') : '–', fresh && last.up ? last.online : null, animate);
  $('#t-online-sub').textContent = fresh && last.up && last.max ? `of ${last.max} slots` : fresh ? '' : 'no recent data';

  const today = todayStr();
  const weekAgo = nowSec() - 7 * 86400;
  let peak = 0, weekMinutes = 0;
  for (const [ts, , , sum, pk] of state.hourly) {
    if (hourInfo(ts).date === today) peak = Math.max(peak, pk);
    if (ts >= weekAgo) weekMinutes += sum;
  }
  if (isLive && last.up) peak = Math.max(peak, last.online); // someone just joined: today's peak can't be less
  setCounter($('#t-peak'), String(peak), peak, animate);
  // everyone's time added up: the whole season (from /api/status), or the last 7 days, as the tile's menu says
  const week = playedMode() === '7d' || st.played_minutes == null;
  const minutes = week ? weekMinutes : st.played_minutes;
  $('#t-week-label').textContent = week ? 'Played this week' : 'Total played';
  setCounter($('#t-week'), fmtHours(minutes / 60), minutes, animate);
  setCounter($('#t-players'), st.players_total.toLocaleString(), st.players_total, animate);
}

// The played tile's period: 'all' (the default) or '7d'. A finished season has no menu, only its total.
const playedMode = () => $('#t-week-mode')?.value ?? 'all';
{
  const sel = $('#t-week-mode');
  if (CURRENT_SEASON > 1) sel.options[0].textContent = 'this season'; // each season is counted on its own
  sel.value = recall('playedMode') === '7d' ? '7d' : 'all';
  sel.addEventListener('change', () => {
    remember('playedMode', sel.value);
    if (state.status) renderTiles();
  });
}

// A finished season: how long it ran, its busiest moment and its total.
function renderArchiveTiles() {
  const st = state.status;
  const days = state.dataStart ? daysCovered(state.dataStart) : 0;
  $('#t-online-label').textContent = 'Season length';
  setCounter($('#t-online'), `${days} ${days === 1 ? 'day' : 'days'}`, null, false);
  $('#t-online-sub').textContent = seasonSpan();
  $('#t-peak-label').textContent = 'Peak';
  setCounter($('#t-peak'), String(st.peak_ever), st.peak_ever, false);
  let minutes = 0;
  for (const [, , , sum] of state.hourly) minutes += sum;
  $('#t-week-label').textContent = 'Total played';
  setCounter($('#t-week'), fmtHours(minutes / 60), minutes, false);
  $('#t-week-sub').textContent = 'player-hours, whole season';
  setCounter($('#t-players'), st.players_total.toLocaleString(), st.players_total, false);
}

async function renderServerDaily(animate = false, slide = 0) {
  const w = dailyCtl.get();
  const r = resolveWindow(w);
  dailyCtl.sync();
  $('#daily-label').textContent = `player-hours per day · ${windowLabel(w, r, DAILY_PRESETS)}`;
  const rows = await getHourlyRange(r.from, r.to);
  if (dailyCtl.get() !== w) return; // another range was picked meanwhile
  const index = new Map(r.buckets.map((b, i) => [b.date, i]));
  const vals = r.buckets.map(() => 0);
  const peaks = r.buckets.map(() => 0);
  for (const [ts, , , sum, pk] of rows) {
    const i = index.get(hourInfo(ts).date);
    if (i === undefined) continue;
    vals[i] += sum / 60;
    peaks[i] = Math.max(peaks[i], pk);
  }
  const hours = await teamHoursPerBucket(r.buckets).catch(() => null);
  if (dailyCtl.get() !== w) return;
  const shown = hours ? activityTeams() : [];
  // each team's share of the bar. The bar's height is the server's player count, which can run a little past
  // the time of the players it names (it doesn't always list everyone), so the teams fill it in proportion.
  // A team with no time to speak of that day (what would read as 0.0 hours) isn't in the bar or its tooltip at all.
  const on = (i) => shown.filter((t) => hours[t.id][i] >= 0.05);
  const split = hours && r.buckets.map((b, i) => {
    const whole = on(i).reduce((n, t) => n + hours[t.id][i], 0);
    return on(i).map((t) => [`team-${t.id}`, hours[t.id][i] / whole]);
  });
  const teamRow = (t, i) => ({ value: fmtHours(hours[t.id][i]), label: t.name, color: teamVar(t.id) });
  renderBars($('#heatmap'), {
    buckets: r.buckets, vals, windowKey: windowKey(w), labels: 'day', split,
    fmtTick: (v) => `${v}h`, dataStart: chartStart(),
    describe: (i) => [
      { value: vals[i] ? `${fmtHours(vals[i])} player-hours` : 'No activity' },
      ...(vals[i] && hours ? on(i).map((t) => teamRow(t, i)) : []),
      { label: `${fmtDay(r.buckets[i].date)}${peaks[i] ? ` · peak ${peaks[i]} online` : ''}` },
    ],
  }, { animate, slide });
}

// Hours each team played in every bucket ({ start, end }, in order), from everyone's sessions.
// { team id: [hours] } for the teams the Activity page shows (a team grouped with another counts in
// that one's); null when there are none.
async function teamHoursPerBucket(buckets) {
  if (!roster.size || !buckets.length || !activityTeams().length) return null;
  const from = buckets[0].start, to = buckets[buckets.length - 1].end;
  // (kept between redraws, and as the chart is scrolled along; see timeCache)
  await dailySessions.ensure(from, to);
  const out = Object.fromEntries(activityTeams().map((t) => [t.id, buckets.map(() => 0)]));
  const stop = Math.min(to, nowSec());
  for (const [, name, a0, b0] of dailySessions.rows(from, to)) {
    // (cut where the player changed teams, if that change only counted from then on)
    for (const [id, a, b] of teamSpans(name, Math.max(from, a0), Math.min(stop, b0 + POLL))) {
      const team = out[activityTeam(id)];
      if (!team) continue;
      for (let i = 0; i < buckets.length && buckets[i].start < b; i++) {
        const over = Math.min(b, buckets[i].end) - Math.max(a, buckets[i].start);
        if (over > 0) team[i] += over / 3600;
      }
    }
  }
  return out;
}

// Busiest times for everyone, one team, or the teams blended (their colors mixed by their share).
let heatTeam = recall('heatTeam') || 'all';
let heatToken = 0;
const heatModes = () => {
  const shown = activityTeams();
  return ['all', ...shown.map((t) => t.id), ...(shown.length > 1 ? ['mix'] : [])];
};

function syncHeatToggle() {
  const t = $('#heat-team');
  const shown = activityTeams();
  t.hidden = !roster.size || !shown.length;
  if (!heatModes().includes(heatTeam)) heatTeam = 'all';
  const button = (v, text, title) => el('button', { type: 'button', 'data-v': v, title, text, 'aria-pressed': String(v === heatTeam) });
  t.replaceChildren(button('all', 'All', 'Everyone'), ...shown.map((x) => button(x.id, x.short, `${x.name} only`)),
    ...(shown.length > 1 ? [button('mix', 'Mix', 'The teams, blended by their share')] : []));
}

// Seconds each team spent online in every weekday-hour of [from, to), from everyone's sessions.
async function teamSeconds(from, to) {
  const r = await memoApi(`/api/sessions?from=${from}&to=${to}`);
  const secs = Object.fromEntries(activityTeams().map((t) => [t.id, emptyWeek()]));
  for (const [, name, a0, b0] of r.rows) {
    for (const [id, a, b] of teamSpans(name, Math.max(from, a0), Math.min(to, b0 + r.poll_seconds))) {
      const team = secs[activityTeam(id)];
      if (!team) continue;
      for (let t = a; t < b;) {
        const end = Math.min(b, Math.floor(t / 3600) * 3600 + 3600);
        const { dow, hour } = hourInfo(t);
        team[dow][hour] += end - t;
        t = end;
      }
    }
  }
  return secs;
}
const emptyWeek = () => Array.from({ length: 7 }, () => Array(24).fill(0));
const fmtAvg = (v) => v.toFixed(v < 10 ? 1 : 0);

async function renderServerWeekGrid() {
  const token = ++heatToken;
  syncHeatToggle();
  const mode = roster.size ? heatTeam : 'all';
  const root = $('#weekgrid');
  // Hours are whole so the sessions request stays the same (and cached) until the next hour.
  const now = nowSec();
  const to = mode === 'all' ? Infinity : Math.floor(now / 3600) * 3600;
  let since = archived() ? 0 : now - 90 * 86400;
  if (mode !== 'all') since = Math.floor(Math.max(since, (archived() ? now : to) - 119 * 86400, state.dataStart || 0) / 3600) * 3600;
  const sum = emptyWeek();
  const cnt = emptyWeek();
  for (const [ts, samples, , s] of state.hourly) {
    if (ts < since || ts >= to) continue;
    const { dow, hour } = hourInfo(ts);
    sum[dow][hour] += s;
    cnt[dow][hour] += samples;
  }
  const per = (g) => g.map((row, d) => row.map((v, h) => (cnt[d][h] ? v / cnt[d][h] : 0)));
  const span = archived() ? 'whole season' : 'last 90 days';
  root.className = mode !== 'all' && mode !== 'mix' ? `heat-${mode}` : '';

  if (mode === 'all') {
    renderWeekGrid(root, per(sum), (v, label) => [
      { value: `${fmtAvg(v)} players`, label: 'avg' },
      { label: `${label} · ${span}` },
    ], { animate: live() });
    return;
  }

  const secs = await teamSeconds(since, to);
  if (token !== heatToken) return; // the mode changed or a newer render started meanwhile
  // a player online for a whole hour shows up in every check of it, so seconds / POLL = their samples
  const shown = activityTeams();
  const grids = Object.fromEntries(shown.map((t) => [t.id, per(secs[t.id].map((row) => row.map((v) => v / POLL)))]));
  const tip = (rows, label) => [...rows, { label: `${label} · ${span}` }];
  const teamRow = (t, v) => ({ color: teamVar(t.id), value: `${fmtAvg(v)} ${t.short}`, label: 'avg' });

  if (mode !== 'mix') {
    const t = teamInfo(mode);
    renderWeekGrid(root, grids[mode], (v, label) => tip([teamRow(t, v)], label), { animate: live() });
    return;
  }

  // Blended: the hue is the teams' shares, the strength is how many are on in all (in five steps, like the others).
  const both = grids[shown[0].id].map((row, d) => row.map((_, h) => shown.reduce((n, t) => n + grids[t.id][d][h], 0)));
  const max = Math.max(0, ...both.flat());
  const STRENGTH = [0, 30, 55, 78, 100];
  // the teams' colors mixed by weight, one more team at a time
  const mixColor = (weights, strength) => {
    let color = null, total = 0;
    shown.forEach((t, k) => {
      if (!(weights[k] > 0)) return;
      total += weights[k];
      color = color ? `color-mix(in oklch, ${color} ${Math.round((1 - weights[k] / total) * 100)}%, ${teamVar(t.id)})` : teamVar(t.id);
    });
    return color ? `color-mix(in oklab, ${color} ${strength}%, var(--lv0))` : 'var(--lv0)';
  };
  const legend = el('div', { class: 'scale' });
  if (shown.length === 2) {
    legend.append(el('span', { class: 'lbl', text: shown[0].short }));
    for (const p of [1, 0.75, 0.5, 0.25, 0]) legend.append(el('span', { class: 'sw', style: `background:${mixColor([p, 1 - p], 100)}` }));
    legend.append(el('span', { class: 'lbl', text: shown[1].short }));
  } else {
    for (const t of shown) legend.append(el('span', { class: 'sw', style: `background:${teamVar(t.id)}` }), el('span', { class: 'lbl', text: t.short }));
  }
  renderWeekGrid(root, both, (v, label, d, h) => tip(shown.map((t) => teamRow(t, grids[t.id][d][h])), label), {
    animate: live(),
    legend,
    cellColor: (d, h) => {
      const v = both[d][h];
      if (v <= 0 || max <= 0) return 'var(--lv0)';
      return mixColor(shown.map((t) => grids[t.id][d][h]), STRENGTH[Math.min(4, Math.ceil((v / max) * 4))]);
    },
  });
}

// Centered moving average over `window` seconds, at the same timestamps as pts.
function rollingAverage(pts, window) {
  const half = window / 2;
  const out = [];
  let lo = 0, hi = 0, sum = 0;
  for (const p of pts) {
    while (hi < pts.length && pts[hi].t <= p.t + half) sum += pts[hi++].v;
    while (pts[lo].t < p.t - half) sum -= pts[lo++].v;
    out.push({ t: p.t, v: sum / (hi - lo) });
  }
  return out;
}

// Players online, or the average line, as everyone together or split into Red and Blue stacked.
const TL_MODES = ['all', 'teams', 'share'];
let tlTeams = TL_MODES.includes(recall('tlTeams')) ? recall('tlTeams') : 'all';
function syncTlTeamToggle() {
  const t = $('#tl-team');
  t.hidden = !roster.size || !activityTeams().length;
  for (const b of t.children) b.setAttribute('aria-pressed', String(b.dataset.v === tlTeams));
}
$('#tl-team').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === tlTeams) return;
  tlTeams = b.dataset.v;
  remember('tlTeams', tlTeams);
  syncTlTeamToggle();
  loadTimeline().catch((err) => showError(err.message));
});
rosterLoad.then(() => {
  syncTlTeamToggle();
  if (roster.size && tlTeams !== 'all' && !$('#view-home').hidden) loadTimeline().catch(() => {});
});

// How many of each team were on at each point (minute data), or on average through the hour starting
// at each point (hourly data), from everyone's sessions ([name, start, end]).
function teamCounts(pts, sessions, minuteData) {
  const out = Object.fromEntries(activityTeams().map((t) => [t.id, pts.map(() => 0)]));
  if (!pts.length) return out;
  const firstAt = (t) => {
    let lo = 0, hi = pts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const now = nowSec();
  for (const [name, a0, b0] of sessions) {
    for (const [id, a, b] of teamSpans(name, a0, b0)) { // their team at the time (or the one it's grouped with)
      const team = out[activityTeam(id)];
      if (!team) continue;
      if (minuteData) {
        for (let i = firstAt(a); i < pts.length && pts[i].t < b; i++) team[i] += 1;
      } else {
        for (let i = Math.max(0, firstAt(a - 3600 + 1)); i < pts.length && pts[i].t < b; i++) {
          const t = pts[i].t, end = Math.min(t + 3600, now);
          const over = Math.min(b, end) - Math.max(a, t);
          if (over > 0 && end > t) team[i] += over / (end - t);
        }
      }
    }
  }
  return out;
}

// The teams stacked in their order, the first at the bottom, each shaded down to the line below.
// first: where the first of them will sit among the chart's series.
function teamSeries(pts, counts, word, first) {
  let sum = pts.map(() => 0);
  return activityTeams().map((t, k) => {
    sum = sum.map((v, i) => v + counts[t.id][i]);
    const stacked = pts.map((p, i) => ({ t: p.t, v: sum[i] }));
    return { name: `${t.short} ${word}`, cls: t.id, color: teamVar(t.id), pts: stacked, raw: counts[t.id], ...(k ? { band: first + k - 1 } : { area: true }) };
  });
}

// Each team's share of all of them at each point, as percentages stacked to 100% (no point where
// none is on): a line between each two, shaded in the team's color on its side. The top team comes
// first, so the lines are drawn over the shading.
function shareSeries(pts, counts) {
  const shown = activityTeams();
  const keep = [];
  pts.forEach((p, i) => {
    const whole = shown.reduce((n, t) => n + counts[t.id][i], 0);
    if (whole > 0.01) keep.push({ t: p.t, share: shown.map((t) => (counts[t.id][i] / whole) * 100) });
  });
  const n = shown.length;
  return shown.map((t, k) => {
    const top = k === n - 1;
    return {
      name: t.short, cls: top ? 'none' : 'share', areaCls: t.id, color: teamVar(t.id), noMarker: top,
      pts: keep.map((p) => ({ t: p.t, v: top ? 100 : p.share.slice(0, k + 1).reduce((a, b) => a + b, 0) })),
      raw: keep.map((p) => p.share[k]),
      ...(k ? { band: n - k } : { area: true }), // the series after it in the list is the team below it
    };
  }).reverse();
}

async function loadTimeline(slide = 0) {
  const w = tlCtl.get();
  const r = resolveWindow(w);
  const { from, to } = r;
  tlCtl.sync();
  $('#tl-label').textContent = windowLabel(w, r, TL_PRESETS);
  const c1 = 'var(--series-1)';
  const c2 = 'var(--series-2)';
  const c3 = 'var(--series-3)';
  const legend = $('#tl-legend');
  const key = (color, text) => el('span', {}, el('span', { class: 'key', style: `background:${color}` }), text);
  let opts;

  const minuteData = to - from <= 8 * 86400;
  await Promise.all([minuteData && tlSnaps.ensure(from, to), tlSessions.ensure(from, to)]);
  if (tlCtl.get() !== w) return; // another range was picked meanwhile
  // Whatever is already here past each edge is drawn too, out of sight, so scrolling the chart along
  // shows it at once (pinchZoom); lo..hi is that wider stretch.
  const pad = timelinePad(from, to);
  const local = !minuteData && state.hourly.length > 0 && from >= state.hourlyFrom; // the hours come from the page's own copy
  const got = [tlSessions.span(), minuteData ? tlSnaps.span() : local ? { from: state.hourlyFrom, to: Infinity } : { from, to }];
  const lo = Math.min(from, Math.max(from - pad, ...got.map((c) => c?.from ?? from)));
  const hi = Math.max(to, Math.min(to + pad, ...got.map((c) => c?.to ?? to)));
  const rows = minuteData ? tlSnaps.rows(lo, hi) : await getHourlyRange(local ? lo : from, local ? hi : to);
  if (tlCtl.get() !== w) return;
  const sessions = tlSessions.rows(lo, hi).map(([, name, a, b]) => [name, a, b + POLL]);
  // names online at t (minute data), or at any point in the hour starting at t (hourly data)
  const whoAt = (t) => {
    const end = minuteData ? t + 1 : t + 3600;
    return [...new Set(sessions.filter(([, a, b]) => a < end && b > t).map(([name]) => name))];
  };

  const shownTeams = activityTeams();
  const teams = tlTeams === 'teams' && roster.size > 0 && shownTeams.length > 0;
  const share = tlTeams === 'share' && roster.size > 0 && shownTeams.length > 0;
  const cm = 'var(--muted)';
  const band = (color, text) => el('span', {}, el('span', { class: 'key key-band', style: `background:${color}` }), text);
  if (minuteData) {
    const pts = rows.map(([t, up, v]) => ({ t, v, down: !up }));
    // Trend line (1-hour average) for ranges longer than 6h.
    const trend = to - from > 6 * 3600 + 60;
    const series = [teams
      ? { name: 'online', cls: 'muted', color: cm, pts }
      : { name: 'online', cls: '1', color: c1, area: true, pts }];
    if (teams || share) {
      const counts = teamCounts(pts, sessions, true);
      if (trend) {
        const avg = (vs) => rollingAverage(pts.map((p, i) => ({ t: p.t, v: vs[i] })), 3600).map((p) => p.v);
        for (const id of Object.keys(counts)) counts[id] = avg(counts[id]);
      }
      if (share) series.splice(0, 1, ...shareSeries(pts, counts));
      else series.push(...teamSeries(pts, counts, trend ? 'avg (1 hour)' : 'online', 1));
    } else if (trend) series.push({ name: 'avg (1 hour)', cls: '2', color: c2, pts: rollingAverage(pts, 3600) });
    opts = {
      from, to, step: POLL, series, whoAt,
      fmtValue: (v) => (Number.isInteger(v) ? `${v} ${v === 1 ? 'player' : 'players'}` : v.toFixed(1)),
      fmtTime: (t) => fmt(t, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    };
    const what = trend ? 'average online (1 hour)' : 'online';
    legend.replaceChildren(...(!pts.length ? []
      : share ? shownTeams.map((t, k) => band(teamVar(t.id), `${t.short} share${trend && !k ? ' (1-hour average)' : ''}`))
      : teams ? [key(cm, 'Players online'), ...shownTeams.map((t) => band(teamVar(t.id), `${t.short} ${what}`))]
        : trend ? [key(c1, 'Players online'), key(c2, 'Average online (1 hour)')] : []));
  } else {
    const avgPts = rows.map(([t, n, , s]) => ({ t, v: n ? s / n : 0 }));
    const peak = { name: 'peak', cls: '3', color: c3, pts: rows.map(([t, , , , pk]) => ({ t, v: pk })) };
    opts = {
      from, to, step: 3600,
      series: share ? shareSeries(avgPts, teamCounts(avgPts, sessions, false))
        : teams
        ? [{ name: 'average', cls: 'muted', color: cm, pts: avgPts }, ...teamSeries(avgPts, teamCounts(avgPts, sessions, false), 'average', 1), peak]
        : [{ name: 'average', cls: '1', color: c1, area: true, pts: avgPts }, peak],
      whoAt,
      fmtValue: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
      fmtTime: (t) => `${fmt(t, { weekday: 'short', month: 'short', day: 'numeric' })}, ${hourName(hourInfo(t).hour)}`,
    };
    legend.replaceChildren(...(share
      ? shownTeams.map((t) => band(teamVar(t.id), `${t.short} share`))
      : teams
      ? [key(cm, 'Average online'), ...shownTeams.map((t) => band(teamVar(t.id), `${t.short} average`)), key(c3, 'Peak online')]
      : [key(c1, 'Average online'), key(c3, 'Peak online')]));
  }
  opts.key = `${windowKey(w)}|${share ? 'share' : teams ? 'teams' : 'all'}`;
  opts.dataStart = chartStart();
  if (share) {
    opts.yScale = () => ({ ymax: 100, ystep: 25 });
    opts.fmtTick = (v) => `${v}%`;
    opts.fmtValue = (v) => `${Math.round(v)}%`;
  } else {
    // up to the most online in the range, in steps of 5, never less than 0-10 so the scale stays steady
    opts.yScale = (vmax) => {
      const ymax = Math.max(10, Math.ceil(vmax / 5) * 5);
      return { ymax, ystep: ymax <= 20 ? 5 : niceStep(ymax / 4) };
    };
  }
  renderLineChart($('#timeline'), opts, { animate: live(), slide });
  if ($('#timeline').matches(':hover')) preloadTimeline(); // being read or scrolled: have the next stretch ready
}

const lbRowsBySize = new Map(); // range size -> most rows seen
const ROW_MOVE_MS = 380;

function reserveRows(root, n) {
  const row = root.querySelector('tbody tr');
  const head = root.querySelector('thead');
  const rowH = row ? row.getBoundingClientRect().height : 39;
  const headH = head ? head.getBoundingClientRect().height : 24;
  root.style.minHeight = `${Math.ceil(headH + n * rowH)}px`;
}

function rowTops(root) {
  const tops = new Map();
  for (const tr of root.querySelectorAll('tr[data-uuid]')) {
    const b = tr.querySelector('.bar');
    tops.set(tr.dataset.uuid, { top: tr.getBoundingClientRect().top, bar: b?.style.width });
  }
  return tops;
}

// Rows glide from where they were to their new rank; newcomers fade in; bars stretch to their new length.
function moveRows(root, oldTops) {
  if (reducedMotion() || !oldTops.size) return false;
  const ease = 'cubic-bezier(0.2, 0.8, 0.3, 1)';
  let moved = false;
  root.querySelectorAll('tr[data-uuid]').forEach((tr, i) => {
    const old = oldTops.get(tr.dataset.uuid);
    if (!old) {
      tr.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
        { duration: ROW_MOVE_MS, delay: Math.min(i, 10) * 15, easing: ease, fill: 'backwards' });
      return;
    }
    const dy = old.top - tr.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) {
      moved = true;
      tr.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: ROW_MOVE_MS, easing: ease });
    }
    const bar = tr.querySelector('.bar');
    if (bar && old.bar && old.bar !== bar.style.width) {
      bar.animate([{ width: old.bar }, { width: bar.style.width }], { duration: ROW_MOVE_MS, easing: ease });
    }
  });
  return moved;
}

// The season beside the heading; red when a range other than All reaches back before its data began.
function renderLeaderboardNote() {
  const note = $('#lb-note');
  if (!state.dataStart) {
    note.replaceChildren();
    return;
  }
  const w = lbCtl.get();
  const r = resolveWindow(w);
  const fit = fittingLeaderboardRange();
  // Red when the range is wider than the smallest preset that covers all the data and reaches back before it.
  const warn = w.unit !== 'all' && fit.unit !== 'all' && r.from < state.dataStart && r.to - r.from > fit.count;
  const start = el('span', { class: `data-note${warn ? ' warn' : ''}`, text: `Season ${SEASON}` });
  if (warn) start.title = `This range reaches back before the season’s data began (${fmt(state.dataStart, { month: 'short', day: 'numeric' })}), so totals cover less time than it suggests.`;
  note.replaceChildren(`${windowLabel(w, r, LB_PRESETS)} · `, start);
}

async function loadLeaderboard() {
  const w = lbCtl.get();
  const win = resolveWindow(w);
  lbCtl.sync();
  renderLeaderboardNote();
  const from = w.unit === 'all' ? 1 : win.from;
  const path = `/api/leaderboard?from=${from}&to=${win.to}`;
  const r = win.live ? await api(path) : await memoApi(path);
  const root = $('#leaderboard');
  // Keep the card as tall as the most rows seen for this range size, so paging doesn't make the page jump.
  const sizeKey = `${w.unit}:${w.count}`;
  const rows = Math.min(25, r.players.length);
  const reserve = Math.max(rows, lbRowsBySize.get(sizeKey) || 0);
  lbRowsBySize.set(sizeKey, reserve);
  const oldTops = rowTops(root);
  if (!r.players.length) {
    root.replaceChildren(el('div', { class: 'empty', text: 'Nobody seen in this range yet.' }));
    reserveRows(root, reserve);
    return;
  }
  const top = r.players[0].secs || 1;
  const onNow = new Set(archived() ? [] : onlineNow().online.map((p) => p.uuid));
  const prev = state.lbPrev?.range === windowKey(w) ? state.lbPrev.secs : null;
  state.lbPrev = { range: windowKey(w), secs: new Map(r.players.map((p) => [p.uuid, p.secs])) };
  const changed = [];
  const tbody = el('tbody');
  r.players.slice(0, 25).forEach((p, i) => {
    const link = teamName(el('a', { href: `#/player/${p.uuid}`, text: shownName(p.name) }), p.name);
    const tr = el('tr', { class: 'link', 'data-uuid': p.uuid },
      el('td', { class: 'rank', text: String(i + 1) }),
      el('td', {},
        el('div', { class: 'pname' }, headImg(p.name, 22), link),
        el('div', { class: `bar${rosterOf(p.name) ? ` team-${rosterOf(p.name).team}` : ''}`, style: `width:${Math.max(1, (p.secs / top) * 100)}%` })
      ),
      el('td', { class: 'num', text: dur(p.secs) }),
      el('td', { class: 'num muted hide-sm', text: onNow.has(p.uuid) ? 'online' : ago(p.last_seen) })
    );
    tr.addEventListener('click', (e) => { if (e.target !== link) location.hash = `#/player/${p.uuid}`; });
    tr.addEventListener('pointerenter', () => prefetchPlayer(p.uuid));
    link.addEventListener('focus', () => prefetchPlayer(p.uuid));
    knownNames.set(p.uuid, p.name);
    tbody.append(tr);
    if (prev && prev.get(p.uuid) !== p.secs) changed.push(tr);
  });
  root.replaceChildren(el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}), el('th', { text: 'Player' }), el('th', { class: 'num', text: 'Played' }), el('th', { class: 'num hide-sm', text: 'Last seen' })
    )),
    tbody
  ));
  reserveRows(root, reserve);
  const moved = moveRows(root, oldTops);

  // Updated rows get a blue tint that dissolves away in sparkly pixels (after any reordering settles).
  if (!live()) return;
  const blue = cssVar('--series-1');
  for (const tr of changed) setTimeout(() => tr.isConnected && pixelTiles({
      host: root, target: tr, mode: 'clear', color: withAlpha(blue, 0.07),
      tile: 4, hold: 0, duration: 750, sweep: 0.3,
      spark: { chance: 0.04, colors: FX.blue, vx: [-15, 15], vy: [-45, -10], life: [400, 800], size: [1, 2] },
    }), moved ? ROW_MOVE_MS : 0);
}

async function loadStatus() {
  [state.status] = await Promise.all([api('/api/status'), rosterLoad]);
  const season = state.status.season;
  if (season?.ended && season.end) {
    clockStop = season.end - 1; // its end is the next season's first moment
    document.body.classList.add('archived');
  }
  setTz(state.status.tz);
  POLL = state.status.poll_seconds;
  state.dataStart = state.status.data_start;
  if (!state.rangesChosen) {
    state.rangesChosen = true;
    tlCtl.set(fittingTimelineWindow());
    dailyCtl.set(fittingDailyWindow());
    lbCtl.set(presetWindow(defaultLeaderboardRange()));
  }
  renderLive();
}

// After the first load, only rows from the latest (still-filling) hour onward are re-fetched.
async function loadHourly() {
  // a finished season keeps all of its hours, for its totals
  const since = archived() ? Math.min(state.dataStart ?? nowSec(), nowSec() - HOURLY_DAYS * 86400) : nowSec() - HOURLY_DAYS * 86400;
  state.hourlyFrom = since;
  if (!state.hourly.length) {
    state.hourly = (await api(`/api/hourly?from=${since}`)).rows;
    return;
  }
  const from = state.hourly.at(-1)[0];
  const fresh = (await api(`/api/hourly?from=${from}`)).rows;
  state.hourly = state.hourly.filter((r) => r[0] >= since && r[0] < from).concat(fresh);
}

// Responses for windows in the past don't change, so keep a few around.
const memo = new Map();
async function memoApi(path) {
  if (!memo.has(path)) {
    if (memo.size >= 8) memo.delete(memo.keys().next().value);
    memo.set(path, await api(path));
  }
  return memo.get(path);
}

// Rows over time kept as one unbroken stretch, so moving a chart along (or back to where it was)
// mostly finds its data already here: a request reaching past either end asks only for the missing
// part, and one nowhere near what's kept starts over.
//   load(a, b) -> the rows for a..b    key(row): one fetched twice is kept once, as the newer copy
//   start(row), end(row): its time     tail: seconds before the kept end that are asked for again (rows there can still change)
//   slack: how far behind now the kept end may be    chunk: the longest stretch one request may ask for
//   keep: past this length, only what was asked for and as much again either side stays
function timeCache({ load, key, start, end = start, tail = 180, slack = 30, chunk = 100 * 86400, keep = 400 * 86400 }) {
  let have = null; // { from, to, rows: Map }
  let sorted = [];
  let queue = Promise.resolve();
  const fetchAll = async (a, b) => {
    const parts = [];
    for (let x = a; x < b; x += chunk) parts.push(load(x, Math.min(b, x + chunk)));
    return (await Promise.all(parts)).flat();
  };
  const ensure = async (a, b) => {
    b = Math.min(b, nowSec());
    if (b <= a || (have && a >= have.from && b <= have.to + slack)) return;
    const fresh = !have || a > have.to || b < have.from;
    const parts = fresh ? [[a, b]] : [
      ...(a < have.from ? [[a, have.from]] : []),
      ...(b > have.to + slack ? [[Math.max(a, have.to - tail), b]] : []),
    ];
    const rows = (await Promise.all(parts.map(([x, y]) => fetchAll(x, y)))).flat();
    const map = fresh ? new Map() : have.rows;
    for (const r of rows) map.set(key(r), r);
    have = fresh ? { from: a, to: b, rows: map } : { from: Math.min(a, have.from), to: Math.max(b, have.to), rows: map };
    if (have.to - have.from > keep) {
      const lo = a - (b - a), hi = b + (b - a);
      for (const [k, r] of map) if (end(r) < lo || start(r) > hi) map.delete(k);
      have.from = Math.max(have.from, lo);
      have.to = Math.min(have.to, hi);
    }
    sorted = [...map.values()].sort((p, q) => start(p) - start(q));
  };
  return {
    // one request at a time, so each builds on what the last one left
    ensure: (a, b) => (queue = queue.then(() => ensure(a, b), () => ensure(a, b))),
    span: () => have && { from: have.from, to: have.to },
    rows: (a, b) => sorted.filter((r) => end(r) >= a && start(r) <= b),
  };
}
const snapshotCache = () => timeCache({
  load: (a, b) => api(`/api/snapshots?from=${a}&to=${b}`).then((x) => x.rows),
  key: (r) => r[0], start: (r) => r[0], chunk: 7 * 86400, keep: 24 * 86400, slack: 5,
});
// (a session counts until the check after its last one)
const sessionCache = (opts) => timeCache({
  load: (a, b) => api(`/api/sessions?from=${a}&to=${b}`).then((x) => x.rows),
  key: (r) => `${r[0]}|${r[2]}`, start: (r) => r[2], end: (r) => r[3] + POLL, tail: 300, ...opts,
});
const tlSnaps = snapshotCache(); // the Players online chart's minute rows
const tlSessions = sessionCache({ slack: 5 }); // and who was on
const dailySessions = sessionCache({ slack: 600 }); // Daily activity's (today's bar keeps up in ten-minute steps)

// How far past each edge the Players online chart is drawn, when the data is already here.
const timelinePad = (from, to) => Math.round((to - from) * (to - from > 2 * 86400 && to - from <= 8 * 86400 ? 0.25 : 0.5));
// Fetches what's either side of a chart's range (see pinchZoom).
function preloadAround(r, caches) {
  const pad = timelinePad(r.from, r.to);
  const a = Math.min(r.from, Math.max(state.dataStart ?? 0, r.from - pad));
  for (const c of caches) c.ensure(a, r.to + pad).catch(() => {});
}
const preloadTimeline = () => {
  const r = resolveWindow(tlCtl.get());
  preloadAround(r, r.to - r.from <= 8 * 86400 ? [tlSnaps, tlSessions] : [tlSessions]);
};
const preloadDaily = () => {
  if (roster.size && activityTeams().length) preloadAround(resolveWindow(dailyCtl.get()), [dailySessions]);
};

// Hourly rows in [from, to): from the cache when it covers them, otherwise fetched.
async function getHourlyRange(from, to) {
  if (state.hourly.length && from >= state.hourlyFrom) return state.hourly.filter((r) => r[0] >= from && r[0] < to);
  return (await memoApi(`/api/hourly?from=${from}&to=${to - 1}`)).rows;
}

// Minute rows, fetching only what's newer than the cache unless the range grew.
async function loadSnapshots(from) {
  const s = state.snaps;
  if (!s.rows.length || from < s.since) {
    state.snaps = { since: from, rows: (await api(`/api/snapshots?from=${from}`)).rows };
  } else {
    const fresh = (await api(`/api/snapshots?from=${s.rows.at(-1)[0] + 1}`)).rows;
    s.rows.push(...fresh);
  }
  return state.snaps.rows.filter((r) => r[0] >= from);
}

// Shows one of the views ('home', 'player', 'chat', 'combat', 'admin', 'live') and marks its tab.
function showView(name) {
  for (const v of ['home', 'player', 'chat', 'combat', 'admin', 'live']) $(`#view-${v}`).hidden = v !== name;
  if (name !== 'player') clearPlayerModel();
  if (name !== 'live') liveMod?.hide(); // Liveview stops drawing, and lets go of its connection after a while
  document.body.classList.toggle('chat-mode', name === 'chat');
  document.body.classList.toggle('live-mode', name === 'live'); // Liveview shows in-game names only: no IGN / Name switch
  if (name !== 'chat') closeSearch();
  if (state.status) renderSeasonNote();
  renderLayoutNote(name);
  const tab = name === 'chat' || name === 'combat' || name === 'live' || name === 'admin' ? name : 'activity';
  for (const t of ['activity', 'chat', 'combat', 'live', 'admin']) {
    if (t === tab) $(`#tab-${t}`).setAttribute('aria-current', 'page');
    else $(`#tab-${t}`).removeAttribute('aria-current');
  }
}

async function showHome() {
  showView('home');
  document.title = SITE;
  await loadStatus();
  await loadHourly();
  renderAbout();
  renderCommands();
  renderTiles();
  renderOnlineChips();
  renderServerWeekGrid().catch((e) => showError(e.message));
  await Promise.all([loadTimeline(), renderServerDaily(live()), loadLeaderboard()]);
}

/* ---------- player page ---------- */

const knownNames = new Map(); // uuid -> name, from the leaderboard and chips, for the loading header
const playerCache = new Map(); // uuid -> { at, promise }

// Player data is fetched on hover, so a click usually finds it ready.
function fetchPlayer(uuid, fresh = false) {
  const hit = playerCache.get(uuid);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.promise;
  const promise = api(`/api/player/${encodeURIComponent(uuid)}`);
  playerCache.set(uuid, { at: Date.now(), promise });
  promise.catch(() => playerCache.delete(uuid));
  return promise;
}
const prefetchPlayer = (uuid) => fetchPlayer(uuid).catch(() => {});

function setHead(img, name) {
  if (img.dataset.name === name) return;
  delete img.dataset.fellBack;
  img.dataset.name = name;
  img.dataset.size = 64;
  img.src = head(name, 64);
}

// Placeholders while a different player's data loads, so the last player never shows.
function showPlayerLoading(uuid) {
  const view = $('#view-player');
  view.classList.remove('reveal');
  view.classList.add('is-loading');
  const name = knownNames.get(uuid);
  $('#p-name').textContent = name ? shownName(name) : 'Loading…';
  $('#p-team').hidden = true;
  const ph = $('#p-head');
  if (name) setHead(ph, name);
  else { ph.removeAttribute('src'); delete ph.dataset.name; }
  $('#p-status').textContent = 'Loading…';
  for (const id of ['p-total', 'p-sessions', 'p-longest', 'p-chat']) {
    const n = $(`#${id}`);
    delete n.dataset.text;
    delete n.dataset.value;
    n.textContent = '–';
  }
  for (const id of ['p-total-sub', 'p-avg', 'p-longest-sub', 'p-chat-sub', 'pa-label']) $(`#${id}`).textContent = '';
  const chart = $('#p-heatmap');
  stopTween(chart);
  chartPrev.delete(chart);
  redraws.delete(chart);
  chart.replaceChildren(el('div', { class: 'empty-chart', text: 'Loading…' }));
  const empty = Array.from({ length: 7 }, () => Array(24).fill(0));
  renderWeekGrid($('#p-weekgrid'), empty, () => [{ value: 'Loading…' }]);
  weekPrev.delete($('#p-weekgrid'));
  $('#p-recent').replaceChildren(el('div', { class: 'empty', text: 'Loading…' }));
  $('#p-usual').replaceChildren();
  $('#p-usual-sub').textContent = '';
  $('#p-combat').replaceChildren(el('div', { class: 'empty', text: 'Loading…' }));
  $('#pcb-sub').textContent = '';
  $('#p-addon-card').hidden = true;
  $('#p-adv-card').hidden = true;
  adv.key = null;
  adv.drawn = null;
}

let playerReq = 0;

async function showPlayer(uuid, { refresh = false } = {}) {
  showView('player');
  if (!refresh) window.scrollTo(0, 0);
  const switching = !refresh && state.playerShown !== uuid;
  const req = ++playerReq;
  if (switching) {
    state.playerShown = null;
    state.playerData = null;
    showPlayerLoading(uuid);
  }
  const [r, chatInfo] = await Promise.all([
    fetchPlayer(uuid, refresh),
    // the page still works if chat can't be loaded
    fetchPlayerChat(`uuid=${uuid}`, { events: true, fresh: refresh }).catch(() => null),
    refresh || !state.status ? loadStatus() : null,
  ]);
  if (req !== playerReq) return; // another player was opened meanwhile
  const { player } = r;
  knownNames.set(player.uuid, player.name);
  setHead($('#p-head'), player.name);

  const sessions = r.sessions.map(([s, e]) => [s, e + r.poll_seconds]);
  const lastTs = state.status.last?.ts;
  const isOnline = !archived() && lastTs != null && r.sessions.length && r.sessions.at(-1)[1] === lastTs;

  let total = 0, longest = [0, null];
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const [s, e] of sessions) {
    const len = e - s;
    total += len;
    if (len > longest[0]) longest = [len, s];
    eachHourChunk(s, e, (h, secs) => {
      const info = hourInfo(h);
      grid[info.dow][info.hour] += secs;
    });
  }

  const status = $('#p-status');
  status.replaceChildren();
  if (isOnline) status.append(el('span', { class: 'badge', text: 'Online' }), `since ${fmt(r.sessions.at(-1)[0], { hour: 'numeric', minute: '2-digit' })}`);
  else if (r.sessions.length) status.append(`Last seen ${ago(r.sessions.at(-1)[1])}`);
  else status.append('Not seen this season');
  if (player.first_seen) status.append(` · first seen ${fmt(player.first_seen, { month: 'short', day: 'numeric', year: 'numeric' })}`);

  const weekAgo = nowSec() - 7 * 86400;
  let week = 0;
  for (const [s, e] of sessions) if (e > weekAgo) week += e - Math.max(s, weekAgo);

  const animate = live() && state.playerShown === player.uuid;
  if (state.playerShown !== player.uuid) pCtl.set(playerDefaultWindow());
  state.playerShown = player.uuid;
  state.playerData = { name: player.name, sessions, liveSession: isOnline ? sessions.at(-1) : null, chat: chatInfo, gear: r.gear };
  renderPlayerName();
  renderPlayerModel(player.name, r.gear);
  renderPlayerAddons(player.name, r.gear);
  renderPlayerCombat(player.name).catch((e) => console.error('combat card:', e));
  renderPlayerAdvancements(player.name).catch((e) => console.error('advancements card:', e));
  setCounter($('#p-total'), dur(total), total, animate);
  $('#p-total-sub').textContent = `${dur(week)} in the ${archived() ? 'final' : 'last'} 7 days`;
  setCounter($('#p-sessions'), sessions.length.toLocaleString(), sessions.length, animate);
  $('#p-avg').textContent = sessions.length ? `avg ${dur(total / sessions.length)}` : '';
  setCounter($('#p-longest'), dur(longest[0]), longest[0], animate);
  $('#p-longest-sub').textContent = longest[1] ? fmt(longest[1], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  renderPlayerChatTile(animate);

  // A newly opened player fades in, with the activity bars rising from zero.
  const view = $('#view-player');
  view.classList.remove('is-loading');
  if (switching && !reducedMotion()) {
    view.classList.remove('reveal');
    void view.offsetWidth; // restart the animations
    view.classList.add('reveal');
    clearTimeout(showPlayer.revealTimer);
    showPlayer.revealTimer = setTimeout(() => view.classList.remove('reveal'), 900);
  }

  renderPlayerActivity(animate, 0, switching);
  renderWeekGrid($('#p-weekgrid'), grid, (v, label) => [
    { value: v ? dur(v) : 'Never', label: v ? 'total' : null },
    { label },
  ], { animate });

  const usual = usualActivity(sessions);
  $('#p-usual').replaceChildren(usual.graph);
  $('#p-usual-sub').textContent = usual.sub;

  const recent = sessions.slice(-100).reverse();
  const root = $('#p-recent');
  if (!recent.length) {
    root.replaceChildren(el('div', { class: 'empty', text: 'No sessions yet.' }));
    return;
  }
  const tbody = el('tbody');
  recent.forEach(([s, e], i) => {
    const live = i === 0 && isOnline;
    const timeOpts = { hour: 'numeric', minute: '2-digit' };
    tbody.append(el('tr', {},
      el('td', { text: fmt(s, { weekday: 'short', month: 'short', day: 'numeric' }) }),
      el('td', { class: 'muted' }, `${fmt(s, timeOpts)} – `, live ? el('span', { class: 'badge', text: 'now' }) : fmt(e, timeOpts)),
      el('td', { class: 'num', text: dur(e - s) })
    ));
  });
  root.replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, el('th', { text: 'Date' }), el('th', { text: 'Time' }), el('th', { class: 'num', text: 'Length' }))),
    tbody
  ));
}

// The name as chat shows it, in its colors (or their real name), and their team.
function renderPlayerName() {
  const d = state.playerData;
  if (!d) return;
  $('#p-name').replaceChildren(...nameParts(d.chat?.display, d.name));
  document.title = `${shownName(d.name)} · ${SITE}`;
  const r = rosterOf(d.name);
  const team = $('#p-team');
  team.hidden = !r;
  if (r) {
    team.replaceChildren(el('span', { class: `team-dot team-${r.team}` }),
      el('span', { class: `team-${r.team}`, text: teamLabel(r.team) }),
      el('span', { class: 'muted', text: `· ${nameMode === 'real' ? r.ign : r.name}` }),
      ...addons('playerTags', d.name, d.gear).flat());
  }
}

/* ---------- a player's advancements, as the game's advancements screen ---------- */

// The tree comes from the server mod with the game's own layout: x is the column, y the row.
// Drawn at twice the game's size: a 26-pixel frame every 28 pixels across and 27 down, joined by
// the game's elbow lines, on the tab's background. Hidden advancements only show once earned.
const ADV = { scale: 2, dx: 28, dy: 27, box: 26, pad: 9 };
const adv = { key: null, tab: recall('advTab') || null, data: null };
const advTexture = (path) => `${BASE}/api/mc/textures/${path}.png`;
let mcIcons = null;
function setItemIcon(img, icon) {
  mcIcons ??= import('/mcicons.js');
  mcIcons.then((m) => m.itemIcon(icon.model || icon.id).then((url) => url || (icon.model ? m.itemIcon(icon.id) : null)))
    .then((url) => { if (url) img.src = url; else img.remove(); })
    .catch(() => img.remove());
}

async function renderPlayerAdvancements(name) {
  const card = $('#p-adv-card');
  const mine = (state.playerAdvReq = (state.playerAdvReq || 0) + 1);
  const data = await api(`/api/advancements?name=${encodeURIComponent(name)}`).catch(() => null);
  if (mine !== state.playerAdvReq || state.playerData?.name !== name) return;
  if (!data?.tree?.length) { card.hidden = true; adv.key = null; return; }
  const key = JSON.stringify([name, data.ts, data.tree.length, data.done, data.part]);
  $('#adv-sub').textContent = advSummary(data);
  if (key === adv.key) return; // nothing new: leave the tab and the scroll position alone
  adv.key = key;
  adv.data = data;
  card.hidden = false;
  drawAdvancements();
}

// Which advancements show: all of them, except hidden ones nobody has earned (or earned past) yet.
function advShown(data) {
  const kids = new Map();
  for (const a of data.tree) if (a.parent) kids.set(a.parent, [...(kids.get(a.parent) || []), a]);
  const earnedBelow = (a) => a.id in data.done || (kids.get(a.id) || []).some(earnedBelow);
  return data.tree.filter((a) => !a.hidden || earnedBelow(a));
}
function advSummary(data) {
  const shown = advShown(data);
  const got = shown.filter((a) => a.id in data.done).length;
  return `${got} of ${shown.length} · ${data.ts ? `updated ${ago(data.ts)}` : 'not reported yet'}`;
}

function drawAdvancements() {
  hideTip(); // the advancement it was for is about to be redrawn
  const data = adv.data;
  const shown = advShown(data);
  const byId = new Map(shown.map((a) => [a.id, a]));
  const rootOf = (a) => { let r = a; for (let i = 0; i < 64 && r.parent && byId.has(r.parent); i++) r = byId.get(r.parent); return r; };
  const tabs = new Map(); // root id -> its advancements
  for (const a of shown) {
    const r = rootOf(a);
    if (r.parent) continue; // its root isn't in the tree: nowhere to draw it
    if (!tabs.has(r.id)) tabs.set(r.id, []);
    tabs.get(r.id).push(a);
  }
  // the game's own tabs first, in the game's order; then any a data pack adds
  const ORDER = ['story/root', 'nether/root', 'end/root', 'adventure/root', 'husbandry/root'];
  const rank = (id) => (ORDER.indexOf(id) + 1 || ORDER.length + 1);
  const ordered = [...tabs].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  if (!tabs.has(adv.tab)) adv.tab = ordered[0]?.[0];
  const fresh = adv.drawn !== `${state.playerData?.name}/${adv.tab}`; // a tab not on screen yet starts on its root
  adv.drawn = `${state.playerData?.name}/${adv.tab}`;

  $('#adv-tabs').replaceChildren(...ordered.map(([id, list]) => {
    const root = byId.get(id);
    const icon = el('img', { class: 'adv-tab-icon', alt: '', width: 16, height: 16 });
    setItemIcon(icon, root.icon);
    const b = el('button', { type: 'button', role: 'tab', 'aria-selected': String(id === adv.tab), title: root.desc || null },
      icon, el('span', { text: root.title }),
      el('span', { class: 'adv-tab-n', text: `${list.filter((a) => a.id in data.done).length}/${list.length}` }));
    b.addEventListener('click', () => {
      if (adv.tab === id) return;
      adv.tab = id;
      remember('advTab', id);
      drawAdvancements();
    });
    return b;
  }));

  const list = tabs.get(adv.tab) || [];
  const root = byId.get(adv.tab);
  const { scale: S, dx, dy, box, pad } = ADV;
  const minX = Math.min(...list.map((a) => a.x)), minY = Math.min(...list.map((a) => a.y));
  const at = (a) => [Math.floor((a.x - minX) * dx) + pad, Math.floor((a.y - minY) * dy) + pad]; // in game pixels
  const w = Math.max(...list.map((a) => at(a)[0])) + box + pad, h = Math.max(...list.map((a) => at(a)[1])) + box + pad;

  const tree = $('#adv-tree');
  tree.style.width = `${w * S}px`;
  tree.style.height = `${h * S}px`;
  const view = $('#adv-view');
  view.style.backgroundImage = root?.bg ? `url("${advTexture(root.bg)}")` : '';

  // the lines: from the parent's middle to just past its frame, up or down, then to the child's middle
  const lines = sv('svg', { class: 'adv-lines', width: w * S, height: h * S, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' });
  const paths = { line: [], got: [] };
  for (const a of list) {
    const p = a.parent && byId.get(a.parent);
    if (!p) continue;
    const [px, py] = at(p), [cx, cy] = at(a);
    const mid = px + box + 4.5;
    paths.line.push(`M${px + 13} ${py + 13.5}H${mid}V${cy + 13.5}H${cx + 13}`);
  }
  lines.append(sv('path', { class: 'adv-line-edge', d: paths.line.join('') }), sv('path', { class: 'adv-line', d: paths.line.join('') }));

  const frames = { task: 'task', goal: 'goal', challenge: 'challenge' };
  const nodes = list.map((a) => {
    const [x, y] = at(a);
    const done = a.id in data.done;
    const part = data.part[a.id];
    const node = el('button', {
      type: 'button', class: `adv-node${done ? ' done' : ''}`, style: `left:${x * S}px;top:${y * S}px`,
      'aria-label': `${a.title}: ${a.desc}. ${done ? 'Earned' : part ? `${part.n} of ${part.of}` : 'Not earned'}`,
    },
      el('img', { class: 'adv-frame', alt: '', src: advTexture(`gui/sprites/advancements/${frames[a.frame] || 'task'}_frame_${done ? 'obtained' : 'unobtained'}`) }));
    const icon = el('img', { class: 'adv-icon', alt: '' });
    setItemIcon(icon, a.icon);
    node.append(icon);
    const tipNode = () => {
      const when = done && data.done[a.id]
        ? `Earned ${fmt(data.done[a.id], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : done ? 'Earned' : part && part.of > 1 ? `In progress: ${part.n}/${part.of}` : 'Not earned yet';
      return el('div', { class: `adv-tip${done ? ' done' : ''} adv-${a.frame}` },
        el('div', { class: 'adv-tip-title', text: a.title }),
        el('div', { class: 'adv-tip-body' },
          el('div', { class: 'adv-tip-desc', text: a.desc }),
          el('div', { class: 'adv-tip-when', text: `${a.frame === 'task' ? '' : `${a.frame === 'goal' ? 'Goal' : 'Challenge'} · `}${when}` })));
    };
    const show = (e) => showTip(e.clientX, e.clientY, [{ node: tipNode(), adv: true }]);
    node.addEventListener('pointerenter', show);
    node.addEventListener('pointermove', show);
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => {
      const r = node.getBoundingClientRect();
      showTip(r.right - 14, r.top + 6, [{ node: tipNode(), adv: true }]);
    });
    node.addEventListener('blur', hideTip);
    return node;
  });
  tree.replaceChildren(lines, ...nodes);
  // like the game, a tab opens with its root in view: at the left, halfway down
  if (fresh && root) view.scrollTo(0, Math.max(0, (at(root)[1] + box / 2) * S - view.clientHeight / 2));
}

// Dragging the tree with a mouse moves it around, like in the game (touch already scrolls it).
{
  const view = $('#adv-view');
  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button) return;
    drag = { x: e.clientX, y: e.clientY, left: view.scrollLeft, top: view.scrollTop, moved: false };
  });
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.moved = true;
    view.classList.add('dragging');
    hideTip();
    view.scrollLeft = drag.left - dx;
    view.scrollTop = drag.top - dy;
  });
  addEventListener('pointerup', () => {
    drag = null;
    view.classList.remove('dragging');
  });
}

// What a server's add-ons put beside Combat on a player's page (the Egg SMP add-on: their egg).
function renderPlayerAddons(name, gear) {
  const parts = addons('playerCard', name, gear);
  $('#p-addon-card').hidden = !parts.length;
  $('#p-addon-body').replaceChildren(...parts);
}

// The player in 3D, wearing their armor, with their best weapon (public/player3d.js). An add-on may put
// something in the off hand, with particles around them.
let playerModel = null; // { key, abort, handle }
function clearPlayerModel() {
  if (!playerModel) return;
  playerModel.abort.abort();
  playerModel.handle?.dispose();
  playerModel = null;
  $('#p-model').replaceChildren();
}
// The weapon or tool picked from the list under the model, for this player (kept across refreshes
// while they still carry it; another player's page starts from their best one again).
let modelPick = null; // { name, key }
// Without a pick here, what the player chose in game (/mcstats view → Your Profile, mod 2.2.0), else their best.
function modelWeapon(name, gear) {
  const pick = modelPick?.name === name && carriedWeapons(gear).find((w) => w.key === modelPick.key);
  return pick ? pick.item : gear?.display?.mainhand || bestWeapon(gear);
}

// The particle effects a player can pick in game (src/gear.js PARTICLES), as the model's aura
// (public/player3d.js): [r, g, b] for the dust around them, [r2, g2, b2] for the ring's other half, and
// the particle that bursts out of it.
const PARTICLE_AURAS = {
  flame: [1, 0.55, 0.1, 1, 0.85, 0.3, 'flame'],
  heart: [1, 0.3, 0.4, 1, 0.65, 0.75, 'heart'],
  end_rod: [0.95, 0.95, 1, 0.8, 0.85, 1, 'end_rod'],
  enchant: [0.6, 0.45, 1, 0.85, 0.8, 1, 'enchant'],
  portal: [0.6, 0.2, 0.9, 0.85, 0.5, 1, 'portal'],
  firework: [1, 0.85, 0.4, 0.6, 0.85, 1, 'firework'],
  happy_villager: [0.35, 0.9, 0.35, 0.7, 1, 0.5, 'happy_villager'],
  snowflake: [0.85, 0.95, 1, 0.6, 0.8, 1, 'snowflake'],
  crit: [0.9, 0.9, 0.85, 0.75, 0.7, 0.55, 'crit'],
  electric_spark: [1, 0.95, 0.5, 0.6, 0.9, 1, 'electric_spark'],
  sculk_soul: [0.1, 0.55, 0.6, 0.4, 0.9, 0.95, 'sculk_soul'],
  crimson_spore: [0.8, 0.15, 0.25, 0.95, 0.45, 0.5, 'crimson_spore'],
  small_gust: [0.85, 0.9, 0.95, 0.65, 0.75, 0.9, 'small_gust'],
  nautilus: [0.2, 0.55, 0.9, 0.45, 0.85, 0.95, 'nautilus'],
  smoke: [0.35, 0.35, 0.35, 0.6, 0.6, 0.6, 'smoke'],
  ash: [0.3, 0.3, 0.3, 0.55, 0.5, 0.45, 'ash'],
  composter: [0.45, 0.75, 0.2, 0.7, 0.6, 0.3, 'composter'],
};
function renderPlayerModel(name, gear) {
  const card = $('#p-model-card');
  const extra = Object.assign({}, ...addons('modelSpec', name, gear));
  const spec = {
    name,
    uuid: gear?.uuid ? gear.uuid.replace(/-/g, '') : null,
    armor: gear?.armor || {},
    // what they chose in game (/mcstats, mod 2.2.0) comes before an add-on's
    offhand: gear?.display?.offhand ?? extra.offhand ?? null,
    aura: PARTICLE_AURAS[gear?.display?.particle] ?? extra.aura ?? null, // particles around them: [r, g, b, r2, g2, b2, accent particle] (player3d.js)
    // a particle effect they picked plays whatever they hold; an add-on's only while the off hand holds something
    auraAlways: !!PARTICLE_AURAS[gear?.display?.particle],
  };
  // the held item changes in place (setMainhand), so it isn't part of what rebuilds the model
  const key = JSON.stringify(spec);
  const mainhand = modelWeapon(name, gear);
  renderModelNote(name, gear, mainhand);
  if (playerModel?.key === key) {
    const changed = !playerModel.mainhand !== !mainhand || (mainhand && gearKey(mainhand) !== gearKey(playerModel.mainhand));
    playerModel.mainhand = mainhand;
    if (changed) playerModel.handle?.setMainhand(mainhand);
    return; // the same look: leave it turning
  }
  clearPlayerModel();
  card.hidden = false;
  const abort = new AbortController();
  const mine = { key, abort, handle: null, mainhand };
  playerModel = mine;
  const box = $('#p-model');
  box.classList.add('loading');
  import('/player3d.js')
    .then((m) => m.mountPlayer(box, { ...spec, mainhand, signal: abort.signal }))
    .then((handle) => {
      if (playerModel !== mine) return handle.dispose();
      mine.handle = handle;
      // picked from the list while it was loading
      if (mine.mainhand !== mainhand) handle.setMainhand(mine.mainhand);
    })
    .catch((err) => {
      console.error('3D model:', err);
      if (playerModel === mine) card.hidden = true; // no WebGL, or the library couldn't load
    })
    .finally(() => box.classList.remove('loading'));
}

// Under the model: the weapon in their hand as the game styles it (hover for its tooltip), with a
// list of everything else they carry next to it; any add-on's line below; when it was reported.
function renderModelNote(name, gear, mainhand) {
  const note = $('#p-model-note');
  closeGearMenu();
  const rows = [];
  const all = carriedWeapons(gear);
  if (mainhand) {
    const look = gearItemLook(mainhand, gear?.styles);
    const label = itemTip(el('span', { class: 'msg-item p-weapon' }, ...mcRuns(look.name)), look.tip, look.note);
    const line = el('div', { class: 'p-model-held' }, label);
    if (all.length > 1) {
      const toggle = el('button', { type: 'button', class: 'p-gear-toggle', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        title: `All ${all.length} weapons and tools they carry`, 'aria-label': `All ${all.length} weapons and tools they carry` },
      el('span', { class: 'p-gear-count', text: all.length }), icon(['M4 6l4 4 4-4'], 12));
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (gearMenu.hidden) openGearMenu(toggle, name, gear, mainhand, all);
        else closeGearMenu();
      });
      line.append(toggle);
    }
    rows.push(line);
  }
  rows.push(...addons('modelLines', name, gear).flat());
  const when = gear?.ts ? `Gear updated ${ago(gear.ts)}` : 'No gear reported yet';
  note.replaceChildren(...rows, el('div', { class: 'muted p-model-when', text: when }));
}

// The list of everything they carry: each in its game colors (hover for its tooltip); picking one
// puts it in the model's hand.
const gearMenu = el('div', { class: 'gear-menu', role: 'menu', hidden: '' });
document.body.append(gearMenu);
function closeGearMenu() {
  if (gearMenu.hidden) return;
  gearMenu.hidden = true;
  document.querySelector('.p-gear-toggle[aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
  hideTip();
}
function openGearMenu(toggle, name, gear, current, all) {
  const currentKey = gearKey(current);
  gearMenu.replaceChildren(el('div', { class: 'gear-menu-head', text: 'Weapons and tools they carry' }), ...all.map((w, i) => {
    const look = gearItemLook(w.item, gear?.styles);
    const picked = w.key === currentKey;
    const row = el('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(picked), class: `gear-row${picked ? ' picked' : ''}` },
      el('span', { class: 'gear-check' }, picked ? icon(['M3.5 8.5l3 3 6-7'], 12) : null),
      el('span', { class: 'gear-name msg-item' }, ...mcRuns(look.name)),
      el('span', { class: 'gear-sub muted', text: [w.item.name ? itemKind(w.item) : '', w.count > 1 ? `×${w.count}` : '', i === 0 ? 'best' : ''].filter(Boolean).join(' · ') }));
    // its tooltip beside the list, as in the chat log
    const show = () => {
      const r = row.getBoundingClientRect();
      showTip(r.right + 4, r.top + 12, [{ node: itemTipNode(look.tip, look.note) }]);
    };
    row.addEventListener('pointerenter', show);
    row.addEventListener('focus', () => { if (row.matches(':focus-visible')) show(); else hideTip(); });
    row.addEventListener('pointerleave', hideTip);
    row.addEventListener('click', () => {
      modelPick = { name, key: w.key };
      closeGearMenu();
      renderPlayerModel(name, gear);
      $('#p-model-note .p-gear-toggle')?.focus({ preventScroll: true });
    });
    return row;
  }));
  gearMenu.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  const r = toggle.getBoundingClientRect();
  const { width, height } = gearMenu.getBoundingClientRect();
  gearMenu.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - width / 2, innerWidth - width - 8))}px`;
  gearMenu.style.top = `${r.bottom + 6 + height > innerHeight - 8 ? Math.max(8, r.top - height - 6) : r.bottom + 6}px`;
  (gearMenu.querySelector('.gear-row.picked') || gearMenu.querySelector('.gear-row'))?.focus({ preventScroll: true });
}
document.addEventListener('pointerdown', (e) => {
  if (!gearMenu.hidden && !gearMenu.contains(e.target) && !e.target.closest('.p-gear-toggle')) closeGearMenu();
});
gearMenu.addEventListener('keydown', (e) => {
  const rows = [...gearMenu.querySelectorAll('.gear-row')];
  const i = rows.indexOf(document.activeElement);
  if (e.key === 'Escape') { closeGearMenu(); $('#p-model-note .p-gear-toggle')?.focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
  }
});
window.addEventListener('scroll', (e) => { if (!gearMenu.hidden && !gearMenu.contains(e.target)) closeGearMenu(); }, { passive: true, capture: true });
window.addEventListener('resize', closeGearMenu);

// Chat messages sent, all time or today (the choice is remembered). A finished season shows its total.
const chatDataStartLabel = (ms) => {
  const t = Math.floor(ms / 1000);
  return `${fmt(t, { month: 'numeric', day: 'numeric' })} ${fmt(t, { hour: 'numeric' }).replace(/\s/g, '').toLowerCase()}`;
};
function renderPlayerChatTile(animate = false) {
  const c = state.playerData?.chat;
  const mode = archived() ? 'total' : $('#p-chat-mode').value;
  $('#p-chat-mode').hidden = archived();
  const node = $('#p-chat');
  if (!c) {
    node.textContent = '–';
    $('#p-chat-sub').textContent = 'Chat log unavailable';
    return;
  }
  const n = mode === 'today' ? c.today : c.total;
  setCounter(node, n.toLocaleString(), n, animate);
  $('#p-chat-sub').textContent = c.data_start ? `data starts ${chatDataStartLabel(c.data_start)}` : 'no chat logged yet';
}
$('#p-chat-mode').value = recall('playerChatMode') === 'today' ? 'today' : 'total';
$('#p-chat-mode').addEventListener('change', (e) => {
  remember('playerChatMode', e.target.value);
  renderPlayerChatTile(true);
});

// Bars of time played per hour or day, with the when-online strip underneath.
function renderPlayerActivity(animate = false, slide = 0, grow = false) {
  const d = state.playerData;
  if (!d) return;
  const w = pCtl.get();
  const r = resolveWindow(w);
  pCtl.sync();
  $('#pa-label').textContent = windowLabel(w, r, PLAYER_PRESETS);

  const hourly = w.unit === 'hour';
  const inWindow = d.sessions.filter(([a, e]) => e > r.from && a < r.to);
  const secs = r.buckets.map((b) => {
    let total = 0;
    for (const [a, e] of inWindow) {
      const overlap = Math.min(e, b.end) - Math.max(a, b.start);
      if (overlap > 0) total += overlap;
    }
    return total;
  });
  const hm = { hour: 'numeric', minute: '2-digit' };

  renderBars($('#p-heatmap'), {
    buckets: r.buckets,
    vals: secs.map((x) => (hourly ? x / 60 : x / 3600)),
    windowKey: windowKey(w),
    labels: hourly ? 'hour' : 'day',
    fmtTick: (v) => (hourly ? `${v}m` : `${v}h`),
    scale: hourly ? { ymax: 60, ystep: 15 } : null, // minutes per hour: always the full hour, for fair comparison
    dataStart: chartStart(),
    describe: (i) => {
      const b = r.buckets[i];
      const when = hourly
        ? `${fmt(b.start, { weekday: 'short', month: 'short', day: 'numeric' })}, ${hourName(hourInfo(b.start).hour)}–${hourName(hourInfo(b.end).hour)}`
        : fmtDay(b.date);
      return [{ value: secs[i] ? dur(secs[i]) : 'Offline' }, { label: when }];
    },
    strip: {
      intervals: inWindow,
      describe: (t, iv) => {
        const when = fmt(t, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        if (state.dataStart && t < state.dataStart) return [{ value: 'No data' }, { label: when }];
        if (!iv) return [{ value: 'Offline' }, { label: when }];
        const end = iv === d.liveSession ? 'now' : fmt(iv[1], hm);
        return [
          { value: 'Online', color: 'var(--series-1)' },
          { label: when },
          { label: `Session ${fmt(iv[0], hm)} – ${end} · ${dur(iv[1] - iv[0])}` },
        ];
      },
    },
    chatStrip: d.chat && {
      events: d.chat.events.filter(([, ts]) => ts >= r.from * 1000 && ts < r.to * 1000),
      dataStart: d.chat.data_start ? d.chat.data_start / 1000 : null,
      onPick: (ev, x, y) => openChatPeek(ev, x, y),
    },
  }, { animate, slide, grow });
}

/* ---------- chat log ---------- */

const CHAT_PAGE = 100; // messages per request
const CHAT_KEEP = 1200; // most messages kept on the page; past this the far end is dropped (and reloads on demand)
const CHAT_GROUP_MS = 5 * 60_000; // one player's lines within this of each other share a name header
const CHAT_POLL_MS = 10_000;

const chat = {
  messages: [], // in time order: { id, ts (ms), kind, uuid, name, text }
  lines: [], // one per message, in order: { el, ts, id } — for finding what's on screen
  moreBefore: false,
  moreAfter: false, // the newest messages aren't loaded (after jumping back in time)
  maxId: 0, // newest message id seen, for live updates
  loading: null, // 'older' | 'newer' | 'jump' while a request is out
  loaded: false,
  pinned: null, // a time picked on the graph; it stays the chat's time until the reader scrolls
  quietUntil: 0, // scroll events before this come from the page moving things, not the reader
  followUntil: 0, // until then the log is on its way to the bottom after sending (performance.now())
  bottomGap: 0, // distance from the bottom, kept when the log's height changes
  unread: 0, // player messages newer than the last one seen at the bottom of the log, per the server
  seenId: (() => { try { const v = Number(localStorage.getItem('chatSeen')); return v > 0 ? v : null; } catch { return null; } })(),
  newFrom: null, // messages after this id get a "New" divider (unread when the page was opened)
  t: null, // the time the chat is scrolled to (seconds)
  win: null, // the graph's window: the live 24h, or one whole day
  sessions: [],
  geom: null, // the graph's geometry from its last drawing
  graphReq: 0,
  onlineKey: '',
  pendingJump: null, // { id, ts } to open the chat at, from a player's page
  whispers: [], // yours, in time order: { id, ts (ms), sender, target, text, via } (src/whisper.js)
};
const chatScroll = $('#chat-scroll');

const clock = (t) => fmt(t, { hour: 'numeric', minute: '2-digit' });

function relativeDay(date, opts) {
  if (archived()) return fmtDay(date, opts);
  const today = todayStr();
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  return fmtDay(date, opts);
}
const cursorLabel = (t) => `${relativeDay(hourInfo(t).date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${clock(t)}`;

// Links in chat become clickable (http/https only).
const URL_RE = /\bhttps?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'}]/gi;
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer nofollow', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Names as chat shows them, in the game's colors: exact on the light page (pale ones get a shadow),
// lightened where needed on the dark page (the CSS picks). Red and blue are the teams' own colors.
const nameColors = new Map(); // uuid -> color of the name itself, for chips and lists elsewhere
const mcCache = new Map();

function luminance([r, g, b]) {
  const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

function mcStyle(hex) {
  let v = mcCache.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    let dark = rgb;
    // dark page: lighten away from near-black
    for (let k = 0; k <= 1 && contrast(luminance(dark), 0.01) < 4; k += 0.05) dark = rgb.map((c) => c + (255 - c) * k);
    // light page: the exact color; ones too pale to read on white (white, yellow, aqua) get
    // Minecraft's own text shadow, the same color at a quarter brightness
    const shadow = contrast(luminance(rgb), 0.96) < 2 ? `1px 1px 0 ${toHex(rgb.map((c) => c / 4))}` : 'none';
    // the game's red and blue are the two teams: those take the team's color, as the leaderboards
    // do, on either page (the game's own red and blue look off beside them)
    const team = { '#ff5555': 'red', '#5555ff': 'blue' }[hex.toLowerCase()];
    v = team ? `--cl:var(--team-${team});--cs:none;--cd:var(--team-${team})` : `--cl:${hex};--cs:${shadow};--cd:${toHex(dark)}`;
    mcCache.set(hex, v);
  }
  return v;
}

function colorName(node, uuid, ign) {
  if (ign && rosterOf(ign)) { // on a team: the team's color, as everywhere else
    node.classList.remove('mc');
    node.removeAttribute('style');
    node.classList.add('team', `team-${rosterOf(ign).team}`);
    return node;
  }
  const c = nameColors.get(uuid);
  if (c) { node.classList.add('mc'); node.setAttribute('style', mcStyle(c)); }
  return node;
}

const displayText = (m) => (m.display ? m.display.map((p) => p.t).join('') : m.name || 'Server');

// Admins send chat from the dashboard without a player name; a yellow tag stands in for it.
const adminTag = () => el('span', { class: 'msg-name msg-admin', text: 'Admin', title: 'Sent by an admin from this dashboard' });

function chatName(m) {
  if (m.via === 'admin') return adminTag();
  const parts = m.display
    ? swapParts(m.display, m.name).map((p) => (p.c ? el('span', { class: 'mc', style: mcStyle(p.c), text: p.t }) : p.t))
    : [m.name ? shownName(m.name) : 'Server'];
  // without the game's own styling of the name (one still being sent, or logged without it): the team's color, as everywhere else
  if (m.uuid && !m.pending) knownNames.set(m.uuid, m.name);
  if (!m.display && m.name && rosterOf(m.name)) return teamName(m.uuid ? playerLink(el('a', { class: 'msg-name' }, ...parts), m.uuid, m.name) : el('span', { class: 'msg-name' }, ...parts), m.name);
  if (!m.uuid) return el('span', { class: 'msg-name' }, ...parts);
  const own = m.display?.find((p) => p.c && p.t.includes(m.name));
  if (own) nameColors.set(m.uuid, own.c);
  return playerLink(el('a', { class: 'msg-name' }, ...parts), m.uuid, m.name);
}

// A link to a player that opens their card (plain click) or their page (new tab, etc.).
// Without a uuid (a name only seen in a message), the card looks the name up.
function playerLink(a, uuid, name) {
  a.href = uuid ? `#/player/${uuid}` : '#';
  a.dataset.card = '';
  if (uuid) {
    a.dataset.uuid = uuid;
    a.addEventListener('pointerenter', () => prefetchPlayer(uuid));
  } else a.dataset.name = name;
  return a;
}

const uuidForName = (name) => {
  const lower = name.toLowerCase();
  for (const [uuid, n] of knownNames) if (n && n.toLowerCase() === lower) return uuid;
  return null;
};

// A whole message as the game styles it (deaths, advancements): every player named in it is a
// link in their own colors, and item or advancement names keep theirs.
function richText(m) {
  const out = [];
  const pieces = m.rich;
  const colored = (p, t = p.t) => (p.c ? el('span', { class: 'mc', style: mcStyle(p.c), text: t }) : t);
  // The weapon's name: marked by the server mod (w); in older messages, the [bracketed] part of a death.
  let itemFrom = -1, itemTo = -1;
  if (!pieces.some((p) => p.w) && (m.kind === 'death' || m.kind === 'advancement')) { // (or the advancement's name)
    itemFrom = pieces.findIndex((p) => !p.p && p.t.trimStart().startsWith('['));
    if (itemFrom >= 0) {
      itemTo = pieces.findIndex((p, k) => k >= itemFrom && p.t.trimEnd().endsWith(']'));
      if (itemTo < 0 || pieces.slice(itemFrom, itemTo + 1).some((p) => p.p)) itemFrom = itemTo = -1;
    }
  }
  const isItem = (k) => pieces[k].w || (k >= itemFrom && k <= itemTo);
  for (let i = 0; i < pieces.length;) {
    const who = pieces[i].p;
    if (who) {
      const run = [];
      while (i < pieces.length && pieces[i].p === who) run.push(pieces[i++]);
      const uuid = who === m.name ? m.uuid : uuidForName(who);
      const shown = (t) => (shownName(who) === who ? noTag(t) : noTag(t).replace(who, shownName(who)));
      out.push(playerLink(el('a', { class: 'msg-name' }, ...run.map((p) => colored(p, shown(p.t)))), uuid, who));
    } else if (isItem(i)) {
      const run = [];
      while (i < pieces.length && !pieces[i].p && isItem(i)) run.push(pieces[i++]);
      out.push(m.kind === 'advancement' ? advSpan(run, m) : itemSpan(run));
    } else out.push(colored(pieces[i++]));
  }
  return out;
}

// An advancement named in a message. Hovering (or focusing, or tapping) shows it as the advancements
// box on a player's page does: its name, what it's for, and when this player earned it (the message's
// time). The tree, the same for everyone, is fetched the first time one is pointed at.
let advTree = null;
function advSpan(run, m) {
  const node = el('span', { class: 'msg-item has-tip', tabindex: '0' }, ...mcRuns(run));
  const title = run.map((p) => p.t).join('').trim().replace(/^\[|\]$/g, '');
  const frame = /challenge/.test(m.text) ? 'challenge' : /goal/.test(m.text) ? 'goal' : 'task';
  let over = false;
  const show = async (x, y) => {
    over = true;
    advTree ??= api(`/api/advancements?name=${encodeURIComponent(m.name || '')}`).then((d) => d.tree || []).catch(() => { advTree = null; return []; });
    const tree = await advTree;
    if (!over) return;
    const a = tree.find((n) => n.title === title && n.frame === frame) || tree.find((n) => n.title === title) || { title, desc: '', frame };
    const when = `Earned ${fmt(m.ts / 1000, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    showTip(x, y, [{ adv: true, node: el('div', { class: `adv-tip done adv-${a.frame}` },
      el('div', { class: 'adv-tip-title', text: a.title }),
      el('div', { class: 'adv-tip-body' },
        a.desc ? el('div', { class: 'adv-tip-desc', text: a.desc }) : null,
        el('div', { class: 'adv-tip-when', text: `${a.frame === 'task' ? '' : `${a.frame === 'goal' ? 'Goal' : 'Challenge'} · `}${when}` }))) }]);
  };
  const hide = () => { over = false; hideTip(); };
  node.addEventListener('pointerenter', (e) => show(e.clientX, e.clientY));
  node.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
  node.addEventListener('pointerleave', hide);
  node.addEventListener('focus', () => { const r = node.getBoundingClientRect(); show(r.left + 8, r.bottom); });
  node.addEventListener('blur', hide);
  return node;
}

// An item named in a message, a little bolder like the players' names. Hovering (or tapping) shows
// its tooltip as in game, when the server mod sent one.
function itemSpan(run) {
  const node = el('span', { class: 'msg-item' }, ...mcRuns(run));
  const lines = run.find((p) => p.i)?.i;
  if (lines) itemTip(node, lines);
  return node;
}
const mcRuns = (run) => run.map((p) => (p.c ? el('span', { class: 'mc', style: mcStyle(p.c), text: p.t }) : p.t));
// An item's tooltip as the game draws it (lines of { t, c?, i? } pieces), with an optional note under it.
const itemTipNode = (lines, note) => el('div', { class: 'item-tip' },
  ...lines.map((line, k) => el('div', { class: `it-line${k ? '' : ' it-name'}` },
    ...(line.length ? line.map((p) => el('span', { style: `${p.c ? `color:${p.c};` : ''}${p.i ? 'font-style:italic' : ''}`, text: p.t })) : ['\u00a0']))),
  note ? el('div', { class: 'it-note', text: note }) : null);
// Hovering (or focusing, or tapping) the node shows it.
function itemTip(node, lines, note) {
  node.classList.add('has-tip');
  node.tabIndex = 0;
  const tipNode = () => itemTipNode(lines, note);
  const show = (e) => showTip(e.clientX, e.clientY, [{ node: tipNode() }]);
  node.addEventListener('pointerenter', show);
  node.addEventListener('pointermove', show);
  node.addEventListener('pointerleave', hideTip);
  node.addEventListener('focus', () => {
    const r = node.getBoundingClientRect();
    showTip(r.left, r.top, [{ node: tipNode() }]);
  });
  node.addEventListener('blur', hideTip);
  return node;
}

const chatAvatar = (m, size) => (m.name && (m.uuid || m.kind !== 'say')
  ? headImg(m.name, size, { width: size, height: size, class: 'chat-head' })
  : el('span', { class: 'logo chat-logo', style: `width:${size}px;height:${size}px` }));

const SYS_ICONS = {
  join: ['M7 4.5 10.5 8 7 11.5', 'M2.5 8h8', 'M9.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3'],
  leave: ['M10.5 4.5 14 8l-3.5 3.5', 'M6 8h8', 'M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3'],
  death: ['M3 7.2a5 5 0 0 1 10 0v2.3l-1.5 1v2.5h-7v-2.5L3 9.5z', 'M6.2 7.8h.01', 'M9.8 7.8h.01', 'M7 13v-1.5M9 13v-1.5'],
  advancement: ['M8 2.2l1.75 3.6 3.95.55-2.87 2.78.69 3.92L8 11.2l-3.52 1.85.69-3.92L2.3 6.35l3.95-.55z'],
  server: ['M8 2.2v5.3', 'M4.6 4.4a5 5 0 1 0 6.8 0'],
  system: ['M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z', 'M8 7.4v3.6', 'M8 5.1h.01'],
};

// Joins, leaves, deaths, advancements, /me and server messages: one line each.
function sysRow(m) {
  const lead = m.kind === 'emote' ? chatAvatar(m, 16) : icon(SYS_ICONS[m.kind] || SYS_ICONS.system, 14);
  const body = el('div', { class: 'sys-text' });
  if (m.kind === 'emote') body.append(chatName(m), ' ', el('i', {}, ...linkify(m.text)));
  // Join and leave lines are all yellow in game, which would tint the name; those use the name's own colors.
  else if (m.rich && m.kind !== 'join' && m.kind !== 'leave') body.append(...richText(m));
  else if (m.name && m.text.startsWith(displayText(m))) body.append(chatName(m), m.text.slice(displayText(m).length));
  else if (m.name && m.text.startsWith(m.name)) body.append(chatName({ ...m, display: null }), m.text.slice(m.name.length));
  else body.append(noTag(m.text));
  if (m.kind === 'death' && m.attr_note && m.killer) body.append(byNote(m.killer));
  return el('div', { class: `msg-sys sys-${m.kind}` },
    el('span', { class: 'msg-lead' }, lead), body, el('time', { class: 'msg-time', text: clock(m.ts / 1000) }));
}

// "(by name)" after a death an admin attributed, when they chose to show it
const byNote = (name) => el('em', { class: 'by-note', text: ` (by ${name})` });

// A run of messages from one player: head and name once, then their lines.
function msgGroup(m) {
  const head = chatAvatar(m, 24);
  const lead = m.uuid
    ? playerLink(el('a', { class: 'msg-lead', tabindex: '-1', 'aria-hidden': 'true' }, head), m.uuid, m.name)
    : el('span', { class: 'msg-lead' }, head);
  return el('div', { class: 'msg-group' }, lead, el('div', { class: 'msg-body' },
    el('div', { class: 'msg-meta' },
      chatName(m),
      m.kind === 'say' ? el('span', { class: 'msg-tag', text: '/say' }) : null,
      m.via === 'web' ? el('span', { class: 'msg-tag', text: 'web', title: 'Sent from this dashboard' })
        : m.via === 'discord' ? el('span', { class: 'msg-tag', text: 'discord', title: 'Sent from Discord' }) : null,
      el('time', { class: 'msg-time', text: clock(m.ts / 1000) }))));
}

const chatLine = (m) => el('div', { class: 'msg-line' },
  el('time', { class: 'msg-gutter', 'aria-hidden': 'true', text: clock(m.ts / 1000).replace(/\s?[AP]M$/, '') }),
  ...linkify(m.text));

// Your whispers that fall within the stretch of the log that's loaded.
function shownWhispers() {
  if (!chat.loaded || !chat.whispers.length) return [];
  const first = chat.messages[0], last = chat.messages.at(-1);
  return chat.whispers.filter((w) => (!chat.moreBefore || !first || w.ts >= first.ts) && (!chat.moreAfter || !last || w.ts <= last.ts));
}

const isMe = (sender) => {
  const me = compose.me;
  return !!me && (sender === '@admin' ? !!me.admin : !!me.ign && sender.toLowerCase() === me.ign.toLowerCase());
};

// A name in a whisper: an admin's yellow tag, or the player in their team's color (opens their card).
const whisperName = (n) => (n === '@admin' ? adminTag() : playerLink(teamName(el('a', { class: 'msg-name', text: shownName(n) }), n), null, n));

// As the game shows them: "You whisper to Name: text" and "Name whispers to you: text".
function whisperRow(w) {
  const mine = isMe(w.sender);
  const other = mine ? w.target : w.sender;
  const body = el('div', { class: 'sys-text' },
    ...(mine ? ['You whisper to ', whisperName(w.target)] : [whisperName(w.sender), ' whispers to you']), ': ', ...linkify(w.text));
  return el('div', { class: 'msg-sys sys-whisper', title: `Only you and ${other === '@admin' ? 'the admin' : shownName(other)} can see this` },
    el('span', { class: 'msg-lead' }, icon(WHISPER_ICON, 14)), body,
    el('time', { class: 'msg-time', text: clock(w.ts / 1000) }));
}
const WHISPER_ICON = ['M4.5 7V5.5a3.5 3.5 0 0 1 7 0V7', 'M3.5 7h9v6.5h-9z'];

// A date floating at the top of a scrolling log while what's at its top is from another day than
// today: the day of the last day line ([data-day]) that has scrolled up past the top.
function dayBadge(scroller) {
  const label = el('span', { class: 'day-badge' });
  const wrap = el('div', { class: 'day-badge-wrap', 'aria-hidden': 'true', hidden: '' }, label);
  scroller.prepend(wrap);
  let queued = false;
  const update = () => {
    queued = false;
    if (!scroller.isConnected || !scroller.offsetParent) return;
    const top = scroller.getBoundingClientRect().top + 6;
    let day = null;
    for (const sep of scroller.querySelectorAll('[data-day]')) {
      if (sep.getBoundingClientRect().bottom > top) break;
      day = sep.dataset.day;
    }
    wrap.hidden = !day || day === todayStr();
    if (!wrap.hidden) label.textContent = relativeDay(day, { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const soon = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  scroller.addEventListener('scroll', soon, { passive: true });
  return { update: soon };
}
const chatDayBadge = dayBadge(chatScroll);

function renderChat(fresh = new Set(), freshWhispers = new Set()) {
  const frag = document.createDocumentFragment();
  chat.lines = [];
  let prev = null, group = null, day = null;
  const dayBreak = (ts) => {
    const d = hourInfo(ts / 1000).date;
    if (d === day) return;
    frag.append(el('div', { class: 'chat-day', role: 'separator', 'data-day': d },
      el('span', { text: relativeDay(d, { weekday: 'long', month: 'long', day: 'numeric' }) })));
    day = d;
    group = null;
  };
  const whispers = shownWhispers();
  let wi = 0;
  const putWhispers = (until) => {
    while (wi < whispers.length && whispers[wi].ts <= until) {
      const w = whispers[wi++];
      dayBreak(w.ts);
      const row = whisperRow(w);
      if (freshWhispers.has(w.id)) row.classList.add('msg-new');
      frag.append(row);
      group = null;
    }
  };
  settlePending();
  for (const m of [...chat.messages, ...pendingMessages()]) {
    putWhispers(m.ts);
    dayBreak(m.ts);
    // what was unread when the page opened starts under a "New" line
    if (chat.newFrom != null && prev && prev.id <= chat.newFrom && m.id > chat.newFrom) {
      frag.append(el('div', { class: 'chat-new', role: 'separator' }, el('span', { text: 'New' })));
      group = null;
    }
    let node;
    if (m.kind === 'chat' || m.kind === 'say') {
      const opens = !group || prev.kind !== m.kind || prev.name !== m.name || prev.via !== m.via || m.ts - prev.ts > CHAT_GROUP_MS;
      if (opens) {
        group = msgGroup(m);
        frag.append(group);
      }
      node = chatLine(m);
      group.lastChild.append(node);
      if (m.pending) {
        // what you just sent, in its place in the log: grey and slanted until the server says it's shown in game
        const p = m.pending;
        if (!p.sent) {
          node.classList.add('msg-sending');
          node.append(el('span', { class: 'msg-status', text: 'sending…' }));
        }
        if (p.fresh) (opens ? group : node).classList.add('msg-new');
        p.fresh = false;
        prev = m;
        continue;
      }
    } else {
      group = null;
      node = sysRow(m);
      frag.append(node);
    }
    if (fresh.has(m.id)) node.classList.add('msg-new');
    node.dataset.chatId = m.id;
    if (m.kind === 'death') node.dataset.death = '1';
    chat.lines.push({ el: node, ts: m.ts, id: m.id });
    prev = m;
  }
  putWhispers(Infinity);
  $('#chat-list').replaceChildren(frag);
  renderChatEdge();
  chatDayBadge.update();
}

function renderChatEdge() {
  const top = $('#chat-top');
  if (!chat.loaded) top.replaceChildren(el('div', { class: 'chat-note loading', text: 'Loading chat…' }));
  else if (!chat.messages.length && !shownWhispers().length) {
    top.replaceChildren(el('div', { class: 'chat-empty' },
      el('strong', { text: 'No chat yet' }),
      el('div', { text: 'Messages show up here once the mcstats-chat mod is running on the server.' })));
  } else if (chat.loading === 'older') top.replaceChildren(el('div', { class: 'chat-note loading', text: 'Loading older messages…' }));
  else if (!chat.moreBefore) top.replaceChildren(el('div', { class: 'chat-note', text: 'This is the start of the chat log.' }));
  else top.replaceChildren();
}

const fromBottom = () => chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight;

// Scrolls made by the page itself don't count as the reader scrolling.
function setScroll(top) {
  chat.quietUntil = performance.now() + 250;
  chatScroll.scrollTop = top;
}

// The last message at least partly on screen: the time the chat is scrolled to.
function lastVisibleLine() {
  const lines = chat.lines;
  if (!lines.length) return null;
  const bottom = chatScroll.scrollTop + chatScroll.clientHeight - 6;
  let lo = 0, hi = lines.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].el.offsetTop < bottom) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return lines[found];
}

// Keeps the bottom line where it is while messages are added or removed around it.
function chatAnchor() {
  const line = lastVisibleLine();
  return line && { id: line.id, off: line.el.offsetTop - chatScroll.scrollTop };
}
function restoreAnchor(a) {
  const line = a && chat.lines.find((l) => l.id === a.id);
  if (line) setScroll(line.el.offsetTop - a.off);
}

async function loadChatLatest() {
  const res = await api(`/api/chat?limit=${CHAT_PAGE}`);
  Object.assign(chat, {
    messages: res.messages, moreBefore: res.more_before, moreAfter: false,
    maxId: res.max_id, loaded: true, pinned: null,
  });
  renderChat();
  setScroll(chatScroll.scrollHeight);
  chat.bottomGap = 0;
}

async function loadOlder() {
  if (chat.loading || !chat.moreBefore || !chat.messages.length) return;
  chat.loading = 'older';
  renderChatEdge();
  try {
    const first = chat.messages[0];
    const res = await api(`/api/chat?before=${first.ts}:${first.id}&limit=${CHAT_PAGE}`);
    const anchor = chatAnchor();
    chat.messages = res.messages.concat(chat.messages);
    chat.moreBefore = res.more_before;
    if (chat.messages.length > CHAT_KEEP) {
      chat.messages.length = CHAT_KEEP;
      chat.moreAfter = true;
    }
    chat.loading = null;
    renderChat();
    restoreAnchor(anchor);
  } finally {
    chat.loading = null;
    renderChatEdge();
  }
  fillChat();
}

async function loadNewer() {
  if (chat.loading || !chat.moreAfter || !chat.messages.length) return;
  chat.loading = 'newer';
  try {
    const last = chat.messages.at(-1);
    const res = await api(`/api/chat?after=${last.ts}:${last.id}&limit=${CHAT_PAGE}`);
    const anchor = chatAnchor();
    chat.messages = chat.messages.concat(res.messages);
    chat.moreAfter = res.more_after;
    chat.maxId = Math.max(chat.maxId, res.max_id);
    if (chat.messages.length > CHAT_KEEP) {
      chat.messages.splice(0, chat.messages.length - CHAT_KEEP);
      chat.moreBefore = true;
    }
    renderChat();
    restoreAnchor(anchor);
  } finally {
    chat.loading = null;
  }
  updateChatJump();
}

// Loads more while the log doesn't fill its box (or the reader is near an end).
function fillChat() {
  if (chatScroll.scrollTop < 600) loadOlder().catch((e) => showError(e.message));
  if (fromBottom() < 600) loadNewer().catch((e) => showError(e.message));
}

// The graph jumps the chat: messages up to that moment end at the bottom of the log.
// With an id (a search result, a message picked on a player's page), that message is the one shown.
async function jumpChatTo(t, id = null) {
  if (chat.loading === 'jump') return;
  // let a load that's already out finish first, so it doesn't land on top of the jump
  for (let i = 0; chat.loading && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
  if (chat.loading) return;
  chat.loading = 'jump';
  let line = null;
  try {
    const res = await api(`/api/chat?at=${Math.round(t * 1000)}&limit=${CHAT_PAGE}`);
    Object.assign(chat, {
      messages: res.messages, moreBefore: res.more_before, moreAfter: res.more_after,
      maxId: Math.max(chat.maxId, res.max_id), loaded: true,
    });
    renderChat();
    line = (id != null && chat.lines.find((l) => l.id === id)) || chat.lines.findLast((l) => l.ts <= t * 1000) || null;
    // a picked message sits mid-log, clear of the jump button; a picked time ends the log
    const below = id != null ? chatScroll.clientHeight / 2 - line?.el.offsetHeight / 2 : 10;
    setScroll(line ? line.el.offsetTop + line.el.offsetHeight - chatScroll.clientHeight + below : 0);
    chat.bottomGap = fromBottom();
    chat.pinned = t;
  } finally {
    chat.loading = null;
    renderChatEdge();
  }
  if (line && !reducedMotion()) {
    line.el.animate([{ background: withAlpha(cssVar('--series-2'), 0.22) }, { background: 'transparent' }], { duration: 1400, easing: 'ease-out' });
  }
  updateChatJump();
  syncChatTime();
  fillChat();
}

// New messages since the last look. They're added at the bottom when the newest are loaded,
// and followed if the reader is already at the bottom.

// Everything up to the newest message counts as seen once the reader is at the bottom of the log.
function markSeen() {
  if (DUMMY || archived() || $('#view-chat').hidden || document.hidden || !chat.loaded || chat.moreAfter || fromBottom() > 60) return;
  if (chat.seenId == null || chat.maxId > chat.seenId) {
    chat.seenId = chat.maxId;
    remember('chatSeen', String(chat.maxId));
  }
  if (chat.unread) {
    chat.unread = 0;
    renderUnread();
  }
}

// Unread count in the Chat log tab, the page title and the jump button.
function renderUnread() {
  const n = chat.unread;
  const label = n > 99 ? '99+' : String(n);
  const badge = $('#tab-chat-badge');
  badge.hidden = !n;
  badge.textContent = label;
  $('#tab-chat').setAttribute('aria-label', n ? `Chat log, ${label} unread` : 'Chat log');
  document.title = `${n ? `(${label}) ` : ''}${document.title.replace(/^\(\d+\+?\) /, '')}`;
  if (!$('#view-chat').hidden) updateChatJump();
}

// From the other pages: just the count, every 30 seconds.
async function checkUnread() {
  if (DUMMY || archived()) return; // no new messages in sample data or a finished season
  if (chat.seenId == null) {
    const res = await api(`/api/chat?since_id=${Number.MAX_SAFE_INTEGER}&limit=1`);
    chat.seenId = res.max_id;
    remember('chatSeen', String(res.max_id));
    return;
  }
  const res = await api(`/api/chat?since_id=${Number.MAX_SAFE_INTEGER}&limit=1&unread_since=${chat.seenId}`);
  if (res.unread !== chat.unread) {
    chat.unread = res.unread;
    renderUnread();
  }
}

async function pollChat() {
  if (DUMMY || archived() || !chat.loaded || chat.loading || document.hidden || $('#view-chat').hidden) return;
  const res = await api(`/api/chat?since_id=${chat.maxId}&limit=200&unread_since=${chat.seenId ?? chat.maxId}`);
  if (res.more_after && !chat.moreAfter) return loadChatLatest().then(syncChatTime); // fell far behind
  // the chat log was reset while this page was open: start over with what came after
  if (res.start && chat.messages.length && chat.messages[0].ts < res.start) return loadChatLatest().then(syncChatTime);
  chat.maxId = Math.max(chat.maxId, res.max_id);
  // At the bottom of the log (or on the way there, having just sent something) what arrives is seen as it
  // arrives, so it's never counted as unread: not even for the moment before the log has scrolled to it.
  const follow = (fromBottom() < 60 && chat.pinned == null) || performance.now() < chat.followUntil;
  if (follow && !chat.moreAfter) {
    chat.unread = 0;
    if (chat.seenId == null || chat.maxId > chat.seenId) {
      chat.seenId = chat.maxId;
      remember('chatSeen', String(chat.maxId));
    }
  } else chat.unread = res.unread ?? 0;
  renderUnread();
  if (!res.messages.length || chat.moreAfter || chat.loading) return;
  const known = new Set(chat.messages.map((m) => m.id));
  const fresh = res.messages.filter((m) => !known.has(m.id));
  if (!fresh.length) return;
  const anchor = chatAnchor();
  chat.messages = chat.messages.concat(fresh).sort((a, b) => a.ts - b.ts || a.id - b.id);
  if (chat.messages.length > CHAT_KEEP) {
    chat.messages.splice(0, chat.messages.length - CHAT_KEEP);
    chat.moreBefore = true;
  }
  // (the logged copy of a message you sent takes the place of the one already showing, without a flourish)
  const mine = settlePending();
  renderChat(new Set(fresh.filter((m) => !mine.has(m.id)).map((m) => m.id)));
  if (follow) {
    chat.quietUntil = performance.now() + 800;
    chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  } else {
    restoreAnchor(anchor);
  }
  markSeen();
  updateChatJump();
  syncChatTime();
}

/* ---------- sending chat into the game ---------- */

// Accounts Roles lets chat send as the player Admin → Players links their email to (owners and admins
// with none send as Admin); the server mod shows it in game as
// "[Web] <name> message" and logs it, so it comes back into this log a few seconds later. Meanwhile
// it shows at the end of the log as one of your messages: grey and slanted with "sending…" until the
// server says it showed it, then like any other, and its logged copy takes its place unnoticed.
const compose = { me: null, sending: false, pending: [], checked: 0 };
const chatInput = $('#chat-input');

async function loadComposer() {
  const form = $('#chat-compose');
  if (DUMMY || archived() || SEASON !== CURRENT_SEASON) {
    form.hidden = true;
    return;
  }
  compose.checked = Date.now();
  try {
    compose.me = await api('/api/chat/me');
  } catch {
    compose.me = null;
  }
  renderComposer();
  if (!compose.whispersLoaded) loadWhispers().catch(() => {});
}

function renderComposer() {
  const me = compose.me;
  const form = $('#chat-compose');
  form.hidden = !me;
  if (!me) return;
  // without the server, whispers can still reach people who have the dashboard open
  const can = !!(me.ign || me.admin);
  chatInput.disabled = !can;
  chatInput.placeholder = me.blocked ? 'This account isn’t allowed to send messages from the dashboard'
    : !me.ign && !me.admin
    ? (me.email ? `${me.email} isn’t linked to a player yet · connect it in game with /mcstats connect` : 'Sign in to send messages')
    : !me.linked ? "The server isn't connected · /w still reaches people on the website"
    : `Message the server as ${me.admin ? 'Admin' : shownName(me.ign)} · /w to whisper`;
  $('#chat-compose-me').replaceChildren(me.admin ? adminTag() : me.ign ? headImg(me.ign, 24) : '');
  renderConnectAsk();
  updateComposeCount();
}

// A player asked in game (/mcstats connect) to connect this account: say yes or no here. Yes, and this
// account sends chat from the website as them (src/connect.js).
function renderConnectAsk() {
  const box = $('#chat-connect');
  const ask = compose.me?.connect;
  box.hidden = !ask;
  if (!ask) return box.replaceChildren();
  const answer = async (accept) => {
    for (const b of box.querySelectorAll('button')) b.disabled = true;
    try {
      const res = await fetch('/api/chat/connect', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ accept }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
      toast(accept ? `Connected: you chat as ${shownName(ask.name)} now` : 'Request turned down');
      await loadComposer();
    } catch (err) {
      toast(err.message, { error: true });
      for (const b of box.querySelectorAll('button')) b.disabled = false;
    }
  };
  const yes = el('button', { type: 'button', class: 'btn btn-primary', text: 'Connect' });
  const no = el('button', { type: 'button', class: 'btn btn-quiet', text: 'Not me' });
  yes.addEventListener('click', () => answer(true));
  no.addEventListener('click', () => answer(false));
  const switching = compose.me.ign && compose.me.ign.toLowerCase() !== ask.name.toLowerCase();
  box.replaceChildren(
    el('span', { class: 'chat-connect-text' }, headImg(ask.name, 20),
      el('span', { text: `${ask.name} asked in game to connect this account (${compose.me.email}). `
        + (switching ? `You'd chat as them instead of ${shownName(compose.me.ign)}.` : 'You’ll chat from here as them.') })),
    el('span', { class: 'chat-connect-actions' }, yes, no));
}

function updateComposeCount() {
  const max = compose.me?.max || 256;
  const n = chatInput.value.length;
  const left = $('#chat-count');
  left.textContent = n > max - 40 ? String(max - n) : '';
  left.classList.toggle('over', n > max);
  $('#chat-send').disabled = chatInput.disabled || compose.sending || !chatInput.value.trim() || n > max;
}

let composeErrTimer = 0;
function composeError(msg) {
  const box = $('#chat-compose-err');
  box.textContent = msg || '';
  box.hidden = !msg;
  clearTimeout(composeErrTimer);
  if (msg) composeErrTimer = setTimeout(() => { box.hidden = true; }, 6000);
}

// What you've sent that isn't in the log yet, as messages at its end (only while the newest are loaded).
// Each looks like your last message there (the name as the game styles it), so nothing changes when
// its logged copy takes its place.
function pendingMessages() {
  if (!chat.loaded || chat.moreAfter) return [];
  return compose.pending.map((p, i) => {
    const last = p.admin ? null : chat.messages.findLast((m) => m.kind === 'chat' && m.name && m.name.toLowerCase() === p.name.toLowerCase());
    return {
      id: `pending-${i}`, pending: p, kind: 'chat', ts: p.ts, text: p.text, via: p.admin ? 'admin' : 'web',
      name: last?.name ?? p.name, uuid: last?.uuid ?? (p.admin ? null : uuidForName(p.name)), display: last?.display ?? null,
    };
  });
}

// Redraws the log with what's being sent, keeping it where it is (or at the bottom).
function renderPending() {
  if ($('#view-chat').hidden || !chat.loaded) return;
  const stick = fromBottom() < 60;
  const anchor = chatAnchor();
  renderChat();
  if (stick) setScroll(chatScroll.scrollHeight);
  else restoreAnchor(anchor);
}

// A message that has come back in the log (logged after it was sent, same sender and text) is no longer
// pending. Gives the ids of the logged copies.
function settlePending() {
  const ids = new Set();
  if (!compose.pending.length) return ids;
  compose.pending = compose.pending.filter((p) => {
    const m = chat.messages.findLast((x) => x.id > p.after && !ids.has(x.id) && x.text === p.text
      && (p.admin ? x.via === 'admin' : x.via === 'web' && p.name.toLowerCase() === (x.name || '').toLowerCase()));
    if (m) ids.add(m.id);
    return !m;
  });
  return ids;
}

// Checks the log every second and a half until this message's logged copy has replaced it. If it
// hasn't after `ms`, it's taken down, and `missed` is called.
function watchPending(p, ms, missed) {
  const until = Date.now() + ms;
  const timer = setInterval(() => {
    if (!compose.pending.includes(p)) return clearInterval(timer);
    if (Date.now() < until) return void pollChat().catch(() => {});
    clearInterval(timer);
    compose.pending = compose.pending.filter((x) => x !== p);
    renderPending();
    missed?.();
  }, 1500);
}

async function sendChat() {
  const text = chatInput.value.trim();
  const me = compose.me;
  if (!text || compose.sending || !(me?.ign || me?.admin)) return;
  composeError('');
  closeSuggest();
  if (text.startsWith('/')) return sendWhisper(text);
  if (!me.linked) {
    composeError("The server isn't connected right now, so messages can't reach the game. You can still /w people on the website.");
    return;
  }
  compose.sending = true;
  // (after: the newest message when it was sent; its logged copy comes after that)
  const p = { name: me.admin ? null : me.ign, admin: !!me.admin, text, ts: Date.now(), sent: false, fresh: true, after: chat.maxId };
  chatInput.value = '';
  updateComposeCount();
  if (chat.moreAfter) await loadChatLatest().catch(() => {});
  compose.pending.push(p);
  renderPending();
  chat.pinned = null;
  chat.followUntil = performance.now() + 1500; // on the way to the bottom
  chat.quietUntil = performance.now() + 800;
  chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  try {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Your login expired; reload the page to sign in again.');
    if (!res.ok) {
      if (body.reason === 'offline') me.linked = false;
      throw new Error(body.error || `Couldn't send it (HTTP ${res.status}).`);
    }
    if (body.unsure) {
      // the server didn't answer in time, which isn't a no: it stays "sending…" while the log is watched for it
      watchPending(p, 8_000, () => {
        if (!chatInput.value) chatInput.value = text;
        updateComposeCount();
        composeError("The server didn't confirm that message and it hasn't shown up in the log, so it probably didn't arrive.");
      });
    } else {
      p.sent = true;
      renderPending();
      // the mod logs it right away; its logged copy is usually back within a few seconds
      watchPending(p, 60_000);
    }
  } catch (err) {
    compose.pending = compose.pending.filter((x) => x !== p);
    renderPending();
    if (!chatInput.value) chatInput.value = text; // give it back to try again
    composeError(err.message);
  } finally {
    compose.sending = false;
    renderComposer();
    if (!chatInput.disabled) chatInput.focus();
  }
}

$('#chat-compose').addEventListener('submit', (e) => {
  e.preventDefault();
  sendChat();
});
chatInput.addEventListener('input', () => {
  updateComposeCount();
  composeMode();
  updateSuggest();
  if (!$('#chat-compose-err').hidden) composeError('');
});

/* ---------- whispers: /w, /msg and /tell ---------- */

// "/w Name message" whispers to a player: in game if they're on, otherwise on their page if they
// have the dashboard open (src/whisper.js). Whispers to you, and the ones you send, show in the log
// as the game shows them, and only to the two of you. While typing one the box is in italics, and
// names are suggested the way the game does it, in their team colors.
const WHISPER_CMDS = ['w', 'msg', 'tell'];
const WHISPER_RE = /^\/(w|msg|tell)(\s|$)/i;
const suggest = { items: [], sel: 0, box: el('div', { class: 'chat-suggest', role: 'listbox', 'aria-label': 'Suggestions', hidden: '' }) };
$('#chat-compose').append(suggest.box);
chatInput.setAttribute('aria-autocomplete', 'list');

function composeMode() {
  chatInput.classList.toggle('whisper', WHISPER_RE.test(chatInput.value));
}

// Who a whisper can go to: everyone in game, and roster players with the dashboard open. { name, web }
function whisperTargets() {
  const out = new Map();
  for (const p of onlineNow().online) out.set(p.name.toLowerCase(), { name: p.name, web: false });
  for (const n of presence.data?.web || []) if (!out.has(n.toLowerCase())) out.set(n.toLowerCase(), { name: n, web: true });
  const me = compose.me?.ign?.toLowerCase();
  if (me) out.delete(me);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// What to suggest for the text so far (with the cursor at its end): the command, then the name.
function suggestionsFor(v) {
  const cmd = v.match(/^\/(\S*)$/);
  if (cmd) {
    const typed = cmd[1].toLowerCase();
    return WHISPER_CMDS.filter((c) => c.startsWith(typed) && c !== typed).map((c) => ({ from: 0, text: `/${c} `, cmd: c }));
  }
  const who = v.match(/^\/(w|msg|tell)\s+(\S*)$/i);
  if (!who) return [];
  const typed = who[2].toLowerCase();
  const from = v.length - who[2].length;
  return whisperTargets()
    .filter((t) => t.name.toLowerCase().startsWith(typed) && t.name.toLowerCase() !== typed)
    .map((t) => ({ from, text: `${t.name} `, name: t.name, web: t.web }));
}

function updateSuggest() {
  const v = chatInput.value;
  const atEnd = chatInput.selectionStart === v.length && chatInput.selectionEnd === v.length;
  const items = document.activeElement === chatInput && atEnd ? suggestionsFor(v).slice(0, 8) : [];
  const same = items.length === suggest.items.length && items.every((it, i) => it.text === suggest.items[i].text);
  if (!same) suggest.sel = 0;
  suggest.items = items;
  renderSuggest();
}

function renderSuggest() {
  const box = suggest.box;
  box.hidden = !suggest.items.length;
  chatInput.setAttribute('aria-expanded', String(!box.hidden));
  box.replaceChildren(...suggest.items.map((it, i) => {
    const row = el('div', { class: `chat-suggest-item${i === suggest.sel ? ' sel' : ''}`, role: 'option', 'aria-selected': String(i === suggest.sel) },
      ...(it.cmd
        ? [el('span', { class: 'chat-suggest-cmd', text: `/${it.cmd}` }), el('span', { class: 'muted', text: 'whisper to a player' })]
        : [headImg(it.name, 16, { width: 16, height: 16 }), teamName(el('span', { class: 'chat-suggest-name', text: it.name }), it.name),
          ...(it.web ? [el('span', { class: 'chat-suggest-where', text: 'on the website' })] : [])]));
    row.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // keep the box focused
      acceptSuggest(i);
    });
    return row;
  }));
}

function acceptSuggest(i = suggest.sel) {
  const it = suggest.items[i];
  if (!it) return;
  chatInput.value = chatInput.value.slice(0, it.from) + it.text;
  chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
  composeMode();
  updateComposeCount();
  updateSuggest();
}

function closeSuggest() {
  suggest.items = [];
  renderSuggest();
}

chatInput.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  // Tab completes, as in game, even before the list is showing
  if (e.key === 'Tab' && !e.shiftKey && !suggest.items.length && suggestionsFor(chatInput.value).length) updateSuggest();
  if (!suggest.items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = suggest.items.length;
    suggest.sel = (suggest.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderSuggest();
  } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault();
    acceptSuggest();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSuggest();
  }
});
chatInput.addEventListener('blur', closeSuggest);
chatInput.addEventListener('focus', updateSuggest);
chatInput.addEventListener('click', updateSuggest);

async function sendWhisper(text) {
  compose.sending = true;
  chatInput.value = '';
  composeMode();
  updateComposeCount();
  try {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Your login expired; reload the page to sign in again.');
    if (!res.ok || !body.whisper) throw new Error(body.error || `Couldn't send it (HTTP ${res.status}).`);
    if (chat.moreAfter) await loadChatLatest().catch(() => {});
    chat.pinned = null;
    addWhispers([body.whisper], { fresh: true, follow: true });
  } catch (err) {
    if (!chatInput.value) chatInput.value = text; // give it back to try again
    composeMode();
    composeError(err.message);
  } finally {
    compose.sending = false;
    renderComposer();
    if (!chatInput.disabled) chatInput.focus();
  }
}

// Yours, from the server: all of them at first (the latest 200), then anything newer than you have.
async function loadWhispers() {
  const me = compose.me;
  if (DUMMY || archived() || SEASON !== CURRENT_SEASON || !(me?.ign || me?.admin)) return;
  const since = compose.whispersLoaded ? chat.whispers.at(-1)?.id ?? 0 : 0;
  const res = await api(`/api/chat/whispers?since_id=${since}`);
  compose.whispersLoaded = true;
  addWhispers(res.whispers, { fresh: since > 0 });
}

function addWhispers(list, { fresh = false, follow = false } = {}) {
  const known = new Set(chat.whispers.map((w) => w.id));
  const add = (list || []).filter((w) => w && !known.has(w.id));
  if (!add.length) return;
  chat.whispers = chat.whispers.concat(add).sort((a, b) => a.ts - b.ts || a.id - b.id).slice(-500);
  if ($('#view-chat').hidden || !chat.loaded) return;
  const stick = follow || (fromBottom() < 60 && chat.pinned == null);
  const anchor = chatAnchor();
  renderChat(new Set(), fresh ? new Set(add.map((w) => w.id)) : new Set());
  if (stick) {
    chat.quietUntil = performance.now() + 800;
    chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  } else {
    restoreAnchor(anchor);
  }
}

// A whisper as it's sent (over the live connection): into the log, and a note on other pages.
async function onWhisper(w) {
  if (!w || chat.whispers.some((x) => x.id === w.id)) return;
  if (!compose.me) await loadComposer(); // to tell yours from ones to you
  addWhispers([w], { fresh: true });
  if (!isMe(w.sender) && ($('#view-chat').hidden || document.hidden)) {
    toast(`${w.sender === '@admin' ? 'Admin' : shownName(w.sender)} whispers to you: ${w.text}`, { ms: 6000 });
  }
}

function updateChatJump() {
  const btn = $('#chat-jump');
  const n = chat.unread;
  btn.hidden = !n && !chat.moreAfter && fromBottom() < 400;
  btn.classList.toggle('unread', n > 0);
  btn.textContent = n ? `${n > 99 ? '99+' : n} unread ↓` : 'Jump to latest ↓';
}

$('#chat-jump').addEventListener('click', async () => {
  chat.pinned = null;
  if (chat.moreAfter) await loadChatLatest().catch((e) => showError(e.message));
  else chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  updateChatJump();
  syncChatTime();
});

// Scroll events come at most once a frame, so everything that follows the scroll updates right here.
chatScroll.addEventListener('scroll', () => {
  if (performance.now() > chat.quietUntil) chat.pinned = null;
  chat.bottomGap = fromBottom();
  fillChat();
  markSeen();
  updateChatJump();
  syncChatTime();
}, { passive: true });

// When the log's box changes height (the graph folding, the window resizing), the bottom stays put.
new ResizeObserver(() => {
  if ($('#view-chat').hidden || !chat.loaded) return;
  setScroll(chatScroll.scrollHeight - chatScroll.clientHeight - chat.bottomGap);
  syncChatTime();
}).observe(chatScroll);

/* chat graph: players online, locked to the live 24h or one whole day, following the chat */

const liveDayWindow = () => presetWindow(presetByKey(TL_PRESETS, '24h'));

// The window showing t: the current one if t is on it, else the live 24h or t's whole day.
// The live window hands over to "yesterday" a little before t would slide off its left edge.
function chatWindowFor(t, cur) {
  const r = resolveWindow(cur);
  const margin = 600;
  if (cur.end == null ? t >= r.from + margin : t >= r.from && t < r.to) return cur;
  if (t >= nowSec() - 86400 + margin) return liveDayWindow();
  return { unit: 'day', count: 1, end: hourInfo(t).date, preset: '24h', byDay: true };
}

function syncChatPager() {
  const r = resolveWindow(chat.win);
  $('#cg-next').disabled = chat.win.end == null;
  $('#cg-prev').disabled = state.dataStart != null && r.from <= state.dataStart;
  $('#cg-label').textContent = windowLabel(chat.win, r, TL_PRESETS);
}

function setChatWindow(w, dir) {
  const prev = chat.win;
  chat.win = w;
  syncChatPager();
  loadChatGraph(pageShift(prev, w, dir)).catch((e) => showError(e.message));
}

$('#cg-prev').append(chevronIcon(-1));
$('#cg-next').append(chevronIcon(1));
$('#cg-prev').addEventListener('click', () => setChatWindow(shiftWindow(chat.win, -1), -1));
$('#cg-next').addEventListener('click', () => setChatWindow(shiftWindow(chat.win, 1), 1));

async function loadChatGraph(slide = 0) {
  const w = chat.win;
  const r = resolveWindow(w);
  const { from, to } = r;
  const req = ++chat.graphReq;
  syncChatPager();
  const [rows, ses] = await Promise.all([
    r.live ? loadSnapshots(from) : memoApi(`/api/snapshots?from=${from}&to=${to}`).then((x) => x.rows),
    r.live ? api(`/api/sessions?from=${from}&to=${to}`) : memoApi(`/api/sessions?from=${from}&to=${to}`),
  ]);
  if (req !== chat.graphReq) return; // the window moved on meanwhile
  chat.sessions = ses.rows.map(([uuid, name, a, b]) => ({ uuid, name, from: a, to: b + ses.poll_seconds }));
  const whoAt = (t) => [...new Set(chat.sessions.filter((s) => s.from < t + 1 && s.to > t).map((s) => s.name))];

  // While the graph pages, the cursor glides with it.
  const cursor = $('#cg-cursor');
  if (slide) {
    cursor.classList.add('sliding');
    clearTimeout(loadChatGraph.slideTimer);
    loadChatGraph.slideTimer = setTimeout(() => cursor.classList.remove('sliding'), SLIDE_MS);
  }
  renderLineChart($('#chat-chart'), {
    key: windowKey(w), from, to, step: POLL, ticks: 2, dataStart: chartStart(), whoAt,
    series: [{ name: 'online', cls: '1', color: 'var(--series-1)', area: true, pts: rows.map(([t, up, v]) => ({ t, v, down: !up })) }],
    fmtValue: (v) => `${v} ${v === 1 ? 'player' : 'players'}`,
    fmtTime: (t) => `${fmt(t, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · click to read`,
    onPick: (t) => jumpChatTo(t).catch((e) => showError(e.message)),
    onDraw: (g) => { chat.geom = g; placeCursor(); },
  }, { animate: live(), slide });
  renderOnlineThen(true);
}

// The cursor: a bold line at the chat's time, with a dot where it meets the players line.
function placeCursor() {
  const c = $('#cg-cursor');
  const g = chat.geom;
  // The live graph is redrawn once a minute, so anything newer than its last drawing is "now".
  const t = g && chat.win?.end == null && chat.t > g.to && chat.t <= nowSec() + 60 ? g.to : chat.t;
  if (!g || t == null || t < g.from || t > g.to) {
    c.classList.add('off');
    return;
  }
  c.classList.remove('off');
  c.style.transform = `translateX(${g.x(t)}px)`;
  c.style.top = `${g.top}px`;
  c.style.height = `${g.height}px`;
  const y = g.yAt(t);
  const dot = c.firstElementChild;
  dot.hidden = y == null;
  if (y != null) dot.style.top = `${y - g.top}px`;
}

const onlineHeads = new Map(); // reused so heads don't blink while scrolling
function renderOnlineThen(force = false) {
  const t = chat.t;
  if (t == null) return;
  const before = state.dataStart && t < state.dataStart;
  const people = before ? [] : [...new Map(chat.sessions.filter((s) => s.from <= t && s.to > t).map((s) => [s.uuid, s])).values()];
  const key = `${before}|${people.map((p) => p.uuid).join()}`;
  if (!force && key === chat.onlineKey) return;
  chat.onlineKey = key;
  $('#cg-online-n').textContent = people.length ? `· ${people.length}` : '';
  $('#cg-count').textContent = before ? '' : `${people.length} online`;
  const list = $('#cg-online-list');
  if (!people.length) {
    list.replaceChildren(el('div', { class: 'cg-online-none', text: before ? 'No data yet' : 'Nobody' }));
    return;
  }
  list.replaceChildren(...people.map((p) => {
    if (!onlineHeads.has(p.name)) onlineHeads.set(p.name, headImg(p.name, 16, { width: 16, height: 16, loading: 'eager' }));
    return playerLink(el('a', { class: 'cg-person' }, onlineHeads.get(p.name), colorName(el('span', { text: shownName(p.name) }), p.uuid, p.name)), p.uuid, p.name);
  }));
}

// Works out the chat's time from the scroll position and moves everything that follows it.
function syncChatTime() {
  if ($('#view-chat').hidden || !chat.win) return;
  const line = lastVisibleLine();
  const t = chat.pinned ?? (line ? line.ts / 1000 : nowSec());
  chat.t = t;
  $('#cg-time').textContent = cursorLabel(t);
  const w = chatWindowFor(t, chat.win);
  if (windowKey(w) !== windowKey(chat.win)) setChatWindow(w, t < resolveWindow(chat.win).from ? -1 : 1);
  placeCursor();
  renderOnlineThen();
}

/* folding the graph and the who's-online bar (remembered in the browser) */

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

$('#heat-team').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === heatTeam) return;
  heatTeam = b.dataset.v;
  remember('heatTeam', heatTeam);
  renderServerWeekGrid().catch((err) => showError(err.message));
});

function setGraphOpen(open) {
  $('#cg').classList.toggle('collapsed', !open);
  $('#cg-toggle').setAttribute('aria-expanded', String(open));
  remember('chatGraph', open ? 'open' : 'closed');
  if (open) requestAnimationFrame(() => redraws.get($('#chat-chart'))?.());
}
$('#cg-toggle').addEventListener('click', () => setGraphOpen($('#cg').classList.contains('collapsed')));
setGraphOpen(recall('chatGraph') !== 'closed');

function setOnlineBarOpen(open) {
  $('#chat-online').classList.toggle('collapsed', !open);
  $('#chat-online-pill').hidden = open;
  remember('chatOnline', open ? 'open' : 'closed');
}
$('#chat-online-close').addEventListener('click', () => setOnlineBarOpen(false));
$('#chat-online-pill').addEventListener('click', () => setOnlineBarOpen(true));
setOnlineBarOpen(recall('chatOnline') !== 'closed');

function renderChatOnline() {
  const { last, online } = onlineNow();
  const fresh = last && nowSec() - last.ts <= 300;
  syncChips($('#chat-chips'), fresh ? online : [], '--surface');
  const empty = $('#chat-online-empty');
  const paused = pausedSince();
  empty.hidden = fresh && online.length > 0;
  empty.textContent = paused ? `Server paused since ${clock(paused)}`
    : !fresh ? 'No recent data' : !last.up ? 'Server offline' : 'Nobody online right now';
  const n = fresh && last.up ? last.online : 0;
  $('#chat-online-pill-text').textContent = paused ? 'Paused' : !fresh ? 'No data' : !last.up ? 'Offline' : `${n} online`;
  $('#chat-online-pill').classList.toggle('none', !n);
}

async function showChat({ refresh = false } = {}) {
  showView('chat');
  document.title = `Chat log · ${SITE}`;
  if (!refresh || Date.now() - compose.checked > 60_000) loadComposer();
  await loadStatus();
  renderChatOnline();
  if (refresh && chat.loaded) {
    if (chat.win?.end == null) await loadChatGraph();
    syncChatTime();
    return;
  }
  chat.loaded = false;
  chat.messages = [];
  chat.newFrom = chat.unread ? chat.seenId : null;
  renderChat();
  const jump = chat.pendingJump; // "Show in chat log" from a player's page
  chat.pendingJump = null;
  if (jump) await jumpChatTo(jump.ts / 1000, jump.id);
  else {
    await loadChatLatest();
    markSeen();
  }
  const line = lastVisibleLine();
  chat.t = chat.pinned ?? (line ? line.ts / 1000 : nowSec());
  chat.win = chatWindowFor(chat.t, liveDayWindow());
  await loadChatGraph();
  syncChatTime();
  updateChatJump();
  fillChat();
}

let chatTicks = 0;
setInterval(() => {
  if (document.hidden) return;
  if (!$('#view-chat').hidden) {
    pollChat().catch(() => {});
    // whether the server is connected, now and then (and sooner while it isn't)
    if (Date.now() - compose.checked > (compose.me?.linked ? 60_000 : 20_000)) loadComposer();
  } else if (chatTicks++ % 3 === 0) checkUnread().catch(() => {});
}, CHAT_POLL_MS);

/* ---------- player card: what a click on a name opens ---------- */

const pcard = el('div', { class: 'pcard', role: 'dialog', 'aria-label': 'Player', hidden: '' });
document.body.append(pcard);
let pcardFor = null;
let pcardReq = 0;
const playerChatCache = new Map(); // query -> { at, promise }

// key: "uuid=…" or "name=…"; events adds their messages, deaths and advancements.
function fetchPlayerChat(key, { events = false, fresh = false } = {}) {
  const k = `${key}|${events}`;
  const hit = playerChatCache.get(k);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.promise;
  const promise = api(`/api/chat/player?${key}&today=${startOfTodayTs()}${events ? '&events=1' : ''}`);
  playerChatCache.set(k, { at: Date.now(), promise });
  promise.catch(() => playerChatCache.delete(k));
  return promise;
}

const nameParts = (display, name) => (display
  ? swapParts(display, name).map((p) => (p.c ? el('span', { class: 'mc', style: mcStyle(p.c), text: p.t }) : p.t))
  : [shownName(name)]);

function playedBetween(sessions, from, to) {
  let total = 0;
  for (const [s, e] of sessions) {
    const overlap = Math.min(e, to) - Math.max(s, from);
    if (overlap > 0) total += overlap;
  }
  return total;
}

// Little bars, one per hour: bars = [{ v (minutes), now?, tip: tooltip rows }], labels = [[fraction across, text]],
// scaled to fullAt minutes (or the biggest bar).
// The bars stretch to any width; the hour labels sit under them as text, so they never stretch.
function hourBars(bars, labels, aria, fullAt = null, H = 40) {
  const W = 240, slot = W / bars.length;
  const max = fullAt ?? Math.max(10, ...bars.map((b) => b.v));
  const svg = sv('svg', { width: '100%', height: H, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'pc-graph', role: 'img', 'aria-label': aria });
  bars.forEach((b, i) => {
    const bh = Math.max(b.v > 0.5 ? 2 : 1, (b.v / max) * H);
    const bar = sv('rect', { x: i * slot + 1, y: H - bh, width: slot - 2, height: bh, rx: 1.5, class: `pc-bar${b.now ? ' now' : ''}${b.v <= 0.5 ? ' zero' : ''}` });
    bar.dataset.i = i;
    svg.append(bar);
  });
  svg.addEventListener('pointermove', (e) => {
    const i = e.target.dataset?.i;
    if (i == null) return hideTip();
    showTip(e.clientX, e.clientY, bars[i].tip);
  });
  svg.addEventListener('pointerleave', hideTip);
  const axis = el('div', { class: 'pc-axis' }, ...labels.map(([f, text]) => el('span', { style: `left:${f * 100}%`, text })));
  return el('div', { class: 'pc-hours' }, svg, axis);
}

// Minutes online in each of the last 24 hours, oldest first, ending with the hour now.
function last24Hours(sessions) {
  const now = nowSec();
  const hourNow = Math.floor(now / 3600) * 3600;
  const first = hourNow - 23 * 3600;
  const mins = Array(24).fill(0);
  for (const [s, e] of sessions) {
    if (e <= first) continue;
    eachHourChunk(Math.max(s, first), Math.min(e, now), (h, secs) => {
      const i = Math.round((h - first) / 3600);
      if (i >= 0 && i < 24) mins[i] += secs / 60;
    });
  }
  const bars = mins.map((v, i) => {
    const t = first + i * 3600;
    const h = hourInfo(t).hour;
    return {
      v, now: i === 23,
      tip: [{ value: v < 0.5 ? 'Not on' : `${Math.round(v)} min` },
        { label: `${i === 23 ? 'This hour' : fmt(t, { weekday: 'short' })}, ${hourName(h)}–${hourName((h + 1) % 24)}` }],
    };
  });
  const labels = [];
  for (let i = 0; i < 24; i++) {
    const h = hourInfo(first + i * 3600).hour;
    if (h % 6 === 0 && i < 20) labels.push([i / 24, hourName(h, true)]);
  }
  labels.push([1, 'now']);
  return hourBars(bars, labels, 'Time online in each of the last 24 hours', 60); // a full bar is the whole hour
}

// Average minutes online in each hour of the day since the season began. Each hour of the day is
// divided by how many times it has come round since then, so a new season isn't averaged over days
// that hadn't happened yet.
function usualActivity(sessions) {
  const now = archived() && state.status?.last?.ts ? state.status.last.ts : nowSec();
  const start = chartStart() ?? sessions[0]?.[0] ?? now;
  const mins = Array(24).fill(0);
  const seen = Array(24).fill(0); // hours of each hour of the day since the start
  if (start < now) eachHourChunk(start, now, (h, secs) => { seen[hourInfo(h).hour] += secs / 3600; });
  for (const [s, e] of sessions) {
    const a = Math.max(s, start), b = Math.min(e, now);
    if (b > a) eachHourChunk(a, b, (h, secs) => { mins[hourInfo(h).hour] += secs / 60; });
  }
  const avg = mins.map((m, h) => (seen[h] > 0 ? m / Math.max(1, seen[h]) : 0));
  const nowHour = hourInfo(nowSec()).hour;
  const days = Math.max(1, Math.round((now - start) / 86400));
  const bars = avg.map((v, h) => ({
    v, now: !archived() && h === nowHour,
    tip: [{ value: v < 1 ? 'Rarely on' : `${Math.round(v)} min`, label: v < 1 ? null : 'avg' },
      { label: `${hourName(h)}–${hourName((h + 1) % 24)}, ${archived() ? 'whole season' : `since the season began`}` }],
  }));
  return {
    graph: hourBars(bars, [0, 6, 12, 18].map((h) => [h / 24, hourName(h, true)]), 'Usual activity by hour', null, 58),
    sub: `avg minutes, over ${days} ${days === 1 ? 'day' : 'days'}`,
  };
}

function pcStat(value, label) {
  return el('div', { class: 'pc-stat' }, el('div', { class: 'pc-value', text: value }), el('div', { class: 'pc-label', text: label }));
}

function renderCard({ name, uuid, chatInfo, player, error }) {
  const display = chatInfo?.display;
  const headRow = el('div', { class: 'pc-head' },
    headImg(name || 'MHF_Steve', 48, { width: 48, height: 48, class: 'pc-avatar' }),
    el('div', { class: 'pc-who' },
      el('div', { class: 'pc-name' }, ...(rosterOf(name) ? [el('span', { class: `team-dot team-${rosterOf(name).team}`, title: teamLabel(rosterOf(name).team) })] : []),
        ...nameParts(display, name || '…')),
      el('div', { class: 'pc-status', id: 'pc-status' })));
  const kids = [headRow];
  if (error) {
    kids.push(el('div', { class: 'pc-note', text: error }));
  } else if (!player) {
    kids.push(el('div', { class: 'pc-note loading', text: 'Loading…' }));
  } else {
    const sessions = player.sessions.map(([s, e]) => [s, e + player.poll_seconds]);
    const lastTs = state.status?.last?.ts;
    const online = !archived() && lastTs != null && player.sessions.length && player.sessions.at(-1)[1] === lastTs;
    const status = headRow.querySelector('.pc-status');
    if (online) status.append(el('span', { class: 'pc-dot' }), `Online since ${clock(player.sessions.at(-1)[0])}`);
    else status.textContent = player.sessions.length ? `Last seen ${ago(player.sessions.at(-1)[1])}` : 'Not seen yet';
    const now = nowSec();
    kids.push(
      archived()
        ? el('div', { class: 'pc-stats' },
          pcStat(chatInfo.total.toLocaleString(), chatInfo.total === 1 ? 'message' : 'messages'),
          pcStat(dur(playedBetween(sessions, 0, now)), 'played'),
          pcStat(sessions.length.toLocaleString(), sessions.length === 1 ? 'session' : 'sessions'))
        : el('div', { class: 'pc-stats' },
          pcStat(chatInfo.today.toLocaleString(), chatInfo.today === 1 ? 'message today' : 'messages today'),
          pcStat(dur(playedBetween(sessions, startOfTodayTs(), now)), 'played today'),
          pcStat(dur(playedBetween(sessions, now - 7 * 86400, now)), 'last 7 days')),
      el('div', { class: 'pc-section', text: 'Past 24 hours' }),
      last24Hours(sessions),
      el('a', { class: 'pc-open', href: `#/player/${uuid}` }, 'View profile'),
    );
  }
  pcard.replaceChildren(...kids);
}

function placeCard() {
  if (!pcardFor || pcard.hidden) return;
  const r = pcardFor.getBoundingClientRect();
  const w = pcard.offsetWidth, h = pcard.offsetHeight;
  const x = Math.min(Math.max(8, r.left), innerWidth - w - 8);
  let y = r.bottom + 6;
  if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
  pcard.style.left = `${x}px`;
  pcard.style.top = `${y}px`;
}

async function openCard(a) {
  if (pcardFor === a && !pcard.hidden) return closeCard();
  hideTip();
  pcardFor = a;
  const req = ++pcardReq;
  let uuid = a.dataset.uuid || null;
  let name = a.dataset.name || knownNames.get(uuid) || '';
  renderCard({ name, uuid });
  pcard.hidden = false;
  if (!reducedMotion()) pcard.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 140, easing: 'ease-out' });
  placeCard();
  try {
    const chatInfo = await fetchPlayerChat(uuid ? `uuid=${uuid}` : `name=${encodeURIComponent(name)}`);
    uuid = chatInfo.uuid;
    name = chatInfo.name;
    knownNames.set(uuid, name);
    const player = await fetchPlayer(uuid);
    if (req !== pcardReq) return;
    renderCard({ name, uuid, chatInfo, player });
  } catch (err) {
    if (req !== pcardReq) return;
    renderCard({ name, uuid, error: /→ 404$/.test(err.message) ? 'Not seen on the server yet.' : 'Couldn’t load this player.' });
  }
  placeCard();
}

function closeCard() {
  pcard.hidden = true;
  pcardFor = null;
  pcardReq++;
  hideTip();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-card]');
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  openCard(a);
});
document.addEventListener('pointerdown', (e) => {
  if (!pcard.hidden && !pcard.contains(e.target) && !e.target.closest('[data-card]')) closeCard();
});
for (const type of ['wheel', 'touchmove']) {
  document.addEventListener(type, (e) => { if (!pcard.hidden && !pcard.contains(e.target)) closeCard(); }, { passive: true });
}
window.addEventListener('resize', () => { if (!pcard.hidden) closeCard(); });
window.addEventListener('scroll', () => { if (!pcard.hidden) closeCard(); }, { passive: true }); // the page, not the chat log
window.addEventListener('hashchange', closeCard);

// A chat mark picked on a player's activity strip: a look at it, and a way to it in the chat log.
function openChatPeek([id, ts, kind, text], x, y) {
  const anchor = { getBoundingClientRect: () => new DOMRect(x - 8, y, 0, 0) };
  if (pcardFor?.peek === id && !pcard.hidden) return closeCard();
  hideTip();
  pcardFor = anchor;
  anchor.peek = id;
  pcardReq++;
  const d = state.playerData;
  const name = knownNames.get(state.playerShown) || '';
  const what = CHAT_KINDS[kind] || CHAT_KINDS.chat;
  const talk = kind === 'chat' || kind === 'say' || kind === 'emote';
  const go = el('button', { type: 'button', class: 'pc-open', text: 'Show in chat log →' });
  go.addEventListener('click', () => {
    chat.pendingJump = { id, ts };
    closeCard();
    location.hash = '#/chat';
  });
  pcard.replaceChildren(
    el('div', { class: 'peek-head' },
      el('span', { class: 'key', style: `background:${what.color}` }),
      el('span', { class: 'peek-kind', text: what.label }),
      el('time', { text: fmt(ts / 1000, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })),
    el('div', { class: `peek-text peek-${kind}` },
      ...(talk ? [el('span', { class: 'msg-name' }, ...nameParts(d?.chat?.display, name)), kind === 'emote' ? ' ' : ': '] : []),
      text.length >= 200 ? `${text}…` : text),
    go);
  pcard.hidden = false;
  placeCard();
}

/* ---------- chat search (⌘F / Ctrl+F on the chat page) ---------- */

const search = { q: '', in: 'all', from: '', kind: '', results: [], more: false, req: 0, players: null, timer: 0 };
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
$('#search-kbd').textContent = isMac ? '⌘F' : 'Ctrl F';

// The search sits at the head of the chat log; its results and filters drop down over the log while it's open.
function openSearch() {
  const q = $('#search-q');
  if (!$('#search-pop').hidden) { q.focus(); q.select(); return; }
  closeCard();
  $('#search-pop').hidden = false;
  $('#search-close').hidden = false;
  q.setAttribute('aria-expanded', 'true');
  if (document.activeElement !== q) { q.focus(); q.select(); }
  loadSearchPlayers().catch(() => {});
  if (!search.results.length) renderSearch();
}

function closeSearch() {
  $('#search-pop').hidden = true;
  $('#search-close').hidden = true;
  $('#search-q').setAttribute('aria-expanded', 'false');
}

async function loadSearchPlayers() {
  if (search.players) return;
  const { players } = await api('/api/chat/players');
  search.players = players;
  for (const p of players) knownNames.set(p.uuid, p.name);
  $('#sf-from').append(...players.map((p) => el('option', { value: p.uuid, text: p.n ? `${p.name} (${p.n.toLocaleString()})` : p.name })));
}

function syncSearchFilters() {
  for (const b of $('#sf-in').children) b.setAttribute('aria-pressed', String(b.dataset.v === search.in));
  const n = (search.in !== 'all') + !!search.from + !!search.kind;
  const badge = $('#search-filter-n');
  badge.hidden = !n;
  badge.textContent = n;
}

async function runSearch(more = false) {
  const q = search.q.trim();
  if (!q && !search.from && !search.kind) {
    search.results = [];
    search.more = false;
    search.req++;
    renderSearch();
    return;
  }
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (q && search.in !== 'all') params.set('in', search.in);
  if (search.from) params.set('from', search.from);
  if (search.kind) params.set('kind', search.kind);
  if (more) {
    const last = search.results.at(-1);
    params.set('before', `${last.ts}:${last.id}`);
  }
  const req = ++search.req;
  if (!more) $('#search-results').classList.add('busy');
  try {
    const res = await api(`/api/chat/search?${params}`);
    if (req !== search.req) return;
    search.results = more ? search.results.concat(res.results) : res.results;
    search.more = res.more;
    renderSearch();
    if (!more) $('#search-results').scrollTop = 0;
  } finally {
    if (req === search.req) $('#search-results').classList.remove('busy');
  }
}

// Where the words matched, marked.
function highlighted(text, q) {
  if (!q) return [text];
  const out = [];
  const lower = text.toLowerCase(), needle = q.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, at)) {
    if (i > at) out.push(text.slice(at, i));
    out.push(el('mark', { text: text.slice(i, i + needle.length) }));
    at = i + needle.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function searchItem(m) {
  const talk = m.kind === 'chat' || m.kind === 'say' || m.kind === 'emote';
  const q = search.q.trim();
  const shown = displayText(m);
  // a system line already starts with the name, which the header shows
  const text = talk || !m.text.startsWith(shown) ? m.text : m.text.slice(shown.length).trim();
  const own = m.display?.find((p) => p.c && m.name && p.t.includes(m.name));
  const item = el('button', { type: 'button', class: `sr-item sr-${m.kind}` },
    el('div', { class: 'sr-meta' },
      talk ? chatAvatar(m, 16) : el('span', { class: 'sr-icon' }, icon(SYS_ICONS[m.kind] || SYS_ICONS.system, 13)),
      el('span', { class: `sr-name${own ? ' mc' : ''}`, ...(own && { style: mcStyle(own.c) }) },
        ...highlighted(shown, search.in === 'text' ? '' : q)),
      el('time', { text: `${relativeDay(hourInfo(m.ts / 1000).date, { month: 'short', day: 'numeric' })} · ${clock(m.ts / 1000)}` })),
    el('div', { class: 'sr-text' }, ...highlighted(text, search.in === 'name' ? '' : q)));
  item.addEventListener('click', () => {
    for (const x of $('#search-results').querySelectorAll('.sr-item.current')) x.classList.remove('current');
    item.classList.add('current');
    jumpChatTo(m.ts / 1000, m.id).catch((e) => showError(e.message));
  });
  return item;
}

function renderSearch() {
  const root = $('#search-results');
  const q = search.q.trim();
  if (!q && !search.from && !search.kind) {
    root.replaceChildren(el('div', { class: 'sr-hint' },
      'Type to search messages and names. ',
      el('button', { type: 'button', class: 'link-btn', text: 'Filters' }), ' narrow it to one player or kind of message.'));
    root.querySelector('.link-btn').addEventListener('click', () => toggleFilters(true));
    return;
  }
  if (!search.results.length) {
    root.replaceChildren(el('div', { class: 'sr-hint', text: 'No messages found.' }));
    return;
  }
  const n = search.results.length;
  const kids = [el('div', { class: 'sr-count', text: `${n}${search.more ? '+' : ''} ${n === 1 ? 'result' : 'results'}, newest first` }), ...search.results.map(searchItem)];
  if (search.more) {
    const more = el('button', { type: 'button', class: 'sr-more', text: 'Show older results' });
    more.addEventListener('click', () => { more.disabled = true; runSearch(true).catch((e) => showError(e.message)); });
    kids.push(more);
  }
  root.replaceChildren(...kids);
}

function toggleFilters(open = $('#search-filters').hidden) {
  $('#search-filters').hidden = !open;
  $('#search-filter-btn').setAttribute('aria-expanded', String(open));
}

const searchSoon = () => {
  clearTimeout(search.timer);
  search.timer = setTimeout(() => runSearch().catch((e) => showError(e.message)), 220);
};
$('#search-q').addEventListener('focus', () => { if ($('#search-pop').hidden) openSearch(); });
$('#search-close').addEventListener('click', () => { closeSearch(); $('#search-q').blur(); });
// a click anywhere outside the search (the log, the chart) puts the results away
document.addEventListener('pointerdown', (e) => {
  if (!$('#search-pop').hidden && !$('#chat-find').contains(e.target)) closeSearch();
});
// on a phone the results cover the log: picking one puts them away, to show it there
$('#search-results').addEventListener('click', (e) => {
  if (e.target.closest('.sr-item') && matchMedia('(max-width: 640px)').matches) closeSearch();
});
$('#search-filter-btn').addEventListener('click', () => toggleFilters());
$('#search-q').addEventListener('input', (e) => { search.q = e.target.value; searchSoon(); });
$('#search-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(search.timer); runSearch().catch((err) => showError(err.message)); }
  if (e.key === 'ArrowDown') { e.preventDefault(); $('#search-results .sr-item')?.focus(); }
});
$('#search-results').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...$('#search-results').querySelectorAll('.sr-item')];
  const i = items.indexOf(document.activeElement);
  if (i === -1) return;
  e.preventDefault();
  if (e.key === 'ArrowUp' && i === 0) $('#search-q').focus();
  else items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
});
$('#sf-in').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  search.in = b.dataset.v;
  syncSearchFilters();
  if (search.q.trim()) searchSoon();
});
$('#sf-from').addEventListener('change', (e) => { search.from = e.target.value; syncSearchFilters(); searchSoon(); });
$('#sf-kind').addEventListener('change', (e) => { search.kind = e.target.value; syncSearchFilters(); searchSoon(); });
syncSearchFilters();

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && !$('#view-chat').hidden) {
    e.preventDefault();
    openSearch();
  } else if (e.key === 'Escape') {
    if (!pcard.hidden) closeCard();
    else if (!$('#search-pop').hidden) closeSearch();
  }
});

/* ---------- combat: kills and deaths ---------- */

// Every death in the season comes from /api/combat once (then only what's new), and the Combat
// page and each player's combat card are worked out from it here, for whatever range is picked.

const CAUSE_LABELS = {
  melee: 'Slain', shot: 'Shot', explosion: 'Explosion', fall: 'Fall', fire: 'Fire', lava: 'Lava', drown: 'Drowning',
  void: 'The void', border: 'World border', magic: 'Magic', wither: 'Wither', sonic: 'Sonic boom', lightning: 'Lightning', crush: 'Crushed',
  suffocation: 'Suffocation', starve: 'Starvation', thorns: 'Thorns', freeze: 'Freezing', other: 'Other',
};
const mobLabel = (mob) => mob.replace(/^.*:/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// What ended a death no player caused: the creature if there was one, else how.
const naturalCause = (d) => (d.mob ? mobLabel(d.mob) : CAUSE_LABELS[d.cause] || 'Other');
// a sword, point up and to the right: blade, crossguard, grip, pommel
const SWORD_ICON = ['M13.5 2.5 10.6 3 4.9 8.7', 'M13.5 2.5 13 5.4 7.3 11.1', 'M3.4 7.2l5.4 5.4', 'M6.1 9.9 3.4 12.6', 'M2.7 13.3h.01'];
const teamOf = (name) => rosterOf(name)?.team ?? null;

const combat = {
  rows: [], // every death this season, oldest first: { id, ts (seconds), victim, killer, cause, mob }
  uuids: new Map(), // lowercased name -> uuid, for the players named in them
  maxId: 0,
  loaded: false,
  pending: null,
  sort: (() => {
    const [key, dir] = (recall('combatSort') || '').split(':');
    return ['name', 'kills', 'deaths', 'kd'].includes(key) ? { key, dir: dir === '1' ? 1 : -1 } : { key: 'kills', dir: -1 };
  })(),
  chartMode: recall('combatChart') === 'total' ? 'total' : 'each',
  view: null, // what the page last drew: { from, to, rows, buckets, hourly }
};

// Loads the season's deaths; later calls fetch only what's been logged since.
function loadCombat() {
  if (combat.pending) return combat.pending;
  if (combat.loaded && archived()) return Promise.resolve();
  combat.pending = (async () => {
    const res = await api(combat.loaded ? `/api/combat?after=${combat.maxId}` : '/api/combat');
    for (const [name, uuid] of Object.entries(res.uuids || {})) combat.uuids.set(name, uuid);
    const have = new Set(combat.rows.map((d) => d.id));
    const fresh = res.rows.filter((r) => !have.has(r[0])).map(([id, ts, victim, killer, cause, mob]) => ({ id, ts, victim, killer, cause, mob }));
    for (const d of fresh) {
      for (const n of [d.victim, d.killer]) {
        const uuid = n && combat.uuids.get(n.toLowerCase());
        if (uuid && !knownNames.has(uuid)) knownNames.set(uuid, n);
      }
    }
    if (fresh.length) combat.rows = combat.rows.concat(fresh).sort((a, b) => a.ts - b.ts || a.id - b.id);
    combat.maxId = Math.max(combat.maxId, res.max_id || 0);
    combat.loaded = true;
    return fresh.length;
  })().finally(() => { combat.pending = null; });
  return combat.pending;
}

const combatUuid = (name) => combat.uuids.get(name.toLowerCase()) || uuidForName(name);

// Kills, deaths and K/D for everyone in these deaths (and everyone on the roster, even with none).
function combatPlayers(rows, { everyone = true } = {}) {
  const by = new Map();
  const get = (name) => {
    const key = name.toLowerCase();
    if (!by.has(key)) by.set(key, { key, name: rosterOf(name)?.ign || name, kills: 0, deaths: 0, pvpDeaths: 0 });
    return by.get(key);
  };
  if (everyone) for (const p of roster.values()) get(p.ign);
  for (const d of rows) {
    const v = get(d.victim);
    v.deaths++;
    if (d.killer) {
      v.pvpDeaths++;
      get(d.killer).kills++;
    }
  }
  for (const p of by.values()) p.kd = p.kills / Math.max(1, p.deaths);
  return [...by.values()];
}
const fmtKd = (p) => (p.kills + p.deaths === 0 ? '–' : p.kd.toFixed(2));

/* the range the whole page shows */

const COMBAT_PRESETS = [
  { v: '24h', label: '24h', unit: 'hour', count: 24, long: 'Last 24 hours' },
  dayPreset(7), dayPreset(30),
  { v: 'all', label: 'All', unit: 'all', count: 0, long: 'All time' },
];

// The picked range as { from, to, rows (the deaths in it), buckets, hourly }: one bucket per hour
// for up to two days, else one per day.
function combatView() {
  const w = cbCtl.get();
  let r = resolveWindow(w);
  if (w.unit === 'all') {
    const first = Math.min(state.dataStart ?? nowSec(), combat.rows[0]?.ts ?? nowSec());
    const now = nowSec();
    r = now - first <= 48 * 3600
      ? resolveWindow({ unit: 'hour', count: Math.max(6, Math.ceil((currentHourEnd() - first) / 3600)), end: null })
      : resolveWindow({ unit: 'day', count: Math.min(400, daysCovered(first)), end: null });
    r = { ...r, all: true };
  }
  const rows = r.all ? combat.rows : combat.rows.filter((d) => d.ts >= r.from && d.ts < r.to);
  return { ...r, w, rows, hourly: r.buckets[0].end - r.buckets[0].start <= 3600 };
}

/* The teams against each other: each one's deaths, split by what caused them */

// For the teams in the scoreboard (the admin page picks them): { id: { kills, own, other, deaths,
// by: { killer's team: n } } }, and '#outside': deaths of anyone not on one of them. A kill by someone
// who isn't on one of these teams counts with the other deaths.
function factionTotals(rows, shown) {
  const t = { '#outside': 0 }; // (no team's id starts with #)
  for (const x of shown) t[x.id] = { kills: 0, own: 0, other: 0, deaths: 0, by: {} };
  for (const d of rows) {
    const vt = teamAt(d.victim, d.ts); // the teams they were on when it happened
    const kt = d.killer ? teamAt(d.killer, d.ts) : null;
    if (!vt || !t[vt]) { t['#outside']++; continue; }
    t[vt].deaths++;
    if (kt && kt !== vt && t[kt]) {
      t[kt].kills++;
      t[vt].by[kt] = (t[vt].by[kt] || 0) + 1;
    } else if (kt === vt) t[vt].own++;
    else t[vt].other++;
  }
  return t;
}

// One long bar of every death. With two teams it's a tug of war: left of the divider is every death
// of the second team (the ones nobody on the other side caused, hatched; then its own team kills;
// then the first team's kills, ending at the divider), and right of it, mirrored, every death of the
// first. A team shown "in the middle" (the admin page) sits between those two sides, with no headline
// of its own: its deaths, with its kills of the first team to their left and of the second to their
// right. With any other number of sides, each team gets a block of its deaths in order, the kills
// against it in the color of the team that made them. A segment that would be empty isn't there at all.
function renderFactionBar() {
  const card = $('#cb-score-card');
  const shown = teams.filter((t) => t.bar);
  card.hidden = !roster.size || !shown.length;
  if (card.hidden || !combat.view) return;
  const sides = shown.filter((t) => !t.middle);
  const tug = sides.length === 2;
  const mids = tug ? shown.filter((t) => t.middle) : [];
  card.querySelector('h2').textContent = tug ? `${sides[0].short} vs ${sides[1].short}` : shown.length === 1 ? shown[0].name : 'Teams';
  const root = $('#cb-score');
  const t = factionTotals(combat.view.rows, shown);
  const total = shown.reduce((n, x) => n + t[x.id].deaths, 0);
  const seg = (cls, n, tipRows) => {
    if (!n) return null;
    const s = el('div', { class: `fb-seg ${cls}`, style: `flex-grow:${n}` }, n / total > 0.06 ? el('span', { text: String(n) }) : null);
    s.tipRows = tipRows;
    s.n = n;
    return s;
  };
  const tipRow = (n, what, id) => [{ value: n.toLocaleString(), label: what, color: teamVar(id) }];
  const other = (x) => seg(`fb-other fb-${x.id}`, t[x.id].other, tipRow(t[x.id].other, `Other ${x.short} deaths: mobs, falls, lava…`, x.id));
  const own = (x) => seg(`fb-own fb-${x.id}`, t[x.id].own, tipRow(t[x.id].own, `${x.short} players killed by their own team`, x.id));
  const killed = (v, k) => seg(`fb-kills fb-${k.id}`, t[v.id].by[k.id] || 0, tipRow(t[v.id].by[k.id] || 0, `${v.short} players killed by ${k.short}`, k.id));
  const key = (cls, text) => el('span', {}, el('i', { class: `fb-key ${cls}` }), text);
  const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;
  const anyOwn = shown.some((x) => !mids.includes(x) && t[x.id].own);
  const legend = el('div', { class: 'legend fb-legend' },
    ...shown.filter((x) => shown.length > 1 && !mids.includes(x)).map((x) => key(`fb-kills fb-${x.id}`, `${x.short} kills`)),
    ...mids.flatMap((x) => [key(`fb-kills fb-${x.id}`, `${x.short} kills`), key(`fb-all fb-${x.id}`, `${x.short} deaths`)]),
    ...(anyOwn ? [key('fb-own fb-mix', 'Killed by their own team')] : []),
    key('fb-other fb-mix', 'Other deaths (mobs, falls, lava…)'),
    ...(t['#outside'] ? [el('span', { class: 'muted', text: `${t['#outside']} ${plural(t['#outside'], 'death')} of players not on ${shown.length === 1 ? 'this team' : 'these teams'} not shown` })] : []));
  const none = el('span', { class: 'fb-none', text: 'No deaths in this range yet' });
  const ends = (segs) => { segs[0]?.classList.add('fb-first'); segs.at(-1)?.classList.add('fb-last'); return segs; };
  const count = (segs) => segs.reduce((n, s) => n + s.n, 0);

  if (tug) {
    const [a, b] = sides; // b's deaths on the left, a's on the right
    // a team in the middle: every death of its players as one segment, between its kills of a and its
    // kills of b. Those can be slivers beside the rest (one kill among hundreds of deaths), so all
    // three share one tooltip that lists everything the team did and had done to it.
    const midRows = (x) => {
      const d = t[x.id];
      const rows = [];
      for (const k of sides) if (t[k.id].by[x.id]) rows.push({ value: t[k.id].by[x.id].toLocaleString(), label: `${k.short} players killed by ${x.short}`, color: teamVar(x.id) });
      if (d.deaths) rows.push({ value: d.deaths.toLocaleString(), label: `${x.short} ${plural(d.deaths, 'death')}`, color: teamVar(x.id) });
      for (const k of shown) if (k !== x && d.by[k.id]) rows.push({ value: d.by[k.id].toLocaleString(), label: `killed by ${k.short}`, color: teamVar(k.id) });
      if (d.own) rows.push({ value: d.own.toLocaleString(), label: 'killed by their own team' });
      if (d.other) rows.push({ value: d.other.toLocaleString(), label: 'other: mobs, falls, lava…' });
      return rows;
    };
    const midSegs = (x) => {
      const rows = midRows(x);
      const segs = [killed(a, x), seg(`fb-all fb-${x.id}`, t[x.id].deaths, rows), killed(b, x)].filter(Boolean);
      for (const sg of segs) sg.tipRows = rows;
      return segs;
    };
    const left = [other(b), own(b), ...sides.filter((k) => k !== b).map((k) => killed(b, k))].filter(Boolean);
    const mid = mids.flatMap(midSegs);
    const right = [killed(a, b), own(a), other(a)].filter(Boolean);
    const segs = ends([...left, ...mid, ...right]);
    // the dividers sit either side of the middle (one, where the left side's deaths end, when nothing's
    // in the middle); the kill counts hang off them, kept on screen
    const pct = (n) => (total ? (n / total) * 100 : 50);
    const splitL = pct(count(left)), splitR = pct(count(left) + count(mid));
    const room = Math.min(42, (118 / Math.max(280, root.clientWidth || 600)) * 100);
    const clamp = (v) => Math.min(100 - room, Math.max(room, v));
    const kills = (x, side, style) => el('div', { class: `fb-count fb-${side} fb-${x.id}`, style },
      el('strong', { text: t[x.id].kills.toLocaleString() }), el('span', { text: `${x.short} ${plural(t[x.id].kills, 'kill')}` }));
    const end = (x) => el('div', { class: 'fb-end' },
      el('strong', { text: t[x.id].deaths.toLocaleString() }), ` ${x.short} ${plural(t[x.id].deaths, 'death')}`);
    const divider = (at) => el('i', { class: 'fb-mid', style: `left:${at}%` });
    const bar = el('div', { class: `fb-bar${total ? '' : ' empty'}` }, ...segs,
      ...(total ? (mid.length ? [divider(splitL), divider(splitR)] : [divider(splitL)]) : [none]));
    root.replaceChildren(
      el('div', { class: 'fb-counts' }, kills(a, 'left', `right:${100 - clamp(splitL)}%`), kills(b, 'right', `left:${clamp(splitR)}%`)),
      bar, el('div', { class: 'fb-ends' }, end(b), end(a)), legend);
    attachCellTips(bar, '.fb-seg', (s) => s.tipRows);
  } else {
    // a block per team: who killed its players (each in the killer's color), its own team kills, the rest
    const blocks = shown.map((v) => {
      const segs = [...shown.filter((k) => k !== v).map((k) => killed(v, k)), own(v), other(v)].filter(Boolean);
      segs[0]?.classList.add('fb-block');
      return segs;
    });
    const bar = el('div', { class: `fb-bar${total ? '' : ' empty'}` }, ...ends(blocks.flat()), ...(total ? [] : [none]));
    const stats = el('div', { class: 'fb-teams' }, ...shown.map((x) => el('div', { class: `fb-team fb-count-n fb-${x.id}` },
      el('span', { class: `team-dot team-${x.id}` }),
      el('strong', { class: `team-${x.id}`, text: t[x.id].kills.toLocaleString() }),
      el('span', { text: `${x.short} ${plural(t[x.id].kills, 'kill')}` }),
      el('span', { class: 'muted', text: `· ${t[x.id].deaths.toLocaleString()} ${plural(t[x.id].deaths, 'death')}` }))));
    root.replaceChildren(stats, bar, legend);
    attachCellTips(bar, '.fb-seg', (s) => s.tipRows);
  }
  redraws.set(root, renderFactionBar);
}

/* kills and deaths over time */

// What a death can be, for the chart: a kill by one of the teams, or anything else.
// Without factions (an earlier season) it's kills by players and everything else.
function combatSeries() {
  if (!roster.size) {
    return [
      { key: 'pvp', label: 'Killed by a player', color: 'var(--series-1)', is: (d) => !!d.killer },
      { key: 'other', label: 'Other deaths', color: 'var(--muted)', is: () => true },
    ];
  }
  // a kill by each team the admin page gives a series of its own, and everything else
  const by = (team) => (d) => d.killer && teamAt(d.killer, d.ts) === team && teamAt(d.victim, d.ts) !== team;
  return [
    ...teams.filter((t) => t.chart).map((t) => ({ key: t.id, label: `${t.short} kills`, color: teamVar(t.id), is: by(t.id) })),
    { key: 'other', label: 'Other deaths', color: 'var(--muted)', is: () => true },
  ];
}

function renderCombatChart() {
  const v = combat.view;
  if (!v) return;
  const root = $('#cb-chart');
  const series = combatSeries().map((s) => ({ ...s, vals: v.buckets.map(() => 0) }));
  let i = 0;
  for (const d of v.rows) {
    while (i < v.buckets.length - 1 && d.ts >= v.buckets[i].end) i++;
    if (d.ts < v.buckets[i].start) continue;
    series.find((s) => s.is(d)).vals[i]++;
  }
  const total = combat.chartMode === 'total';
  $('#cb-mode-each').textContent = v.hourly ? 'Per hour' : 'Per day';
  for (const b of $('#cb-chart-mode').children) b.setAttribute('aria-pressed', String(b.dataset.v === combat.chartMode));
  $('#cb-chart-label').textContent = total ? 'adding up · pinch to zoom'
    : v.hourly ? 'each hour' : 'each day';
  $('#cb-legend').replaceChildren(...series.map((s) => el('span', {},
    el('i', { class: `cb-key${total ? ' line' : ''}${s.key === 'other' ? ' other' : ''}`, style: `--c:${s.color}` }), s.label)));
  if (!v.rows.length) {
    redraws.delete(root);
    root.replaceChildren(el('div', { class: 'empty-chart', text: combat.rows.length ? 'No kills or deaths in this range.' : 'No kills or deaths yet this season.' }));
    return;
  }
  if (total) {
    // the running total has a point for every kill and death, and its own zoom (kept while the range stays)
    const from = v.buckets[0].start, to = v.buckets.at(-1).end;
    const events = combatSeries().map((sr) => ({ ...sr, times: [] }));
    for (const d of v.rows) if (d.ts >= from && d.ts < to) events.find((sr) => sr.is(d)).times.push(d.ts);
    for (const sr of events) sr.times.sort((a, b) => a - b);
    const key = `${from}|${to}`;
    if (combat.zoom?.key !== key) combat.zoom = { key, x0: from, x1: to, ymax: null };
    const tspec = { series: events, from, to, start: chartStart() };
    combat.totalSpec = tspec;
    redraws.set(root, () => drawCombatTotal(root, tspec));
    drawCombatTotal(root, tspec);
    return;
  }
  const spec = { buckets: v.buckets, hourly: v.hourly, series, total, start: chartStart() };
  redraws.set(root, () => drawCombatChart(root, spec));
  drawCombatChart(root, spec);
}

// The running total: one stepped line per series that rises at the moment of each kill or death.
// combat.zoom is what's in view: x0..x1 (unix seconds, inside the range) and ymax (null = fitted to
// what's in view). The scale on the left is redrawn in place, so it never moves with the lines.
function drawCombatTotal(root, spec) {
  root.replaceChildren();
  const { series, from, to } = spec;
  const z = combat.zoom;
  const W = Math.max(280, root.clientWidth);
  const H = root.clientHeight || 200;
  const m = { l: 34, r: 10, t: 10, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const { x0, x1 } = z;
  const end = Math.min(to, nowSec()); // the lines stop at now
  // how many of a series' moments are at or before t
  const countAt = (times, t) => {
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const round = (vmax) => { const st = Math.max(1, niceStep(vmax / 4)); return Math.max(st * 2, Math.ceil(vmax / st) * st); };
  const full = round(Math.max(1, ...series.map((sr) => sr.times.length)));
  const fitted = round(Math.max(1, ...series.map((sr) => countAt(sr.times, x1))));
  const ymax = z.ymax ?? fitted;
  const ystep = Math.max(1, niceStep(ymax / 4));
  const x = (t) => m.l + ((t - x0) / (x1 - x0)) * pw;
  const y = (val) => m.t + ph - (val / ymax) * ph;
  root.totalGeom = { l: m.l, pw, full, ymax };

  const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Kills and deaths adding up over time' });
  for (let val = 0; val <= ymax + 1e-9; val += ystep) {
    if (val > 0) svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(val), y2: y(val), class: 'gridline' }));
    const tx = sv('text', { x: m.l - 6, y: y(val) + 4, 'text-anchor': 'end', class: 'axis-text' });
    tx.textContent = String(val);
    svg.append(tx);
  }
  const clipId = `${root.id}-total-clip`;
  const clip = sv('clipPath', { id: clipId });
  clip.append(sv('rect', { x: m.l, y: m.t - 2, width: pw, height: ph + 3 }));
  const plot = sv('g', { 'clip-path': `url(#${clipId})` });
  svg.append(clip, plot);
  if (spec.start && spec.start > x0) noDataBlock(svg, plot, `${root.id}-hatch`, m.l, Math.min(m.l + pw, x(spec.start)), m.t, ph);

  // time labels: the widest-spaced round hours (or days) that still leave each about 80px
  const span = x1 - x0;
  const steps = [1, 2, 3, 6, 12, 24, 48, 168, 336, 720];
  const hours = steps.find((h) => (h * 3600 / span) * pw >= 80) ?? steps.at(-1);
  for (let h = Math.ceil(x0 / 3600) * 3600; h < x1; h += 3600) {
    const info = hourInfo(h);
    if (hours >= 24 ? info.hour !== 0 || Math.round(h / 86400) % (hours / 24) : info.hour % hours) continue;
    const tx = sv('text', { x: x(h), y: H - 6, 'text-anchor': 'middle', class: 'axis-text' });
    tx.textContent = hours >= 24 || info.hour === 0 ? fmt(h, { month: 'short', day: 'numeric' }) : hourName(info.hour, true);
    svg.append(tx);
  }
  svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'baseline' }));

  // "other" underneath, the teams on top; each line holds level until its next kill or death
  const dots = [];
  for (const k of series.map((_, idx) => idx).reverse()) {
    const sr = series[k];
    let n = countAt(sr.times, x0);
    let d = `M${x(Math.max(x0, from))},${y(n)}`;
    for (; n < sr.times.length && sr.times[n] <= x1; n++) d += `H${x(sr.times[n])}V${y(n + 1)}`;
    d += `H${x(Math.min(x1, end))}`;
    plot.append(sv('path', { d, class: `cb-line${sr.key === 'other' ? ' other' : ''}`, style: `stroke:${sr.color}` }));
    dots[k] = sv('circle', { r: 3.5, class: 'cb-dot', style: `fill:${sr.color}`, visibility: 'hidden' });
  }
  const cross = sv('line', { y1: m.t, y2: m.t + ph, class: 'crosshair', visibility: 'hidden' });
  plot.append(cross, ...dots);

  const clear = () => {
    cross.setAttribute('visibility', 'hidden');
    for (const dot of dots) dot.setAttribute('visibility', 'hidden');
    hideTip();
  };
  const move = (e) => {
    const px = e.clientX - svg.getBoundingClientRect().left;
    if (px < m.l || px > m.l + pw) return clear();
    const t = Math.min(end, x0 + ((px - m.l) / pw) * span);
    cross.setAttribute('x1', x(t));
    cross.setAttribute('x2', x(t));
    cross.setAttribute('visibility', 'visible');
    series.forEach((sr, k) => {
      dots[k].setAttribute('cx', x(t));
      dots[k].setAttribute('cy', y(countAt(sr.times, t)));
      dots[k].setAttribute('visibility', 'visible');
    });
    showTip(e.clientX, e.clientY, [
      { label: `By ${fmt(t, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` },
      ...series.map((sr) => ({ value: String(countAt(sr.times, t)), label: sr.label, color: sr.color })),
    ]);
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', clear);
  root.append(svg);
  if (x0 > from || x1 < to || z.ymax != null) {
    const reset = el('button', { type: 'button', class: 'btn cb-reset', text: 'Reset zoom' });
    reset.addEventListener('click', () => { Object.assign(z, { x0: from, x1: to, ymax: null }); drawCombatTotal(root, spec); });
    root.append(reset);
  }
}

// Zooming and moving the running total: a pinch (Ctrl+wheel on a trackpad or mouse, gesture events in
// Safari, two fingers on a touch screen) zooms the time around the pointer; over the scale on the left,
// or with Shift held, it stretches the height instead (from zero, so the lower lines grow). Scrolling
// sideways moves along. Two fingers on a touch screen do both at once: spread sideways for time,
// up and down for height.
(() => {
  const root = $('#cb-chart');
  const on = () => combat.chartMode === 'total' && combat.zoom && combat.totalSpec && root.totalGeom && root.querySelector('svg');
  let frame = 0;
  const redraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (on()) drawCombatTotal(root, combat.totalSpec); }); };
  const MIN = 10 * 60;
  const zoomX = (factor, clientX) => {
    const z = combat.zoom, { from, to } = combat.totalSpec, g = root.totalGeom;
    const f = Math.min(1, Math.max(0, (clientX - root.getBoundingClientRect().left - g.l) / g.pw));
    const span = Math.min(to - from, Math.max(MIN, (z.x1 - z.x0) * factor));
    let a = z.x0 + f * (z.x1 - z.x0) - f * span;
    a = Math.min(to - span, Math.max(from, a));
    z.x0 = a;
    z.x1 = a + span;
    redraw();
  };
  const zoomY = (factor) => {
    const z = combat.zoom, g = root.totalGeom;
    const next = Math.max(4, (z.ymax ?? g.ymax) * factor);
    z.ymax = next >= g.full ? null : next; // all the way out: fitted again
    g.ymax = z.ymax ?? g.ymax;
    redraw();
  };
  const pan = (px) => {
    const z = combat.zoom, { from, to } = combat.totalSpec, g = root.totalGeom;
    const span = z.x1 - z.x0;
    const a = Math.min(to - span, Math.max(from, z.x0 + (px / g.pw) * span));
    z.x0 = a;
    z.x1 = a + span;
    redraw();
  };
  const overScale = (e) => e.clientX - root.getBoundingClientRect().left < root.totalGeom.l;
  root.addEventListener('wheel', (e) => {
    if (!on()) return;
    const sideways = !e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (!e.ctrlKey && !sideways) return; // an ordinary scroll of the page
    e.preventDefault();
    hideTip();
    if (sideways) return pan(e.deltaX);
    const factor = Math.exp(Math.max(-50, Math.min(50, e.deltaY)) * 0.01);
    if (e.shiftKey || overScale(e)) zoomY(factor); else zoomX(factor, e.clientX);
  }, { passive: false });
  let last = 1;
  root.addEventListener('gesturestart', (e) => { if (on()) { e.preventDefault(); last = 1; } });
  root.addEventListener('gesturechange', (e) => {
    if (!on()) return;
    e.preventDefault();
    const factor = last / e.scale;
    last = e.scale;
    if (e.shiftKey || overScale(e)) zoomY(factor); else zoomX(factor, e.clientX);
  });
  let touch = null;
  const spread = (t) => ({ dx: Math.abs(t[0].clientX - t[1].clientX), dy: Math.abs(t[0].clientY - t[1].clientY), cx: (t[0].clientX + t[1].clientX) / 2 });
  root.addEventListener('touchstart', (e) => { touch = e.touches.length === 2 && on() ? spread(e.touches) : null; }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    if (!touch || e.touches.length !== 2 || !on()) return;
    e.preventDefault();
    const now = spread(e.touches);
    // each direction counts once the fingers are far enough apart that way to mean it
    if (touch.dx > 40 && now.dx > 40) zoomX(touch.dx / now.dx, now.cx);
    if (touch.dy > 40 && now.dy > 40) zoomY(touch.dy / now.dy);
    pan(touch.cx - now.cx);
    touch = now;
  }, { passive: false });
  root.addEventListener('touchend', () => { touch = null; });
})();

// Stacked bars per hour or day, or (total) one rising line per series.
function drawCombatChart(root, spec) {
  root.replaceChildren();
  const { buckets, series, total, hourly } = spec;
  const n = buckets.length;
  const W = Math.max(280, root.clientWidth);
  const H = root.clientHeight || 200;
  const m = { l: 30, r: total ? 10 : 4, t: 10, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const slot = pw / n;
  const from = buckets[0].start, to = buckets[n - 1].end;

  // running totals per series, or the height of each bucket's stack
  const sums = series.map((s) => { let acc = 0; return s.vals.map((x) => (acc += x)); });
  const vmax = total ? Math.max(1, ...sums.map((a) => a[n - 1])) : Math.max(1, ...buckets.map((_, i) => series.reduce((a, s) => a + s.vals[i], 0)));
  const ystep = Math.max(1, niceStep(vmax / 4));
  const ymax = Math.max(ystep * 2, Math.ceil(vmax / ystep) * ystep);
  const y = (val) => m.t + ph - (val / ymax) * ph;
  const xAt = (t) => {
    if (t <= from) return m.l;
    if (t >= to) return m.l + pw;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (buckets[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    return m.l + slot * (lo + (t - buckets[lo].start) / (buckets[lo].end - buckets[lo].start));
  };

  const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Kills and deaths over time' });
  for (let val = 0; val <= ymax + 1e-9; val += ystep) {
    if (val > 0) svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(val), y2: y(val), class: 'gridline' }));
    const tx = sv('text', { x: m.l - 6, y: y(val) + 4, 'text-anchor': 'end', class: 'axis-text' });
    tx.textContent = String(val);
    svg.append(tx);
  }
  const firstBar = spec.start && (buckets.find((bk) => spec.start < bk.end)?.start ?? spec.start);
  if (spec.start && firstBar > from) noDataBlock(svg, svg, `${root.id}-hatch`, m.l, xAt(firstBar), m.t, ph);

  const labelEvery = hourly
    ? (slot >= 36 ? 1 : slot >= 18 ? 2 : slot >= 12 ? 3 : 6)
    : (slot >= 44 ? 1 : slot >= 22 ? 2 : slot >= 14 ? 3 : slot >= 7 ? 7 : 14);
  const gap = slot >= 8 ? 2 * Math.max(2, slot * 0.15) : slot * 0.3;
  const bw = Math.min(40, slot - gap);
  const stacks = [];
  buckets.forEach((b, i) => {
    const cx = m.l + slot * (i + 0.5);
    if (!total) {
      const g = sv('g', { class: 'cb-stack' });
      let acc = 0;
      const live = series.filter((s) => s.vals[i] > 0);
      live.forEach((s, k) => {
        const y1 = y(acc), y0 = y(acc + s.vals[i]);
        acc += s.vals[i];
        const x0 = cx - bw / 2, x1 = cx + bw / 2;
        const top = k === live.length - 1;
        const r = top ? Math.min(3, (y1 - y0) / 2, bw / 2) : 0;
        g.append(sv('path', {
          d: `M${x0},${y1 - (k ? 1 : 0)}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x1 - r}Q${x1},${y0} ${x1},${y0 + r}V${y1 - (k ? 1 : 0)}Z`,
          style: `fill:${s.color}`, class: s.key === 'other' ? 'cb-other' : '',
        }));
      });
      svg.append(g);
      stacks[i] = g;
    }
    if ((n - 1 - i) % labelEvery === 0) {
      const tx = sv('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'axis-text' });
      if (hourly) tx.textContent = hourName(hourInfo(b.start).hour, true);
      else {
        const day = Number(b.date.slice(8));
        tx.textContent = b.date === todayStr() && !archived() ? 'Today'
          : day === 1 || slot >= 44 || i < labelEvery || labelEvery >= 7 ? fmtDay(b.date, { month: 'short', day: 'numeric' })
          : String(day);
      }
      svg.append(tx);
    }
  });
  svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'baseline' }));

  let cross = null;
  const dots = [];
  if (total) {
    // "other" underneath, the factions on top
    for (const k of series.map((_, idx) => idx).reverse()) {
      const s = series[k];
      let d = `M${m.l},${y(0)}`;
      sums[k].forEach((val, i) => { d += `L${m.l + slot * (i + 1)},${y(val)}`; });
      svg.append(sv('path', { d, class: `cb-line${s.key === 'other' ? ' other' : ''}`, style: `stroke:${s.color}` }));
      const dot = sv('circle', { r: 3.5, class: 'cb-dot', style: `fill:${s.color}`, visibility: 'hidden' });
      dots[k] = dot;
    }
    cross = sv('line', { y1: m.t, y2: m.t + ph, class: 'crosshair', visibility: 'hidden' });
    svg.append(cross, ...dots.filter(Boolean));
  }

  const when = (b) => (hourly
    ? `${fmt(b.start, { weekday: 'short', month: 'short', day: 'numeric' })}, ${hourName(hourInfo(b.start).hour)}–${hourName(hourInfo(b.end).hour)}`
    : fmtDay(b.date));
  let hovered = null;
  const clear = () => {
    hovered?.classList.remove('hover');
    hovered = null;
    cross?.setAttribute('visibility', 'hidden');
    for (const d of dots) d?.setAttribute('visibility', 'hidden');
    hideTip();
  };
  const move = (e) => {
    const px = e.clientX - svg.getBoundingClientRect().left;
    if (px < m.l || px > m.l + pw) return clear();
    const i = Math.min(n - 1, Math.max(0, Math.floor((px - m.l) / slot)));
    const b = buckets[i];
    if (total) {
      const x = m.l + slot * (i + 1);
      cross.setAttribute('x1', x);
      cross.setAttribute('x2', x);
      cross.setAttribute('visibility', 'visible');
      dots.forEach((d, k) => {
        d.setAttribute('cx', x);
        d.setAttribute('cy', y(sums[k][i]));
        d.setAttribute('visibility', 'visible');
      });
    } else if (hovered !== stacks[i]) {
      hovered?.classList.remove('hover');
      hovered = stacks[i] || null;
      hovered?.classList.add('hover');
    }
    showTip(e.clientX, e.clientY, [
      { label: total ? `By the end of ${hourly ? hourName(hourInfo(b.start).hour) : fmtDay(b.date, { weekday: 'short', month: 'short', day: 'numeric' })}` : when(b) },
      ...series.map((s, k) => ({ value: String(total ? sums[k][i] : s.vals[i]), label: s.label, color: s.color })),
    ]);
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', clear);
  root.append(svg);
}

/* the leaderboard: click a column heading to sort by it */

const COMBAT_COLS = [
  { key: 'name', label: 'Player', first: 1, hint: 'Sort by name' },
  { key: 'kills', label: 'Kills', first: -1, hint: 'Players they killed' },
  { key: 'deaths', label: 'Deaths', first: -1, hint: 'Every time they died, to a player or not' },
  { key: 'kd', label: 'K/D', first: -1, hint: 'Kills for every death' },
];

function sortCombat(players) {
  const { key, dir } = combat.sort;
  const byName = (a, b) => shownName(a.name).localeCompare(shownName(b.name), undefined, { sensitivity: 'base' });
  return players.sort((a, b) => {
    if (key === 'name') return dir * byName(a, b);
    // players with no kills or deaths go last whichever way it's sorted
    const quietA = a.kills + a.deaths === 0, quietB = b.kills + b.deaths === 0;
    if (quietA !== quietB) return quietA ? 1 : -1;
    return dir * (a[key] - b[key]) || b.kills - a.kills || a.deaths - b.deaths || byName(a, b);
  });
}

function sortArrow(dir) {
  const s = sv('svg', { width: 10, height: 12, viewBox: '0 0 10 12', 'aria-hidden': 'true', class: 'sort-arrow' });
  s.append(sv('path', { d: 'M2 4.5 5 1.5l3 3', class: dir > 0 ? 'on' : '' }), sv('path', { d: 'M2 7.5l3 3 3-3', class: dir < 0 ? 'on' : '' }));
  return s;
}

function renderCombatLeaderboard() {
  const v = combat.view;
  if (!v) return;
  const root = $('#cb-leaderboard');
  const players = sortCombat(combatPlayers(v.rows));
  const { key, dir } = combat.sort;
  const active = players.filter((p) => p.kills + p.deaths > 0).length;
  $('#cb-lb-note').textContent = players.length
    ? `${active} of ${players.length} ${players.length === 1 ? 'player has' : 'players have'} a kill or death · sorted by ${key === 'kd' ? 'K/D' : COMBAT_COLS.find((c) => c.key === key).label.toLowerCase()}`
    : '';
  if (!players.length) {
    root.replaceChildren(el('div', { class: 'empty', text: 'No kills or deaths in this range yet.' }));
    return;
  }
  const oldTops = rowTops(root);
  // the bar under each name is the column it's sorted by
  const barKey = key === 'name' ? 'kills' : key;
  const top = Math.max(...players.map((p) => p[barKey]), 0) || 1;

  const head = el('tr', {}, el('th', {}));
  for (const c of COMBAT_COLS) {
    const on = c.key === key;
    const btn = el('button', { type: 'button', title: on ? `${c.hint} (click to reverse)` : c.hint }, el('span', { text: c.label }), sortArrow(on ? dir : 0));
    btn.addEventListener('click', () => {
      combat.sort = on ? { key, dir: -dir } : { key: c.key, dir: c.first };
      remember('combatSort', `${combat.sort.key}:${combat.sort.dir}`);
      renderCombatLeaderboard();
    });
    head.append(el('th', { class: `sortable${c.key === 'name' ? '' : ' num'}${on ? ' sorted' : ''}`, 'aria-sort': on ? (dir < 0 ? 'descending' : 'ascending') : 'none' }, btn));
  }

  const tbody = el('tbody');
  players.forEach((p, i) => {
    const uuid = combatUuid(p.name);
    const team = teamOf(p.name);
    const quiet = p.kills + p.deaths === 0;
    const link = teamName(playerLink(el('a', { text: shownName(p.name) }), uuid, p.name), p.name);
    delete link.dataset.card; // a click goes straight to their page, like the activity leaderboard
    const cell = (k, text, title) => el('td', { class: `num${k === key ? ' sorted' : ''}${quiet || text === '0' ? ' zero' : ''}`, text, ...(title && { title }) });
    const tr = el('tr', { class: `${uuid ? 'link' : ''}${quiet ? ' quiet' : ''}`, 'data-uuid': p.key },
      el('td', { class: 'rank', text: String(i + 1) }),
      el('td', { class: key === 'name' ? 'sorted' : '' },
        el('div', { class: 'pname' }, headImg(p.name, 22), link),
        el('div', { class: `bar${barKey === 'deaths' ? ' bar-deaths' : team ? ` team-${team}` : ''}`, style: `width:${quiet ? 0 : Math.max(1, (p[barKey] / top) * 100)}%` })),
      cell('kills', p.kills.toLocaleString()),
      cell('deaths', p.deaths.toLocaleString(), p.deaths ? `${p.pvpDeaths} by players · ${p.deaths - p.pvpDeaths} other` : null),
      cell('kd', fmtKd(p), quiet ? null : `${p.kills} ${p.kills === 1 ? 'kill' : 'kills'} ÷ ${p.deaths} ${p.deaths === 1 ? 'death' : 'deaths'}`));
    if (uuid) {
      tr.addEventListener('click', (e) => { if (e.target !== link) location.hash = `#/player/${uuid}`; });
      tr.addEventListener('pointerenter', () => prefetchPlayer(uuid));
    }
    tbody.append(tr);
  });
  root.replaceChildren(el('table', { class: 'cb-table' }, el('thead', {}, head), tbody));
  moveRows(root, oldTops);
}

/* the death log: every death message, oldest at the top and newest at the bottom, like the chat log */

const deathLog = {
  items: [], // newest first, as /api/combat/log gives them (drawn the other way up)
  more: false,
  busy: false,
  loaded: false,
  type: ['pvp', 'other'].includes(recall('deathLogType')) ? recall('deathLogType') : '',
  req: 0,
};
const DEATH_PAGE = 40;

// One death, as the game worded it: every name is a link in its own colors.
function deathRow(m, { when = clock(m.ts / 1000) } = {}) {
  const team = m.killer ? teamAt(m.killer, m.ts / 1000) : null;
  const text = el('div', { class: 'dl-text' });
  if (m.rich) text.append(...richText(m));
  else text.append(noTag(m.text));
  if (m.attr_note && m.killer) text.append(byNote(m.killer));
  const time = el('button', { type: 'button', class: 'dl-time', text: when,
    title: `${fmt(m.ts / 1000, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · open the chat log here` });
  time.addEventListener('click', () => {
    chat.pendingJump = { id: m.id, ts: m.ts };
    location.hash = '#/chat';
  });
  return el('div', { class: `dl-row${m.killer ? ' pvp' : ''}${team ? ` by-${team}` : ''}`, 'data-chat-id': m.id, 'data-death': '1' },
    el('span', { class: 'dl-icon', title: m.killer ? 'Killed by a player' : naturalCause(m) }, icon(m.killer ? SWORD_ICON : SYS_ICONS.death, 14)),
    text, time);
}

const deathDay = (d) => el('div', { class: 'chat-day dl-day', role: 'separator', 'data-day': d },
  el('span', { text: relativeDay(d, { weekday: 'short', month: 'short', day: 'numeric' }) }));
const deathDayBadge = dayBadge($('#dl-scroll'));

function renderDeathLog(fresh = new Set()) {
  const frag = document.createDocumentFragment();
  let day = null;
  for (const m of deathLog.items.toReversed()) {
    const d = hourInfo(m.ts / 1000).date;
    if (d !== day) {
      frag.append(deathDay(d));
      day = d;
    }
    const row = deathRow(m);
    if (fresh.has(m.id)) row.classList.add('msg-new');
    frag.append(row);
  }
  $('#dl-list').replaceChildren(frag);
  const edge = $('#dl-edge');
  if (!deathLog.loaded) edge.replaceChildren(el('div', { class: 'chat-note loading', text: 'Loading deaths…' }));
  else if (!deathLog.items.length) {
    edge.replaceChildren(el('div', { class: 'chat-empty' },
      el('strong', { text: deathLog.type === 'pvp' ? 'No kills yet' : 'No deaths yet' }),
      el('div', { text: deathLog.type ? 'Nothing of this kind has been logged this season.' : 'Deaths show up here as the server logs them.' })));
  } else if (deathLog.busy) edge.replaceChildren(el('div', { class: 'chat-note loading', text: 'Loading older deaths…' }));
  else if (!deathLog.more) edge.replaceChildren(el('div', { class: 'chat-note', text: 'This is the first death of the season.' }));
  else edge.replaceChildren();
  for (const b of $('#dl-type').children) b.setAttribute('aria-pressed', String(b.dataset.v === deathLog.type));
  deathDayBadge.update();
}

const deathLogEnd = () => { const s = $('#dl-scroll'); s.scrollTop = s.scrollHeight; };
const deathLogPath = (extra) => `/api/combat/log?limit=${DEATH_PAGE}${deathLog.type ? `&type=${deathLog.type}` : ''}${extra}`;

// The latest page (or again after the filter changes), opened at the bottom, on the newest death.
async function loadDeathLog() {
  const req = ++deathLog.req;
  deathLog.busy = true;
  try {
    const res = await api(deathLogPath(''));
    if (req !== deathLog.req) return;
    deathLog.items = res.results;
    deathLog.more = res.more;
    deathLog.loaded = true;
  } finally {
    if (req === deathLog.req) {
      deathLog.busy = false;
      renderDeathLog();
      deathLogEnd();
    }
  }
}

// Scrolling up to the top loads older deaths above, without moving what's on screen.
async function loadOlderDeaths() {
  if (deathLog.busy || !deathLog.more || !deathLog.items.length) return;
  const req = deathLog.req;
  const last = deathLog.items.at(-1);
  deathLog.busy = true;
  renderDeathLog();
  try {
    const res = await api(deathLogPath(`&before=${last.ts}:${last.id}`));
    if (req !== deathLog.req) return;
    const have = new Set(deathLog.items.map((m) => m.id));
    deathLog.items = deathLog.items.concat(res.results.filter((m) => !have.has(m.id)));
    deathLog.more = res.more;
  } finally {
    if (req === deathLog.req) {
      const scroll = $('#dl-scroll');
      const fromEnd = scroll.scrollHeight - scroll.scrollTop;
      deathLog.busy = false;
      renderDeathLog();
      scroll.scrollTop = scroll.scrollHeight - fromEnd;
    }
  }
}

// New deaths since the latest one slide in under it; the log follows them if it was at the bottom.
async function refreshDeathLog() {
  if (!deathLog.loaded || deathLog.busy) return;
  if (!deathLog.items.length) return loadDeathLog();
  const req = deathLog.req;
  const first = deathLog.items[0];
  const res = await api(deathLogPath(`&after=${first.ts}:${first.id}`));
  if (req !== deathLog.req || !res.results.length) return;
  if (res.more) return loadDeathLog(); // more new ones than a page: start over from the latest
  const have = new Set(deathLog.items.map((m) => m.id));
  const fresh = res.results.filter((m) => !have.has(m.id));
  if (!fresh.length) return;
  const scroll = $('#dl-scroll');
  const atEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
  deathLog.items = fresh.concat(deathLog.items);
  renderDeathLog(new Set(fresh.map((m) => m.id)));
  if (atEnd) deathLogEnd(); // reading further up: stay put
}

$('#dl-scroll').addEventListener('scroll', () => {
  const s = $('#dl-scroll');
  if (s.scrollTop < 300) loadOlderDeaths().catch((e) => showError(e.message));
}, { passive: true });
$('#dl-type').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === deathLog.type) return;
  deathLog.type = b.dataset.v;
  remember('deathLogType', deathLog.type);
  deathLog.items = [];
  deathLog.loaded = false;
  renderDeathLog();
  loadDeathLog().catch((err) => showError(err.message));
});

// The log can be folded away (remembered); the rest of the page then takes the full width.
function setDeathLogOpen(open) {
  $('#combat').classList.toggle('log-closed', !open);
  $('#dl-open').hidden = open;
  remember('deathLog', open ? 'open' : 'closed');
  fitDeathLog();
  if (open) deathLogEnd();
  // the charts were measured at the other width
  for (const [root, redraw] of redraws) if (root.isConnected && root.offsetParent) redraw();
}
$('#dl-close').addEventListener('click', () => setDeathLogOpen(false));
$('#dl-open').addEventListener('click', () => {
  setDeathLogOpen(true);
  if (matchMedia('(max-width: 900px)').matches) $('#death-log').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
});

// Beside the page, the log is as tall as the window allows and stays in view while the page scrolls.
function fitDeathLog() {
  const log = $('#death-log');
  if ($('#view-combat').hidden) return;
  if (matchMedia('(max-width: 900px)').matches) {
    log.style.height = '';
    return;
  }
  const top = Math.max(12, $('#combat').getBoundingClientRect().top);
  log.style.height = `${Math.max(320, window.innerHeight - top - 12)}px`;
}
let fitQueued = false;
const queueFit = () => {
  if (fitQueued || $('#view-combat').hidden) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitDeathLog(); });
};
window.addEventListener('scroll', queueFit, { passive: true });
window.addEventListener('resize', queueFit);

function renderCombat() {
  const w = cbCtl.get();
  combat.view = combatView();
  cbCtl.sync();
  $('#cb-label').textContent = w.unit === 'all' ? (archived() ? 'The whole season' : 'All time') : windowLabel(w, combat.view, COMBAT_PRESETS);
  renderFactionBar();
  renderCombatChart();
  renderCombatLeaderboard();
}

async function showCombat({ refresh = false } = {}) {
  showView('combat');
  document.title = `Combat · ${SITE}`;
  await loadStatus();
  fitDeathLog();
  const first = !deathLog.loaded;
  if (first) renderDeathLog();
  await Promise.all([
    loadCombat().then(renderCombat),
    (first ? loadDeathLog() : refresh ? refreshDeathLog() : null),
  ]);
  fitDeathLog();
  if (!refresh) deathLogEnd(); // opening the page always lands on the newest death
}

/* a player's combat card */

async function renderPlayerCombat(name) {
  const root = $('#p-combat');
  const mine = (state.playerCombatReq = (state.playerCombatReq || 0) + 1);
  if (!combat.loaded) root.replaceChildren(el('div', { class: 'empty', text: 'Loading…' }));
  const [, log] = await Promise.all([
    loadCombat(),
    api(`/api/combat/log?player=${encodeURIComponent(name)}&limit=30`).catch(() => null),
  ]);
  if (mine !== state.playerCombatReq || state.playerData?.name !== name) return;
  const is = (n) => n && n.toLowerCase() === name.toLowerCase();
  const kills = combat.rows.filter((d) => is(d.killer));
  const deaths = combat.rows.filter((d) => is(d.victim));
  const me = { kills: kills.length, deaths: deaths.length, kd: kills.length / Math.max(1, deaths.length) };
  $('#pcb-sub').textContent = archived() ? 'the whole season' : 'this season';

  // where they stand among everyone with a kill or a death
  const everyone = combatPlayers(combat.rows).filter((p) => p.kills + p.deaths > 0);
  const rank = (key) => {
    if (!me[key] || everyone.length < 2) return '';
    return `#${1 + everyone.filter((p) => p[key] > me[key]).length} of ${everyone.length}`;
  };
  const stat = (label, value, sub, cls = '') => el('div', { class: `pcb-stat ${cls}` },
    el('div', { class: 'pcb-label', text: label }), el('div', { class: 'pcb-value', text: value }), el('div', { class: 'pcb-sub', text: sub }));
  const pvpDeaths = deaths.filter((d) => d.killer).length;
  const stats = el('div', { class: 'pcb-stats' },
    stat('Kills', me.kills.toLocaleString(), rank('kills'), 'kills'),
    stat('Deaths', me.deaths.toLocaleString(), me.deaths ? `${pvpDeaths} PvP · ${me.deaths - pvpDeaths} other` : "", "deaths"),
    stat('K/D', fmtKd(me), rank('kd')));

  if (!me.kills && !me.deaths) {
    root.replaceChildren(stats, el('div', { class: 'empty', text: 'No kills or deaths logged for them this season.' }));
    return;
  }

  // who they kill, who kills them, and what else does
  const tally = (list, keyOf) => {
    const counts = new Map();
    for (const d of list) {
      const k = keyOf(d);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  };
  const person = ([who, n]) => {
    const a = teamName(playerLink(el('a', { class: 'pcb-who' }, headImg(who, 16, { width: 16, height: 16 }), el('span', { text: shownName(who) })), combatUuid(who), who), who);
    return el('li', {}, a, el('span', { class: 'pcb-n', text: `×${n}` }));
  };
  const thing = ([what, n]) => el('li', {}, el('span', { class: 'pcb-who', text: what }), el('span', { class: 'pcb-n', text: `×${n}` }));
  const list = (title, items, render, none) => el('div', { class: 'pcb-list' }, el('h3', { text: title }),
    items.length ? el('ul', { class: 'pcb-scroll', tabindex: '0' }, ...items.map(render)) : el('div', { class: 'muted pcb-none', text: none }));
  const lists = el('div', { class: 'pcb-lists' },
    list('Killed most', tally(kills, (d) => d.victim), person, 'No kills yet'),
    list('Killed by most', tally(deaths.filter((d) => d.killer), (d) => d.killer), person, 'Never killed by a player'),
    list('Other deaths', tally(deaths.filter((d) => !d.killer), naturalCause), thing, 'None'));

  // Their latest kills and deaths, like the chat log: the newest at the bottom, the time of each, a
  // line where the day changes, and older ones loading above as the top comes into view.
  const recent = el('div', { class: 'pcb-recent' }, el('h3', { text: 'Latest kills and deaths' }));
  let box = null;
  if (log?.results.length) {
    box = el('div', { class: 'pcb-scroll pcb-log', tabindex: '0', role: 'log', 'aria-label': 'Their kills and deaths, newest at the bottom' });
    const list = el('div');
    box.append(list);
    const badge = dayBadge(box);
    let items = log.results, more = log.more, loading = false; // newest first, as they come
    const draw = () => {
      const frag = document.createDocumentFragment();
      if (!more) frag.append(el('div', { class: 'chat-note pcb-log-start', text: 'Their first kill or death of the season.' }));
      let day = null;
      for (const m of items.toReversed()) {
        const d = hourInfo(m.ts / 1000).date;
        if (d !== day) { frag.append(deathDay(d)); day = d; }
        const row = deathRow(m);
        row.classList.add(is(m.killer) ? 'is-kill' : 'is-death');
        row.querySelector('.dl-icon').title = is(m.killer) ? 'Their kill' : 'Their death';
        frag.append(row);
      }
      list.replaceChildren(frag);
      badge.update();
    };
    draw();
    box.addEventListener('scroll', async () => {
      if (!more || loading || box.scrollTop > 80) return;
      loading = true;
      try {
        const last = items.at(-1);
        const next = await api(`/api/combat/log?player=${encodeURIComponent(name)}&limit=50&before=${last.ts}:${last.id}`);
        const have = new Set(items.map((m) => m.id));
        items = items.concat(next.results.filter((m) => !have.has(m.id)));
        more = next.more;
        const fromEnd = box.scrollHeight - box.scrollTop; // what's on screen stays where it is
        draw();
        box.scrollTop = box.scrollHeight - fromEnd;
      } catch { /* try again on the next scroll */ } finally { loading = false; }
    }, { passive: true });
    recent.append(box);
  } else recent.append(el('div', { class: 'muted pcb-none', text: log ? 'None yet' : 'Couldn’t load the latest ones.' }));
  root.replaceChildren(stats, lists, recent);
  if (box) box.scrollTop = box.scrollHeight; // opened on the newest
}

/* ---------- the IGN / Name switch: redraw names where they're showing ---------- */

function rerenderNames() {
  closeTip();
  closeCard();
  if (!$('#view-home').hidden && state.status) {
    renderOnlineChips();
    loadLeaderboard().catch((e) => showError(e.message));
  } else if (!$('#view-player').hidden) {
    renderPlayerName();
    if (state.playerData) renderPlayerCombat(state.playerData.name).catch(() => {});
  } else if (!$('#view-combat').hidden && combat.loaded) {
    renderCombat();
    renderDeathLog();
  } else if (!$('#view-chat').hidden && chat.loaded) {
    const anchor = chatAnchor();
    renderChat();
    restoreAnchor(anchor);
    renderOnlineThen(true);
    renderComposer();
    renderChatOnline();
  }
}

syncNameToggle();

/* ---------- admin: the admin page, and right-click on chat and deaths ---------- */

// Whether the signed-in email is an admin (the ADMIN_EMAIL secret). /api/me needs no database.
// What the signed-in email may do (src/roles.js): admin (the admin page), super (it can also set
// everyone's permissions, on Admin → Roles) and perms (view, chat, admin, liveview, liveview_op).
// /api/me needs no database.
const site = { admin: false, super: false, perms: null };
function setMe(r) {
  site.admin = !!r?.admin;
  site.super = !!r?.super;
  site.perms = r?.perms ?? null;
  site.modUpdate = site.admin ? r?.mod_update ?? null : null;
  syncLiveTab();
  renderModUpdate();
  $('#adm-tab-roles').hidden = !site.super;
  // someone a super admin has switched "view" off for: every other request is refused, so say why
  if (site.perms && !site.perms.view) showError(`This account (${r.email}) doesn’t have access to the dashboard. Ask an admin to allow it.`);
}

// The server mod's download, as on /mod: a Minecraft version and a mod version to pick (public/ui.js).
function modPicker(downloads, { suggested = null, latest = null } = {}) {
  return window.mcstatsUI.modDownload(downloads, { suggested, latest });
}

// A newer version of the server's mod (src/modupdate.js), on every page for admins. An ordinary one can be
// put away until the next version comes out (remembered in this browser only); an urgent one stays.
const MOD_SEEN_KEY = 'mcstats:mod-update-seen';
function renderModUpdate() {
  const box = $('#mod-update');
  const u = site.modUpdate;
  let seen = null;
  try { seen = localStorage.getItem(MOD_SEEN_KEY); } catch {}
  if (!box || !u || (!u.urgent && seen === u.latest)) {
    if (box) box.hidden = true;
    return;
  }
  box.classList.toggle('mod-update-urgent', !!u.urgent);
  const later = el('button', { type: 'button', class: 'mod-update-later', text: 'Not now' });
  later.addEventListener('click', () => {
    try { localStorage.setItem(MOD_SEEN_KEY, u.latest); } catch {}
    box.hidden = true;
  });
  box.replaceChildren(
    el('strong', { text: u.urgent ? 'Urgent mod update. ' : 'Mod update available. ' }),
    `The server runs mcstats ${u.current}; ${u.latest} is out${u.behind > 1 ? ` (${u.behind} releases newer)` : ''}`
      + (u.urgent ? ' and fixes something serious, so update it soon. ' : '. '),
    el('a', { href: '#/admin/mod', text: 'See what changed' }),
    ...(u.jar_url ? [' · ', el('a', { href: u.jar_url, download: u.jar || '', text: `Download ${u.latest}` })] : []),
    ...(u.urgent ? [] : [' · ', later]));
  box.hidden = false;
}

if (!DUMMY) {
  api('/api/me').then((r) => {
    setMe(r);
    if (site.admin && state.status) renderLive();
  }).catch(() => {});
}

/* ---------- liveview: admins watching the world live ---------- */

// The Liveview tab is only there for admins. The page itself is public/liveview.js (the 3D view, its
// connection and its keys), loaded the first time the tab is opened, like the 3D player model.
function syncLiveTab() {
  $('#tab-live').hidden = !site.perms?.liveview;
  $('#tab-admin').hidden = !site.admin;
}
const onLive = () => location.hash === '#/live' || location.hash.startsWith('#/live/');
let liveLoad = null;
let liveMod = null;
async function showLive() {
  showView('live');
  document.title = `Liveview · ${SITE}`;
  if (!site.perms) {
    // the check may still be on its way
    const r = DUMMY ? null : await api('/api/me').catch(() => null);
    if (r) setMe(r);
  }
  const say = (title, text) => { $('#lv-gate-title').textContent = title; $('#lv-gate-text').textContent = text; };
  if (!site.perms?.liveview) {
    say('This account can’t use Liveview', DUMMY ? 'It isn’t part of the sample data.' : 'A super admin can allow it under Admin, then Roles.');
    return;
  }
  if (!state.status) loadStatus().catch(() => {}); // the pill at the top of every page
  liveLoad ??= import('/liveview.js');
  try {
    liveMod = await liveLoad;
  } catch (err) {
    console.error(err);
    liveLoad = null;
    say('Liveview didn’t load', 'The page’s code couldn’t be fetched. Check the connection and open the tab again.');
    return;
  }
  if (onLive()) liveMod.show();
}

async function adminPost(body) {
  const res = await fetch(`/api/admin?season=${SEASON}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (res.status === 503 && out.error === 'db_limit') throw new DbLimitError(dbLimitMessage(out.resets_at));
  if (!res.ok) throw new Error(out.error || `failed (${res.status})`);
  return out;
}

// A short note at the bottom of the window.
function toast(text, { error = false, ms = 3000 } = {}) {
  const t = el('div', { class: `toast${error ? ' toast-error' : ''}`, role: 'status', text });
  document.body.append(t);
  setTimeout(() => t.classList.add('toast-out'), ms - 400);
  setTimeout(() => t.remove(), ms);
}

// The season's settings (teams, the roster with each player's real name, their teams over time, the emails
// they chat from the website with, hidden players, merged accounts) are edited as a draft: nothing changes
// on the server until Save is pressed, and Reset puts the draft back to what's saved. The same goes for
// Admin → Layout and Server (srv below); one Save bar at the bottom of the admin page saves them all. The
// rest of the page (restoring a message, counting a death again, filling gaps, testing the link) acts at once.
const admin = {
  data: null, // as the server has it
  loadedAt: 0,
  draft: null, // { teams, roster, history, hidden, aliases, emails } as edited here
  busy: false,
  tab: 'players', // the admin section showing (ADMIN_SECTIONS)
  pick: null, // Players: the lowercased name being edited
  pf: { q: '', show: 'all' }, // Players: the list's search and filter
  stale: false, // the draft changed without the page being redrawn (typing in a field)
};

const admCopy = (v) => JSON.parse(JSON.stringify(v));
function adminDraftFrom(d) {
  return {
    teams: admCopy(d.teams || []),
    roster: admCopy(d.roster).map((r) => ({ ...r, name: r.name || '' })),
    history: admCopy(d.history || []),
    hidden: admCopy(d.hidden),
    aliases: admCopy(d.aliases),
    emails: admCopy(d.emails || []),
  };
}

// What Save would change, part by part: { teams: [text, …], roster, history, hidden, aliases, emails }.
// A part with nothing listed is left alone when saving.
function adminChanges() {
  const base = admin.data, draft = admin.draft;
  const out = { teams: [], roster: [], history: [], hidden: [], aliases: [], emails: [] };
  if (!base || !draft) return out;
  const lower = (v) => v.toLowerCase();
  const tName = (id) => draft.teams.find((t) => t.id === id)?.name || (base.teams || []).find((t) => t.id === id)?.name || id || 'no team';

  // teams
  const baseTeams = base.teams || [];
  for (const t of draft.teams) {
    const was = baseTeams.find((x) => x.id === t.id);
    if (!was) { out.teams.push(`New team: ${t.name}`); continue; }
    const what = [];
    if (was.name !== t.name) what.push('name');
    if (was.short !== t.short) what.push('short name');
    if (was.color.toLowerCase() !== t.color.toLowerCase()) what.push('color');
    if (was.bar !== t.bar || was.middle !== t.middle) what.push('scoreboard');
    if (was.chart !== t.chart) what.push('kills chart');
    if (was.activity !== t.activity || (was.activity_with || null) !== (t.activity_with || null)) what.push('activity charts');
    if (what.length) out.teams.push(`${t.name}: ${what.join(', ')}`);
  }
  for (const t of baseTeams) if (!draft.teams.some((x) => x.id === t.id)) out.teams.push(`Remove the team ${t.name}`);
  const kept = (list, other) => list.filter((t) => other.some((x) => x.id === t.id)).map((t) => t.id).join(' ');
  if (kept(baseTeams, draft.teams) !== kept(draft.teams, baseTeams)) out.teams.push('The order of the teams');

  // roster
  for (const r of draft.roster) {
    const was = base.roster.find((x) => lower(x.ign) === lower(r.ign));
    if (!was) { out.roster.push(`Add ${r.ign} (${tName(r.team)})${r.name ? `, real name ${r.name}` : ''}`); continue; }
    if (was.team !== r.team) out.roster.push(`${r.ign}: ${tName(was.team)} → ${tName(r.team)}`);
    if ((was.name || '') !== (r.name || '')) out.roster.push(`${r.ign}: real name → ${r.name || 'none'}`);
    for (const c of addons('rosterColumn')) {
      if ((was[c.key] || null) !== (r[c.key] || null)) out.roster.push(`${r.ign}: ${c.title.toLowerCase()} → ${r[c.key] ? c.label(r[c.key]) : 'none'}`);
    }
  }
  for (const r of base.roster) if (!draft.roster.some((x) => lower(x.ign) === lower(r.ign))) out.roster.push(`Remove ${r.ign} from the roster`);

  // each player's teams over time
  const periods = (list) => {
    const by = new Map();
    for (const h of list) {
      if (!by.has(lower(h.ign))) by.set(lower(h.ign), { ign: h.ign, rows: [] });
      by.get(lower(h.ign)).rows.push(`${h.until}:${h.team}`);
    }
    for (const p of by.values()) p.rows.sort();
    return by;
  };
  const was = periods(base.history || []), now = periods(draft.history);
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    if ((was.get(key)?.rows.join('|') || '') !== (now.get(key)?.rows.join('|') || '')) {
      out.history.push(`${(now.get(key) || was.get(key)).ign}: teams over time`);
    }
  }

  // hidden players, merged accounts, sign-in emails
  for (const h of draft.hidden) {
    const b = base.hidden.find((x) => lower(x.name) === lower(h.name));
    if (!b) out.hidden.push(`Hide ${h.name}`);
    else if ((b.note || '') !== (h.note || '')) out.hidden.push(`${h.name}: note`);
  }
  for (const h of base.hidden) if (!draft.hidden.some((x) => lower(x.name) === lower(h.name))) out.hidden.push(`Show ${h.name} again`);
  for (const a of draft.aliases) {
    const b = base.aliases.find((x) => lower(x.alias) === lower(a.alias));
    if (!b || lower(b.name) !== lower(a.name)) out.aliases.push(`Count ${a.alias} as ${a.name}`);
  }
  for (const a of base.aliases) if (!draft.aliases.some((x) => lower(x.alias) === lower(a.alias))) out.aliases.push(`Unmerge ${a.alias}`);
  const baseEmails = base.emails || [];
  for (const e of draft.emails) {
    const b = baseEmails.find((x) => x.email === e.email);
    if (!b || lower(b.ign) !== lower(e.ign)) out.emails.push(`${e.email} chats as ${e.ign}`);
  }
  for (const e of baseEmails) if (!draft.emails.some((x) => x.email === e.email)) out.emails.push(`${e.email} no longer chats as ${e.ign}`);
  return out;
}
const adminDirty = () => Object.values(adminChanges()).some((list) => list.length);

// Everything about one player, as a string: compared between what's saved and the draft, to mark the
// players with unsaved changes in Admin → Players.
function playerState(src, key) {
  const lower = (v) => v.toLowerCase();
  const r = src.roster.find((x) => lower(x.ign) === key);
  return JSON.stringify([
    r ? [r.team, r.name || '', ...addons('rosterColumn').map((c) => r[c.key] || null)] : null,
    (src.history || []).filter((h) => lower(h.ign) === key).map((h) => `${h.until}:${h.team}`).sort(),
    src.hidden.filter((h) => lower(h.name) === key).map((h) => h.note || ''),
    src.aliases.filter((a) => lower(a.alias) === key || lower(a.name) === key).map((a) => `${lower(a.alias)}>${lower(a.name)}`).sort(),
    (src.emails || []).filter((e) => lower(e.ign) === key).map((e) => e.email).sort(),
  ]);
}
function changedPlayers() {
  const d = admin.data, f = admin.draft;
  if (!d || !f) return new Set();
  const keys = new Set();
  for (const src of [d, f]) {
    for (const r of src.roster) keys.add(r.ign.toLowerCase());
    for (const h of src.hidden) keys.add(h.name.toLowerCase());
    for (const a of src.aliases) { keys.add(a.alias.toLowerCase()); keys.add(a.name.toLowerCase()); }
    for (const e of src.emails || []) keys.add(e.ign.toLowerCase());
    for (const h of src.history || []) keys.add(h.ign.toLowerCase());
  }
  return new Set([...keys].filter((k) => playerState(d, k) !== playerState(f, k)));
}

window.addEventListener('beforeunload', (e) => {
  if ((admin.draft && adminDirty()) || (srv.draft && srvChanges().length)) e.preventDefault(); // "Leave site? Changes you made may not be saved."
});

// The admin page's sections, and the box each draws in (Players, Teams and the two at-once ones share #admin).
const ADMIN_SECTIONS = {
  players: ['admin', 'Players'], teams: ['admin', 'Teams'], layout: ['layout-admin', 'Layout'], server: ['server-admin', 'Server'],
  roles: ['roles', 'Roles'], moderation: ['admin', 'Chat and deaths'], mod: ['admin', 'Mod and commands'], data: ['admin', 'Connection and data'], analytics: ['analytics', 'Analytics'],
  discord: ['discord-admin', 'Discord'],
};
function adminTab(name) {
  admin.tab = name;
  for (const box of new Set(Object.values(ADMIN_SECTIONS).map(([b]) => b))) $(`#${box}`).hidden = ADMIN_SECTIONS[name][0] !== box;
  $('#adm-tab-roles').hidden = !site.super;
  $('#adm-season-cap').textContent = `Season ${SEASON}`;
  for (const t of Object.keys(ADMIN_SECTIONS)) {
    const a = $(`#adm-tab-${t}`);
    if (t === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${ADMIN_SECTIONS[name][1]} · Admin · ${SITE}`;
  renderAdminBar();
}

// Players, Teams, Chat and deaths, Mod and commands, Connection and data: all drawn from GET /api/admin. pick: a player to edit.
async function showAdmin(section = 'players', pick = null) {
  showView('admin');
  adminTab(section);
  admin.pick = pick ? pick.toLowerCase() : null;
  const root = $('#admin');
  if (!site.admin) {
    // the check may still be on its way
    const r = DUMMY ? null : await api('/api/me').catch(() => null);
    if (r) setMe(r);
  }
  if (!site.admin) {
    root.replaceChildren(el('div', { class: 'card empty', text: 'This page is only for admins.' }));
    return;
  }
  // moving between players doesn't fetch everything again; coming back after a while does
  if (!admin.data || Date.now() - admin.loadedAt > 60_000) {
    if (!admin.data) root.replaceChildren(el('div', { class: 'card empty', text: 'Loading…' }));
    const keep = admin.draft && adminDirty(); // unsaved changes from an earlier visit stay
    [admin.data] = await Promise.all([api('/api/admin'), loadStatus()]);
    admin.loadedAt = Date.now();
    if (!keep) admin.draft = adminDraftFrom(admin.data);
  }
  renderAdmin();
  $('#adm-mod-dot').hidden = !admin.data.mod_update;
  if (pick) root.querySelector('.adm-pedit')?.scrollIntoView?.({ block: 'nearest' });
}

// The one Save bar under every admin section, for everything that waits for Save: the season's settings
// (Players, Teams) and the server's (Layout, Server). It only shows while something is unsaved. The rail
// beside it counts what's unsaved in each section.
function renderAdminBar() {
  const box = $('#adm-bar');
  if (!box) return;
  const a = admin.draft ? adminChanges() : null;
  const s = srv.draft ? srvChanges() : [];
  const lay = srv.draft ? layoutChanges(srv.data.layout, srv.draft.layout) : [];
  const counts = {
    players: admin.draft ? changedPlayers().size : 0,
    teams: a ? a.teams.length : 0,
    layout: lay.length,
    server: s.length - lay.length,
  };
  for (const [t, n] of Object.entries(counts)) {
    const badge = $(`#adm-tab-${t} .adm-rail-n`);
    badge.hidden = !n;
    badge.textContent = n ? String(n) : '';
    badge.title = n ? `${n} unsaved` : '';
  }
  const all = [...(a ? Object.values(a).flat() : []), ...s];
  if (!all.length) { box.replaceChildren(); return; }
  const busy = admin.busy || srv.busy;
  const button = (text, cls, run) => {
    const b = el('button', { type: 'button', class: `btn ${cls}`, text, 'data-fk': `bar:${text}` });
    b.disabled = busy;
    b.addEventListener('click', run);
    return b;
  };
  const list = el('details', { class: 'adm-bar-list' },
    el('summary', { text: 'What changes' }),
    el('ul', {}, ...all.slice(0, 60).map((c) => el('li', { text: c })), all.length > 60 ? el('li', { class: 'muted', text: `and ${all.length - 60} more` }) : null));
  if (admin.barOpen) list.open = true;
  list.addEventListener('toggle', () => { admin.barOpen = list.open; });
  box.replaceChildren(el('div', { class: 'adm-bar', role: 'region', 'aria-label': 'Unsaved changes' },
    el('i', { class: 'adm-bar-mark', 'aria-hidden': 'true' }),
    el('div', { class: 'adm-bar-text' },
      el('strong', { text: `${all.length} unsaved ${all.length === 1 ? 'change' : 'changes'}` }),
      el('span', { class: 'muted', text: 'Nobody else sees them until you save.' }), list),
    el('div', { class: 'adm-bar-actions' }, button('Reset', 'btn-quiet', adminResetAll), button(busy ? 'Saving…' : 'Save', 'btn-primary', adminSaveAll))));
}

async function adminSaveAll() {
  if (admin.busy || srv.busy) return;
  if (admin.draft && adminDirty() && !(await adminSave())) return;
  if (srv.draft && srvChanges().length) await srvSave();
  renderAdminBar();
}
function adminResetAll() {
  if (admin.busy || srv.busy) return;
  if (admin.data) {
    admin.draft = adminDraftFrom(admin.data);
    if (ADMIN_SECTIONS[admin.tab][0] === 'admin') renderAdmin();
  }
  if (srv.data) {
    srv.draft = srvDraftFrom(srv.data);
    srv.errors = {};
    applyLook(srv.data.accent, srv.data.tab_style);
    applyLayout(layoutSaved);
    renderAbout();
    if (admin.tab === 'server') renderServerAdmin();
    if (admin.tab === 'layout') renderLayoutAdmin();
  }
  renderAdminBar();
  toast('Back to what’s saved');
}

/* ---------- admin: the server's own details (Admin → Server) ---------- */

// The server's name, its address, who can see it, its join password and how its pages look (accent
// color, tab style), saved together with the bar at the bottom (POST /api/admin/server,
// src/serveradmin.js). The look is tried on the page as it's picked, and put back if it isn't saved.
const srv = { data: null, draft: null, busy: false, errors: {}, custom: '#b4552d', seasons: null, seasonEdits: {}, seasonErrors: {} };
const HEX6 = /^#[0-9a-f]{6}$/;
// Text on a custom accent: white, unless the color is too light for white to be read on it (as src/look.js).
function inkOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#16181b' : '#ffffff';
}
// Puts a look on the page: accent 'green', 'blue' or '#rrggbb'; tabs 'line' or 'frame'.
function applyLook(accent, tabs) {
  const root = document.documentElement;
  const custom = HEX6.test(accent);
  root.dataset.accent = custom ? 'custom' : accent;
  root.dataset.tabs = tabs;
  for (const [k, v] of [['--accent-custom', accent], ['--accent-ink', custom ? inkOn(accent) : '']]) {
    if (custom) root.style.setProperty(k, v);
    else root.style.removeProperty(k);
  }
}
// icon: undefined while it isn't changed, '' to remove it, or the new one as a data: URL (makeIcon)
const srvDraftFrom = (d) => ({ name: d.name, slug: d.slug, public: d.public, password: '', confirm: '', accent: d.accent, tab_style: d.tab_style, addons: [...d.addons],
  about: d.about || '', banner: d.banner || '', icon: undefined, layout: fullLayout(d.layout) });
// What Save would change, one line each.
function srvChanges() {
  const d = srv.data, f = srv.draft;
  if (!d || !f) return [];
  const out = [];
  const accentName = (a) => (HEX6.test(a) ? a : a[0].toUpperCase() + a.slice(1));
  if (f.name.trim() !== d.name) out.push(`Name: ${d.name} → ${f.name.trim() || '(empty)'}`);
  if (f.slug.trim().toLowerCase() !== d.slug) out.push(`Address: /${d.slug} → /${f.slug.trim().toLowerCase()} (old links stop working, the join link included, and everyone joins again)`);
  if (f.public !== d.public) out.push(f.public ? 'Public: anyone with the address can look' : 'Private: looking needs the join password');
  if (f.password) out.push(d.has_password ? 'A new join password (everyone who joined with the old one joins again)' : 'A join password');
  if (f.accent !== d.accent) out.push(`Accent: ${accentName(d.accent)} → ${accentName(f.accent)}`);
  if (f.tab_style !== d.tab_style) out.push(`Tab style: ${f.tab_style === 'line' ? 'Line' : 'Frame'}`);
  if (f.about.trim() !== (d.about || '')) out.push(f.about.trim() ? (d.about ? 'A new description' : 'A description') : 'No description');
  if (f.icon !== undefined) out.push(f.icon ? (d.icon ? 'A new icon' : 'An icon') : 'Remove the icon');
  if (f.banner !== (d.banner || '')) out.push(f.banner === '1' ? 'Show the header on the Activity page' : 'Hide the header on the Activity page');
  out.push(...layoutChanges(d.layout, f.layout));
  for (const a of d.known_addons || []) {
    if (f.addons.includes(a.id) !== d.addons.includes(a.id)) out.push(`${f.addons.includes(a.id) ? 'Switch on' : 'Switch off'} the add-on ${a.name}`);
  }
  return out;
}
// Leaving the tab with a look that wasn't saved: the page goes back to the saved one.
function srvLeave() {
  if (srv.data) applyLook(srv.data.accent, srv.data.tab_style);
}

async function showServerAdmin() {
  showView('admin');
  document.title = `Server · ${SITE}`;
  const root = $('#server-admin');
  if (!site.perms) {
    const r = DUMMY ? null : await api('/api/me').catch(() => null);
    if (r) setMe(r);
  }
  adminTab('server');
  if (!site.admin || DUMMY) {
    root.replaceChildren(el('div', { class: 'card empty', text: DUMMY ? 'The sample data has no server to change.' : 'This page is only for admins.' }));
    return;
  }
  if (!srv.data) root.replaceChildren(el('div', { class: 'card empty', text: 'Loading…' }));
  const keep = srv.draft && srvChanges().length; // unsaved changes from an earlier visit stay
  [srv.data, srv.seasons] = await Promise.all([api('/api/admin/server'), api('/api/admin/seasons').catch(() => null)]);
  // season times are typed and shown in the server's time zone, which this tab may have opened before learning
  if (srv.seasons?.tz) setTz(srv.seasons.tz);
  if (!keep) {
    srv.draft = srvDraftFrom(srv.data);
    srv.errors = {};
  }
  if (HEX6.test(srv.draft.accent)) srv.custom = srv.draft.accent;
  renderServerAdmin();
}

async function srvSave() {
  const d = srv.data, f = srv.draft;
  if (srv.busy || !d || !srvChanges().length) return;
  const body = {};
  if (f.name.trim() !== d.name) body.name = f.name.trim();
  if (f.slug.trim().toLowerCase() !== d.slug) body.slug = f.slug.trim().toLowerCase();
  if (f.public !== d.public) body.public = f.public;
  if (f.password) Object.assign(body, { password: f.password, confirm: f.confirm });
  if (f.accent !== d.accent) body.accent = f.accent;
  if (f.tab_style !== d.tab_style) body.tab_style = f.tab_style;
  if (d.known_addons && f.addons.join() !== d.addons.join()) body.addons = f.addons;
  if (f.about.trim() !== (d.about || '')) body.about = f.about.trim();
  if (f.icon !== undefined) body.icon = f.icon;
  if (f.banner !== (d.banner || '')) body.banner = f.banner === '1';
  if (layoutChanges(d.layout, f.layout).length) body.layout = f.layout;
  srv.busy = true;
  srv.errors = {};
  $('#server-admin').classList.add('adm-busy');
  renderAdminBar();
  try {
    const res = await fetch('/api/admin/server', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await res.json().catch(() => null);
    if (!res.ok) {
      srv.errors = { [r?.field || 'form']: r?.error || `The server answered ${res.status}.` };
      toast(r?.field ? 'That wasn’t saved. See the note by the field, under Server.' : `Not saved: ${srv.errors.form}`, { error: true, ms: 5000 });
      return;
    }
    // what every page shows from here on
    MCS.about = r.about;
    MCS.banner = r.banner || '';
    MCS.icon = r.icon ? `${BASE}${r.icon}` : null;
    layoutSaved = fullLayout(r.layout);
    // a new address is a new page; a new name is on every page's title: load it afresh
    if (r.moved) { srv.draft = null; location.href = `${r.moved}#/admin/server`; return; }
    if (body.name || body.addons) { srv.draft = null; location.reload(); return; }
    srv.data = r;
    srv.draft = srvDraftFrom(r);
    toast('Saved');
  } catch {
    srv.errors = { form: 'Couldn’t reach the server. Nothing was saved.' };
  } finally {
    srv.busy = false;
    $('#server-admin').classList.remove('adm-busy');
    if (srv.draft) {
      applyLayout(fullLayout(srv.draft.layout));
      renderAbout();
      if (admin.tab === 'server') renderServerAdmin();
      if (admin.tab === 'layout') renderLayoutAdmin();
    }
    renderAdminBar();
  }
}

/* ---------- Admin → Server: seasons (src/seasonadmin.js) ---------- */

// A season is a stretch of time, so everything here can be put back: making one, moving a start, removing
// the newest. Each is its own action with its own confirmation, apart from the Save bar below.

// The time typed into a datetime-local box, in the dashboard's time zone -> unix seconds (null if empty).
function inputTs(v) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  return m ? zonedTs(m[1], +m[2], +m[3]) : null;
}
const seasonWhen = (ts) => fmt(ts, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

async function seasonsPost(body) {
  try {
    const res = await fetch('/api/admin/seasons', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await res.json().catch(() => null);
    return res.ok ? { ok: true, data: r } : { ok: false, error: r?.error || `The server answered ${res.status}.`, field: r?.field };
  } catch {
    return { ok: false, error: 'Couldn’t reach the server. Nothing was changed.' };
  }
}

// Seasons changed: every page of this server reads differently now. Start again from the main page.
function seasonsReload() {
  const to = `${BASE}#/admin/server`;
  if (location.pathname === BASE) { location.hash = '#/admin/server'; location.reload(); } else location.assign(to);
}

// A dialog that asks for the season's name to be typed before its button works. build(d) adds what's
// particular to it and returns the rest of the request; the request is sent with { confirm }.
function seasonDialog({ title, intro, phrase, go, danger, build }) {
  const dialog = el('dialog', { class: 'lv-dialog sea-dialog' });
  const err = el('div', { class: 'lv-gate-error', role: 'alert' });
  const typed = el('input', { class: 'adm-input', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: phrase, 'aria-label': `Type ${phrase} to confirm` });
  const cancel = el('button', { class: 'btn', type: 'button', text: 'Cancel' });
  const submit = el('button', { class: `btn ${danger ? 'sea-danger' : 'btn-primary'}`, type: 'submit', text: go });
  submit.disabled = true;
  const matches = () => typed.value.trim().replace(/\s+/g, ' ').toLowerCase() === phrase.toLowerCase();
  typed.addEventListener('input', () => { submit.disabled = !matches(); });
  const form = el('form', { autocomplete: 'off' }, el('h2', { text: title }), ...intro.map((t) => el('p', { text: t })));
  const more = build ? build(form) : () => ({});
  form.append(
    el('label', { class: 'sea-confirm' }, el('span', {}, 'To confirm, type ', el('strong', { text: phrase })), typed),
    err, el('div', { class: 'range-actions' }, cancel, submit));
  dialog.append(form);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!matches() || submit.disabled) return;
    const extra = more();
    if (extra.error) { err.textContent = extra.error; return; }
    submit.disabled = cancel.disabled = true;
    err.textContent = '';
    const r = await seasonsPost({ ...extra, confirm: typed.value });
    if (r.ok) return seasonsReload();
    err.textContent = r.error;
    cancel.disabled = false;
    submit.disabled = !matches();
  });
  document.body.append(dialog);
  dialog.showModal();
}

function newSeasonDialog() {
  const cur = srv.seasons.current, n = cur + 1;
  seasonDialog({
    title: `Start Season ${n}`,
    intro: [
      `The main page becomes Season ${n} and starts empty. Season ${cur} ends when Season ${n} starts, and stays as an archive you can switch to at the bottom of the page.`,
      'Nothing is deleted. A season is only a stretch of time: you can move its start later, or remove the season again, here.',
    ],
    phrase: `Season ${n}`,
    go: `Start Season ${n}`,
    build(form) {
      const pick = (value, label) => {
        const radio = el('input', { type: 'radio', name: 'sea-when', value });
        return [radio, el('label', { class: 'sea-opt' }, radio, el('span', { text: label }))];
      };
      const [nowRadio, nowOpt] = pick('now', 'It starts now');
      const [laterRadio, laterOpt] = pick('later', 'It starts at a set time');
      nowRadio.checked = true;
      const at = el('input', { class: 'adm-input adm-time', type: 'datetime-local', 'aria-label': `When Season ${n} starts`, min: localInput(nowSec()) });
      at.value = localInput(currentHourEnd());
      at.disabled = true;
      const note = el('span', { class: 'site-hint', text: `Times are in ${TZ}. Until then the main page says when Season ${n} starts, and Season ${cur} keeps recording.` });
      const later = el('div', { class: 'sea-later', hidden: '' }, at, note);
      const sync = () => { at.disabled = !laterRadio.checked; later.hidden = !laterRadio.checked; };
      nowRadio.addEventListener('change', sync);
      laterRadio.addEventListener('change', sync);
      const copy = el('input', { type: 'checkbox' });
      copy.checked = true;
      form.append(
        el('div', { class: 'sea-opts', role: 'radiogroup', 'aria-label': 'When it starts' }, nowOpt, laterOpt, later),
        el('label', { class: 'sea-opt sea-copy' }, copy, el('span', {},
          `Bring over Season ${cur}’s teams, players and sign-in emails`,
          el('span', { class: 'site-hint', text: `Without them Season ${n} has no teams, and nobody can chat from the website until players are added in Admin → Players.` }))));
      return () => {
        const out = { action: 'create', copy: copy.checked };
        if (laterRadio.checked) {
          const ts = inputTs(at.value);
          if (!ts) return { error: 'Pick when it starts.' };
          out.start = ts;
        }
        return out;
      };
    },
  });
}

function removeSeasonDialog() {
  const cur = srv.seasons.current;
  seasonDialog({
    title: `Remove Season ${cur}`,
    intro: [
      `Season ${cur} stops existing. Everything recorded since it started counts as Season ${cur - 1} again, and Season ${cur - 1} goes back to being the main page.`,
      `Nothing is deleted, and Season ${cur}’s teams and players are kept in case you make it again.`,
    ],
    phrase: `Season ${cur}`,
    go: `Remove Season ${cur}`,
    danger: true,
    build: () => () => ({ action: 'remove' }),
  });
}

// The Seasons card of Admin → Server. card: the tab's own card maker; redraw: draws the tab again.
function renderSeasons(card, redraw) {
  const { current, seasons, now } = srv.seasons;
  const rows = [...seasons].reverse().map((s) => {
    const n = s.n;
    const tag = n === current
      ? (s.started ? ['Current', 'on'] : [`Starts ${seasonWhen(s.start)}`, 'wait'])
      : (s.ended ? ['Archive', ''] : [`Still recording until Season ${n + 1} starts`, 'wait']);
    const head = el('div', { class: 'sea-head' }, el('strong', { text: `Season ${n}` }), el('span', { class: `sea-tag ${tag[1]}`, text: tag[0] }));
    const ends = s.end != null ? `${s.ended ? 'Ended' : 'Ends'} ${seasonWhen(s.end)}, when Season ${n + 1} ${s.ended ? 'started' : 'starts'}.` : 'No end yet: it runs until a new season starts.';
    if (n === 1) {
      return el('div', { class: 'sea-row' }, head,
        el('span', { class: 'site-hint', text: `Starts at the first thing recorded. ${ends}` }));
    }
    const saved = { start: s.start ? localInput(s.start) : '', opens: s.opens ? localInput(s.opens) : '' };
    const edit = srv.seasonEdits[n] || (srv.seasonEdits[n] = { ...saved });
    const box = (key, label) => {
      const input = el('input', { class: 'adm-input adm-time', type: 'datetime-local', 'aria-label': `Season ${n}: ${label}`, 'data-fk': `sea:${n}:${key}` });
      input.value = edit[key];
      input.addEventListener('input', () => { edit[key] = input.value; save.disabled = !changed(); });
      return el('label', { class: 'sea-field' }, el('span', { class: 'site-label', text: label }), input);
    };
    const changed = () => edit.start !== saved.start || edit.opens !== saved.opens;
    const save = el('button', { type: 'button', class: 'btn', text: 'Save', 'data-fk': `sea:${n}:save` });
    save.disabled = !changed();
    save.addEventListener('click', async () => {
      const start = inputTs(edit.start), opens = inputTs(edit.opens);
      if (!start) { srv.seasonErrors[n] = 'Pick when it starts.'; return redraw(`sea:${n}:start`); }
      // moving a start across time that's already been recorded changes which season that time counts for
      if (start !== s.start && Math.min(start, s.start ?? start) <= now) {
        const [a, b] = start < s.start ? [n, n - 1] : [n - 1, n];
        if (!confirm(`Move the start of Season ${n} to ${seasonWhen(start)}?\n\nWhat was recorded between the old and new start will count as Season ${a} instead of Season ${b}. Nothing is deleted, and you can move it back.`)) return;
      }
      save.disabled = true;
      const r = await seasonsPost({ action: 'update', n, start, ...(opens && { opens }) });
      if (!r.ok) { srv.seasonErrors[n] = r.error; return redraw(`sea:${n}:${r.field === 'opens' ? 'opens' : 'start'}`); }
      seasonsReload();
    });
    const err = srv.seasonErrors[n] ? el('span', { class: 'site-err', role: 'alert', text: srv.seasonErrors[n] }) : null;
    delete srv.seasonErrors[n];
    return el('div', { class: 'sea-row' }, head,
      el('div', { class: 'sea-fields' }, box('start', 'Starts'), box('opens', 'Officially opens (optional)'), save),
      err,
      el('span', { class: 'site-hint', text: `${ends} A start on the hour is tidiest. Set “officially opens” only if recording starts before the season does: charts then mark the opening, and what’s recorded before it still counts.` }));
  });
  const add = el('button', { type: 'button', class: 'btn', text: `Start Season ${current + 1}…`, 'data-fk': 'sea:new' });
  add.addEventListener('click', newSeasonDialog);
  const waiting = !seasons.at(-1).started;
  add.disabled = waiting || current >= 99;
  const remove = current > 1 ? el('button', { type: 'button', class: 'btn sea-remove', text: `Remove Season ${current}…`, 'data-fk': 'sea:remove' }) : null;
  remove?.addEventListener('click', removeSeasonDialog);
  return card('Seasons', `each season is a stretch of time; times are in ${TZ}`,
    el('div', { class: 'sea-list' }, ...rows),
    el('div', { class: 'sea-actions' }, add, remove),
    el('span', { class: 'site-hint', text: waiting
      ? `Season ${current} hasn’t started yet, so another can’t be made. Change when it starts above, or remove it.`
      : 'A new season gives the main page a fresh start and keeps this one as an archive. Nothing recorded is ever deleted by changing seasons.' }));
}

function renderServerAdmin(focusKey) {
  const d = srv.data, f = srv.draft;
  if (!d || !f) return;
  const root = $('#server-admin');
  const owner = d.can.owner;
  const redraw = (fk) => renderServerAdmin(fk);
  applyLook(f.accent, f.tab_style);

  const error = (key) => (srv.errors[key] ? el('span', { class: 'site-err', role: 'alert', text: srv.errors[key] }) : null);
  const field = (label, control, hint, key) => el('div', { class: 'site-field srv-field' },
    el('span', { class: 'site-label', text: label }), control, key ? error(key) : null, hint ? el('span', { class: 'site-hint', text: hint }) : null);
  // a text box that keeps the draft up to date as it's typed in (only the Save bar is drawn again, so it keeps its place)
  const text = (key, attrs) => {
    const box = el('input', { class: 'adm-input srv-input', 'data-fk': `srv:${key}`, ...attrs });
    box.value = f[key];
    box.addEventListener('input', () => { f[key] = box.value; renderAdminBar(); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') srvSave(); });
    return box;
  };
  const ownerOnly = owner ? null : 'Only the server’s owner can change this.';
  const card = (title, sub, ...kids) => el('section', { class: 'card adm-card' },
    el('div', { class: 'card-head' }, el('h2', { text: title }), sub ? el('span', { class: 'card-sub', text: sub }) : null),
    el('div', { class: 'srv-fields' }, ...kids));

  /* ---- name and address ---- */
  const slugBox = text('slug', { type: 'text', maxlength: '32', spellcheck: 'false', autocapitalize: 'none', autocomplete: 'off', 'aria-label': 'Address',
    disabled: owner && !d.slug_locked ? null : '' });
  slugBox.className = 'wiz-url-input srv-url-input';
  // the icon: what's saved, or what was picked and isn't saved yet
  const iconNow = f.icon !== undefined ? f.icon || null : d.icon ? `${BASE}${d.icon}` : null;
  const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: '', 'aria-hidden': 'true' });
  const takeIcon = async (picked) => {
    try {
      f.icon = await makeIcon(picked);
      delete srv.errors.icon;
    } catch (err) {
      srv.errors.icon = err.message;
    }
    redraw('srv:icon');
  };
  file.addEventListener('change', () => { if (file.files[0]) takeIcon(file.files[0]); });
  const slot = el('div', { class: `srv-icon-slot${iconNow ? '' : ' empty'}` },
    iconNow ? el('img', { src: iconNow, alt: 'The server’s icon', width: '64', height: '64' }) : el('span', { class: 'srv-icon-none', 'aria-hidden': 'true' }));
  slot.addEventListener('dragover', (e) => { e.preventDefault(); slot.classList.add('drop'); });
  slot.addEventListener('dragleave', () => slot.classList.remove('drop'));
  slot.addEventListener('drop', (e) => { e.preventDefault(); slot.classList.remove('drop'); const got = e.dataTransfer?.files?.[0]; if (got) takeIcon(got); });
  const upload = el('button', { type: 'button', class: 'btn', text: iconNow ? 'Upload another…' : 'Upload an image…', 'data-fk': 'srv:icon' });
  upload.addEventListener('click', () => file.click());
  const unicon = iconNow ? el('button', { type: 'button', class: 'btn btn-quiet', text: 'Remove', 'data-fk': 'srv:icon-remove' }) : null;
  unicon?.addEventListener('click', () => { f.icon = d.icon ? '' : undefined; redraw('srv:icon'); });
  const iconField = field('Icon', el('div', { class: 'srv-icon' }, slot, el('div', { class: 'srv-icon-actions' }, upload, unicon, file)),
    'Square works best; anything else is cropped to the middle. The game’s 64×64 server-icon.png stays sharp. Also the icon in the browser tab.', 'icon');
  const aboutBox = el('textarea', { class: 'adm-input srv-input srv-about', rows: '3', maxlength: '280', placeholder: 'What the server is, who plays, when it’s on…', 'aria-label': 'Description', 'data-fk': 'srv:about' });
  aboutBox.value = f.about;
  const aboutCount = el('span', { class: 'srv-count', text: `${f.about.length} / 280` });
  aboutBox.addEventListener('input', () => { f.about = aboutBox.value; aboutCount.textContent = `${f.about.length} / 280`; renderAdminBar(); });
  // whether the header (icon, name, description) shows at the top of the Activity page: the owner's choice
  const bannerBox = el('input', { type: 'checkbox', 'data-fk': 'srv:banner', disabled: owner ? null : '' });
  bannerBox.checked = bannerOn(f.banner, iconNow);
  bannerBox.addEventListener('change', () => { f.banner = bannerBox.checked ? '1' : '0'; redraw('srv:banner'); });
  const bannerField = field('Header', el('label', { class: 'srv-check' }, bannerBox, el('span', { text: 'Show the icon, name and description at the top of the Activity page' })),
    ownerOnly || 'On by default once there’s an icon. It needs an icon or a description to show.', 'banner');
  const details = card('Server', null,
    field('Name', text('name', { type: 'text', maxlength: '60', autocomplete: 'off', 'aria-label': 'Name' }), 'Shown at the top of its pages and in emails.', 'name'),
    iconField,
    field('Description', el('div', { class: 'srv-about-wrap' }, aboutBox, aboutCount), 'Shown under the name at the top of the Activity page. Plain text; a line break starts a new line.', 'about'),
    bannerField,
    field('Address', el('div', { class: 'wiz-url srv-url' }, el('span', { class: 'wiz-url-host', text: `${location.host}/` }), slugBox),
      d.slug_locked || ownerOnly || '3 to 32 lowercase letters, digits and dashes. Changing it moves the server: old links stop working, and everyone joins again at the new address.', 'slug'));

  /* ---- who can see it, and the join password ---- */
  const vis = (pub, title, about) => {
    const radio = el('input', { type: 'radio', name: 'srv-vis', class: 'wiz-vis-radio', 'data-fk': `srv:vis:${pub}`, disabled: owner ? null : '' });
    radio.checked = f.public === pub;
    radio.addEventListener('change', () => { f.public = pub; redraw(`srv:vis:${pub}`); });
    return el('label', { class: 'wiz-vis-opt' }, radio, el('span', { class: 'wiz-vis-title', text: title }), el('span', { class: 'wiz-vis-text', text: about }));
  };
  const pass = (key, label) => text(key, { type: 'password', autocomplete: 'new-password', maxlength: '200', placeholder: label, 'aria-label': label, disabled: owner ? null : '' });
  const access = card('Who can see it', null,
    field('Stats', el('div', { class: 'wiz-vis srv-vis', role: 'radiogroup', 'aria-label': 'Who can see the stats' },
      vis(false, 'Private', 'Players get in with a join link, or with the server’s name and its join password.'),
      vis(true, 'Public', 'Anyone with the address can look. No password needed.')), ownerOnly, 'public'),
    field(d.has_password ? 'New join password' : 'Join password', el('div', { class: 'srv-row' }, pass('password', 'New password'), pass('confirm', 'The same again')),
      ownerOnly || (d.has_password
        ? 'Leave empty to keep the one it has. 8 characters or more. A new one makes everyone who joined with the old one join again.'
        : 'This server has none yet. 8 characters or more; it needs one before it can be made private.'), srv.errors.confirm ? 'confirm' : 'password'),
    joinLinkField(d, field));

  /* ---- how its pages look ---- */
  const custom = HEX6.test(f.accent);
  const swatch = (value, label, color) => {
    const on = value === 'custom' ? custom : f.accent === value;
    const b = el('button', { type: 'button', class: 'srv-swatch', 'aria-pressed': String(on), 'data-fk': `srv:accent:${value}` },
      el('i', { style: `background:${color}` }), label);
    b.addEventListener('click', () => { f.accent = value === 'custom' ? srv.custom : value; redraw(`srv:accent:${value}`); });
    return b;
  };
  const picker = el('input', { type: 'color', class: 'srv-color', 'aria-label': 'Custom accent color', 'data-fk': 'srv:color' });
  picker.value = srv.custom;
  const hex = el('input', { type: 'text', class: 'adm-input srv-hex', maxlength: '7', spellcheck: 'false', 'aria-label': 'Custom accent color as a hex code', 'data-fk': 'srv:hex' });
  hex.value = srv.custom;
  const setCustom = (v, from) => {
    srv.custom = f.accent = v;
    applyLook(f.accent, f.tab_style);
    if (from !== picker) picker.value = v;
    if (from !== hex) hex.value = v;
    renderAdminBar();
  };
  picker.addEventListener('input', () => setCustom(picker.value.toLowerCase(), picker));
  hex.addEventListener('input', () => {
    const v = (hex.value.trim().startsWith('#') ? hex.value.trim() : `#${hex.value.trim()}`).toLowerCase();
    if (HEX6.test(v)) setCustom(v, hex);
  });
  const tabs = (value, title, about) => {
    const radio = el('input', { type: 'radio', name: 'srv-tabs', class: 'wiz-vis-radio', 'data-fk': `srv:tabs:${value}` });
    radio.checked = f.tab_style === value;
    radio.addEventListener('change', () => { f.tab_style = value; redraw(`srv:tabs:${value}`); });
    return el('label', { class: 'wiz-vis-opt srv-tabs-opt' }, radio,
      el('span', { class: `srv-demo srv-demo-${value}`, 'aria-hidden': 'true' }, el('span', { class: 'on', text: 'Activity' }), el('span', { text: 'Combat' }), el('span', { text: 'Chat log' })),
      el('span', { class: 'wiz-vis-title', text: title }), el('span', { class: 'wiz-vis-text', text: about }));
  };
  const look = card('Look', 'tried on this page as you pick; everyone sees it once it’s saved',
    field('Accent color', el('div', { class: 'srv-swatches' },
      swatch('green', 'Green', 'var(--accent-green)'), swatch('blue', 'Blue', 'var(--accent-blue)'), swatch('custom', 'Custom', srv.custom),
      custom ? el('span', { class: 'srv-custom' }, picker, hex) : null),
    'Charts, links, the main buttons and the line under whatever’s picked. A custom color is lightened a little in dark mode.', 'accent'),
    field('Tab style', el('div', { class: 'wiz-vis srv-vis', role: 'radiogroup', 'aria-label': 'Tab style' },
      tabs('line', 'Line', 'The current tab is a shade greyer, with a line in the accent color under it.'),
      tabs('frame', 'Frame', 'The current tab is set in, with a frame around it and no color.')), null, 'tab_style'));

  /* ---- add-ons: the site's operators only ---- */
  const extras = d.known_addons?.length ? card('Add-ons', 'features only some servers have; only the site’s operators see this',
    ...d.known_addons.map((a) => {
      const box = el('input', { type: 'checkbox', 'data-fk': `srv:addon:${a.id}` });
      box.checked = f.addons.includes(a.id);
      box.addEventListener('change', () => {
        f.addons = d.known_addons.map((x) => x.id).filter((id) => (id === a.id ? box.checked : f.addons.includes(id)));
        redraw(`srv:addon:${a.id}`);
      });
      return el('label', { class: 'srv-addon' }, box, el('span', {}, el('strong', { text: a.name }), el('span', { class: 'site-hint', text: a.about })));
    })) : null;

  const seasonsCard = srv.seasons ? renderSeasons(card, redraw) : null;
  const formErr = srv.errors.form ? el('div', { class: 'notice notice-error', role: 'alert', text: srv.errors.form }) : null;
  root.replaceChildren(...(formErr ? [formErr] : []), details, access, look, ...(seasonsCard ? [seasonsCard] : []), ...(extras ? [extras] : []));
  if (focusKey) root.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  renderAdminBar();
}

// Admin → Server → Who can see it: the join link, one address that lets players in without typing the server's
// name and password (src/joinlink.js). Made, replaced and turned off at once, apart from the Save bar: none of
// it waits on the other fields. Any admin can.
async function joinLinkSet(action) {
  try {
    const res = await fetch('/api/admin/server', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ join_link: action }),
    });
    const r = await res.json().catch(() => null);
    if (!res.ok) throw new Error(r?.error || `The server answered ${res.status}.`);
    // only the link: whatever else is being edited on this page stays as it is
    srv.data.join_link = r.join_link;
    return true;
  } catch (err) {
    toast(`The join link wasn’t changed: ${err.message}`, { error: true, ms: 5000 });
    return false;
  } finally {
    if (admin.tab === 'server') renderServerAdmin('srv:link');
  }
}

// Replacing or turning off the link stops it working for whoever still has it, so both ask first.
function joinLinkDialog({ title, lines, go, action, done }) {
  const dialog = el('dialog', { class: 'lv-dialog sea-dialog' });
  const cancel = el('button', { class: 'btn', type: 'button', text: 'Cancel' });
  const submit = el('button', { class: 'btn btn-primary', type: 'submit', text: go });
  const form = el('form', {}, el('h2', { text: title }), ...lines.map((text) => el('p', { text })), el('div', { class: 'range-actions' }, cancel, submit));
  dialog.append(form);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = cancel.disabled = true;
    const ok = await joinLinkSet(action);
    dialog.close();
    if (ok) toast(done);
  });
  document.body.append(dialog);
  dialog.showModal();
}

function joinLinkField(d, field) {
  if (d.public) {
    return field('Join link', el('span', { class: 'site-hint', text: 'Not needed while the server is public: its address is all anyone needs.' }));
  }
  if (!d.join_link) {
    const make = el('button', { type: 'button', class: 'btn', text: 'Create a join link', 'data-fk': 'srv:link' });
    make.addEventListener('click', async () => {
      make.disabled = true;
      if (await joinLinkSet('new')) toast('Join link created');
    });
    return field('Join link', el('div', { class: 'srv-row' }, make),
      'One link to send players: opening it lets them straight in, with no server name or password to type.');
  }
  const link = `${location.origin}${d.join_link}`;
  const box = el('input', { class: 'adm-input srv-input srv-link', type: 'text', readonly: '', 'aria-label': 'Join link', 'data-fk': 'srv:link' });
  box.value = link;
  box.addEventListener('focus', () => box.select());
  const copy = el('button', { type: 'button', class: 'btn', text: 'Copy' });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Join link copied');
    } catch {
      box.focus();
      toast('Couldn’t copy. Select the link and copy it.', { error: true });
    }
  });
  const renew = el('button', { type: 'button', class: 'btn', text: 'New link…' });
  renew.addEventListener('click', () => joinLinkDialog({
    title: 'Make a new join link', go: 'Make a new link', action: 'new', done: 'New join link made. The old one no longer works.',
    lines: ['The link you have now stops working at once, for everyone you sent it to. Send players the new one.',
      'People who already got in stay in. To make everyone join again, the owner changes the join password.'],
  }));
  const off = el('button', { type: 'button', class: 'btn btn-quiet', text: 'Turn off…' });
  off.addEventListener('click', () => joinLinkDialog({
    title: 'Turn off the join link', go: 'Turn off', action: 'off', done: 'Join link turned off',
    lines: ['The link stops working at once. Players then need the server’s name and join password, until you create a link again.',
      'People who already got in stay in. To make everyone join again, the owner changes the join password.'],
  }));
  return field('Join link', el('div', { class: 'srv-row srv-link-row' }, box, copy, renew, off),
    'Opening it lets anyone straight in to see the stats, with nothing to type, so send it only to players. If it gets out, make a new link.');
}

// A picked image as the server's icon: a 128-pixel square PNG (data: URL), cropped to its middle. Pixel art
// that fits 128 a whole number of times (the game's 64×64 server-icon.png) is scaled up without blurring.
async function makeIcon(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('Pick an image: a PNG, JPG, WebP or GIF.');
  if (file.size > 10 * 1024 * 1024) throw new Error('That image is too large to use (at most 10 MB).');
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('That image couldn’t be read. Try a PNG or JPG.'); }
  const side = Math.min(bmp.width, bmp.height);
  const draw = (size) => {
    const c = el('canvas', { width: String(size), height: String(size) });
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = !(side <= size && size % side === 0);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
    return c.toDataURL('image/png');
  };
  let url = draw(128);
  if (url.length > 87_000) url = draw(64); // past 64 KB as a PNG: a busy photo
  if (url.length > 87_000) throw new Error('That image is too detailed to use as an icon. Try a simpler one.');
  return url;
}

/* ---------- Admin → Layout: how each page is arranged (src/layout.js) ---------- */

// The page as a plan: its sections as blocks in the page's own 6-column grid, in its order and widths, each with a
// small drawing of what it shows. Blocks are dragged to move them (or moved with the arrow buttons), sized with ⅓ ½ ⅔
// Full, switched off into the tray under the plan, and their headings renamed. It's kept in Server's draft (srv), so
// it's saved with the Save bar, and it's tried on the real pages as it's changed: a strip on each page says so.

const LAYOUT_W_NAMES = { narrow: 'a third', half: 'half', wide: 'two thirds', full: 'full width' };

// What would change, one line per page: [] when nothing does.
function layoutChanges(baseRaw, draftRaw) {
  const base = fullLayout(baseRaw), draft = fullLayout(draftRaw);
  const out = [];
  for (const [page, info] of Object.entries(LAYOUT_PAGES)) {
    const nameOf = (id) => info.sections.find(([x]) => x === id)?.[1] || id;
    const a = base[page], b = draft[page];
    const what = [];
    const order = (list) => list.filter((s) => !s.hide).map((s) => s.id).join(' ');
    if (order(a) !== order(b) && a.map((s) => s.id).join() !== b.map((s) => s.id).join()) what.push('new order');
    for (const s of b) {
      const was = a.find((x) => x.id === s.id);
      if (!!was.hide !== !!s.hide) what.push(`${nameOf(s.id)} ${s.hide ? 'off' : 'on'}`);
      if (!s.hide && was.w !== s.w) what.push(`${nameOf(s.id)} ${LAYOUT_W_NAMES[s.w]}`);
      if ((was.title || '') !== (s.title || '')) what.push(s.title ? `${nameOf(s.id)} called “${s.title}”` : `${nameOf(s.id)} renamed back`);
    }
    if (info.tiles) {
      const ta = base.tiles[page], tb = draft.tiles[page];
      if (ta.map((t) => t.id).join() !== tb.map((t) => t.id).join()) what.push('tiles in a new order');
      for (const t of tb) {
        if (!!ta.find((x) => x.id === t.id).hide !== !!t.hide) what.push(`${info.tiles.find(([x]) => x === t.id)[1]} tile ${t.hide ? 'off' : 'on'}`);
      }
    }
    if (what.length) out.push(`${info.name} page layout: ${[...new Set(what)].join(', ')}`);
  }
  return out;
}

// On the dashboard's own pages, while a layout is being tried and isn't saved.
function renderLayoutNote(view) {
  const note = $('#layout-note');
  if (!note) return;
  const trying = view !== 'admin' && srv.draft && layoutChanges(srv.data.layout, srv.draft.layout).length;
  note.hidden = !trying;
  if (!trying) return;
  note.replaceChildren(el('strong', { text: 'You’re seeing a layout that isn’t saved. ' }),
    'Everyone else still sees the saved one. ', el('a', { href: '#/admin/layout', text: 'Back to Layout' }));
}

// The little drawings on the blocks: pixels on a 4px grid, in the ink and the accent.
function layoutGlyph(kind) {
  const s = sv('svg', { class: 'lay-glyph', viewBox: '0 0 64 28', 'aria-hidden': 'true', 'shape-rendering': 'crispEdges', preserveAspectRatio: 'xMinYMid meet' });
  const px = (x, y, w, h, cls = 'g1') => s.append(sv('rect', { x, y, width: w, height: h, class: cls }));
  if (kind === 'line') {
    const ys = [20, 16, 18, 12, 14, 8, 10, 4, 8, 12, 6, 10, 14, 10, 16, 12];
    ys.forEach((y, i) => { px(i * 4, y, 4, 4, 'ga'); px(i * 4, y + 4, 4, 24 - y, 'g0'); });
  } else if (kind === 'bars') {
    [10, 14, 6, 18, 12, 20, 8, 16, 22, 12, 6, 14].forEach((h, i) => px(i * 5 + 2, 26 - h, 3, h, i % 4 === 3 ? 'ga' : 'g1'));
  } else if (kind === 'rows') {
    for (let i = 0; i < 4; i++) { px(0, i * 7 + 1, 4, 4, 'g1'); px(8, i * 7 + 2, 26 - i * 4, 2, 'g1'); px(8, i * 7 + 5, 44 - i * 9, 2, 'ga'); }
  } else if (kind === 'grid') {
    const lv = ['g0', 'g1', 'ga', 'g1', 'g0', 'g0', 'ga'];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 9; x++) px(x * 7, y * 7, 6, 6, lv[(x * 3 + y * 5) % 7]);
  } else if (kind === 'tiles') {
    for (let i = 0; i < 4; i++) { px(i * 16, 0, 15, 18, 'g0'); px(i * 16 + 3, 4, 8, 6, 'g1'); }
    for (let i = 0; i < 4; i++) { px(i * 14, 22, 4, 4, 'ga'); px(i * 14 + 5, 23, 7, 2, 'g1'); }
  } else if (kind === 'about') {
    px(0, 2, 22, 22, 'ga'); px(4, 6, 6, 6, 'g0'); px(12, 14, 6, 6, 'g0');
    px(28, 4, 30, 5, 'g1'); px(28, 14, 34, 2, 'g0'); px(28, 19, 24, 2, 'g0');
  } else if (kind === 'score') {
    px(0, 2, 36, 6, 'ga'); px(36, 2, 28, 6, 'g1');
    for (let i = 0; i < 3; i++) { px(0, 13 + i * 5, 20, 3, 'g1'); px(44, 13 + i * 5, 20, 3, 'g1'); }
  } else if (kind === 'tree') {
    [[0, 10], [14, 2], [14, 18], [28, 2], [28, 10], [42, 18], [56, 10]].forEach(([x, y], i) => px(x, y, 8, 8, i % 3 ? 'g1' : 'ga'));
    px(8, 13, 6, 2, 'g0'); px(22, 5, 6, 2, 'g0'); px(36, 21, 6, 2, 'g0'); px(50, 13, 6, 2, 'g0');
  } else {
    px(0, 0, 64, 28, 'g0'); px(6, 6, 16, 16, 'ga'); px(28, 8, 28, 3, 'g1'); px(28, 15, 20, 3, 'g1');
  }
  return s;
}

const layoutUi = { page: 'home', rename: null, drag: null };

async function showLayoutAdmin() {
  showView('admin');
  if (!site.perms) {
    const r = DUMMY ? null : await api('/api/me').catch(() => null);
    if (r) setMe(r);
  }
  adminTab('layout');
  const root = $('#layout-admin');
  if (!site.admin || DUMMY) {
    root.replaceChildren(el('div', { class: 'card empty', text: DUMMY ? 'The sample data has no server to change.' : 'This page is only for admins.' }));
    return;
  }
  if (!srv.data) {
    root.replaceChildren(el('div', { class: 'card empty', text: 'Loading…' }));
    srv.data = await api('/api/admin/server');
  }
  srv.draft ??= srvDraftFrom(srv.data);
  renderLayoutAdmin();
}

function renderLayoutAdmin(focusKey = document.activeElement?.dataset?.fk) {
  const root = $('#layout-admin');
  const f = srv.draft;
  if (!f || !root) return;
  f.layout = fullLayout(f.layout);
  const page = layoutUi.page;
  const info = LAYOUT_PAGES[page];
  const list = f.layout[page];
  const nameOf = (id) => info.sections.find(([x]) => x === id);
  const changed = () => {
    applyLayout(fullLayout(f.layout));
    renderLayoutAdmin();
  };
  const btn = (text, cls, fk, run, attrs = {}) => {
    const b = el('button', { type: 'button', class: `btn ${cls}`, 'data-fk': fk, ...attrs }, ...(Array.isArray(text) ? text : [text]));
    b.addEventListener('click', run);
    return b;
  };
  const move = (id, to) => {
    const from = list.findIndex((s) => s.id === id);
    const [s] = list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, to > from ? to - 1 : to)), 0, s);
  };
  // the visible blocks, packed into rows as the page packs them
  const shown = list.filter((s) => !s.hide);
  const spans = new Map();
  {
    let row = [], used = 0;
    const close = () => { if (row.length) { spans.set(row.at(-1), spans.get(row.at(-1)) + 6 - used); row = []; used = 0; } };
    for (const s of shown) {
      const span = LAYOUT_SPAN[s.w];
      if (used + span > 6) close();
      spans.set(s.id, span);
      row.push(s.id);
      used += span;
    }
    close();
  }

  /* ---- which page ---- */
  const pages = el('div', { class: 'seg lay-pages', role: 'group', 'aria-label': 'Page' });
  for (const [p, pi] of Object.entries(LAYOUT_PAGES)) {
    const n = layoutChanges({ [p]: srv.data.layout[p], tiles: srv.data.layout.tiles }, { [p]: f.layout[p], tiles: f.layout.tiles }).filter((l) => l.startsWith(`${pi.name} `)).length;
    const b = el('button', { type: 'button', 'aria-pressed': String(p === page), 'data-fk': `lay:page:${p}` }, pi.name, n ? el('i', { class: 'adm-seg-dot', title: 'Unsaved changes' }) : null);
    b.addEventListener('click', () => { layoutUi.page = p; layoutUi.rename = null; renderLayoutAdmin(`lay:page:${p}`); });
    pages.append(b);
  }

  /* ---- the plan ---- */
  const plan = el('div', { class: 'lay-plan', role: 'list', 'aria-label': `${info.name} page, top to bottom` });
  const clearDrop = () => plan.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-side'));
  shown.forEach((s, i) => {
    const [, name, glyph, renamable, note] = nameOf(s.id);
    const block = el('div', { class: 'lay-block', role: 'listitem', draggable: 'true', 'data-id': s.id, style: `--span:${spans.get(s.id)}` });
    // width
    const widths = el('div', { class: 'seg lay-w', role: 'group', 'aria-label': `${name}: width` });
    for (const [w, label, full] of [['narrow', '⅓', 'A third'], ['half', '½', 'Half'], ['wide', '⅔', 'Two thirds'], ['full', 'Full', 'Full width']]) {
      const b = el('button', { type: 'button', 'aria-pressed': String(s.w === w), 'aria-label': full, title: full, text: label, 'data-fk': `lay:${s.id}:w:${w}` });
      b.addEventListener('click', () => { s.w = w; changed(); });
      widths.append(b);
    }
    const earlier = btn(icon(['M10 3.5 5.5 8l4.5 4.5'], 12), 'btn-quiet lay-mv', `lay:${s.id}:up`, () => { move(s.id, list.indexOf(shown[i - 1])); changed(); }, { 'aria-label': `Move ${name} earlier`, title: 'Earlier' });
    const later = btn(icon(['M6 3.5 10.5 8 6 12.5'], 12), 'btn-quiet lay-mv', `lay:${s.id}:down`, () => { move(s.id, list.indexOf(shown[i + 1]) + 1); changed(); }, { 'aria-label': `Move ${name} later`, title: 'Later' });
    earlier.disabled = i === 0;
    later.disabled = i === shown.length - 1;
    const off = btn('Hide', 'btn-quiet lay-off-btn', `lay:${s.id}:hide`, () => { s.hide = true; changed(); }, { 'aria-label': `Hide ${name}` });
    // a heading of its own
    let title = null;
    if (renamable) {
      if (layoutUi.rename === s.id) {
        title = el('input', { class: 'adm-input lay-title-in', type: 'text', maxlength: '40', placeholder: name, 'aria-label': `${name}: heading`, 'data-fk': `lay:${s.id}:title` });
        title.value = s.title || '';
        let closed = false;
        const done = () => {
          if (closed) return;
          closed = true;
          const v = title.value.trim().slice(0, 40);
          if (v) s.title = v; else delete s.title;
          layoutUi.rename = null;
          changed();
        };
        title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } if (e.key === 'Escape') { closed = true; layoutUi.rename = null; applyLayout(fullLayout(f.layout)); renderLayoutAdmin(); } });
        title.addEventListener('blur', done);
        title.addEventListener('input', () => { const h = document.querySelector(`.lay[data-page="${page}"] > [data-sec="${s.id}"] .card-head h2`); if (h) h.textContent = title.value.trim() || h.dataset.title0; });
      } else {
        title = btn(icon(['M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12z', 'M9.5 4l2.5 2.5'], 12), 'btn-quiet lay-mv', `lay:${s.id}:rename`, () => { layoutUi.rename = s.id; renderLayoutAdmin(`lay:${s.id}:title`); },
          { 'aria-label': `Rename ${name}`, title: 'Rename its heading' });
      }
    }
    block.append(...[
      el('div', { class: 'lay-block-head' },
        el('span', { class: 'lay-grip', 'aria-hidden': 'true', title: 'Drag to move' }),
        el('span', { class: 'lay-block-name' },
          el('strong', { text: s.title || name }), s.title ? el('span', { class: 'lay-was', text: name }) : null),
        layoutUi.rename === s.id ? null : title),
      layoutUi.rename === s.id ? title : layoutGlyph(glyph),
      note ? el('span', { class: 'lay-note', text: note }) : null,
      el('div', { class: 'lay-block-foot' }, widths, el('span', { class: 'lay-spacer' }), earlier, later, off),
    ].filter((n) => n != null));
    // dragging: the block it's over says before or after itself, by which half the pointer is in
    block.addEventListener('dragstart', (e) => {
      if (e.target.closest('input, button')) { e.preventDefault(); return; }
      layoutUi.drag = s.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', s.id);
      requestAnimationFrame(() => block.classList.add('dragging'));
    });
    block.addEventListener('dragend', () => { layoutUi.drag = null; block.classList.remove('dragging'); clearDrop(); });
    block.addEventListener('dragover', (e) => {
      if (!layoutUi.drag || layoutUi.drag === s.id) return;
      e.preventDefault();
      const r = block.getBoundingClientRect();
      // a block that fills the plan is stacked above the next one, so the drop is above or below it;
      // one sharing its row is beside its neighbours, so the drop is to the left or right
      const side = r.width < plan.getBoundingClientRect().width * 0.92 && spans.get(s.id) < 6;
      const before = side ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
      clearDrop();
      block.classList.add(before ? 'drop-before' : 'drop-after');
      if (side) block.classList.add('drop-side');
    });
    block.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = layoutUi.drag;
      if (!id || id === s.id) return;
      const before = block.classList.contains('drop-before');
      move(id, list.indexOf(s) + (before ? 0 : 1));
      layoutUi.drag = null;
      changed();
    });
    plan.append(block);
  });
  if (!shown.length) plan.append(el('div', { class: 'lay-empty muted', text: 'Every section is hidden. Show one from the list below.' }));

  /* ---- what's switched off ---- */
  const hidden = list.filter((s) => s.hide);
  const tray = el('div', { class: 'lay-tray' },
    el('h3', { text: hidden.length ? 'Hidden from the page' : 'Nothing hidden' }),
    hidden.length ? el('div', { class: 'lay-tray-list' }, ...hidden.map((s) => {
      const [, name, glyph] = nameOf(s.id);
      return el('div', { class: 'lay-chip' }, layoutGlyph(glyph), el('span', { text: s.title || name }),
        btn('Show', 'btn-quiet', `lay:${s.id}:show`, () => { delete s.hide; changed(); }, { 'aria-label': `Show ${name}` }));
    })) : el('span', { class: 'site-hint', text: 'Hide a section to leave it off the page for everyone. It can be shown again here.' }));

  /* ---- the number tiles ---- */
  let tilesCard = null;
  if (info.tiles) {
    const tiles = f.layout.tiles[page];
    const left = tiles.filter((t) => !t.hide).length;
    const row = el('div', { class: 'lay-tiles', role: 'list', 'aria-label': 'Number tiles, in order' });
    tiles.forEach((t, i) => {
      const label = info.tiles.find(([x]) => x === t.id)[1];
      const box = el('input', { type: 'checkbox', 'data-fk': `lay:tile:${t.id}` });
      box.checked = !t.hide;
      box.disabled = !t.hide && left === 1; // one stays, or the row would be an empty frame
      box.addEventListener('change', () => { if (box.checked) delete t.hide; else t.hide = true; changed(); });
      const mv = (by, label2, d) => {
        const b = btn(icon([d], 12), 'btn-quiet lay-mv', `lay:tile:${t.id}:${by}`, () => { const [x] = tiles.splice(i, 1); tiles.splice(i + by, 0, x); changed(); }, { 'aria-label': `Move ${label} ${label2}` });
        b.disabled = i + by < 0 || i + by >= tiles.length;
        return b;
      };
      row.append(el('div', { class: `lay-tile${t.hide ? ' off' : ''}`, role: 'listitem' },
        el('label', { class: 'adm-check' }, box, el('span', { text: label })),
        el('span', { class: 'lay-spacer' }),
        mv(-1, 'earlier', 'M10 3.5 5.5 8l4.5 4.5'), mv(1, 'later', 'M6 3.5 10.5 8 6 12.5')));
    });
    tilesCard = el('div', { class: 'lay-tiles-box' }, el('h3', { text: page === 'home' ? 'Number tiles in Right now' : 'Number tiles beside their model' }), row);
  }

  const isDefault = JSON.stringify(f.layout[page]) === JSON.stringify(defaultLayout()[page])
    && (!info.tiles || JSON.stringify(f.layout.tiles[page]) === JSON.stringify(defaultLayout().tiles[page]));
  const reset = btn('Back to the default', 'btn-quiet', 'lay:default', () => {
    f.layout[page] = defaultLayout()[page];
    if (info.tiles) f.layout.tiles[page] = defaultLayout().tiles[page];
    changed();
  });
  reset.disabled = isDefault;
  const look = info.href ? el('a', { class: 'btn', href: info.href, text: `Open ${info.name}` }) : el('span', { class: 'site-hint', text: 'Open any player to see it.' });

  root.replaceChildren(el('section', { class: 'card adm-card lay-card' },
    el('div', { class: 'card-head' }, el('h2', { text: 'Layout' }), el('span', { class: 'card-sub', text: 'what each page shows, in what order, and how wide; for everyone who looks' })),
    el('div', { class: 'lay-bar' }, pages, el('span', { class: 'lay-spacer' }), reset, look),
    el('p', { class: 'site-hint lay-how', text: 'Drag a block to move it, or use its arrows. Blocks fill each row left to right; the last one in a row stretches to the end. On phones every section is full width. Changes show on the pages as you make them, for you only, until they’re saved.' }),
    plan, tray, tilesCard));
  if (focusKey) root.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  renderAdminBar();
}

/* ---------- website analytics ---------- */

// Each page view, and each minute a page is open and visible, goes to /api/hit (src/analytics.js).
// Only the route is sent (home, chat, combat, admin, player:<uuid>); the server knows who's signed in.
const analyticsPage = () => {
  const m = location.hash.match(/^#\/player\/([0-9a-fA-F-]{36})$/);
  if (m) return `player:${m[1].toLowerCase()}`;
  if (onLive()) return 'live';
  if (location.hash.startsWith('#/admin')) return 'admin';
  return { '#/chat': 'chat', '#/combat': 'combat' }[location.hash] || 'home';
};
const onPhone = () => matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
function sendHit(beat) {
  if (DUMMY) return;
  const body = JSON.stringify({ page: analyticsPage(), beat, mobile: onPhone() });
  fetch('/api/hit', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
}
let lastView = null;
function countView() {
  const page = analyticsPage();
  if (page === lastView) return; // a re-render of the same page isn't another view
  lastView = page;
  sendHit(false);
}
setInterval(() => { if (document.visibilityState === 'visible' && lastView) sendHit(true); }, 60_000);

const stats = { days: 30, data: null, noAdmins: true };

/* ---------- roles: what each sign-in may do (super admins only) ---------- */

// One row per person the site knows about, one checkbox per permission; a change is saved at once
// (POST /api/admin/roles, src/roles.js). The two Liveview permissions are only the dashboard's half:
// the Minecraft server keeps its own list of who it lets in, shown in the last column.
const ROLE_PERMS = [
  ['view', 'View', 'See the dashboard: Activity, Combat, the Chat log and player pages'],
  ['chat', 'Chat', 'Send chat and whispers from the Chat log, as whoever “Chats as” says: the player their email is linked to on Players, or Admin'],
  ['admin', 'Admin page', 'Settings and Analytics on the admin page (not Roles)'],
  ['liveview', 'Liveview', 'Watch the world live. The Minecraft server also has to let the account in'],
  ['liveview_op', 'Liveview controls', 'Run commands and move items from Liveview. The Minecraft server also has to allow it'],
];
const roles = { data: null, busy: false };

async function rolesPost(body) {
  const res = await fetch('/api/admin/roles', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const r = await res.json().catch(() => null);
  if (!res.ok) throw new Error(r?.error || `the server answered ${res.status}`);
  return r;
}

// Making someone an owner: says what it gives and that this page can't take it back, and asks for the
// account password of whoever is doing it (checked by the server, src/roles.js). cancelled: puts the
// dropdown back when it's closed without doing it.
function ownerDialog(email, cancelled) {
  const me = MCS.account || MCS.email || '';
  const dialog = el('dialog', { class: 'lv-dialog sea-dialog' });
  const err = el('div', { class: 'lv-gate-error', role: 'alert' });
  const pass = el('input', { class: 'adm-input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Your mcstats account password' });
  const cancel = el('button', { class: 'btn', type: 'button', text: 'Cancel' });
  const submit = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Make owner' });
  submit.disabled = true;
  pass.addEventListener('input', () => { submit.disabled = !pass.value; });
  // the account the password belongs to, for password managers
  const user = el('input', { type: 'email', autocomplete: 'username', hidden: '', 'aria-hidden': 'true', tabindex: '-1' });
  user.value = me;
  const form = el('form', {},
    el('h2', { text: 'Make an owner' }),
    el('p', {}, el('strong', { text: email }), ' becomes an owner of this server.'),
    el('p', { text: 'An owner can do everything you can: change the address, the join password and who can see the server, use Roles, and make more owners.' }),
    el('p', { text: 'An owner can’t be changed back or removed from this page, by you or anyone else here. Only make owners of people you’d hand the server to.' }),
    user,
    el('label', { class: 'sea-confirm' }, el('span', {}, 'To confirm, type the password of your mcstats account', me ? el('span', { class: 'muted', text: ` (${me})` }) : null), pass),
    err, el('div', { class: 'range-actions' }, cancel, submit));
  dialog.append(form);
  let done = false;
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { dialog.remove(); if (!done) cancelled?.(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pass.value || submit.disabled) return;
    submit.disabled = cancel.disabled = true;
    err.textContent = '';
    try {
      roles.data = await rolesPost({ email, role: 'owner', password: pass.value });
      done = true;
      dialog.close();
      renderRoles();
      toast(`${email} is now an owner.`);
    } catch (ex) {
      err.textContent = ex.message.replace(/^./, (c) => c.toUpperCase());
      cancel.disabled = false;
      submit.disabled = !pass.value;
      pass.select();
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  pass.focus();
}

async function showRoles() {
  showView('admin');
  document.title = `Roles · ${SITE}`;
  const root = $('#roles');
  if (!site.perms) {
    const r = DUMMY ? null : await api('/api/me').catch(() => null);
    if (r) setMe(r);
  }
  adminTab('roles');
  if (!site.super) {
    root.replaceChildren(el('div', { class: 'card empty', text: 'This page is only for the server’s owners.' }));
    return;
  }
  if (!roles.data) root.replaceChildren(el('div', { class: 'card empty', text: 'Loading…' }));
  roles.data = await api('/api/admin/roles');
  renderRoles();
}

function renderRoles() {
  const d = roles.data;
  if (!d) return;
  const root = $('#roles');
  const save = async (body, undo) => {
    if (roles.busy) return;
    roles.busy = true;
    root.classList.add('adm-busy');
    try {
      roles.data = await rolesPost(body);
    } catch (err) {
      undo?.();
      toast(`That wasn’t saved: ${err.message}`, { error: true, ms: 5000 });
    } finally {
      roles.busy = false;
      root.classList.remove('adm-busy');
      renderRoles();
    }
  };
  const serverCell = (u) => {
    if (!d.linked) return el('span', { class: 'muted', text: 'server off' });
    if (u.server === 'control') return el('span', { class: 'role-server control', text: 'Watch and control', title: 'The Minecraft server lets this account watch and use controls' });
    if (u.server === 'viewer') return el('span', { class: 'role-server', text: 'Watch', title: 'The Minecraft server lets this account watch' });
    return el('span', { class: 'muted', text: 'Not let in', title: 'They enter the viewer key in the Liveview tab, or an operator runs /liveview access viewer with their email in game' });
  };
  const ago = (ts) => { const s = nowSec() - ts; return s < 120 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : fmt(ts, { month: 'short', day: 'numeric' }); };
  const roleCell = (u) => {
    if (u.super) return el('span', { class: 'an-tag', text: 'Super admin' });
    if (u.role === 'owner') return el('span', { class: 'an-tag', text: 'Owner' });
    const pick = el('select', { class: 'adm-input', 'aria-label': `Role for ${u.email}` },
      el('option', { value: '', text: 'Not a member' }), el('option', { value: 'member', text: 'Member' }), el('option', { value: 'admin', text: 'Admin' }),
      el('option', { value: 'owner', text: 'Owner…' }));
    pick.value = u.role || '';
    pick.addEventListener('change', () => {
      // an owner is made in its own dialog, with a password; closing it puts the dropdown back
      if (pick.value === 'owner') return ownerDialog(u.email, () => { pick.value = u.role || ''; });
      save(pick.value ? { email: u.email, role: pick.value } : { email: u.email, remove: true });
    });
    return pick;
  };
  const fixed = (u) => u.super || u.role === 'owner';
  // Who they send chat as (src/roles.js chat_as), so a Chat tick never promises more than it gives: a dropdown
  // between their player (the one their email is linked to on Players) and Admin, wherever there's a choice.
  const chatCell = (u) => {
    const member = !!(u.role || u.super);
    if (!member) return el('span', { class: 'muted', text: '–', title: 'Not a member, so they can’t chat' });
    if (!u.perms.chat) return el('span', { class: 'muted', text: 'Chat is off', title: 'Tick Chat to let them send chat from the Chat log' });
    const staff = u.super || u.role === 'owner' || u.role === 'admin';
    // an owner or admin with no player always sends as Admin: nothing to choose until they have one
    if (staff && !u.player) {
      return el('span', { class: 'role-chat-admin', text: 'Admin', title: 'Owners and admins with no player send as Admin. To chat as a player, link their email to one on Players.' });
    }
    const pick = el('select', { class: 'adm-input', 'aria-label': `Who ${u.email} chats as` },
      el('option', { value: 'player', text: u.player || 'Nobody yet' }), el('option', { value: 'admin', text: 'Admin' }));
    pick.value = u.chat_admin ? 'admin' : 'player';
    pick.title = u.chat_admin ? 'Their messages show with the yellow Admin tag instead of a name'
      : u.player ? `Their messages show as ${u.player}, the player their email is linked to on Players`
      : 'They can’t send chat until their email is linked to a player on Players, or they’re set to chat as Admin';
    pick.addEventListener('change', () => save({ email: u.email, chat_as: pick.value }, () => { pick.value = u.chat_admin ? 'admin' : 'player'; }));
    return pick;
  };
  // Reset (back to the role's ticks) and Remove (no longer a member), for anyone but an owner
  const actions = (u) => {
    if (fixed(u)) return null;
    const reset = u.custom ? el('button', { type: 'button', class: 'btn btn-quiet', text: 'Reset', title: 'Back to what the role gives' }) : null;
    reset?.addEventListener('click', () => save({ email: u.email, reset: true }));
    const remove = u.role ? el('button', { type: 'button', class: 'btn btn-quiet role-remove', text: 'Remove', 'aria-label': `Remove ${u.email}` }) : null;
    remove?.addEventListener('click', () => {
      const note = MCS.public
        ? 'They lose their role and ticks. The server is public, so they can still look, and they become a member again if they choose to use their account here.'
        : 'They lose their role and ticks, and can’t open the server again unless they have its join password.';
      if (confirm(`Remove ${u.email} from this server?\n\n${note}`)) save({ email: u.email, remove: true });
    });
    return reset || remove ? el('div', { class: 'role-acts' }, reset, remove) : null;
  };
  const body = d.users.map((u) => {
    const boxes = ROLE_PERMS.map(([key, label]) => {
      const box = el('input', { type: 'checkbox', 'aria-label': `${label} for ${u.email}` });
      box.checked = !!u.perms[key];
      box.disabled = fixed(u);
      box.addEventListener('change', () => save({ email: u.email, perms: { ...u.perms, [key]: box.checked } }, () => { box.checked = !box.checked; }));
      return el('td', { class: 'role-box' }, box);
    });
    return el('tr', { class: fixed(u) ? 'role-super' : '' },
      el('td', {},
        el('div', { class: 'role-who' }, el('span', { class: 'adm-ign', text: u.email }),
          u.custom && !fixed(u) ? el('span', { class: 'an-tag', text: 'Changed' }) : null),
        el('div', { class: 'role-sub muted', text: u.seen ? `here ${ago(u.seen)}` : 'hasn’t opened the site' })),
      el('td', {}, roleCell(u)),
      el('td', {}, chatCell(u)),
      ...boxes,
      el('td', {}, serverCell(u)),
      el('td', { class: 'adm-act' }, actions(u)));
  });
  const email = el('input', { class: 'adm-input', type: 'email', placeholder: 'someone@example.org', 'aria-label': 'Email to add', autocomplete: 'off' });
  const role = el('select', { class: 'adm-input', 'aria-label': 'Role' }, el('option', { value: 'member', text: 'Member' }), el('option', { value: 'admin', text: 'Admin' }),
    el('option', { value: 'owner', text: 'Owner…' }));
  const add = el('form', { class: 'adm-form role-add' }, email, role, el('button', { type: 'submit', class: 'btn', text: 'Add' }));
  add.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = email.value.trim().toLowerCase();
    if (!v) return;
    const known = d.users.find((u) => u.email === v && u.role);
    if (known) { toast(`${v} is already a member.`); return; }
    if (role.value === 'owner') return ownerDialog(v);
    save({ email: v, role: role.value });
  });
  root.replaceChildren(
    el('section', { class: 'card adm-card' },
      el('div', { class: 'card-head' }, el('h2', { text: 'Roles' }), el('span', { class: 'card-sub', text: 'who belongs to this server, and what they may do; a change is saved at once' })),
      el('p', { class: 'adm-note', text: 'Members are people who signed in here with their email, or were added below. A role sets the ticks: Owner gets everything, Admin everything but this tab, Member gets View and Chat; “Changed” means someone’s ticks differ from their role’s. Making someone an owner asks for your account password, and can’t be undone here. “Chats as” is who their messages from the Chat log come from: their player (the one their email is linked to on Players) or Admin, with the yellow Admin tag instead of a name. Being a member here means nothing on any other server. For Liveview a tick here is half of it: the Minecraft server keeps its own list of who it lets in, and only the server can change that (the viewer and control keys, or /liveview access in game).' }),
      el('div', { class: 'adm-table-wrap' }, el('table', { class: 'adm-table role-table' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'Sign-in' }),
          el('th', { text: 'Role' }),
          el('th', { text: 'Chats as', title: 'Who their messages from the Chat log come from: their player, or Admin' }),
          ...ROLE_PERMS.map(([, label, title]) => el('th', { class: 'role-box', text: label, title })),
          el('th', { text: 'Minecraft server', title: 'What the server itself lets this account do in Liveview' }),
          el('th', {}))),
        el('tbody', {}, ...body))),
      el('p', { class: 'adm-note', text: 'Add someone before they’ve signed in, to set what they can do when they do (they sign in with this email on this server):' }),
      add));
}

async function showAnalytics({ refresh = false } = {}) {
  showView('admin');
  adminTab('analytics');
  document.title = `Analytics · ${SITE}`;
  const root = $('#analytics');
  if (!site.admin) {
    const r = DUMMY ? null : await api('/api/me').catch(() => null);
    if (r) setMe(r);
  }
  if (!site.admin) {
    root.replaceChildren(el('div', { class: 'card empty', text: 'This page is only for admins.' }));
    return;
  }
  if (!stats.data && !refresh) root.replaceChildren(el('div', { class: 'card empty', text: 'Loading…' }));
  stats.data = await api(`/api/admin/analytics?days=${stats.days}`);
  renderAnalytics();
}

function renderAnalytics() {
  const d = stats.data;
  if (!d) return;
  const root = $('#analytics');
  const rows = d.rows.filter((r) => !(stats.noAdmins && d.visitors[r.visitor]?.admin));
  const who = (v) => d.visitors[v]?.name || v;
  const pageName = (p) => (p.startsWith('player:') ? `Player · ${d.players[p.slice(7)] || 'unknown'}` : { home: 'Activity', chat: 'Chat log', combat: 'Combat', admin: 'Admin' }[p] || p);
  const time = (min) => (min < 60 ? `${min} min` : `${fmtHours(min / 60)} h`);
  const dayTs = (day) => Date.parse(`${day}T00:00:00Z`) / 1000;

  // the range's days, oldest first
  const days = [];
  for (let t = dayTs(d.from); t <= dayTs(d.today); t += 86400) days.push(new Date(t * 1000).toISOString().slice(0, 10));
  const byDay = new Map(days.map((x) => [x, { visitors: new Set(), views: 0, minutes: 0 }]));
  const pages = new Map(), people = new Map();
  for (const r of rows) {
    const b = byDay.get(r.day);
    if (b) { b.visitors.add(r.visitor); b.views += r.views; b.minutes += r.minutes; }
    const p = pages.get(r.page) || pages.set(r.page, { views: 0, minutes: 0, visitors: new Set() }).get(r.page);
    p.views += r.views; p.minutes += r.minutes; p.visitors.add(r.visitor);
    const v = people.get(r.visitor) || people.set(r.visitor, { views: 0, minutes: 0, days: new Set(), last: 0, mobile: false }).get(r.visitor);
    v.views += r.views; v.minutes += r.minutes; v.days.add(r.day); v.last = Math.max(v.last, r.last_ts); v.mobile ||= !!r.mobile;
  }
  const total = { views: 0, minutes: 0 };
  for (const r of rows) { total.views += r.views; total.minutes += r.minutes; }
  const newCount = [...people.keys()].filter((v) => d.visitors[v]?.first >= d.from).length;
  const phones = [...people.values()].filter((v) => v.mobile).length;

  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Range' }, ...[[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, 'Year']].map(([n, text]) => {
    const b = el('button', { type: 'button', text, 'aria-pressed': String(stats.days === n) });
    b.addEventListener('click', () => { if (stats.days !== n) { stats.days = n; showAnalytics({ refresh: true }).catch((e) => showError(e.message)); } });
    return b;
  }));
  const box = el('input', { type: 'checkbox' });
  box.checked = stats.noAdmins;
  box.addEventListener('change', () => { stats.noAdmins = box.checked; renderAnalytics(); });
  const controls = el('div', { class: 'an-controls' }, seg, el('label', { class: 'an-check' }, box, ' Leave out admins'));

  const tile = (label, value, sub) => el('div', { class: 'tile' }, el('div', { class: 'tile-label', text: label }), el('div', { class: 'tile-value', text: value }), el('div', { class: 'tile-sub', text: sub }));
  const range = stats.days === 365 ? 'last year' : `last ${stats.days} days`;
  const tiles = el('div', { class: 'tiles' },
    tile('Visitors', people.size.toLocaleString(), newCount ? `${newCount} new · ${range}` : range),
    tile('Page views', total.views.toLocaleString(), range),
    tile('Time on the site', time(total.minutes), people.size ? `${time(Math.round(total.minutes / people.size))} per visitor` : 'with the page open'),
    tile('On a phone', people.size ? `${Math.round((phones / people.size) * 100)}%` : '–', `${phones} of ${people.size} visitors`));

  const chart = el('div', { class: 'chart an-chart' });
  const key = (color, text) => el('span', {}, el('span', { class: 'key', style: `background:${color}` }), text);
  const legend = el('div', { class: 'legend' }, key('var(--series-1)', 'Visitors'), key('var(--series-2)', 'Page views'));
  const chartCard = el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: 'Each day' }), el('span', { class: 'card-sub', text: 'days in UTC' })), legend, chart);

  const table = (head, body) => body.length
    ? el('div', { class: 'an-scroll' }, el('table', { class: 'an-table' }, el('thead', {}, el('tr', {}, ...head.map((h, i) => el('th', { class: i ? 'num' : '', text: h })))), el('tbody', {}, ...body)))
    : el('div', { class: 'muted adm-empty', text: 'No visits in this range yet.' });
  const pageRows = [...pages].sort((a, b) => b[1].views - a[1].views || b[1].minutes - a[1].minutes).map(([p, x]) => {
    const name = p.startsWith('player:') ? el('a', { href: `#/player/${p.slice(7)}`, text: pageName(p) }) : pageName(p);
    return el('tr', {}, el('td', {}, name), el('td', { class: 'num', text: x.views.toLocaleString() }), el('td', { class: 'num', text: x.visitors.size }), el('td', { class: 'num', text: time(x.minutes) }));
  });
  const ago = (ts) => { const s = nowSec() - ts; return s < 120 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : fmt(ts, { month: 'short', day: 'numeric' }); };
  const personRows = [...people].sort((a, b) => b[1].last - a[1].last).map(([v, x]) => el('tr', {},
    el('td', {}, who(v), d.visitors[v]?.first >= d.from ? el('span', { class: 'an-tag', text: 'new' }) : null, x.mobile ? el('span', { class: 'an-tag', text: 'phone', title: 'Visited on a phone' }) : null),
    el('td', { class: 'num', text: x.views.toLocaleString() }), el('td', { class: 'num', text: x.days.size }), el('td', { class: 'num', text: time(x.minutes) }), el('td', { class: 'num muted', text: ago(x.last) })));

  root.replaceChildren(controls, tiles, chartCard,
    el('div', { class: 'grid2' },
      el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: 'Pages' })), table(['Page', 'Views', 'Visitors', 'Time'], pageRows)),
      el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: 'Visitors' }), el('span', { class: 'card-sub', text: 'by login' })), table(['Who', 'Views', 'Days', 'Time', 'Last seen'], personRows))),
    el('p', { class: 'adm-intro', text: 'Counted by the site itself: a view each time someone opens a page, and a minute for each minute a page is open and visible. Only signed-in visitors can reach the site, so each one is counted by their login.' }));

  const pts = (f) => days.map((x) => ({ t: dayTs(x), v: f(byDay.get(x)) }));
  renderLineChart(chart, {
    key: `analytics:${stats.days}`, from: dayTs(days[0]), to: dayTs(days[days.length - 1]), step: 86400, yScale: (vmax) => {
      const ystep = niceStep(Math.max(1, Math.max(vmax, 10) / 4));
      return { ymax: Math.max(10, Math.ceil(vmax / ystep) * ystep), ystep };
    },
    series: [
      { name: 'visitors', cls: '1', color: 'var(--series-1)', area: true, pts: pts((b) => b.visitors.size) },
      { name: 'views', cls: '2', color: 'var(--series-2)', pts: pts((b) => b.views) },
    ],
    fmtValue: (v) => String(Math.round(v)),
    fmtTime: (t) => fmtDay(new Date(t * 1000).toISOString().slice(0, 10), { weekday: 'short', month: 'short', day: 'numeric' }),
  });
}

// Runs one of the things that happen at once, then reloads the lists. Unsaved changes stay as they are.
async function adminDo(body, done) {
  if (admin.busy) return;
  admin.busy = true;
  $('#admin').classList.add('adm-busy');
  try {
    await adminPost(body);
    if (done) toast(done);
    admin.data = await api('/api/admin');
    admin.loadedAt = Date.now();
  } catch (err) {
    if (err instanceof DbLimitError) showError(err.message);
    toast(err.message, { error: true });
  } finally {
    admin.busy = false;
    $('#admin').classList.remove('adm-busy');
    renderAdmin();
  }
}

// Save: every part of the draft that differs from what's saved, in one request (all of it or none).
// Whether it was saved.
async function adminSave() {
  if (admin.busy || !admin.draft) return false;
  const changes = adminChanges();
  const d = admin.draft;
  const body = { action: 'config.save' };
  if (changes.teams.length) body.teams = d.teams.map(({ id, name, short, color, bar, middle, chart, activity, activity_with }) => ({ id, name, short, color, bar, middle, chart, activity, activity_with }));
  if (changes.roster.length) body.roster = d.roster.map(({ ign, team, egg, name }) => ({ ign, team, egg: egg || null, name: name || '' }));
  if (changes.history.length) body.history = d.history.map(({ ign, team, until }) => ({ ign, team, until }));
  if (changes.hidden.length) body.hidden = d.hidden.map(({ name, note }) => ({ name, note: note || null }));
  if (changes.aliases.length) body.aliases = d.aliases.map(({ alias, name }) => ({ alias, name }));
  if (changes.emails.length) body.emails = d.emails.map(({ email, ign }) => ({ email, ign }));
  if (Object.keys(body).length === 1) return true;
  admin.busy = true;
  $('#admin').classList.add('adm-busy');
  renderAdminBar();
  let ok = false;
  try {
    await adminPost(body);
    admin.data = await api('/api/admin');
    admin.loadedAt = Date.now();
    admin.draft = adminDraftFrom(admin.data);
    await reloadRoster();
    toast('Saved');
    ok = true;
  } catch (err) {
    if (err instanceof DbLimitError) showError(err.message);
    toast(`Not saved: ${err.message}`, { error: true, ms: 6000 });
  } finally {
    admin.busy = false;
    $('#admin').classList.remove('adm-busy');
    if (ADMIN_SECTIONS[admin.tab][0] === 'admin') renderAdmin();
    else renderAdminBar();
  }
  return ok;
}

async function reloadRoster() {
  const r = await api('/api/roster');
  roster.clear();
  rosterAliases.clear();
  for (const a of r.aliases || []) rosterAliases.set(a.alias.toLowerCase(), a.name.toLowerCase());
  for (const p of r.players || []) roster.set(p.ign.toLowerCase(), p);
  setTeams(r.teams, r.players);
  setTeamHistory(r.history);
  syncHeatToggle();
  syncTlTeamToggle();
}

// A field that was typed in changes the draft without redrawing the page, so the click that took the
// focus away still lands on what it was aimed at; the page is redrawn right after that click (or at
// once, when the focus left by keyboard).
let admPointerDown = false;
document.addEventListener('pointerdown', () => { admPointerDown = true; }, true);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => {
    admPointerDown = false;
    if (admin.stale) setTimeout(adminRedrawIfStale, 0);
  }, true);
}
function adminRedrawIfStale() {
  if (admin.stale && !admin.busy && !$('#view-admin').hidden && !$('#admin').hidden) renderAdmin();
}
function adminEdited() {
  admin.stale = true;
  renderAdminBar();
  if (!admPointerDown) setTimeout(adminRedrawIfStale, 0);
}

const IGN_OK = /^[A-Za-z0-9_]{1,32}$/;
const EMAIL_OK = /^[^\s@"'<>,;]{1,64}@[^\s@"'<>,;]{1,180}\.[^\s@"'<>,;]{2,}$/;
const playerHref = (name) => `#/admin/players/${encodeURIComponent(name)}`;

// Admin → Mod and commands: a switch was clicked. Saved at once (POST /api/admin/server, src/serveradmin.js);
// the mod hears straight away if it's connected, and the Activity page's box follows on this page.
async function commandsSave(body, fk, done, game = false) {
  if (admin.cmdBusy || !admin.data?.commands) return;
  admin.cmdBusy = true;
  try {
    const res = await fetch('/api/admin/server', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await res.json().catch(() => null);
    if (!res.ok || !r?.commands) throw new Error(r?.error || `The server answered ${res.status}.`);
    const c = admin.data.commands = { ...admin.data.commands, ...r.commands };
    MCS.commands = r.commands;
    if (srv.data) srv.data.commands = r.commands;
    renderCommands();
    const where = !game ? '' : c.supported === false ? ` · in game once the mod is ${c.needs} or newer`
      : r.commands_told ? ' in game now' : ' · the mod isn’t connected, so in game once it is';
    toast(`${done}${where}`, { ms: where.length > 12 ? 5000 : 3000 });
  } catch (err) {
    toast(`Not saved: ${err.message}`, { error: true, ms: 5000 });
  } finally {
    admin.cmdBusy = false;
    if (admin.tab === 'mod') renderAdmin();
    document.querySelector(`#admin [data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
  }
}

function renderAdmin() {
  const d = admin.data;
  if (!d) return;
  admin.draft ??= adminDraftFrom(d);
  admin.stale = false;
  admPointerDown = false;
  const draft = admin.draft;
  const changes = adminChanges();
  const focusKey = document.activeElement?.dataset?.fk;
  const lower = (v) => v.toLowerCase();
  const redraw = () => renderAdmin();
  const section = ADMIN_SECTIONS[admin.tab]?.[0] === 'admin' ? admin.tab : 'players';

  const teamList = draft.teams;
  const teamIds = [...new Set([...teamList.map((t) => t.id), ...draft.roster.map((r) => r.team)])];
  const teamName = (id) => teamList.find((x) => x.id === id)?.name || (id ? id[0].toUpperCase() + id.slice(1) : 'No team');
  // columns the server's add-ons put on the roster (the Egg SMP add-on: Egg)
  const rosterCols = addons('rosterColumn');
  const players = el('datalist', { id: 'adm-players' }, ...d.players.map((n) => el('option', { value: n })));
  const select = (options, value, label, fk) => {
    const s = el('select', { class: 'adm-input', 'aria-label': label, 'data-fk': fk });
    for (const [v, text] of options) s.append(el('option', { value: v, text }));
    if (value != null && !options.some(([v]) => v === value)) s.append(el('option', { value, text: value })); // a team that's gone
    s.value = value ?? '';
    return s;
  };
  const teamSelect = (v, fk) => select(teamIds.map((t) => [t, teamName(t)]), v, 'Team', fk);
  const colSelect = (c, v, fk) => select([['', c.none], ...c.options], v, c.title, fk);
  const button = (text, onClick, cls = '', fk = null) => {
    const b = el('button', { type: 'button', class: `btn ${cls}`, text, 'data-fk': fk });
    b.addEventListener('click', onClick);
    return b;
  };
  const nameInput = (placeholder, fk) => el('input', { class: 'adm-input', type: 'text', placeholder, 'aria-label': placeholder, list: 'adm-players', maxlength: '32', autocomplete: 'off', spellcheck: 'false', 'data-fk': fk });
  const card = (title, sub, ...kids) => el('section', { class: 'card adm-card' },
    el('div', { class: 'card-head' }, el('h2', { text: title }), sub ? el('span', { class: 'card-sub', text: sub }) : null), ...kids);
  const empty = (text) => el('div', { class: 'muted adm-empty', text });
  const when = (ms) => fmt(ms / 1000, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const unsaved = (text = 'not saved yet') => el('span', { class: 'adm-unsaved', text });
  const onEnter = (input, run) => input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  const field = (label, control, hint) => el('div', { class: 'site-field adm-field' },
    el('span', { class: 'site-label', text: label }), control, hint ? el('span', { class: 'site-hint', text: hint }) : null);

  /* ---- the teams themselves: name, color, order, and how much of the dashboard each is part of ---- */
  const onTeam = (id) => draft.roster.filter((r) => r.team === id).length;
  const ownSeries = (t) => t.activity && !t.activity_with;
  const arrow = (i, by, label) => {
    const b = el('button', { type: 'button', class: 'btn btn-quiet adm-arrow', 'aria-label': label, title: label, 'data-fk': `team:${teamList[i].id}:${by}` },
      icon([by < 0 ? 'M3.5 10 8 5.5 12.5 10' : 'M3.5 6 8 10.5 12.5 6'], 12));
    b.disabled = i + by < 0 || i + by >= teamList.length;
    b.addEventListener('click', () => {
      [teamList[i], teamList[i + by]] = [teamList[i + by], teamList[i]];
      redraw();
    });
    return b;
  };
  const teamRows = teamList.map((t, i) => {
    const base = (d.teams || []).find((x) => x.id === t.id);
    const name = el('input', { class: 'adm-input', type: 'text', value: t.name, maxlength: '40', 'aria-label': 'Name', 'data-fk': `team:${t.id}:name` });
    const short = el('input', { class: 'adm-input adm-short', type: 'text', value: t.short, maxlength: '16', 'aria-label': 'Short name', 'data-fk': `team:${t.id}:short` });
    const color = el('input', { class: 'adm-color', type: 'color', value: t.color, 'aria-label': 'Color', title: 'Color (a lighter shade of it is used on a dark page)', 'data-fk': `team:${t.id}:color` });
    name.addEventListener('change', () => { if (name.value.trim()) t.name = name.value.trim().slice(0, 40); else name.value = t.name; adminEdited(); });
    short.addEventListener('change', () => { if (short.value.trim()) t.short = short.value.trim().slice(0, 16); else short.value = t.short; adminEdited(); });
    color.addEventListener('change', () => { t.color = color.value; redraw(); });
    // the Combat scoreboard: a side (or block) of its own, in the middle of the two sides, or not at all
    const bar = select([['show', 'Shown'], ['middle', 'In the middle'], ['hide', 'Hidden']], !t.bar ? 'hide' : t.middle ? 'middle' : 'show', 'Combat scoreboard', `team:${t.id}:bar`);
    bar.title = 'The Combat page’s scoreboard bar. In the middle: between the two sides of the bar, with no kills and deaths headline of its own: its deaths, with its kills of each side beside them.';
    bar.addEventListener('change', () => { t.bar = bar.value !== 'hide'; t.middle = bar.value === 'middle'; redraw(); });
    const chart = el('input', { type: 'checkbox', 'data-fk': `team:${t.id}:chart` });
    chart.checked = !!t.chart;
    chart.addEventListener('change', () => { t.chart = chart.checked; redraw(); });
    // the Activity page's by-team charts: a series of its own, none, or counted in another team's
    const hosts = teamList.filter((x) => x !== t && ownSeries(x));
    const activity = select([['show', 'Show'], ['hide', 'Hide'], ...hosts.map((x) => [`with:${x.id}`, `Group with ${x.short}`])],
      t.activity_with ? `with:${t.activity_with}` : t.activity ? 'show' : 'hide', 'Activity charts', `team:${t.id}:activity`);
    activity.title = 'The Activity page’s by-team charts: Players online, Daily activity and Busiest times. Group with: the team isn’t shown there, and its players’ time counts as the other team’s.';
    activity.addEventListener('change', () => {
      t.activity = activity.value === 'show';
      t.activity_with = activity.value.startsWith('with:') ? activity.value.slice(5) : null;
      // a team that was counted in this one has nowhere to count once this one has no series of its own
      if (!ownSeries(t)) for (const x of teamList) if (x.activity_with === t.id) { x.activity_with = null; x.activity = false; }
      redraw();
    });
    const n = onTeam(t.id);
    return el('tr', { class: !base ? 'adm-row-new' : changes.teams.some((c) => c.startsWith(`${t.name}:`)) ? 'adm-row-changed' : '' },
      el('td', { class: 'adm-order' }, arrow(i, -1, 'Move up'), arrow(i, 1, 'Move down')),
      el('td', {}, color), el('td', {}, name), el('td', {}, short),
      el('td', {}, bar),
      el('td', {}, el('label', { class: 'adm-check', title: 'Its kills as their own color in the Combat page’s chart (otherwise with the other deaths)' }, chart, 'Own color')),
      el('td', {}, activity),
      el('td', { class: 'muted adm-count', text: `${n} ${n === 1 ? 'player' : 'players'}` }),
      el('td', { class: 'adm-act' }, !n ? button('Remove', () => {
        draft.teams = teamList.filter((x) => x !== t);
        for (const x of draft.teams) if (x.activity_with === t.id) { x.activity_with = null; x.activity = false; }
        redraw();
      }, 'btn-quiet', `team:${t.id}:remove`) : null));
  });
  const newTeamName = el('input', { class: 'adm-input', type: 'text', placeholder: 'New team’s name', 'aria-label': 'New team’s name', maxlength: '40', 'data-fk': 'team-new:name' });
  const newTeamColor = el('input', { class: 'adm-color', type: 'color', value: '#7a7f87', 'aria-label': 'Color' });
  const addTeam = () => {
    const name = newTeamName.value.trim();
    if (!name) return;
    if (teamList.length >= 12) return toast('At most 12 teams', { error: true });
    // its id: the first word, as lowercase letters and digits (what the roster calls it)
    let id = name.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9-]/g, '').replace(/^[^a-z]+/, '').slice(0, 20);
    if (!id) id = 'team';
    const taken = (x) => teamList.some((t) => t.id === x) || (d.teams || []).some((t) => t.id === x);
    for (let k = 2; taken(id); k++) id = `${id.replace(/\d+$/, '').slice(0, 18)}${k}`;
    teamList.push({ id, name: name.slice(0, 40), short: name.split(/\s+/)[0].slice(0, 16), color: newTeamColor.value, color_dark: null, bar: true, middle: false, chart: true, activity: true, activity_with: null });
    redraw();
  };
  onEnter(newTeamName, addTeam);
  const teamsCard = () => card('Teams', 'listed and stacked in this order',
    teamList.length ? el('div', { class: 'adm-table-wrap' }, el('table', { class: 'adm-table adm-teams' },
      el('thead', {}, el('tr', {}, ...['', 'Color', 'Name', 'Short', 'Combat scoreboard', 'Kills chart', 'Activity charts', '', ''].map((h) => el('th', { text: h })))),
      el('tbody', {}, ...teamRows))) : empty('No teams yet. Add one to put players on it.'),
    el('div', { class: 'adm-form adm-team-add' }, newTeamColor, newTeamName, button('Add team', addTeam, 'btn-primary')),
    el('p', { class: 'muted adm-note', text: 'Combat scoreboard: with two teams shown it’s the tug-of-war bar; with one, or three or more, each gets a block. A team “in the middle” sits between the two sides of the bar. Activity charts: “Group with” leaves the team out of the by-team charts and counts its players’ time as the other team’s. A team left out of a chart still has its players, in their color, everywhere else.' }));

  /* ---- a player's team, and their teams over time ---- */
  const now = nowSec();
  const seasonFrom = Math.min(now - 3600, Math.max(d.lo || 0, state.dataStart || 0) || now - 30 * 86400);
  const periodsOf = (ign) => draft.history.filter((h) => lower(h.ign) === lower(ign)).sort((a, b) => a.until - b.until);
  const minute = (ts) => fmt(ts, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const teamColor = (id) => teamList.find((x) => x.id === id)?.color || null;
  const dot = (id) => el('i', { class: 'adm-dot', style: teamColor(id) ? `background:${teamColor(id)}` : '' });

  // A change of team counts from now on: before now, they were on the team they had. The time can be
  // changed, and removing that earlier team makes the new one count for everything.
  const changeTeam = (r, team) => {
    const key = lower(r.ign);
    const base = d.roster.find((x) => lower(x.ign) === key);
    const was = r.team;
    r.team = team;
    const auto = draft.history.find((h) => h.auto && lower(h.ign) === key);
    if (auto) {
      if (auto.team === r.team) draft.history = draft.history.filter((h) => h !== auto); // changed back
    } else if (base && was !== r.team) {
      draft.history.push({ ign: r.ign, team: was, until: nowSec(), auto: true });
    }
  };

  // from the season's start to now, in the colors of the teams they were on
  const timeline = (r, periods) => {
    const bar = el('div', { class: 'adm-tl', role: 'img', 'aria-label': `${r.ign}’s teams over the season` });
    let t = seasonFrom;
    for (const [team, end] of [...periods.map((h) => [h.team, h.until]), [r.team, now]]) {
      const to = Math.min(now, Math.max(t, end));
      if (to > t) {
        bar.append(el('span', {
          class: `adm-tl-seg${team ? '' : ' none'}`, style: `flex-grow:${to - t};${teamColor(team) ? `background:${teamColor(team)}` : ''}`,
          title: `${teamName(team)}: ${t === seasonFrom ? 'the start of the season' : minute(t)} – ${to === now ? 'now' : minute(to)}`,
        }));
      }
      t = to;
    }
    return bar;
  };

  const periodEditor = (r) => {
    const periods = periodsOf(r.ign);
    const key = lower(r.ign);
    const rows = periods.map((h, i) => {
      const team = select([...teamIds.map((t) => [t, teamName(t)]), ['', 'No team']], h.team, 'Team then', `per:${key}:${i}:team`);
      team.addEventListener('change', () => { h.team = team.value; delete h.auto; redraw(); });
      const until = el('input', { class: 'adm-input adm-time', type: 'datetime-local', value: localInput(h.until), max: localInput(now), 'aria-label': 'Until', 'data-fk': `per:${key}:${i}:until` });
      until.addEventListener('change', () => {
        const [date, time] = until.value.split('T');
        const [hh, mm] = (time || '').split(':').map(Number);
        const ts = date && Number.isFinite(hh) && Number.isFinite(mm) ? zonedTs(date, hh, mm) : NaN;
        if (!Number.isFinite(ts) || ts <= 0) { until.value = localInput(h.until); return; }
        if (ts > nowSec()) { until.value = localInput(h.until); return toast('That time hasn’t come yet', { error: true }); }
        if (periods.some((x) => x !== h && x.until === ts)) { until.value = localInput(h.until); return toast(`${r.ign} already has an earlier team ending then`, { error: true }); }
        h.until = ts;
        delete h.auto;
        adminEdited();
      });
      return el('div', { class: 'adm-period' },
        dot(h.team), team,
        el('span', { class: 'muted adm-period-from', text: i ? `from ${minute(periods[i - 1].until)}` : 'from the start' }),
        el('span', { class: 'muted', text: 'until' }), until,
        button('Remove', () => { draft.history = draft.history.filter((x) => x !== h); redraw(); }, 'btn-quiet', `per:${key}:${i}:remove`));
    });
    const last = periods.at(-1);
    const add = button('Add an earlier team', () => {
      // before everything there is so far (a day before the first change, or an hour ago), on another team than what follows
      const first = periods[0];
      let until = first ? Math.max(seasonFrom + 3600, first.until - 86400) : now - 3600;
      while (periods.some((x) => x.until === until)) until -= 60;
      const after = first ? first.team : r.team;
      draft.history.push({ ign: r.ign, team: teamIds.find((t) => t !== after) ?? '', until: Math.floor(until / 60) * 60 });
      redraw();
    }, 'btn-quiet', `per:${key}:add`);
    return el('div', { class: 'adm-periods' },
      timeline(r, periods),
      ...rows,
      el('div', { class: 'adm-period adm-period-now' }, dot(r.team), el('strong', { text: teamName(r.team) }),
        el('span', { class: 'muted', text: last ? `from ${minute(last.until)} on, and now` : 'the whole season, and now' })),
      el('div', { class: 'adm-form adm-period-add' }, add));
  };

  /* ---- the roster at a glance (Teams): everyone's team in one table ---- */
  const rosterCard = () => {
    const rows = draft.roster.map((r) => {
      const key = lower(r.ign);
      const base = d.roster.find((x) => lower(x.ign) === key);
      const team = teamSelect(r.team, `ros:${key}:team`);
      team.addEventListener('change', () => { changeTeam(r, team.value); redraw(); });
      const extras = rosterCols.map((c) => {
        const sel = colSelect(c, r[c.key], `ros:${key}:${c.key}`);
        sel.addEventListener('change', () => { r[c.key] = sel.value || null; redraw(); });
        return el('td', {}, sel);
      });
      const periods = periodsOf(r.ign);
      const changed = !base ? 'adm-row-new' : playerState(d, key) !== playerState(draft, key) ? 'adm-row-changed' : '';
      return el('tr', { class: changed },
        el('td', { class: 'adm-ign' }, el('a', { href: playerHref(r.ign), class: 'adm-ign-link' }, headImg(r.ign, 16, { class: 'adm-head16' }), r.ign), !base ? unsaved('new') : null),
        el('td', {}, team), ...extras,
        el('td', { class: 'adm-tl-cell' }, periods.length ? timeline(r, periods) : el('span', { class: 'muted', text: '—' })),
        el('td', { class: 'adm-act' }, el('a', { class: 'btn btn-quiet', href: playerHref(r.ign), text: 'Edit' })));
    });
    const newIgn = nameInput('IGN', 'ros-new:ign'), newTeam = teamSelect(teamIds[0], 'ros-new:team'), newExtras = rosterCols.map((c) => colSelect(c, ''));
    const addPlayer = () => {
      const ign = newIgn.value.trim();
      if (!ign) return;
      if (!IGN_OK.test(ign)) return toast('An IGN is letters, digits and underscores', { error: true });
      if (draft.roster.some((x) => lower(x.ign) === lower(ign))) return toast(`${ign} is already on the roster`, { error: true });
      if (!newTeam.value) return toast('Add a team first', { error: true });
      const was = d.roster.find((x) => lower(x.ign) === lower(ign)); // taken off and put back: as they were known
      draft.roster.push({ ign: was?.ign || ign, team: newTeam.value, egg: null, name: was?.name || '', ...Object.fromEntries(rosterCols.map((c, i) => [c.key, newExtras[i].value || null])) });
      redraw();
    };
    onEnter(newIgn, addPlayer);
    const addRow = el('tr', { class: 'adm-add' }, el('td', {}, newIgn), el('td', {}, newTeam), ...newExtras.map((x) => el('td', {}, x)), el('td', {}),
      el('td', { class: 'adm-act' }, button('Add', addPlayer, 'btn-primary')));
    return card('Roster', `who’s on which team in Season ${d.season}`,
      el('div', { class: 'adm-table-wrap' }, el('table', { class: 'adm-table adm-roster' },
        el('thead', {}, el('tr', {}, ...['Player', 'Team', ...rosterCols.map((c) => c.title), 'Teams over time', ''].map((h) => el('th', { text: h })))),
        el('tbody', {}, ...rows, addRow))),
      el('p', { class: 'adm-note adm-from-now' }, el('strong', { text: 'A team change counts from now on. ' }),
        'What they did before stays with the team they were on then. Edit the player to move that moment, or to have everything count for the new team.'));
  };

  /* ---- Players: everyone the server has seen, and one player's editor ---- */
  const playersView = () => {
    const people = new Map();
    const add = (n) => { if (n && !people.has(lower(n))) people.set(lower(n), n); };
    for (const r of draft.roster) add(r.ign);
    for (const r of d.roster) add(r.ign);
    for (const n of d.players) add(n);
    for (const h of draft.hidden) add(h.name);
    for (const a of draft.aliases) { add(a.alias); add(a.name); }
    for (const e of draft.emails) add(e.ign);
    const pick = admin.pick && (people.has(admin.pick) || IGN_OK.test(admin.pick)) ? admin.pick : null;
    if (pick && !people.has(pick)) add(decodeURIComponent(location.hash.split('/').pop() || pick));
    const changed = changedPlayers();
    const about = (key) => ({
      name: people.get(key),
      r: draft.roster.find((x) => lower(x.ign) === key),
      hidden: draft.hidden.find((h) => lower(h.name) === key),
      aliasOf: draft.aliases.find((a) => lower(a.alias) === key),
      alts: draft.aliases.filter((a) => lower(a.name) === key),
      emails: draft.emails.filter((e) => lower(e.ign) === key),
    });

    // the list
    const pf = admin.pf;
    const keys = [...people.keys()].sort((a, b) => a.localeCompare(b));
    const tally = { all: keys.length, roster: 0, off: 0, hidden: 0 };
    for (const k of keys) {
      const p = about(k);
      if (p.r) tally.roster++; else if (!p.aliasOf) tally.off++;
      if (p.hidden) tally.hidden++;
    }
    const listBox = el('div', { class: 'adm-plist', role: 'list' });
    const drawList = () => {
      const q = pf.q.trim().toLowerCase();
      const shown = keys.filter((k) => {
        const p = about(k);
        if (pf.show === 'roster' && !p.r) return false;
        if (pf.show === 'off' && (p.r || p.aliasOf)) return false;
        if (pf.show === 'hidden' && !p.hidden) return false;
        return !q || k.includes(q) || (p.r?.name || '').toLowerCase().includes(q);
      });
      const rows = shown.map((k) => {
        const p = about(k);
        const sub = p.aliasOf ? `counted as ${p.aliasOf.name}` : p.r ? [p.r.name, teamName(p.r.team)].filter(Boolean).join(' · ') : 'not on the roster';
        const a = el('a', { class: 'adm-prow', href: playerHref(p.name), 'aria-current': k === pick ? 'true' : null },
          headImg(p.name, 24, { class: 'adm-prow-head' }),
          el('span', { class: 'adm-prow-text' }, el('strong', { text: p.name }), el('span', { class: 'adm-prow-sub', text: sub })),
          el('span', { class: 'adm-prow-tags' },
            p.hidden ? el('span', { class: 'adm-tag', text: 'Hidden', title: 'Left out of Activity and Combat' }) : null,
            p.alts.length ? el('span', { class: 'adm-tag', text: `+${p.alts.length}`, title: `${p.alts.length} other ${p.alts.length === 1 ? 'account' : 'accounts'} counted as them` }) : null,
            p.r ? el('i', { class: 'adm-dot adm-prow-team', style: teamColor(p.r.team) ? `background:${teamColor(p.r.team)}` : '', title: teamName(p.r.team) }) : null,
            changed.has(k) ? el('i', { class: 'adm-prow-unsaved', title: 'Unsaved changes' }) : null));
        return el('div', { role: 'listitem' }, a);
      });
      // a name nobody has, typed in the search: put them on the roster
      const typed = pf.q.trim();
      const offer = IGN_OK.test(typed) && !people.has(typed.toLowerCase()) && teamIds.length
        ? el('div', { role: 'listitem' }, el('a', { class: 'adm-prow adm-prow-new', href: playerHref(typed) },
          el('span', { class: 'adm-prow-plus', 'aria-hidden': 'true', text: '+' }),
          el('span', { class: 'adm-prow-text' }, el('strong', { text: `Add ${typed}` }), el('span', { class: 'adm-prow-sub', text: 'a player the server hasn’t seen yet' }))))
        : null;
      listBox.replaceChildren(...rows, ...(offer ? [offer] : []), ...(!rows.length && !offer ? [empty(q ? 'Nobody matches that.' : 'Nobody here yet.')] : []));
    };
    drawList();
    const search = el('input', { class: 'adm-input adm-psearch', type: 'search', placeholder: 'Find a player', 'aria-label': 'Find a player', autocomplete: 'off', spellcheck: 'false', 'data-fk': 'pl:search' });
    search.value = pf.q;
    search.addEventListener('input', () => { pf.q = search.value; drawList(); });
    onEnter(search, () => { const first = listBox.querySelector('.adm-prow'); if (first) location.hash = first.getAttribute('href'); });
    const filter = el('div', { class: 'seg adm-pfilter', role: 'group', 'aria-label': 'Show' });
    for (const [v, text] of [['all', 'All'], ['roster', 'Roster'], ['off', 'Not on it'], ['hidden', 'Hidden']]) {
      const b = el('button', { type: 'button', 'aria-pressed': String(pf.show === v), 'data-fk': `pl:show:${v}` }, text, el('span', { class: 'adm-seg-n', text: String(tally[v]) }));
      b.addEventListener('click', () => { pf.show = v; redraw(); });
      filter.append(b);
    }
    const listCard = el('section', { class: 'card adm-card adm-plist-card' },
      el('div', { class: 'card-head' }, el('h2', { text: 'Players' }), el('span', { class: 'card-sub', text: `${tally.roster} on the Season ${d.season} roster` })),
      search, filter, listBox);

    // the editor
    let editor;
    if (!pick) {
      editor = el('section', { class: 'card adm-card adm-pedit adm-pedit-empty' },
        el('div', { class: 'adm-pick-hint' },
          el('span', { class: 'adm-pick-art', 'aria-hidden': 'true' }),
          el('strong', { text: 'Pick a player to edit them' }),
          el('span', { class: 'muted', text: 'Their team and real name, the teams they were on before, the emails they chat from the website with, and whether they’re hidden or merged with another account.' })));
    } else {
      const p = about(pick);
      const name = p.name;
      const r = p.r;
      const uuid = uuidForName(name);
      const base = d.roster.find((x) => lower(x.ign) === pick);

      // this season: the roster
      const season = [];
      if (r) {
        const team = teamSelect(r.team, `pe:${pick}:team`);
        team.addEventListener('change', () => { changeTeam(r, team.value); redraw(); });
        const real = el('input', { class: 'adm-input srv-input', type: 'text', maxlength: '60', placeholder: 'Same as their IGN', autocomplete: 'off', 'aria-label': 'Real name', 'data-fk': `pe:${pick}:name` });
        real.value = r.name || '';
        real.addEventListener('change', () => { r.name = real.value.trim().slice(0, 60); adminEdited(); });
        onEnter(real, () => real.blur());
        season.push(
          el('div', { class: 'adm-pgrid' },
            field('Team', team),
            ...rosterCols.map((c) => {
              const sel = colSelect(c, r[c.key], `pe:${pick}:${c.key}`);
              sel.addEventListener('change', () => { r[c.key] = sel.value || null; redraw(); });
              return field(c.title, sel);
            }),
            field('Real name', real, 'Shown when someone picks Name at the top of the page.')),
          field('Teams over time', periodEditor(r), 'What they did before each change counts for the team they were on then: playtime in the by-team charts, kills and deaths in Combat.'));
      } else if (!p.aliasOf) {
        const team = teamSelect(teamIds[0], `pe:${pick}:newteam`);
        const put = button(`Add ${name} to the roster`, () => {
          if (!IGN_OK.test(name)) return toast('An IGN is letters, digits and underscores', { error: true });
          if (!team.value) return toast('Add a team first, under Teams', { error: true });
          const was = d.roster.find((x) => lower(x.ign) === pick);
          draft.roster.push({ ign: was?.ign || name, team: team.value, egg: null, name: was?.name || '', ...Object.fromEntries(rosterCols.map((c) => [c.key, null])) });
          redraw();
        }, 'btn-primary', `pe:${pick}:add`);
        season.push(el('div', { class: 'adm-pjoin' },
          el('p', { class: 'adm-note', text: teamIds.length ? `${name} isn’t on the Season ${d.season} roster, so they have no team and no real name here.` : 'There are no teams yet. Make one under Teams to put players on it.' }),
          teamIds.length ? el('div', { class: 'adm-form' }, team, put) : el('a', { class: 'btn', href: '#/admin/teams', text: 'Go to Teams' })));
      }

      // the emails they chat from the website with
      const emailBox = el('input', { class: 'adm-input', type: 'email', placeholder: 'name@example.com', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Add an email', 'data-fk': `pe:${pick}:email` });
      const addEmail = () => {
        const e = emailBox.value.trim().toLowerCase();
        if (!e) return;
        if (!EMAIL_OK.test(e)) return toast('That isn’t an email address', { error: true });
        const other = draft.emails.find((x) => x.email === e);
        if (other) return toast(lower(other.ign) === pick ? 'They have that one already' : `${e} already chats as ${other.ign}`, { error: true });
        draft.emails.push({ email: e, ign: name });
        redraw();
      };
      onEnter(emailBox, addEmail);
      const savedEmails = (d.emails || []).filter((x) => lower(x.ign) === pick).map((x) => x.email);
      season.push(field('Chats from the website as them',
        el('div', { class: 'adm-stack' },
          p.emails.length ? el('ul', { class: 'adm-list adm-emails' }, ...p.emails.map((e) => el('li', {},
            el('span', { class: 'adm-main', text: e.email }), savedEmails.includes(e.email) ? null : unsaved('new'),
            button('Remove', () => { draft.emails = draft.emails.filter((x) => x !== e); redraw(); }, 'btn-quiet', `pe:${pick}:email:${e.email}`)))) : null,
          el('div', { class: 'adm-form' }, emailBox, button('Add email', addEmail, '', `pe:${pick}:email-add`))),
        'Someone signed in to mcstats with one of these can send chat from the Chat log as this player.'));

      // the email they connected themselves, in game with /mcstats connect (it counts once that account said yes)
      const own = (d.connected || []).find((c) => lower(c.name) === pick);
      season.push(field('Connected account',
        own ? el('ul', { class: 'adm-list adm-emails' }, el('li', {},
          el('span', { class: 'adm-main', text: own.email }),
          el('span', { class: 'muted', text: own.confirmed_at ? ` connected ${ago(own.confirmed_at)}` : ` asked ${ago(own.requested_at)}, waiting for that account to say yes` }),
          button('Disconnect', () => {
            if (confirm(`Disconnect ${own.email} from ${name}? They can connect again in game.`)) adminDo({ action: 'account.disconnect', uuid: own.uuid }, 'Disconnected');
          }, 'btn-quiet', `pe:${pick}:own-off`)))
          : el('span', { class: 'muted', text: 'None. A player connects one themselves in game, with /mcstats connect.' }),
        'The mcstats account the player connected in game. Signed in with it, someone chats from the website as this player.'));

      // every season: hidden, merged
      const hide = el('input', { type: 'checkbox', 'data-fk': `pe:${pick}:hide` });
      hide.checked = !!p.hidden;
      hide.addEventListener('change', () => {
        if (hide.checked) draft.hidden.push({ name, note: null });
        else draft.hidden = draft.hidden.filter((h) => h !== p.hidden);
        redraw();
      });
      const note = p.hidden ? el('input', { class: 'adm-input srv-input', type: 'text', maxlength: '200', placeholder: 'Why (only admins see this)', 'aria-label': 'Note', 'data-fk': `pe:${pick}:note` }) : null;
      if (note) {
        note.value = p.hidden.note || '';
        note.addEventListener('change', () => { p.hidden.note = note.value.trim() || null; adminEdited(); });
      }
      const merge = (alias, into) => {
        if (![alias, into].every((v) => IGN_OK.test(v))) return toast('A player’s name is letters, digits and underscores', { error: true });
        if (lower(alias) === lower(into)) return toast('An account can’t be merged into itself', { error: true });
        const rest = draft.aliases.filter((a) => lower(a.alias) !== lower(alias));
        if (rest.some((a) => lower(a.alias) === lower(into)) || rest.some((a) => lower(a.name) === lower(alias))) {
          return toast(`${into} is itself merged into another account, or ${alias} already has accounts merged into it; merge into the main account`, { error: true, ms: 6000 });
        }
        draft.aliases = [...rest, { alias, name: into }];
        redraw();
      };
      let merged;
      if (p.aliasOf) {
        merged = el('div', { class: 'adm-form' },
          el('span', {}, 'Counted as part of ', el('a', { href: playerHref(p.aliasOf.name), text: p.aliasOf.name }), '.'),
          button('Unmerge', () => { draft.aliases = draft.aliases.filter((a) => a !== p.aliasOf); redraw(); }, 'btn-quiet', `pe:${pick}:unmerge`));
      } else {
        const other = nameInput('Another account', `pe:${pick}:alt`);
        const go = () => { if (other.value.trim()) merge(other.value.trim(), name); };
        onEnter(other, go);
        merged = el('div', { class: 'adm-stack' },
          p.alts.length ? el('ul', { class: 'adm-list' }, ...p.alts.map((a) => el('li', {},
            headImg(a.alias, 16, { class: 'adm-head16' }), el('a', { class: 'adm-main', href: playerHref(a.alias), text: a.alias }),
            d.aliases.some((x) => lower(x.alias) === lower(a.alias) && lower(x.name) === pick) ? null : unsaved(),
            button('Unmerge', () => { draft.aliases = draft.aliases.filter((x) => x !== a); redraw(); }, 'btn-quiet', `pe:${pick}:unmerge:${lower(a.alias)}`)))) : null,
          el('div', { class: 'adm-form' }, other, button('Merge into them', go, '', `pe:${pick}:merge`)));
      }

      const status = [r ? `${teamName(r.team)}${r.name ? ` · ${r.name}` : ''}` : p.aliasOf ? `another account of ${p.aliasOf.name}` : 'not on the roster', p.hidden ? 'hidden' : null].filter(Boolean).join(' · ');
      editor = el('section', { class: 'card adm-card adm-pedit' },
        el('a', { class: 'adm-back', href: '#/admin/players', text: '← All players' }),
        el('div', { class: 'adm-phead' },
          headImg(name, 48, { class: 'adm-phead-img', width: '48', height: '48' }),
          el('div', { class: 'adm-phead-text' },
            el('h2', { class: 'adm-pname', text: name }),
            el('span', { class: 'adm-pmeta' }, r ? dot(r.team) : null, status, changed.has(pick) ? unsaved('unsaved changes') : null)),
          uuid ? el('a', { class: 'btn btn-quiet', href: `#/player/${uuid}`, text: 'Their page' }) : null),
        el('div', { class: 'adm-pblock' }, el('h3', { text: `Season ${d.season}` }), ...season,
          r ? el('div', { class: 'adm-pfoot' }, button('Take off the roster', () => {
            draft.roster = draft.roster.filter((x) => x !== r);
            draft.history = draft.history.filter((h) => lower(h.ign) !== pick);
            redraw();
          }, 'btn-quiet adm-danger', `pe:${pick}:remove`), base ? el('span', { class: 'site-hint', text: 'Their stats stay; they lose their team and real name here.' }) : null) : null),
        el('div', { class: 'adm-pblock' }, el('h3', { text: 'Every season' }),
          field('Hidden', el('div', { class: 'adm-stack' }, el('label', { class: 'adm-check adm-check-lg' }, hide, 'Leave them out of Activity and Combat'), note),
            'The chat log still shows them.'),
          field(p.aliasOf ? 'Merged' : 'Other accounts', merged, p.aliasOf ? null : 'Another account’s playtime, kills and chat count as this player’s, under this name.')));
    }
    return [el('div', { class: `adm-players${pick ? ' has-pick' : ''}` }, listCard, editor)];
  };

  /* ---- what happens at once: deaths left out of Combat, deleted messages, gaps, the link ---- */
  const uncountedCard = () => card('Left out of Combat', 'right-click a death to leave it out',
    d.uncounted.length ? el('ul', { class: 'adm-list adm-scroll' }, ...d.uncounted.map((u) => el('li', {},
      el('span', { class: 'adm-main', text: u.text }), el('span', { class: 'muted adm-when', text: when(u.ts) }),
      button('Count again', () => adminDo({ action: 'death.count', id: u.id }, 'Counted again'), 'btn-quiet'))))
      : empty('Every death counts.'));
  const deletedCard = () => card('Deleted messages', 'right-click a message to delete it',
    d.deleted.length ? el('ul', { class: 'adm-list adm-scroll' }, ...d.deleted.map((m) => el('li', {},
      el('span', { class: 'adm-main', text: m.kind === 'chat' || m.kind === 'say' ? `<${m.name}> ${m.text}` : m.text }),
      el('span', { class: 'muted adm-when', text: when(m.ts) }),
      button('Restore', () => adminDo({ action: 'chat.restore', event_id: m.event_id }, 'Restored'), 'btn-quiet'))))
      : empty('Nothing deleted.'));

  /* ---- chat log rules: which lines are left out (src/chatrules.js) ---- */
  const rulesCard = () => {
    const cr = d.chat_rules || { rules: [], hidden: 0 };
    const rf = (admin.ruleForm ??= { action: 'hide', kind: 'system', match: 'starts', text: '', from: '', to: '' });
    const count = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
    const rAction = select([['hide', 'Hide'], ['show', 'Always show']], rf.action, 'Hide or show', 'cr:action');
    const rKind = select([['', 'every kind of message'], ...RULE_KINDS.map(([k, name]) => [k, `${name} messages`])], rf.kind, 'Kind of message', 'cr:kind');
    const rMatch = select(RULE_MATCHES, rf.match, 'Which ones', 'cr:match');
    const rText = el('input', { class: 'adm-input', type: 'text', placeholder: 'text to match (capitals don’t matter)', maxlength: '300',
      autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Text to match', 'data-fk': 'cr:text' });
    rText.value = rf.text;
    rText.hidden = rf.match === 'any';
    const rFrom = el('input', { class: 'adm-input', type: 'datetime-local', 'aria-label': 'Only messages from this time on', 'data-fk': 'cr:from' });
    const rTo = el('input', { class: 'adm-input', type: 'datetime-local', 'aria-label': 'Only messages before this time', 'data-fk': 'cr:to' });
    rFrom.value = rf.from;
    rTo.value = rf.to;
    rAction.addEventListener('change', () => { rf.action = rAction.value; });
    rKind.addEventListener('change', () => { rf.kind = rKind.value; });
    rMatch.addEventListener('change', () => { rf.match = rMatch.value; rText.hidden = rf.match === 'any'; if (!rText.hidden) rText.focus(); });
    rText.addEventListener('input', () => { rf.text = rText.value; });
    rFrom.addEventListener('change', () => { rf.from = rFrom.value; });
    rTo.addEventListener('change', () => { rf.to = rTo.value; });
    const ms = (v) => (v ? new Date(v).getTime() || null : null);
    const addRule = async () => {
      if (rf.match !== 'any' && !rf.text.trim()) { rText.focus(); return; }
      const rule = { action: rf.action, kind: rf.kind || null, match: rf.match, text: rf.text, from_ms: ms(rf.from), to_ms: ms(rf.to) };
      const before = cr.rules.length;
      await adminDo({ action: 'rule.add', rule }, rf.action === 'hide' ? 'Rule added · the chat log is updated' : 'Rule added · those messages show again');
      if ((admin.data.chat_rules?.rules.length ?? 0) > before) Object.assign(rf, { text: '', from: '', to: '' });
      renderAdmin();
    };
    onEnter(rText, addRule);
    return card('Chat log rules', 'right-click a message in the chat log to hide ones like it',
      el('p', { class: 'adm-note', text: `A message is left out of the chat log when a Hide rule matches it and no Always show rule does. Rules cover messages already in the log too, unless you give them a start time. ${cr.hidden ? `${count(cr.hidden, 'message')} ${cr.hidden === 1 ? 'is' : 'are'} hidden now.` : 'Nothing is hidden now.'}` }),
      cr.rules.length ? el('ul', { class: 'adm-list adm-scroll' }, ...cr.rules.map((r) => el('li', { class: r.enabled ? '' : 'adm-rule-off' },
        el('span', { class: `adm-rule-tag ${r.action}`, text: r.action === 'hide' ? 'Hide' : 'Show' }),
        el('span', { class: 'adm-main', text: ruleText(r, when) }),
        el('span', { class: 'muted adm-when', text: r.enabled ? `matches ${count(r.matches, 'message')}` : 'turned off' }),
        button(r.enabled ? 'Turn off' : 'Turn on', () => adminDo({ action: 'rule.update', id: r.id, enabled: !r.enabled }, r.enabled ? 'Rule turned off' : 'Rule turned on'), 'btn-quiet', `cr:t${r.id}`),
        button('Delete', () => adminDo({ action: 'rule.delete', id: r.id }, 'Rule deleted'), 'btn-quiet', `cr:d${r.id}`))))
        : empty('No rules yet: every message shows.'),
      el('div', { class: 'adm-form adm-rule-form' }, rAction, rKind, rMatch, rText),
      el('div', { class: 'adm-form adm-rule-form' },
        el('span', { class: 'muted', text: 'Only messages from' }), rFrom, el('span', { class: 'muted', text: 'until' }), rTo,
        el('span', { class: 'muted', text: '(leave empty for all time)' }), button('Add rule', addRule, 'btn-primary', 'cr:add')));
  };

  const gapsCard = () => {
    const gapNote = el('span', { class: 'muted adm-gap-note', text: admin.gapNote || '' });
    return card('Missed checks', 'filled in every hour at :07 from joins and leaves, once the chat log catches up',
      el('div', { class: 'adm-form' }, button('Fill gaps now', async () => {
        gapNote.textContent = 'Working…';
        try {
          const { gaps } = await adminPost({ action: 'gaps.fill' });
          const done = gaps.filter((g) => g.filled), waiting = gaps.filter((g) => !g.filled);
          admin.gapNote = !gaps.length ? 'No gaps in the last 2 days.'
            : [done.length ? `Filled ${done.length} gap${done.length === 1 ? '' : 's'} (${done.reduce((n, g) => n + g.minutes, 0)} minutes).` : '',
              ...waiting.map((g) => `${when(g.from * 1000)} to ${when(g.to * 1000)}: waiting (${g.why}).`)].filter(Boolean).join(' ');
        } catch (err) {
          admin.gapNote = err.message;
        }
        gapNote.textContent = admin.gapNote;
      }), gapNote));
  };

  // the server mod's web chat connection: how it is now, and what it's done lately
  const linkCard = () => {
    const l = d.link;
    const secs = (n) => (n == null ? '–' : n < 90 ? `${n}s` : n < 5400 ? `${Math.round(n / 60)} min` : `${(n / 3600).toFixed(1)} h`);
    const linkNote = el('span', { class: 'muted adm-gap-note', text: admin.linkNote || '' });
    return card('Web chat connection', 'the server mod’s link for messages sent from here',
      !l ? empty('Couldn’t be checked.') : el('div', {},
        el('div', { class: 'adm-link-now' },
          el('span', { class: `adm-link-dot${l.linked ? ' up' : ''}` }),
          el('strong', { text: l.linked ? 'Connected' : 'Not connected' }),
          el('span', { class: 'muted', text: l.linked
            ? `mod ${l.version || '(version unknown)'}${l.version && !d.mod_update ? ' (the newest)' : ''}${l.connected_ago != null ? ` · connected ${secs(l.connected_ago)} ago` : ''} · last heard ${secs(l.heard_ago)} ago`
            : 'messages can’t reach the game until the mod reconnects' })),
        el('div', { class: 'adm-form' }, button('Test connection', async () => {
          linkNote.textContent = 'Testing…';
          try {
            const { probe, link } = await adminPost({ action: 'link.test' });
            admin.linkNote = probe.ok ? `The mod answered in ${probe.ms} ms. Nothing was shown in game.`
              : `No answer from the mod (${probe.why}).`;
            d.link = link;
          } catch (err) {
            admin.linkNote = err.message;
          }
          renderAdmin();
        }), linkNote),
        l.log?.length ? el('ul', { class: 'adm-list adm-scroll' }, ...l.log.slice().reverse().map((e) => el('li', {},
          el('span', { class: 'adm-main', text: e.what }), el('span', { class: 'muted adm-when', text: `${secs(e.ago)} ago` }))))
          : empty('Nothing has happened to it lately.')));
  };

  // every jar the site has, by Minecraft version and mod version, starting on the one the server needs
  const downloadCard = () => {
    const m = d.mod;
    if (!m) return null;
    const runs = d.link?.minecraft;
    return el('section', { class: 'card adm-card mod-page adm-mod-dl' },
      el('h2', { class: 'site-title', text: 'The mcstats mod' }),
      el('p', { class: 'site-sub', text: runs
        ? `It runs on the Minecraft server and sends what happens there to these pages. The server runs Minecraft ${runs}, so that’s picked below.`
        : 'It runs on the Minecraft server and sends what happens there to these pages. Players don’t install anything.' }),
      modPicker(m.downloads, { suggested: m.suggested, latest: m.version }),
      el('p', { class: 'site-sub' }, 'Put the jar in the server’s ', el('code', { text: 'mods/' }), ' folder in place of any older mcstats-chat jar, and restart the server. The config file stays as it is. ',
        el('a', { href: '/mod', text: 'What it needs and how to install it' })),
      // the key that ties the mod to this server is made in setup, by its owners
      site.super && MCS.slug ? el('p', { class: 'site-sub' }, 'The key in the mod’s config file is what ties it to this server. ',
        el('a', { href: `/new?server=${encodeURIComponent(MCS.slug)}&step=4`, text: 'Make a new key in setup' }), ' (the old one stops working at once).') : null);
  };

  // the mod's /mcstats commands, each with a switch: one that's off is gone in game for everyone (src/commands.js).
  // And whether the In-game commands box on the Activity page starts closed. Both are saved as they're clicked.
  const commandsCard = () => {
    const c = d.commands;
    if (!c) return null;
    const busy = !!admin.cmdBusy;
    const groups = [];
    for (const [cmd, what, id] of MC_COMMANDS) {
      const g = id && groups.find((x) => x.id === id);
      if (g) g.rows.push([cmd, what]);
      else groups.push({ id, rows: [[cmd, what]] });
    }
    const row = ({ id, rows }) => {
      const on = !id || !c.off.includes(id);
      const fk = `cmd:${id || 'help'}`;
      const box = el('input', { type: 'checkbox', 'data-fk': fk, disabled: !id || busy ? '' : null });
      box.checked = on;
      const name = rows[0][0];
      box.addEventListener('change', () => commandsSave(
        { commands_off: box.checked ? c.off.filter((x) => x !== id) : [...c.off, id] }, fk, box.checked ? `${name} is on` : `${name} is off`, true));
      return el('li', { class: on ? null : 'off' }, el('label', { class: 'adm-cmd' }, box,
        el('span', { class: 'adm-cmd-rows' }, ...rows.map(([cmd, what]) => el('span', { class: 'adm-cmd-row' },
          el('code', { text: cmd === '/mcstats' ? '/mcstats · /mcstats view' : cmd }), el('span', { class: 'adm-cmd-what', text: what })))),
        !id ? el('span', { class: 'muted adm-cmd-tag', text: 'always on' }) : on ? null : el('span', { class: 'adm-rule-tag hide', text: 'Off' })));
    };
    const old = c.supported === false
      ? el('p', { class: 'adm-note adm-cmd-warn' }, `The server’s mod is ${d.link?.last_version || 'an older version'}, and switching commands off needs ${c.needs} or newer. Until it’s updated every command stays on in game, whatever is picked here.`)
      : c.supported == null ? el('p', { class: 'adm-note', text: `Switching a command off needs mod ${c.needs} or newer on the server.` }) : null;
    const fold = el('input', { type: 'checkbox', 'data-fk': 'cmd:fold', disabled: busy ? '' : null });
    fold.checked = c.fold;
    fold.addEventListener('change', () => commandsSave({ commands_fold: fold.checked }, 'cmd:fold',
      fold.checked ? 'The commands box starts closed' : 'The commands box starts open'));
    return card('/mcstats commands', 'what players can type in game · saved as you click',
      el('p', { class: 'adm-note', text: 'A command that’s switched off is gone for everyone within a moment: it doesn’t run, and it leaves tab completion, /mcstats help, the menus and the list on the Activity page.' }),
      old,
      el('ul', { class: 'adm-cmds' }, ...groups.map(row)),
      field('On the Activity page', el('label', { class: 'adm-check adm-check-lg adm-cmd-fold' }, fold, el('span', { text: 'Keep the In-game commands box closed until someone opens it' })),
        'On by default. The box’s heading opens it. Switched off, the list is always showing.'));
  };

  // the mod's /liveview commands, to read: they aren't switched on or off here
  const liveviewCard = () => {
    const list = (rows) => el('ul', { class: 'adm-cmds adm-cmds-ro' }, ...rows.map(([cmd, what]) => el('li', {},
      el('span', { class: 'adm-cmd-row' }, el('code', { text: cmd }), el('span', { class: 'adm-cmd-what', text: what })))));
    return card('/liveview commands', 'for reference; these can’t be switched off here',
      el('p', { class: 'adm-note', text: 'They come with Liveview. All but help only work for the Minecraft server’s operators, so players can’t run them.' }),
      el('h3', { class: 'adm-cmds-cap', text: 'Everyone' }), list(LIVEVIEW_COMMANDS.filter((r) => !r[2])),
      el('h3', { class: 'adm-cmds-cap', text: 'Operators' }), list(LIVEVIEW_COMMANDS.filter((r) => r[2])));
  };

  // a newer mod than the server runs (src/modupdate.js): what changed in each release since, and how to update
  const updateCard = () => {
    const mu = d.mod_update;
    if (!mu) return null;
    return el('section', { class: `card adm-card adm-update${mu.urgent ? ' urgent' : ''}` },
      el('div', { class: 'card-head' },
        el('h2', { text: mu.urgent ? 'Urgent: update the server mod' : 'A newer server mod is out' }),
        el('span', { class: 'card-sub', text: `mcstats ${mu.current} → ${mu.latest}` })),
      ...(mu.urgent ? [el('ul', { class: 'adm-update-why' }, ...mu.urgent_why.map((w) => el('li', { text: w })))] : []),
      el('p', { class: 'adm-note' },
        'To update: ', el('a', { href: mu.jar_url, download: '', text: `download ${mu.jar}` }),
        `, put it in the server’s mods folder in place of the old mcstats-chat jar, and restart the server. The config file stays as it is.`),
      ...mu.releases.map((r) => el('div', { class: 'adm-release' },
        el('h3', {},
          el('span', { text: r.version }),
          r.date ? el('span', { class: 'muted', text: ` · ${r.date}` }) : '',
          r.urgent ? el('span', { class: 'adm-rule-tag hide', text: 'Urgent' }) : ''),
        ...(r.urgent_why ? [el('p', { class: 'adm-release-urgent', text: r.urgent_why })] : []),
        ...(r.summary ? [el('p', { class: 'adm-note', text: r.summary })] : []),
        ...r.changes.map((c) => el('div', {},
          el('h4', { text: c.section }),
          el('ul', { class: 'adm-release-list' }, ...c.items.map((it) => el('li', {},
            ...(it.title ? [el('strong', { text: `${it.title}. ` })] : []), it.text))))))));
  };

  const views = {
    players: playersView,
    teams: () => [teamsCard(), rosterCard()],
    moderation: () => [rulesCard(), deletedCard(), uncountedCard()],
    mod: () => [updateCard(), downloadCard(), commandsCard(), liveviewCard()],
    data: () => [linkCard(), gapsCard()],
  };
  const root = $('#admin');
  const listTop = root.querySelector('.adm-plist')?.scrollTop ?? null;
  root.replaceChildren(players, ...views[section]().filter(Boolean));
  if (listTop != null) { const l = root.querySelector('.adm-plist'); if (l) l.scrollTop = listTop; }
  if (focusKey) root.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  renderAdminBar();
}

// Chat log rules (src/chatrules.js): the kinds of line and ways to match, as the admin page names them.
const RULE_KINDS = [['system', 'info'], ['server', 'server'], ['chat', 'chat'], ['say', '/say'], ['emote', '/me'],
  ['join', 'join'], ['leave', 'leave'], ['death', 'death'], ['advancement', 'advancement']];
const RULE_MATCHES = [['any', 'all of them'], ['exact', 'that say exactly'], ['starts', 'that start with'], ['contains', 'that contain'], ['ends', 'that end with']];
function ruleText(r, when) {
  const kind = r.kind ? `${RULE_KINDS.find(([k]) => k === r.kind)?.[1] ?? r.kind} messages` : 'messages of every kind';
  const what = r.match === 'any' ? `all ${kind}` : `${kind} ${RULE_MATCHES.find(([m]) => m === r.match)[1]} “${r.text}”`;
  const span = r.from_ms && r.to_ms ? ` · ${when(r.from_ms)} to ${when(r.to_ms)}` : r.from_ms ? ` · from ${when(r.from_ms)}` : r.to_ms ? ` · until ${when(r.to_ms)}` : '';
  return what[0].toUpperCase() + what.slice(1) + span;
}
// The server's test, for taking newly hidden lines off the page at once.
function ruleMatches(r, m) {
  const low = (v) => v.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (r.kind && r.kind !== m.kind) return false;
  if (r.from_ms != null && m.ts < r.from_ms) return false;
  if (r.to_ms != null && m.ts >= r.to_ms) return false;
  if (r.match === 'any') return true;
  const text = low(m.text), want = low(r.text.trim());
  return r.match === 'exact' ? text === want : r.match === 'starts' ? text.startsWith(want) : r.match === 'ends' ? text.endsWith(want) : text.includes(want);
}

// "Hide messages like this": the menu turns into a small form for a new Hide rule, starting from the
// line that was clicked (its kind, its exact text).
function hideLikeThis(m, row, e) {
  const kindName = RULE_KINDS.find(([k]) => k === m.kind)?.[1] ?? m.kind;
  const match = el('select', { 'aria-label': 'Which messages' });
  for (const [v, text] of [['exact', 'With exactly this text'], ['starts', 'Starting with'], ['contains', 'Containing'], ['any', `Every ${kindName} message`]]) match.append(el('option', { value: v, text }));
  const input = el('input', { type: 'text', maxlength: '300', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Text to match' });
  input.value = m.text.slice(0, 300);
  match.addEventListener('change', () => { input.hidden = match.value === 'any'; if (!input.hidden) { input.focus(); input.select(); } });
  const onlyKind = el('input', { type: 'checkbox' }), past = el('input', { type: 'checkbox' });
  onlyKind.checked = past.checked = true;
  const go = async () => {
    if (match.value !== 'any' && !input.value.trim()) { input.focus(); return; }
    if (match.value === 'any') onlyKind.checked = true; // never every message of every kind
    const rule = { action: 'hide', kind: onlyKind.checked ? m.kind : null, match: match.value, text: input.value, from_ms: past.checked ? null : Date.now(), to_ms: null };
    closeAdminMenu();
    let res;
    try {
      res = await adminPost({ action: 'rule.add', rule });
    } catch (err) {
      if (err instanceof DbLimitError) showError(err.message);
      toast(err.message, { error: true });
      return;
    }
    toast(`${res.changed ? `Hid ${res.changed.toLocaleString()} ${res.changed === 1 ? 'message' : 'messages'}` : 'Rule added'} · change it under Chat log rules on the admin page`, { ms: 5000 });
    admin.data = null; // the admin page reads the rules again
    const before = chat.messages.length;
    chat.messages = chat.messages.filter((x) => !ruleMatches(rule, x));
    if (chat.messages.length !== before && !$('#view-chat').hidden) renderChat();
  };
  const ok = el('button', { type: 'button', class: 'ctx-primary', text: 'Hide' });
  ok.addEventListener('click', go);
  input.addEventListener('keydown', (k) => { if (k.key === 'Enter') { k.preventDefault(); go(); } });
  adminMenu.replaceChildren(el('div', { class: 'ctx-attr ctx-rule' },
    el('div', { class: 'ctx-label', text: 'Hide from the chat log' }), match, input,
    el('label', { class: 'ctx-check' }, onlyKind, el('span', { text: `Only ${kindName} messages` })),
    el('label', { class: 'ctx-check' }, past, el('span', { text: 'Also ones already in the log' })),
    el('div', { class: 'ctx-row' }, ok)));
  row.classList.add('ctx-target');
  adminMenu.hidden = false;
  const { width, height } = adminMenu.getBoundingClientRect();
  adminMenu.style.left = `${Math.min(e.clientX, innerWidth - width - 8)}px`;
  adminMenu.style.top = `${Math.min(e.clientY, innerHeight - height - 8)}px`;
  match.focus({ preventScroll: true });
}

// Right-click a chat line or a death, as an admin: delete it, hide ones like it, or leave a death out of Combat.
const adminMenu = el('div', { class: 'ctx-menu', role: 'menu', hidden: '' });
document.body.append(adminMenu);
function closeAdminMenu() {
  adminMenu.hidden = true;
  document.querySelector('.ctx-target')?.classList.remove('ctx-target');
}
document.addEventListener('contextmenu', (e) => {
  if (!site.admin) return;
  const row = e.target.closest('[data-chat-id]');
  // Shift + right-click still opens the browser's own menu.
  if (!row || e.shiftKey) {
    closeAdminMenu();
    return;
  }
  e.preventDefault();
  closeAdminMenu();
  const id = Number(row.dataset.chatId);
  const shown = chat.messages.find((x) => x.id === id); // (a death in the Combat log may not be loaded here)
  const item = (text, run, danger = false) => {
    const b = el('button', { type: 'button', role: 'menuitem', class: danger ? 'danger' : '', text });
    b.addEventListener('click', () => { closeAdminMenu(); run(); });
    return b;
  };
  adminMenu.replaceChildren(
    ...(row.dataset.death ? [
      (() => {
        const now = deathKiller(id);
        const b = item(now.killer ? 'Attribute death · ' : 'Attribute death', () => attributeDeath(id, row, e));
        if (now.killer) b.append(el('strong', { text: now.killer }));
        return b;
      })(),
      item("Don't count in combat", () => adminRemove(id, 'death.uncount'))] : []),
    ...(shown ? [item('Hide messages like this…', () => hideLikeThis(shown, row, e))] : []),
    item('Delete message', () => adminRemove(id, 'chat.delete'), true));
  row.classList.add('ctx-target');
  adminMenu.hidden = false;
  const { width, height } = adminMenu.getBoundingClientRect();
  adminMenu.style.left = `${Math.min(e.clientX, innerWidth - width - 8)}px`;
  adminMenu.style.top = `${Math.min(e.clientY, innerHeight - height - 8)}px`;
  adminMenu.querySelector('button').focus({ preventScroll: true });
});
document.addEventListener('pointerdown', (e) => { if (!adminMenu.hidden && !adminMenu.contains(e.target)) closeAdminMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !adminMenu.hidden) closeAdminMenu(); });
// scrolling what's under it closes it (not other scrolling, such as the chat log settling elsewhere)
window.addEventListener('scroll', (e) => {
  const t = document.querySelector('.ctx-target');
  if (!adminMenu.hidden && (!t || e.target === document || e.target.contains?.(t))) closeAdminMenu();
}, { passive: true, capture: true });

// "Attribute death": the menu turns into a small picker (type or pick a player, then Attribute; or No
// one to take the kill away). The death then counts as that player's kill on the Combat page.
// The killer a death has now, and whether its "(by name)" note shows, from whatever is loaded.
function deathKiller(id) {
  const m = deathLog.items.find((x) => x.id === id) || chat.messages.find((x) => x.id === id);
  const d = combat.rows.find((x) => x.id === id);
  return { killer: m?.killer ?? d?.killer ?? null, note: !!m?.attr_note };
}

function attributeDeath(id, row, e) {
  const now = deathKiller(id);
  const names = [...new Set(knownNames.values())].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const list = el('datalist', { id: 'attr-names' }, ...names.map((n) => el('option', { value: n })));
  const input = el('input', { type: 'text', list: 'attr-names', placeholder: 'Player name', maxlength: '16',
    spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Player who gets the kill' });
  const go = async (killer) => {
    if (killer !== null && !/^[A-Za-z0-9_]{1,16}$/.test(killer)) { input.focus(); input.select(); return; }
    closeAdminMenu();
    let res;
    try {
      res = await adminPost({ action: 'death.attribute', id, killer, note: noteBox.checked });
    } catch (err) {
      if (err instanceof DbLimitError) showError(err.message);
      toast(err.message, { error: true });
      return;
    }
    const who = names.find((n) => n.toLowerCase() === (killer || '').toLowerCase()) || killer;
    toast(killer ? `Counted as ${who}’s kill` : 'Cleared: no one gets the kill now');
    for (const d of combat.rows) if (d.id === id) { d.killer = who; if (who) d.mob = null; }
    const note = who && noteBox.checked ? 1 : 0;
    for (const m of deathLog.items) if (m.id === id) { m.killer = who; m.attr_note = note; if (who) m.mob = null; }
    for (const m of chat.messages) if (m.id === id) { m.killer = who; m.attr_note = note; }
    if (!$('#view-chat').hidden) renderChat();
    renderDeathLog(); // drawn even while its page is hidden, so it's right when it next shows
    if (!$('#view-combat').hidden) renderCombat();
    else if (state.playerData && !$('#view-player').hidden) renderPlayerCombat(state.playerData.name).catch(() => {});
  };
  const ok = el('button', { type: 'button', class: 'ctx-primary', text: 'Attribute' });
  ok.addEventListener('click', () => go(input.value.trim()));
  input.addEventListener('keydown', (k) => { if (k.key === 'Enter') { k.preventDefault(); go(input.value.trim()); } });
  const noteBox = el('input', { type: 'checkbox' });
  noteBox.checked = !!now.note;
  const updateNote = () => { noteText.textContent = `(by ${input.value.trim() || 'name'})`; };
  const noteText = el('em', {});
  input.addEventListener('input', updateNote);
  // who has it now, with a button to take it away
  const current = now.killer ? el('div', { class: 'ctx-current' },
    el('span', {}, 'Now: ', el('strong', { text: now.killer })),
    (() => { const c = el('button', { type: 'button', class: 'danger', text: 'Clear' }); c.addEventListener('click', () => go(null)); return c; })())
    : null;
  if (now.killer) input.value = now.killer;
  updateNote();
  adminMenu.replaceChildren(el('div', { class: 'ctx-attr' },
    el('div', { class: 'ctx-label', text: 'Who gets the kill?' }), current, input, list,
    el('label', { class: 'ctx-check' }, noteBox, el('span', {}, 'Show ', noteText, ' in the message')),
    el('div', { class: 'ctx-row' }, ok)));
  row.classList.add('ctx-target');
  adminMenu.hidden = false;
  const { width, height } = adminMenu.getBoundingClientRect();
  adminMenu.style.left = `${Math.min(e.clientX, innerWidth - width - 8)}px`;
  adminMenu.style.top = `${Math.min(e.clientY, innerHeight - height - 8)}px`;
  input.focus({ preventScroll: true });
}

// Takes it out here at once (the server has already changed by the time this runs).
async function adminRemove(id, action) {
  try {
    await adminPost({ action, id });
  } catch (err) {
    if (err instanceof DbLimitError) showError(err.message);
    toast(err.message, { error: true });
    return;
  }
  toast(action === 'chat.delete' ? 'Deleted · restore it from the admin page' : 'Left out of Combat · undo it from the admin page');
  combat.rows = combat.rows.filter((d) => d.id !== id);
  deathLog.items = deathLog.items.filter((m) => m.id !== id);
  if (action === 'chat.delete') {
    chat.messages = chat.messages.filter((m) => m.id !== id);
    if (!$('#view-chat').hidden) renderChat();
  }
  for (const n of document.querySelectorAll(`.pcb-recent [data-chat-id="${id}"]`)) n.remove();
  if (!$('#view-combat').hidden) { renderDeathLog(); renderCombat(); }
  else if (state.playerData && !$('#view-player').hidden) renderPlayerCombat(state.playerData.name).catch(() => {});
}

/* ---------- Admin → Discord (DISCORD.md; GET/POST /api/admin/discord, src/discord/admin.js) ---------- */

// Unlike the rest of Admin, each change here is saved at once: linking happens partly on Discord's side, and
// every change takes effect in Discord straight away.
const dsc = { data: null, busy: false, code: null, notice: null };
const DSC_FEEDS = {
  status: ['Status message', 'One message kept up to date: who’s on, and today at a glance.'],
  events: ['Events', 'Joins and leaves, deaths, advancements, the server going up or down, new seasons.'],
  chat: ['Chat', 'The game’s chat, posted as each player. Needs “Chat” shared.'],
  digest: ['Daily summary', 'Yesterday on the server, once a day.'],
};
const DSC_SHARE = [
  ['online', 'Who’s online', 'Always on: the least a linked server shares.'],
  ['stats', 'Stats', 'Playtime, the leaderboard, player cards, when someone was last on.'],
  ['deaths', 'Deaths and kills', 'Needs the mod.'],
  ['advancements', 'Advancements', 'Needs the mod.'],
  ['chat', 'Chat', 'The game’s chat in a Discord channel. Needs the mod.'],
  ['joinlink', 'Join link', 'A Join button on /dashboard, so Discord members get in without the password.'],
];
const DSC_NOTICES = {
  linked: 'Linked. Now pick a setup below.', cancelled: 'Not added: nothing changed.', expired: 'That took too long. Try Add to Discord again.',
  not_owner: 'Only the server’s owner can add the bot.', taken: 'That Discord server is already linked to another mcstats server. Unlink it there first.',
  failed: 'Discord didn’t confirm the bot was added. Try again.', not_set_up: 'The Discord bot isn’t set up on this site yet.',
};

async function showDiscordAdmin() {
  showView('admin');
  adminTab('discord');
  const root = $('#discord-admin');
  if (!site.perms) {
    const r = DUMMY ? null : await api('/api/me').catch(() => null);
    if (r) setMe(r);
  }
  if (!site.admin || DUMMY) {
    root.replaceChildren(el('div', { class: 'card empty', text: DUMMY ? 'The sample data has no Discord.' : 'This page is only for admins.' }));
    return;
  }
  // back from Discord's "Add app" screen (src/discord/install.js): say how it went, once
  const q = new URLSearchParams(location.search);
  if (q.has('discord')) {
    dsc.notice = DSC_NOTICES[q.get('discord')] || null;
    q.delete('discord');
    history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`);
  }
  if (!dsc.data) root.replaceChildren(el('div', { class: 'card empty', text: 'Loading…' }));
  dsc.data = await api('/api/admin/discord');
  renderDiscordAdmin();
}

async function dscPost(body) {
  if (dsc.busy) return null;
  dsc.busy = true;
  $('#discord-admin').classList.add('adm-busy');
  try {
    const res = await fetch('/api/admin/discord', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    });
    const r = await res.json().catch(() => null);
    if (!res.ok) throw new Error(r?.error || `the server answered ${res.status}`);
    if (r.link !== undefined) dsc.data = r;
    if (r.notes?.length) toast(r.notes.join(' '), { error: true, ms: 8000 });
    return r;
  } catch (err) {
    toast(err.message, { error: true, ms: 6000 });
    return null;
  } finally {
    dsc.busy = false;
    $('#discord-admin').classList.remove('adm-busy');
    renderDiscordAdmin();
  }
}

function renderDiscordAdmin() {
  const d = dsc.data;
  if (!d) return;
  const root = $('#discord-admin');
  const card = (title, sub, ...kids) => el('section', { class: 'card adm-card' },
    el('div', { class: 'card-head' }, el('h2', { text: title }), sub ? el('span', { class: 'card-sub', text: sub }) : null),
    el('div', { class: 'srv-fields dsc-fields' }, ...kids));
  const note = (text) => el('p', { class: 'adm-note', text });
  const btn = (text, onclick, primary = false, attrs = {}) => {
    const b = el('button', { class: primary ? 'btn btn-primary' : 'btn', type: 'button', text, ...attrs });
    b.addEventListener('click', onclick);
    return b;
  };
  const cards = [];
  if (dsc.notice) cards.push(el('div', { class: 'card dsc-notice', role: 'status', text: dsc.notice }));

  if (!d.ready) {
    cards.push(card('Discord', null, note('The Discord bot isn’t set up on this site yet. Its operator follows “Operator setup” in DISCORD.md.')));
    root.replaceChildren(...cards);
    return;
  }

  /* ---- not linked: the two ways in ---- */
  if (!d.link) {
    const kids = [
      note('Bring this server into your Discord: commands like /online, /player and /top, a live status message, joins, deaths and '
        + 'advancements as they happen, and the game’s chat in a channel if you like. What Discord sees is up to the owner, below once linked.'),
    ];
    if (d.owner) {
      const add = el('a', { class: 'btn btn-primary', href: d.install_url, text: 'Add to Discord' });
      kids.push(el('div', { class: 'dsc-actions' }, add,
        btn('Link with a code', async () => { const r = await dscPost({ action: 'code' }); if (r?.code) { dsc.code = r; renderDiscordAdmin(); } })));
      kids.push(note('Add to Discord: pick your Discord server on Discord’s own screen and you’re back here, linked. '
        + 'If someone else runs the Discord server, make a code and send them the command it shows.'));
      if (dsc.code) {
        const cmd = el('code', { class: 'dsc-code', text: dsc.code.command });
        kids.push(el('div', { class: 'site-field' }, el('span', { class: 'site-label', text: `Code (works once, for ${dsc.code.minutes} minutes)` }), cmd,
          el('div', { class: 'dsc-actions' }, btn('Copy', () => navigator.clipboard?.writeText(dsc.code.command).then(() => toast('Copied.'))))));
      }
    } else {
      kids.push(note('Only the server’s owner can add the bot to a Discord server.'));
    }
    cards.push(card('Discord', 'Not linked', ...kids));
    root.replaceChildren(...cards);
    return;
  }

  /* ---- linked ---- */
  const g = d.guild || {};
  const chans = g.channels || [];
  const chanName = (id) => chans.find((c) => c.id === id)?.name;
  const health = [];
  if (d.link.broken) health.push(el('p', { class: 'site-err', text: `Posting stopped: ${d.link.broken} Pick a setup again to start it.` }));
  if (g.error) health.push(el('p', { class: 'site-err', text: g.error }));
  health.push(note(d.mod.linked ? `The Minecraft server’s mod is connected (${d.mod.version || 'version unknown'}).`
    : d.has_mod ? 'The Minecraft server’s mod isn’t connected right now: chat, deaths and /say wait for it.'
      : 'The Minecraft server doesn’t run the mcstats mod: commands work, but there’s no chat, deaths or advancements.'));
  const linkedBy = d.link.linked_by ? ` by ${d.link.linked_by}` : '';
  cards.push(card(`Discord · ${d.link.guild_name || 'linked'}`, `Linked ${fmt(d.link.linked_at, { month: 'short', day: 'numeric', year: 'numeric' })}${linkedBy}`,
    ...health,
    el('div', { class: 'dsc-actions' },
      el('a', { class: 'btn', href: d.install_url, text: 'Add again (fix permissions)' }),
      btn('Send a test', async () => {
        const r = await dscPost({ action: 'test' });
        if (r?.results) toast(Object.entries(r.results).map(([f, v]) => `${DSC_FEEDS[f][0]}: ${v === 'ok' ? 'posted' : v}`).join(' · ') || 'No feeds to test.', { ms: 6000 });
      }),
      d.owner ? btn('Unlink', () => { if (confirm('Unlink this Discord server? Its feeds stop and the bot’s webhooks and status message are deleted.')) dscPost({ action: 'unlink' }); }) : null)));

  /* ---- what may be shared (owners) ---- */
  const shareRows = DSC_SHARE.filter(([k]) => k !== 'joinlink' || (!d.public && d.has_join_link)).map(([k, label, hint]) => {
    const box = el('input', { type: 'checkbox', disabled: !d.owner || k === 'online' ? '' : null });
    box.checked = !!d.config.share[k];
    box.addEventListener('change', () => dscPost({ action: 'share', share: { [k]: box.checked } }));
    return el('label', { class: 'dsc-check' }, box, el('span', {}, el('b', { text: label }), ' ', el('span', { class: 'site-hint', text: hint })));
  });
  cards.push(card('Shared with Discord', d.owner ? 'The most Discord ever gets' : 'Only the owner can change this', ...shareRows));

  /* ---- setup: a preset and channels ---- */
  const pick = (feed, value) => {
    const s = el('select', { class: 'adm-input', 'aria-label': `Channel for ${DSC_FEEDS[feed][0]}` },
      el('option', { value: '', text: 'Off' }),
      ...chans.map((c) => el('option', { value: c.id, text: `#${c.name}${c.parent ? ` (${c.parent})` : ''}${(feed === 'chat' ? c.missing_webhook : c.missing).length ? ' ⚠' : ''}` })));
    s.value = value || '';
    return s;
  };
  const sug = g.suggested || {};
  const presetBox = el('select', { class: 'adm-input', 'aria-label': 'Setup' },
    ...Object.entries(d.presets).map(([id, p]) => el('option', { value: id, text: p.label, disabled: p.needs.some((k) => !d.config.share[k]) ? '' : null })));
  presetBox.value = d.feeds.chat ? 'bridge' : d.feeds.events ? 'community' : d.feeds.status ? 'status' : 'community';
  const statusPick = pick('status', d.feeds.status?.channel_id || sug.status);
  const eventsPick = pick('events', d.feeds.events?.channel_id || sug.events);
  const chatPick = pick('chat', d.feeds.chat?.channel_id || sug.chat);
  const make = el('input', { type: 'checkbox', disabled: g.can_make_channels ? null : '' });
  const shown = () => {
    const feeds = d.presets[presetBox.value].feeds;
    statusPick.parentElement.hidden = !feeds.includes('status');
    eventsPick.parentElement.hidden = !feeds.includes('events');
    chatPick.parentElement.hidden = !feeds.includes('chat');
  };
  const field = (label, control) => el('div', { class: 'site-field' }, el('span', { class: 'site-label', text: label }), control);
  const fields = [
    field('Setup', presetBox),
    field('Status message and daily summary', statusPick),
    field('Joins, deaths and advancements', eventsPick),
    field('The game’s chat', chatPick),
    el('label', { class: 'dsc-check' }, make, el('span', {}, el('b', { text: 'Make the channels for me' }), ' ',
      el('span', { class: 'site-hint', text: g.can_make_channels ? 'A “Minecraft” category with the channels this setup uses.' : 'The bot needs Manage Channels: use “Add again” with it ticked on Discord’s screen.' }))),
    el('div', { class: 'dsc-actions' }, btn('Save setup', () => dscPost({
      action: 'preset', preset: presetBox.value, make: make.checked,
      channels: { status: statusPick.value || null, events: eventsPick.value || null, chat: chatPick.value || null },
    }), true)),
  ];
  presetBox.addEventListener('change', shown);
  cards.push(card('Setup', 'What the bot posts, and where', ...fields));
  queueMicrotask(shown);

  /* ---- feeds as they are ---- */
  const feedRows = Object.keys(DSC_FEEDS).map((f) => {
    const x = d.feeds[f];
    const q = d.relay?.queued?.[f]?.n;
    const state = !x ? 'Off'
      : x.last_error ? `⚠ ${x.last_error}` : x.last_ok ? `Last post ${fmt(x.last_ok, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}` : 'Nothing posted yet';
    const extra = [];
    if (x && f === 'events') {
      for (const [k, label] of [['joins', 'joins'], ['deaths', 'deaths'], ['advancements', 'advancements'], ['server', 'up/down'], ['season', 'seasons']]) {
        const box = el('input', { type: 'checkbox' });
        box.checked = x.options[k] !== false;
        box.addEventListener('change', () => dscPost({ action: 'feeds', feeds: { events: { channel_id: x.channel_id, options: { ...x.options, [k]: box.checked } } } }));
        extra.push(el('label', { class: 'dsc-inline' }, box, ` ${label}`));
      }
    }
    if (x && f === 'digest') {
      const hour = el('select', { class: 'adm-input dsc-hour', 'aria-label': 'Hour of the daily summary' },
        ...Array.from({ length: 24 }, (_, h) => el('option', { value: String(h), text: `${String(h).padStart(2, '0')}:00` })));
      hour.value = String(x.options.hour ?? 9);
      hour.addEventListener('change', () => dscPost({ action: 'feeds', feeds: { digest: { channel_id: x.channel_id, options: { hour: Number(hour.value) } } } }));
      extra.push(el('span', { class: 'dsc-inline' }, 'at ', hour));
    }
    return el('div', { class: 'dsc-feed' },
      el('div', {}, el('b', { text: DSC_FEEDS[f][0] }), x ? ` → #${chanName(x.channel_id) || 'unknown channel'}` : '', el('div', { class: 'site-hint', text: DSC_FEEDS[f][1] })),
      el('div', { class: 'dsc-feed-state' }, `${state}${q ? ` · ${q} waiting` : ''}`), extra.length ? el('div', { class: 'dsc-feed-opts' }, ...extra) : null);
  });
  if (d.relay?.dropped) feedRows.push(note(`${d.relay.dropped} posts were dropped while Discord couldn’t be reached.`));
  cards.push(card('Feeds', null, ...feedRows));

  /* ---- commands and /say ---- */
  const on = el('input', { type: 'checkbox' });
  on.checked = d.config.commands.on;
  on.addEventListener('change', () => dscPost({ action: 'commands', commands: { on: on.checked } }));
  const quiet = el('input', { type: 'checkbox' });
  quiet.checked = d.config.commands.ephemeral;
  quiet.addEventListener('change', () => dscPost({ action: 'commands', commands: { ephemeral: quiet.checked } }));
  const sayBox = el('select', { class: 'adm-input', disabled: d.owner ? null : '', 'aria-label': 'Who may /say' },
    el('option', { value: 'off', text: 'Nobody' }), el('option', { value: 'linked', text: 'Discord members linked to a player' }),
    el('option', { value: 'anyone', text: 'Anyone (shown with a * in game; needs mod 2.4.0)' }));
  sayBox.value = d.config.bridge.say;
  sayBox.addEventListener('change', () => dscPost({ action: 'bridge', bridge: { say: sayBox.value } }));
  cards.push(card('Commands', null,
    el('label', { class: 'dsc-check' }, on, el('span', {}, el('b', { text: 'Commands on' }), ' ', el('span', { class: 'site-hint', text: '/online, /server, /player, /top, /seen, /deaths, /dashboard, /me' }))),
    el('label', { class: 'dsc-check' }, quiet, el('span', {}, el('b', { text: 'Answers only to whoever asked' }), ' ', el('span', { class: 'site-hint', text: 'Otherwise everyone in the channel sees them.' }))),
    field('Who may send chat into the game with /say', sayBox)));

  /* ---- linked players ---- */
  const players = (d.players || []).map((p) => el('div', { class: 'dsc-feed' },
    el('div', {}, el('b', { text: p.name }), el('span', { class: 'site-hint', text: ` Discord user ${p.discord_id} · linked ${fmt(p.at, { month: 'short', day: 'numeric' })}` })),
    btn('Unlink', () => dscPost({ action: 'player.unlink', discord_id: p.discord_id }))));
  cards.push(card('Linked players', 'Discord members link themselves with /mcstats connect',
    ...(players.length ? players : [note('Nobody yet.')])));

  root.replaceChildren(...cards);
}

/* ---------- routing & refresh ---------- */

async function route() {
  closeTip();
  closeGearMenu();
  showError('');
  if (location.hash !== '#/admin/server') srvLeave(); // a look tried on Admin → Server but not saved
  const m = location.hash.match(/^#\/player\/([0-9a-fA-F-]{36})$/);
  // Admin's sections: #/admin (Players), #/admin/players/<name>, #/admin/teams, …
  const adm = location.hash.match(/^#\/admin(?:\/(players|teams|moderation|mod|data)(?:\/([^/]{1,40}))?)?$/);
  try {
    if (m) await showPlayer(m[1]);
    else if (location.hash === '#/chat') await showChat();
    else if (location.hash === '#/combat') await showCombat();
    else if (adm) await showAdmin(adm[1] || 'players', adm[2] ? decodeURIComponent(adm[2]) : null);
    else if (location.hash === '#/admin/layout') await showLayoutAdmin();
    else if (location.hash === '#/admin/server') await showServerAdmin();
    else if (location.hash === '#/admin/analytics') await showAnalytics();
    else if (location.hash === '#/admin/roles') await showRoles();
    else if (location.hash === '#/admin/discord') await showDiscordAdmin();
    else if (onLive()) await showLive();
    else await showHome();
    renderUnread();
    countView();
  } catch (err) {
    console.error(err);
    if (err instanceof AuthError) {
      showError('Not signed in. Reload the page to log in through Cloudflare Access.');
    } else if (err instanceof DbLimitError) {
      showError(err.message);
    } else {
      showError(`Couldn’t load data (${err.message}).`);
    }
  }
}

/* ---------- light / dark ---------- */

// Dark until the switch is used, then remembers the choice (set before first paint in index.html).
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const themeToggle = $('#theme-toggle');
const isDark = () => (document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light')) === 'dark';
const syncThemeToggle = () => themeToggle.setAttribute('aria-checked', String(isDark()));

themeToggle.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  const apply = () => {
    document.documentElement.dataset.theme = next;
    syncThemeToggle();
  };
  // Cross-fade the whole page where supported.
  if (document.startViewTransition && !reducedMotion()) document.startViewTransition(apply);
  else apply();
  try { localStorage.setItem('theme', next); } catch {}
});
darkQuery.addEventListener('change', syncThemeToggle);
syncThemeToggle();
requestAnimationFrame(() => requestAnimationFrame(() => themeToggle.classList.add('ready'))); // no slide on page load

// How far paging moved the time axis, in widths of the old window (-1 = a whole width earlier).
function pageShift(prev, w, dir) {
  if (!dir || !prev) return 0;
  const a = resolveWindow(prev), b = resolveWindow(w);
  const shift = (b.from - a.from) / (a.to - a.from);
  return Math.max(-1, Math.min(1, shift)) || dir;
}

// Pinch to zoom a chart's time range around the point under the fingers: a trackpad pinch
// (Ctrl+wheel in most browsers, gesture events in Safari), Ctrl+scroll with a mouse, or two fingers.
// Each step is worked out from where the gesture started, so ranges that snap to whole hours
// or days don't drift. toWindow(from, to) gives the window for a span (or an error string).
// preload(), when given, fetches the data either side of what's shown: it's called when the pointer
// settles on the chart and as a gesture starts, so what scrolls into view is usually already here.
function pinchZoom(root, { ctl, toWindow, render, min, max, preload }) {
  let g = null;
  let idle = 0, timer = 0;
  if (preload) {
    let dwell = 0;
    root.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') dwell = setTimeout(preload, 200);
    });
    root.addEventListener('pointerleave', () => clearTimeout(dwell));
  }
  const begin = (clientX) => {
    if (g) return;
    preload?.();
    const r = resolveWindow(ctl.get());
    const box = root.getBoundingClientRect();
    const { l, r: right } = root.plotBox || { l: 0, r: 0 };
    const f = (clientX - box.left - l) / Math.max(1, box.width - l - right);
    g = { from: r.from, to: Math.min(r.to, nowSec()), f: Math.min(1, Math.max(0, f)), scale: 1, shift: 0 };
    drawn = null;
    hideTip();
  };
  // The span the fingers ask for right now (not yet snapped to whole hours or days).
  const wanted = () => {
    const span = Math.min(max, Math.max(min, (g.to - g.from) * g.scale));
    const at = g.from + g.f * (g.to - g.from);
    let from = at - g.f * span + g.shift, to = from + span;
    const now = nowSec();
    if (to > now) { from -= to - now; to = now; }
    const first = state.dataStart;
    if (first && from < first && to < now) { to += first - from; from = first; if (to > now) to = now; }
    return { from, to };
  };
  // Every frame the chart already on screen is stretched to the wanted span, which costs almost
  // nothing, so the zoom follows the fingers. The chart is redrawn for real (new data, sharp
  // labels) one drawing at a time behind that, and the stretch then starts again from the new one.
  let drawn = null; // the span of the chart on screen
  let busy = false, again = false, frame = 0, last = null;
  const stretch = () => {
    frame = 0;
    if (!g || !drawn) return;
    const { from, to } = wanted();
    const { l, r: right } = root.plotBox || { l: 0, r: 0 };
    const pw = Math.max(1, root.clientWidth - l - right);
    const k = (drawn.to - drawn.from) / (to - from);
    const dx = l * (1 - k) + ((drawn.from - from) / (to - from)) * pw;
    const same = Math.abs(k - 1) < 1e-4 && Math.abs(dx) < 0.25;
    for (const child of root.children) {
      const node = plotOf(child, l, pw) || child;
      node.style.transformOrigin = '0 0';
      node.style.transform = same ? '' : `translateX(${dx}px) scaleX(${k})`;
    }
  };
  // A chart that keeps its y-axis apart (.yaxis beside .slide-clip > .slide, as slideIn uses) has only
  // its plot moved, behind the plot's edges, so the axis and its numbers stay where they are. What the
  // chart drew past its edges (.overscan, and lines beyond .plot-clip) shows as it comes into view.
  const plotOf = (svg, l, pw) => {
    const frame = svg.querySelector(':scope > .slide-clip');
    const body = frame?.querySelector(':scope > .slide');
    if (!body) return null;
    if (!svg.querySelector(':scope > .pan-clip')) {
      const id = `pan-clip-${++slideClips}`;
      const c = sv('clipPath', { id, class: 'pan-clip' });
      c.append(sv('rect', { x: l - 1, y: -50, width: pw + 2, height: 5000 }));
      svg.append(c);
      frame.setAttribute('clip-path', `url(#${id})`);
      for (const r of body.querySelectorAll('.plot-clip > rect')) {
        r.setAttribute('x', l - pw);
        r.setAttribute('width', pw * 3);
      }
      for (const o of body.querySelectorAll('.overscan')) o.setAttribute('visibility', 'visible');
    }
    return body;
  };
  const unstretch = () => {
    const { l, r: right } = root.plotBox || { l: 0, r: 0 };
    for (const child of root.children) {
      child.style.transform = '';
      const clip = child.querySelector(':scope > .pan-clip');
      if (!clip) continue;
      const frame = child.querySelector(':scope > .slide-clip'), body = frame.querySelector(':scope > .slide');
      clip.remove();
      frame.removeAttribute('clip-path');
      body.style.transform = '';
      for (const r of body.querySelectorAll('.plot-clip > rect')) {
        r.setAttribute('x', l);
        r.setAttribute('width', Math.max(1, child.clientWidth - l - right));
      }
      for (const o of body.querySelectorAll('.overscan')) o.setAttribute('visibility', 'hidden');
    }
    root.style.overflow = '';
  };
  const shownSpan = () => {
    const r = resolveWindow(ctl.get()); // what the chart's x axis covers
    return { from: r.from, to: r.to };
  };
  const apply = () => {
    timer = 0;
    if (!g) return;
    if (busy) { again = true; return; }
    const { from, to } = wanted();
    const w = toWindow(Math.round(from), Math.round(to));
    if (typeof w === 'string' || windowKey(w) === windowKey(ctl.get())) return;
    ctl.set(w);
    busy = true;
    const mine = g;
    Promise.resolve(render()).catch(() => {}).then(() => {
      busy = false;
      if (g !== mine) { // the gesture ended meanwhile: draw where it ended, unstretched
        unstretch();
        if (last && typeof last !== 'string' && windowKey(last) !== windowKey(ctl.get())) {
          ctl.set(last);
          render();
        }
        last = null;
        return;
      }
      drawn = shownSpan();
      stretch();
      if (again) { again = false; apply(); }
    });
  };
  // Scrolling sideways moves the range along, the way zooming stretches it.
  const panBy = (px) => {
    const { l, r: right } = root.plotBox || { l: 0, r: 0 };
    const pw = Math.max(1, root.clientWidth - l - right);
    const span = Math.min(max, Math.max(min, (g.to - g.from) * g.scale));
    const base = g.from + g.f * (g.to - g.from) - g.f * span; // where the range starts unmoved
    g.shift += (px / pw) * span;
    g.shift = wanted().from - base; // pushing past now or the start doesn't build up
    kick();
  };
  const zoomTo = (scale) => {
    const span = g.to - g.from;
    g.scale = Math.min(max / span, Math.max(min / span, scale));
    kick();
  };
  const kick = () => {
    if (!drawn) {
      drawn = shownSpan();
      root.style.overflow = 'hidden';
    }
    if (!frame && !reducedMotion()) frame = requestAnimationFrame(stretch);
    if (!timer) timer = setTimeout(apply, 90);
  };
  const end = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    frame = 0;
    again = false;
    if (g && busy) {
      const { from, to } = wanted();
      last = toWindow(Math.round(from), Math.round(to));
    } else if (g) apply();
    g = null;
    drawn = null;
    if (!busy) unstretch(); // otherwise the drawing in flight clears it when it lands
  };

  root.addEventListener('wheel', (e) => {
    const sideways = !e.ctrlKey && (Math.abs(e.deltaX) > Math.abs(e.deltaY) || (e.shiftKey && e.deltaY));
    if (!e.ctrlKey && !sideways) return;
    e.preventDefault();
    begin(e.clientX);
    if (sideways) panBy(Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
    else zoomTo(g.scale * Math.exp(Math.max(-50, Math.min(50, e.deltaY)) * 0.01));
    clearTimeout(idle);
    idle = setTimeout(end, 300);
  }, { passive: false });

  root.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    begin(e.clientX);
  });
  root.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (g) zoomTo(1 / e.scale);
  });
  root.addEventListener('gestureend', (e) => {
    e.preventDefault();
    end();
  });

  let startDist = 0;
  const dist = ([a, b]) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  root.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    g = null;
    begin((e.touches[0].clientX + e.touches[1].clientX) / 2);
    startDist = dist(e.touches);
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !g || !startDist) return;
    e.preventDefault();
    zoomTo(startDist / Math.max(1, dist(e.touches)));
  }, { passive: false });
  root.addEventListener('touchend', (e) => {
    if (e.touches.length < 2 && startDist) {
      startDist = 0;
      end();
    }
  });
}

const tlCtl = rangeControl($('#tl-ctl'), {
  presets: TL_PRESETS, picker: 'datetime', fromPicker: pickSeconds(TL_PRESETS),
  onChange: (w, dir, prev) => loadTimeline(pageShift(prev, w, dir)).catch((e) => showError(e.message)),
});
const dailyCtl = rangeControl($('#daily-ctl'), {
  presets: DAILY_PRESETS, picker: 'date', fromPicker: pickDays(DAILY_PRESETS),
  onChange: (w, dir, prev) => renderServerDaily(false, pageShift(prev, w, dir)).catch((e) => showError(e.message)),
});
const pCtl = rangeControl($('#pa-ctl'), {
  presets: PLAYER_PRESETS, picker: 'datetime', fromPicker: pickPlayerRange,
  onChange: (w, dir, prev) => renderPlayerActivity(false, pageShift(prev, w, dir)),
});
tlCtl.set(presetWindow(TL_PRESETS[1]));
dailyCtl.set(presetWindow(DAILY_PRESETS[0]));
pCtl.set(playerDefaultWindow());
const lbCtl = rangeControl($('#lb-ctl'), {
  presets: LB_PRESETS, picker: 'datetime', fromPicker: pickSeconds(LB_PRESETS),
  onChange: () => loadLeaderboard().catch((e) => showError(e.message)),
});
lbCtl.set(presetWindow(LB_PRESETS[0]));
// Combat: one range for the whole page; up to two days is drawn by the hour, longer by the day.
const cbCtl = rangeControl($('#cb-ctl'), {
  presets: COMBAT_PRESETS, picker: 'datetime',
  fromPicker: (from, to) => {
    const w = pickPlayerRange(from, to);
    return typeof w === 'string' ? w : { ...w, preset: matchPreset(COMBAT_PRESETS, w.unit, w.count) };
  },
  onChange: () => renderCombat(),
});
cbCtl.set(presetWindow(COMBAT_PRESETS.at(-1)));
$('#cb-chart-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === combat.chartMode) return;
  combat.chartMode = b.dataset.v;
  remember('combatChart', combat.chartMode);
  renderCombatChart();
});
if (recall('deathLog') === 'closed') {
  $('#combat').classList.add('log-closed');
  $('#dl-open').hidden = false;
}

pinchZoom($('#timeline'), {
  ctl: tlCtl, toWindow: pickSeconds(TL_PRESETS), min: 30 * 60, max: 90 * 86400, preload: preloadTimeline,
  render: () => loadTimeline().catch((e) => showError(e.message)),
});
pinchZoom($('#heatmap'), {
  ctl: dailyCtl, min: 86400, max: 90 * 86400, preload: preloadDaily,
  toWindow: (from, to) => pickDays(DAILY_PRESETS)(hourInfo(from).date, hourInfo(to - 1).date),
  render: () => renderServerDaily().catch((e) => showError(e.message)),
});
pinchZoom($('#p-heatmap'), {
  ctl: pCtl, min: 2 * 3600, max: 365 * 86400,
  // Hourly ranges keep a whole number of hours as they're moved or stretched (snapping each end
  // outward on its own would add an hour to a range that was only scrolled sideways).
  toWindow: (from, to) => {
    if (to - from > 48 * 3600) return pickPlayerRange(from, to);
    const n = Math.max(1, Math.round((to - from) / 3600));
    const end = to >= nowSec() - 60 ? currentHourEnd() : Math.round(from / 3600) * 3600 + n * 3600;
    return pickPlayerRange(end - n * 3600, end);
  },
  render: () => renderPlayerActivity(),
});

window.addEventListener('hashchange', route);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!$('#view-home').hidden) loadTimeline().catch(() => {});
});

// Live updates: re-render everything shortly after each once-a-minute server check,
// while the tab is visible. Fetches are incremental, so this stays cheap.
let refreshing = false;
let presenceUpdate = false; // a join or leave pushed by the server (see "live online list" below)
// Effects only play for automatic updates, not first loads or range changes.
function live() {
  return (refreshing || presenceUpdate) && !reducedMotion();
}
async function refresh() {
  if (document.hidden || refreshing || archived()) return; // a finished season doesn't change
  refreshing = true;
  try {
    const m = location.hash.match(/^#\/player\/([0-9a-fA-F-]{36})$/);
    if (m) await showPlayer(m[1], { refresh: true });
    else if (location.hash === '#/chat') await showChat({ refresh: true });
    else if (location.hash === '#/combat') await showCombat({ refresh: true });
    else if (location.hash === '#/admin/analytics') await showAnalytics({ refresh: true });
    else if (location.hash.startsWith('#/admin')) { /* the admin page reloads only on a change */ }
    else if (onLive()) { /* Liveview keeps itself up to date over its own connection */ }
    else await showHome();
    renderUnread();
    showError('');
  } catch (err) {
    if (err instanceof AuthError) showError('Your login expired. Reload the page to sign in again.');
    else if (err instanceof DbLimitError) showError(err.message);
    // other errors: keep showing the last good data; the next tick retries
  } finally {
    refreshing = false;
  }
}

function scheduleRefresh() {
  const ms = Date.now() % 60_000;
  const wait = (20_000 - ms + 60_000) % 60_000 || 60_000; // ~20s past each minute
  setTimeout(async () => { await refresh(); scheduleRefresh(); }, wait);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refresh();
  if (!$('#view-chat').hidden) pollChat().catch(() => {});
  else checkUnread().catch(() => {});
});
scheduleRefresh();

/* ---------- live online list ---------- */

// Who's online is pushed over a WebSocket the moment someone joins or leaves (src/presence.js): the
// server mod sends the join/leave lines and its tab list within a second or two. The badges, the
// online count and the live pill show it; the charts still come from the once-a-minute check. The
// list comes at least every 20 seconds while the server is up; without one for PRESENCE_STALE_MS (the
// server asleep, the mod not running, or the connection down) the page goes back to the minute check.
const PRESENCE_STALE_MS = 75_000;
const presence = { data: null, at: 0, ws: null, retry: 0, timer: null, idle: null, shown: '' };

function livePresence() {
  const p = presence.data;
  return p && p.fresh && Date.now() - presence.at <= PRESENCE_STALE_MS ? p : null;
}

// What to show as online now: the live list when it's current, otherwise the last minute check's.
// last is shaped like status.last ({ ts, up, online, listed, max }).
function onlineNow() {
  const st = state.status;
  const p = SEASON === CURRENT_SEASON && !archived() ? livePresence() : null;
  if (!p || !st) return { last: st?.last ?? null, online: st?.online ?? [], live: false };
  const n = p.players.length;
  return {
    last: { ...(st.last || {}), ts: Math.max(p.sent_at, st.last?.ts ?? 0), up: p.up ? 1 : 0, online: n, listed: n },
    online: p.players,
    live: true,
    stopping: p.stopping,
    reportAt: p.report_at,
  };
}

// Redraws what shows who's online, if what it would show changed.
function syncPresence() {
  if (!state.status || archived()) return;
  const now = onlineNow();
  const key = JSON.stringify([now.live, now.last?.up, now.stopping, now.online.map((p) => [p.uuid, p.name, p.start_ts])]);
  if (key === presence.shown) return;
  presence.shown = key;
  presenceUpdate = true;
  try {
    renderLive();
    if (!$('#view-home').hidden) { renderTiles(); renderOnlineChips(); }
    if (!$('#view-chat').hidden) renderChatOnline();
  } finally {
    presenceUpdate = false;
  }
}

function connectPresence() {
  clearTimeout(presence.timer);
  if (DUMMY || archived() || SEASON !== CURRENT_SEASON || presence.ws || document.hidden || !('WebSocket' in window)) return;
  let ws;
  try {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`);
  } catch {
    retryPresence();
    return;
  }
  presence.ws = ws;
  let ping = null;
  ws.addEventListener('open', () => {
    // keeps the connection open while the server is asleep and nothing else is sent
    ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 30_000);
    // anything sent while this page wasn't connected: whispers, and chat
    if (presence.wasOpen) {
      if (compose.whispersLoaded) loadWhispers().catch(() => {});
      chatNudge();
    }
    presence.wasOpen = true;
  });
  ws.addEventListener('message', (e) => {
    if (e.data === 'pong') return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m?.type === 'whisper') return onWhisper(m.whisper);
    if (m?.type === 'chat') return chatNudge();
    if (m?.type === 'link') return onLink(m.up);
    if (m?.type !== 'presence' || !Array.isArray(m.players)) return;
    presence.retry = 0;
    presence.data = m;
    presence.at = Date.now();
    if (typeof m.link === 'boolean') onLink(m.link);
    syncPresence();
    if (suggest.items.length) updateSuggest(); // who can be whispered to may have changed
  });
  ws.addEventListener('close', () => {
    clearInterval(ping);
    if (presence.ws !== ws) return;
    presence.ws = null;
    retryPresence();
  });
}

// Reconnects after a dropped connection: soon at first, then less often (up to a minute apart).
function retryPresence() {
  clearTimeout(presence.timer);
  if (document.hidden) return;
  const wait = Math.min(60_000, 1000 * 2 ** presence.retry++) * (0.75 + Math.random() * 0.5);
  presence.timer = setTimeout(connectPresence, wait);
}

// New chat was logged: fetch it now rather than at the next check (a few in a row make one fetch).
let nudgeTimer = 0;
function chatNudge() {
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    if (!$('#view-chat').hidden) pollChat().catch(() => {});
    else checkUnread().catch(() => {});
  }, 250);
}

// The server mod's web chat connection came up or went down: the message box says so at once.
function onLink(up) {
  const me = compose.me;
  if (!me || me.linked === up) return;
  me.linked = up;
  compose.checked = Date.now();
  renderComposer();
}

// A tab in the background lets go of its connection after a quarter of an hour (whispers to you
// reach you until then), and picks it up again when shown.
document.addEventListener('visibilitychange', () => {
  clearTimeout(presence.idle);
  if (!document.hidden) {
    presence.retry = 0;
    connectPresence();
    return;
  }
  presence.idle = setTimeout(() => {
    const ws = presence.ws;
    presence.ws = null;
    clearTimeout(presence.timer);
    ws?.close(1000, 'tab hidden');
  }, 15 * 60_000);
});
// the live list going stale shows up even when nothing arrives
setInterval(() => { if (!document.hidden) syncPresence(); }, 5_000);
connectPresence();

route().finally(() => checkUnread().catch(() => {}));
