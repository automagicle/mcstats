// Site analytics (src/siteanalytics.js, src/census.js, src/sitecounts.js): who may see it (and what everyone else
// sees instead), the census of the servers and what it keeps, counting devices without telling them apart,
// active accounts, mod downloads, baselines and viewers.
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountCookie, call, makeServer, ORIGIN } from './helpers.js';
import { MOD } from '../src/modinfo.gen.js';
import { hourlyCensus } from '../src/census.js';
import { RESERVED } from '../src/directory.js';

const OPERATOR = 'operator@example.org'; // SUPER_ADMIN_EMAIL in vitest.config.mjs
const today = () => new Date().toISOString().slice(0, 10);
const count = async (metric, day = today()) =>
  (await env.DIRECTORY.prepare('SELECT n FROM site_counts WHERE day = ? AND metric = ?').bind(day, metric).first('n')) ?? 0;
const data = async (cookie) => {
  const res = await call('/api/site-analytics/data', { cookie });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
};
const census = async (cookie) => {
  const res = await call('/api/site-analytics/census', { method: 'POST', cookie, body: { since: Math.floor(Date.now() / 1000) + 1 } });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
};

afterEach(() => vi.unstubAllGlobals());

// First, while this file's directory holds only what it makes here, so the totals can be exact.
describe('the census of the servers', () => {
  it('puts each account’s roles together across servers, and keeps no emails', async () => {
    const a = await makeServer('sa-alpha', { owner: 'alpha@example.org' });
    const b = await makeServer('sa-beta', { owner: 'beta@example.org' });
    await accountCookie('both@example.org');
    for (const [s, role] of [[a, 'admin'], [b, 'member']]) {
      const res = await call(`/api/site/servers/${s.slug}/invite`, { method: 'POST', cookie: s.cookie, body: { email: 'both@example.org', role } });
      expect(res.status).toBe(200);
    }
    // invited by email, never made an account
    expect((await call(`/api/site/servers/${a.slug}/invite`, { method: 'POST', cookie: a.cookie, body: { email: 'later@example.org', role: 'member' } })).status).toBe(200);

    const op = await accountCookie(OPERATOR);
    const r = await census(op);
    expect(r).toMatchObject({ asked: 2, failed: 0, left: 0 });

    const stored = await env.DIRECTORY.prepare('SELECT data FROM server_census').all();
    expect(stored.results).toHaveLength(2);
    for (const row of stored.results) {
      expect(row.data).not.toContain('@'); // tags, not addresses
      expect(row.data).not.toContain('sa-alpha');
    }

    const d = await data(op);
    expect(d.totals).toMatchObject({
      servers: 2,
      accounts: 4, // alpha, beta, both, the operator
      roles: { owner: 2, mixed: 1, none: 1, member: 0, admin: 0 },
      invited_no_account: 1,
      servers_per_account: { 1: 2, 2: 1, '3+': 0 },
      census: { counted: 2, failed: 0, missing: 0 },
    });
    expect(d.history.servers.reduce((n, [, k]) => n + k, 0)).toBe(2);
    // the page's own visit keeps today's snapshot up to date
    expect(d.snapshots.at(-1)[0]).toBe(today());
    expect(d.snapshots.at(-1)[1]).toMatchObject({ servers: 2, accounts: 4 });
  });

  it('the hourly run asks the servers, reads the bot’s Discord count and keeps today’s numbers', async () => {
    const asked = [];
    vi.stubGlobal('fetch', async (u) => {
      asked.push(String(u));
      return Response.json({ id: '1', approximate_guild_count: 7 });
    });
    await env.DIRECTORY.prepare('DELETE FROM site_snapshots').run();
    await hourlyCensus(env);
    expect(asked.some((u) => u.endsWith('/applications/@me'))).toBe(true);
    expect(await count('discord:guilds')).toBe(7);
    const snap = await env.DIRECTORY.prepare('SELECT data FROM site_snapshots WHERE day = ?').bind(today()).first('data');
    expect(JSON.parse(snap)).toMatchObject({ servers: 2 });
  });
});

