// Rate limits: one small Durable Object per thing being counted (a server name being joined, an IP
// address, an email address), each a sliding window of recent attempts. IP addresses are hashed before
// they become an object's name, so they aren't stored anywhere.
import { DurableObject } from 'cloudflare:workers';
import { sha256Hex } from './session.js';

export class Limiter extends DurableObject {
  // { ok, retry } : ok is false once `limit` attempts have been made in the last `windowSec` seconds.
  // count: false only looks; it doesn't use up an attempt.
  async hit(limit, windowSec, count = true) {
    const now = Date.now();
    let times = ((await this.ctx.storage.get('t')) || []).filter((t) => now - t < windowSec * 1000);
    if (times.length >= limit) {
      return { ok: false, retry: Math.max(1, Math.ceil((times[0] + windowSec * 1000 - now) / 1000)) };
    }
    if (count) {
      times.push(now);
      await this.ctx.storage.put('t', times);
      await this.ctx.storage.setAlarm(now + windowSec * 1000);
    }
    return { ok: true, retry: 0 };
  }

  async reset() {
    await this.ctx.storage.deleteAll();
  }

  // nothing left to count: forget it all
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

const stub = (env, key) => env.LIMITER.get(env.LIMITER.idFromName(key));

// Counts one attempt against each [key, limit, windowSec]; the first that's over its limit wins.
export async function limit(env, rules) {
  for (const [key, max, windowSec] of rules) {
    const r = await stub(env, key).hit(max, windowSec);
    if (!r.ok) return r;
  }
  return { ok: true, retry: 0 };
}

// One IPv6 customer usually has a whole /64 (2^64 addresses) to send from: they count as one.
const network = (ip) => (ip.includes(':') ? ip.toLowerCase().replace(/::.*$/, '').split(':').slice(0, 4).join(':') + '::/64' : ip);
export const ipKey = async (env, request) =>
  `ip:${(await sha256Hex(`${env.SESSION_SECRET || ''}:${network(request.headers.get('CF-Connecting-IP') || 'local')}`)).slice(0, 32)}`;

export const tooMany = (retry) => new Response(JSON.stringify({ error: 'Too many tries. Wait a little and try again.', retry }), {
  status: 429,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(retry) },
});
