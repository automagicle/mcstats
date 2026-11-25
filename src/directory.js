// The directory (the DIRECTORY database): finds a server's object from its slug (web pages) or id (the
// mod's key). It holds no stats. See directory-migrations/0001_directory.sql.
import { randomHex } from './session.js';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
export const ID_RE = /^[0-9a-f]{16}$/;
// Words a server can't be called: the site's own paths, and names that would mislead.
export const RESERVED = new Set([
  'admin', 'api', 'www', 'new', 'join', 's', 'static', 'assets', 'stats', 'app', 'auth', 'login', 'logout',
  'signin', 'signup', 'site', 'ops', 'mcstats', 'help', 'support', 'about', 'settings', 'root', 'null', 'undefined',
]);

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s_-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
}

export function slugProblem(slug) {
  if (!SLUG_RE.test(slug)) return 'The address is 3 to 32 lowercase letters, digits and dashes, and starts and ends with a letter or digit.';
  if (RESERVED.has(slug)) return 'That address is reserved. Pick another.';
  return null;
}

export const newServerId = () => randomHex(8);

// slug -> { at, row } for a few seconds, per isolate: every API call on a page looks its server up.
const CACHE_MS = 5_000;
const cache = new Map();
export const forgetSlug = (slug) => cache.delete(slug);

const COLS = 'id, slug, name, join_salt, join_hash, join_iter, has_password, owner_email, created_at';

export async function serverBySlug(env, slug, { fresh = false } = {}) {
  if (!SLUG_RE.test(slug || '')) return null;
  const hit = cache.get(slug);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.row;
  const row = await env.DIRECTORY.prepare(`SELECT ${COLS} FROM servers WHERE slug = ?`).bind(slug).first();
  cache.set(slug, { at: Date.now(), row: row ?? null });
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  return row ?? null;
}

export async function serverById(env, id) {
  if (!ID_RE.test(id || '')) return null;
  return (await env.DIRECTORY.prepare(`SELECT ${COLS} FROM servers WHERE id = ?`).bind(id).first()) ?? null;
}

export async function serversOwnedBy(env, email) {
  const { results } = await env.DIRECTORY.prepare(
    `SELECT s.id, s.slug, s.name, s.created_at, w.step FROM servers s LEFT JOIN wizard w ON w.server_id = s.id
     WHERE s.owner_email = ? ORDER BY s.created_at`
  ).bind(email).all();
  return results;
}
