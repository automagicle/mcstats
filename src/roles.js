// Who may do what on one server's dashboard. Everything here is that server's: its user_perms table lives in
// its own database, so being someone on one server means nothing on another.
//
// A member is a row in user_perms: an email with a role and five permissions, each on or off:
//   view         see the dashboard at all
//   chat         send chat and whispers from it (the email still has to be on the roster to have a name)
//   admin        the admin page: settings and analytics
//   liveview     watch through Liveview
//   liveview_op  Liveview's controls: commands and item moves
// For Liveview these are only the dashboard's half. The Minecraft server keeps its own list of accounts
// it lets in (src/liveview.js), and an account needs both.
//
// Roles are where the permissions start from:
//   owner   everything, and the Roles tab (who's a member, and with what). Made with the server (/new).
//   admin   everything but Roles.
//   member  look and chat. Anyone who can see the server (its password, or it's public) becomes one by
//           choosing to use their mcstats account on it (src/tenant.js, /api/auth/enter).
// Owners can switch single permissions on or off for anyone but an owner, and remove members.
//
// Super admins (the SUPER_ADMIN_EMAIL secret) run the site: signed in to that account, they can do
// everything there, owners' things included, and can't be locked out.
//
//   GET  /api/admin/roles   everyone known to this server, with their role and permissions
//   POST /api/admin/roles   { email, role }                    add or change a member (role sets the permissions)
//                           { email, perms: { view, ... } }    set one member's permissions
//                           { email, reset: true }             back to their role's permissions
//                           { email, remove: true }            no longer a member
import { currentSeason } from './seasons.js';
import { json } from './util.js';

