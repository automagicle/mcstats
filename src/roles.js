// Who may do what on the dashboard.
//
// Five permissions, each on or off for each sign-in (a Cloudflare Access email), independently:
//   view         see the dashboard at all (every /api/ request but /api/me)
//   chat         send chat and whispers from it (the email still has to be on the roster to have a name)
//   admin        the admin page: settings and analytics
//   liveview     watch through Liveview
//   liveview_op  Liveview's controls: commands and item moves
// For Liveview these are only the dashboard's half. The Minecraft server keeps its own list of accounts
// it lets in (src/liveview.js), and an account needs both.
//
// Super admins are the emails in the SUPER_ADMIN_EMAIL secret (comma-separated). They can do everything,
// can't be locked out from the page, and are the only ones who can change anyone's permissions:
//   GET  /api/admin/roles   everyone known to the site, with their permissions
//   POST /api/admin/roles   { email, perms: { view, chat, admin, liveview, liveview_op } } or { email, reset: true }
// Someone whose permissions were never changed has the defaults: look and chat for anyone Access lets in,
// plus admin and both Liveview permissions for the ADMIN_EMAIL logins (as before this table existed).
import { CURRENT_SEASON } from './seasons.js';
import { json } from './util.js';

export const PERMS = ['view', 'chat', 'admin', 'liveview', 'liveview_op'];
const EMAIL_RE = /^[^\s@"'<>]{1,64}@[^\s@"'<>]{1,180}$/;
const CACHE_MS = 30_000;
const cache = new Map(); // email -> { at, perms } for this isolate; a change made here clears its entry

const list = (v) => String(v || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
export const isSuper = (env, who) => !!who?.email && list(env.SUPER_ADMIN_EMAIL).includes(who.email.toLowerCase());

function defaults(env, email) {
  const admin = list(env.ADMIN_EMAIL).includes(email);
  return { view: true, chat: true, admin, liveview: admin, liveview_op: admin };
}
const ALL = Object.fromEntries(PERMS.map((p) => [p, true]));
const fromRow = (row) => Object.fromEntries(PERMS.map((p) => [p, !!row[p]]));

// { view, chat, admin, liveview, liveview_op, super } for a signed-in user. Local development without
// DEV_EMAIL (no email at all) can look and nothing else.
export async function loadPerms(env, who) {
  const email = who?.email?.toLowerCase();
  if (!email) return { view: true, chat: false, admin: false, liveview: false, liveview_op: false, super: false };
  if (isSuper(env, who)) return { ...ALL, super: true };
  const hit = cache.get(email);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.perms;
  let perms = defaults(env, email);
  try {
    const row = await env.DB.prepare(`SELECT ${PERMS.join(', ')} FROM user_perms WHERE email = ?`).bind(email).first();
    if (row) perms = fromRow(row);
  } catch (err) {
    console.error('permissions:', err.message); // before the migration has run: the defaults
  }
  perms = { ...perms, super: false };
  cache.set(email, { at: Date.now(), perms });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return perms;
}

// GET /api/admin/roles: { users: [{ email, name, super, custom, perms, server, seen }], linked }
//   custom  their permissions were changed (false: the defaults)
//   server  what the Minecraft server lets the account do in Liveview: 'viewer', 'control' or null
//   seen    when they last had the dashboard open (unix seconds), or null
async function rolesState(env, serverAccess) {
  const db = env.DB;
  const [rows, roster, visits] = await db.batch([
    db.prepare(`SELECT email, ${PERMS.join(', ')} FROM user_perms`),
    db.prepare('SELECT email, ign FROM roster_email WHERE season = ?').bind(CURRENT_SEASON),
    db.prepare('SELECT visitor, MAX(last_ts) AS seen FROM site_visits GROUP BY visitor'),
  ]);
  const users = new Map();
  const user = (email) => {
    const e = String(email).toLowerCase();
    if (!users.has(e)) users.set(e, { email: e, name: null, super: false, custom: false, perms: defaults(env, e), server: null, seen: null });
    return users.get(e);
  };
  for (const e of list(env.SUPER_ADMIN_EMAIL)) Object.assign(user(e), { super: true, perms: { ...ALL } });
  for (const e of list(env.ADMIN_EMAIL)) user(e);
  for (const r of roster.results) user(r.email).name = r.ign === '@admin' ? 'Admin (chat)' : r.ign;
  for (const r of visits.results) if (EMAIL_RE.test(r.visitor)) user(r.visitor).seen = r.seen;
  for (const [e, level] of Object.entries(serverAccess?.access || {})) user(e).server = level;
  for (const r of rows.results) {
    const u = user(r.email);
    if (!u.super) Object.assign(u, { custom: true, perms: fromRow(r) });
  }
  return json({
    users: [...users.values()].sort((a, b) => (b.super - a.super) || a.email.localeCompare(b.email)),
    linked: !!serverAccess?.linked,
  });
}

// Everything under /api/admin/roles. Super admins only.
export async function handleRoles(request, env, url, who, serverAccess) {
  if (!isSuper(env, who)) return json({ error: 'forbidden' }, 403);
  if (request.method === 'GET') return rolesState(env, await serverAccess());
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);
  let b;
  try {
    const raw = await request.text();
    if (raw.length > 2048) return json({ error: 'too large' }, 413);
    b = JSON.parse(raw);
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const email = typeof b?.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) return json({ error: 'That isn’t an email address.' }, 400);
  if (list(env.SUPER_ADMIN_EMAIL).includes(email)) return json({ error: 'A super admin can always do everything.' }, 400);
  if (b.reset === true) {
    await env.DB.prepare('DELETE FROM user_perms WHERE email = ?').bind(email).run();
  } else {
    const p = b.perms;
    if (!p || typeof p !== 'object' || !PERMS.every((k) => typeof p[k] === 'boolean')) return json({ error: 'expected { email, perms }' }, 400);
    await env.DB.prepare(
      `INSERT INTO user_perms (email, view, chat, admin, liveview, liveview_op, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(email) DO UPDATE SET view = excluded.view, chat = excluded.chat, admin = excluded.admin, liveview = excluded.liveview,
         liveview_op = excluded.liveview_op, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(email, ...PERMS.map((k) => (p[k] ? 1 : 0)), Math.floor(Date.now() / 1000), who.email).run();
    console.log(`roles: ${who.email} set ${email} to ${PERMS.filter((k) => p[k]).join(', ') || 'nothing'}`);
  }
  cache.delete(email);
  return rolesState(env, await serverAccess());
}
