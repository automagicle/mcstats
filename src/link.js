// Chat from the dashboard into the game.
//
// The server mod keeps one WebSocket open to /api/ingest/link (with its CHAT_INGEST_TOKEN and the
// Access service token). That socket lives in a Durable Object, ServerLink, so every Worker request
// reaches the same one. A signed-in player whose login email is on the roster can POST
// /api/chat/send; the message goes down the socket, the mod shows it in game chat as
// "[Web] <name> text" and logs it like any other chat (marked via = 'web'), so it comes back to
// the chat log a few seconds later. Admins (the roster file's "admins" emails) send without a
// player name: a yellow [Admin] tag stands in for it (via = 'admin'). Nothing is queued: if the server isn't connected, sending
// fails right away rather than turning up in game later. If the mod doesn't answer in time the reply
// is 202 { unsure: true }: the message may or may not have been shown, and the log will tell.
//
// Whispers (/w, /msg, /tell) typed on the dashboard come here too (src/whisper.js): to the player in game
// through the mod (1.8.0), or to their page if they're only on the website. The mod sends whispers typed
// in game to someone who's only on the website, and is sent who that is whenever it changes.
//
// Liveview (src/liveview.js) borrows this connection for its handshake (mod 2.0.0): the mod says here
// whether Liveview is on and which keys exist, a key typed on the dashboard is sent down for the mod to
// check, and the mod is asked here to open its Liveview connection when someone wants to watch. The
// view itself goes over that other connection, not this one.
//
// The socket hibernates while idle, so an idle link costs next to nothing. The mod's pings (every 30
// seconds) are answered by this object itself, not by Cloudflare's automatic reply: after a deploy
// the automatic reply could keep answering for a connection this object no longer holds, so the mod
// thought it was connected while the dashboard said it wasn't. Answered here, a connection the object
// doesn't hold goes quiet, and the mod reconnects by itself within about 75 seconds.

import { DurableObject } from 'cloudflare:workers';
import { siblingEnv } from './tenantenv.js';
import { currentSeason } from './seasons.js';
import { json, ingestDenied } from './util.js';
import { tellPresence } from './presence.js';
import { ADMIN_SENDER, deliverWhisper, parseCommand } from './whisper.js';
import { modUpdateMessage } from './modupdate.js';
import { uploadOrigin } from './site.js';
import { accountRequest, connectedPlayer, pendingFor } from './connect.js';

export const MAX_WEB_CHAT = 256; // the game's own limit for a chat message
const IGN_RE = /^[A-Za-z0-9_.]{1,20}$/;
const ACK_MS = 5_000;
// per player: at most one message every 1.5 seconds, and 8 in any 30 seconds
const GAP_MS = 1_500;
const BURST = 8;
const BURST_MS = 30_000;

// The mod pings every 30 seconds; a connection not heard from for this long is dead, whatever it looks like.
const QUIET_MS = 100_000;
const link = (env) => env.LINK.get(env.LINK.idFromName('server'));

// What the web chat connection is doing, for the logs and the admin page: { linked, sockets, version,
// connected_ago, heard_ago, started_ago (this object), log: recent connects and closes }.
export async function linkProbe(env) {
  try {
    return await (await link(env).fetch('https://link/probe')).json();
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

export async function linkStatus(env) {
  if (!env.LINK) return null;
  try {
    return await (await link(env).fetch('https://link/status')).json();
  } catch (err) {
    console.error('link status:', err.message);
    return null;
  }
}

// Whether this side holds the mod's web chat connection, or null if that couldn't be found out. The
// mod is told with each online list (src/online.js): after a deploy its connection can look open to it
// while this side no longer has it, and that's how it finds out to reconnect.
export async function linkUp(env) {
  if (!env.LINK) return null;
  try {
    return !!(await (await link(env).fetch('https://link/status')).json()).linked;
  } catch (err) {
    console.error('link status:', err.message);
    return null;
  }
}

// One line of plain text: no control characters or § formatting codes.
export const cleanWebText = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/§.?/gs, '').trim().slice(0, MAX_WEB_CHAT);

// GET /api/ingest/link (WebSocket) from the server mod.
export async function connectLink(request, env) {
  // the mod's key for this server was checked before the request got here (src/tenant.js)
  const denied = ingestDenied(env);
  if (denied) return denied;
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'expected a WebSocket' }, 426);
  // where this server's pages are, for the mod's /mcstats links (mod 2.2.0): https://<site>/s/<slug>/
  const slug = env.TENANT?.slug;
  const page = slug ? `${uploadOrigin(env, new URL(request.url))}/s/${encodeURIComponent(slug)}/` : '';
  return link(env).fetch(new Request(`https://link/connect?page=${encodeURIComponent(page)}`, request));
}

