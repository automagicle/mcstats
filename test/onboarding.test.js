// Making a server on /new, the way an owner does: signed in to an mcstats account (test/account.test.js), pick the address, choose
// private or public, and the stats are then shown (or not) to someone without a password.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, cookieOf, siteCookie } from './helpers.js';

const make = (cookie, body) => call('/api/site/servers', { method: 'POST', cookie, body });
const check = (cookie, name) => call(`/api/site/slug?name=${encodeURIComponent(name)}`, { cookie });
// what someone with no cookies at all gets at a server's stats page
const anonymousPage = (slug) => call(`/${slug}`);
const join = (slug, password) => call('/api/site/join', { method: 'POST', body: { server: slug, password } });

describe('the mod’s config', () => {
  it('uploads to the site’s main address, whichever address the owner is browsing at', async () => {
    const cookie = await siteCookie('config-owner@example.org');
    expect((await make(cookie, { name: 'Config', slug: 'config-one', visibility: 'public' })).status).toBe(200);
    const key = await (await call('/api/site/servers/config-one/key', { method: 'POST', cookie, body: {} })).json();
    expect(key.config).toContain(`url=${env.SITE_ORIGIN}/api/ingest/chat`);
    expect(env.SITE_ORIGIN).toBe('https://mcstats.live');
    expect((await (await call('/api/site/mod')).json()).ingest_url).toBe('https://mcstats.live/api/ingest/chat');
  });
});

describe('signing in on /new', () => {
  it('making a server or checking an address needs a sign-in', async () => {
    expect((await make(null, { name: 'Nope', slug: 'nope-server', visibility: 'public' })).status).toBe(401);
    expect((await check(null, 'nope-server')).status).toBe(401);
  });
});

describe('choosing the address', () => {
  it('says whether an address is free, as it would be made from what was typed', async () => {
    const cookie = await siteCookie('picker@example.org');
    expect(await (await check(cookie, 'Maple Grove SMP')).json()).toEqual({ slug: 'maple-grove-smp', ok: true });
    for (const [typed, why] of [['ab', /3 to 32/], ['admin', /reserved/], ['', /Type an address/]]) {
      const r = await (await check(cookie, typed)).json();
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(why);
    }
    expect((await make(cookie, { name: 'Maple Grove', slug: 'maple-grove-smp', visibility: 'public' })).status).toBe(200);
    expect(await (await check(cookie, 'maple-grove-smp')).json()).toMatchObject({ ok: false, error: expect.stringMatching(/taken/) });
  });

  it('the server is at the address the owner chose, not one made from its name', async () => {
    const cookie = await siteCookie('chooser@example.org');
    const res = await make(cookie, { name: 'The Long Display Name', slug: 'short', visibility: 'public' });
    expect(res.status).toBe(200);
    expect((await res.json()).server.slug).toBe('short');
    expect((await anonymousPage('short')).status).toBe(200);
  });

  it('refuses bad, reserved and taken addresses, and says which field is wrong', async () => {
    const cookie = await siteCookie('refused@example.org');
    for (const slug of ['-bad', 'Has Spaces', 'x', 'new', 'a'.repeat(33)]) {
      const r = await make(cookie, { name: 'Bad', slug, visibility: 'public' });
      expect(r.status, slug).toBe(400);
      expect((await r.json()).field).toBe('slug');
    }
    expect((await make(cookie, { name: 'First', slug: 'taken-one', visibility: 'public' })).status).toBe(200);
    const again = await make(await siteCookie('someone-else@example.org'), { name: 'Second', slug: 'taken-one', visibility: 'public' });
    expect(again.status).toBe(409);
    expect((await again.json()).field).toBe('slug');
  });
});

