// Cookies, join passwords, mod keys and emailed codes.
//
//   __Host-mcs  Path=/          The account session (src/account.js): a random token, nothing else. The
//               directory keeps its SHA-256 and which account it is; deleting that row signs the browser out.
//               "__Host-" makes browsers refuse it unless it's Secure, for this exact host, and Path=/.
//   mcs_view    Path=/s/<slug>/ { k: 'view', s: server id, p: a piece of the join password's hash, x: expiry }
//               Lets someone look at one server. A signed token: base64url(JSON payload) "." base64url(HMAC-SHA256),
//               with a key derived from SESSION_SECRET *and the server's id*, so a token made for server A
//               doesn't verify for server B. Changing the join password changes p, which ends every one of them.
//
// Both are HttpOnly, Secure, SameSite=Lax. The cookies from before accounts (mcs_id, mcs_site) aren't read
// any more: everyone who was signed in with one is signed out.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

export async function sha256Hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

// Constant-time comparison of two strings (hashing first makes them the same length).
export async function sameString(a, b) {
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export const sessionReady = (env) => typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.length >= 32;

const keys = new Map(); // purpose -> CryptoKey, per isolate
async function hmacKey(env, purpose) {
  const cacheKey = `${purpose}\u0000${env.SESSION_SECRET}`;
  if (keys.has(cacheKey)) return keys.get(cacheKey);
  const root = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', root, enc.encode(`mcstats:${purpose}`));
  const key = await crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  keys.set(cacheKey, key);
  if (keys.size > 1000) keys.delete(keys.keys().next().value);
  return key;
}

// HMAC-SHA256 of `bytes` with a key derived from SESSION_SECRET for one purpose (src/password.js's pepper).
export async function keyed(env, purpose, bytes) {
  if (!sessionReady(env)) throw new Error('SESSION_SECRET is not set');
  return crypto.subtle.sign('HMAC', await hmacKey(env, purpose), bytes);
}

const purposeOf = (p) => (p.k === 'site' ? 'site' : `${p.k}:${p.s}`);

export async function signToken(env, payload) {
  if (!sessionReady(env)) throw new Error('SESSION_SECRET is not set');
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env, purposeOf(payload)), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

// The payload if the token is genuine, unexpired and of kind `k` (for server `s`, unless it's a site token).
export async function verifyToken(env, token, k, s) {
  if (!sessionReady(env) || typeof token !== 'string' || token.length > 2048) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  try {
    const want = k === 'site' ? { k } : { k, s };
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env, purposeOf(want)), unb64url(token.slice(dot + 1)), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(dec.decode(unb64url(body)));
    if (p.k !== k || (k !== 'site' && p.s !== s) || !(p.x > Date.now() / 1000)) return null;
    return p;
  } catch {
    return null;
  }
}

export function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    // the browser sends the most specific path first; keep that one
    if (!(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

export function cookie(name, value, { path, maxAge }) {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
export const clearCookie = (name, path) => cookie(name, '', { path, maxAge: 0 });

export const DAY = 86400;
export const VIEW_DAYS = 30;
export const SESSION_DAYS = 30;
export const SESSION_COOKIE = '__Host-mcs';
export const serverPath = (slug) => `/s/${slug}/`;

// ---- join passwords ----

// The most PBKDF2 iterations the Workers runtime allows (it refuses more than 100,000).
export const PBKDF2_ITERATIONS = 100_000;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return { join_salt: b64url(salt), join_hash: b64url(bits), join_iter: PBKDF2_ITERATIONS };
}

// A made-up server's hash, so checking a password for a server that doesn't exist takes as long as for one that does.
const DUMMY = { join_salt: 'AAAAAAAAAAAAAAAAAAAAAA', join_hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', join_iter: PBKDF2_ITERATIONS };

export async function checkPassword(password, row) {
  const r = row?.join_hash ? row : DUMMY;
  const bits = await pbkdf2(String(password).slice(0, MAX_PASSWORD), unb64url(r.join_salt), r.join_iter || PBKDF2_ITERATIONS);
  const ok = crypto.subtle.timingSafeEqual(bits, unb64url(r.join_hash).buffer);
  return ok && r !== DUMMY;
}

// What a viewer cookie carries of the password's hash (so a new password ends old viewer sessions).
export const passwordStamp = (row) => String(row?.join_hash || '').slice(0, 12);

// ---- mod keys: mcs_<server id>_<secret> ----

export const KEY_RE = /^mcs_([0-9a-f]{16})_[A-Za-z0-9_-]{43}$/;
export function newApiKey(serverId) {
  return `mcs_${serverId}_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}
export const keyServer = (token) => KEY_RE.exec(token || '')?.[1] ?? null;

// ---- emailed codes (they prove an email address: src/account.js) ----

export const CODE_MINUTES = 10;
export const CODE_TRIES = 5;
export function newCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, '0');
}
// Account codes are 8 digits: with five tries a code and five codes an hour, guessing one is out of reach.
export const ACCOUNT_CODE_RE = /^\d{8}$/;
export function newAccountCode() {
  const buf = new Uint32Array(1);
  // every code equally likely: values past the last whole multiple of 10^8 are drawn again
  do crypto.getRandomValues(buf); while (buf[0] >= 4_200_000_000);
  return String(buf[0] % 100_000_000).padStart(8, '0');
}
export const codeHash = (scope, email, code) => sha256Hex(`${scope}\u0000${email}\u0000${code}`);

export const EMAIL_RE = /^[^\s@"'<>,;]{1,64}@[^\s@"'<>,;]{1,180}\.[^\s@"'<>,;]{2,}$/;
export const cleanEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
