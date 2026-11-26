// "Your servers" (src/myservers.js): each account's own list. What goes on it by itself (made, joined, opened as
// a member), what "Add to my servers" does, removing and reordering, and what each row may say about a server.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { accountCookie, call, makeServer, newKey, upload, viewerCookie } from './helpers.js';

const both = (...c) => c.filter(Boolean).join('; ');
const mine = async (cookie) => {
  const res = await call('/api/site/mine', { cookie });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()).servers;
};
const slugs = async (cookie) => (await mine(cookie)).map((s) => s.slug);
const save = (slug, saved, cookie) => call(`/${slug}/api/mine`, { method: 'POST', cookie, body: { saved } });
// what the stats page tells its script (window.MCS)
async function pageConfig(slug, cookie) {
  const res = await call(`/${slug}`, { cookie });
  if (res.status !== 200) return { status: res.status };
  const m = /window\.MCS=(\{.*?\});<\/script>/.exec(await res.text());
  return JSON.parse(m[1]);
}
async function makePublic(slug, owner) {
  const cookie = await accountCookie(owner);
  const res = await call('/api/site/servers', { method: 'POST', cookie, body: { name: `Server ${slug}`, slug, visibility: 'public' } });
  expect(res.status, await res.clone().text()).toBe(200);
  return { slug, owner, cookie };
}

describe('what goes on the list by itself', () => {
  it('a server you make', async () => {
    const s = await makeServer('mine-made', { owner: 'maker@example.org' });
    const [row] = await mine(s.cookie);
    expect(row).toMatchObject({ slug: 'mine-made', name: 'Server mine-made', role: 'owner', owner: true, access: true });
  });

  it('a server you join with its password while signed in, and the row says so', async () => {
    const s = await makeServer('mine-joined');
    const me = await accountCookie('joiner@example.org');
    expect(await slugs(me)).toEqual([]);
    const res = await call('/api/site/join', { method: 'POST', cookie: me, body: { server: s.slug, password: s.password } });
    expect(res.status).toBe(200);
    const [row] = await mine(me);
    expect(row).toMatchObject({ slug: 'mine-joined', role: null, viewer: true, access: true });
  });

  it('a server you open as a member (added by its owner), but not a public one you only look at', async () => {
    const s = await makeServer('mine-member');
    const me = await accountCookie('invited@example.org');
    expect((await call(`/api/site/servers/${s.slug}/invite`, { method: 'POST', cookie: s.cookie, body: { email: 'invited@example.org', role: 'admin' } })).status).toBe(200);
    expect(await slugs(me)).toEqual([]);
    expect((await pageConfig(s.slug, me)).saved).toBe(true);
    expect((await mine(me))[0]).toMatchObject({ slug: 'mine-member', role: 'admin' });

    const p = await makePublic('mine-public', 'pub-owner@example.org');
    const looker = await accountCookie('looker@example.org');
    expect((await pageConfig(p.slug, looker)).saved).toBe(false);
    expect(await slugs(looker)).toEqual([]);
    // and nobody signed in: nothing to say
    expect((await pageConfig(p.slug, null)).saved).toBe(null);
  });
});

