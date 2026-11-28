// Who may send chat from the dashboard, and as whom: what Admin → Players and Roles say, nothing else.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { accountCookie, call, makeServer, newKey, viewerCookie } from './helpers.js';
import { hashAccountPassword } from '../src/password.js';

const me = async (s, cookie) => (await call(`/${s.slug}/api/chat/me`, { cookie })).json();
const save = (s, body) => call(`/${s.slug}/api/admin?season=1`, { method: 'POST', cookie: s.cookie, body: { action: 'config.save', ...body } });
const addMember = (s, email, role = 'member') => call(`/${s.slug}/api/admin/roles`, { method: 'POST', cookie: s.cookie, body: { email, role } });

describe('web chat identity', () => {
  it('says why someone can\'t send: signed out, not a member, or chat turned off', async () => {
    const s = await makeServer('chat-why');
    const send = (cookie) => call(`/${s.slug}/api/chat/send`, { method: 'POST', cookie, body: { text: 'hi' } });
    // in with the server's password only
    const view = await viewerCookie(s);
    expect(await me(s, view)).toMatchObject({ refused: 'signed_out', blocked: true });
    const out = await send(view);
    expect(out.status).toBe(403);
    expect(await out.json()).toMatchObject({ reason: 'signed_out', error: 'Sign in to send messages.' });
    // signed in with an account that isn't one of the server's members
    const stranger = `${view}; ${await accountCookie('stranger@example.org')}`;
    expect(await me(s, stranger)).toMatchObject({ refused: 'not_member', email: null, account: 'stranger@example.org' });
    expect(await (await send(stranger)).json()).toMatchObject({ reason: 'not_member' });
    // the owner isn't stopped at all
    expect(await me(s, s.cookie)).toMatchObject({ refused: null, blocked: false });
  });

  it('follows Admin → Players and Roles', async () => {
    const s = await makeServer('chat-who');
    // the owner, with no player of their own, chats as Admin
    const owner = await me(s, s.cookie);
    expect(owner).toMatchObject({ admin: true, blocked: false });

    // a member whose email isn't linked to a player can't
    expect((await addMember(s, 'steve@example.org')).status).toBe(200);
    const steve = await accountCookie('steve@example.org');
    expect(await me(s, steve)).toMatchObject({ ign: null, admin: false, blocked: false });

    // linked on Admin → Players, they chat as that player, with no team needed
    const saved = await save(s, { emails: [{ email: 'steve@example.org', ign: 'Steve' }] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await me(s, steve)).toMatchObject({ ign: 'Steve', team: null, admin: false });

    // an admin with no player chats as Admin too
    expect((await addMember(s, 'helper@example.org', 'admin')).status).toBe(200);
    expect(await me(s, await accountCookie('helper@example.org'))).toMatchObject({ admin: true });

    // Roles says the same thing
    const roles = await (await call(`/${s.slug}/api/admin/roles`, { cookie: s.cookie })).json();
    const as = Object.fromEntries(roles.users.map((u) => [u.email, u.chat_as]));
    expect(as['steve@example.org']).toBe('Steve');
    expect(as['helper@example.org']).toBe('@admin');
    expect(as[s.owner]).toBe('@admin');

    // and the Chat tick switched off stops them
    const off = await call(`/${s.slug}/api/admin/roles`, { method: 'POST', cookie: s.cookie,
      body: { email: 'steve@example.org', perms: { view: true, chat: false, admin: false, liveview: false, liveview_op: false } } });
    expect(off.status, await off.clone().text()).toBe(200);
    expect(await me(s, steve)).toMatchObject({ blocked: true, refused: 'blocked', ign: null });
    const roles2 = await off.json();
    expect(roles2.users.find((u) => u.email === 'steve@example.org').chat_as).toBe(null);
  });

  it('Roles picks who chats as Admin, whatever player they have, and puts them back', async () => {
    const s = await makeServer('chat-as');
    const roles = (body) => call(`/${s.slug}/api/admin/roles`, { method: 'POST', cookie: s.cookie, body });
    const row = async (res, email) => (await res.json()).users.find((u) => u.email === email);
    expect((await addMember(s, 'alex@example.org')).status).toBe(200);
    const alex = await accountCookie('alex@example.org');
    await save(s, { emails: [{ email: 'alex@example.org', ign: 'Alex' }] });
    expect(await me(s, alex)).toMatchObject({ ign: 'Alex', admin: false });

    // a member with a player, set to chat as Admin: the player stays linked
    const on = await roles({ email: 'alex@example.org', chat_as: 'admin' });
    expect(on.status, await on.clone().text()).toBe(200);
    expect(await row(on, 'alex@example.org')).toMatchObject({ chat_as: '@admin', chat_admin: true, player: 'Alex' });
    expect(await me(s, alex)).toMatchObject({ ign: null, admin: true });
    // saving Players again doesn't undo it
    await save(s, { emails: [{ email: 'alex@example.org', ign: 'Alex' }] });
    expect(await me(s, alex)).toMatchObject({ admin: true });

    const off = await roles({ email: 'alex@example.org', chat_as: 'player' });
    expect(await row(off, 'alex@example.org')).toMatchObject({ chat_as: 'Alex', chat_admin: false });
    expect(await me(s, alex)).toMatchObject({ ign: 'Alex', admin: false });

    // a member with no player can be given Admin too; the owner's own can be set (it isn't access)
    expect((await addMember(s, 'mod@example.org')).status).toBe(200);
    expect(await row(await roles({ email: 'mod@example.org', chat_as: 'admin' }), 'mod@example.org')).toMatchObject({ chat_as: '@admin' });
    expect((await roles({ email: s.owner, chat_as: 'admin' })).status).toBe(200);
    // not for someone who isn't a member, and not by an admin
    expect((await roles({ email: 'stranger@example.org', chat_as: 'admin' })).status).toBe(400);
    expect((await roles({ email: 'alex@example.org', chat_as: 'everyone' })).status).toBe(400);
    expect((await addMember(s, 'helper@example.org', 'admin')).status).toBe(200);
    expect((await call(`/${s.slug}/api/admin/roles`, { method: 'POST', cookie: await accountCookie('helper@example.org'), body: { email: 'alex@example.org', chat_as: 'admin' } })).status).toBe(403);
  });
  it('connects a player from in game once that account says yes (/mcstats connect)', async () => {
    const s = await makeServer('chat-connect');
    const key = await newKey(s);
    const res = await call('/api/ingest/link', { headers: { Upgrade: 'websocket', Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(101);
    const sock = res.webSocket;
    sock.accept();
    const answers = new Map();
    sock.addEventListener('message', (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'ack') answers.get(m.id)?.(m);
      } catch { /* pong */ }
    });
    let n = 0;
    const ask = (m) => new Promise((resolve) => {
      const id = `acct-${++n}`;
      answers.set(id, resolve);
      sock.send(JSON.stringify({ type: 'account', id, ...m }));
    });
    const uuid = '00000000-0000-4000-8000-0000000000aa';
    const connect = (cookie, accept) => call(`/${s.slug}/api/chat/connect`, { method: 'POST', cookie, body: { accept } });

    expect(await ask({ action: 'status', uuid, name: 'Alex' })).toMatchObject({ ok: true, email: null, confirmed: false });
    expect(await ask({ action: 'connect', uuid, name: 'Alex', email: 'not an email' })).toMatchObject({ ok: false });
    expect(await ask({ action: 'connect', uuid, name: 'Alex', email: 'Alex@Example.org' })).toMatchObject({ ok: true, email: 'alex@example.org', confirmed: false });

    // asking does nothing by itself: the account sees the request, and nobody else can answer it
    expect((await addMember(s, 'alex@example.org')).status).toBe(200);
    expect((await addMember(s, 'bob@example.org')).status).toBe(200);
    const alex = await accountCookie('alex@example.org');
    const bob = await accountCookie('bob@example.org');
    expect(await me(s, alex)).toMatchObject({ ign: null, connect: { name: 'Alex' } });
    expect(await me(s, bob)).toMatchObject({ connect: null });
    expect((await connect(bob, true)).status).toBe(404);

    // the yes: Alex's account chats as Alex, and the admin page shows it on the player
    expect((await connect(alex, true)).status).toBe(200);
    expect(await me(s, alex)).toMatchObject({ ign: 'Alex', connected: true, connect: null });
    expect(await ask({ action: 'status', uuid, name: 'Alex' })).toMatchObject({ ok: true, email: 'alex@example.org', confirmed: true });
    const state = await (await call(`/${s.slug}/api/admin?season=1`, { cookie: s.cookie })).json();
    expect(state.connected).toEqual([expect.objectContaining({ uuid, name: 'Alex', email: 'alex@example.org' })]);
    const roles = await (await call(`/${s.slug}/api/admin/roles`, { cookie: s.cookie })).json();
    expect(roles.users.find((u) => u.email === 'alex@example.org').chat_as).toBe('Alex');

    // Admin → Players' own emails still come first
    expect((await save(s, { emails: [{ email: 'alex@example.org', ign: 'Steve' }] })).status).toBe(200);
    expect(await me(s, alex)).toMatchObject({ ign: 'Steve' });
    expect((await save(s, { emails: [] })).status).toBe(200);

    // the player disconnects in game; an admin can too
    expect(await ask({ action: 'disconnect', uuid, name: 'Alex' })).toMatchObject({ ok: true, had: 'alex@example.org' });
    expect(await me(s, alex)).toMatchObject({ ign: null, connected: false });
    await ask({ action: 'connect', uuid, name: 'Alex', email: 'alex@example.org' });
    expect((await connect(alex, true)).status).toBe(200);
    const off = await call(`/${s.slug}/api/admin?season=1`, { method: 'POST', cookie: s.cookie, body: { action: 'account.disconnect', uuid } });
    expect(off.status, await off.clone().text()).toBe(200);
    expect(await me(s, alex)).toMatchObject({ ign: null });

    // saying no ends the request
    await ask({ action: 'connect', uuid, name: 'Alex', email: 'alex@example.org' });
    expect((await connect(alex, false)).status).toBe(200);
    expect(await me(s, alex)).toMatchObject({ ign: null, connect: null });
    sock.close();
  });
});

describe('making an owner', () => {
  it('needs the account password of whoever does it, and can’t be undone from the page', async () => {
    const s = await makeServer('own-more');
    await env.DIRECTORY.prepare('UPDATE accounts SET pw_hash = ? WHERE email = ?').bind(await hashAccountPassword(env, 'the-owners-password'), s.owner).run();
    const roles = (body, cookie = s.cookie) => call(`/${s.slug}/api/admin/roles`, { method: 'POST', cookie, body });
    expect((await addMember(s, 'second@example.org', 'admin')).status).toBe(200);
    const second = await accountCookie('second@example.org');

    // no password, a wrong one, someone else's: nothing changes
    expect((await roles({ email: 'second@example.org', role: 'owner' })).status).toBe(400);
    const wrong = await roles({ email: 'second@example.org', role: 'owner', password: 'not-the-password' });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ field: 'password' });
    // an admin can't make owners, themselves included
    expect((await roles({ email: 'second@example.org', role: 'owner', password: 'the-owners-password' }, second)).status).toBe(403);
    expect((await call(`/${s.slug}/api/admin/roles`, { cookie: second })).status).toBe(403);

    const ok = await roles({ email: 'second@example.org', role: 'owner', password: 'the-owners-password' });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await ok.json()).users.find((u) => u.email === 'second@example.org')).toMatchObject({ role: 'owner', custom: false });
    // the new owner has Roles, and the owner's settings
    expect((await call(`/${s.slug}/api/admin/roles`, { cookie: second })).status).toBe(200);
    expect((await (await call(`/${s.slug}/api/admin/server`, { cookie: second })).json()).can.owner).toBe(true);
    // and stays one
    expect((await roles({ email: 'second@example.org', role: 'admin' })).status).toBe(400);
    expect((await roles({ email: 'second@example.org', remove: true })).status).toBe(400);
    // someone who was never a member can be made one straight away
    expect((await roles({ email: 'third@example.org', role: 'owner', password: 'the-owners-password' })).status).toBe(200);
  });

  it('stops taking guesses at the password', async () => {
    const s = await makeServer('own-guess');
    await env.DIRECTORY.prepare('UPDATE accounts SET pw_hash = ? WHERE email = ?').bind(await hashAccountPassword(env, 'the-owners-password'), s.owner).run();
    const roles = (body) => call(`/${s.slug}/api/admin/roles`, { method: 'POST', cookie: s.cookie, body });
    for (let i = 0; i < 5; i++) expect((await roles({ email: 'x@example.org', role: 'owner', password: `guess-${i}` })).status).toBe(403);
    expect((await roles({ email: 'x@example.org', role: 'owner', password: 'the-owners-password' })).status).toBe(429);
  });
});
