// Admin → Server (src/serveradmin.js): a server's name, address, password, look and add-ons, changed
// from its own dashboard, by the right people only.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, cookieOf, idCookie, makeServer, viewerCookie } from './helpers.js';

const both = (...c) => c.filter(Boolean).join('; ');
const settings = (server, cookie, body) => call(`/s/${server.slug}/api/admin/server`, { method: body ? 'POST' : 'GET', cookie, body });
const page = async (slug, cookie) => (await call(`/s/${slug}/`, { cookie })).text();
async function invite(server, email, role) {
  const res = await call(`/api/site/servers/${server.slug}/invite`, { method: 'POST', cookie: server.cookie, body: { email, role } });
  expect(res.status).toBe(200);
  return idCookie(server, email);
}

describe('who can change what', () => {
  it('members and viewers can’t see or change the server’s details', async () => {
    const a = await makeServer('sa-members');
    expect((await settings(a, await viewerCookie(a))).status).toBe(403);
    const member = await invite(a, 'member@example.org', 'member');
    expect((await settings(a, member)).status).toBe(403);
    expect((await settings(a, member, { accent: 'blue' })).status).toBe(403);
    expect((await settings(a, null)).status).toBe(401);
  });

  it('an admin sets the name and the look; the address, password and visibility are the owner’s', async () => {
    const a = await makeServer('sa-admin');
    const admin = await invite(a, 'helper@example.org', 'admin');
    const got = await (await settings(a, admin)).json();
    expect(got).toMatchObject({ slug: a.slug, accent: 'green', tab_style: 'line', public: false, has_password: true, addons: [] });
    expect(got.can).toEqual({ owner: false, super: false });
    expect(got.known_addons).toBeUndefined();

    const ok = await settings(a, admin, { name: 'Renamed', accent: 'blue', tab_style: 'frame' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ name: 'Renamed', accent: 'blue', tab_style: 'frame' });
    for (const body of [{ slug: 'sa-admin-moved' }, { password: 'another-password', confirm: 'another-password' }, { public: true }, { addons: ['eggsmp'] }]) {
      expect((await settings(a, admin, body)).status, JSON.stringify(body)).toBe(403);
    }
    // an admin of another server gets nowhere here
    const b = await makeServer('sa-admin-b');
    expect((await settings(a, await idCookie(b, b.owner), { accent: 'green' })).status).toBe(401);
  });

  it('only the site’s operators switch add-ons on, and only that server’s page then loads them', async () => {
    const a = await makeServer('sa-addon-a');
    const b = await makeServer('sa-addon-b');
    const owner = await idCookie(a, a.owner);
    expect((await settings(a, owner, { addons: ['eggsmp'] })).status).toBe(403);
    expect(await page(a.slug, owner)).not.toContain('"/addons/');

    const operator = await idCookie(a, 'operator@example.org');
    const state = await (await settings(a, operator)).json();
    expect(state.known_addons.map((x) => x.id)).toContain('eggsmp');
    expect((await settings(a, operator, { addons: ['nope'] })).status).toBe(400);
    expect((await (await settings(a, operator, { addons: ['eggsmp'] })).json()).addons).toEqual(['eggsmp']);

    const html = await page(a.slug, owner);
    expect(html).toContain('<script src="/addons/eggsmp/addon.js" defer></script>');
    expect(html).toContain('<link rel="stylesheet" href="/addons/eggsmp/addon.css">');
    expect(html.indexOf('/addons/eggsmp/addon.js')).toBeLessThan(html.indexOf('src="/app.js"'));
    expect(await page(b.slug, await idCookie(b, b.owner))).not.toContain('"/addons/');
  });

  it('the first server, copied in from before, keeps its eggs', async () => {
    const res = await call('/api/ops/servers', {
      method: 'POST', headers: { Authorization: `Bearer ${env.OPS_TOKEN}` },
      body: { slug: env.LEGACY_SLUG, name: 'eggSMP', owner: 'owner@example.org', password: 'first-server-pw', legacy: true },
    });
    expect(res.status).toBe(200);
    const first = { slug: env.LEGACY_SLUG, password: 'first-server-pw', id: (await res.json()).id };
    const owner = await idCookie(first, 'owner@example.org');
    expect(await page(first.slug, owner)).toContain('/addons/eggsmp/addon.js');
    // the old shared mod token finds it by its address, so the address stays while that token is in use
    const moved = await settings(first, owner, { slug: 'eggsmp-moved' });
    expect(moved.status).toBe(400);
    expect((await moved.json()).field).toBe('slug');
  });
});

