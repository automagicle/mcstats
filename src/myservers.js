// "Your servers": each mcstats account's own list of servers (the account_servers table,
// directory-migrations/0004_my_servers.sql), shown at /servers in the order the account chose.
//
// What goes on it:
//   by itself   a server the account makes (src/site.js), joins with its password while signed in (src/site.js),
//               or opens as a member (src/index.js, when the stats page is served). Never one it took off.
//   asked for   "Add to my servers" on any server's page it can see (POST /<server>/api/mine, src/index.js)
//
//   GET  /api/site/mine                    { servers: [...] }, in order, each with the account's role there and who's on
//   POST /api/site/mine/order  { servers: [slug, ...] }   the new order (servers left out keep theirs, after these)
//   POST /api/site/mine/remove { server: slug }           off the list (the account stays whatever it is there)
//   POST /<server>/api/mine  { saved: true | false }    on or off the list, from the server's own page
//
// Being on the list gives nothing: what an account may see or do on a server is still that server's own
// business (src/tenant.js access(), src/roles.js). Each row's role and online players come from the server's
// own object (card()), which only tells an account that may see the server.
import { passwordStamp } from './session.js';
import { tenantStub } from './tenantenv.js';
import { json } from './util.js';

export const MAX_LISTED = 60;
// players named per server; the rest are a count
const NAMED = 8;
const now = () => Math.floor(Date.now() / 1000);

const listedCount = async (env, accountId) => (await env.DIRECTORY.prepare(
  'SELECT COUNT(*) AS n FROM account_servers WHERE account_id = ? AND removed_at IS NULL'
).bind(accountId).first('n')) ?? 0;

// The next place at the end of the account's list, as SQL (?1 is the account).
const END = '(SELECT COALESCE(MAX(position), 0) + 1 FROM account_servers WHERE account_id = ?1)';

// A signed-in account was let in to a server: joined it with its password (view: { stamp, until }, from the
// viewer cookie), or opened it as a member or its owner. auto: whether that's enough to put it on the list by
// itself; it never puts back a server the account took off. Returns whether it's on the list now.
export async function noteServer(env, accountId, serverId, { auto = false, view = null } = {}) {
  const db = env.DIRECTORY;
  const row = await db.prepare('SELECT removed_at, view_stamp, view_until FROM account_servers WHERE account_id = ? AND server_id = ?')
    .bind(accountId, serverId).first();
  if (!row) {
    if (!auto || (await listedCount(env, accountId)) >= MAX_LISTED) return false;
    await db.prepare(
      `INSERT INTO account_servers (account_id, server_id, position, added_at, view_stamp, view_until) VALUES (?1, ?2, ${END}, ?3, ?4, ?5)
       ON CONFLICT(account_id, server_id) DO NOTHING`
    ).bind(accountId, serverId, now(), view?.stamp ?? null, view?.until ?? null).run();
    return true;
  }
  // a later join (a new cookie, or after a new password) is remembered, on the list or not
  if (view && (row.view_stamp !== view.stamp || row.view_until !== view.until)) {
    await db.prepare('UPDATE account_servers SET view_stamp = ?, view_until = ? WHERE account_id = ? AND server_id = ?')
      .bind(view.stamp, view.until, accountId, serverId).run();
  }
  return row.removed_at == null;
}

// "Add to my servers": on the list, at the end if it wasn't on it already. { ok } or { error }.
export async function saveServer(env, accountId, serverId, view = null) {
  const db = env.DIRECTORY;
  const had = await db.prepare('SELECT removed_at FROM account_servers WHERE account_id = ? AND server_id = ?').bind(accountId, serverId).first();
  if (had && had.removed_at == null) return { ok: true };
  if ((await listedCount(env, accountId)) >= MAX_LISTED) return { error: `Your list can have up to ${MAX_LISTED} servers. Remove one first.` };
  await db.prepare(
    `INSERT INTO account_servers (account_id, server_id, position, added_at, view_stamp, view_until) VALUES (?1, ?2, ${END}, ?3, ?4, ?5)
     ON CONFLICT(account_id, server_id) DO UPDATE SET position = excluded.position, added_at = excluded.added_at, removed_at = NULL,
       view_stamp = COALESCE(excluded.view_stamp, view_stamp), view_until = COALESCE(excluded.view_until, view_until)`
  ).bind(accountId, serverId, now(), view?.stamp ?? null, view?.until ?? null).run();
  return { ok: true };
}

