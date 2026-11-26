// The directory (the DIRECTORY database): finds a server's object from its slug (web pages) or id (the
// mod's key). It holds no stats. See directory-migrations/0001_directory.sql.
import { randomHex } from './session.js';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
export const ID_RE = /^[0-9a-f]{16}$/;
// The site's own top-level paths (public/ and /api): a request for one of these is never a server's.
// Anything added to public/ without a dot in its address belongs here too.
export const SITE_PATHS = new Set(['api', 'new', 'join', 'account', 'servers', 'mod', 'stats', 'downloads', 'addons', 'index', 's']);
// Words a server can't be called. Servers live at the top of the site (/<server>), so this is every page the
// site has, the ones it may well grow, and names that would mislead. A server made before a word was added
// here keeps working until the site really uses that address (only SITE_PATHS are routed away from servers).
export const RESERVED = new Set([
  ...SITE_PATHS,
  // signing in and accounts
  'auth', 'login', 'logout', 'signin', 'signout', 'signup', 'register', 'sso', 'oauth', 'callback', 'verify', 'confirm',
  'password', 'reset', 'recover', 'me', 'my', 'profile', 'user', 'users', 'member', 'members', 'settings', 'preferences',
  'notifications', 'inbox', 'messages', 'billing', 'payment', 'payments', 'checkout', 'subscribe', 'unsubscribe',
  'pricing', 'plans', 'premium', 'pro', 'upgrade', 'donate', 'sponsor', 'store', 'shop',
  // the site's own pages, now or later
  'home', 'index', 'app', 'apps', 'dashboard', 'server', 'create', 'edit', 'delete', 'remove', 'setup', 'onboarding',
  'welcome', 'start', 'invite', 'invites', 'link', 'links', 'go', 'open', 'share', 'embed', 'widget', 'widgets', 'badge',
  'explore', 'discover', 'browse', 'search', 'find', 'list', 'directory', 'top', 'popular', 'trending', 'featured', 'public', 'private',
  'player', 'players', 'team', 'teams', 'season', 'seasons', 'leaderboard', 'leaderboards', 'activity', 'combat', 'chat',
  'chatlog', 'liveview', 'live', 'map', 'maps', 'analytics', 'roles', 'layout',
  'mods', 'plugin', 'plugins', 'addon', 'download', 'install', 'update', 'updates', 'release', 'releases', 'changelog', 'version', 'versions',
  'help', 'support', 'contact', 'feedback', 'faq', 'docs', 'doc', 'documentation', 'guide', 'guides', 'wiki', 'learn', 'tutorial', 'tutorials',
  'about', 'blog', 'news', 'press', 'jobs', 'careers', 'company', 'community', 'forum', 'forums', 'discord', 'status', 'roadmap',
  'legal', 'terms', 'tos', 'privacy', 'cookies', 'security', 'abuse', 'report', 'dmca', 'copyright', 'license', 'rules', 'guidelines',
  // how the site is built and run
  'www', 'web', 'site', 'static', 'assets', 'asset', 'public-assets', 'cdn', 'media', 'img', 'image', 'images', 'icon', 'icons', 'fonts', 'font',
  'css', 'js', 'script', 'scripts', 'style', 'styles', 'files', 'file', 'upload', 'uploads', 'data', 'export', 'import', 'backup',
  'admin', 'administrator', 'ops', 'operator', 'staff', 'mod-tools', 'moderator', 'internal', 'system', 'debug', 'dev', 'test', 'testing',
  'staging', 'beta', 'alpha', 'demo', 'example', 'sample', 'preview', 'health', 'healthz', 'ping', 'metrics', 'graphql', 'rest', 'rpc',
  'webhook', 'webhooks', 'hook', 'hooks', 'ws', 'socket', 'ingest', 'feed', 'rss', 'atom', 'sitemap', 'robots', 'favicon', 'manifest',
  'well-known', 'error', 'errors', 'not-found', '404', '500', 'offline', 'maintenance',
  // names that would mislead
  'mcstats', 'mcstats-live', 'official', 'minecraft', 'mojang', 'microsoft', 'root', 'null', 'undefined', 'true', 'false', 'none', 'nan',
  'anonymous', 'everyone', 'nobody', 'unknown', 'default', 'new-server',
]);
// /s1 … /s99 were the season archives before servers had their own addresses, and still lead to the first server's.
const OLD_SEASON_RE = /^s\d+$/;

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s_-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
}

export function slugProblem(slug) {
  if (!SLUG_RE.test(slug)) return 'The address is 3 to 32 lowercase letters, digits and dashes, and starts and ends with a letter or digit.';
  if (RESERVED.has(slug) || OLD_SEASON_RE.test(slug)) return 'That address is reserved. Pick another.';
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
