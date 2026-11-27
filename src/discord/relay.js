// DiscordRelay: one per server (named by its id, like ServerLink and Presence). Everything the bot posts on its
// own (as opposed to answering a command) goes through here: game chat, events, the status message and the
// daily summary. It keeps an outbox in its own SQLite and posts from it on an alarm, so a slow or unreachable
// Discord never holds up the mod's uploads, and one server's posts never wait behind another's.
//
//   enqueue(items)   from the uploads (tellRelay, below): chat lines and events, already checked against what
//                    the server shares and where its feeds go
//   deleted(ids)     chat lines an admin deleted on the dashboard (or deaths left out of Combat): their posts go
//   changed()        the feeds or what's shared changed: the status message is redrawn, queued posts re-checked
//   welcome()        after a setup: the welcome message and a fresh status message
//   forget()         unlinked: the status message is deleted and everything here dropped
//   state()          for Admin → Discord and /mcstats status: queue, last posts, errors
//   test()           posts a test message to each feed
//
// Sending: each webhook (or channel, when a feed has no webhook and posts as the bot) is its own rate-limit
// bucket, read from Discord's headers. A 429 waits retry_after; a 5xx backs off (2 s, 4 s, … at most 6 tries);
// a 401/403/404 stops that feed and says why on the admin page. Chat older than 10 minutes and events older
// than an hour are dropped rather than posted late, and the outbox never holds more than 2,000 rows.
import { DurableObject } from 'cloudflare:workers';
import { scoped, siblingEnv } from '../tenantenv.js';
import { serverById } from '../directory.js';
import { describeDeath } from '../combat.js';
import { discord, problem } from './api.js';
import { getConfig, getFeeds, getLink, noteFeed, setBroken } from './store.js';
import { openServer } from './server.js';
import { daySummary, lastHours, onlineNow, teamsOf } from './data.js';
import { digestEmbed, eventLine, faceUrl, NO_PINGS, onlineEmbed } from './render.js';
import { clip, dayStart, esc, hourIn } from './text.js';

const SECOND = 1000;
const CHAT_MAX_AGE = 10 * 60 * SECOND;
const EVENT_MAX_AGE = 60 * 60 * SECOND;
const MAX_ROWS = 2000;
const MAX_TRIES = 6;
const STATUS_GAP = 30 * SECOND; // the status message is redrawn at most this often
const STATUS_EVERY = 10 * 60 * SECOND; // and at least this often, so "Updated" stays true
const BATCH_AFTER = 5; // more chat lines than this waiting: posted together in one message

const CHAT_KINDS = new Set(['chat', 'emote', 'say']);
const EVENT_OF = { join: 'joins', leave: 'joins', death: 'deaths', advancement: 'advancements', server: 'server', season: 'season' };

export const relayOf = (env, serverId) => {
  const ns = env.DISCORD_RELAY?.idFromName ? env.DISCORD_RELAY : null;
  if (!ns) return nullRelay;
  const s = scoped(ns, serverId);
  return s.get(s.idFromName('server'));
};
const nullRelay = new Proxy({}, { get: () => async () => null });

// Called by the uploads, inside the server's Tenant: rows the chat ingest just stored (src/chat.js), already
// cleaned. Never throws: a Discord problem mustn't fail an upload. Costs one local read when the server isn't
// linked to Discord.
export async function tellRelay(env, rows) {
  try {
    if (!rows?.length || !env.TENANT?.id || !env.RAW?.DISCORD_RELAY) return;
    const link = await env.DB.prepare('SELECT guild_id FROM discord_link WHERE id = 1 AND broken IS NULL').first().catch(() => null);
    if (!link) return;
    const items = [];
    for (const r of rows) {
      if (r.hidden) continue; // hidden by Admin → Chat rules
      if (r.via === 'discord') continue; // it came from Discord: no echo
      if (r.kind === 'death' && r.name) {
        // the same deaths Combat counts: not a border death nobody caused (src/combat.js)
        const d = describeDeath({ name: r.name, text: r.text, rich: r.rich ? safeJson(r.rich) : null, death: r.death });
        if (d.cause === 'border' && !d.killer) continue;
      }
      if (CHAT_KINDS.has(r.kind) || EVENT_OF[r.kind]) items.push({ event_id: r.event_id, ts: r.ts, kind: r.kind, name: r.name, uuid: r.uuid, text: r.text, via: r.via });
    }
    if (items.length) await relayOf(env.RAW, env.TENANT.id).enqueue(items);
  } catch (err) {
    console.error('discord relay:', err.message);
  }
}

