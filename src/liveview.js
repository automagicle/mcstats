// Liveview: the dashboard's admins watching the Minecraft world live, in the Liveview tab.
//
// The server mod (2.0.0) does the work: it samples players, mobs and terrain and builds the messages the
// page draws from. Nothing about the world is stored here. This file is the door and the pipe:
//
//   The door. Two locks, and it takes both. The dashboard's: the account's "liveview" permission, and
//   "liveview_op" for controls, which a super admin sets on Admin → Roles (src/roles.js). The server's:
//   the mod keeps its own list of accounts it lets in, and tells this side what's on it. An account gets
//   on by entering the viewer key (an operator makes it in game with /liveview key viewer; the mod checks
//   it), or the control key for controls, or by an operator naming it (/liveview access viewer <email>).
//   Only the server can change that list: /liveview access remove <email> takes an account off, and a new
//   key empties it. The mod checks the list again itself when a page connects. Controls are also off
//   each time the page opens, until they're switched on.
//
//   The pipe. The mod can't be reached from the internet (no open port, no certificate), so, as with
//   web chat, it dials out: one WebSocket to /api/ingest/liveview, opened only while someone watches
//   (this side asks for it over the web chat connection). It lands in a Durable Object, LiveRelay,
//   together with the pages' WebSockets (/api/liveview/ws), and the object passes frames between them.
//   The game's textures and models (a few megabytes, named by their hash) are fetched through the same
//   socket the first time and kept in Cloudflare's cache after that.
//
//   GET  /api/liveview               what the page needs to decide what to show (see liveviewState)
//   POST /api/liveview/unlock        { level: 'viewer' | 'control', key }
//   GET  /api/liveview/ws            the page's WebSocket
//   GET  /api/liveview/assets/<name> a texture atlas, model file or skin
//   GET  /api/ingest/liveview        the mod's WebSocket (its token, not a login)
//
// Cost on the free plan: the relay is only awake while someone watches. The mod gathers everything for
// every viewer into one frame every 50 ms, because a Durable Object is billed per frame it receives
// (20 frames count as one request): about 3,600 requests an hour of watching, however many watch.

import { DurableObject } from 'cloudflare:workers';
import { siblingEnv } from './tenantenv.js';
import { loadPerms } from './roles.js';
import { json, ingestDenied } from './util.js';

const MAX_VIEWERS = 8;
const MAX_PAGE_MESSAGE = 8 * 1024; // what the mod accepts from a page
const WAIT_FOR_MOD_MS = 15_000;
const ASSET_WAIT_MS = 30_000;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const ASSET_NAME = /^[0-9a-f]{64}\.(png|json)$/;
const KEY_LEVELS = ['viewer', 'control'];

const link = (env) => env.LINK.get(env.LINK.idFromName('server'));
const relay = (env) => env.LIVEVIEW.get(env.LIVEVIEW.idFromName('server'));
const mayWatch = new Map(); // email -> when it was last found allowed to watch (for the asset burst only)
const MAY_WATCH_MS = 20_000;

// What the mod last said about Liveview on the server: { linked, version, live: { enabled, control,
// viewer_key, control_key } | null }. live is null when the mod is older than 2.0.0 or not connected.
async function serverState(env) {
  if (!env.LINK) return { linked: false, version: null, live: null };
  try {
    const s = await (await link(env).fetch('https://link/status')).json();
    return { linked: !!s.linked, version: s.version ?? null, live: s.linked ? s.liveview ?? null : null };
  } catch (err) {
    console.error('liveview state:', err.message);
    return { linked: false, version: null, live: null };
  }
}

// What this account may do right now: { view, control }. Two locks, and it takes both:
//   the dashboard's   the account's "liveview" and "liveview_op" permissions (src/roles.js), set by a super admin;
//   the server's      its own list of accounts it lets in (live.access), which an account gets onto by entering
//                     a key or by an operator naming it in game, and which only the server can change.
// Neither holds while the server isn't connected.
function grants(perms, email, live) {
  if (!email || !live?.enabled || !perms?.liveview) return { view: false, control: false };
  const level = live.access?.[email.toLowerCase()];
  const view = level === 'viewer' || level === 'control';
  return { view, control: view && level === 'control' && !!live.control && !!perms.liveview_op };
}

