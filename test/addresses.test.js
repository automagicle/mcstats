// Where things live on the site: a server's pages at /<server> (src/index.js), the old /s/<server>/ addresses
// that lead there, the names a server can't take, join links (src/joinlink.js), and the old workers.dev address.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { accountCookie, call, cookieOf, idCookie, makeServer, ORIGIN, viewerCookie } from './helpers.js';
import { RESERVED, SITE_PATHS, slugProblem } from '../src/directory.js';

const where = (res) => res.headers.get('Location');
const admin = (server, cookie, body) => call(`/${server.slug}/api/admin/server`, { method: body ? 'POST' : 'GET', cookie, body });

describe('server addresses', () => {
  it('a server’s page is /<server>, with one spelling', async () => {
    const a = await makeServer('addr-one');
    const view = await viewerCookie(a);
    const page = await call('/addr-one', { cookie: view });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('"base":"/addr-one"');
    expect((await call('/addr-one/api/status', { cookie: view })).status).toBe(200);
    // a slash on the end, or capitals, lead to the one address
    const slash = await call('/addr-one/?tab=1');
    expect([slash.status, where(slash)]).toEqual([302, '/addr-one?tab=1']);
    const caps = await call('/Addr-One/s1');
    expect([caps.status, where(caps)]).toEqual([302, '/addr-one/s1']);
    // nothing else lives under a server
    expect((await call('/addr-one/nope', { cookie: view })).status).toBe(404);
    // someone who can't see it is sent to join it, as for a server that doesn't exist
    expect(where(await call('/addr-one'))).toBe('/join?server=addr-one');
    expect(where(await call('/addr-none'))).toBe('/join?server=addr-none');
  });

  it('the viewer cookie is for /<server> and what’s under it only', async () => {
    const a = await makeServer('addr-cookie');
    const res = await call('/api/site/join', { method: 'POST', body: { server: a.slug, password: a.password } });
    expect((await res.json()).url).toBe('/addr-cookie');
    expect(res.headers.getSetCookie().find((c) => c.startsWith('mcs_view='))).toMatch(/; Path=\/addr-cookie;/);
  });

  it('the old /s/<server>/ addresses lead to the new ones, and take the viewer cookie along', async () => {
    const a = await makeServer('addr-old');
    const view = await viewerCookie(a);
    const res = await call('/s/addr-old/', { cookie: view });
    expect([res.status, where(res)]).toEqual([301, '/addr-old']);
    const set = res.headers.getSetCookie();
    // the same cookie at the new address, and gone from the old one
    const moved = set.find((c) => c.startsWith(`${view};`));
    expect(moved).toMatch(/; Path=\/addr-old; Max-Age=\d+; HttpOnly; Secure/);
    expect(set.some((c) => c.startsWith('mcs_view=;') && c.includes('Path=/s/addr-old/;') && c.includes('Max-Age=0'))).toBe(true);
    expect((await call('/addr-old', { cookie: view })).status).toBe(200);

    // the rest of the address and the query come along
    expect(where(await call('/s/addr-old'))).toBe('/addr-old');
    expect(where(await call('/s/addr-old/s1/?x=1#y'))).toBe('/addr-old/s1?x=1');
    expect(where(await call('/s/Addr-Old/api/status?season=1'))).toBe('/addr-old/api/status?season=1');
    // a request with a body is sent again as it was
    const post = await call('/s/addr-old/api/mine', { method: 'POST', body: { saved: true } });
    expect([post.status, where(post)]).toEqual([308, '/addr-old/api/mine']);
    // a cookie that isn't this server's isn't carried anywhere
    const b = await makeServer('addr-old-b');
    const other = await call('/s/addr-old-b/', { cookie: view });
    expect([other.status, where(other)]).toEqual([301, '/addr-old-b']);
    expect(other.headers.getSetCookie()).toEqual([]);
    expect(b.slug).toBe('addr-old-b');
    // and one for a server that doesn't exist says nothing either
    expect(where(await call('/s/addr-nowhere/', { cookie: view }))).toBe('/addr-nowhere');
    expect((await call('/s/a%2Fb/')).status).toBe(404);
  });

  it('the site’s own pages are never a server’s', async () => {
    for (const p of ['/', '/join', '/new', '/account', '/servers', '/mod']) {
      const res = await call(p);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('Content-Type'), p).toContain('text/html');
    }
    expect((await call('/style.css')).status).toBe(200);
    expect((await call('/stats')).status).toBe(404);
    expect((await call('/api/nope')).status).toBe(404);
  });

  it('a server can’t take a name the site uses or may come to use', async () => {
    for (const name of [...SITE_PATHS].filter((n) => n.length >= 3)) expect(RESERVED.has(name), name).toBe(true);
    for (const name of ['settings', 'login', 'signup', 'docs', 'pricing', 'privacy', 'terms', 'dashboard', 'explore', 'invite', 'players', 'admin', 'mcstats', 's10', 's99']) {
      expect(slugProblem(name), name).toMatch(/reserved/);
    }
    expect(slugProblem('egg-smp')).toBeNull();
    const cookie = await accountCookie('namer@example.org');
    const make = await call('/api/site/servers', { method: 'POST', cookie, body: { name: 'Settings', slug: 'settings', password: 'a-good-password', confirm: 'a-good-password' } });
    expect(make.status).toBe(400);
    expect(await make.json()).toMatchObject({ field: 'slug' });
    expect(await (await call('/api/site/slug?name=account', { cookie })).json()).toMatchObject({ ok: false });
    // and an existing server can't be moved onto one
    const a = await makeServer('addr-move');
    expect((await admin(a, await idCookie(a, a.owner), { slug: 'servers' })).status).toBe(400);
  });
});