const ADMIN = '@admin'; // roster_email's stand-in IGN for an admin (scripts/roster-sql.mjs)

// Who a login email sends as this season, by what the admin page says:
//   { ign, team }    the player Admin → Players gave this email to (team is null when they have none yet), or
//                    else the player who connected it from in game (/mcstats connect), with connected: true
//   { admin: true }  the roster file's "admins" (@admin), or an owner or admin (Roles) with no player of their own
//   null             nobody: a member whose email isn't linked to a player
// perms: what Roles gives the account (src/roles.js loadPerms), when known.
export async function playerFor(env, email, perms = null) {
  if (!email) return null;
  const row = await env.DB.prepare(
    `SELECT e.ign, r.team FROM roster_email e LEFT JOIN roster r ON r.season = e.season AND r.ign = e.ign
     WHERE e.season = ? AND e.email = ?`
  ).bind(currentSeason(env), email).first();
  if (row?.ign === ADMIN) return { admin: true };
  if (row) return { ign: row.ign, team: row.team ?? null };
  // the player who connected this account from in game (/mcstats connect, src/connect.js)
  const own = await connectedPlayer(env.DB, email);
  if (own) {
    const t = await env.DB.prepare('SELECT team FROM roster WHERE season = ? AND ign = ? COLLATE NOCASE').bind(currentSeason(env), own.name).first();
    return { ign: own.name, team: t?.team ?? null, connected: true };
  }
  if (perms && (perms.super || perms.role === 'owner' || perms.role === 'admin')) return { admin: true };
  return null;
}

// A player's name the way the game spells it (the roster's capitals can differ). The game looks up a
// name's team exactly, so a message sent as "Mar9904" for the player "mar9904" lost its team color.
async function gameName(env, ign) {
  try {
    // with more than one spelling on record, the one most recently on the server
    const row = await env.DB.prepare(
      `SELECT p.name FROM players p WHERE p.name = ? COLLATE NOCASE
       ORDER BY (SELECT MAX(s.end_ts) FROM sessions s WHERE s.uuid = p.uuid) DESC LIMIT 1`
    ).bind(ign).first();
    return row?.name || ign;
  } catch {
    return ign;
  }
}

// GET /api/chat/me: who you'd be sending as, and whether the server is connected.
export async function webChatMe(env, who) {
  // someone a super admin has stopped from chatting (src/roles.js) is told so, rather than "not on the roster"
  const blocked = who.perms ? !who.perms.chat : false;
  const player = blocked ? null : await playerFor(env, who.email, who.perms);
  const linked = player ? (await linkUp(env)) === true : false;
  // a player who asked in game to connect this account, waiting for its yes (src/connect.js)
  const ask = who.email ? await pendingFor(env.DB, who.email) : null;
  return json({
    email: who.email, ign: player?.ign ?? null, team: player?.team ?? null, admin: !!player?.admin, connected: !!player?.connected,
    linked, max: MAX_WEB_CHAT, blocked, connect: ask ? { name: ask.name, at: ask.requested_at } : null,
  });
}

