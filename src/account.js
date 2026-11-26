// mcstats accounts: an email address and a password, signed in site-wide. Under /api/account/:
//
//   POST /api/account/code      { email, next? }            emails an 8-digit code (and a link carrying it) that
//                                                           proves the address. The answer is the same whether
//                                                           or not the address has an account.
//   POST /api/account/password  { email, code, password }   with that code: makes the account, or (if there is
//                                                           one) gives it a new password and signs it out
//                                                           everywhere else. Signs in.
//   POST /api/account/login     { email, password }         signs in
//   POST /api/account/logout                                signs this browser out
//   POST /api/account/logout-all                            signs the account out everywhere
//   POST /api/account/change    { current, password }       a new password; signed out everywhere else
//   GET  /api/account/me        { email }                   who's signed in (email: null if nobody)
//
// An account is only ever made by someone who received a code at its address: what a person may do on a
// server goes by their email (src/roles.js), so an unproven address would be someone else's access.
//
// How it's kept (directory-migrations/0003_accounts.sql):
//   accounts  the email and the password's hash (src/password.js). The password itself is never stored or logged.
//   sessions  the SHA-256 of each signed-in browser's token. The cookie (__Host-mcs: HttpOnly, Secure,
//             SameSite=Lax) holds the token and nothing else, so nothing about the account is in the browser
//             and a session can be ended from here: sign out, sign out everywhere, a new password.
//
// Guessing is slowed three ways: every answer about a wrong email or password is the same and takes as long
// (a made-up hash is checked when there's no account); attempts are counted per address and email, per email
// and per address (src/limiter.js); and a code is 8 digits, allows five tries in all, and lasts ten minutes.
import {
  ACCOUNT_CODE_RE, b64url, cleanEmail, clearCookie, codeHash, CODE_MINUTES, CODE_TRIES, cookie, DAY, EMAIL_RE, newAccountCode, parseCookies,
  randomHex, sameString, SESSION_COOKIE, SESSION_DAYS, sessionReady, sha256Hex,
} from './session.js';
import { checkAccountPassword, hashAccountPassword, passwordProblem } from './password.js';
import { ipKey, limit, tooMany } from './limiter.js';
import { accountCodeEmail, passwordChangedEmail, sendEmail, signInLink } from './email.js';
import { json } from './util.js';

export const LOGIN_FAILED = 'That email and password don’t match.';
const CODE_FAILED = 'That code isn’t right, or it has expired.';
const now = () => Math.floor(Date.now() / 1000);

// A page of this site to go back to after signing in: a path, never another site's address.
export const localPath = (v) => (typeof v === 'string' && /^\/(?![/\\])[A-Za-z0-9\-._~/?=&%]{0,200}$/.test(v) ? v : null);

// ---- sessions ----

// token hash -> { at, account } for a few seconds, per isolate: every API call on a page asks who's signed in.
// Signing out clears it here at once; another isolate may honour an ended session for up to CACHE_MS more.
const CACHE_MS = 10_000;
const cache = new Map();

const tokenOf = (request) => {
  const t = parseCookies(request)[SESSION_COOKIE];
  return typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
};

// Who's signed in on this request: { id, email, session } (session: its token's hash), or null.
export async function accountOf(request, env) {
  const token = tokenOf(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.account;
  const row = await env.DIRECTORY.prepare(
    'SELECT a.id, a.email FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?'
  ).bind(hash, now()).first();
  const account = row ? { id: row.id, email: row.email, session: hash } : null;
  cache.set(hash, { at: Date.now(), account });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return account;
}

// A new session for the account: its Set-Cookie. Old, expired ones are cleared out along the way.
async function startSession(env, accountId) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const t = now();
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(t),
    env.DIRECTORY.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(token), accountId, t, t + SESSION_DAYS * DAY),
  ]);
  return cookie(SESSION_COOKIE, token, { path: '/', maxAge: SESSION_DAYS * DAY });
}

