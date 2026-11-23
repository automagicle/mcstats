// One Minecraft server's object. Everything recorded for the server lives in this object's own SQLite and
// nowhere else: its migrations (src/tenant/schema.js) run when it starts. It's named by the server's id
// (src/directory.js), which only the Worker hands out, so no request can name it on its own.
//
// It answers:
//   fetch   the server's API (/api/... with the /s/<slug> taken off), sent by the Worker with
//           X-MCS-Who (what the cookies proved, src/index.js) or, for the mod's uploads, X-MCS-Ingest
//           (the key is checked here, against this server's own key table)
//   alarm   the once-a-minute status check (src/poll.js) and the hourly gap fill, for this server only
//   RPC     setup, settings, keys, members, and the database for the server's other objects (query)
import { DurableObject } from 'cloudflare:workers';
import { localDb } from './sql.js';
import { DATA_TABLES, migrate } from './tenant/schema.js';
import { SETTING_RE, tenantEnv } from './tenantenv.js';
import { handleApi } from './api.js';
import { poll } from './poll.js';
import { fillGaps } from './gapfill.js';
import { forgetPerms, loadPerms, ROLES, setRoleStmt } from './roles.js';
import { clearCache } from './cache.js';
import {
  cleanEmail, codeHash, CODE_MINUTES, CODE_TRIES, cookie, clearCookie, DAY, EMAIL_RE, ID_DAYS, newCode,
  sameString, serverPath, sessionReady, sha256Hex, signToken,
} from './session.js';
import { codeEmail, sendEmail } from './email.js';
import { ipKey, limit, tooMany } from './limiter.js';
import { json } from './util.js';
import { parseStart } from './seasons.js';

const ADDRESS_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const MINUTE = 60_000;

// Settings anyone with access may see (the page and /new show them). The rest stay inside.
const PUBLIC_SETTINGS = ['TZ_NAME', 'CURRENT_SEASON', 'CHAT_RESETS', 'PUBLIC'];

