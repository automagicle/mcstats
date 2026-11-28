// The Discord bot (DISCORD.md): signed interactions, linking a Discord server to exactly one mcstats server,
// commands reading only that server (and only what it shares), and the feeds' relay. Discord itself is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { accountCookie, call, chatEvent, makeServer, newKey, ORIGIN, upload } from './helpers.js';
import { _test as png } from '../src/discord/head.js';
import { esc } from '../src/discord/text.js';
import { channelPermissions, INSTALL_PERMISSIONS, P } from '../src/discord/api.js';

const APP = '100000000000000001';
const PRIVATE_KEY = 'MC4CAQAwBQYDK2VwBCIEIFtMUFaKacdBHJufo8j9ze9Ymie1HYP7XW9kpXi9rNMa';
const MANAGE = String(P.MANAGE_GUILD);
let guildN = 0;
const newGuild = () => `2000000000000000${String(++guildN).padStart(2, '0')}`;

// ---- a fake Discord ----
let discord;
function fakeDiscord() {
  const d = { posts: [], edits: [], deletes: [], webhooks: 0, messages: 0, guilds: new Map(), followups: [], tokenGuild: null };
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname !== 'discord.com') return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/v10/, '');
    const body = init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
    const ok = (data, status = 200) => new Response(data == null ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    let m;
    if (path === '/oauth2/token') return d.tokenGuild ? ok({ access_token: 'x', guild: { id: d.tokenGuild, name: 'The Guild' } }) : ok({ error: 'invalid_grant' }, 400);
    if ((m = /^\/guilds\/(\d+)$/.exec(path))) {
      return ok({ id: m[1], name: `Guild ${m[1].slice(-2)}`, icon: null, system_channel_id: null, roles: [{ id: m[1], permissions: String(INSTALL_PERMISSIONS) }] });
    }
    if (/^\/guilds\/\d+\/members\/\d+$/.test(path)) return ok({ roles: [] });
    if ((m = /^\/guilds\/(\d+)\/channels$/.exec(path))) {
      if (method === 'POST') return ok({ id: `30000000000000${String(++d.messages).padStart(4, '0')}`, name: body.name });
      return ok([
        { id: '300000000000000001', type: 0, name: 'general', position: 0, permission_overwrites: [] },
        { id: '300000000000000002', type: 0, name: 'mc-chat', position: 1, permission_overwrites: [] },
      ]);
    }
    if ((m = /^\/channels\/(\d+)\/webhooks$/.exec(path))) {
      d.webhooks++;
      return ok({ id: `40000000000000000${d.webhooks}`, token: `hooktoken${d.webhooks}`, channel_id: m[1] });
    }
    if (method === 'DELETE' && /^\/webhooks\/\d+$/.test(path)) return ok(null, 204);
    if ((m = /^\/webhooks\/(\d+)\/([^/]+)\/messages\/(.+)$/.exec(path))) {
      if (m[1] === APP) { d.followups.push({ token: m[2], body }); return ok({ id: '1' }); }
      if (method === 'DELETE') { d.deletes.push(m[3]); return ok(null, 204); }
      d.edits.push({ id: m[3], body });
      return ok({ id: m[3] });
    }
    if ((m = /^\/webhooks\/(\d+)\/([^/]+)$/.exec(path)) && method === 'POST') {
      const id = `50000000000000${String(++d.messages).padStart(4, '0')}`;
      d.posts.push({ webhook: m[1], body, id });
      return ok({ id });
    }
    if ((m = /^\/channels\/(\d+)\/messages$/.exec(path)) && method === 'POST') {
      const id = `50000000000000${String(++d.messages).padStart(4, '0')}`;
      d.posts.push({ channel: m[1], body, id });
      return ok({ id });
    }
    return ok({ message: `fake discord: no ${method} ${path}` }, 404);
  });
  return d;
}

beforeEach(() => { discord = fakeDiscord(); });
afterEach(() => vi.unstubAllGlobals());

