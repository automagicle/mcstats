// Admin → Server: the server's own details, changed from its dashboard.
//
//   GET  /api/admin/server   { name, slug, public, has_password, accent, tab_style, addons, mod, can, … }
//   POST /api/admin/server   any of { name, accent, tab_style }                 admins
//                            and { slug, public, password + confirm }           owners
//                            and { addons: [ids] }                              the site's operators
//
// It runs inside the server's Tenant object (src/tenant.js hands it over before the rest of the API), because
// what it changes lives in two places: the server's settings (in the object) and its row in the directory
// (name, address, join password).
//
// A new address moves the server: /s/<old>/ stops existing and cookies made for it no longer apply (they're
// Path=/s/<old>/), so everyone joins again at the new one. Whoever changed it gets cookies for the new address
// with the answer. A new password ends every viewer session made with the old one; the same goes for them.
import { json } from './util.js';
import { loadPerms } from './roles.js';
import { forgetSlug, serverById, slugProblem } from './directory.js';
import {
  clearCookie, cookie, DAY, hashPassword, MAX_PASSWORD, MIN_PASSWORD, passwordStamp, serverPath, signToken, VIEW_DAYS,
} from './session.js';
import { limit, tooMany } from './limiter.js';
import { ADDONS, addonList } from './addons.js';
import { lookOf } from './look.js';
import { MOD } from './modinfo.gen.js';

// Why the address can't be changed, or null. The old shared mod token finds the first server by its address
// (LEGACY_SLUG), so that server stays put until it has a key of its own and the shared token is gone.
const slugLock = (t) => (t.settings.LEGACY === '1' && (t.env.CHAT_INGEST_TOKEN || '').length >= 32
  ? 'This server still takes the old shared mod token, which finds it by this address. Give it its own key on /new and delete the CHAT_INGEST_TOKEN secret first.'
  : null);

function state(t, row, perms) {
  const look = lookOf(t.settings);
  return {
    name: row.name,
    slug: row.slug,
    public: t.settings.PUBLIC === '1',
    has_password: row.has_password !== 0,
    accent: look.accent,
    tab_style: look.tabs,
    addons: addonList(t.settings),
    // what this sign-in may change: everyone here is an admin; owner adds the address, password and visibility
    can: { owner: !!(perms.owner || perms.super), super: !!perms.super },
    slug_locked: slugLock(t),
    // the mod this site offers (src/modinfo.gen.js, read from mod/): for the Mod card's download
    mod: { version: MOD.version, jar: MOD.jar, jar_url: `/downloads/${MOD.jar}`, minecraft: MOD.minecraft_built },
    ...(perms.super && { known_addons: Object.entries(ADDONS).map(([id, a]) => ({ id, name: a.name, about: a.about })) }),
  };
}

