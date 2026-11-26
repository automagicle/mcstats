// Who may send chat from the dashboard, and as whom: what Admin → Players and Roles say, nothing else.
import { describe, expect, it } from 'vitest';
import { accountCookie, call, makeServer } from './helpers.js';

const me = async (s, cookie) => (await call(`/s/${s.slug}/api/chat/me`, { cookie })).json();
const save = (s, body) => call(`/s/${s.slug}/api/admin?season=1`, { method: 'POST', cookie: s.cookie, body: { action: 'config.save', ...body } });
const addMember = (s, email, role = 'member') => call(`/s/${s.slug}/api/admin/roles`, { method: 'POST', cookie: s.cookie, body: { email, role } });

describe('web chat identity', () => {
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
    const roles = await (await call(`/s/${s.slug}/api/admin/roles`, { cookie: s.cookie })).json();
    const as = Object.fromEntries(roles.users.map((u) => [u.email, u.chat_as]));
    expect(as['steve@example.org']).toBe('Steve');
    expect(as['helper@example.org']).toBe('@admin');
    expect(as[s.owner]).toBe('@admin');

    // and the Chat tick switched off stops them
    const off = await call(`/s/${s.slug}/api/admin/roles`, { method: 'POST', cookie: s.cookie,
      body: { email: 'steve@example.org', perms: { view: true, chat: false, admin: false, liveview: false, liveview_op: false } } });
    expect(off.status, await off.clone().text()).toBe(200);
    expect(await me(s, steve)).toMatchObject({ blocked: true, ign: null });
    const roles2 = await off.json();
    expect(roles2.users.find((u) => u.email === 'steve@example.org').chat_as).toBe(null);
  });
});