// A season started (src/seasonadmin.js).
export async function tellSeason(env, n) {
  try {
    if (!env.TENANT?.id || !env.RAW?.DISCORD_RELAY) return;
    await relayOf(env.RAW, env.TENANT.id).enqueue([{ event_id: `season-${n}-${Date.now()}`, ts: Date.now(), kind: 'season', n }]);
  } catch (err) {
    console.error('discord relay:', err.message);
  }
}

// Chat lines deleted on the dashboard (src/admin.js).
export async function tellDeleted(env, eventIds) {
  try {
    if (!eventIds?.length || !env.TENANT?.id || !env.RAW?.DISCORD_RELAY) return;
    await relayOf(env.RAW, env.TENANT.id).deleted(eventIds);
  } catch (err) {
    console.error('discord relay:', err.message);
  }
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

export class DiscordRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.raw = env;
    this.id = ctx.id.name;
    this.env = siblingEnv(env, ctx);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, feed TEXT NOT NULL, kind TEXT NOT NULL,
      at INTEGER NOT NULL, due INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS posts (event_id TEXT PRIMARY KEY, feed TEXT NOT NULL, message_id TEXT NOT NULL,
      line TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS posts_message ON posts (message_id)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.buckets = new Map(); // webhook or channel id -> don't send before (ms)
  }

  get(key) {
    const r = this.sql.exec('SELECT value FROM state WHERE key = ?', key).toArray()[0];
    return r ? JSON.parse(r.value) : null;
  }

  set(key, value) {
    if (value == null) this.sql.exec('DELETE FROM state WHERE key = ?', key);
    else this.sql.exec('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  // The server as the commands see it (src/discord/server.js), with its feeds and what it shares.
  async server() {
    const row = await serverById(this.raw, this.id);
    if (!row) return null;
    const srv = await openServer(this.raw, row, this.raw.SITE_ORIGIN || 'https://mcstats.live');
    if (!srv.link || srv.link.broken) return null;
    srv.feeds = await getFeeds(srv.db, { secrets: true });
    return srv;
  }

  async wake(at = Date.now() + SECOND) {
    const now = await this.ctx.storage.getAlarm();
    if (now == null || now > at) await this.ctx.storage.setAlarm(Math.max(at, Date.now()));
  }

  // ---------- RPC ----------

  async enqueue(items) {
    const db = this.env.DB;
    const [feedsRaw, linkRow] = await Promise.all([getFeeds(db), getLink(db)]);
    if (!linkRow || linkRow.broken) return { queued: 0 };
    const isPublic = (await db.prepare("SELECT value FROM settings WHERE key = 'PUBLIC'").first('value').catch(() => null)) === '1';
    const config = await getConfig(db, isPublic).catch(() => null);
    const share = config?.share || {};
    // hidden players and other accounts, as the dashboard shows them (src/hidden.js, src/aliases.js)
    const [hidden, aliases] = await db.batch([
      db.prepare('SELECT name FROM hidden_players'),
      db.prepare('SELECT alias, name FROM player_aliases'),
    ]).then(([h, a]) => [new Set(h.results.map((r) => r.name.toLowerCase())), new Map(a.results.map((r) => [r.alias.toLowerCase(), r.name]))]);
    const now = Date.now();
    let queued = 0, status = false;
    for (const e of items) {
      if (e.name && hidden.has(String(e.name).toLowerCase())) continue;
      const item = { ...e, name: e.name ? aliases.get(e.name.toLowerCase()) || e.name : e.name };
      if (['join', 'leave', 'server'].includes(e.kind)) status = true;
      let feed = null;
      if (CHAT_KINDS.has(e.kind)) feed = share.chat && feedsRaw.chat ? 'chat' : null;
      else if (EVENT_OF[e.kind]) {
        const opt = feedsRaw.events?.options || {};
        const kind = EVENT_OF[e.kind];
        const shared = kind === 'deaths' ? share.deaths : kind === 'advancements' ? share.advancements : true;
        feed = feedsRaw.events && opt[kind] !== false && shared ? 'events' : null;
      }
      if (!feed) continue;
      this.sql.exec('INSERT INTO outbox (feed, kind, at, due, body) VALUES (?, ?, ?, ?, ?)', feed, e.kind, e.ts || now, now, JSON.stringify(item));
      queued++;
    }
    // the outbox never grows past MAX_ROWS: the oldest chat goes first
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM outbox').one().n;
    if (n > MAX_ROWS) {
      const drop = n - MAX_ROWS;
      this.sql.exec("DELETE FROM outbox WHERE seq IN (SELECT seq FROM outbox ORDER BY feed = 'chat' DESC, seq LIMIT ?)", drop);
      this.set('dropped', (this.get('dropped') || 0) + drop);
    }
    if (status && feedsRaw.status) this.set('status_due', Math.max(now, (this.get('status_at') || 0) + STATUS_GAP));
    if (queued || status) await this.wake();
    return { queued };
  }

  async changed() {
    this.set('status_due', Date.now());
    await this.wake();
    return { ok: true };
  }

  async welcome() {
    this.set('welcome', true);
    this.set('status_msg', null); // a new setup gets a new status message, in its (maybe new) channel
    this.set('status_due', Date.now());
    await this.wake();
    return { ok: true };
  }

  async forget() {
    const msg = this.get('status_msg');
    if (msg) await this.deleteMessage(msg).catch(() => {});
    this.sql.exec('DELETE FROM outbox');
    this.sql.exec('DELETE FROM posts');
    this.sql.exec('DELETE FROM state');
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  async deleted(eventIds) {
    const srv = await this.server();
    if (!srv) return { ok: false };
    let n = 0;
    for (const id of eventIds.slice(0, 100)) {
      // still waiting to be posted: it simply isn't
      this.sql.exec("DELETE FROM outbox WHERE json_extract(body, '$.event_id') = ?", id);
      const post = this.sql.exec('SELECT feed, message_id FROM posts WHERE event_id = ?', id).toArray()[0];
      if (!post) continue;
      const feed = srv.feeds[post.feed];
      this.sql.exec('DELETE FROM posts WHERE event_id = ?', id);
      if (!feed) continue;
      const rest = this.sql.exec('SELECT line FROM posts WHERE message_id = ? ORDER BY at', post.message_id).toArray().map((r) => r.line);
      const target = { feed: post.feed, id: post.message_id, channel: feed.channel_id, webhook_id: feed.webhook_id, webhook_token: feed.webhook_token };
      if (rest.length) await this.editMessage(target, { content: clip(rest.join('\n'), 2000), allowed_mentions: NO_PINGS });
      else await this.deleteMessage(target);
      n++;
    }
    return { ok: true, removed: n };
  }

  async state() {
    const queued = this.sql.exec('SELECT feed, COUNT(*) AS n, MIN(at) AS oldest FROM outbox GROUP BY feed').toArray();
    return {
      queued: Object.fromEntries(queued.map((r) => [r.feed, { n: r.n, oldest: r.oldest }])),
      dropped: this.get('dropped') || 0,
      status_msg: this.get('status_msg'),
      status_at: this.get('status_at'),
      digest_day: this.get('digest_day'),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  async test() {
    const srv = await this.server();
    if (!srv) return { ok: false, results: {} };
    const results = {};
    for (const [feed, f] of Object.entries(srv.feeds)) {
      const r = await this.post(srv, feed, f, {
        content: `✅ mcstats test: the ${feed === 'status' ? 'status message' : feed === 'digest' ? 'daily summary' : feed} for **${esc(srv.name)}** posts here.`,
        ...(f.webhook_id ? { username: 'mcstats' } : {}),
      });
      results[feed] = r.ok ? 'ok' : problem(r);
    }
    return { ok: true, results };
  }

  // ---------- the alarm: posting ----------

  async alarm() {
    const srv = await this.server().catch((err) => { console.error('discord relay:', err.message); return null; });
    if (!srv) {
      // unlinked, or broken: nothing to post
      this.sql.exec('DELETE FROM outbox');
      return;
    }
    const now = Date.now();
    // stale posts go rather than turning up late
    this.sql.exec("DELETE FROM outbox WHERE (feed = 'chat' AND at < ?) OR at < ?", now - CHAT_MAX_AGE, now - EVENT_MAX_AGE);
    for (const feed of ['chat', 'events']) {
      const f = srv.feeds[feed];
      if (!f) { this.sql.exec('DELETE FROM outbox WHERE feed = ?', feed); continue; }
      await this.flush(srv, feed, f, now);
    }
    if (this.get('welcome') && Object.keys(srv.feeds).length) await this.sendWelcome(srv);
    await this.statusMessage(srv, now);
    await this.digest(srv, now);
    await this.schedule(srv);
  }

  async schedule(srv) {
    const next = [];
    const due = this.sql.exec('SELECT MIN(due) AS due FROM outbox').one().due;
    if (due != null) next.push(due);
    for (const until of this.buckets.values()) if (until > Date.now()) next.push(until);
    if (srv.feeds.status) next.push(this.get('status_due') ?? (this.get('status_at') || 0) + STATUS_EVERY);
    if (srv.feeds.digest) next.push(Math.ceil((Date.now() + 1) / 3_600_000) * 3_600_000 + 60 * SECOND); // just past each hour
    const at = Math.max(Date.now() + SECOND, Math.min(...next.filter((t) => t != null && Number.isFinite(t))));
    if (Number.isFinite(at)) await this.ctx.storage.setAlarm(at);
  }

  bucketOf(f) {
    return f.webhook_id || f.channel_id;
  }

  async flush(srv, feed, f, now) {
    const bucket = this.bucketOf(f);
    if ((this.buckets.get(bucket) || 0) > now) return;
    const rows = this.sql.exec('SELECT seq, kind, at, tries, body FROM outbox WHERE feed = ? AND due <= ? ORDER BY seq LIMIT 60', feed, now).toArray();
    if (!rows.length) return;
    const items = rows.map((r) => ({ ...JSON.parse(r.body), seq: r.seq, tries: r.tries }));
    // what goes in each message: events always as one list; chat one line each (as the player), unless it's
    // fallen behind, when it goes in one message like the events
    const groups = [];
    if (feed === 'events' || items.length > BATCH_AFTER || !f.webhook_id) {
      let cur = [];
      let len = 0;
      for (const it of items) {
        const line = feed === 'events' ? eventLine(it) : chatLine(it, !f.webhook_id || items.length > BATCH_AFTER);
        if (cur.length && len + line.length + 1 > 1900) { groups.push(cur); cur = []; len = 0; }
        cur.push({ it, line });
        len += line.length + 1;
      }
      if (cur.length) groups.push(cur);
    } else {
      for (const it of items) groups.push([{ it, line: it.kind === 'emote' ? `_${esc(it.text)}_` : esc(it.text), single: true }]);
    }
    for (const g of groups) {
      const first = g[0];
      const body = first.single
        ? { content: clip(first.line, 2000), username: chatUsername(first.it), ...(faceUrl(srv, first.it.uuid) ? { avatar_url: faceUrl(srv, first.it.uuid) } : {}) }
        : { content: clip(g.map((x) => x.line).join('\n'), 2000), ...(f.webhook_id ? { username: feed === 'events' ? srv.name.slice(0, 80) : 'Minecraft chat' } : {}) };
      const r = await this.post(srv, feed, f, body);
      const seqs = g.map((x) => x.it.seq);
      if (r.ok) {
        const stmt = 'INSERT OR REPLACE INTO posts (event_id, feed, message_id, line, at) VALUES (?, ?, ?, ?, ?)';
        for (const x of g) if (x.it.event_id && r.data?.id) this.sql.exec(stmt, x.it.event_id, feed, r.data.id, x.line, Date.now());
        this.sql.exec(`DELETE FROM outbox WHERE seq IN (${seqs.map(() => '?').join(',')})`, ...seqs);
        continue;
      }
      if (r.kind === 'rate') return; // the bucket waits; everything stays queued
      if (r.kind === 'gone' || r.kind === 'bad') {
        // this feed's posts are dropped (sending them again would only fail again)
        this.sql.exec('DELETE FROM outbox WHERE feed = ?', feed);
        return;
      }
      // retry later, backing off; after MAX_TRIES it's dropped
      const tries = first.it.tries + 1;
      if (tries >= MAX_TRIES) this.sql.exec(`DELETE FROM outbox WHERE seq IN (${seqs.map(() => '?').join(',')})`, ...seqs);
      else this.sql.exec(`UPDATE outbox SET tries = ?, due = ? WHERE seq IN (${seqs.map(() => '?').join(',')})`, tries, Date.now() + Math.min(60, 2 ** tries) * SECOND, ...seqs);
      return;
    }
  }

  // Posts one message for a feed: through its webhook, or as the bot when it has none. Keeps to the bucket's
  // limits and notes how it went (on the admin page).
  async post(srv, feed, f, body) {
    const msg = { allowed_mentions: NO_PINGS, ...body };
    const r = f.webhook_id && f.webhook_token
      ? await discord(this.raw, 'POST', `/webhooks/${f.webhook_id}/${f.webhook_token}?wait=true`, msg, { auth: 'none' })
      : await discord(this.raw, 'POST', `/channels/${f.channel_id}/messages`, strip(msg));
    await this.after(srv, feed, f, r);
    return r;
  }

  async after(srv, feed, f, r) {
    const bucket = this.bucketOf(f);
    if (r.kind === 'rate') this.buckets.set(bucket, Date.now() + r.retryAfter * SECOND);
    else if (r.remaining === 0 && r.resetAfter) this.buckets.set(bucket, Date.now() + r.resetAfter * SECOND);
    else this.buckets.delete(bucket);
    if (r.ok) await noteFeed(srv.db, feed, null).catch(() => {});
    else if (r.kind !== 'rate') await noteFeed(srv.db, feed, problem(r)).catch(() => {});
    // the bot itself was refused or removed: the whole link is marked broken until it's set up again
    if (r.data?.code === 10004 || r.status === 401) await setBroken(srv.db, problem(r)).catch(() => {});
  }

  async editMessage(t, body) {
    const msg = { allowed_mentions: NO_PINGS, ...body };
    return t.webhook_id && t.webhook_token
      ? discord(this.raw, 'PATCH', `/webhooks/${t.webhook_id}/${t.webhook_token}/messages/${t.id}`, msg, { auth: 'none' })
      : discord(this.raw, 'PATCH', `/channels/${t.channel}/messages/${t.id}`, strip(msg));
  }

  async deleteMessage(t) {
    return t.webhook_id && t.webhook_token
      ? discord(this.raw, 'DELETE', `/webhooks/${t.webhook_id}/${t.webhook_token}/messages/${t.id}`, null, { auth: 'none' })
      : discord(this.raw, 'DELETE', `/channels/${t.channel}/messages/${t.id}`);
  }

  async sendWelcome(srv) {
    this.set('welcome', null);
    const [feed, f] = Object.entries(srv.feeds).find(([k]) => k !== 'chat') || Object.entries(srv.feeds)[0];
    const words = { status: 'the status message', events: 'joins, deaths and advancements', chat: 'the game’s chat', digest: 'a daily summary' };
    const here = Object.entries(srv.feeds).filter(([, x]) => x.channel_id === f.channel_id).map(([k]) => words[k]);
    await this.post(srv, feed, f, {
      content: `👋 mcstats is connected to **${esc(srv.name)}**. This channel gets ${here.join(', ')}. Try \`/online\`, \`/player\` or \`/top\`.`,
      ...(f.webhook_id ? { username: 'mcstats' } : {}),
    });
  }

  // The status message: one message, edited in place.
  async statusMessage(srv, now) {
    const f = srv.feeds.status;
    if (!f) return;
    const due = this.get('status_due') ?? (this.get('status_at') || 0) + STATUS_EVERY;
    if (due > now) return;
    if ((this.buckets.get(this.bucketOf(f)) || 0) > now) return;
    const [online, today, teams] = await Promise.all([onlineNow(srv), lastHours(srv, 24).catch(() => null), teamsOf(srv)]);
    const body = { embeds: [onlineEmbed(srv, online, { today, teams, live: true })], ...(f.webhook_id ? { username: srv.name.slice(0, 80) } : {}) };
    this.set('status_at', now);
    this.set('status_due', null);
    const msg = this.get('status_msg');
    if (msg && msg.channel === f.channel_id) {
      const r = await this.editMessage({ ...msg, webhook_id: f.webhook_id, webhook_token: f.webhook_token }, { embeds: body.embeds });
      await this.after(srv, 'status', f, r);
      if (r.ok || r.kind === 'rate' || r.kind === 'retry') return;
      // deleted (or its webhook changed): a new one below
    }
    if (msg) await this.deleteMessage({ ...msg, webhook_id: f.webhook_id, webhook_token: f.webhook_token }).catch(() => {});
    const r = await this.post(srv, 'status', f, body);
    this.set('status_msg', r.ok ? { id: r.data.id, channel: f.channel_id } : null);
  }

  // The daily summary, once a day at its hour in the server's time zone, for the day before.
  async digest(srv, now) {
    const f = srv.feeds.digest;
    if (!f) return;
    const secs = Math.floor(now / 1000);
    const day = dayStart(srv.tz, secs);
    if (this.get('digest_day') === day) return;
    if (hourIn(srv.tz, secs) < (f.options?.hour ?? 9)) return;
    this.set('digest_day', day);
    const d = await daySummary(srv, secs).catch((err) => { console.error('discord digest:', err.message); return null; });
    if (!d) return; // nobody played: no post
    await this.post(srv, 'digest', f, { embeds: [digestEmbed(srv, d)], ...(f.webhook_id ? { username: srv.name.slice(0, 80) } : {}) });
  }
}

// What a chat line looks like when it can't be posted as the player (no webhook, or several in one message).
function chatLine(it, named) {
  const who = it.via === 'admin' ? '**[Admin]**' : it.name ? `**${it.name.replace(/_/g, '\\_')}**` : '**Server**';
  const tag = it.via === 'web' ? '[Web] ' : '';
  if (it.kind === 'emote') return `* ${tag}${who} ${esc(it.text)}`;
  return named ? `${tag}${who}: ${esc(it.text)}` : esc(it.text);
}

// The name a chat line is posted under (a webhook's username: 1-80 characters, and Discord refuses some words).
function chatUsername(it) {
  const base = it.via === 'admin' ? '[Admin]' : it.name || 'Server';
  const name = `${it.via === 'web' ? '[Web] ' : ''}${base}`;
  return clip(name.replace(/discord|clyde/gi, (w) => `${w[0]}​${w.slice(1)}`), 80);
}

// A message posted as the bot can't set a username or avatar.
function strip({ username, avatar_url, ...rest }) {
  return rest;
}