describe('join links', () => {
  const invite = async (server, email, role) => {
    expect((await call(`/api/site/servers/${server.slug}/invite`, { method: 'POST', cookie: server.cookie, body: { email, role } })).status).toBe(200);
    return idCookie(server, email);
  };

  it('an admin makes one, and opening it lets a browser in like the password does', async () => {
    const a = await makeServer('link-one');
    const helper = await invite(a, 'helper@example.org', 'admin');
    expect((await (await admin(a, helper)).json()).join_link).toBeNull();
    const made = await admin(a, helper, { join_link: 'new' });
    expect(made.status).toBe(200);
    const link = (await made.json()).join_link;
    expect(link).toMatch(/^\/link-one\/join\/[A-Za-z0-9_-]{16}$/);
    // it's there to copy again later
    expect((await (await admin(a, helper)).json()).join_link).toBe(link);

    const res = await call(link);
    expect([res.status, where(res)]).toEqual([302, '/link-one']);
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.getSetCookie().find((c) => c.startsWith('mcs_view='))).toMatch(/; Path=\/link-one; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax/);
    const view = cookieOf(res, 'mcs_view');
    expect((await call('/link-one', { cookie: view })).status).toBe(200);
    expect((await call('/link-one/api/status', { cookie: view })).status).toBe(200);
    // looking is all it gives
    expect((await admin(a, view)).status).toBe(403);
    // and the link itself is nowhere on the page a viewer gets
    expect(await (await call('/link-one', { cookie: view })).text()).not.toContain(link.split('/').pop());
  });

  it('a link that’s wrong, replaced or turned off lets nobody in, and says the same as no such server', async () => {
    const a = await makeServer('link-two');
    const owner = await idCookie(a, a.owner);
    const first = (await (await admin(a, owner, { join_link: 'new' })).json()).join_link;
    const gone = '/join?server=link-two&link=gone';
    for (const bad of ['/link-two/join/AAAAAAAAAAAAAAAA', '/link-two/join/short', `${first}x`]) {
      const res = await call(bad);
      expect([res.status, where(res), res.headers.getSetCookie()], bad).toEqual([302, gone, []]);
    }
    expect(where(await call(`/link-nowhere/join/${first.split('/').pop()}`))).toBe('/join?server=link-nowhere&link=gone');
    // another server's link is no use here
    const b = await makeServer('link-two-b');
    expect(where(await call(first.replace('link-two', b.slug)))).toBe('/join?server=link-two-b&link=gone');

    const second = (await (await admin(a, owner, { join_link: 'new' })).json()).join_link;
    expect(second).not.toBe(first);
    expect(where(await call(first))).toBe(gone);
    const got = await call(second);
    expect(where(got)).toBe('/link-two');
    // turned off: nobody new gets in; whoever's in stays in
    expect((await (await admin(a, owner, { join_link: 'off' })).json()).join_link).toBeNull();
    expect(where(await call(second))).toBe(gone);
    expect((await call('/link-two', { cookie: cookieOf(got, 'mcs_view') })).status).toBe(200);
    // a new join password ends those sessions, as it does the password's own
    expect((await admin(a, owner, { password: 'a-new-password', confirm: 'a-new-password' })).status).toBe(200);
    expect((await call('/link-two', { cookie: cookieOf(got, 'mcs_view') })).status).toBe(302);
  });

  it('only admins make, see or change it', async () => {
    const a = await makeServer('link-three');
    const member = await invite(a, 'member@example.org', 'member');
    expect((await admin(a, member, { join_link: 'new' })).status).toBe(403);
    expect((await admin(a, await viewerCookie(a), { join_link: 'new' })).status).toBe(403);
    expect((await admin(a, null, { join_link: 'new' })).status).toBe(401);
    expect((await admin(a, await idCookie(a, a.owner), { join_link: 'maybe' })).status).toBe(400);
    expect((await (await admin(a, await idCookie(a, a.owner))).json()).join_link).toBeNull();
  });

  it('the owner makes one while setting the server up', async () => {
    const a = await makeServer('link-four');
    const setup = (path = '', body) => call(`/api/site/servers/${a.slug}${path}`, { method: body ? 'POST' : 'GET', cookie: a.cookie, body });
    expect((await (await setup()).json()).join_link).toBeNull();
    const made = await (await setup('/joinlink', { on: true })).json();
    expect(made.join_link).toMatch(new RegExp(`^${ORIGIN}/link-four/join/[A-Za-z0-9_-]{16}$`));
    expect(made.url).toBe(`${ORIGIN}/link-four`);
    expect(where(await call(made.join_link.slice(ORIGIN.length)))).toBe('/link-four');
    // the same link the admin page shows
    expect(`${ORIGIN}${(await (await admin(a, await idCookie(a, a.owner))).json()).join_link}`).toBe(made.join_link);
    expect((await (await setup('/joinlink', { on: false })).json()).join_link).toBeNull();
    expect((await setup('/joinlink', { on: 'yes' })).status).toBe(400);
    // someone else's server is no server at all
    const stranger = await accountCookie('stranger@example.org');
    expect((await call(`/api/site/servers/${a.slug}/joinlink`, { method: 'POST', cookie: stranger, body: { on: true } })).status).toBe(404);
  });

  it('opening it signed in puts the server on the account’s list', async () => {
    const a = await makeServer('link-five');
    const link = (await (await admin(a, await idCookie(a, a.owner), { join_link: 'new' })).json()).join_link;
    const me = await accountCookie('player@example.org');
    expect(where(await call(link, { cookie: me }))).toBe('/link-five');
    const mine = await (await call('/api/site/mine', { cookie: me })).json();
    expect(JSON.stringify(mine)).toContain('link-five');
  });

  it('guessing is limited', async () => {
    const a = await makeServer('link-six');
    let last;
    for (let i = 0; i < 21; i++) last = await call('/link-six/join/AAAAAAAAAAAAAAAA');
    expect(where(last)).toBe('/join?server=link-six&link=wait');
    expect(a.slug).toBe('link-six');
  });
});

describe('the old workers.dev address', () => {
  const old = (path, init = {}) => SELF.fetch(`https://mcstats.example.workers.dev${path}`, { redirect: 'manual', ...init });

  it('sends pages and the site’s API on to the domain, keeping the rest of the address', async () => {
    for (const path of ['/', '/eggsmp', '/s/eggsmp/s1/?range=7d', '/join?server=eggsmp', '/eggsmp/api/status?season=2', '/style.css', '/api/site/mod']) {
      const res = await old(path);
      expect([res.status, where(res)], path).toEqual([301, `https://mcstats.live${path}`]);
    }
    const post = await old('/api/site/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect([post.status, where(post)]).toEqual([308, 'https://mcstats.live/api/site/join']);
  });

  it('still answers the mod, which doesn’t follow redirects', async () => {
    const res = await old('/api/ingest/chat', { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{"events":[]}' });
    expect(res.status).toBe(401);
    expect((await old('/downloads/README.txt')).status).not.toBe(301);
  });

  it('and the domain itself goes nowhere', async () => {
    expect((await call('/join')).status).toBe(200);
  });
});
