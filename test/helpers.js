// Making servers, keys and cookies the way the site does, for the tests.
import { env, SELF } from 'cloudflare:test';
import { b64url, sha256Hex } from '../src/session.js';

export const ORIGIN = 'https://mcstats.test';
const now = () => Math.floor(Date.now() / 1000);

// The cookie of a signed-in mcstats account with that email (made if there isn't one), as signing in gives it.
export async function accountCookie(email) {
  await env.DIRECTORY.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING')
    .bind(b64url(crypto.getRandomValues(new Uint8Array(12))), email, now()).run();
  const account = await env.DIRECTORY.prepare('SELECT id FROM accounts WHERE email = ?').bind(email).first();
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DIRECTORY.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), account.id, now(), now() + 3600).run();
  return `__Host-mcs=${token}`;
}
export const siteCookie = accountCookie;

export function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const h = { Origin: ORIGIN, ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  return SELF.fetch(`${ORIGIN}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
}

export async function makeServer(slug, { owner = `owner-${slug}@example.org`, password = `pw-${slug}-secret` } = {}) {
  const cookie = await siteCookie(owner);
  const res = await call('/api/site/servers', { method: 'POST', cookie, body: { name: `Server ${slug}`, slug, password, confirm: password } });
  if (res.status !== 200) throw new Error(`makeServer ${slug}: ${res.status} ${await res.text()}`);
  const row = await env.DIRECTORY.prepare('SELECT id FROM servers WHERE slug = ?').bind(slug).first();
  return { slug, owner, password, id: row.id, cookie };
}

export async function newKey(server) {
  const res = await call(`/api/site/servers/${server.slug}/key`, { method: 'POST', cookie: server.cookie, body: {} });
  if (res.status !== 200) throw new Error(`newKey: ${res.status} ${await res.text()}`);
  return (await res.json()).key;
}

// The cookie part of a Set-Cookie header (name=value).
export const cookieOf = (res, name) => res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));

export async function viewerCookie(server) {
  const res = await call('/api/site/join', { method: 'POST', body: { server: server.slug, password: server.password } });
  if (res.status !== 200) throw new Error(`join: ${res.status}`);
  return cookieOf(res, 'mcs_view');
}

// Signed in is site-wide now: the same account cookie on any server.
export const idCookie = (_server, email) => accountCookie(email);

let n = 0;
export function chatEvent(text, extra = {}) {
  n += 1;
  return { id: `t${Date.now()}-${n}`, ts: Date.now(), kind: 'chat', name: 'Steve', uuid: '00000000-0000-4000-8000-000000000001', text, ...extra };
}

export function upload(token, events, { path = '/api/ingest/chat', query = '', body } = {}) {
  return SELF.fetch(`${ORIGIN}${path}${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? { events }),
  });
}

export async function chatTexts(server, cookie) {
  const res = await call(`/s/${server.slug}/api/chat`, { cookie });
  if (res.status !== 200) return { status: res.status, texts: null };
  return { status: 200, texts: (await res.json()).messages?.map((m) => m.text) ?? [] };
}