describe('private or public', () => {
  it('a private server needs its password, and the stats are hidden without it', async () => {
    const cookie = await siteCookie('private-owner@example.org');
    const noPass = await make(cookie, { name: 'Hidden', slug: 'hidden-smp', visibility: 'private' });
    expect(noPass.status).toBe(400);
    expect((await noPass.json()).field).toBe('password');
    const mismatch = await make(cookie, { name: 'Hidden', slug: 'hidden-smp', visibility: 'private', password: 'correct horse', confirm: 'correct house' });
    expect((await mismatch.json()).field).toBe('confirm');

    expect((await make(cookie, { name: 'Hidden', slug: 'hidden-smp', visibility: 'private', password: 'correct horse', confirm: 'correct horse' })).status).toBe(200);
    const page = await anonymousPage('hidden-smp');
    expect(page.status).toBe(302);
    expect(page.headers.get('Location')).toBe('/join?server=hidden-smp');
    expect((await call('/hidden-smp/api/status')).status).toBe(401);

    const joined = await join('hidden-smp', 'correct horse');
    expect(joined.status).toBe(200);
    const view = cookieOf(joined, 'mcs_view');
    expect((await call('/hidden-smp', { cookie: view })).status).toBe(200);
    expect((await call('/hidden-smp/api/status', { cookie: view })).status).toBe(200);
  });

  it('a public server needs no password, and anyone can see its stats', async () => {
    const cookie = await siteCookie('public-owner@example.org');
    const res = await make(cookie, { name: 'Open Fields', slug: 'open-fields', visibility: 'public' });
    expect(res.status).toBe(200);
    expect((await res.json()).server.public).toBe(true);
    expect((await anonymousPage('open-fields')).status).toBe(200);
    expect((await call('/open-fields/api/status')).status).toBe(200);
    // there's no password to join with, so no guess works
    expect((await join('open-fields', '')).status).toBe(401);
    expect((await join('open-fields', 'anything at all')).status).toBe(401);
    const state = await (await call('/api/site/servers/open-fields', { cookie })).json();
    expect(state.has_password).toBe(false);
    expect(state.info.public).toBe(true);
  });

  it('visibility must be private or public', async () => {
    const r = await make(await siteCookie('odd@example.org'), { name: 'Odd', slug: 'odd-one', visibility: 'friends' });
    expect(r.status).toBe(400);
    expect((await r.json()).field).toBe('visibility');
  });

  it('a public server can only be made private once it has a password', async () => {
    const cookie = await siteCookie('switcher@example.org');
    await make(cookie, { name: 'Switch', slug: 'switch-smp', visibility: 'public' });
    const settings = (b) => call('/api/site/servers/switch-smp/settings', { method: 'POST', cookie, body: b });

    const refused = await settings({ PUBLIC: '' });
    expect(refused.status).toBe(400);
    expect((await refused.json()).field).toBe('password');
    expect((await anonymousPage('switch-smp')).status).toBe(200); // still public

    expect((await settings({ PUBLIC: '', password: 'new password 1', confirm: 'new password 1' })).status).toBe(200);
    expect((await anonymousPage('switch-smp')).status).toBe(302);
    expect((await join('switch-smp', 'new password 1')).status).toBe(200);

    // and back to public: no password needed to look, and the password still works
    expect((await settings({ PUBLIC: '1' })).status).toBe(200);
    expect((await anonymousPage('switch-smp')).status).toBe(200);
    expect((await join('switch-smp', 'new password 1')).status).toBe(200);
  });

  it('a private server can be made public, and private again, without a new password', async () => {
    const cookie = await siteCookie('flipper@example.org');
    await make(cookie, { name: 'Flip', slug: 'flip-smp', visibility: 'private', password: 'flip password', confirm: 'flip password' });
    const settings = (b) => call('/api/site/servers/flip-smp/settings', { method: 'POST', cookie, body: b });
    expect((await anonymousPage('flip-smp')).status).toBe(302);
    expect((await settings({ PUBLIC: '1' })).status).toBe(200);
    expect((await anonymousPage('flip-smp')).status).toBe(200);
    expect((await settings({ PUBLIC: '' })).status).toBe(200);
    expect((await anonymousPage('flip-smp')).status).toBe(302);
  });
});

describe('owners', () => {
  it('only the owner sees a server’s setup, and an owner has at most MAX_SERVERS_PER_OWNER', async () => {
    const cookie = await siteCookie('busy-owner@example.org');
    const max = Number(env.MAX_SERVERS_PER_OWNER) || 3;
    for (let i = 0; i < max; i++) expect((await make(cookie, { name: `Busy ${i}`, slug: `busy-${i}`, visibility: 'public' })).status).toBe(200);
    const over = await make(cookie, { name: 'One too many', slug: 'busy-extra', visibility: 'public' });
    expect(over.status).toBe(403);

    const me = await (await call('/api/site/me', { cookie })).json();
    expect(me.servers.map((s) => s.slug)).toEqual(Array.from({ length: max }, (_, i) => `busy-${i}`));
    // someone else's server looks like no server
    expect((await call('/api/site/servers/busy-0', { cookie: await siteCookie('nosy@example.org') })).status).toBe(404);
  });
});
