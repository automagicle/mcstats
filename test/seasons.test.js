// Seasons made and moved from Admin → Server (src/seasonadmin.js): by admins only, with a typed
// confirmation, in order, and never losing anything.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, idCookie, makeServer, viewerCookie } from './helpers.js';

const tenant = (s) => env.TENANT.get(env.TENANT.idFromName(s.id));
const seasons = (server, cookie, body) => call(`/s/${server.slug}/api/admin/seasons`, { method: body ? 'POST' : 'GET', cookie, body });
const get = async (server, cookie) => (await seasons(server, cookie)).json();
const pageSeason = async (slug, cookie) => Number(/"season":(\d+)/.exec(await (await call(`/s/${slug}/`, { cookie })).text())?.[1]);
const now = () => Math.floor(Date.now() / 1000);
const HOUR = 3600;

describe('a new server', () => {
  it('is in season 1, which has no start to set and no archive', async () => {
    const a = await makeServer('se-new');
    const owner = await idCookie(a, a.owner);
    expect(await get(a, owner)).toMatchObject({ current: 1, seasons: [{ n: 1, start: null, end: null, started: true, ended: false }] });
    expect(await pageSeason(a.slug, owner)).toBe(1);
    expect((await call(`/s/${a.slug}/s1/`, { cookie: owner })).status).toBe(404);
    for (const body of [{ action: 'update', n: 1, start: now() }, { action: 'remove', confirm: 'Season 1' }]) expect((await seasons(a, owner, body)).status).toBe(400);
  });
});