// Ends the account's sessions (all of them, or all but `keep`), here and in this isolate's memory.
async function endSessions(env, accountId, keep = null) {
  await env.DIRECTORY.prepare('DELETE FROM sessions WHERE account_id = ?1 AND (?2 IS NULL OR token_hash <> ?2)').bind(accountId, keep).run();
  for (const [hash, hit] of cache) if (hit.account?.id === accountId && hash !== keep) cache.delete(hash);
}

const answer = (body, cookies = [], status = 200) => {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
};
const signedOut = () => clearCookie(SESSION_COOKIE, '/');

// A POST's JSON body, from this site's own pages only. A Response when it isn't one.
async function body(request, url) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
  // a form on another site can't send JSON without asking first, and Sec-Fetch-Site says where it came from
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return json({ error: 'wrong origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'too large' }, 413);
    const b = JSON.parse(raw || '{}');
    return b && typeof b === 'object' ? { b } : json({ error: 'bad json' }, 400);
  } catch {
    return json({ error: 'bad json' }, 400);
  }
}

export async function handleAccount(request, env, url) {
  if (!sessionReady(env)) return json({ error: 'The site isn’t set up yet (no SESSION_SECRET).' }, 503);
  const path = url.pathname.slice('/api/account'.length);

  if (path === '/me') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const me = await accountOf(request, env);
    return json({ email: me?.email ?? null });
  }

  const r = await body(request, url);
  if (r instanceof Response) return r;
  const b = r.b;
  const ip = await ipKey(env, request);

  if (path === '/code') {
    const email = cleanEmail(b.email);
    if (!EMAIL_RE.test(email)) return json({ error: 'That isn’t an email address.', field: 'email' }, 400);
    // the address's own count comes first, so someone over theirs can't use up an email's
    const lim = await limit(env, [[`code-ip:${ip}`, 20, 3600], [`acct-code:${email}`, 5, 3600]]);
    if (!lim.ok) return tooMany(lim.retry);
    const code = newAccountCode();
    await env.DIRECTORY.prepare(
      'INSERT INTO login_codes (email, code_hash, expires_at, tries) VALUES (?, ?, ?, 0) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0'
    ).bind(email, await codeHash('account', email, code), now() + CODE_MINUTES * 60).run();
    const next = localPath(b.next);
    const link = signInLink(url.origin, `/account${next ? `?${new URLSearchParams({ next })}` : ''}`, email, code);
    // the same email whether or not there's an account: the address's owner decides what the code is for
    if (!(await sendEmail(env, { to: email, ...accountCodeEmail(code, link) }))) return json({ error: 'The email couldn’t be sent. Try again in a minute.' }, 502);
    return json({ ok: true });
  }

  if (path === '/password') {
    const email = cleanEmail(b.email);
    const code = String(b.code ?? '').replace(/\s/g, '');
    const lim = await limit(env, [[`verify-ip:${ip}`, 30, 600]]);
    if (!lim.ok) return tooMany(lim.retry);
    // the password is looked at first, so a password that won't do doesn't use the code up
    const bad = passwordProblem(b.password, email);
    if (bad) return json({ error: bad, field: 'password' }, 400);
    const wrong = json({ error: CODE_FAILED, field: 'code' }, 400);
    if (!EMAIL_RE.test(email) || !ACCOUNT_CODE_RE.test(code)) return wrong;
    // A try is claimed in one statement, before the code is looked at: guesses sent all at once still get
    // CODE_TRIES between them, not CODE_TRIES each.
    const row = await env.DIRECTORY.prepare(
      'UPDATE login_codes SET tries = tries + 1 WHERE email = ? AND tries < ? AND expires_at >= ? RETURNING code_hash'
    ).bind(email, CODE_TRIES, now()).first();
    if (!row || !(await sameString(row.code_hash, await codeHash('account', email, code)))) return wrong;
    // and used up in one statement: the same code sent twice at once is taken once
    const used = await env.DIRECTORY.prepare('DELETE FROM login_codes WHERE email = ? AND code_hash = ? RETURNING 1 AS ok').bind(email, row.code_hash).first();
    if (!used) return wrong;
    const hash = await hashAccountPassword(env, b.password);
    const t = now();
    const had = await env.DIRECTORY.prepare('SELECT id FROM accounts WHERE email = ?').bind(email).first();
    await env.DIRECTORY.prepare(
      'INSERT INTO accounts (id, email, pw_hash, created_at, pw_changed_at) VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT(email) DO UPDATE SET pw_hash = excluded.pw_hash, pw_changed_at = excluded.pw_changed_at'
    ).bind(randomHex(16), email, hash, t).run();
    const account = await env.DIRECTORY.prepare('SELECT id FROM accounts WHERE email = ?').bind(email).first();
    // a new password ends every session made with the old one
    await endSessions(env, account.id);
    console.log(`account: ${had ? 'new password (by email) for' : 'made'} ${account.id}`);
    return answer({ ok: true, email, created: !had }, [await startSession(env, account.id)]);
  }

  if (path === '/login') {
    const email = cleanEmail(b.email);
    const password = typeof b.password === 'string' ? b.password : '';
    // counted per email only when it is one, so nonsense can't make a counter each
    const who = EMAIL_RE.test(email) ? email : '-';
    // The address's own counts come first, so someone over theirs can't use up an email's. The count per
    // email alone (guesses from many addresses) is generous; an account it holds up still gets in with
    // "Forgot password", which doesn't pass through here.
    const lim = await limit(env, [[`login-ip:${ip}`, 60, 600], [`login:${who}:${ip}`, 10, 600], [`login:${who}`, 100, 3600]]);
    if (!lim.ok) return tooMany(lim.retry);
    const row = EMAIL_RE.test(email) ? await env.DIRECTORY.prepare('SELECT id, pw_hash FROM accounts WHERE email = ?').bind(email).first() : null;
    // a made-up hash is checked when there's no such account (or it has no password), so both take as long
    const { ok, stale } = await checkAccountPassword(env, password, row?.pw_hash);
    if (!ok) return json({ error: LOGIN_FAILED }, 401);
    if (stale) await env.DIRECTORY.prepare('UPDATE accounts SET pw_hash = ? WHERE id = ?').bind(await hashAccountPassword(env, password), row.id).run();
    return answer({ ok: true, email }, [await startSession(env, row.id)]);
  }

  const me = await accountOf(request, env);

  if (path === '/logout') {
    if (me) {
      await env.DIRECTORY.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(me.session).run();
      cache.delete(me.session);
    }
    return answer({ ok: true }, [signedOut()]);
  }

  if (!me) return json({ error: 'Sign in first.', reason: 'signed_out' }, 401);

  if (path === '/logout-all') {
    await endSessions(env, me.id);
    return answer({ ok: true }, [signedOut()]);
  }

  if (path === '/change') {
    const lim = await limit(env, [[`change:${me.id}`, 10, 600]]);
    if (!lim.ok) return tooMany(lim.retry);
    const row = await env.DIRECTORY.prepare('SELECT pw_hash FROM accounts WHERE id = ?').bind(me.id).first();
    const { ok } = await checkAccountPassword(env, typeof b.current === 'string' ? b.current : '', row?.pw_hash);
    if (!ok) return json({ error: 'That isn’t your current password.', field: 'current' }, 400);
    const bad = passwordProblem(b.password, me.email);
    if (bad) return json({ error: bad, field: 'password' }, 400);
    await env.DIRECTORY.prepare('UPDATE accounts SET pw_hash = ?, pw_changed_at = ? WHERE id = ?').bind(await hashAccountPassword(env, b.password), now(), me.id).run();
    await endSessions(env, me.id, me.session);
    console.log(`account: new password for ${me.id}`);
    // told by email, in case it wasn't them (the email says how to take the account back)
    await sendEmail(env, { to: me.email, ...passwordChangedEmail(`${url.origin}/account`) });
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}