// For the roles page: { linked, access: { email: 'viewer' | 'control' } } as the server has it.
export async function serverAccess(env) {
  const s = await serverState(env);
  return { linked: s.linked, access: s.live?.access || {} };
}

// GET /api/liveview: { server: { linked, version, liveview, control, keys: { viewer, control } }, may_control, view, control }
//   server.liveview  whether the server has Liveview at all (false: mod too old, or turned off)
//   server.control   whether the server lets the dashboard run commands
//   server.keys      which keys have been made in game
//   may_control      whether the dashboard allows this account controls (its "liveview_op" permission)
//   view, control    whether the server lets this account watch, and use controls
async function liveviewState(env, who) {
  const s = await serverState(env);
  return json({
    server: {
      linked: s.linked,
      version: s.version,
      liveview: !!s.live?.enabled,
      old: s.linked && !s.live, // connected, but the mod doesn't know about Liveview (older than 2.0.0)
      control: !!s.live?.control,
      keys: { viewer: !!s.live?.viewer_key, control: !!s.live?.control_key },
    },
    may_control: !!who.perms.liveview_op,
    ...grants(who.perms, who.email, s.live),
  });
}

// POST /api/liveview/unlock { level, key }: the mod checks the key and, if it's right, puts this account on
// the server's list.
async function unlock(request, env, url, who) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 2048) return json({ error: 'too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const level = body?.level;
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (!KEY_LEVELS.includes(level)) return json({ error: 'bad level' }, 400);
  if (!key || key.length > 256) return json({ error: 'wrong', reason: 'wrong' }, 403);
  // the dashboard's own lock first: the control key is no use to an account that isn't allowed controls here
  if (level === 'control' && !who.perms.liveview_op) return json({ error: 'not allowed', reason: 'not_allowed' }, 403);

  const s = await serverState(env);
  if (!s.linked) return json({ error: "The server isn't connected right now.", reason: 'offline' }, 503);
  if (!s.live?.enabled) return json({ error: 'Liveview is off on the server.', reason: 'off' }, 409);
  // the control key is a second step: watching comes first
  if (level === 'control' && !grants(who.perms, who.email, s.live).view) return json({ error: 'Enter the viewer key first.', reason: 'locked' }, 403);

  const res = await link(env).fetch('https://link/liveview/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, key, who: who.email }),
  });
  const r = await res.json().catch(() => ({}));
  if (!r.ok) {
    const reason = r.reason || 'offline';
    const status = { wrong: 403, limited: 429, not_set: 409, off: 409 }[reason] ?? 503;
    console.log(`liveview: ${who.email} was refused the ${level} key (${reason})`);
    return json({ error: reason, reason }, status);
  }
  console.log(`liveview: ${who.email} entered the ${level} key`);
  // the mod has put the account on its list and said so before answering
  return json({ ok: true, ...grants(who.perms, who.email, (await serverState(env)).live) });
}

