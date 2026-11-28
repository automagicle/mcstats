// Servers can't see or change each other. Each test makes its own servers.
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  accountCookie, call, chatEvent, chatTexts, cookieOf, idCookie, makeServer, newKey, ORIGIN, siteCookie, upload, viewerCookie,
} from './helpers.js';

const tenant = (s) => env.TENANT.get(env.TENANT.idFromName(s.id));
const both = (...cookies) => cookies.filter(Boolean).join('; ');

describe('mod keys', () => {
  it('server B’s key writes to B only, whatever server the request names', async () => {
    const a = await makeServer('keys-a');
    const b = await makeServer('keys-b');
    const keyB = await newKey(b);
    await newKey(a);
    // a forged server id and slug in the query, the body and our own internal headers: all ignored
    const res = await upload(keyB, null, {
      query: `?server=${a.id}&slug=${a.slug}`,
      body: { server: a.id, slug: a.slug, server_id: a.id, events: [chatEvent('written with B’s key')] },
    });
    expect(res.status).toBe(200);
    const forged = await SELFfetchWithHeaders(keyB, { 'X-MCS-Ingest': '1', 'X-MCS-Who': JSON.stringify({ viewer: true, email: a.owner }), 'X-MCS-Server-Id': a.id });
    expect(forged.status).toBe(200);

    expect((await chatTexts(b, await viewerCookie(b))).texts).toEqual(expect.arrayContaining(['written with B’s key', 'forged headers']));
    expect((await chatTexts(a, await viewerCookie(a))).texts).toEqual([]);
  });

  it('a key made of A’s id and B’s secret is refused', async () => {
    const a = await makeServer('splice-a');
    const b = await makeServer('splice-b');
    await newKey(a);
    const keyB = await newKey(b);
    const spliced = keyB.replace(`mcs_${b.id}_`, `mcs_${a.id}_`);
    const res = await upload(spliced, [chatEvent('spliced')]);
    expect(res.status).toBe(401);
    expect((await chatTexts(a, await viewerCookie(a))).texts).toEqual([]);
    expect((await chatTexts(b, await viewerCookie(b))).texts).toEqual([]);
  });

  it('a rotated key stops working at once, for uploads and for the mod’s WebSockets', async () => {
    const a = await makeServer('rotate-a');
    const old = await newKey(a);
    expect((await upload(old, [chatEvent('before')])).status).toBe(200);
    const fresh = await newKey(a);
    expect((await upload(old, [chatEvent('after, old key')])).status).toBe(401);
    expect((await upload(old, [], { path: '/api/ingest/link' })).status).toBe(401);
    expect((await upload(fresh, [chatEvent('after, new key')])).status).toBe(200);
    expect((await chatTexts(a, await viewerCookie(a))).texts).toEqual(['before', 'after, new key']);
  });

  it('the old shared token reaches the first server only, and only once it is marked as that server', async () => {
    const legacy = env.CHAT_INGEST_TOKEN;
    // before the first server exists the old token goes nowhere
    expect((await upload(legacy, [chatEvent('too early')])).status).toBe(401);
    const res = await call('/api/ops/servers', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPS_TOKEN}` },
      body: { slug: env.LEGACY_SLUG, name: 'eggSMP', owner: 'owner@example.org', password: 'first-server-pw', legacy: true },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const other = await makeServer('not-legacy');
    expect((await upload(legacy, [chatEvent('old mod')])).status).toBe(200);
    const first = { slug: env.LEGACY_SLUG, password: 'first-server-pw' };
    expect((await chatTexts(first, await viewerCookie(first))).texts).toEqual(['old mod']);
    expect((await chatTexts(other, await viewerCookie(other))).texts).toEqual([]);
    // the old ADMIN_EMAIL logins are admins of the first server, and only of it
    const fromInfo = await runInDurableObject(tenant(other), (_o, state) => state.storage.sql.exec('SELECT COUNT(*) AS n FROM user_perms WHERE email = ?', 'oldadmin@example.org').one().n);
    expect(fromInfo).toBe(0);
  });
});

// An upload carrying our internal headers, as if a client tried to set them itself.
function SELFfetchWithHeaders(token, headers) {
  return SELF.fetch(`${ORIGIN}/api/ingest/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ events: [chatEvent('forged headers')] }),
  });
}