// Off the list. The row stays (removed_at), so opening the server again doesn't put it back.
export async function unsaveServer(env, accountId, serverId) {
  await env.DIRECTORY.prepare('UPDATE account_servers SET removed_at = ? WHERE account_id = ? AND server_id = ? AND removed_at IS NULL')
    .bind(now(), accountId, serverId).run();
}

// The account's list, in order: what /servers draws.
async function listed(env, account) {
  const { results } = await env.DIRECTORY.prepare(
    `SELECT s.id, s.slug, s.name, s.join_hash, s.owner_email, w.step, a.view_stamp, a.view_until
     FROM account_servers a JOIN servers s ON s.id = a.server_id LEFT JOIN wizard w ON w.server_id = s.id
     WHERE a.account_id = ? AND a.removed_at IS NULL ORDER BY a.position, a.added_at, s.id LIMIT ?`
  ).bind(account.id, MAX_LISTED).all();
  const t = now();
  // every server is asked at once; one that doesn't answer is shown without its details rather than holding up the rest
  const cards = await Promise.all(results.map((r) => tenantStub(env, r.id)
    .card({ email: account.email, viewer: !!r.view_stamp && r.view_stamp === passwordStamp(r) && r.view_until > t })
    .catch((err) => { console.error(`my servers: ${r.slug}:`, err.message); return null; })));
  return results.map((r, i) => {
    const c = cards[i];
    const base = { slug: r.slug, name: r.name, owner: r.owner_email === account.email, step: r.owner_email === account.email ? (r.step ?? 7) : null };
    if (!c) return { ...base, access: null };
    const players = c.access ? c.players || [] : [];
    return {
      ...base,
      role: c.role, super: c.super, viewer: c.viewer, public: c.public, access: c.access,
      ...(c.access ? { status: c.status, online: c.online, max: c.max, players: players.slice(0, NAMED), more: Math.max(0, c.online - Math.min(players.length, NAMED)) } : {}),
    };
  });
}

// Under /api/site/mine (src/site.js has checked the body and that an account is signed in). b: the POST's body.
export async function handleMine(request, env, path, account, b) {
  if (path === '/mine') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return json({ servers: await listed(env, account), max: MAX_LISTED });
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  if (path === '/mine/order') {
    const want = Array.isArray(b.servers) ? b.servers.filter((s) => typeof s === 'string').slice(0, MAX_LISTED * 2) : null;
    if (!want) return json({ error: 'expected { servers: [slug, ...] }' }, 400);
    const { results } = await env.DIRECTORY.prepare(
      `SELECT a.server_id, s.slug FROM account_servers a JOIN servers s ON s.id = a.server_id
       WHERE a.account_id = ? AND a.removed_at IS NULL ORDER BY a.position, a.added_at, s.id`
    ).bind(account.id).all();
    const bySlug = new Map(results.map((r) => [r.slug, r.server_id]));
    // the ones named, in that order, then any it didn't name (added in another tab, say) as they were
    const order = [...new Set(want.map((s) => bySlug.get(s)).filter(Boolean))];
    for (const r of results) if (!order.includes(r.server_id)) order.push(r.server_id);
    if (order.length) {
      await env.DIRECTORY.batch(order.map((id, i) => env.DIRECTORY.prepare(
        'UPDATE account_servers SET position = ? WHERE account_id = ? AND server_id = ?'
      ).bind(i + 1, account.id, id)));
    }
    return json({ ok: true });
  }

  if (path === '/mine/remove') {
    const slug = typeof b.server === 'string' ? b.server : '';
    const row = await env.DIRECTORY.prepare('SELECT id FROM servers WHERE slug = ?').bind(slug).first();
    if (row) await unsaveServer(env, account.id, row.id);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}
