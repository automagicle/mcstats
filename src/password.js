// Account passwords: how they're checked for sense, hashed and compared. Nothing here stores or logs one.
//
// The hash is PBKDF2-HMAC-SHA512, salted per account, then keyed with a secret that isn't in the database:
//
//   v1$<rounds>$<salt>$<hash>
//
//   1. PBKDF2-HMAC-SHA512 with a random 16-byte salt, ROUNDS times over, each ITERATIONS long, each round's
//      output being the next one's password. The Workers runtime refuses more than 100,000 iterations in one
//      call; chaining gets past that. ROUNDS × ITERATIONS is above the 210,000 OWASP asks of this function.
//   2. HMAC-SHA256 of that with a key derived from SESSION_SECRET (a "pepper"): someone who gets a copy of the
//      database but not the Worker's secrets can't even begin guessing passwords.
//
// The parameters are written into each hash, so they can be raised later: checkPassword() says when a hash
// was made with older ones, and signing in then stores a new one (src/account.js).
//
// Changing SESSION_SECRET therefore makes every password stop matching; people get back in with
// "Forgot password" (an emailed code), which needs nothing but their email.
import { b64url, keyed, unb64url } from './session.js';

const enc = new TextEncoder();
const ITERATIONS = 100_000;
const ROUNDS = 3;

export const MIN_ACCOUNT_PASSWORD = 8;
export const MAX_ACCOUNT_PASSWORD = 200;

// The same password however the keyboard composed its characters.
const normal = (password) => String(password).normalize('NFKC');

async function stretch(password, salt, rounds) {
  let input = enc.encode(normal(password));
  let bits;
  for (let i = 0; i < rounds; i++) {
    const key = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
    bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: ITERATIONS }, key, 512);
    input = new Uint8Array(bits);
  }
  return bits;
}

async function make(env, password, salt, rounds) {
  return b64url(await keyed(env, 'account-password', await stretch(password, salt, rounds)));
}

export async function hashAccountPassword(env, password, rounds = ROUNDS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `v1$${rounds}$${b64url(salt)}$${await make(env, password, salt, rounds)}`;
}

// A hash nobody's password makes, so checking one for an account that doesn't exist takes as long.
const DUMMY = `v1$${ROUNDS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

// { ok, stale }: whether the password is the one hashed, and whether the hash should be made again.
export async function checkAccountPassword(env, password, stored) {
  let parts = String(stored || '').split('$');
  let real = parts.length === 4 && parts[0] === 'v1' && /^[1-9]$/.test(parts[1]);
  if (!real) parts = DUMMY.split('$');
  const rounds = Number(parts[1]);
  let got;
  try {
    // normalised before it's cut, the way passwordProblem() measured it when it was set
    got = await make(env, normal(password).slice(0, MAX_ACCOUNT_PASSWORD), unb64url(parts[2]), rounds);
  } catch {
    return { ok: false, stale: false };
  }
  const a = enc.encode(got), b = enc.encode(parts[3]);
  const ok = a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
  return { ok: ok && real, stale: ok && real && rounds !== ROUNDS };
}

// The passwords tried first by anyone guessing. Not a strength meter: just the ones that are no password at all.
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', '12345678', '123456789', '1234567890', '87654321',
  '11111111', '00000000', 'qwertyui', 'qwertyuiop', 'qwerty123', 'qwerty12', '1q2w3e4r', '1q2w3e4r5t', 'iloveyou', 'iloveyou1',
  'letmein1', 'letmein123', 'welcome1', 'welcome123', 'admin123', 'administrator', 'abc12345', 'abcd1234', 'abcdefgh', 'asdfghjk',
  'asdfghjkl', 'zxcvbnm1', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'trustno1', 'dragon123', 'monkey123',
  'minecraft', 'minecraft1', 'minecraft123', 'mcstats1', 'mcstats123', 'changeme', 'changeme1', 'computer', 'internet', 'whatever',
]);

// Why this password can't be used for this account, or null.
export function passwordProblem(password, email) {
  if (typeof password !== 'string') return 'Type a password.';
  const p = normal(password);
  if (p.length < MIN_ACCOUNT_PASSWORD) return `The password needs at least ${MIN_ACCOUNT_PASSWORD} characters.`;
  if (p.length > MAX_ACCOUNT_PASSWORD) return `The password can be at most ${MAX_ACCOUNT_PASSWORD} characters.`;
  const low = p.toLowerCase();
  if (new Set(low).size < 4) return 'That password is too easy to guess. Use more different characters.';
  if (COMMON.has(low)) return 'That password is one of the most common ones. Pick another.';
  const e = String(email || '').toLowerCase();
  if (e && (low === e || low === e.split('@')[0])) return 'The password can’t be your email address.';
  return null;
}