describe('making a season', () => {
  it('is for admins, and needs its name typed', async () => {
    const a = await makeServer('se-who');
    const owner = await idCookie(a, a.owner);
    expect((await seasons(a, await viewerCookie(a))).status).toBe(403);
    expect((await seasons(a, await viewerCookie(a), { action: 'create', confirm: 'Season 2' })).status).toBe(403);
    expect((await call(`/api/site/servers/${a.slug}/invite`, { method: 'POST', cookie: a.cookie, body: { email: 'se-member@example.org', role: 'member' } })).status).toBe(200);
    expect((await seasons(a, await idCookie(a, 'se-member@example.org'), { action: 'create', confirm: 'Season 2' })).status).toBe(403);
    // another server's owner is nobody here
    const b = await makeServer('se-who-b');
    expect((await seasons(a, await idCookie(b, b.owner), { action: 'create', confirm: 'Season 2' })).status).toBe(401);
    for (const confirm of [undefined, '', 'yes', 'Season 3', 'season2']) {
      const res = await seasons(a, owner, { action: 'create', confirm });
      expect([res.status, (await res.json()).field], String(confirm)).toEqual([400, 'confirm']);
    }
    expect((await get(a, owner)).current).toBe(1);
    expect((await seasons(a, owner, { action: 'create', confirm: ' season 2 ' })).status).toBe(200);
    expect((await get(a, owner)).current).toBe(2);
  });

  it('starting now: the main page is the new season and the old one is its archive', async () => {
    const a = await makeServer('se-now');
    const owner = await idCookie(a, a.owner);
    const out = await (await seasons(a, owner, { action: 'create', confirm: 'Season 2' })).json();
    expect(out.current).toBe(2);
    expect(out.seasons[1]).toMatchObject({ n: 2, started: true, ended: false, end: null, opens: null });
    expect(out.seasons[0]).toMatchObject({ n: 1, ended: true, end: out.seasons[1].start });
    expect(Math.abs(out.seasons[1].start - now())).toBeLessThan(5);
    expect(await pageSeason(a.slug, owner)).toBe(2);
    expect((await call(`/s/${a.slug}/s1/`, { cookie: owner })).status).toBe(200);
    const status = await (await call(`/s/${a.slug}/api/status?season=2`, { cookie: owner })).json();
    expect(status.season).toMatchObject({ n: 2, started: true });
  });

  it('starting later: the new season waits, and another can’t be made until it has begun', async () => {
    const a = await makeServer('se-later');
    const owner = await idCookie(a, a.owner);
    const start = now() + 48 * HOUR;
    const out = await (await seasons(a, owner, { action: 'create', confirm: 'Season 2', start })).json();
    expect(out.seasons[1]).toMatchObject({ n: 2, start, started: false });
    expect(out.seasons[0]).toMatchObject({ n: 1, ended: false, end: start });
    const status = await (await call(`/s/${a.slug}/api/status?season=2`, { cookie: owner })).json();
    expect(status.season).toMatchObject({ n: 2, started: false, start });
    expect((await seasons(a, owner, { action: 'create', confirm: 'Season 3' })).status).toBe(400);
    expect((await get(a, owner)).current).toBe(2);
  });

  it('refuses a start that isn’t after the season before, or isn’t a time', async () => {
    const a = await makeServer('se-order');
    const owner = await idCookie(a, a.owner);
    expect((await seasons(a, owner, { action: 'create', confirm: 'Season 2', start: now() - HOUR })).status).toBe(200);
    for (const start of [now() - 2 * HOUR, 'tomorrow', 12.5, now() + 400 * 86400]) {
      const res = await seasons(a, owner, { action: 'create', confirm: 'Season 3', start });
      expect([res.status, (await res.json()).field], String(start)).toEqual([400, 'start']);
    }
    expect((await get(a, owner)).current).toBe(2);
  });

  it('brings the teams, players and their emails over only when asked', async () => {
    const a = await makeServer('se-copy');
    const owner = await idCookie(a, a.owner);
    await runInDurableObject(tenant(a), async (_o, state) => {
      state.storage.sql.exec("INSERT INTO teams (season, id, name, short, color, sort) VALUES (1, 'red', 'Red', 'Red', '#ff0000', 0)");
      state.storage.sql.exec("INSERT INTO roster (season, ign, name, team) VALUES (1, 'Steve', 'Steve', 'red')");
      state.storage.sql.exec("INSERT INTO roster_email (season, email, ign) VALUES (1, 'steve@example.org', 'Steve')");
    });
    const count = (season) => runInDurableObject(tenant(a), async (_o, state) => ['teams', 'roster', 'roster_email']
      .map((t) => state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${t} WHERE season = ?`, season).one().n));
    expect((await seasons(a, owner, { action: 'create', confirm: 'Season 2', start: now() - HOUR })).status).toBe(200);
    expect(await count(2)).toEqual([0, 0, 0]);
    expect((await seasons(a, owner, { action: 'create', confirm: 'Season 3', copy: true })).status).toBe(200);
    expect(await count(3)).toEqual([0, 0, 0]); // season 2 had none to bring
    expect((await seasons(a, owner, { action: 'remove', confirm: 'Season 3' })).status).toBe(200);
    expect((await seasons(a, owner, { action: 'remove', confirm: 'Season 2' })).status).toBe(200);
    expect((await seasons(a, owner, { action: 'create', confirm: 'Season 2', copy: true })).status).toBe(200);
    expect(await count(2)).toEqual([1, 1, 1]);
    expect(await count(1)).toEqual([1, 1, 1]);
  });
});

describe('moving and removing seasons', () => {
  it('a start can move, but seasons stay in order', async () => {
    const a = await makeServer('se-move');
    const owner = await idCookie(a, a.owner);
    const s2 = now() - 10 * HOUR, s3 = now() - 5 * HOUR;
    expect((await seasons(a, owner, { action: 'create', confirm: 'Season 2', start: s2 })).status).toBe(200);
    expect((await seasons(a, owner, { action: 'create', confirm: 'Season 3', start: s3 })).status).toBe(200);
    // season 2 can't start after season 3, nor season 3 before season 2
    expect((await seasons(a, owner, { action: 'update', n: 2, start: s3 + 60 })).status).toBe(400);
    expect((await seasons(a, owner, { action: 'update', n: 3, start: s2 })).status).toBe(400);
    expect((await seasons(a, owner, { action: 'update', n: 4, start: now() })).status).toBe(400);
    const moved = await (await seasons(a, owner, { action: 'update', n: 2, start: s2 + HOUR })).json();
    expect(moved.seasons.map((s) => [s.start, s.end])).toEqual([[null, s2 + HOUR], [s2 + HOUR, s3], [s3, null]]);
    // the official opening sits inside its season
    for (const opens of [s3 - 60, s3]) expect((await seasons(a, owner, { action: 'update', n: 3, start: s3, opens })).status, String(opens)).toBe(400);
    expect((await (await seasons(a, owner, { action: 'update', n: 3, start: s3, opens: s3 + HOUR })).json()).seasons[2].opens).toBe(s3 + HOUR);
    expect((await (await seasons(a, owner, { action: 'update', n: 3, start: s3 })).json()).seasons[2].opens).toBe(null);
  });

  it('removing the newest season gives its time back to the one before', async () => {
    const a = await makeServer('se-remove');
    const owner = await idCookie(a, a.owner);
    expect((await seasons(a, owner, { action: 'create', confirm: 'Season 2' })).status).toBe(200);
    expect((await seasons(a, owner, { action: 'remove', confirm: 'Season 1' })).status).toBe(400);
    expect((await seasons(a, owner, { action: 'remove' })).status).toBe(400);
    const out = await (await seasons(a, owner, { action: 'remove', confirm: 'Season 2' })).json();
    expect(out).toMatchObject({ current: 1, seasons: [{ n: 1, end: null, ended: false }] });
    expect(await pageSeason(a.slug, owner)).toBe(1);
    expect((await call(`/s/${a.slug}/s1/`, { cookie: owner })).status).toBe(404);
  });
});
