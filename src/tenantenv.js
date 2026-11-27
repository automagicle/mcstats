// The `env` every request handler gets is one server's own: built here from the Worker's real env, that
// server's settings and its database. The code written for one server (api.js, chat.js, …) reads
// env.DB, env.MC_SERVER, env.LINK and so on as before, and gets this server's.
//
//   DB                      this server's SQLite (sql.js: local inside its Tenant object, remote elsewhere)
//   LINK, PRESENCE, LIVEVIEW the Durable Object namespaces, scoped: idFromName('server') is this server's
//                           instance (named by the server's id), never another's
//   MC_SERVER, TZ_NAME, CURRENT_SEASON, SEASONn_START, SEASONn_OPENS, CHAT_RESETS, PUBLIC, ACCENT, TAB_STYLE, LAYOUT, ABOUT
//                           this server's settings (ACCENT and TAB_STYLE are how its pages look: src/look.js;
//                           LAYOUT how they're arranged and ABOUT its description: src/layout.js)
//   COMMANDS_OFF, COMMANDS_FOLD  which /mcstats commands are switched off, and whether the Activity page's
//                           commands box starts closed (src/commands.js)
//   ADMIN_EMAIL             not used: who's an admin is in this server's user_perms (roles)
//   CHAT_INGEST_TOKEN       not passed on: the mod's key is checked before a request gets here,
//                           and INGEST_OK says it was
//   TENANT                  { id, slug, name }
import { remoteDb } from './sql.js';

export const SETTING_RE = /^(MC_SERVER|TZ_NAME|CURRENT_SEASON|CHAT_RESETS|PUBLIC|ACCENT|TAB_STYLE|LAYOUT|ABOUT|BANNER|COMMANDS_OFF|COMMANDS_FOLD|SEASON\d{1,2}_(START|OPENS))$/;

// The site-wide values every server shares.
const SHARED = ['ASSETS', 'MC_VERSION', 'SUPER_ADMIN_EMAIL', 'SESSION_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_DEV_LOG', 'LIMITER', 'DEV_NO_AUTH', 'DEV_EMAIL'];

// A namespace whose instances all belong to one server. The code names instances 'server' (one per
// server); that becomes the server's id, so two servers can never reach the same instance.
export function scoped(ns, serverId) {
  if (!ns) return ns;
  return {
    idFromName: (name) => ns.idFromName(name === 'server' ? serverId : `${serverId}:${name}`),
    get: (id) => ns.get(id),
  };
}

export const tenantStub = (env, serverId) => env.TENANT.get(env.TENANT.idFromName(serverId));

export function tenantEnv(raw, tenant, db, settings = {}, extra = {}) {
  const out = {};
  for (const k of SHARED) if (raw[k] !== undefined) out[k] = raw[k];
  for (const [k, v] of Object.entries(settings)) if (SETTING_RE.test(k)) out[k] = v;
  out.TZ_NAME ||= 'UTC';
  out.CURRENT_SEASON ||= '1';
  return {
    ...out,
    DB: db,
    LINK: scoped(raw.LINK, tenant.id),
    PRESENCE: scoped(raw.PRESENCE, tenant.id),
    LIVEVIEW: scoped(raw.LIVEVIEW, tenant.id),
    TENANT_NS: raw.TENANT,
    RAW: raw,
    TENANT: tenant,
    ...extra,
  };
}

// For a server's other objects (ServerLink, Presence, LiveRelay), which are named by the server's id: its
// env, with the database reached through its Tenant object. They don't need its settings.
export function siblingEnv(raw, ctx) {
  const id = ctx.id.name;
  if (!id || !/^[0-9a-f]{16}$/.test(id)) {
    // an instance from before servers had their own (named 'server'): nothing to reach
    return { ...raw, DB: null, LINK: null, PRESENCE: null, LIVEVIEW: null, TENANT: null };
  }
  return tenantEnv(raw, { id }, remoteDb(tenantStub(raw, id)));
}
