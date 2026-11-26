// The parts handled outside a server's own object: WebSockets and the once-a-minute check.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, chatEvent, makeServer, newKey, upload, viewerCookie } from './helpers.js';

const tenant = (s) => env.TENANT.get(env.TENANT.idFromName(s.id));
const ws = (path, headers) => call(path, { headers: { Upgrade: 'websocket', ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe('WebSockets', () => {
  it('a server’s live updates open for its viewers only', async () => {
    const a = await makeServer('ws-a');
    const b = await makeServer('ws-b');
    const res = await ws(`/${a.slug}/api/live`, { Cookie: await viewerCookie(a) });
    expect(res.status).toBe(101);
    res.webSocket.accept();
    res.webSocket.close();
    expect((await ws(`/${b.slug}/api/live`, { Cookie: await viewerCookie(a) })).status).toBe(401);
  });

  it('the mod’s link connects with its server’s key only', async () => {
    const a = await makeServer('link-a');
    const key = await newKey(a);
    const res = await ws('/api/ingest/link', { Authorization: `Bearer ${key}` });
    expect(res.status).toBe(101);
    res.webSocket.accept();
    res.webSocket.close();
    expect((await ws('/api/ingest/link', { Authorization: 'Bearer mcs_0123456789abcdef_' + 'x'.repeat(43) })).status).toBe(401);
  });
});

describe('the status check', () => {
  it('runs per server, on that server’s own alarm, and writes only to it', async () => {
    const a = await makeServer('poll-a');
    const b = await makeServer('poll-b');
    // no address: no alarm
    expect(await runInDurableObject(tenant(a), (_o, s) => s.storage.getAlarm())).toBe(null);
    const set = await call(`/api/site/servers/${a.slug}/settings`, { method: 'POST', cookie: a.cookie, body: { MC_SERVER: 'play.example.invalid' } });
    expect(set.status, await set.clone().text()).toBe(200);
    expect(await runInDurableObject(tenant(a), (_o, s) => s.storage.getAlarm())).toBeGreaterThan(Date.now());
    expect(await runInDurableObject(tenant(b), (_o, s) => s.storage.getAlarm())).toBe(null);

    // the status API can't be reached here; the mod's own list of who's on is enough to record a minute
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
    const key = await newKey(a);
    const online = await upload(key, null, { path: '/api/ingest/online', body: { players: [{ uuid: '00000000-0000-4000-8000-0000000000bb', name: 'Alex' }] } });
    expect(online.status, await online.clone().text()).toBe(200);
    expect(await runDurableObjectAlarm(tenant(a))).toBe(true);
    const snapsA = await runInDurableObject(tenant(a), (_o, s) => s.storage.sql.exec('SELECT COUNT(*) AS n FROM snapshots').one().n);
    const snapsB = await runInDurableObject(tenant(b), (_o, s) => s.storage.sql.exec('SELECT COUNT(*) AS n FROM snapshots').one().n);
    expect(snapsA).toBe(1);
    expect(snapsB).toBe(0);
    // and it set itself again for the next minute
    expect(await runInDurableObject(tenant(a), (_o, s) => s.storage.getAlarm())).toBeGreaterThan(Date.now());
    const status = await (await call(`/${a.slug}/api/status`, { cookie: await viewerCookie(a) })).json();
    expect(status.online.map((p) => p.name)).toEqual(['Alex']);
  });
});

describe('a server with no address', () => {
  it('records sessions from the mod’s list alone, from its first upload on', async () => {
    const a = await makeServer('noaddr-a');
    expect(await runInDurableObject(tenant(a), (_o, s) => s.storage.getAlarm())).toBe(null);
    // no address means nothing to ping: the status API must not be asked
    const asked = [];
    vi.stubGlobal('fetch', async (u) => { asked.push(String(u)); return new Response('{}', { status: 503 }); });
    const key = await newKey(a);
    const online = await upload(key, null, { path: '/api/ingest/online', body: { players: [{ uuid: '00000000-0000-4000-8000-0000000000cc', name: 'Steve' }] } });
    expect(online.status, await online.clone().text()).toBe(200);
    // the first upload started the checks
    expect(await runInDurableObject(tenant(a), (_o, s) => s.storage.getAlarm())).toBeGreaterThan(Date.now());
    expect(await runDurableObjectAlarm(tenant(a))).toBe(true);
    expect(asked.some((u) => u.includes('mcstatus.io'))).toBe(false);
    const rows = await runInDurableObject(tenant(a), (_o, s) => ({
      snaps: s.storage.sql.exec('SELECT online FROM snapshots').toArray(),
      sessions: s.storage.sql.exec('SELECT p.name FROM sessions x JOIN players p ON p.uuid = x.uuid').toArray().map((r) => r.name),
    }));
    expect(rows.snaps).toEqual([{ online: 1 }]);
    expect(rows.sessions).toEqual(['Steve']);
    expect(await runInDurableObject(tenant(a), (_o, s) => s.storage.getAlarm())).toBeGreaterThan(Date.now());
  });
});

describe('a player page before any minute is recorded', () => {
  it('shows players the mod has named, and still 404s for nobody', async () => {
    const a = await makeServer('early-page');
    const key = await newKey(a);
    const view = await viewerCookie(a);
    const page = (uuid) => call(`/${a.slug}/api/player/${uuid}`, { cookie: view });
    // on now, by the mod's list
    const alex = 'acb4cbcb-0824-4e60-b578-0fe604008bb0';
    expect((await upload(key, null, { path: '/api/ingest/online', body: { players: [{ uuid: alex, name: 'Alex' }] } })).status).toBe(200);
    const res = await page(alex);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();
    expect(body.player).toMatchObject({ uuid: alex, name: 'Alex', first_seen: null });
    expect(body.sessions).toEqual([]);
    // only in the chat log
    expect((await upload(key, [chatEvent('hi', { name: 'Steve', uuid: '00000000-0000-4000-8000-0000000000dd' })])).status).toBe(200);
    expect((await (await page('00000000-0000-4000-8000-0000000000dd')).json()).player.name).toBe('Steve');
    // nobody the server has seen
    expect((await page('00000000-0000-4000-8000-0000000000ee')).status).toBe(404);
  });
});
