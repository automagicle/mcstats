// Admin → Mod and commands (src/commands.js): which /mcstats commands are switched off, who may change that,
// what the mod is told over its connection, and what the server's pages are told.
import { describe, expect, it } from 'vitest';
import { accountCookie, call, makeServer, newKey, viewerCookie } from './helpers.js';

const settings = (server, cookie, body) => call(`/${server.slug}/api/admin/server`, { method: body ? 'POST' : 'GET', cookie, body });
const invite = async (server, email, role) => {
  expect((await call(`/api/site/servers/${server.slug}/invite`, { method: 'POST', cookie: server.cookie, body: { email, role } })).status).toBe(200);
  return accountCookie(email);
};
// What the page is told about its server (window.MCS, src/index.js).
const pageConfig = async (server, cookie) => JSON.parse((await (await call(`/${server.slug}`, { cookie })).text()).match(/window\.MCS=(\{.*?\});<\/script>/)[1]);
// The mod's web chat connection, with everything it's sent kept in order.
async function modSocket(server, agent = 'mcstats-chat/2.4.0 (Minecraft 26.2)') {
  const key = await newKey(server);
  const res = await call('/api/ingest/link', { headers: { Upgrade: 'websocket', Authorization: `Bearer ${key}`, 'User-Agent': agent } });
  expect(res.status).toBe(101);
  const got = [];
  let wake = null;
  res.webSocket.addEventListener('message', (e) => {
    try { got.push(JSON.parse(e.data)); } catch { /* pong */ }
    wake?.();
  });
  res.webSocket.accept();
  const next = async (type) => {
    for (let i = 0; i < 200; i++) {
      const at = got.findIndex((m) => m.type === type);
      if (at >= 0) return got.splice(at, 1)[0];
      await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 10); });
    }
    throw new Error(`no ${type} message from the dashboard`);
  };
  return { sock: res.webSocket, next };
}

describe('switching /mcstats commands off', () => {
  it('starts with every command on and the Activity box closed', async () => {
    const a = await makeServer('cmd-start');
    const owner = await accountCookie(a.owner);
    expect((await (await settings(a, owner)).json()).commands).toEqual({ off: [], fold: true });
    expect((await pageConfig(a, owner)).commands).toEqual({ off: [], fold: true });
    const state = await (await call(`/${a.slug}/api/admin?season=1`, { cookie: owner })).json();
    // supported: null until a mod has connected and said its version
    expect(state.commands).toEqual({ off: [], fold: true, needs: '2.4.0', supported: null });
  });

  it('an admin switches commands off and on; members and viewers can’t', async () => {
    const a = await makeServer('cmd-admin');
    const helper = await invite(a, 'helper@example.org', 'admin');
    const off = await settings(a, helper, { commands_off: ['top', 'connect'] });
    expect(off.status).toBe(200);
    // kept in the mod's own order, whatever order they were sent in
    expect((await off.json()).commands).toEqual({ off: ['top', 'connect'], fold: true });
    expect((await (await settings(a, helper, { commands_off: ['reset', 'view', 'top'] })).json()).commands.off).toEqual(['view', 'top', 'reset']);
    // every page of the server is told, so the Activity list leaves them out
    expect((await pageConfig(a, await viewerCookie(a))).commands.off).toEqual(['view', 'top', 'reset']);
    expect((await (await settings(a, helper, { commands_off: [] })).json()).commands.off).toEqual([]);

    // help can't be switched off, and neither can something that isn't a command
    for (const bad of [['help'], ['top', 'nonsense'], 'top', [3], { top: true }]) {
      const res = await settings(a, helper, { commands_off: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).field).toBe('commands_off');
    }
    expect((await (await settings(a, helper)).json()).commands.off).toEqual([]);

    const member = await invite(a, 'member@example.org', 'member');
    expect((await settings(a, member, { commands_off: ['top'] })).status).toBe(403);
    expect((await settings(a, await viewerCookie(a), { commands_off: ['top'] })).status).toBe(403);
    const b = await makeServer('cmd-admin-b');
    expect((await settings(a, await accountCookie(b.owner), { commands_off: ['top'] })).status).toBe(401);
    expect((await (await settings(a, helper)).json()).commands.off).toEqual([]);
  });

  it('the Activity box can be set to start open, and closed again', async () => {
    const a = await makeServer('cmd-fold');
    const owner = await accountCookie(a.owner);
    expect((await (await settings(a, owner, { commands_fold: false })).json()).commands).toEqual({ off: [], fold: false });
    expect((await pageConfig(a, owner)).commands.fold).toBe(false);
    // it doesn't touch which commands are off, and the other way round
    expect((await (await settings(a, owner, { commands_off: ['link'] })).json()).commands).toEqual({ off: ['link'], fold: false });
    expect((await (await settings(a, owner, { commands_fold: true })).json()).commands).toEqual({ off: ['link'], fold: true });
  });

  it('one server’s choice is its own', async () => {
    const a = await makeServer('cmd-own-a');
    const b = await makeServer('cmd-own-b');
    expect((await settings(a, await accountCookie(a.owner), { commands_off: ['profile'], commands_fold: false })).status).toBe(200);
    expect((await (await settings(b, await accountCookie(b.owner))).json()).commands).toEqual({ off: [], fold: true });
  });
});