describe('viewer sessions', () => {
  it('joining A gives a cookie for A’s pages only', async () => {
    const a = await makeServer('view-a');
    const res = await call('/api/site/join', { method: 'POST', body: { server: a.slug, password: a.password } });
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().find((c) => c.startsWith('mcs_view='));
    expect(set).toMatch(/Path=\/view-a;/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/);
  });

  it('A’s viewer gets nothing from B’s pages or API, even sending A’s cookie there', async () => {
    const a = await makeServer('see-a');
    const b = await makeServer('see-b');
    await upload(await newKey(b), [chatEvent('B’s secret chat')]);
    const viewA = await viewerCookie(a);
    for (const path of ['/api/status', '/api/chat', '/api/roster', '/api/leaderboard', '/api/me', '/api/chat/search?q=secret', '/api/mc/textures/item/diamond.png']) {
      const res = await call(`/${b.slug}${path}`, { cookie: viewA });
      expect(res.status, path).toBe(401);
      expect(await res.text(), path).not.toContain('secret chat');
    }
    const page = await call(`/${b.slug}`, { cookie: viewA });
    expect(page.status).toBe(302);
    expect(page.headers.get('Location')).toBe(`/join?server=${b.slug}`);
    // and with it, A's own page works
    expect((await call(`/${a.slug}`, { cookie: viewA })).status).toBe(200);
  });

  it('a client can’t claim to be a viewer by sending our internal header', async () => {
    const b = await makeServer('hdr-b');
    const res = await call(`/${b.slug}/api/status`, { headers: { 'X-MCS-Who': JSON.stringify({ viewer: true, email: b.owner }) } });
    expect(res.status).toBe(401);
  });

  it('a new join password ends the viewer sessions made with the old one', async () => {
    const a = await makeServer('pw-change');
    const view = await viewerCookie(a);
    expect((await call(`/${a.slug}/api/status`, { cookie: view })).status).toBe(200);
    const res = await call(`/api/site/servers/${a.slug}/settings`, { method: 'POST', cookie: a.cookie, body: { password: 'a-brand-new-password', confirm: 'a-brand-new-password' } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await call(`/${a.slug}/api/status`, { cookie: view })).status).toBe(401);
  });
});

describe('admins and members', () => {
  it('an admin of A is not an admin of B', async () => {
    const a = await makeServer('adm-a');
    const b = await makeServer('adm-b');
    const ownerA = await idCookie(a, a.owner);
    const adminA = await call(`/${a.slug}/api/admin?season=1`, { cookie: ownerA });
    expect(adminA.status).toBe(200);
    // the Mod and data page's download picker: every jar, starting on one the site has
    const { mod } = await adminA.json();
    expect(mod.downloads.length).toBeGreaterThan(0);
    expect(mod.downloads.map((d) => d.file)).toContain(mod.suggested);
    expect((await (await call(`/${a.slug}/api/me`, { cookie: ownerA })).json()).admin).toBe(true);

    // A's owner, signed in, on B: not let in at all
    expect((await call(`/${b.slug}/api/admin?season=1`, { cookie: ownerA })).status).toBe(401);
    // the same account, able to look at B: still nobody there
    const onB = both(await viewerCookie(b), await idCookie(b, a.owner));
    const me = await (await call(`/${b.slug}/api/me`, { cookie: onB })).json();
    expect(me.admin).toBe(false);
    expect(me.email).toBe(null);
    expect((await call(`/${b.slug}/api/admin?season=1`, { cookie: onB })).status).toBe(403);
    expect((await call(`/${b.slug}/api/admin/roles`, { cookie: onB })).status).toBe(403);
    // B's owner makes them a member of B: a member, not an admin
    expect((await call(`/api/site/servers/${b.slug}/invite`, { method: 'POST', cookie: b.cookie, body: { email: a.owner, role: 'member' } })).status).toBe(200);
    const asMember = await (await call(`/${b.slug}/api/me`, { cookie: onB })).json();
    expect(asMember.role).toBe('member');
    expect(asMember.admin).toBe(false);
    expect((await call(`/${b.slug}/api/admin?season=1`, { cookie: onB })).status).toBe(403);
  });

  it('an admin invited to A can use its Roles tab, and gets nowhere on B', async () => {
    const a = await makeServer('inv-a');
    const b = await makeServer('inv-b');
    expect((await call(`/api/site/servers/${a.slug}/invite`, { method: 'POST', cookie: a.cookie, body: { email: 'helper@example.org', role: 'admin' } })).status).toBe(200);
    const helperA = await idCookie(a, 'helper@example.org');
    expect((await call(`/${a.slug}/api/admin?season=1`, { cookie: helperA })).status).toBe(200);
    expect((await call(`/${a.slug}/api/admin/roles`, { cookie: helperA })).status).toBe(200);
    expect((await call(`/${b.slug}/api/admin/roles`, { cookie: helperA })).status).not.toBe(200);
    const helperOnB = both(await viewerCookie(b), await idCookie(b, 'helper@example.org'));
    expect((await call(`/${b.slug}/api/admin?season=1`, { cookie: helperOnB })).status).toBe(403);
    // someone else's server can't be set up from /new either
    expect((await call(`/api/site/servers/${b.slug}`, { cookie: a.cookie })).status).toBe(404);
    expect((await call(`/api/site/servers/${b.slug}/key`, { method: 'POST', cookie: a.cookie, body: {} })).status).toBe(404);
  });

  it('a signed-in account is nobody on a server until it asks to be a member, and then only there', async () => {
    const a = await makeServer('code-a');
    const b = await makeServer('code-b');
    const player = await accountCookie('player@example.org');
    const enter = (server, cookie) => call(`/${server.slug}/api/auth/enter`, { method: 'POST', cookie, body: {} });
    // signed in, but can't see A: nothing, and no member is made
    expect((await call(`/${a.slug}/api/me`, { cookie: player })).status).toBe(401);
    expect((await enter(a, player)).status).toBe(401);
    // nobody signed in: nothing to make a member of
    const viewA = await viewerCookie(a);
    expect((await enter(a, viewA)).status).toBe(401);
    // joined with the password: can look, and is still nobody until they ask
    const onA = both(viewA, player);
    expect((await (await call(`/${a.slug}/api/me`, { cookie: onA })).json()).email).toBe(null);
    expect((await enter(a, onA)).status).toBe(200);
    expect((await (await call(`/${a.slug}/api/me`, { cookie: onA })).json()).role).toBe('member');
    // a member gets in with the account alone, from any browser
    expect((await (await call(`/${a.slug}/api/me`, { cookie: player })).json()).role).toBe('member');
    // on B: still nothing, and looking at B doesn't make them a member of it
    expect((await call(`/${b.slug}/api/me`, { cookie: player })).status).toBe(401);
    const onB = await (await call(`/${b.slug}/api/me`, { cookie: both(await viewerCookie(b), player) })).json();
    expect(onB.email).toBe(null);
    // asking twice changes nothing: an admin who asks stays an admin
    const ownerA = await accountCookie(a.owner);
    expect((await enter(a, ownerA)).status).toBe(200);
    expect((await (await call(`/${a.slug}/api/me`, { cookie: ownerA })).json()).role).toBe('owner');
  });
});

