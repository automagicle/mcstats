// Who may do what on one server's dashboard. Everything here is that server's: its user_perms table lives in
// its own database, so being someone on one server means nothing on another.
//
// A member is a row in user_perms: an email with a role and five permissions, each on or off:
//   view         see the dashboard at all
//   chat         send chat and whispers from it, as the player Admin → Players links the email to, or as Admin
//                for someone set to on the Roles tab (chat_admin). Owners and admins with no player send as
//                Admin anyway; a member with none can't
//   admin        the admin page: settings and analytics
//   liveview     watch through Liveview
//   liveview_op  Liveview's controls: commands and item moves
// For Liveview these are only the dashboard's half. The Minecraft server keeps its own list of accounts
// it lets in (src/liveview.js), and an account needs both.
//
// Roles are where the permissions start from:
//   owner   everything. Made with the server (/new), or by another owner on the Roles tab, who types their own
//           account password to do it. Only an owner (or a super admin) makes owners, and an owner can't be
//           changed or removed by anyone but a super admin.
//   admin   everything an owner can do but make owners: the Roles tab (who's a member, and with what), the
//           server's address, password and visibility, and Admin → Discord's linking and sharing too.
//   member  look and chat. Anyone who can see the server (its password, or it's public) becomes one by
//           choosing to use their mcstats account on it (src/tenant.js, /api/auth/enter).
// Owners and admins can switch single permissions on or off for anyone but an owner, and remove members.
//
// Super admins (the SUPER_ADMIN_EMAIL secret) run the site: signed in to that account, they can do
// everything there, owners' things included, and can't be locked out.
//
//   GET  /api/admin/roles   everyone known to this server, with their role and permissions
//   POST /api/admin/roles   { email, role }                    add or change a member (role sets the permissions)
//                           { email, role: 'owner', password } make them an owner; password is the account
//                                                              password of whoever is asking
//                           { email, chat_as }                 'admin': they send chat as Admin;
//                                                              'player': as the player their email is linked to
//                           { email, perms: { view, ... } }    set one member's permissions
//                           { email, reset: true }             back to their role's permissions
//                           { email, remove: true }            no longer a member
import { connectedList } from './connect.js';
import { currentSeason } from './seasons.js';
import { json } from './util.js';
import { limit, tooMany } from './limiter.js';
import { checkAccountPassword } from './password.js';