// ---- signed interactions ----
let signKey;
async function sign(body, ts) {
  signKey ??= await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(PRIVATE_KEY), (c) => c.charCodeAt(0)), { name: 'Ed25519' }, false, ['sign']);
  const sig = await crypto.subtle.sign('Ed25519', signKey, new TextEncoder().encode(ts + body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function interact(payload, { tamper = false, ts = String(Math.floor(Date.now() / 1000)) } = {}) {
  const body = JSON.stringify({ token: 'itok', ...payload });
  const signature = await sign(body, ts);
  return SELF.fetch(`${ORIGIN}/api/discord/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': ts },
    body: tamper ? body.replace('itok', 'xtok') : body,
  });
}

const member = (perms = '0', id = '600000000000000001') => ({ user: { id, username: 'discorduser', global_name: 'Disco' }, permissions: perms });
const slash = (guild, name, options = [], perms = '0', user) => interact({ type: 2, guild_id: guild, member: member(perms, user), data: { name, options } });
const sub = (guild, name, options = [], perms = MANAGE) => slash(guild, 'mcstats', [{ type: 1, name, options }], perms);
const opt = (name, value) => ({ type: 3, name, value });
const answer = async (res) => {
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
};
const text = (a) => [a.data?.content, ...(a.data?.embeds || []).flatMap((e) => [e.title, e.description])].filter(Boolean).join('\n');

const admin = (s, body) => call(`/${s.slug}/api/admin/discord`, { method: body ? 'POST' : 'GET', cookie: s.cookie, body });
const relay = (s) => env.DISCORD_RELAY.get(env.DISCORD_RELAY.idFromName(s.id));

async function linkWithCode(s, guild) {
  const made = await (await admin(s, { action: 'code' })).json();
  expect(made.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const a = await answer(await sub(guild, 'setup', [opt('server', s.slug), opt('code', made.code)]));
  expect(text(a)).toContain('Linked to');
  return a;
}

describe('interactions', () => {
  it('only answers what Discord signed', async () => {
    expect((await interact({ type: 1 }, { tamper: true })).status).toBe(401);
    expect((await interact({ type: 1 }, { ts: String(Math.floor(Date.now() / 1000) - 3600) })).status).toBe(401);
    const unsigned = await SELF.fetch(`${ORIGIN}/api/discord/interactions`, { method: 'POST', body: '{"type":1}' });
    expect(unsigned.status).toBe(401);
    expect(await answer(await interact({ type: 1 }))).toEqual({ type: 1 });
  });

  it('a Discord server that isn’t linked is told how to link, and nothing else', async () => {
    const a = await answer(await slash(newGuild(), 'online'));
    expect(a.data.flags).toBe(64);
    expect(text(a)).toContain('isn’t linked to mcstats yet');
  });
});

describe('linking', () => {
  it('with a code: needs Manage Server, a code for that server, and works once', async () => {
    const s = await makeServer('dc-code');
    const other = await makeServer('dc-code-other');
    const guild = newGuild();
    const made = await (await admin(s, { action: 'code' })).json();
    // without Manage Server
    expect(text(await answer(await sub(guild, 'setup', [opt('server', s.slug), opt('code', made.code)], '0')))).toContain('Manage Server');
    // the code with another server's address
    expect(text(await answer(await sub(guild, 'setup', [opt('server', other.slug), opt('code', made.code)])))).toContain('don’t match');
    // right
    const a = await answer(await sub(guild, 'setup', [opt('server', s.slug), opt('code', made.code.toLowerCase())]));
    expect(text(a)).toContain(`Linked to **Server ${s.slug}**`);
    expect(a.data.components.length).toBeGreaterThan(1); // the wizard
    const row = await env.DIRECTORY.prepare('SELECT server_id FROM discord_guilds WHERE guild_id = ?').bind(guild).first();
    expect(row.server_id).toBe(s.id);
    // used up
    const again = await answer(await sub(newGuild(), 'setup', [opt('server', s.slug), opt('code', made.code)]));
    expect(text(again)).toContain('don’t match');
    // the guild can't be taken over by another server's code
    const code2 = (await (await admin(other, { action: 'code' })).json()).code;
    expect(text(await answer(await sub(guild, 'setup', [opt('server', other.slug), opt('code', code2)])))).toContain('already linked to another');
  });

  it('owners and admins make codes and choose what’s shared; members don’t see the section', async () => {
    const s = await makeServer('dc-roles');
    await call(`/${s.slug}/api/admin/roles`, { method: 'POST', cookie: s.cookie, body: { email: 'adm@example.org', role: 'admin' } });
    await call(`/${s.slug}/api/admin/roles`, { method: 'POST', cookie: s.cookie, body: { email: 'mem@example.org', role: 'member' } });
    const adm = await accountCookie('adm@example.org');
    const mem = await accountCookie('mem@example.org');
    expect((await call(`/${s.slug}/api/admin/discord`, { cookie: mem })).status).toBe(403);
    expect((await call(`/${s.slug}/api/admin/discord`, { cookie: adm })).status).toBe(200);
    expect((await (await call(`/${s.slug}/api/admin/discord`, { cookie: adm })).json()).owner).toBe(true);
    expect((await call(`/${s.slug}/api/admin/discord`, { method: 'POST', cookie: adm, body: { action: 'code' } })).status).toBe(200);
    expect((await call(`/${s.slug}/api/admin/discord`, { method: 'POST', cookie: adm, body: { action: 'share', share: { chat: true } } })).status).toBe(200);
    expect((await call(`/api/discord/install?server=${s.slug}`, { cookie: adm })).status).toBe(302);
    expect((await call(`/${s.slug}/api/admin/discord`, { method: 'POST', cookie: mem, body: { action: 'code' } })).status).toBe(403);
  });

  it('from the dashboard: Add to Discord, and back linked', async () => {
    const s = await makeServer('dc-oauth');
    const guild = newGuild();
    const go = await call(`/api/discord/install?server=${s.slug}`, { cookie: s.cookie });
    expect(go.status).toBe(302);
    const to = new URL(go.headers.get('Location'));
    expect(to.hostname).toBe('discord.com');
    expect(to.searchParams.get('permissions')).toBe('536955904');
    const state = to.searchParams.get('state');
    // someone else can't finish it
    discord.tokenGuild = guild;
    const stranger = await accountCookie('stranger@example.org');
    const bad = await call(`/api/discord/oauth?code=c&state=${encodeURIComponent(state)}&guild_id=${guild}`, { cookie: stranger });
    expect(bad.headers.get('Location')).toContain('discord=not_owner');
    // nor with a made-up state
    const forged = await call(`/api/discord/oauth?code=c&state=${encodeURIComponent(state.slice(0, -2) + 'xx')}&guild_id=${guild}`, { cookie: s.cookie });
    expect(forged.headers.get('Location')).toContain('discord=expired');
    const done = await call(`/api/discord/oauth?code=c&state=${encodeURIComponent(state)}&guild_id=${guild}`, { cookie: s.cookie });
    expect(done.headers.get('Location')).toBe(`/${s.slug}?discord=linked#/admin/discord`);
    const st = await (await admin(s)).json();
    expect(st.link.guild_id).toBe(guild);
    expect(st.guild.channels.map((c) => c.name)).toEqual(['general', 'mc-chat']);
    expect(st.guild.suggested.chat).toBe('300000000000000002');
  });
});