describe('adding, removing and reordering', () => {
  it('“Add to my servers” on a public server, then off again; taken off, opening it doesn’t put it back', async () => {
    const p = await makePublic('mine-add', 'add-owner@example.org');
    const me = await accountCookie('adder@example.org');
    const on = await save(p.slug, true, me);
    expect(on.status, await on.clone().text()).toBe(200);
    expect((await mine(me))[0]).toMatchObject({ slug: 'mine-add', role: null, public: true, access: true });
    expect((await pageConfig(p.slug, me)).saved).toBe(true);
    expect((await save(p.slug, false, me)).status).toBe(200);
    expect(await slugs(me)).toEqual([]);
    expect((await pageConfig(p.slug, me)).saved).toBe(false);
  });

  it('a member who took it off isn’t given it back by opening it', async () => {
    const s = await makeServer('mine-off');
    expect(await slugs(s.cookie)).toEqual(['mine-off']);
    expect((await call('/api/site/mine/remove', { method: 'POST', cookie: s.cookie, body: { server: s.slug } })).status).toBe(200);
    expect(await slugs(s.cookie)).toEqual([]);
    expect((await pageConfig(s.slug, s.cookie)).saved).toBe(false);
    expect(await slugs(s.cookie)).toEqual([]);
    // still the owner: the list was all that changed
    expect((await pageConfig(s.slug, s.cookie)).email).toBe(s.owner);
    // and added again, at the end
    expect((await save(s.slug, true, s.cookie)).status).toBe(200);
    expect(await slugs(s.cookie)).toEqual(['mine-off']);
  });

  it('needs a sign-in, and a server you can see', async () => {
    const s = await makeServer('mine-private');
    expect((await save(s.slug, true, null)).status).toBe(401);
    const stranger = await accountCookie('stranger@example.org');
    expect((await save(s.slug, true, stranger)).status).toBe(401);
    expect(await slugs(stranger)).toEqual([]);
    // the password's cookie is proof enough
    const view = await viewerCookie(s);
    expect((await save(s.slug, true, both(stranger, view))).status).toBe(200);
    expect((await mine(stranger))[0]).toMatchObject({ slug: 'mine-private', viewer: true, access: true });
    // and a request from another site is refused
    const other = await call(`/${s.slug}/api/mine`, { method: 'POST', cookie: both(stranger, view), body: { saved: false }, headers: { Origin: 'https://evil.example' } });
    expect(other.status).toBe(403);
  });

  it('keeps the order it’s given; servers it wasn’t told about stay, after them', async () => {
    const me = await accountCookie('orderer@example.org');
    for (const slug of ['ord-a', 'ord-b', 'ord-c']) {
      await makePublic(slug, `${slug}@example.org`);
      expect((await save(slug, true, me)).status).toBe(200);
    }
    expect(await slugs(me)).toEqual(['ord-a', 'ord-b', 'ord-c']);
    const res = await call('/api/site/mine/order', { method: 'POST', cookie: me, body: { servers: ['ord-c', 'nope', 'ord-a'] } });
    expect(res.status).toBe(200);
    expect(await slugs(me)).toEqual(['ord-c', 'ord-a', 'ord-b']);
    // someone else's list is theirs
    const other = await accountCookie('other-orderer@example.org');
    expect((await call('/api/site/mine/order', { method: 'POST', cookie: other, body: { servers: ['ord-b'] } })).status).toBe(200);
    expect(await slugs(me)).toEqual(['ord-c', 'ord-a', 'ord-b']);
    expect(await slugs(other)).toEqual([]);
  });
});

describe('what a row says', () => {
  it('who’s on, from the mod’s list, without hidden players and with aliases as their player', async () => {
    const s = await makeServer('mine-online');
    const key = await newKey(s);
    const stub = env.TENANT.get(env.TENANT.idFromName(s.id));
    await stub.query([
      { q: 'INSERT INTO hidden_players (name) VALUES (?)', p: ['Ghost'], mode: 'run' },
      { q: 'INSERT INTO player_aliases (alias, name) VALUES (?, ?)', p: ['SteveAlt', 'Steve'], mode: 'run' },
    ]);
    const players = [['aa', 'Alex'], ['bb', 'Ghost'], ['cc', 'SteveAlt']].map(([n, name]) => ({ uuid: `00000000-0000-4000-8000-0000000000${n}`, name }));
    expect((await upload(key, null, { path: '/api/ingest/online', body: { players } })).status).toBe(200);
    const [row] = await mine(s.cookie);
    expect(row).toMatchObject({ status: 'up', online: 2, players: ['Alex', 'Steve'], more: 0 });
  });

  it('nothing about a server you can no longer see: its password changed since you joined', async () => {
    const s = await makeServer('mine-locked');
    const me = await accountCookie('was-joined@example.org');
    expect((await call('/api/site/join', { method: 'POST', cookie: me, body: { server: s.slug, password: s.password } })).status).toBe(200);
    expect((await mine(me))[0].access).toBe(true);
    const pw = 'a whole new password';
    expect((await call(`/api/site/servers/${s.slug}/settings`, { method: 'POST', cookie: s.cookie, body: { password: pw, confirm: pw } })).status).toBe(200);
    const [row] = await mine(me);
    expect(row).toMatchObject({ slug: 'mine-locked', access: false });
    expect(row).not.toHaveProperty('online');
    expect(row).not.toHaveProperty('players');
  });

  it('the list needs a sign-in', async () => {
    expect((await call('/api/site/mine')).status).toBe(401);
  });
});
