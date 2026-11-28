// Site analytics: numbers about mcstats itself (accounts, servers, devices, the mod, the Discord bot), for the
// site's operators. Nothing on the site links to it, and to anyone else it looks like a server that doesn't exist.
//
//   GET  /site-analytics                 the page (public/site-analytics.html + .js), for viewers only
//   GET  /api/site-analytics/data        everything the page draws
//   POST /api/site-analytics/census      { since, discord? }  asks the next batch of servers whose census is
//                                        older than `since` (unix seconds): { asked, failed, left }
//   POST /api/site-analytics/baselines   { metric, value, from_day?, note? } | { remove: id }   super admins only
//   POST /api/site-analytics/viewers     { email } | { email, remove: true }                     super admins only
//
// Viewers are the super admins (the SUPER_ADMIN_EMAIL secret) and the accounts they add (site_viewers), signed
// in to their mcstats account. Everyone else gets what a missing server or page gets: /site-analytics redirects to
// /join, the API says "not found".
//
// Counted from the rest of the site, without naming anyone:
//   POST /api/site/visit  { a, s, b, n }   a browser's first visit of the day, week or month (public/visit.js)
//   GET  /downloads/*.jar                  mod downloads, one per address and file a day
// and accounts.seen_day (src/account.js) for active accounts. See README, "Site analytics".
import { accountOf } from './account.js';
import { isSuper } from './roles.js';
import { cleanEmail, EMAIL_RE } from './session.js';
import { ipKey, limit, tooMany } from './limiter.js';
import { json } from './util.js';
import { aggregate, BATCH, refreshCensus, refreshDiscordCount, saveSnapshot } from './census.js';
import { bump, DAY_RE, periodsOf, utcDay } from './sitecounts.js';
import { discordReady } from './discord/api.js';
import { MOD } from './modinfo.gen.js';

export const PAGE = '/site-analytics';
const SCRIPT = '/site-analytics.js';
const METRICS = ['accounts', 'servers'];
const MAX_VIEWERS = 50;
const MAX_BASELINES = 200;
const now = () => Math.floor(Date.now() / 1000);

// Whether a request is for the page or its script (the API is matched separately).
export const isSitePage = (p) => p === PAGE || p.startsWith(`${PAGE}/`) || p === `${PAGE}.html` || p === SCRIPT;

const local = (url) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

// Who's asking, if they may see the site analytics: { email, super }. Null for everyone else.
export async function viewerOf(request, env, url) {
  let email = (await accountOf(request, env))?.email ?? null;
  // a developer's own machine with DEV_NO_AUTH: whoever DEV_EMAIL is, as everywhere else on the site
  if (!email && env.DEV_NO_AUTH === '1' && local(url) && env.DEV_EMAIL) email = env.DEV_EMAIL.toLowerCase();
  if (!email) return null;
  if (isSuper(env, { email })) return { email, super: true };
  const row = await env.DIRECTORY.prepare('SELECT 1 AS ok FROM site_viewers WHERE email = ?').bind(email).first();
  return row ? { email, super: false } : null;
}

// What anyone else gets: the same as for a server that doesn't exist (src/index.js joinPage), or a missing file.
async function notHere(env, url) {
  if (url.pathname === PAGE) {
    return new Response(null, { status: 302, headers: { Location: `/join?server=${encodeURIComponent(PAGE.slice(1))}`, 'Cache-Control': 'no-store' } });
  }
  if (url.pathname.startsWith(`${PAGE}/`)) return new Response('Not found', { status: 404 });
  return env.ASSETS.fetch(new Request(new URL('/__not_a_file__', url)));
}

const PRIVATE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'same-origin' };

export async function sitePage(request, env, url) {
  const me = await viewerOf(request, env, url);
  if (!me) return notHere(env, url);
  const p = url.pathname;
  if (p !== PAGE && p !== SCRIPT) {
    return new Response(null, { status: 302, headers: { Location: PAGE, 'Cache-Control': 'no-store' } });
  }
  const res = await env.ASSETS.fetch(new Request(new URL(p, url)));
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(PRIVATE)) out.headers.set(k, v);
  return out;
}