describe('who can see it', () => {
  it('says “not authorized” to anyone signed out, with a way to sign in', async () => {
    const res = await call('/site-analytics');
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Not authorized');
    expect(html).toContain('/account?next=%2Fsite-analytics');
    expect(html).not.toContain('/join');
    const api = await call('/api/site-analytics/data');
    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({ error: 'not authorized' });
    expect((await call('/site-analytics.js')).status).toBe(403);
    expect((await call('/site-analytics.html')).status).toBe(403);
  });

  it('and to a signed-in account that isn’t let in, even one that owns a server', async () => {
    const s = await makeServer('sa-owner');
    const page = await call('/site-analytics', { cookie: s.cookie });
    expect(page.status).toBe(403);
    expect(await page.text()).toContain(s.owner);
    expect((await call('/site-analytics.js', { cookie: s.cookie })).status).toBe(403);
    expect((await call('/api/site-analytics/data', { cookie: s.cookie })).status).toBe(403);
    expect((await call('/api/site-analytics/viewers', { method: 'POST', cookie: s.cookie, body: { email: 'me@example.org' } })).status).toBe(403);
  });

  it('a super admin gets the page and its script, kept out of search engines', async () => {
    const op = await accountCookie(OPERATOR);
    const page = await call('/site-analytics', { cookie: op });
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toContain('text/html');
    expect(page.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(await page.text()).toContain('/site-analytics.js');
    const script = await call('/site-analytics.js', { cookie: op });
    expect(script.status).toBe(200);
    expect(await script.text()).toContain('/api/site-analytics/data');
  });

  it('a super admin lets another account in; it can look and refresh but not change anything', async () => {
    const op = await accountCookie(OPERATOR);
    const friend = await accountCookie('friend@example.org');
    expect((await call('/api/site-analytics/data', { cookie: friend })).status).toBe(403);

    const add = await call('/api/site-analytics/viewers', { method: 'POST', cookie: op, body: { email: 'Friend@Example.org' } });
    expect(add.status).toBe(200);
    expect((await add.json()).viewers.map((v) => v.email)).toEqual(['friend@example.org']);

    const d = await data(friend);
    expect(d.me).toEqual({ email: 'friend@example.org', super: false });
    expect(d.access).toBeNull(); // the viewer list is the super admins' business
    expect((await call('/site-analytics', { cookie: friend })).status).toBe(200);
    expect((await call('/api/site-analytics/census', { method: 'POST', cookie: friend, body: {} })).status).toBe(200);
    expect((await call('/api/site-analytics/baselines', { method: 'POST', cookie: friend, body: { metric: 'accounts', value: 3 } })).status).toBe(403);
    expect((await call('/api/site-analytics/viewers', { method: 'POST', cookie: friend, body: { email: 'other@example.org' } })).status).toBe(403);

    // super admins can't be added (they're always in), and a request from another site is refused
    expect((await call('/api/site-analytics/viewers', { method: 'POST', cookie: op, body: { email: OPERATOR } })).status).toBe(400);
    expect((await call('/api/site-analytics/viewers', { method: 'POST', cookie: op, body: { email: 'x@example.org' }, headers: { Origin: 'https://evil.example' } })).status).toBe(403);

    expect((await call('/api/site-analytics/viewers', { method: 'POST', cookie: op, body: { email: 'friend@example.org', remove: true } })).status).toBe(200);
    expect((await call('/api/site-analytics/data', { cookie: friend })).status).toBe(403);
  });

  it('no server can take its address, and both spellings are reserved names', async () => {
    const cookie = await accountCookie('taker@example.org');
    for (const slug of ['site-analytics', 'siteanalytics']) {
      expect(RESERVED.has(slug)).toBe(true);
      const res = await call('/api/site/servers', { method: 'POST', cookie, body: { name: 'Site analytics', slug, password: 'password-123', confirm: 'password-123' } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/reserved/);
    }
  });
});

describe('baselines', () => {
  it('are set, checked and removed by a super admin', async () => {
    const op = await accountCookie(OPERATOR);
    const set = (b) => call('/api/site-analytics/baselines', { method: 'POST', cookie: op, body: b });
    expect((await set({ metric: 'accounts', value: -1 })).status).toBe(400);
    expect((await set({ metric: 'accounts', value: 1.5 })).status).toBe(400);
    expect((await set({ metric: 'players', value: 1 })).status).toBe(400);
    expect((await set({ metric: 'servers', value: 2, from_day: '2026-02-30' })).status).toBe(400);
    expect((await set({ metric: 'accounts', value: 12, note: 'test accounts' })).status).toBe(200);
    const res = await set({ metric: 'accounts', value: 20, from_day: '2026-12-01' });
    const list = (await res.json()).baselines.filter((b) => b.metric === 'accounts');
    expect(list.map((b) => [b.value, b.from_day])).toEqual([[12, null], [20, '2026-12-01']]);
    const after = await set({ remove: list[1].id });
    expect((await after.json()).baselines.filter((b) => b.metric === 'accounts').map((b) => b.value)).toEqual([12]);
  });
});

describe('counting devices', () => {
  const visit = (b, { cookie, headers } = {}) => call('/api/site/visit', { method: 'POST', cookie, body: b, headers: { 'User-Agent': 'Mozilla/5.0 (test)', ...headers } });

  it('a new browser counts once a day, week and month, and again only in a new period', async () => {
    const before = { d: await count('dev:a:d'), n: await count('dev:new') };
    const res = await visit({ a: null, s: {}, b: null, n: true }); // s is ignored when signed out
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ signedIn: false, counted: { a: null, s: null, b: null } });

    const first = await (await visit({ a: {}, s: {}, b: {}, n: true })).json();
    expect(first.counted).toEqual({ a: 'dwm', s: null, b: 'dwm' });
    expect(await count('dev:a:d')).toBe(before.d + 1);
    expect(await count('dev:new')).toBe(before.n + 1);
    expect(await count('dev:s:d')).toBe(0);

    // the same browser, sending back what it was told to remember: nothing more
    const again = await (await visit({ a: first.periods, b: first.periods, n: false })).json();
    expect(again.counted).toEqual({ a: '', s: null, b: '' });
    expect(await count('dev:a:d')).toBe(before.d + 1);

    // yesterday's day, this week and month already counted: just the day
    const y = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const stale = { ...first.periods, d: y };
    expect((await (await visit({ a: stale })).json()).counted.a).toBe('d');
  });

  it('signed in is decided here, from the account cookie', async () => {
    const cookie = await accountCookie('visitor@example.org');
    const before = await count('dev:s:d');
    const out = await (await visit({ a: {}, s: {} }, { cookie })).json();
    expect(out).toMatchObject({ signedIn: true, counted: { s: 'dwm' } });
    expect(await count('dev:s:d')).toBe(before + 1);
  });

  it('nothing from crawlers, nothing from other sites, nothing that isn’t JSON', async () => {
    const before = await count('dev:a:d');
    expect((await (await visit({ a: {} }, { headers: { 'User-Agent': 'Googlebot/2.1' } })).json()).counted).toBeNull();
    expect((await visit({ a: {} }, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    const form = await SELF.fetch(`${ORIGIN}/api/site/visit`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: '{"a":{}}' });
    expect(form.status).toBe(415);
    expect(await count('dev:a:d')).toBe(before);
  });
});

describe('active accounts', () => {
  it('counts an account once a day when it uses the site', async () => {
    const cookie = await accountCookie('active@example.org');
    const before = await count('acct:d');
    expect((await call('/api/account/me', { cookie })).status).toBe(200);
    expect(await count('acct:d')).toBe(before + 1);
    const row = await env.DIRECTORY.prepare("SELECT seen_day FROM accounts WHERE email = 'active@example.org'").first();
    expect(row.seen_day).toBe(today());
    // another session of the same account, the same day: not again
    const other = await accountCookie('active@example.org');
    await call('/api/account/me', { cookie: other });
    expect(await count('acct:d')).toBe(before + 1);
  });
});

describe('mod downloads', () => {
  // as a browser asks for it in the end (the "+" in a jar's name is redirected to %2B first)
  const get = (path, headers = {}) => SELF.fetch(`${ORIGIN}${path.replace(/\+/g, '%2B')}`, { headers });
  const settle = () => new Promise((r) => setTimeout(r, 400)); // counted after the answer (waitUntil)

  it('counts a jar once per address a day, browsers apart from other tools', async () => {
    const jar = MOD.jar;
    const res = await get(`/downloads/${jar}`, { 'User-Agent': 'Mozilla/5.0 (Macintosh)' });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    await settle();
    expect(await count(`dl:web:${jar}`)).toBe(1);

    await (await get(`/downloads/${jar}`, { 'User-Agent': 'Mozilla/5.0 (Macintosh)' })).arrayBuffer();
    await settle();
    expect(await count(`dl:web:${jar}`)).toBe(1);

    // the rest of a download already started isn't another one; a crawler isn't one at all
    const other = MOD.downloads.find((d) => d.file !== jar).file;
    await (await get(`/downloads/${other}`, { 'User-Agent': 'curl/8.4.0', Range: 'bytes=1000-' })).arrayBuffer();
    await (await get(`/downloads/${other}`, { 'User-Agent': 'Googlebot/2.1' })).arrayBuffer();
    await settle();
    expect(await count(`dl:cli:${other}`)).toBe(0);
    await (await get(`/downloads/${other}`, { 'User-Agent': 'curl/8.4.0' })).arrayBuffer();
    await settle();
    expect(await count(`dl:cli:${other}`)).toBe(1);
  });
});
