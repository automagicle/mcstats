// mcstats accounts (src/account.js): made with an emailed code and a password, signed in with the password,
// signed out for good when asked. And what the database holds afterwards.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, cookieOf, makeServer } from './helpers.js';
import { codeHash, signToken } from '../src/session.js';
import { accountCodeEmail, signInLink } from '../src/email.js';
import { checkAccountPassword, hashAccountPassword, passwordProblem } from '../src/password.js';
import { localPath } from '../src/account.js';

// Each test comes from an address of its own, so one test's tries don't count against the next's.
let address = 0;
beforeEach(() => { address += 1; });
const from = (n = 0) => ({ 'CF-Connecting-IP': `10.${address >> 8}.${address & 255}.${n}` });
const post = (path, body, cookie, headers = from()) => call(`/api/account/${path}`, { method: 'POST', body, cookie, headers });
const me = async (cookie) => (await (await call('/api/account/me', { cookie })).json()).email;
const session = (res) => cookieOf(res, '__Host-mcs');

// The code went by email and is only stored hashed: put a known one in its place.
async function codeFor(typed, code = '42424242') {
  expect((await post('code', { email: typed })).status).toBe(200);
  const email = typed.trim().toLowerCase();
  await env.DIRECTORY.prepare('UPDATE login_codes SET code_hash = ? WHERE email = ?').bind(await codeHash('account', email, code), email).run();
  return code;
}
async function signUp(email, password) {
  const res = await post('password', { email, code: await codeFor(email), password });
  expect(res.status).toBe(200);
  return session(res);
}

describe('the code email', () => {
  it('has the code and a link that carries the same code after the #, where no server sees it', () => {
    const link = signInLink('https://mcstats.test', '/account?next=%2Fs%2Fmy-smp%2F', 'a+b@example.org', '42424242');
    const url = new URL(link);
    expect(url.pathname + url.search).toBe('/account?next=%2Fs%2Fmy-smp%2F');
    expect(Object.fromEntries(new URLSearchParams(url.hash.slice(1)))).toEqual({ email: 'a+b@example.org', code: '42424242' });
    const mail = accountCodeEmail('42424242', link);
    expect(mail.subject).toContain('42424242');
    expect(mail.text).toContain(link);
    expect(mail.html).toContain('href="https://mcstats.test/account?next=%2Fs%2Fmy-smp%2F#email=a%2Bb%40example.org&#38;code=42424242"');
  });

  it('only ever sends people back to a page of this site', () => {
    expect(localPath('/s/my-smp/')).toBe('/s/my-smp/');
    expect(localPath('/new?server=a&step=3')).toBe('/new?server=a&step=3');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/a b', '', null, 5]) expect(localPath(bad), String(bad)).toBe(null);
  });
});