// A POST's JSON body, from this site's own pages only. A Response when it isn't one.
async function body(request, url, max = 2048) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return json({ error: 'wrong origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);
  try {
    const raw = await request.text();
    if (raw.length > max) return json({ error: 'too large' }, 413);
    const b = JSON.parse(raw || '{}');
    return b && typeof b === 'object' && !Array.isArray(b) ? { b } : json({ error: 'bad json' }, 400);
  } catch {
    return json({ error: 'bad json' }, 400);
  }
}

async function baselines(env) {
  const { results } = await env.DIRECTORY.prepare(
    'SELECT id, metric, value, from_day, note, set_by, set_at FROM site_baselines ORDER BY metric, COALESCE(from_day, \'\'), set_at'
  ).all();
  return results;
}

async function viewers(env) {
  const { results } = await env.DIRECTORY.prepare(
    `SELECT v.email, v.added_by, v.added_at, a.seen_day, (a.id IS NOT NULL) AS has_account
     FROM site_viewers v LEFT JOIN accounts a ON a.email = v.email ORDER BY v.added_at`
  ).all();
  const supers = String(env.SUPER_ADMIN_EMAIL || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return { supers, viewers: results.map((r) => ({ ...r, has_account: !!r.has_account })) };
}

// New accounts, servers and Discord links per UTC day, all time: the growth charts add them up.
async function history(env) {
  const db = env.DIRECTORY;
  const per = (table, col) => db.prepare(`SELECT date(${col}, 'unixepoch') AS day, COUNT(*) AS n FROM ${table} GROUP BY day ORDER BY day`);
  const [accounts, servers, discord] = await db.batch([per('accounts', 'created_at'), per('servers', 'created_at'), per('discord_guilds', 'linked_at')]);
  const pairs = (r) => r.results.map((x) => [x.day, x.n]);
  return { accounts: pairs(accounts), servers: pairs(servers), discord: pairs(discord) };
}

async function data(env, me) {
  const db = env.DIRECTORY;
  const totals = await aggregate(env);
  // today's snapshot follows the latest numbers, whoever looks
  await saveSnapshot(env, totals);
  const [hist, snaps, counts, dl, base] = await Promise.all([
    history(env),
    db.prepare('SELECT day, data FROM site_snapshots ORDER BY day').all(),
    db.prepare("SELECT day, metric, n FROM site_counts WHERE metric NOT LIKE 'dl:%' ORDER BY day").all(),
    db.prepare("SELECT day, metric, n FROM site_counts WHERE metric LIKE 'dl:%' ORDER BY day").all(),
    baselines(env),
  ]);
  const today = utcDay();
  return {
    me, today, periods: periodsOf(today), now: now(),
    totals,
    history: hist,
    snapshots: snaps.results.map((r) => { try { return [r.day, JSON.parse(r.data)]; } catch { return [r.day, {}]; } }),
    counts: counts.results.map((r) => [r.day, r.metric, r.n]),
    downloads: dl.results.map((r) => [r.day, r.metric, r.n]),
    baselines: base,
    access: me.super ? await viewers(env) : null,
    discord_ready: discordReady(env),
    census_batch: BATCH,
    mod: { latest: MOD.version, files: (MOD.downloads || []).map((d) => ({ file: d.file, version: d.version, label: d.label })) },
  };
}

export async function handleSiteAnalytics(request, env, url) {
  const me = await viewerOf(request, env, url);
  if (!me) return json({ error: 'not found' }, 404);
  const path = url.pathname.slice('/api/site-analytics'.length);

  if (path === '/data') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return json(await data(env, me));
  }

  const r = await body(request, url);
  if (r instanceof Response) return r;
  const b = r.b;

  if (path === '/census') {
    const lim = await limit(env, [[`site-census:${me.email}`, 120, 600]]);
    if (!lim.ok) return tooMany(lim.retry);
    const t = now();
    // census taken before this moment gets taken again; never further back than a week, never in the future
    const since = Math.min(t, Math.max(t - 7 * 86400, Math.floor(Number(b.since)) || t));
    const out = await refreshCensus(env, { before: since });
    if (b.discord === true) out.discord = await refreshDiscordCount(env).catch(() => null);
    return json(out);
  }

  // what follows changes the page for everyone who can see it: the super admins only
  if (!me.super) return json({ error: 'Only the site’s super admins can change this.' }, 403);

  if (path === '/baselines') {
    if (b.remove != null) {
      await env.DIRECTORY.prepare('DELETE FROM site_baselines WHERE id = ?').bind(Number(b.remove) || 0).run();
      return json({ ok: true, baselines: await baselines(env) });
    }
    if (!METRICS.includes(b.metric)) return json({ error: 'metric is accounts or servers' }, 400);
    const value = Number(b.value);
    if (!Number.isInteger(value) || value < 0 || value > 10_000_000) return json({ error: 'The baseline is a whole number, 0 or more.', field: 'value' }, 400);
    let from = b.from_day == null || b.from_day === '' ? null : String(b.from_day);
    if (from != null && (!DAY_RE.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || new Date(`${from}T00:00:00Z`).toISOString().slice(0, 10) !== from)) {
      return json({ error: 'The date is YYYY-MM-DD.', field: 'from_day' }, 400);
    }
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 120) : '';
    const n = await env.DIRECTORY.prepare('SELECT COUNT(*) AS n FROM site_baselines').first('n');
    if (n >= MAX_BASELINES) return json({ error: `At most ${MAX_BASELINES} baselines; remove some first.` }, 409);
    await env.DIRECTORY.prepare('INSERT INTO site_baselines (metric, value, from_day, note, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(b.metric, value, from, note || null, me.email, now()).run();
    return json({ ok: true, baselines: await baselines(env) });
  }

  if (path === '/viewers') {
    const email = cleanEmail(b.email);
    if (!EMAIL_RE.test(email)) return json({ error: 'That isn’t an email address.', field: 'email' }, 400);
    if (b.remove === true) {
      await env.DIRECTORY.prepare('DELETE FROM site_viewers WHERE email = ?').bind(email).run();
      return json({ ok: true, ...(await viewers(env)) });
    }
    if (isSuper(env, { email })) return json({ error: 'Super admins can always see this page.', field: 'email' }, 400);
    const n = await env.DIRECTORY.prepare('SELECT COUNT(*) AS n FROM site_viewers').first('n');
    if (n >= MAX_VIEWERS) return json({ error: `At most ${MAX_VIEWERS} viewers.` }, 409);
    await env.DIRECTORY.prepare('INSERT INTO site_viewers (email, added_by, added_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING')
      .bind(email, me.email, now()).run();
    console.log(`site analytics: ${me.email} let ${email} in`);
    return json({ ok: true, ...(await viewers(env)) });
  }

  return json({ error: 'not found' }, 404);
}

// ---------- counting devices, without telling them apart ----------
//
// A browser remembers (in its own localStorage, public/visit.js) which day, week and month it was last counted
// in, separately for any visit (a), a visit while signed in (s) and a visit to a server's dashboard (b). It sends
// those back once a day, and whichever is older than the current period adds 1 to that period's counter; the
// answer says which periods to remember now. The periods are the Worker's (UTC), so a browser with its clock
// wrong is still counted once. Nothing comes with it that tells one browser from another: no id, no cookie of
// its own, and the address only ever as an unreadable rate-limit key (src/limiter.js) that isn't kept.
// "Signed in" is checked here, from the account cookie, not taken from the browser.

const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|curl|wget|python|java\//i;
const KINDS = ['a', 's', 'b'];

// The periods a browser's stored ones ({ d, w, m }, or nothing) are behind on: 'dwm', 'd', ''.
function behind(stored, p) {
  if (!stored || typeof stored !== 'object') return 'dwm';
  return ['d', 'w', 'm'].filter((f) => stored[f] !== p[f]).join('');
}

export async function recordVisit(request, env, url) {
  const r = await body(request, url, 512);
  if (r instanceof Response) return r;
  if (BOT_RE.test(request.headers.get('User-Agent') || '')) return json({ ok: true, counted: null });
  const lim = await limit(env, [[`visit:${await ipKey(env, request)}`, 60, 3600]]);
  if (!lim.ok) return tooMany(lim.retry);
  const signedIn = !!(await accountOf(request, env));
  const p = periodsOf(utcDay());
  const counted = {};
  const pairs = [];
  for (const kind of KINDS) {
    // a kind the browser didn't send (null) isn't counted: s while signed out, b away from a dashboard
    if (r.b[kind] === undefined || r.b[kind] === null || (kind === 's' && !signedIn)) { counted[kind] = null; continue; }
    counted[kind] = behind(r.b[kind], p);
    for (const f of counted[kind]) pairs.push([p[f], `dev:${kind}:${f}`]);
  }
  // a browser seen for the first time (it had nothing stored), with its first visit of the day
  if (r.b.n === true && counted.a?.includes('d')) pairs.push([p.d, 'dev:new']);
  await bump(env, pairs);
  return json({ ok: true, signedIn, counted, periods: p });
}

// ---------- mod downloads ----------

const JAR_RE = /^\/downloads\/([A-Za-z0-9._+-]{1,120}\.jar)$/;

// Serves a file from /downloads/ and counts a jar: 'web' from a browser, 'cli' from anything else (curl or wget
// on the server itself, say). Crawlers aren't counted, nor the rest of a download already started, nor the same
// file again from the same address on the same day.
export async function serveDownload(request, env, url, ctx) {
  const res = await env.ASSETS.fetch(request);
  // the files are served at their encoded names ("+" as %2B: a link with "+" is sent there first)
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* not a file of ours */ }
  const m = JAR_RE.exec(path);
  if (m && request.method === 'GET' && res.status === 200) ctx.waitUntil(countDownload(request, env, m[1]).catch((err) => console.error('download count:', err.message)));
  return res;
}

async function countDownload(request, env, file) {
  const ua = request.headers.get('User-Agent') || '';
  if (/bot|crawl|spider|slurp|preview|headless/i.test(ua)) return;
  const range = request.headers.get('Range');
  if (range && !/^bytes=0-/.test(range)) return;
  const kind = /^Mozilla\//.test(ua) ? 'web' : 'cli';
  const once = await limit(env, [[`dl:${file}:${await ipKey(env, request)}`, 1, 86400]]);
  if (!once.ok) return;
  await bump(env, [[utcDay(), `dl:${kind}:${file}`]]);
}