describe('commands', () => {
  it('answer from the linked server only, without hidden players', async () => {
    const a = await makeServer('dc-a');
    const b = await makeServer('dc-b');
    const ga = newGuild(), gb = newGuild();
    await linkWithCode(a, ga);
    await linkWithCode(b, gb);
    const ka = await newKey(a), kb = await newKey(b);
    const players = (...names) => ({ players: names.map((n, i) => ({ uuid: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, name: n })) });
    expect((await upload(ka, null, { path: '/api/ingest/online', body: players('Steve', 'Secret') })).status).toBe(200);
    expect((await upload(kb, null, { path: '/api/ingest/online', body: players('Bob') })).status).toBe(200);
    const hide = await call(`/${a.slug}/api/admin?season=1`, { method: 'POST', cookie: a.cookie, body: { action: 'config.save', hidden: [{ name: 'Secret', note: '' }] } });
    expect(hide.status, await hide.clone().text()).toBe(200);

    const oa = text(await answer(await slash(ga, 'online')));
    expect(oa).toContain('Steve');
    expect(oa).not.toContain('Secret');
    expect(oa).not.toContain('Bob');
    expect(text(await answer(await slash(gb, 'online')))).toContain('Bob');
    // a private server shares only who's online until its owner says otherwise
    expect(text(await answer(await slash(ga, 'top')))).toContain('doesn’t share stats');
    await admin(a, { action: 'share', share: { stats: true } });
    const top = await answer(await slash(ga, 'top'));
    expect(top.data.flags).toBeUndefined();
    expect(text(top)).toContain('Playtime');
  });

  it('autocomplete offers this server’s players', async () => {
    const s = await makeServer('dc-auto');
    const g = newGuild();
    await linkWithCode(s, g);
    await admin(s, { action: 'share', share: { stats: true } });
    const key = await newKey(s);
    await upload(key, null, { path: '/api/ingest/online', body: { players: [{ uuid: '00000000-0000-4000-8000-000000000201', name: 'Alexandra' }] } });
    await runDurableObjectAlarm(env.TENANT.get(env.TENANT.idFromName(s.id)));
    const a = await answer(await interact({ type: 4, guild_id: g, member: member(), data: { name: 'player', options: [{ type: 3, name: 'name', value: 'alex', focused: true }] } }));
    expect(a.type).toBe(8);
    expect(a.data.choices.map((c) => c.name)).toContain('Alexandra');
  });

  it('/say needs the owner to switch it on, and a linked player', async () => {
    const s = await makeServer('dc-say');
    const g = newGuild();
    await linkWithCode(s, g);
    const say = () => slash(g, 'say', [opt('text', 'hello')]);
    expect(text(await answer(await say()))).toContain('doesn’t take chat from Discord');
    await admin(s, { action: 'bridge', bridge: { say: 'linked' } });
    expect(text(await answer(await say()))).toContain('/mcstats connect');
  });
});