describe('caches', () => {
  it('A’s cached figures are never served for B', async () => {
    const a = await makeServer('cache-a');
    const b = await makeServer('cache-b');
    const now = Math.floor(Date.now() / 1000);
    await runInDurableObject(tenant(a), (_o, state) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO players (uuid, name, first_seen) VALUES ('00000000-0000-4000-8000-0000000000aa', 'OnlyOnA', ?)", now - 600);
      sql.exec("INSERT INTO sessions (uuid, start_ts, end_ts) VALUES ('00000000-0000-4000-8000-0000000000aa', ?, ?)", now - 600, now - 60);
      sql.exec('INSERT INTO snapshots (ts, up, online, max, listed) VALUES (?, 1, 1, 20, 1)', Math.floor(now / 60) * 60 - 60);
    });
    const ra = await call(`/${a.slug}/api/status?season=1`, { cookie: await viewerCookie(a) });
    const sa = await ra.json();
    expect(sa.players_total).toBe(1);
    expect(ra.headers.get('Cache-Control')).toBe('no-store');
    // the same address on B, straight after: B's own (empty) figures
    const rb = await call(`/${b.slug}/api/status?season=1`, { cookie: await viewerCookie(b) });
    const sb = await rb.json();
    expect(sb.players_total).toBe(0);
    expect(sb.last).toBe(null);
    expect(rb.headers.get('Cache-Control')).toBe('no-store');
    // each kept its figures in its own database
    const cacheA = await runInDurableObject(tenant(a), (_o, s) => s.storage.sql.exec('SELECT key, value FROM cache').toArray());
    const cacheB = await runInDurableObject(tenant(b), (_o, s) => s.storage.sql.exec('SELECT key, value FROM cache').toArray());
    expect(cacheA.length).toBeGreaterThan(0);
    expect(cacheB.map((r) => r.key)).toEqual(cacheA.map((r) => r.key));
    expect(cacheB.map((r) => r.value)).not.toEqual(cacheA.map((r) => r.value));
  });

  it('pages are not cached by anyone in between', async () => {
    const a = await makeServer('page-a');
    const res = await call(`/${a.slug}`, { cookie: await viewerCookie(a) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('"slug":"page-a"');
  });
});

describe('joining', () => {
  it('a wrong password and a server that doesn’t exist get the same answer', async () => {
    const a = await makeServer('same-a');
    const wrong = await call('/api/site/join', { method: 'POST', body: { server: a.slug, password: 'not-the-password' }, headers: { 'CF-Connecting-IP': '203.0.113.1' } });
    const none = await call('/api/site/join', { method: 'POST', body: { server: 'no-such-server', password: 'not-the-password' }, headers: { 'CF-Connecting-IP': '203.0.113.2' } });
    expect(wrong.status).toBe(401);
    expect(none.status).toBe(401);
    expect(await wrong.text()).toBe(await none.text());
    // and the pages of a server that doesn't exist look like those of one you can't see
    const p1 = await call(`/${a.slug}`);
    const p2 = await call('/no-such-server');
    expect(p1.status).toBe(p2.status);
    expect((await call(`/${a.slug}/api/status`)).status).toBe((await call('/no-such-server/api/status')).status);
  });

  it('is rate limited the same way for a real server and a made-up one', async () => {
    const a = await makeServer('limit-a');
    const tries = async (server, ip) => {
      const out = [];
      for (let i = 0; i < 11; i++) {
        const r = await call('/api/site/join', { method: 'POST', body: { server, password: `guess-${i}` }, headers: { 'CF-Connecting-IP': ip } });
        out.push(r.status);
      }
      return out;
    };
    const real = await tries(a.slug, '198.51.100.7');
    const fake = await tries('made-up-name', '198.51.100.8');
    expect(real).toEqual([...Array(10).fill(401), 429]);
    expect(fake).toEqual(real);
    // the right password is refused too while the limit lasts (it isn't a way to test guesses)
    const right = await call('/api/site/join', { method: 'POST', body: { server: a.slug, password: a.password }, headers: { 'CF-Connecting-IP': '198.51.100.7' } });
    expect(right.status).toBe(429);
    // from another address it still works
    expect((await call('/api/site/join', { method: 'POST', body: { server: a.slug, password: a.password }, headers: { 'CF-Connecting-IP': '198.51.100.9' } })).status).toBe(200);
  });

  it('a server can be made public, and then its page needs no password', async () => {
    const a = await makeServer('public-a');
    expect((await call(`/${a.slug}/api/status`)).status).toBe(401);
    await call(`/api/site/servers/${a.slug}/settings`, { method: 'POST', cookie: a.cookie, body: { PUBLIC: '1' } });
    expect((await call(`/${a.slug}/api/status`)).status).toBe(200);
    // looking is all it gives
    expect((await call(`/${a.slug}/api/admin?season=1`)).status).toBe(403);
  });
});

describe('making servers', () => {
  it('refuses reserved, taken and badly formed addresses, and short or mismatched passwords', async () => {
    const cookie = await siteCookie('maker@example.org');
    const make = (b) => call('/api/site/servers', { method: 'POST', cookie, body: { name: 'X', password: 'long-enough-pw', confirm: 'long-enough-pw', ...b } });
    expect((await make({ slug: 'admin' })).status).toBe(400);
    expect((await make({ slug: 'api' })).status).toBe(400);
    expect((await make({ slug: 'www' })).status).toBe(400);
    expect((await make({ slug: 'Bad Slug' })).status).toBe(400);
    expect((await make({ slug: 'ok-slug', password: 'short', confirm: 'short' })).status).toBe(400);
    expect((await make({ slug: 'ok-slug', confirm: 'different-pw!' })).status).toBe(400);
    expect((await make({ slug: 'ok-slug' })).status).toBe(200);
    expect((await make({ slug: 'ok-slug' })).status).toBe(409);
    expect((await call('/api/site/servers', { method: 'POST', body: { name: 'X', slug: 'nobody', password: 'long-enough-pw', confirm: 'long-enough-pw' } })).status).toBe(401);
  });

  it('caps the servers one owner can make', async () => {
    const cookie = await siteCookie('busy@example.org');
    const make = (slug) => call('/api/site/servers', { method: 'POST', cookie, body: { name: slug, slug, password: 'long-enough-pw', confirm: 'long-enough-pw' } });
    for (const s of ['cap-1', 'cap-2', 'cap-3']) expect((await make(s)).status).toBe(200);
    expect((await make('cap-4')).status).toBe(403);
  });

  it('notes the first upload, for the setup page', async () => {
    const a = await makeServer('first-up');
    const before = await (await call(`/api/site/servers/${a.slug}`, { cookie: a.cookie })).json();
    expect(before.info.first_upload_at).toBe(null);
    await upload(await newKey(a), [chatEvent('hello')]);
    const after = await (await call(`/api/site/servers/${a.slug}`, { cookie: a.cookie })).json();
    expect(after.info.first_upload_at).toBeGreaterThan(0);
  });
});