export async function handleServerAdmin(t, request, url, who) {
  const env = t.serverEnv();
  const perms = await loadPerms(env, who);
  if (!who.email || !perms.admin) return json({ error: 'forbidden' }, 403);
  let row = await serverById(t.env, t.id);
  if (!row) return json({ error: 'not found' }, 404);
  if (request.method === 'GET') return json(state(t, row, perms));
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);
  let b;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'too large' }, 413);
    b = JSON.parse(raw);
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  if (!b || typeof b !== 'object') return json({ error: 'bad json' }, 400);
  const bad = (error, field) => json({ error, field }, 400);
  const owner = perms.owner || perms.super;
  const has = (k) => b[k] !== undefined && b[k] !== null;

  // ---- check everything first, so a refused change leaves nothing half done ----
  const patch = {};
  if (has('name')) {
    const name = String(b.name).trim().replace(/\s+/g, ' ');
    if (!name || name.length > 60) return bad('The name is 1 to 60 characters.', 'name');
    if (name !== row.name) patch.NAME = name;
  }
  if (has('accent')) patch.ACCENT = String(b.accent);
  if (has('tab_style')) patch.TAB_STYLE = String(b.tab_style);

  const ownerOnly = ['slug', 'public', 'password'].filter((k) => has(k) && b[k] !== '');
  if (ownerOnly.length && !owner) return json({ error: 'Only the server’s owner can change its address, password or who can see it.' }, 403);
  if (has('addons') && !perms.super) return json({ error: 'forbidden' }, 403);

  const password = typeof b.password === 'string' ? b.password : '';
  if (password) {
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return bad(`The password is ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`, 'password');
    if (password !== b.confirm) return bad('The two passwords aren’t the same.', 'confirm');
  }
  if (has('public')) {
    const pub = b.public === true || b.public === '1';
    // a server can only be made private once it has a password to join with
    if (!pub && row.has_password === 0 && !password) return bad('Set a join password to make it private, so players can still get in.', 'password');
    if (pub !== (t.settings.PUBLIC === '1')) patch.PUBLIC = pub ? '1' : '';
  }
  let slug = null;
  if (has('slug') && String(b.slug).trim().toLowerCase() !== row.slug) {
    slug = String(b.slug).trim().toLowerCase();
    const locked = slugLock(t);
    if (locked) return bad(locked, 'slug');
    const problem = slugProblem(slug);
    if (problem) return bad(problem, 'slug');
    if (await t.env.DIRECTORY.prepare('SELECT 1 FROM servers WHERE slug = ?').bind(slug).first()) return json({ error: 'That address is taken. Pick another.', field: 'slug' }, 409);
    const lim = await limit(t.env, [[`move:${t.id}`, 5, 86400]]);
    if (!lim.ok) return tooMany(lim.retry);
  }
  if (has('addons') && (!Array.isArray(b.addons) || b.addons.some((id) => !ADDONS[id]))) return bad('unknown add-on');

  // ---- then change it ----
  if (Object.keys(patch).length) {
    const out = await t.updateSettings(patch);
    if (out.error) return bad(out.error, patch.ACCENT !== undefined && /accent/i.test(out.error) ? 'accent' : undefined);
  }
  if (has('addons')) await t.setAddons(b.addons);
  const sets = [];
  if (patch.NAME) sets.push(t.env.DIRECTORY.prepare('UPDATE servers SET name = ? WHERE id = ?').bind(patch.NAME, t.id));
  if (password) {
    const h = await hashPassword(password);
    sets.push(t.env.DIRECTORY.prepare('UPDATE servers SET join_salt = ?, join_hash = ?, join_iter = ?, has_password = 1 WHERE id = ?').bind(h.join_salt, h.join_hash, h.join_iter, t.id));
  }
  const cookies = [];
  if (slug) {
    try {
      await t.env.DIRECTORY.batch([...sets.splice(0), t.env.DIRECTORY.prepare('UPDATE servers SET slug = ? WHERE id = ?').bind(slug, t.id)]);
    } catch (err) {
      if (/UNIQUE/i.test(String(err?.message))) return json({ error: 'That address is taken. Pick another.', field: 'slug' }, 409);
      throw err;
    }
    t.put('SLUG', slug);
    t.load();
    forgetSlug(slug);
    cookies.push(clearCookie('mcs_view', serverPath(row.slug)));
    console.log(`server: ${who.email} moved ${row.slug} to ${slug}`);
  }
  if (sets.length) await t.env.DIRECTORY.batch(sets);
  forgetSlug(row.slug);
  if (password) console.log(`server: ${who.email} set a new join password for ${slug || row.slug}`);

  row = await serverById(t.env, t.id);
  if (slug || password) {
    // the old cookies stopped applying (another path, or the old password's stamp): new ones for whoever did this
    const now = Math.floor(Date.now() / 1000);
    const path = serverPath(row.slug);
    cookies.push(cookie('mcs_view', await signToken(t.env, { k: 'view', s: t.id, p: passwordStamp(row), x: now + VIEW_DAYS * DAY }), { path, maxAge: VIEW_DAYS * DAY }));
  }
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify({ ...state(t, row, perms), ...(slug && { moved: serverPath(row.slug) }) }), { headers });
}