// GET /api/liveview/assets/<sha256>.<png|json>: the game's textures and models, and players' skins, as the
// mod packed them. Named by their hash, so one that's been fetched once never needs the mod again.
async function asset(request, env, url, ctx) {
  const name = url.pathname.slice('/api/liveview/assets/'.length);
  if (!ASSET_NAME.test(name)) return json({ error: 'not found' }, 404);
  // kept per server: an asset came from that server's mod, and is only for those allowed to watch it
  const cacheKey = new Request(`${url.origin}/_server/${env.TENANT?.id ?? 'none'}/api/liveview/assets/${name}`);
  const cache = caches.default;
  let res = await cache.match(cacheKey);
  if (!res) {
    res = await relay(env).fetch(`https://relay/asset?name=${name}`);
    if (!res.ok) return json({ error: res.status === 404 ? 'not found' : 'The server isn’t connected.' }, res.status === 404 ? 404 : 503);
    res = new Response(res.body, {
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
    const put = cache.put(cacheKey, res.clone());
    if (ctx) ctx.waitUntil(put); else await put;
  }
  // the edge keeps it for everyone who's allowed in; the browser keeps its own copy
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  return out;
}

// Everything under /api/liveview, for a signed-in user with the "liveview" permission.
export async function handleLiveview(request, env, url, who, ctx) {
  if (!who.perms?.liveview) return json({ error: 'forbidden' }, 403);
  if (!env.LIVEVIEW) return json({ error: 'not set up' }, 503);
  const path = url.pathname;

  if (path === '/api/liveview') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return liveviewState(env, who);
  }
  if (path === '/api/liveview/unlock') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return unlock(request, env, url, who);
  }
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  // Assets arrive in a burst (a few dozen files the first time a page opens), so that an account may
  // watch is remembered for a few seconds rather than looked up again for each file.
  const isAsset = path.startsWith('/api/liveview/assets/');
  if (isAsset && Date.now() - (mayWatch.get(who.email) || 0) < MAY_WATCH_MS) return asset(request, env, url, ctx);

  // the view itself: only for an account that entered the current viewer key
  const s = await serverState(env);
  const g = grants(who.perms, who.email, s.live);
  if (!g.view) return json({ error: 'locked', reason: s.linked ? 'locked' : 'offline' }, s.linked ? 403 : 503);

  if (isAsset) {
    mayWatch.set(who.email, Date.now());
    if (mayWatch.size > 200) mayWatch.delete(mayWatch.keys().next().value);
    return asset(request, env, url, ctx);
  }
  if (path === '/api/liveview/ws') {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'expected a WebSocket' }, 426);
    // a page on another site could open a WebSocket here with the browser's login; only this page may
    const origin = request.headers.get('Origin');
    if (origin !== url.origin) return json({ error: 'wrong origin' }, 403);
    const watch = new Request('https://relay/watch', request);
    watch.headers.set('X-Viewer', JSON.stringify({ email: who.email }));
    return relay(env).fetch(watch);
  }
  return json({ error: 'not found' }, 404);
}

// GET /api/ingest/liveview (WebSocket) from the server mod.
export async function connectLiveview(request, env) {
  // the mod's key for this server was checked before the request got here (src/tenant.js)
  const denied = ingestDenied(env);
  if (denied) return denied;
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'expected a WebSocket' }, 426);
  if (!env.LIVEVIEW) return json({ error: 'not set up' }, 503);
  return relay(env).fetch(new Request('https://relay/mod', request));
}

// Close codes the page understands (4000-4999 are ours to define).
const CLOSE = {
  REPLACED: 4000, // a newer connection took this one's place
  BAD: 4400, // the page sent something the mod wouldn't take
  DENIED: 4403, // the server doesn't have this account on its list (any more)
  FULL: 4429, // too many pages watching
  SERVER_GONE: 4502, // the mod's connection ended (server stopped, key replaced, Liveview turned off)
  NO_SERVER: 4503, // the server isn't connected to the dashboard at all
  NO_ANSWER: 4504, // asked the server to connect and it didn't
};