describe('making an account', () => {
  it('needs the emailed code, and a password that is one', async () => {
    const email = 'new@example.org';
    const code = await codeFor(email);
    // no code, a wrong code, a weak password: no account
    expect((await post('password', { email, code: '11111111', password: 'a fine password' })).status).toBe(400);
    for (const password of ['short', 'password123', 'aaaaaaaaaaaa', 'new@example.org', 'x'.repeat(201)]) {
      const res = await post('password', { email, code, password });
      expect(res.status, password).toBe(400);
      expect((await res.json()).field).toBe('password');
    }
    expect(await env.DIRECTORY.prepare('SELECT COUNT(*) AS n FROM accounts WHERE email = ?').bind(email).first('n')).toBe(0);
    // typed twice, differently: no account, and the code isn't used up
    const slip = await post('password', { email, code, password: 'a fine password', confirm: 'a fine passwrod' });
    expect([slip.status, (await slip.json()).field]).toEqual([400, 'confirm']);
    // the right code: an account, signed in
    const res = await post('password', { email, code, password: 'a fine password' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email, created: true });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('__Host-mcs='));
    for (const attr of ['Path=/;', 'HttpOnly', 'Secure', 'SameSite=Lax']) expect(set).toContain(attr);
    expect(set).not.toContain('Domain');
    expect(await me(session(res))).toBe(email);
    // a code works once
    expect((await post('password', { email, code, password: 'another password' })).status).toBe(400);
  });

  it('a code allows five tries, then is dead even when right', async () => {
    const email = 'tries@example.org';
    const code = await codeFor(email);
    for (let i = 0; i < 5; i++) expect((await post('password', { email, code: '00000000', password: 'a fine password' })).status).toBe(400);
    expect((await post('password', { email, code, password: 'a fine password' })).status).toBe(400);
  });

  it('guesses sent all at once still get five tries between them', async () => {
    const email = 'flood@example.org';
    const code = await codeFor(email);
    // from twenty addresses, so no one address's limit is what stops them
    await Promise.all(Array.from({ length: 20 }, (_, i) => post('password', { email, code: '00000000', password: 'a fine password' }, undefined, from(i + 1))));
    expect(await env.DIRECTORY.prepare('SELECT tries FROM login_codes WHERE email = ?').bind(email).first('tries')).toBe(5);
    expect((await post('password', { email, code, password: 'a fine password' })).status).toBe(400);
  });

  it('the right code sent twice at once makes one session, not two', async () => {
    const email = 'twice@example.org';
    const code = await codeFor(email);
    const res = await Promise.all([1, 2].map(() => post('password', { email, code, password: 'a fine password' })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('a long password with composed characters still signs in', async () => {
    const email = 'long@example.org';
    const password = '\uFB03'.repeat(60) + ' horse'; // 66 typed, 186 once normalised
    await signUp(email, password);
    expect((await post('login', { email, password })).status).toBe(200);
  });

  it('asking for a code says the same thing whether or not there is an account', async () => {
    await signUp('known@example.org', 'a fine password');
    const a = await post('code', { email: 'known@example.org' });
    const b = await post('code', { email: 'unknown@example.org' });
    expect([a.status, await a.text()]).toEqual([b.status, await b.text()]);
    expect((await post('code', { email: 'not an email' })).status).toBe(400);
  });

  it('the email is one account however it is typed', async () => {
    await signUp('Mixed.Case@Example.org', 'a fine password');
    expect((await post('login', { email: '  mixed.case@example.ORG ', password: 'a fine password' })).status).toBe(200);
    expect(await env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM accounts WHERE email LIKE 'mixed.case@%'").first('n')).toBe(1);
  });
});

describe('signing in', () => {
  it('takes the password, and tells a wrong password and a missing account apart in no way', async () => {
    await signUp('user@example.org', 'correct horse battery');
    const ok = await post('login', { email: 'user@example.org', password: 'correct horse battery' });
    expect(ok.status).toBe(200);
    expect(await me(session(ok))).toBe('user@example.org');
    const wrong = await post('login', { email: 'user@example.org', password: 'correct horse batterx' });
    const nobody = await post('login', { email: 'nobody@example.org', password: 'correct horse battery' });
    expect([wrong.status, await wrong.text()]).toEqual([401, await nobody.text()]);
    expect(nobody.status).toBe(401);
    expect(session(wrong)).toBeUndefined();
  });

  it('stops counting guesses after ten for one email from one address', async () => {
    await signUp('guessed@example.org', 'correct horse battery');
    for (let i = 0; i < 10; i++) expect((await post('login', { email: 'guessed@example.org', password: `guess number ${i}` })).status).toBe(401);
    // even the right password has to wait now
    expect((await post('login', { email: 'guessed@example.org', password: 'correct horse battery' })).status).toBe(429);
  });

  it('only from this site’s own pages', async () => {
    const login = (headers) => call('/api/account/login', { method: 'POST', headers: { ...from(), ...headers }, body: { email: 'user@example.org', password: 'x' } }).then((r) => r.status);
    expect(await login({ Origin: 'https://evil.example' })).toBe(403);
    expect(await login({ 'Sec-Fetch-Site': 'cross-site' })).toBe(403);
    expect((await call('/api/account/login')).status).toBe(405);
  });

  it('the cookies from before accounts sign nobody in', async () => {
    const a = await makeServer('acct-old');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const old = `mcs_id=${await signToken(env, { k: 'id', s: a.id, e: a.owner, x: exp })}; mcs_site=${await signToken(env, { k: 'site', e: a.owner, x: exp })}`;
    expect((await call(`/s/${a.slug}/api/me`, { cookie: old })).status).toBe(401);
    expect((await (await call('/api/site/me', { cookie: old })).json()).email).toBe(null);
    expect(await me(old)).toBe(null);
  });
});

describe('signing out and changing the password', () => {
  it('signing out ends that session for good, not just in the browser', async () => {
    const one = await signUp('out@example.org', 'correct horse battery');
    const two = session(await post('login', { email: 'out@example.org', password: 'correct horse battery' }));
    const res = await post('logout', {}, one);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-mcs=;') && c.includes('Max-Age=0'))).toBe(true);
    // the old cookie, sent again by someone who kept a copy: nobody
    expect(await me(one)).toBe(null);
    expect(await me(two)).toBe('out@example.org');
    await post('logout-all', {}, two);
    expect(await me(two)).toBe(null);
    expect(await env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE a.email = 'out@example.org'").first('n')).toBe(0);
  });

  it('a new password needs the current one, and signs out everywhere else', async () => {
    const here = await signUp('change@example.org', 'correct horse battery');
    const there = session(await post('login', { email: 'change@example.org', password: 'correct horse battery' }));
    expect((await post('change', { current: 'wrong', password: 'a brand new password' }, here)).status).toBe(400);
    expect((await post('change', { current: 'correct horse battery', password: 'short' }, here)).status).toBe(400);
    expect((await post('change', { current: 'correct horse battery', password: 'a brand new password' })).status).toBe(401);
    expect((await post('change', { current: 'correct horse battery', password: 'a brand new password' }, here)).status).toBe(200);
    expect(await me(here)).toBe('change@example.org');
    expect(await me(there)).toBe(null);
    expect((await post('login', { email: 'change@example.org', password: 'correct horse battery' })).status).toBe(401);
    expect((await post('login', { email: 'change@example.org', password: 'a brand new password' })).status).toBe(200);
  });

  it('forgetting the password: a code sets a new one and signs out every old session', async () => {
    const old = await signUp('forgot@example.org', 'correct horse battery');
    const res = await post('password', { email: 'forgot@example.org', code: await codeFor('forgot@example.org', '13579000'), password: 'a brand new password' });
    expect(await res.json()).toMatchObject({ created: false });
    expect(await me(old)).toBe(null);
    expect(await me(session(res))).toBe('forgot@example.org');
    expect((await post('login', { email: 'forgot@example.org', password: 'correct horse battery' })).status).toBe(401);
  });
});

describe('what is stored', () => {
  it('never the password or the session token, only hashes', async () => {
    const password = 'correct horse battery';
    const cookie = await signUp('stored@example.org', password);
    const token = cookie.split('=')[1];
    const account = await env.DIRECTORY.prepare("SELECT * FROM accounts WHERE email = 'stored@example.org'").first();
    const sessions = (await env.DIRECTORY.prepare('SELECT * FROM sessions WHERE account_id = ?').bind(account.id).all()).results;
    const all = JSON.stringify([account, sessions]);
    expect(all).not.toContain(password);
    expect(all).not.toContain(token);
    expect(account.pw_hash).toMatch(/^v1\$\d\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(sessions).toHaveLength(1);
  });

  it('the same password hashes differently each time, and not at all without the Worker’s secret', async () => {
    const a = await hashAccountPassword(env, 'correct horse battery');
    const b = await hashAccountPassword(env, 'correct horse battery');
    expect(a).not.toBe(b);
    expect(await checkAccountPassword(env, 'correct horse battery', a)).toEqual({ ok: true, stale: false });
    expect((await checkAccountPassword(env, 'correct horse batterx', a)).ok).toBe(false);
    // a copy of the database checked with another secret: the right password doesn't match
    const elsewhere = { ...env, SESSION_SECRET: 'another-secret-0123456789abcdefghijklmnopqrstu' };
    expect((await checkAccountPassword(elsewhere, 'correct horse battery', a)).ok).toBe(false);
    // nothing, or nonsense, where a hash should be: never a match
    for (const stored of [null, '', 'v1$3$$', 'plain']) expect((await checkAccountPassword(env, 'correct horse battery', stored)).ok).toBe(false);
  });

  it('a hash made with fewer rounds still checks, and is made again at the next sign-in', async () => {
    const email = 'stale@example.org';
    await signUp(email, 'correct horse battery');
    const old = await hashAccountPassword(env, 'correct horse battery', 1);
    expect(await checkAccountPassword(env, 'correct horse battery', old)).toEqual({ ok: true, stale: true });
    await env.DIRECTORY.prepare('UPDATE accounts SET pw_hash = ? WHERE email = ?').bind(old, email).run();
    expect((await post('login', { email, password: 'correct horse battery' })).status).toBe(200);
    const made = await env.DIRECTORY.prepare('SELECT pw_hash FROM accounts WHERE email = ?').bind(email).first('pw_hash');
    expect(made.startsWith('v1$3$')).toBe(true);
    expect((await checkAccountPassword(env, 'correct horse battery', made)).ok).toBe(true);
    expect(passwordProblem('correct horse battery', email)).toBe(null);
  });
});