export class Tenant extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.id = ctx.id.name;
    this.db = localDb(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage);
      this.load();
      await this.arm();
    });
  }

  load() {
    this.settings = Object.fromEntries(this.ctx.storage.sql.exec('SELECT key, value FROM settings').toArray().map((r) => [r.key, r.value]));
  }

  put(key, value) {
    if (value == null || value === '') this.ctx.storage.sql.exec('DELETE FROM settings WHERE key = ?', key);
    else this.ctx.storage.sql.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  get tenant() {
    return { id: this.id, slug: this.settings.SLUG ?? null, name: this.settings.NAME ?? null };
  }

  serverEnv(extra = {}) {
    return tenantEnv(this.env, this.tenant, this.db, this.settings, extra);
  }

  // The status check runs while there's an address to check and nothing has paused the server.
  async arm() {
    const want = !!this.settings.SLUG && ADDRESS_RE.test(this.settings.MC_SERVER || '') && this.settings.PAUSED !== '1';
    const at = await this.ctx.storage.getAlarm();
    if (want && at == null) await this.ctx.storage.setAlarm(Math.ceil((Date.now() + 1) / MINUTE) * MINUTE);
    if (!want && at != null) await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const now = Math.floor(Date.now() / 1000);
    try {
      if (ADDRESS_RE.test(this.settings.MC_SERVER || '') && this.settings.PAUSED !== '1') {
        const env = this.serverEnv();
        await poll(env, now);
        // once an hour, fill in minutes an outage kept from being recorded (src/gapfill.js)
        if (Math.floor(now / 60) % 60 === 7) await fillGaps(env, now);
      }
    } finally {
      await this.arm();
    }
  }

  // ---------- RPC: for the Worker and this server's other objects ----------

  // The database, for this server's other objects (sql.js remoteDb): [{ q, p, mode }] in one transaction.
  async query(ops) {
    return this.db.run(ops);
  }

  // Makes the server (or finishes making it, if that was interrupted): its name, its owner, its first settings.
  async setup({ slug, name, owner, settings = {}, legacy = false, paused = false }) {
    this.ctx.storage.transactionSync(() => {
      if (!this.settings.SLUG) {
        this.put('SLUG', slug);
        this.put('CREATED_AT', Math.floor(Date.now() / 1000));
      }
      this.put('NAME', name);
      if (legacy) this.put('LEGACY', '1');
      if (paused) this.put('PAUSED', '1');
      for (const [k, v] of Object.entries(settings)) if (SETTING_RE.test(k)) this.put(k, v);
    });
    this.load();
    // While old data is being copied in (paused), its tables must hold exactly what's copied, so the
    // counts can be compared: the owner is added when the copy is finished (finishImport).
    if (owner && this.settings.PAUSED !== '1') {
      await setRoleStmt(this.db, cleanEmail(owner), 'owner', 'setup').run();
      forgetPerms(this.serverEnv(), cleanEmail(owner));
    }
    this.load();
    await this.arm();
    return this.info();
  }

  async info() {
    const key = this.ctx.storage.sql.exec('SELECT created_at FROM api_keys ORDER BY created_at DESC LIMIT 1').toArray()[0];
    const members = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM user_perms').one().n;
    const visible = Object.fromEntries(PUBLIC_SETTINGS.filter((k) => this.settings[k] != null).map((k) => [k, this.settings[k]]));
    return {
      ...this.tenant,
      settings: visible,
      mc_server: this.settings.MC_SERVER ?? null,
      current_season: Number(this.serverEnv().CURRENT_SEASON) || 1,
      public: this.settings.PUBLIC === '1',
      paused: this.settings.PAUSED === '1',
      legacy: this.settings.LEGACY === '1',
      key_created_at: key?.created_at ?? null,
      first_upload_at: Number(this.settings.FIRST_UPLOAD_AT) || null,
      last_upload_at: Number(this.settings.LAST_UPLOAD_AT) || null,
      members,
    };
  }

  // A new mod key (its hash). The old one is deleted in the same transaction: it stops working at once.
  async setKey(keyHash) {
    const now = Math.floor(Date.now() / 1000);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM api_keys');
      this.ctx.storage.sql.exec('INSERT INTO api_keys (key_hash, created_at) VALUES (?, ?)', keyHash, now);
    });
    return now;
  }

  // Whether `token` is this server's mod key: { ok, paused }. The first server also takes the old shared
  // CHAT_INGEST_TOKEN. An upload that gets in is noted, for /new's "waiting for your server".
  async verifyKey(token) {
    let ok = false;
    if (typeof token === 'string' && token.length >= 32 && token.length <= 200) {
      const legacy = this.settings.LEGACY === '1' && (this.env.CHAT_INGEST_TOKEN || '').length >= 32;
      if (legacy && (await sameString(token, this.env.CHAT_INGEST_TOKEN))) ok = true;
      else ok = this.ctx.storage.sql.exec('SELECT 1 FROM api_keys WHERE key_hash = ?', await sha256Hex(token)).toArray().length > 0;
    }
    if (ok) this.noteUpload();
    return { ok, paused: this.settings.PAUSED === '1' };
  }

  noteUpload() {
    const now = Math.floor(Date.now() / 1000);
    if (!this.settings.FIRST_UPLOAD_AT) this.put('FIRST_UPLOAD_AT', now);
    if (now - (Number(this.settings.LAST_UPLOAD_AT) || 0) >= 60) this.put('LAST_UPLOAD_AT', now);
    this.load();
  }

  // Changes from /new's settings step. Returns info(), or { error }.
  async updateSettings(patch) {
    const clean = {};
    for (const [k, raw] of Object.entries(patch || {})) {
      const v = raw == null ? '' : String(raw).trim();
      if (k === 'NAME') {
        if (!v || v.length > 60) return { error: 'The name is 1 to 60 characters.' };
        clean.NAME = v;
      } else if (!SETTING_RE.test(k)) {
        return { error: `unknown setting ${k}` };
      } else if (k === 'MC_SERVER') {
        if (v && !ADDRESS_RE.test(v)) return { error: 'The server address is a host name or IP, with :port if it isn’t 25565.' };
        clean[k] = v;
      } else if (k === 'PUBLIC') {
        clean[k] = v === '1' || v === 'true' ? '1' : '';
      } else if (k === 'TZ_NAME') {
        try {
          if (v) new Intl.DateTimeFormat('en', { timeZone: v });
        } catch {
          return { error: 'That isn’t a time zone (e.g. Europe/London).' };
        }
        clean[k] = v;
      } else if (k === 'CURRENT_SEASON') {
        const n = Number(v || 1);
        if (!Number.isInteger(n) || n < 1 || n > 99) return { error: 'The season is a number from 1 to 99.' };
        clean[k] = String(n);
      } else if (k === 'CHAT_RESETS') {
        if (v.split(/[\s,]+/).filter(Boolean).some((t) => parseStart(t) == null)) return { error: 'Chat resets are dates (e.g. 2026-11-15T18:00:00-08:00), separated by commas.' };
        clean[k] = v;
      } else {
        if (v && parseStart(v) == null) return { error: `${k} is a date like 2026-11-15T18:00:00-08:00.` };
        clean[k] = v;
      }
    }
    this.ctx.storage.transactionSync(() => {
      for (const [k, v] of Object.entries(clean)) this.put(k, v);
    });
    this.load();
    await clearCache(this.db);
    await this.arm();
    return this.info();
  }

  async addMember(email, role, by) {
    const e = cleanEmail(email);
    if (!EMAIL_RE.test(e) || !ROLES.includes(role) || role === 'owner') return { error: 'bad member' };
    await setRoleStmt(this.db, e, role, by).run();
    forgetPerms(this.serverEnv(), e);
    return { ok: true };
  }

  // What the cookies proved ({ viewer, email }, checked by the Worker) amounts to here:
  //   { email }        a member of this server (or a super admin) who signed in on it
  //   { email: null }  may look: joined with the password, or the server is public
  //   null             not let in
  async access(proof) {
    if (proof?.email) {
      const env = this.serverEnv();
      const perms = await loadPerms(env, { email: proof.email });
      if (perms.role || perms.super) return { email: proof.email };
    }
    if (proof?.viewer || this.settings.PUBLIC === '1') return { email: null };
    return null;
  }

  // For the Worker's own handling of a request (WebSockets, textures): who it is, and what it needs.
  async gate(proof) {
    return { who: await this.access(proof), tenant: this.tenant, settings: { ...this.settings } };
  }

  // ---------- RPC: copying the old database in (scripts/copy-tenant.mjs) ----------

  async counts() {
    return Object.fromEntries(DATA_TABLES.map((t) => [t, this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).one().n]));
  }

  // rows: [[...values]] in the order of `columns`; replaces rows with the same key, so a chunk can be sent twice.
  async importRows(table, columns, rows) {
    if (!DATA_TABLES.includes(table)) return { error: `unknown table ${table}` };
    const known = new Set(this.ctx.storage.sql.exec(`PRAGMA table_info(${table})`).toArray().map((c) => c.name));
    if (!Array.isArray(columns) || !columns.length || !columns.every((c) => typeof c === 'string' && known.has(c))) return { error: 'unknown columns' };
    if (!Array.isArray(rows) || rows.length > 5000 || rows.some((r) => !Array.isArray(r) || r.length !== columns.length)) return { error: 'bad rows' };
    const q = `INSERT OR REPLACE INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    this.ctx.storage.transactionSync(() => {
      for (const r of rows) this.ctx.storage.sql.exec(q, ...r.map((v) => (v === undefined ? null : v)));
    });
    return { ok: true, rows: rows.length };
  }

  // After the copy: the copied permissions become roles (admin where the admin page was allowed), the owner
  // stays the owner (a copied row may have replaced theirs), and uploads and status checks start again.
  // admins: the old ADMIN_EMAIL logins, who were admins by default; someone whose permissions were changed
  // keeps them, as an admin.
  async finishImport({ owner, admins = [] } = {}) {
    this.ctx.storage.sql.exec("UPDATE user_perms SET role = 'admin' WHERE admin = 1 AND role = 'member'");
    const env = this.serverEnv();
    for (const raw of admins) {
      const e = cleanEmail(raw);
      if (!EMAIL_RE.test(e) || e === cleanEmail(owner)) continue;
      const had = this.ctx.storage.sql.exec('SELECT 1 FROM user_perms WHERE email = ?', e).toArray().length;
      if (had) this.ctx.storage.sql.exec("UPDATE user_perms SET role = 'admin' WHERE email = ?", e);
      else await setRoleStmt(this.db, e, 'admin', 'copy').run();
      forgetPerms(env, e);
    }
    if (owner) {
      await setRoleStmt(this.db, cleanEmail(owner), 'owner', 'copy').run();
      forgetPerms(env, cleanEmail(owner));
    }
    this.put('PAUSED', '');
    this.load();
    await clearCache(this.db);
    await this.arm();
    return this.info();
  }

  // ---------- HTTP ----------

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('X-MCS-Ingest') === '1') {
      const auth = request.headers.get('Authorization') || '';
      const { ok, paused } = await this.verifyKey(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
      if (!ok) return json({ error: 'unauthorized' }, 401);
      // while the server's old data is being copied in, uploads wait (the mod keeps them and tries again)
      if (paused) return json({ error: 'paused' }, 503);
      return handleApi(request, this.serverEnv({ INGEST_OK: true }), url, this.ctx);
    }
    let proof = null;
    try {
      proof = JSON.parse(request.headers.get('X-MCS-Who') || 'null');
    } catch { /* nobody */ }
    if (url.pathname.startsWith('/api/auth/')) return this.auth(request, url, proof);
    const who = await this.access(proof);
    return handleApi(request, this.serverEnv(who ? { WHO: who } : {}), url, this.ctx);
  }

  // Signing in with an email code, on this server only:
  //   POST /api/auth/code    { email }         sends a code (to someone who can see the server, or a member)
  //   POST /api/auth/verify  { email, code }   signs in: the mcs_id cookie, for this server's pages only
  //   POST /api/auth/logout
  async auth(request, url, proof) {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
    const slug = this.settings.SLUG;
    if (!slug) return json({ error: 'not found' }, 404);
    const path = serverPath(slug);
    if (url.pathname === '/api/auth/logout') {
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': clearCookie('mcs_id', path) } });
    }
    if (!sessionReady(this.env)) return json({ error: 'Signing in isn’t set up yet (no SESSION_SECRET).' }, 503);
    if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);
    let b;
    try {
      const raw = await request.text();
      if (raw.length > 1024) return json({ error: 'too large' }, 413);
      b = JSON.parse(raw);
    } catch {
      return json({ error: 'bad json' }, 400);
    }
    const email = cleanEmail(b?.email);
    if (!EMAIL_RE.test(email)) return json({ error: 'That isn’t an email address.' }, 400);
    const env = this.serverEnv();
    const canLook = !!proof?.viewer || this.settings.PUBLIC === '1';
    const member = async () => {
      const p = await loadPerms(env, { email });
      return !!(p.role || p.super);
    };
    const ip = await ipKey(this.env, request);
    const now = Math.floor(Date.now() / 1000);

    if (url.pathname === '/api/auth/code') {
      const r = await limit(this.env, [[`code:${this.id}:${email}`, 5, 3600], [`code-ip:${ip}`, 20, 3600]]);
      if (!r.ok) return tooMany(r.retry);
      // Someone who can't see the server gets a code only for an email that's already a member here
      // (an invited admin, say). The answer is the same either way.
      if (canLook || (await member())) {
        const code = newCode();
        await this.db.prepare(
          'INSERT INTO login_codes (email, code_hash, expires_at, tries) VALUES (?, ?, ?, 0) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0'
        ).bind(email, await codeHash(this.id, email, code), now + CODE_MINUTES * 60).run();
        const sent = await sendEmail(this.env, { to: email, ...codeEmail(code, this.settings.NAME || slug) });
        if (!sent) return json({ error: 'The email couldn’t be sent. Try again in a minute.' }, 502);
      }
      return json({ ok: true });
    }

    if (url.pathname === '/api/auth/verify') {
      const r = await limit(this.env, [[`verify-ip:${ip}`, 30, 600]]);
      if (!r.ok) return tooMany(r.retry);
      const code = String(b?.code ?? '').replace(/\s/g, '');
      const row = await this.db.prepare('SELECT code_hash, expires_at, tries FROM login_codes WHERE email = ?').bind(email).first();
      const wrong = json({ error: 'That code isn’t right, or it has expired.' }, 400);
      if (!row || row.expires_at < now || row.tries >= CODE_TRIES || !/^\d{6}$/.test(code)) return wrong;
      if (!(await sameString(row.code_hash, await codeHash(this.id, email, code)))) {
        await this.db.prepare('UPDATE login_codes SET tries = tries + 1 WHERE email = ?').bind(email).run();
        return wrong;
      }
      await this.db.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run();
      if (!(await member())) {
        if (!canLook) return wrong;
        // anyone who can see the server becomes a member by signing in on it
        await setRoleStmt(this.db, email, 'member', 'sign-in').run();
        forgetPerms(env, email);
      }
      const token = await signToken(this.env, { k: 'id', s: this.id, e: email, x: now + ID_DAYS * DAY });
      return new Response(JSON.stringify({ ok: true, email }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': cookie('mcs_id', token, { path, maxAge: ID_DAYS * DAY }) },
      });
    }
    return json({ error: 'not found' }, 404);
  }
}