export const PERMS = ['view', 'chat', 'admin', 'liveview', 'liveview_op'];
export const ROLES = ['owner', 'admin', 'member'];
const EMAIL_RE = /^[^\s@"'<>]{1,64}@[^\s@"'<>]{1,180}$/;
const CACHE_MS = 30_000;
// (server id, email) -> { at, perms } for this isolate; a change made here clears its entry. Keyed by the
// server too: one isolate can run several servers' objects.
const cache = new Map();

const list = (v) => String(v || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
export const isSuper = (env, who) => !!who?.email && list(env.SUPER_ADMIN_EMAIL).includes(who.email.toLowerCase());

const ALL = Object.fromEntries(PERMS.map((p) => [p, true]));
export const PRESETS = {
  owner: { ...ALL },
  admin: { ...ALL },
  member: { view: true, chat: true, admin: false, liveview: false, liveview_op: false },
};
const LOOK = { view: true, chat: false, admin: false, liveview: false, liveview_op: false };
const fromRow = (row) => Object.fromEntries(PERMS.map((p) => [p, !!row[p]]));
const cacheKey = (env, email) => `${env.TENANT?.id || ''}\u0000${email}`;

// { view, chat, admin, liveview, liveview_op, role, owner, super } for someone on this server. Without an
// email (they can only look), or with one that isn't a member: look and nothing else.
export async function loadPerms(env, who) {
  const email = who?.email?.toLowerCase();
  if (!email) return { ...LOOK, role: null, owner: false, super: false };
  if (isSuper(env, who)) return { ...ALL, role: 'owner', owner: true, super: true };
  const key = cacheKey(env, email);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.perms;
  let perms = { ...LOOK, role: null };
  try {
    const row = await env.DB.prepare(`SELECT role, ${PERMS.join(', ')} FROM user_perms WHERE email = ?`).bind(email).first();
    if (row) perms = { ...fromRow(row), role: ROLES.includes(row.role) ? row.role : 'member' };
  } catch (err) {
    console.error('permissions:', err.message);
  }
  perms = { ...perms, owner: perms.role === 'owner', super: false };
  cache.set(key, { at: Date.now(), perms });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return perms;
}

export const forgetPerms = (env, email) => cache.delete(cacheKey(env, email));

// Adds a member, or changes their role (their permissions become the role's).
export function setRoleStmt(db, email, role, by) {
  const p = PRESETS[role];
  return db.prepare(
    `INSERT INTO user_perms (email, role, view, chat, admin, liveview, liveview_op, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(email) DO UPDATE SET role = excluded.role, view = excluded.view, chat = excluded.chat, admin = excluded.admin,
       liveview = excluded.liveview, liveview_op = excluded.liveview_op, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(email, role, ...PERMS.map((k) => (p[k] ? 1 : 0)), Math.floor(Date.now() / 1000), by ?? null);
}

// GET /api/admin/roles: { users: [{ email, name, role, super, custom, perms, server, seen }], linked }
//   role    'owner' | 'admin' | 'member', or null: known here (on the roster, or visited) but not a member
//   custom  their permissions differ from their role's
//   server  what the Minecraft server lets the account do in Liveview: 'viewer', 'control' or null
//   seen    when they last had the dashboard open (unix seconds), or null
async function rolesState(env, serverAccess) {
  const db = env.DB;
  const [rows, roster, visits] = await db.batch([
    db.prepare(`SELECT email, role, ${PERMS.join(', ')} FROM user_perms`),
    db.prepare('SELECT email, ign FROM roster_email WHERE season = ?').bind(currentSeason(env)),
    db.prepare('SELECT visitor, MAX(last_ts) AS seen FROM site_visits GROUP BY visitor'),
  ]);
  const users = new Map();
  const user = (email) => {
    const e = String(email).toLowerCase();
    if (!users.has(e)) users.set(e, { email: e, name: null, role: null, super: false, custom: false, perms: { ...LOOK }, server: null, seen: null });
    return users.get(e);
  };
  for (const r of roster.results) user(r.email).name = r.ign === '@admin' ? 'Admin (chat)' : r.ign;
  for (const r of visits.results) if (EMAIL_RE.test(r.visitor)) user(r.visitor).seen = r.seen;
  for (const [e, level] of Object.entries(serverAccess?.access || {})) user(e).server = level;
  for (const r of rows.results) {
    const u = user(r.email);
    const role = ROLES.includes(r.role) ? r.role : 'member';
    const perms = fromRow(r);
    Object.assign(u, { role, perms, custom: PERMS.some((k) => perms[k] !== PRESETS[role][k]) });
  }
  // site operators are only listed once they've been here
  for (const e of list(env.SUPER_ADMIN_EMAIL)) if (users.has(e)) Object.assign(users.get(e), { super: true, perms: { ...ALL } });
  const order = { owner: 0, admin: 1, member: 2 };
  return json({
    users: [...users.values()].sort((a, b) => ((order[a.role] ?? 3) - (order[b.role] ?? 3)) || a.email.localeCompare(b.email)),
    linked: !!serverAccess?.linked,
    roles: ROLES,
  });
}

// Everything under /api/admin/roles. Owners and super admins only.
export async function handleRoles(request, env, url, who, serverAccess) {
  if (!(who.perms?.owner || who.perms?.super)) return json({ error: 'forbidden' }, 403);
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
  const db = env.DB;
  const current = await db.prepare('SELECT role FROM user_perms WHERE email = ?').bind(email).first();
  // An owner stays an owner: only a super admin can change or remove one, and nobody is made one here.
  if (current?.role === 'owner' && !who.perms.super) return json({ error: 'An owner’s access can’t be changed here.' }, 400);
  const now = Math.floor(Date.now() / 1000);
  if (b.remove === true) {
    if (current?.role === 'owner') {
      const owners = await db.prepare("SELECT COUNT(*) AS n FROM user_perms WHERE role = 'owner'").first();
      if ((owners?.n ?? 0) <= 1) return json({ error: 'A server needs an owner.' }, 400);
    }
    await db.prepare('DELETE FROM user_perms WHERE email = ?').bind(email).run();
  } else if (typeof b.role === 'string') {
    if (b.role !== 'admin' && b.role !== 'member') return json({ error: 'The role is admin or member.' }, 400);
    await setRoleStmt(db, email, b.role, who.email).run();
  } else if (b.reset === true) {
    if (!current) return json({ error: 'Not a member.' }, 400);
    await setRoleStmt(db, email, current.role, who.email).run();
  } else {
    const p = b.perms;
    if (!p || typeof p !== 'object' || !PERMS.every((k) => typeof p[k] === 'boolean')) return json({ error: 'expected { email, perms }' }, 400);
    await db.prepare(
      `INSERT INTO user_perms (email, role, view, chat, admin, liveview, liveview_op, updated_at, updated_by) VALUES (?1, 'member', ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(email) DO UPDATE SET view = excluded.view, chat = excluded.chat, admin = excluded.admin, liveview = excluded.liveview,
         liveview_op = excluded.liveview_op, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(email, ...PERMS.map((k) => (p[k] ? 1 : 0)), now, who.email).run();
  }
  console.log(`roles: ${who.email} changed ${email} on ${env.TENANT?.slug ?? 'this server'}`);
  forgetPerms(env, email);
  return rolesState(env, await serverAccess());
}
