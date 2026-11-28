// The Advancements add-on (src/addons.js, public/addons/advancements/): its page's data, everyone's
// advancements at once, on a server that has it switched on.
import { describe, expect, it } from 'vitest';
import { call, idCookie, makeServer, newKey, upload } from './helpers.js';

const settings = (server, cookie, body) => call(`/${server.slug}/api/admin/server`, body ? { method: 'POST', cookie, body } : { cookie });
const summary = (server, cookie) => call(`/${server.slug}/api/advancements/summary`, { cookie });
const node = (id, extra = {}) => ({ id, title: id, desc: '', icon: { id: 'minecraft:stone' }, frame: 'task', x: 0, y: 0, ...extra });
const TREE = [
  node('minecraft:story/root'),
  node('minecraft:story/mine_stone', { parent: 'minecraft:story/root', x: 1 }),
  node('minecraft:adventure/adventuring_time', { parent: 'minecraft:story/root', x: 2, frame: 'challenge', of: 53 }),
];
const player = (n, name, done, part = {}, ts = Date.now()) => ({ uuid: `00000000-0000-4000-8000-00000000000${n}`, name, ts, done, part });
const sec = Math.floor(Date.now() / 1000);

describe('the Advancements add-on', () => {
  it('answers only on a server that has it, with what each player has earned in the tree', async () => {
    const a = await makeServer('adv-a');
    const b = await makeServer('adv-b');
    const owner = await idCookie(a, a.owner);
    const key = await newKey(a);
    const sent = await upload(key, null, {
      path: '/api/ingest/advancements',
      body: {
        tree: { ts: Date.now(), list: TREE },
        players: [
          player(1, 'Steve', { 'minecraft:story/root': sec - 500, 'minecraft:story/mine_stone': sec - 400, 'minecraft:recipes/misc/stick': sec - 300 },
            { 'minecraft:adventure/adventuring_time': { n: 12, of: 53, got: ['minecraft:plains'] } }, Date.now() - 60_000),
          player(2, 'Alex', { 'minecraft:story/root': sec - 450 }, { 'minecraft:story/mine_stone': { n: 0, of: 1, got: [] } }),
        ],
      },
    });
    expect(await sent.json()).toEqual({ stored: 2, tree: true });

    // without the add-on there's no such page, and no such route
    expect((await summary(a, owner)).status).toBe(404);
    expect(await (await call(`/${a.slug}`, { cookie: owner })).text()).not.toContain('/addons/advancements/');

    const operator = await idCookie(a, 'operator@example.org');
    expect((await settings(a, owner, { addons: ['advancements'] })).status).toBe(403);
    expect((await (await settings(a, operator, { addons: ['advancements'] })).json()).addons).toEqual(['advancements']);
    expect(await (await call(`/${a.slug}`, { cookie: owner })).text()).toContain('<script src="/addons/advancements/addon.js" defer></script>');

    const res = await summary(a, owner);
    expect(res.status).toBe(200);
    const got = await res.json();
    expect(got.tree.map((x) => x.id)).toEqual(TREE.map((x) => x.id));
    // newest report first; what isn't in the tree (recipes) is dropped; progress that hasn't started isn't sent
    expect(got.players.map((p) => p.name)).toEqual(['Alex', 'Steve']);
    expect(got.ts).toBe(got.players[0].ts);
    expect(got.players[0]).toMatchObject({ uuid: '00000000-0000-4000-8000-000000000002', done: { 'minecraft:story/root': sec - 450 }, part: {} });
    expect(got.players[1].done).toEqual({ 'minecraft:story/root': sec - 500, 'minecraft:story/mine_stone': sec - 400 });
    expect(got.players[1].part).toEqual({ 'minecraft:adventure/adventuring_time': { n: 12, of: 53 } });

    // signed out, or on another server: nothing
    expect((await summary(a)).status).toBe(401);
    expect((await summary(b, await idCookie(b, b.owner))).status).toBe(404);

    // switched off again, it's gone
    expect((await (await settings(a, operator, { addons: [] })).json()).addons).toEqual([]);
    expect((await summary(a, owner)).status).toBe(404);
  });

  it('is empty, not an error, before the mod has sent anything', async () => {
    const a = await makeServer('adv-empty');
    await settings(a, await idCookie(a, 'operator@example.org'), { addons: ['advancements'] });
    const res = await summary(a, await idCookie(a, a.owner));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tree: [], ts: null, players: [], shared: false });
  });

  it('its admins say advancements are shared, and the page is told', async () => {
    const a = await makeServer('adv-shared');
    const owner = await idCookie(a, a.owner);
    // no add-on, no option: it isn't offered, and can't be set
    expect((await (await settings(a, owner)).json()).addon_options).toEqual([]);
    expect((await settings(a, owner, { addon_options: { advancements: { shared: true } } })).status).toBe(400);
    await settings(a, await idCookie(a, 'operator@example.org'), { addons: ['advancements'] });

    const state = await (await settings(a, owner)).json();
    expect(state.addon_options).toMatchObject([{ addon: 'advancements', key: 'shared', on: false, name: expect.any(String), about: expect.any(String) }]);
    expect((await (await summary(a, owner)).json()).shared).toBe(false);
    for (const bad of [{ advancements: { nope: true } }, { advancements: { shared: 'yes' } }, { eggsmp: { shared: true } }, []]) {
      expect((await settings(a, owner, { addon_options: bad })).status).toBe(400);
    }
    // the server's own admin sets it (it isn't the operators' alone, as switching the add-on on is)
    const set = await (await settings(a, owner, { addon_options: { advancements: { shared: true } } })).json();
    expect(set.addon_options[0].on).toBe(true);
    expect((await (await summary(a, owner)).json()).shared).toBe(true);
    expect((await (await settings(a, owner, { addon_options: { advancements: { shared: false } } })).json()).addon_options[0].on).toBe(false);
    expect((await (await summary(a, owner)).json()).shared).toBe(false);
  });

  it('counts a player’s accounts together, and leaves hidden players out', async () => {
    const a = await makeServer('adv-merge');
    const owner = await idCookie(a, a.owner);
    await settings(a, await idCookie(a, 'operator@example.org'), { addons: ['advancements'] });
    const key = await newKey(a);
    await upload(key, null, {
      path: '/api/ingest/advancements',
      body: {
        tree: { ts: Date.now(), list: TREE },
        players: [
          player(1, 'Steve', { 'minecraft:story/root': sec - 500 }, {}, Date.now() - 60_000),
          player(3, 'SteveAlt', { 'minecraft:story/root': sec - 900, 'minecraft:story/mine_stone': sec - 100 }),
          player(4, 'Ghost', { 'minecraft:story/root': sec - 50 }),
        ],
      },
    });
    const admin = (body) => call(`/${a.slug}/api/admin?season=1`, { method: 'POST', cookie: owner, body });
    const saved = await admin({ action: 'config.save', aliases: [{ alias: 'SteveAlt', name: 'Steve' }], hidden: [{ name: 'Ghost', note: '' }] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const got = await (await summary(a, owner)).json();
    expect(got.players).toHaveLength(1);
    expect(got.players[0].name).toBe('Steve');
    expect(got.players[0].done).toEqual({ 'minecraft:story/root': sec - 900, 'minecraft:story/mine_stone': sec - 100 });
  });
});
