// Admin → Layout and Server's icon and description (src/layout.js), and Admin → Players' per-player edits
// (real names, sign-in emails: src/admin.js config.save).
import { describe, expect, it } from 'vitest';
import { cleanLayout, defaultLayout, iconFromDataUrl, layoutSetting } from '../src/layout.js';
import { call, idCookie, makeServer, viewerCookie } from './helpers.js';

const settings = (server, cookie, body) => call(`/${server.slug}/api/admin/server`, { method: body ? 'POST' : 'GET', cookie, body });
const admin = (server, cookie, body) => call(`/${server.slug}/api/admin?season=1`, { method: body ? 'POST' : 'GET', cookie, body });

// a w×h PNG's first bytes (signature and IHDR), which is all iconFromDataUrl looks at
function png(w, h) {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return `data:image/png;base64,${btoa(String.fromCharCode(...b))}`;
}

describe('layouts', () => {
  it('fills in what’s missing, drops what it doesn’t know, and keeps nothing for the default', () => {
    const l = cleanLayout({ home: [{ id: 'busiest', w: 'full', hide: true, title: '  Peak\u0007 hours ' }, { id: 'nope' }, { id: 'busiest' }], tiles: { home: [{ id: 'seen' }] } });
    expect(l.home[0]).toEqual({ id: 'busiest', w: 'full', hide: true, title: 'Peak hours' });
    expect(l.home.map((s) => s.id)).toEqual(['busiest', 'about', 'now', 'timeline', 'daily', 'leaderboard', 'commands']);
    expect(l.tiles.home.map((t) => t.id)).toEqual(['seen', 'online', 'peak', 'played']);
    expect(l.player).toEqual(defaultLayout().player);
    expect(cleanLayout('not json')).toBeNull();
    expect(layoutSetting(cleanLayout({}))).toBe('');
    // a row of tiles is never left empty
    expect(cleanLayout({ tiles: { player: ['total', 'sessions', 'longest', 'chat'].map((id) => ({ id, hide: true })) } }).tiles.player[0].hide).toBeUndefined();
  });

  it('an admin saves one, and the page gets it', async () => {
    const a = await makeServer('lay-save');
    const owner = await idCookie(a, a.owner);
    const layout = { ...defaultLayout(), combat: [{ id: 'leaderboard', w: 'half' }, { id: 'chart', w: 'half' }, { id: 'score', w: 'full', hide: true }] };
    const res = await settings(a, owner, { layout });
    expect(res.status).toBe(200);
    expect((await res.json()).layout.combat).toEqual(layout.combat);
    const html = await (await call(`/${a.slug}`, { cookie: owner })).text();
    expect(html).toContain('"combat":[{"id":"leaderboard","w":"half"}');
    expect((await settings(a, owner, { layout: [1, 2] })).status).toBe(400);
    // back to the default: nothing is kept
    expect((await (await settings(a, owner, { layout: defaultLayout() })).json()).layout).toEqual(defaultLayout());
  });
});

describe('the server’s icon and description', () => {
  it('takes a square PNG only', () => {
    expect(iconFromDataUrl(png(64, 64)).size).toBe(64);
    expect(iconFromDataUrl(png(64, 32)).error).toMatch(/square/);
    expect(iconFromDataUrl(png(512, 512)).error).toMatch(/256/);
    expect(iconFromDataUrl('data:image/jpeg;base64,AAAA').error).toMatch(/PNG/);
    expect(iconFromDataUrl(`data:image/png;base64,${btoa('x'.repeat(40))}`).error).toMatch(/PNG/);
  });

  it('is set by an admin, shown to viewers, and removed again', async () => {
    const a = await makeServer('icon-set');
    const owner = await idCookie(a, a.owner);
    const viewer = await viewerCookie(a);
    expect((await call(`/${a.slug}/api/icon`, { cookie: viewer })).status).toBe(404);
    const res = await settings(a, owner, { icon: png(64, 64), about: '  A survival server\n\n\nfor friends.  ' });
    expect(res.status).toBe(200);
    const got = await res.json();
    expect(got.about).toBe('A survival server\nfor friends.');
    expect(got.icon).toMatch(/^\/api\/icon\?v=\d+$/);
    const icon = await call(`/${a.slug}${got.icon}`, { cookie: viewer });
    expect(icon.status).toBe(200);
    expect(icon.headers.get('Content-Type')).toBe('image/png');
    expect(icon.headers.get('Cache-Control')).toContain('immutable');
    // nobody who can't look at the server gets it
    expect((await call(`/${a.slug}${got.icon}`)).status).toBe(401);
    const html = await (await call(`/${a.slug}`, { cookie: viewer })).text();
    // the browser tab keeps the mcstats icon; link previews show the server's own icon, name and description
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml');
    expect(html).toMatch(new RegExp(`<meta property="og:image" content="https?://[^"]+/${a.slug}/api/icon\\?v=\\d+">`));
    expect(html).toContain('<meta property="og:description" content="A survival server\nfor friends.">');
    expect(html).not.toContain('og:image:width');
    expect(html).toContain('"about":"A survival server\\nfor friends."');

    expect((await settings(a, owner, { icon: png(10, 10) })).status).toBe(400);
    expect((await settings(a, owner, { about: 'x'.repeat(281) })).status).toBe(400);
    expect((await (await settings(a, owner, { icon: '' })).json()).icon).toBeNull();
    expect((await call(`/${a.slug}/api/icon`, { cookie: viewer })).status).toBe(404);
  });
});

describe('editing a player', () => {
  it('saves a real name and the emails they chat with, and leaves names alone when they’re not sent', async () => {
    const a = await makeServer('player-edit');
    const owner = await idCookie(a, a.owner);
    const teams = [{ id: 'red', name: 'Red', short: 'Red', color: '#cc3333', bar: true, middle: false, chart: true, activity: true, activity_with: null }];
    let res = await admin(a, owner, { action: 'config.save', teams, roster: [{ ign: 'Steve', team: 'red', name: 'Steven' }, { ign: 'Alex', team: 'red' }],
      emails: [{ email: 'Steve@Example.org', ign: 'Steve' }] });
    expect(res.status).toBe(200);
    let d = await (await admin(a, owner)).json();
    expect(d.roster.find((r) => r.ign === 'Steve').name).toBe('Steven');
    expect(d.roster.find((r) => r.ign === 'Alex').name).toBe('');
    expect(d.emails).toEqual([{ email: 'steve@example.org', ign: 'Steve' }]);

    // a save without names (an older page) keeps them; '' takes one away
    res = await admin(a, owner, { action: 'config.save', roster: [{ ign: 'Steve', team: 'red' }, { ign: 'Alex', team: 'red', name: 'Alexandra' }] });
    expect(res.status).toBe(200);
    d = await (await admin(a, owner)).json();
    expect(d.roster.map((r) => [r.ign, r.name])).toEqual([['Alex', 'Alexandra'], ['Steve', 'Steven']]);
    await admin(a, owner, { action: 'config.save', roster: [{ ign: 'Steve', team: 'red', name: '' }, { ign: 'Alex', team: 'red' }], emails: [] });
    d = await (await admin(a, owner)).json();
    expect(d.roster.find((r) => r.ign === 'Steve').name).toBe('');
    expect(d.emails).toEqual([]);

    for (const emails of [[{ email: 'nope', ign: 'Steve' }], [{ email: 'a@b.org', ign: 'Steve' }, { email: 'A@b.org', ign: 'Alex' }]]) {
      expect((await admin(a, owner, { action: 'config.save', emails })).status).toBe(400);
    }
  });
});