export const PERMS = ['view', 'chat', 'admin', 'liveview', 'liveview_op'];
export const ROLES = ['owner', 'admin', 'member'];
const EMAIL_RE = /^[^\s@"'<>]{1,64}@[^\s@"'<>]{1,180}$/;
const ADMIN_IGN = '@admin'; // roster_email's stand-in IGN for someone the roster file says chats as Admin (src/link.js)
const CACHE_MS = 30_000;
// (server id, email) -> { at, perms } for this isolate; a change made here clears its entry. Keyed by the
// server too: one isolate can run several servers' objects.
const cache = new Map();

const list = (v) => String(v || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
export const isSuper = (env, who) => !!who?.email && list(env.SUPER_ADMIN_EMAIL).includes(who.email.toLowerCase());
// Whether someone runs this server: an owner or admin who still has the admin permission, or a super admin.
// They get the Roles tab and everything once only owners had (all but making owners).
export const canManage = (perms) => !!(perms?.super || (perms?.admin && (perms.role === 'owner' || perms.role === 'admin')));

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

// GET /api/admin/roles: { users: [{ email, name, role, super, custom, perms, server, seen, chat_as }], linked }
//   role    'owner' | 'admin' | 'member', or null: known here (on the roster, or visited) but not a member
//   custom  their permissions differ from their role's
//   server  what the Minecraft server lets the account do in Liveview: 'viewer', 'control' or null
//   seen    when they last had the dashboard open (unix seconds), or null
//   chat_as the player they send chat from the dashboard as, '@admin' for Admin, or null if they can't
//   player  the player their email is linked to on Admin → Players, or null
//   chat_admin  they were set to chat as Admin here (or by the roster file's "admins"), whatever player they have
async function rolesState(env, serverAccess) {
  const db = env.DB;
  const [rows, roster, visits] = await db.batch([
    db.prepare(`SELECT email, role, chat_admin, ${PERMS.join(', ')} FROM user_perms`),
    db.prepare('SELECT email, ign FROM roster_email WHERE season = ?').bind(currentSeason(env)),
    db.prepare('SELECT visitor, MAX(last_ts) AS seen FROM site_visits GROUP BY visitor'),
  ]);
  const users = new Map();
  const user = (email) => {
    const e = String(email).toLowerCase();
    if (!users.has(e)) users.set(e, { email: e, name: null, role: null, super: false, custom: false, perms: { ...LOOK }, server: null, seen: null, chat_admin: false });
    return users.get(e);
  };
  for (const r of roster.results) user(r.email).name = r.ign; // '@admin': the roster file's admins, who chat as Admin
  for (const r of visits.results) if (EMAIL_RE.test(r.visitor)) user(r.visitor).seen = r.seen;
  for (const [e, level] of Object.entries(serverAccess?.access || {})) user(e).server = level;
  for (const r of rows.results) {
    const u = user(r.email);
    const role = ROLES.includes(r.role) ? r.role : 'member';
    const perms = fromRow(r);
    Object.assign(u, { role, perms, custom: PERMS.some((k) => perms[k] !== PRESETS[role][k]), chat_admin: !!r.chat_admin });
  }
  // players who connected their account from in game (src/connect.js); Admin → Players' emails come first
  for (const r of await connectedList(db)) {
    if (r.confirmed_at && users.has(r.email.toLowerCase()) && !users.get(r.email.toLowerCase()).name) users.get(r.email.toLowerCase()).name = r.name;
  }
  // site operators are only listed once they've been here
  for (const e of list(env.SUPER_ADMIN_EMAIL)) if (users.has(e)) Object.assign(users.get(e), { super: true, perms: { ...ALL } });
  // who each one sends chat as, by the same rules as sending (src/link.js playerFor): Admin when they were
  // set to here, else their player on Admin → Players, else Admin for owners and admins; null when they can't chat
  for (const u of users.values()) {
    const staff = u.super || u.role === 'owner' || u.role === 'admin';
    if (u.name === ADMIN_IGN) u.chat_admin = true;
    u.player = u.name && u.name !== ADMIN_IGN ? u.name : null;
    u.chat_as = !u.perms.chat || !(u.role || u.super) ? null
      : u.chat_admin ? ADMIN_IGN
      : u.player || (staff ? ADMIN_IGN : null);
  }
  const order = { owner: 0, admin: 1, member: 2 };
  return json({
    users: [...users.values()].sort((a, b) => ((order[a.role] ?? 3) - (order[b.role] ?? 3)) || a.email.localeCompare(b.email)),
    linked: !!serverAccess?.linked,
    roles: ROLES,
  });
}

// Whether `password` is the account password of whoever is asking (who.email's mcstats account, in the
// directory). Making an owner asks for it again, so a dashboard left open on someone's screen can't.
async function confirmPassword(env, who, password) {
  const raw = env.RAW || env;
  if (typeof password !== 'string' || !password) return { error: 'Type your account password to confirm.', status: 400 };
  const lim = await limit(raw, [[`owner-confirm:${env.TENANT?.id || ''}:${who.email.toLowerCase()}`, 5, 600]]);
  if (!lim.ok) return { response: tooMany(lim.retry) };
  const account = await raw.DIRECTORY.prepare('SELECT pw_hash FROM accounts WHERE email = ?').bind(who.email.toLowerCase()).first();
  // checked even with no account, so the answer takes as long either way
  const { ok } = await checkAccountPassword(raw, password, account?.pw_hash);
  return ok ? { ok: true } : { error: 'That isn’t your account password.', status: 403 };
}

// Everything under /api/admin/roles. Owners, admins and super admins (canManage); making an owner is owners' only.
export async function handleRoles(request, env, url, who, serverAccess) {
  if (!canManage(who.perms)) return json({ error: 'forbidden' }, 403);
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
  // who someone chats as isn't access: it can be set for owners and super admins too
  const chatOnly = typeof b.chat_as === 'string';
  const superEmail = list(env.SUPER_ADMIN_EMAIL).includes(email);
  if (superEmail && !chatOnly) return json({ error: 'A super admin can always do everything.' }, 400);
  const db = env.DB;
  const current = await db.prepare('SELECT role FROM user_perms WHERE email = ?').bind(email).first();
  // An owner stays an owner: only a super admin can change or remove one.
  if (current?.role === 'owner' && !who.perms.super && !chatOnly) return json({ error: 'An owner’s access can’t be changed here.' }, 400);
  const now = Math.floor(Date.now() / 1000);
  if (b.remove === true) {
    if (current?.role === 'owner') {
      const owners = await db.prepare("SELECT COUNT(*) AS n FROM user_perms WHERE role = 'owner'").first();
      if ((owners?.n ?? 0) <= 1) return json({ error: 'A server needs an owner.' }, 400);
    }
    await db.prepare('DELETE FROM user_perms WHERE email = ?').bind(email).run();
  } else if (b.role === 'owner') {
    // an owner can do everything here and can't be changed back from this page: it's asked for with the
    // password of whoever is doing it
    if (!(who.perms.owner || who.perms.super)) return json({ error: 'Only an owner can make someone an owner.' }, 403);
    if (current?.role === 'owner') return json({ error: 'They’re already an owner.' }, 400);
    const sure = await confirmPassword(env, who, b.password);
    if (sure.response) return sure.response;
    if (!sure.ok) return json({ error: sure.error, field: 'password' }, sure.status);
    await setRoleStmt(db, email, 'owner', who.email).run();
    console.log(`roles: ${who.email} made ${email} an owner of ${env.TENANT?.slug ?? 'this server'}`);
  } else if (typeof b.role === 'string') {
    if (b.role !== 'admin' && b.role !== 'member') return json({ error: 'The role is owner, admin or member.' }, 400);
    await setRoleStmt(db, email, b.role, who.email).run();
  } else if (typeof b.chat_as === 'string') {
    if (b.chat_as !== 'admin' && b.chat_as !== 'player') return json({ error: 'They chat as admin or as their player.' }, 400);
    if (!current && !superEmail) return json({ error: 'Not a member.' }, 400);
    // a super admin needs no row to do everything; this choice needs somewhere to be kept
    const stmts = [];
    if (!current) stmts.push(setRoleStmt(db, email, 'member', who.email));
    stmts.push(db.prepare('UPDATE user_perms SET chat_admin = ?, updated_at = ?, updated_by = ? WHERE email = ?').bind(b.chat_as === 'admin' ? 1 : 0, now, who.email, email));
    // the roster file's way of saying the same thing (an @admin row) would keep them as Admin
    if (b.chat_as === 'player') stmts.push(db.prepare('DELETE FROM roster_email WHERE season = ? AND email = ? AND ign = ?').bind(currentSeason(env), email, ADMIN_IGN));
    await db.batch(stmts);
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
