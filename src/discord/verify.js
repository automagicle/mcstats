// Every interaction Discord sends is signed with the app's Ed25519 key over timestamp + body. Anything that
// doesn't verify gets a 401 before it's even parsed (Discord sends bad ones on purpose to check this).

const enc = new TextEncoder();
const MAX_BODY = 64 * 1024;
const SKEW_SECONDS = 300;

const hexBytes = (h) => {
  if (typeof h !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(h)) return null;
  return Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
};

const keys = new Map(); // public key hex -> CryptoKey, per isolate
async function publicKey(hex) {
  if (keys.has(hex)) return keys.get(hex);
  const raw = hexBytes(hex);
  if (!raw || raw.length !== 32) throw new Error('DISCORD_PUBLIC_KEY is not a 32-byte hex key');
  const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  keys.set(hex, key);
  return key;
}

// The request's body if it's genuinely from Discord, otherwise null.
export async function verifiedBody(request, env) {
  const sig = hexBytes(request.headers.get('X-Signature-Ed25519') || '');
  const ts = request.headers.get('X-Signature-Timestamp') || '';
  if (!sig || sig.length !== 64 || !/^\d{1,12}$/.test(ts)) return null;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > SKEW_SECONDS) return null;
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) return null;
  const raw = await request.text();
  if (raw.length > MAX_BODY) return null;
  try {
    const ok = await crypto.subtle.verify('Ed25519', await publicKey(env.DISCORD_PUBLIC_KEY), sig, enc.encode(ts + raw));
    return ok ? raw : null;
  } catch (err) {
    console.error('discord signature:', err.message);
    return null;
  }
}