describe('the look', () => {
  it('is on the page before it’s drawn: green and line unless the server chose otherwise', async () => {
    const a = await makeServer('sa-look');
    const owner = await idCookie(a, a.owner);
    expect(await page(a.slug, owner)).toMatch(/<html[^>]* data-accent="green" data-tabs="line"/);
    expect((await settings(a, owner, { accent: 'blue', tab_style: 'frame' })).status).toBe(200);
    expect(await page(a.slug, owner)).toMatch(/<html[^>]* data-accent="blue" data-tabs="frame"/);
    // a custom color, with text that can be read on it (dark on a light color, white on a dark one)
    expect((await (await settings(a, owner, { accent: '#FFD23F' })).json()).accent).toBe('#ffd23f');
    expect(await page(a.slug, owner)).toMatch(/data-accent="custom" data-tabs="frame" style="--accent-custom:#ffd23f;--accent-ink:#16181b"/);
    expect((await settings(a, owner, { accent: '#5b2a86' })).status).toBe(200);
    expect(await page(a.slug, owner)).toContain('--accent-custom:#5b2a86;--accent-ink:#ffffff');
  });

  it('refuses anything that isn’t a color or a known style, and changes nothing', async () => {
    const a = await makeServer('sa-look-bad');
    const owner = await idCookie(a, a.owner);
    for (const body of [{ accent: 'red' }, { accent: '#12' }, { accent: 'url(x)' }, { accent: '#fff;color:red' }, { tab_style: 'round' }, { name: '' }, { name: 'x'.repeat(61) }]) {
      expect((await settings(a, owner, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await (await settings(a, owner)).json()).toMatchObject({ accent: 'green', tab_style: 'line', name: 'Server sa-look-bad' });
  });
});

describe('the address and the password', () => {
  it('a new address moves the server: the old one is gone, and whoever moved it is let in at the new one', async () => {
    const a = await makeServer('sa-move');
    const owner = await idCookie(a, a.owner);
    for (const slug of ['ab', 'admin', 'Has Space', '-dash']) expect((await settings(a, owner, { slug })).status, slug).toBe(400);
    const other = await makeServer('sa-move-taken');
    expect((await settings(a, owner, { slug: other.slug })).status).toBe(409);

    const res = await settings(a, owner, { slug: 'sa-moved' });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ slug: 'sa-moved', moved: '/s/sa-moved/' });
    // the account is signed in site-wide, so it comes along; the viewer cookie is made again for the new address
    expect(res.headers.getSetCookie().some((c) => c.startsWith('mcs_view=') && c.includes('Path=/s/sa-moved/'))).toBe(true);
    const fresh = both(cookieOf(res, 'mcs_view'), owner);
    expect((await call('/s/sa-moved/api/me', { cookie: fresh })).status).toBe(200);
    expect((await (await call('/s/sa-moved/api/me', { cookie: fresh })).json()).email).toBe(a.owner);
    // the old address is no server at all now, and the data came along
    expect((await call('/s/sa-move/', { cookie: owner })).status).toBe(302);
    expect((await call('/s/sa-move/api/me', { cookie: owner })).status).toBe(401);
    const row = await env.DIRECTORY.prepare('SELECT slug FROM servers WHERE id = ?').bind(a.id).first();
    expect(row.slug).toBe('sa-moved');
    // and players join at the new name with the same password
    expect((await call('/api/site/join', { method: 'POST', body: { server: 'sa-moved', password: a.password } })).status).toBe(200);
    expect((await call('/api/site/join', { method: 'POST', body: { server: 'sa-move', password: a.password } })).status).toBe(401);
  });

  it('a new password ends the old viewer sessions, but not the one of whoever set it', async () => {
    const a = await makeServer('sa-pass');
    const owner = await idCookie(a, a.owner);
    const viewer = await viewerCookie(a);
    expect((await call(`/s/${a.slug}/api/me`, { cookie: viewer })).status).toBe(200);
    expect((await settings(a, owner, { password: 'short', confirm: 'short' })).status).toBe(400);
    const mismatch = await settings(a, owner, { password: 'a-new-password', confirm: 'a-new-passw0rd' });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).field).toBe('confirm');

    const res = await settings(a, owner, { password: 'a-new-password', confirm: 'a-new-password' });
    expect(res.status).toBe(200);
    expect((await call(`/s/${a.slug}/api/me`, { cookie: viewer })).status).toBe(401);
    expect((await call(`/s/${a.slug}/api/me`, { cookie: cookieOf(res, 'mcs_view') })).status).toBe(200);
    expect((await call('/api/site/join', { method: 'POST', body: { server: a.slug, password: a.password } })).status).toBe(401);
    expect((await call('/api/site/join', { method: 'POST', body: { server: a.slug, password: 'a-new-password' } })).status).toBe(200);
  });

  it('a public server needs a password before it can be made private', async () => {
    const cookie = (await makeServer('sa-pub-owner')).cookie;
    const made = await call('/api/site/servers', { method: 'POST', cookie, body: { name: 'Open', slug: 'sa-open', visibility: 'public' } });
    expect(made.status).toBe(200);
    const row = await env.DIRECTORY.prepare('SELECT id FROM servers WHERE slug = ?').bind('sa-open').first();
    const open = { slug: 'sa-open', id: row.id };
    const owner = await idCookie(open, 'owner-sa-pub-owner@example.org');
    expect(await (await settings(open, owner)).json()).toMatchObject({ public: true, has_password: false });
    const refused = await settings(open, owner, { public: false });
    expect(refused.status).toBe(400);
    expect((await refused.json()).field).toBe('password');
    expect((await settings(open, owner, { public: false, password: 'now-it-has-one', confirm: 'now-it-has-one' })).status).toBe(200);
    expect(await (await settings(open, owner)).json()).toMatchObject({ public: false, has_password: true });
    expect((await call('/s/sa-open/')).status).toBe(302);
  });
});