describe('what the mod hears', () => {
  it('is told when it connects, and again the moment an admin changes it', async () => {
    const a = await makeServer('cmd-mod');
    const owner = await accountCookie(a.owner);
    // nothing connected yet: saved all the same, and the answer says the mod wasn't told
    const before = await (await settings(a, owner, { commands_off: ['particle'] })).json();
    expect(before.commands_told).toBe(false);

    const mod = await modSocket(a);
    expect(await mod.next('hello')).toMatchObject({ type: 'hello', commands_off: ['particle'] });
    const state = await (await call(`/${a.slug}/api/admin?season=1`, { cookie: owner })).json();
    expect(state.commands).toMatchObject({ off: ['particle'], supported: true });

    const changed = await (await settings(a, owner, { commands_off: ['particle', 'stats'] })).json();
    expect(changed.commands_told).toBe(true);
    expect(await mod.next('commands')).toEqual({ type: 'commands', off: ['stats', 'particle'] });
    // saving the same list again, or something else, tells it nothing
    const same = await (await settings(a, owner, { commands_off: ['stats', 'particle'], commands_fold: false })).json();
    expect(same.commands_told).toBeUndefined();
    expect((await (await settings(a, owner, { commands_off: [] })).json()).commands_told).toBe(true);
    expect(await mod.next('commands')).toEqual({ type: 'commands', off: [] });
    mod.sock.close();
  });

  it('an older mod is marked as not able to', async () => {
    const a = await makeServer('cmd-old');
    const owner = await accountCookie(a.owner);
    const mod = await modSocket(a, 'mcstats-chat/2.3.0 (Minecraft 26.2)');
    // it's sent the list like any other; it just ignores it
    expect(await mod.next('hello')).toMatchObject({ commands_off: [] });
    const state = await (await call(`/${a.slug}/api/admin?season=1`, { cookie: owner })).json();
    expect(state.commands.supported).toBe(false);
    mod.sock.close();
  });
});

// The Fabric mod and the Paper plugin connect the same way; the plugin's User-Agent ends in "Paper".
describe('which edition the server runs', () => {
  it('remembers the Paper plugin and offers Paper jars for it', async () => {
    const a = await makeServer('ed-paper');
    const owner = await accountCookie(a.owner);
    const mod = await modSocket(a, 'mcstats-chat/2.3.0 (Minecraft 1.21.11) Paper');
    // an older version than the newest, so it's told about the update: with the Paper jar for its Minecraft
    const update = await mod.next('update');
    expect(update.jar).toMatch(/^\/downloads\/mcstats-paper-[\d.]+\+mc1\.21\.11\.jar$/);
    const state = await (await call(`/${a.slug}/api/admin?season=1`, { cookie: owner })).json();
    expect(state.link.edition).toBe('paper');
    expect(state.mod).toMatchObject({ server_edition: 'paper', server_minecraft: '1.21.11' });
    expect(state.mod.suggested).toMatch(/^mcstats-paper-/);
    expect(state.mod_update).toMatchObject({ edition: 'paper', jar: expect.stringMatching(/^mcstats-paper-/) });
    mod.sock.close();
  });

  it('takes a mod that says nothing more for the Fabric mod', async () => {
    const a = await makeServer('ed-fabric');
    const owner = await accountCookie(a.owner);
    const mod = await modSocket(a, 'mcstats-chat/2.3.0 (Minecraft 1.21.11)');
    expect((await mod.next('update')).jar).toMatch(/^\/downloads\/mcstats-chat-[\d.]+\+mc1\.21\.11\.jar$/);
    const state = await (await call(`/${a.slug}/api/admin?season=1`, { cookie: owner })).json();
    expect(state.link.edition).toBe('fabric');
    expect(state.mod.suggested).toMatch(/^mcstats-chat-/);
    mod.sock.close();
  });
});