// Passes frames between the mod's socket and the pages' sockets. Holds nothing about the world.
//
// Sockets are told apart by their attachment: { mod: true } for the mod's, { v, email, armed } for a page's
// (v: its number on the mod's socket; armed: this page has controls switched on). Attachments survive the
// object going to sleep, so nothing else is kept.
//
// To the mod, as text (mod/…/relay/RelayLink.java has the other side):
//   o{"v":3,"who":"a@b.c","control":false}   g3   c{"v":3,"on":true}   m3 <the page's message>   a{"id":7,"name":"…"}
// From the mod: "ping"; x{"v":3,"code":"…"} to drop a page; and binary frames, 0x01 (frames for pages:
// per page u16 v, u32 length, bytes, passed on as they are) and 0x02 (a piece of an asset).
export class LiveRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // one per server, named by its id; this.env is that server's (its database, its other objects)
    this.env = siblingEnv(env, ctx);
    this.pages = null; // v -> socket, rebuilt from the sockets themselves after a sleep
    this.assets = new Map(); // request id -> { chunks, size, type, resolve }
    this.nextAsset = 1;
  }

  mod() {
    let live = null;
    for (const ws of this.ctx.getWebSockets('mod')) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!live || (ws.deserializeAttachment()?.at || 0) >= (live.deserializeAttachment()?.at || 0)) live = ws;
    }
    return live;
  }

  pageSockets() {
    if (!this.pages) {
      this.pages = new Map();
      for (const ws of this.ctx.getWebSockets('page')) {
        const a = ws.deserializeAttachment();
        if (a && ws.readyState === WebSocket.OPEN) this.pages.set(a.v, ws);
      }
    }
    return this.pages;
  }

  tell(ws, message) {
    try { ws.send(JSON.stringify(message)); } catch {}
  }

  closeAll(code, reason) {
    for (const ws of this.pageSockets().values()) {
      try { ws.close(code, reason); } catch {}
    }
    this.pages = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/mod') {
      for (const old of this.ctx.getWebSockets('mod')) {
        try { old.close(CLOSE.REPLACED, 'replaced by a newer connection'); } catch {}
      }
      const [client, server] = Object.values(new WebSocketPair());
      server.serializeAttachment({ mod: true, at: Date.now() });
      this.ctx.acceptWebSocket(server, ['mod']);
      // everyone already waiting; each starts with controls off (its page switches them on again if they were)
      for (const [v, ws] of this.pageSockets()) {
        const a = ws.deserializeAttachment();
        if (a.armed) ws.serializeAttachment({ ...a, armed: false });
        try { server.send(`o${JSON.stringify({ v, who: a.email, control: false })}`); } catch {}
        this.tell(ws, { type: 'relay', state: 'up' });
      }
      console.log(`liveview relay: the server connected (${this.pageSockets().size} page(s) waiting)`);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/watch') {
      let viewer;
      try { viewer = JSON.parse(request.headers.get('X-Viewer') || ''); } catch { viewer = null; }
      if (!viewer?.email) return json({ error: 'forbidden' }, 403);
      const [client, server] = Object.values(new WebSocketPair());
      const pages = this.pageSockets();
      if (pages.size >= MAX_VIEWERS) {
        this.ctx.acceptWebSocket(server, ['refused']);
        server.close(CLOSE.FULL, 'too many pages are watching');
        return new Response(null, { status: 101, webSocket: client });
      }
      let v = 1;
      while (pages.has(v)) v++;
      server.serializeAttachment({ v, email: String(viewer.email).slice(0, 120), armed: false, at: Date.now() });
      this.ctx.acceptWebSocket(server, ['page']);
      pages.set(v, server);

      const mod = this.mod();
      if (mod) {
        try { mod.send(`o${JSON.stringify({ v, who: viewer.email, control: false })}`); } catch {}
        this.tell(server, { type: 'relay', state: 'up' });
      } else {
        // ask the server to connect, over the web chat connection
        let linked = false;
        try {
          linked = !!(await (await link(this.env).fetch('https://link/liveview/open', { method: 'POST' })).json()).ok;
        } catch (err) {
          console.error('liveview relay: asking the server to connect:', err.message);
        }
        if (!linked) {
          pages.delete(v);
          server.close(CLOSE.NO_SERVER, 'the server is not connected');
        } else {
          this.tell(server, { type: 'relay', state: 'waiting' });
          await this.ctx.storage.setAlarm(Date.now() + WAIT_FOR_MOD_MS);
        }
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // an asset, fetched from the mod in pieces
    if (url.pathname === '/asset') {
      const name = url.searchParams.get('name') || '';
      const mod = this.mod();
      if (!mod || !ASSET_NAME.test(name)) return json({ error: mod ? 'not found' : 'not connected' }, mod ? 404 : 503);
      const id = this.nextAsset++;
      const got = await new Promise((resolve) => {
        this.assets.set(id, { chunks: [], size: 0, type: '', resolve });
        setTimeout(() => resolve(null), ASSET_WAIT_MS);
        try { mod.send(`a${JSON.stringify({ id, name })}`); } catch { resolve(null); }
      });
      this.assets.delete(id);
      if (!got) return json({ error: 'the server did not answer' }, 504);
      if (got.missing) return json({ error: 'not found' }, 404);
      return new Response(new Blob(got.chunks), { headers: { 'Content-Type': got.type || 'application/octet-stream' } });
    }

    if (url.pathname === '/state') {
      return json({ server: !!this.mod(), pages: [...this.pageSockets().values()].map((ws) => { const a = ws.deserializeAttachment(); return { email: a.email, armed: !!a.armed }; }) });
    }
    return json({ error: 'not found' }, 404);
  }

  // Pages that have waited too long for the server to connect are told so.
  async alarm() {
    if (this.mod()) return;
    if (this.pageSockets().size) console.log('liveview relay: the server did not connect in time');
    this.closeAll(CLOSE.NO_ANSWER, 'the server did not answer');
  }

  async webSocketMessage(ws, message) {
    const a = ws.deserializeAttachment() || {};
    if (a.mod) return this.fromMod(ws, message);
    if (a.v == null) return;
    return this.fromPage(ws, a, message);
  }

  fromMod(ws, message) {
    if (typeof message === 'string') {
      if (message === 'ping') {
        try { ws.send('pong'); } catch {}
      } else if (message[0] === 'x') {
        // the mod won't take what this page sent, or isn't letting anyone watch
        let m;
        try { m = JSON.parse(message.slice(1)); } catch { return; }
        const page = this.pageSockets().get(m?.v);
        if (page) {
          this.pageSockets().delete(m.v);
          const code = m.code === 'off' ? CLOSE.SERVER_GONE : m.code === 'denied' ? CLOSE.DENIED : CLOSE.BAD;
          try { page.close(code, String(m.code || 'refused').slice(0, 60)); } catch {}
        }
      }
      return;
    }
    const bytes = new Uint8Array(message);
    if (bytes.length < 1) return;
    if (bytes[0] === 1) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const pages = this.pageSockets();
      let at = 1;
      while (at + 6 <= bytes.length) {
        const v = view.getUint16(at);
        const length = view.getUint32(at + 2);
        at += 6;
        if (at + length > bytes.length) break;
        const page = pages.get(v);
        if (page) {
          try { page.send(bytes.subarray(at, at + length)); } catch { pages.delete(v); }
        }
        at += length;
      }
    } else if (bytes[0] === 2 && bytes.length >= 8) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const job = this.assets.get(view.getUint32(1));
      if (!job) return;
      const flags = bytes[5];
      const typeLength = view.getUint16(6);
      if (8 + typeLength > bytes.length) return;
      if (flags & 2) return job.resolve({ missing: true });
      job.type = new TextDecoder().decode(bytes.subarray(8, 8 + typeLength));
      const chunk = bytes.slice(8 + typeLength);
      job.size += chunk.length;
      if (job.size > MAX_ASSET_BYTES) return job.resolve(null);
      job.chunks.push(chunk);
      if (flags & 1) job.resolve(job);
    }
  }

  async fromPage(ws, a, message) {
    if (typeof message !== 'string' || message.length > MAX_PAGE_MESSAGE) {
      try { ws.close(CLOSE.BAD, 'bad message'); } catch {}
      return;
    }
    // switching controls on or off is decided here (it's about the account); the mod is told the result
    if (message.includes('"arm"')) {
      let m;
      try { m = JSON.parse(message); } catch { m = null; }
      if (m?.type === 'arm') {
        let on = m.on === true;
        let reason = null;
        if (on) {
          // Looked up every time, never remembered: the account may have been allowed controls since this
          // page connected, or lost them (on the server's list, or in its permissions here).
          const [s, perms] = await Promise.all([serverState(this.env), loadPerms(this.env, { email: a.email })]);
          if (!grants(perms, a.email, s.live).control) { on = false; reason = perms.liveview_op ? 'locked' : 'not_allowed'; }
        }
        a.armed = on;
        ws.serializeAttachment(a);
        const mod = this.mod();
        if (mod) try { mod.send(`c${JSON.stringify({ v: a.v, on })}`); } catch {}
        this.tell(ws, { type: 'armed', on, ...(reason ? { reason } : {}) });
        return;
      }
    }
    const mod = this.mod();
    if (mod) try { mod.send(`m${a.v} ${message}`); } catch {}
  }

  async gone(ws, code, reason) {
    const a = ws.deserializeAttachment() || {};
    if (a.mod) {
      if (this.mod()) return; // a newer connection already replaced it
      console.log(`liveview relay: the server's connection ended (${code}${reason ? `: ${reason}` : ''})`);
      for (const job of this.assets.values()) job.resolve(null);
      this.closeAll(CLOSE.SERVER_GONE, String(reason || 'the server disconnected').slice(0, 100));
      return;
    }
    if (a.v == null) return;
    const pages = this.pageSockets();
    if (pages.get(a.v) === ws) pages.delete(a.v);
    const mod = this.mod();
    if (mod) try { mod.send(`g${a.v}`); } catch {}
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); } catch {}
    await this.gone(ws, code, reason);
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch {}
    await this.gone(ws, 1011, 'error');
  }
}