describe('feeds', () => {
  it('post what the server shares, escaped and unable to ping, and follow deletes', async () => {
    const s = await makeServer('dc-feeds');
    const g = newGuild();
    await linkWithCode(s, g);
    const chan = '300000000000000002';
    // chat isn't shared yet: the Full bridge preset is refused
    const refused = await admin(s, { action: 'preset', preset: 'bridge', channels: { status: chan, chat: chan } });
    expect(refused.status).toBe(400);
    await admin(s, { action: 'share', share: { chat: true, deaths: true } });
    const set = await admin(s, { action: 'preset', preset: 'bridge', channels: { status: chan, chat: chan } });
    expect(set.status, await set.clone().text()).toBe(200);
    expect(discord.webhooks).toBe(1); // one channel, one webhook for every feed in it

    const key = await newKey(s);
    const ping = chatEvent('hi @everyone **bold**');
    const fromDiscord = chatEvent('from discord', { via: 'discord' });
    const death = chatEvent('Steve was slain by Alex', { kind: 'death' });
    expect((await upload(key, [ping, fromDiscord, death])).status).toBe(200);
    expect(await runDurableObjectAlarm(relay(s))).toBe(true);

    const contents = discord.posts.map((p) => p.body.content || '');
    expect(contents.some((c) => c.includes('mcstats is connected'))).toBe(true); // the welcome
    const chatPost = discord.posts.find((p) => (p.body.content || '').includes('@​everyone'));
    expect(chatPost.body.username).toBe('Steve');
    expect(chatPost.body.content).toContain('\\*\\*bold\\*\\*');
    expect(chatPost.body.allowed_mentions).toEqual({ parse: [] });
    expect(contents.some((c) => c.includes('from discord'))).toBe(false); // no echo
    expect(contents.some((c) => c.includes('☠ Steve was slain by Alex'))).toBe(true);
    expect(discord.posts.some((p) => p.body.embeds?.[0]?.title?.includes('Server dc-feeds'))).toBe(true); // the status message

    // an admin deletes the chat line on the dashboard: it comes off Discord too
    const log = await (await call(`/${s.slug}/api/chat`, { cookie: s.cookie })).json();
    const line = log.messages.find((m) => m.text.startsWith('hi @everyone'));
    const del = await call(`/${s.slug}/api/admin?season=1`, { method: 'POST', cookie: s.cookie, body: { action: 'chat.delete', id: line.id } });
    expect(del.status, await del.clone().text()).toBe(200);
    expect(discord.deletes).toContain(chatPost.id);
  });

  it('the setup wizard in Discord picks a preset and saves it', async () => {
    const s = await makeServer('dc-wizard');
    const g = newGuild();
    const wiz = await linkWithCode(s, g);
    const click = (message, custom_id, values, perms = MANAGE) => interact({
      type: 3, guild_id: g, member: member(perms), message: { components: message.components }, data: { custom_id, ...(values ? { values } : {}) },
    });
    // pick "Status board": the message is redrawn with one channel menu
    const picked = await answer(await click(wiz.data, 'setup:v1:preset', ['status']));
    expect(picked.type).toBe(7);
    expect(picked.data.components.filter((r) => r.components[0].type === 8)).toHaveLength(1);
    // someone without Manage Server can't press Save
    const save = picked.data.components.at(-1).components[0].custom_id;
    expect(save).toMatch(/^setup:v1:save:s:/);
    expect(text(await answer(await click(picked.data, save, null, '0')))).toContain('Manage Server');
    const done = await answer(await click(picked.data, save));
    expect(text(done)).toContain('Saved: **Status board**');
    const feeds = await (await admin(s)).json();
    expect(Object.keys(feeds.feeds).sort()).toEqual(['digest', 'status']);
  });

  it('unlinking deletes the webhooks and forgets the guild', async () => {
    const s = await makeServer('dc-unlink');
    const g = newGuild();
    await linkWithCode(s, g);
    await admin(s, { action: 'preset', preset: 'status', channels: { status: '300000000000000001' } });
    const st = await (await admin(s, { action: 'unlink' })).json();
    expect(st.link).toBe(null);
    expect(await env.DIRECTORY.prepare('SELECT 1 FROM discord_guilds WHERE guild_id = ?').bind(g).first()).toBe(null);
    expect(text(await answer(await slash(g, 'online')))).toContain('isn’t linked');
    const feeds = await runInDurableObject(env.TENANT.get(env.TENANT.idFromName(s.id)), (_o, st2) => st2.storage.sql.exec('SELECT COUNT(*) AS n FROM discord_feeds').one().n);
    expect(feeds).toBe(0);
  });
});