// POST /api/chat/send { text }
export async function sendWebChat(request, env, url, who) {
  // Only this page may post here (a JSON body also can't be sent cross-site without CORS allowing it).
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);

  if (who.perms && !who.perms.chat) return json({ error: 'This account isn’t allowed to send chat from the dashboard.' }, 403);
  const player = await playerFor(env, who.email, who.perms);
  if (!player) {
    return json({ error: who.email ? `${who.email} isn’t linked to a player yet (connect it in game with /mcstats connect, or an admin links it on Admin → Players), so it can’t send chat` : 'not signed in with an email' }, 403);
  }
  let text;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'too large' }, 413);
    text = JSON.parse(raw).text;
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  if (typeof text !== 'string') return json({ error: 'expected { text }' }, 400);
  text = cleanWebText(text);
  if (!text) return json({ error: 'empty message' }, 400);

  const sendAs = player.admin ? null : await gameName(env, player.ign);

  // "/w Name message" (or /msg, /tell): a whisper (src/whisper.js)
  const command = parseCommand(text);
  if (command?.error) return json({ error: command.error, reason: 'command' }, 400);
  if (command) {
    const sender = player.admin ? ADMIN_SENDER : player.ign;
    if (command.target.toLowerCase() === sender.toLowerCase()) return json({ error: 'You can’t whisper to yourself.', reason: 'command' }, 400);
    const res = await link(env).fetch('https://link/whisper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sendAs, admin: !!player.admin, key: player.admin ? who.email : player.ign, target: command.target, text: command.text }),
    });
    const r = await res.json().catch(() => ({ error: 'Something went wrong.' }));
    if (!res.ok) return json(r, res.status);
    const whisper = await deliverWhisper(env, { sender, target: r.to, text: command.text, via: 'web' });
    return json({ ok: true, whisper, where: r.where, unsure: !!r.unsure });
  }

  const began = Date.now();
  const res = await link(env).fetch('https://link/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(player.admin ? { admin: true, key: who.email, text } : { name: sendAs, key: player.ign, text }),
  });
  console.log(`web chat send: HTTP ${res.status} after ${Date.now() - began}ms`);
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export class ServerLink extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // one per server, named by its id; this.env is that server's (its database, its other objects)
    this.env = siblingEnv(env, ctx);
    this.pending = new Map(); // message id -> resolve, while a send waits for the mod's answer
    this.late = new Map(); // message id -> when it was sent, for the ones that got no answer in time
    this.sent = new Map(); // player -> times of their recent messages
    this.web = null; // roster players with the dashboard open (src/presence.js), for whispers typed in game
    this.keyTries = new Map(); // account -> times of its recent Liveview key tries
    this.access = null; // the server's list of accounts that may use Liveview (kept in storage)
    this.started = Date.now();
    this.log = null; // recent connects and closes, kept in storage: [{ at, what }]
    ctx.setWebSocketAutoResponse(); // no automatic reply: pings are answered in webSocketMessage
  }

  async liveAccess() {
    this.access ??= (await this.ctx.storage.get('liveview_access')) ?? {};
    return this.access;
  }

  async webList() {
    this.web ??= (await this.ctx.storage.get('web')) ?? [];
    return this.web;
  }

  // At most one message every GAP_MS per sender, and BURST in any BURST_MS. A Response when it's too soon.
  limited(key) {
    const now = Date.now();
    const times = (this.sent.get(key) || []).filter((t) => now - t < BURST_MS);
    if (times.length && now - times[times.length - 1] < GAP_MS) return json({ error: 'Slow down a little.', reason: 'rate' }, 429);
    if (times.length >= BURST) return json({ error: 'Too many messages; wait a few seconds.', reason: 'rate' }, 429);
    times.push(now);
    this.sent.set(key, times);
    return null;
  }

  // Sends the mod a message that it answers with an ack: { ok, error } or { ok: false, unsure: true }.
  async ask(ws, message) {
    const id = crypto.randomUUID();
    const answer = new Promise((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => resolve({ ok: false, unsure: true }), ACK_MS);
    });
    try {
      ws.send(JSON.stringify({ ...message, id }));
    } catch {
      this.pending.delete(id);
      return null; // not connected after all
    }
    const sent = Date.now();
    const r = await answer;
    this.pending.delete(id);
    if (r.unsure) {
      const a = ws.deserializeAttachment() || {};
      this.late.set(id, sent);
      if (this.late.size > 50) this.late.delete(this.late.keys().next().value);
      this.note(`no answer to a ${message.type} within ${ACK_MS / 1000}s (connection ${ws.readyState === WebSocket.OPEN ? 'open' : 'not open'}, `
        + `last heard ${Math.round((Date.now() - (a.heard || 0)) / 1000)}s ago, ${this.ctx.getWebSockets().length} socket(s))`);
    }
    return r;
  }

  // The mod's connection, if there's a live one. One that hasn't been heard from for QUIET_MS (no
  // ping, no answer) is dead even if it still looks open from here, so it's closed and doesn't count:
  // a message sent down it would just wait for an answer that never comes.
  socket() {
    const now = Date.now();
    let live = null;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue; // closing: a newer connection replaced it
      const a = ws.deserializeAttachment() || {};
      if (now - (a.heard || 0) > QUIET_MS) {
        this.note(`dropped a connection not heard from for ${Math.round((now - (a.heard || 0)) / 1000)}s`);
        try { ws.close(4001, 'went quiet'); } catch {}
        this.ctx.waitUntil(this.gone(ws));
        continue;
      }
      if (!live || (a.at || 0) >= (live.deserializeAttachment()?.at || 0)) live = ws;
    }
    return live;
  }

  // Heard from the mod on this connection just now.
  heard(ws) {
    const a = ws.deserializeAttachment() || {};
    ws.serializeAttachment({ ...a, heard: Date.now() });
  }

  note(what) {
    console.log(`web chat link: ${what}`);
    this.ctx.waitUntil((async () => {
      this.log ??= (await this.ctx.storage.get('log')) ?? [];
      this.log.push({ at: Date.now(), what });
      if (this.log.length > 30) this.log.splice(0, this.log.length - 30);
      await this.ctx.storage.put('log', this.log);
    })());
  }

  async fetch(request) {
    const reqUrl = new URL(request.url);
    const path = reqUrl.pathname;

    if (path === '/connect') {
      const page = reqUrl.searchParams.get('page') || '';
      // One server at a time: a new connection (say, after a restart) replaces any old one.
      for (const old of this.ctx.getWebSockets()) {
        try { old.close(4000, 'replaced by a newer connection'); } catch {}
      }
      const [client, server] = Object.values(new WebSocketPair());
      // the mod's version, from its User-Agent ("mcstats-chat/1.8.0"): whispers need 1.8.0
      const version = (request.headers.get('User-Agent') || '').match(/mcstats-chat\/(\d+)\.(\d+)/);
      const ua = (request.headers.get('User-Agent') || '').match(/mcstats-chat\/([\w.+-]{1,20})/);
      // and the game's ("mcstats-chat/2.3.0 (Minecraft 1.21.11)", from 2.3.0), for offering the right jar
      const mc = (request.headers.get('User-Agent') || '').match(/\(Minecraft ([\w.+-]{1,24})\)/);
      server.serializeAttachment({
        whispers: !!version && (Number(version[1]) > 1 || (Number(version[1]) === 1 && Number(version[2]) >= 8)),
        version: ua ? ua[1] : null, minecraft: mc ? mc[1] : null, at: Date.now(), heard: Date.now(), page,
      });
      this.note(`mod ${ua ? ua[1] : '(unknown version)'} connected${mc ? ` (Minecraft ${mc[1]})` : ''}`);
      // kept for the admin page while the mod isn't connected (it still needs updating then)
      if (ua) this.ctx.waitUntil(this.ctx.storage.put('version', ua[1]));
      if (mc) this.ctx.waitUntil(this.ctx.storage.put('minecraft', mc[1]));
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'hello', max: MAX_WEB_CHAT, ...(page && { page }) }));
      // a newer mod than this one is out (src/modupdate.js): 2.1.0 and newer tell operators in game; older ones ignore it
      const update = ua ? modUpdateMessage(ua[1], 8, mc ? mc[1] : null) : null;
      if (update) server.send(JSON.stringify(update));
      server.send(JSON.stringify({ type: 'web', names: await this.webList() }));
      this.ctx.waitUntil(tellPresence(this.env, '/link', { up: true }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // who has the dashboard open changed (src/presence.js): { names }
    if (path === '/web' && request.method === 'POST') {
      const { names } = await request.json();
      this.web = Array.isArray(names) ? names.filter((n) => typeof n === 'string').slice(0, 500) : [];
      await this.ctx.storage.put('web', this.web);
      const ws = this.socket();
      if (ws) try { ws.send(JSON.stringify({ type: 'web', names: this.web })); } catch {}
      return json({ ok: true });
    }

    // a whisper typed on the website: { name, admin, key, target, text }. To the player in game if
    // they're on, otherwise to their page if they have the dashboard open. The answer says where:
    // { to (their name as the server has it), where: 'game' | 'web' }.
    if (path === '/whisper' && request.method === 'POST') {
      const { name = null, admin = false, key, target, text } = await request.json();
      const slow = this.limited(key);
      if (slow) return slow;
      let state = { game: [], web: [] };
      try {
        state = await (await this.env.PRESENCE.get(this.env.PRESENCE.idFromName('server')).fetch('https://presence/state')).json();
      } catch (err) {
        console.error('whisper state:', err.message);
      }
      const find = (list) => (list || []).find((n) => n.toLowerCase() === target.toLowerCase());
      const inGame = find(state.game), onWeb = find(state.web);
      const ws = this.socket();
      const canWhisper = !!ws?.deserializeAttachment()?.whispers;
      if (inGame && ws && !canWhisper && !onWeb) {
        return json({ error: `The server's mcstats-chat mod is too old to pass whispers on (it needs 1.8.0 or newer).`, reason: 'refused' }, 503);
      }
      if (inGame && ws && canWhisper) {
        const r = await this.ask(ws, admin ? { type: 'whisper', admin: true, to: inGame, text } : { type: 'whisper', name, to: inGame, text });
        if (r?.ok) return json({ ok: true, to: inGame, where: 'game' });
        if (r?.unsure) return json({ ok: true, to: inGame, where: 'game', unsure: true });
        if (!onWeb) return json({ error: r?.error || 'No player was found.', reason: 'refused' }, r ? 404 : 503);
      }
      if (onWeb) return json({ ok: true, to: onWeb, where: 'web' });
      if (inGame) return json({ error: `The server isn't connected right now, so this can't reach ${inGame} in game.`, reason: 'offline' }, 503);
      return json({ error: `No player was found called ${target}, in game or on the website.`, reason: 'refused' }, 404);
    }

    // Liveview: someone wants to watch, so the mod should open its Liveview connection. { ok } (false: not connected)
    if (path === '/liveview/open' && request.method === 'POST') {
      const ws = this.socket();
      if (!ws) return json({ ok: false });
      try { ws.send(JSON.stringify({ type: 'liveview_open' })); } catch { return json({ ok: false }); }
      return json({ ok: true });
    }

    // Liveview: a key typed on the dashboard, for the mod to check: { level, key, who }. Answers
    // { ok: true, key_id } or { ok: false, reason: 'wrong' | 'not_set' | 'limited' | 'off' | 'offline' }.
    if (path === '/liveview/verify' && request.method === 'POST') {
      const { level, key, who } = await request.json();
      const ws = this.socket();
      if (!ws) return json({ ok: false, reason: 'offline' });
      // wrong keys are counted by the mod too; this keeps one account from hammering it
      const now = Date.now();
      const tries = (this.keyTries.get(who) || []).filter((t) => now - t < 60_000);
      if (tries.length >= 8) return json({ ok: false, reason: 'limited' });
      tries.push(now);
      this.keyTries.set(who, tries);
      if (this.keyTries.size > 500) this.keyTries.delete(this.keyTries.keys().next().value);
      const r = await this.ask(ws, { type: 'liveview_key', level, key, who });
      if (!r || r.unsure) return json({ ok: false, reason: 'offline' });
      if (r.ok && r.key_id) return json({ ok: true, key_id: r.key_id });
      return json({ ok: false, reason: ['wrong', 'not_set', 'limited', 'off'].includes(r.error) ? r.error : 'off' });
    }

    if (path === '/status') {
      const ws = this.socket();
      const a = ws?.deserializeAttachment() || {};
      const now = Date.now();
      const ago = (t) => (t ? Math.round((now - t) / 1000) : null);
      this.log ??= (await this.ctx.storage.get('log')) ?? [];
      return json({
        linked: !!ws, sockets: this.ctx.getWebSockets().length, version: a.version ?? null,
        // the version of the mod last connected, connected now or not
        last_version: a.version ?? (await this.ctx.storage.get('version')) ?? null,
        // the Minecraft version it last said it runs on (mods from 2.3.0 say), or null
        minecraft: a.minecraft ?? (await this.ctx.storage.get('minecraft')) ?? null,
        // what the mod said about Liveview: { enabled, control, viewer_key, control_key, access: { email: 'viewer' | 'control' } }
        liveview: a.live ? { ...a.live, access: await this.liveAccess() } : null,
        connected_ago: ago(a.at), heard_ago: ago(a.heard), started_ago: ago(this.started),
        log: this.log.slice(-12).map((e) => ({ ago: ago(e.at), what: e.what })),
      });
    }

    // A round trip to the mod that shows nothing in game: a message without a sender, which the mod
    // refuses with "bad message". { ok (it answered), ms, answer } or { ok: false, why }.
    if (path === '/probe') {
      const ws = this.socket();
      if (!ws) return json({ ok: false, why: 'not connected' });
      const began = Date.now();
      const r = await this.ask(ws, { type: 'say', name: '', text: 'connection test' });
      if (!r) return json({ ok: false, why: 'not connected' });
      if (r.unsure) return json({ ok: false, why: `no answer within ${ACK_MS / 1000}s`, ms: Date.now() - began });
      return json({ ok: true, ms: Date.now() - began, answer: r.error || 'ok' });
    }

    if (path === '/send' && request.method === 'POST') {
      const { name = null, admin = false, key, text } = await request.json();
      const ws = this.socket();
      if (!ws) return json({ error: "The server isn't connected right now, so messages can't reach the game.", reason: 'offline' }, 503);

      const slow = this.limited(key);
      if (slow) return slow;
      const began = Date.now();
      const r = await this.ask(ws, admin ? { type: 'say', admin: true, text } : { type: 'say', name, text });
      if (!r) return json({ error: "The server isn't connected right now.", reason: 'offline' }, 503);
      const took = Date.now() - began;
      if (!r.ok && !r.unsure) this.note(`the mod refused a message after ${(took / 1000).toFixed(1)}s: "${String(r.error).slice(0, 60)}"`);
      else if (r.ok && took > 1500) this.note(`a message took ${(took / 1000).toFixed(1)}s to be shown`);
      if (/too busy/.test(r.error || '')) {
        return json({ error: 'The Minecraft server was too busy to show that message (it may be lagging). Nothing was sent; try again in a moment.', reason: 'refused' }, 502);
      }
      // No answer in time (or an older mod saying it's busy, which can still show the message a moment later)
      // isn't a no: the page keeps the message as sending and watches the log for it.
      if (r.unsure || r.error === 'the server is busy') return json({ ok: false, unsure: true, name, admin, text }, 202);
      return r.ok ? json({ ok: true, name, admin, text }) : json({ error: r.error || 'The server refused the message.', reason: 'refused' }, 502);
    }

    return json({ error: 'not found' }, 404);
  }

  // The mod answers each message: { type: 'ack', id, ok, error? }.
  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    this.heard(ws);
    if (message === 'ping') {
      try { ws.send('pong'); } catch {}
      return;
    }
    let m;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    if (m?.type === 'ack' && typeof m.id === 'string') {
      if (this.late.has(m.id)) {
        this.note(`the answer came late, ${((Date.now() - this.late.get(m.id)) / 1000).toFixed(1)}s after sending (ok: ${m.ok === true}${m.error ? `, "${String(m.error).slice(0, 60)}"` : ''})`);
        this.late.delete(m.id);
      } else if (!this.pending.has(m.id)) {
        this.note(`an answer came for a message no longer waited on (ok: ${m.ok === true})`);
      }
      this.pending.get(m.id)?.({
        ok: m.ok === true, error: typeof m.error === 'string' ? m.error.slice(0, 200) : null,
        key_id: typeof m.key_id === 'string' && /^[0-9a-f]{8,32}$/.test(m.key_id) ? m.key_id : null, // a Liveview key check
      });
    }
    // Liveview on the server (mod 2.0.0): whether it's on, whether commands are allowed, and the ids of its
    // two keys. Sent when the mod connects and whenever any of it changes; kept with the connection.
    if (m?.type === 'liveview') {
      const id = (v) => (typeof v === 'string' && /^[0-9a-f]{8,32}$/.test(v) ? v : null);
      const a = ws.deserializeAttachment() || {};
      ws.serializeAttachment({
        ...a, live: { enabled: m.enabled === true, control: m.control === true, viewer_key: id(m.viewer_key), control_key: id(m.control_key) },
      });
      // The accounts the server lets in. It's the server's list: this side only keeps a copy (in storage,
      // as it can outgrow what a connection can carry) and never adds to it.
      const access = {};
      if (m.access && typeof m.access === 'object') {
        for (const [email, level] of Object.entries(m.access).slice(0, 500)) {
          if (typeof email === 'string' && email.length <= 120 && (level === 'viewer' || level === 'control')) access[email.toLowerCase()] = level;
        }
      }
      this.access = access;
      await this.ctx.storage.put('liveview_access', access);
    }
    // a player connecting their mcstats account from in game (mod 2.3.0, src/connect.js): { id, action, uuid, name, email? }
    if (m?.type === 'account' && typeof m.id === 'string') {
      let a;
      try {
        a = await accountRequest(this.env, m, (ws.deserializeAttachment() || {}).page || '');
      } catch (err) {
        console.error('account from game:', err.message);
        a = { ok: false, error: "the website couldn't keep it" };
      }
      try { ws.send(JSON.stringify({ type: 'ack', id: m.id, ...a })); } catch {}
      return;
    }
    // typed in game to a player who's only on the website (mod 1.8.0): { id, from, to, text }
    if (m?.type === 'whisper' && typeof m.id === 'string') {
      const answer = (error) => { try { ws.send(JSON.stringify({ type: 'ack', id: m.id, ok: !error, ...(error ? { error } : {}) })); } catch {} };
      const from = typeof m.from === 'string' && IGN_RE.test(m.from) ? m.from : null;
      const text = typeof m.text === 'string' ? cleanWebText(m.text) : '';
      const to = typeof m.to === 'string' ? (await this.webList()).find((n) => n.toLowerCase() === m.to.toLowerCase()) : null;
      if (!from || !text) return answer('bad message');
      if (!to) return answer(`${m.to} isn't on the website any more`);
      try {
        await deliverWhisper(this.env, { sender: from, target: to, text, via: 'game' });
        answer(null);
      } catch (err) {
        console.error('whisper from game:', err.message);
        answer("the dashboard couldn't keep it");
      }
    }
  }

  // The mod's connection is gone (unless a newer one replaced it): pages' message boxes say so.
  async gone(ws) {
    if (!this.ctx.getWebSockets().some((s) => s !== ws)) await tellPresence(this.env, '/link', { up: false });
  }

  async webSocketClose(ws, code, reason) {
    this.note(`connection closed (${code}${reason ? `: ${reason}` : ''})`);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); } catch {}
    await this.gone(ws);
  }

  async webSocketError(ws, error) {
    this.note(`connection error (${String(error?.message || error).slice(0, 80)})`);
    try { ws.close(1011, 'error'); } catch {}
    await this.gone(ws);
  }
}
