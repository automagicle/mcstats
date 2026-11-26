// One Minecraft server's object. Everything recorded for the server lives in this object's own SQLite and
// nowhere else: its migrations (src/tenant/schema.js) run when it starts. It's named by the server's id
// (src/directory.js), which only the Worker hands out, so no request can name it on its own.
//
// It answers:
//   fetch   the server's API (/api/... with the /s/<slug> taken off), sent by the Worker with
//           X-MCS-Who (what the cookies proved: joined, and which account; src/index.js) or, for the mod's uploads, X-MCS-Ingest
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
import { cleanEmail, EMAIL_RE, sameString, sha256Hex } from './session.js';
import { limit, tooMany } from './limiter.js';
import { json } from './util.js';
import { parseStart } from './seasons.js';
import { cleanAccent, TAB_STYLES } from './look.js';
import { cleanAbout, cleanLayout, layoutSetting, MAX_ABOUT } from './layout.js';
import { ADDONS, addonList } from './addons.js';
import { handleServerAdmin } from './serveradmin.js';
import { handleSeasons } from './seasonadmin.js';
import { modOnline } from './online.js';

const ADDRESS_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const MINUTE = 60_000;

// Settings anyone with access may see (the page and /new show them). The rest stay inside.
const PUBLIC_SETTINGS = ['TZ_NAME', 'CURRENT_SEASON', 'CHAT_RESETS', 'PUBLIC', 'ACCENT', 'TAB_STYLE'];

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

  // Whether the once-a-minute check has anything to go on: an address to ping, or the server mod, which
  // reports who's online by itself (the address is optional on /new, and without one the mod's list is
  // the whole check: src/poll.js).
  collecting() {
    if (this.settings.PAUSED === '1') return false;
    return ADDRESS_RE.test(this.settings.MC_SERVER || '') || !!this.settings.FIRST_UPLOAD_AT;
  }

  // The status check runs while there's something to check and nothing has paused the server.
  async arm() {
    const want = !!this.settings.SLUG && this.collecting();
    const at = await this.ctx.storage.getAlarm();
    if (want && at == null) await this.ctx.storage.setAlarm(Math.ceil((Date.now() + 1) / MINUTE) * MINUTE);
    if (!want && at != null) await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const now = Math.floor(Date.now() / 1000);
    try {
      if (this.collecting()) {
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
      if (legacy) {
        this.put('LEGACY', '1');
        // the server from before servers had their own is Egg SMP: it keeps its eggs (src/addons.js)
        if (this.settings.ADDONS == null) this.put('ADDONS', 'eggsmp');
      }
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
    if (ok && this.noteUpload()) await this.arm(); // the mod's first upload starts the checks on a server with no address
    return { ok, paused: this.settings.PAUSED === '1' };
  }

  // Returns true for the server's first upload ever.
  noteUpload() {
    const now = Math.floor(Date.now() / 1000);
    const first = !this.settings.FIRST_UPLOAD_AT;
    if (first) this.put('FIRST_UPLOAD_AT', now);
    if (now - (Number(this.settings.LAST_UPLOAD_AT) || 0) >= 60) this.put('LAST_UPLOAD_AT', now);
    this.load();
    return first;
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
      } else if (k === 'ACCENT') {
        const a = cleanAccent(v);
        if (v && !a) return { error: 'The accent is blue, green, or a color like #3d8a26.' };
        clean[k] = a || '';
      } else if (k === 'TAB_STYLE') {
        if (v && !TAB_STYLES.includes(v)) return { error: `The tab style is ${TAB_STYLES.join(' or ')}.` };
        clean[k] = v;
      } else if (k === 'LAYOUT') {
        const layout = cleanLayout(v);
        if (!layout) return { error: 'That isn’t a layout.' };
        clean[k] = layoutSetting(layout);
      } else if (k === 'ABOUT') {
        const about = cleanAbout(raw);
        if (about.length > MAX_ABOUT) return { error: `The description is at most ${MAX_ABOUT} characters.` };
        clean[k] = about;
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

  // Which add-ons this server has (src/addons.js). Only the site's operators set this.
  async setAddons(ids) {
    // '-' for none at all, so "switched off" is remembered apart from "never set"
    this.put('ADDONS', [...new Set(ids)].filter((id) => ADDONS[id]).join(',') || '-');
    this.load();
    return addonList(this.settings);
  }

  // The server's icon (src/layout.js iconFromDataUrl made sure it's a square PNG), or null to remove it.
  // ICON_AT is when it last changed: the page asks for /api/icon?v=<ICON_AT>, so a new one is fetched at once.
  async setIcon(bytes) {
    this.ctx.storage.transactionSync(() => {
      if (bytes) {
        this.ctx.storage.sql.exec('INSERT INTO server_icon (id, png, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET png = excluded.png, updated_at = excluded.updated_at',
          bytes, Date.now());
        this.put('ICON_AT', Date.now());
      } else {
        this.ctx.storage.sql.exec('DELETE FROM server_icon');
        this.put('ICON_AT', '');
      }
    });
    this.load();
  }

  icon() {
    const row = this.ctx.storage.sql.exec('SELECT png FROM server_icon WHERE id = 1').toArray()[0];
    return row ? new Uint8Array(row.png) : null;
  }

  async addMember(email, role, by) {
    const e = cleanEmail(email);
    if (!EMAIL_RE.test(e) || !ROLES.includes(role) || role === 'owner') return { error: 'bad member' };
    await setRoleStmt(this.db, e, role, by).run();
    forgetPerms(this.serverEnv(), e);
    return { ok: true };
  }

  // What the cookies proved ({ viewer, email }, checked by the Worker) amounts to here:
  //   { email }        a member of this server (or a super admin), signed in to their mcstats account
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
  // member: the signed-in account has a role here (not just a super admin looking in).
  async gate(proof) {
    const who = await this.access(proof);
    const member = !!who?.email && !!(await loadPerms(this.serverEnv(), { email: who.email })).role;
    return { who, member, tenant: this.tenant, settings: { ...this.settings } };
  }

  // One row of an account's "Your servers" list (src/myservers.js): what the account is here, and who's on now.
  //   email   the signed-in account
  //   viewer  it joined with the current password, and that hasn't run out (the directory remembers; the
  //           cookie itself is only sent to this server's pages)
  // Someone who can't see the server gets its name and nothing more: { access: false }.
  async card({ email = null, viewer = false } = {}) {
    const env = this.serverEnv();
    const perms = email ? await loadPerms(env, { email }) : null;
    const isPublic = this.settings.PUBLIC === '1';
    const access = !!(perms?.role || perms?.super || viewer || isPublic);
    const out = { name: this.settings.NAME ?? null, public: isPublic, role: perms?.role ?? null, super: !!perms?.super, viewer: !!viewer, access };
    if (!access) return out;
    return { ...out, ...(await this.onlineNow()) };
  }

  // Who's on right now: { status: 'up' | 'down' | 'paused' | 'unknown', online, players: [names], max }.
  // From the mod's own list while it's fresh, otherwise the last minute's status check if it's recent.
  // Hidden players are left out, and aliases shown as the player they belong to, as on the stats page.
  async onlineNow() {
    if (this.settings.PAUSED === '1') return { status: 'paused', online: 0, players: [], max: null };
    const now = Math.floor(Date.now() / 1000);
    const sql = this.ctx.storage.sql;
    const hidden = new Set(sql.exec('SELECT name FROM hidden_players').toArray().map((r) => r.name.toLowerCase()));
    const alias = new Map(sql.exec('SELECT alias, name FROM player_aliases').toArray().map((r) => [r.alias.toLowerCase(), r.name]));
    const shown = (names) => {
      const seen = new Map();
      for (const n of names) {
        if (typeof n !== 'string' || hidden.has(n.toLowerCase())) continue;
        const c = alias.get(n.toLowerCase()) || n;
        if (!seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
      }
      return [...seen.values()];
    };
    const snap = sql.exec('SELECT ts, up, online, max FROM snapshots ORDER BY ts DESC LIMIT 1').toArray()[0];
    const recent = snap && now - snap.ts <= 3 * 60 ? snap : null;
    const mod = await modOnline(this.db, now);
    if (mod) {
      const players = mod.stopping ? [] : shown(mod.players.map((p) => p.name));
      return { status: mod.stopping ? 'down' : 'up', online: players.length, players, max: recent?.max ?? null };
    }
    if (!recent) return { status: 'unknown', online: 0, players: [], max: null };
    const names = sql.exec('SELECT p.name FROM sessions s JOIN players p ON p.uuid = s.uuid WHERE s.end_ts = ? ORDER BY s.start_ts', recent.ts).toArray().map((r) => r.name);
    const players = shown(names);
    // the ping names at most a dozen players; the count it gives is the whole server's, less the hidden ones
    const hiddenOn = names.filter((n) => hidden.has(n.toLowerCase())).length;
    const online = recent.up ? Math.max(players.length, recent.online - hiddenOn) : 0;
    return { status: recent.up ? 'up' : 'down', online, players: recent.up ? players : [], max: recent.max ?? null };
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
    // the server's own details (name, address, password, look): they live here and in the directory
    if (who && url.pathname === '/api/admin/server') return handleServerAdmin(this, request, url, who);
    // its seasons too: they're this object's settings
    if (who && url.pathname === '/api/admin/seasons') return handleSeasons(this, request, url, who);
    // its icon (Admin → Server), for anyone who may look at its pages
    if (who && url.pathname === '/api/icon' && request.method === 'GET') {
      const png = this.icon();
      if (!png) return json({ error: 'not found' }, 404);
      const fresh = url.searchParams.get('v') === String(this.settings.ICON_AT);
      return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': fresh ? 'private, max-age=31536000, immutable' : 'private, no-cache' } });
    }
    return handleApi(request, this.serverEnv(who ? { WHO: who } : {}), url, this.ctx);
  }

  // Who's signed in is the site's business (an mcstats account, src/account.js); being someone *here* is this
  // server's:
  //   POST /api/auth/enter   the signed-in account becomes a member of this server, if it can see it (its
  //                          password, or it's public). Asked for, never automatic: the server's owner sees
  //                          members' emails, so just looking at a server doesn't hand yours over. Only the
  //                          button on the server's own page asks (public/tenant.js); no link can.
  async auth(request, url, proof) {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
    const from = request.headers.get('Sec-Fetch-Site');
    if (from && from !== 'same-origin') return json({ error: 'wrong origin' }, 403);
    if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);
    if (!this.settings.SLUG || url.pathname !== '/api/auth/enter') return json({ error: 'not found' }, 404);
    const email = cleanEmail(proof?.email);
    if (!EMAIL_RE.test(email)) return json({ error: 'Sign in to mcstats first.', reason: 'signed_out' }, 401);
    const r = await limit(this.env, [[`enter:${this.id}:${email}`, 20, 3600]]);
    if (!r.ok) return tooMany(r.retry);
    const env = this.serverEnv();
    const perms = await loadPerms(env, { email });
    if (!(perms.role || perms.super)) {
      // someone who can't see the server learns nothing about it
      if (!(proof?.viewer || this.settings.PUBLIC === '1')) return json({ error: 'unauthorized' }, 401);
      await setRoleStmt(this.db, email, 'member', 'sign-in').run();
      forgetPerms(env, email);
    }
    return json({ ok: true, email });
  }
}