describe('pieces', () => {
  it('escapes game text so it can’t ping or format', () => {
    expect(esc('@here <@123> _x_ https://a.b')).toBe('@\u200bhere <\u200b@\u200b123\\> \\_x\\_ <https://a.b>');
    expect(esc('# big\n- item a-b')).toBe('\\# big\n\\- item a-b');
  });

  it('works out the bot’s permissions in a channel', () => {
    const g = '1', role = '2';
    const roles = [{ id: g, permissions: String(P.VIEW_CHANNEL | P.SEND_MESSAGES) }, { id: role, permissions: String(P.MANAGE_WEBHOOKS) }];
    const channel = { permission_overwrites: [{ id: g, type: 0, allow: '0', deny: String(P.SEND_MESSAGES) }, { id: role, type: 0, allow: String(P.SEND_MESSAGES), deny: '0' }] };
    expect(channelPermissions({ guildId: g, roles, member: { roles: [] }, channel }) & P.SEND_MESSAGES).toBe(0n);
    expect(channelPermissions({ guildId: g, roles, member: { roles: [role] }, channel }) & P.SEND_MESSAGES).toBe(P.SEND_MESSAGES);
  });

  it('makes a face from a skin', async () => {
    const skin = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < skin.length; i += 4) skin.set([200, 100, 50, 255], i);
    const encoded = await png.encodePng(64, 64, skin);
    const face = await png.face(encoded);
    const back = await png.decodePng(face);
    expect(back.width).toBe(64);
    expect(back.pixel(10, 10)).toEqual([200, 100, 50, 255]);
  });
});
