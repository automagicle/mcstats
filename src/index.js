// The Worker: works out which server a request is for before anything else, then hands it to that server's
// own objects. It never takes a server from a request's body or query string.
//
//   /s/<slug>/...        a server's pages and API; the server is the one the directory has for <slug>.
//                        Cookies (src/session.js, src/account.js) are checked here and what they prove goes along as X-MCS-Who.
//   /api/ingest/*        the mod's uploads; the server is the one its key names (mcs_<server id>_…), and that
//                        server's object checks the key itself. The old shared CHAT_INGEST_TOKEN still works,
//                        for the first server (LEGACY_SLUG) only.
//   /api/site/*          joining and making servers, and each account's list of them (src/site.js, src/myservers.js)
//                        /api/ops/*  the operator's (src/ops.js)
//   /api/account/*       mcstats accounts: signing in and out, passwords (src/account.js)
//   /s1/                 the old season 1 archive address: now the first server's
//   /api/mc/*            outside a server: just the game textures the landing page's example players wear
//   everything else      the static pages in public/ (/, /join, /new, /account)
import { handleApi } from './api.js';
import { body, handleSite } from './site.js';
import { noteServer, saveServer, unsaveServer } from './myservers.js';
import { accountOf, handleAccount } from './account.js';
import { handleOps } from './ops.js';
import { serverById, serverBySlug, SLUG_RE } from './directory.js';
import { tenantEnv, tenantStub } from './tenantenv.js';
import { remoteDb } from './sql.js';
import { keyServer, parseCookies, passwordStamp, sameString, verifyToken } from './session.js';
import { currentSeason } from './seasons.js';
import { json } from './util.js';
import { serveHomeAsset } from './mcassets.js';
import { ADDONS, addonList } from './addons.js';
import { lookAttrs, lookOf } from './look.js';
import { layoutOf } from './layout.js';

export { ServerLink } from './link.js';
export { Presence } from './presence.js';
export { LiveRelay } from './liveview.js';
export { Tenant } from './tenant.js';
export { Limiter } from './limiter.js';

const INGEST = /^\/api\/ingest\/(chat|gear|online|advancements|link|liveview)$/;
// Handled here rather than in the server's object: WebSockets (passed straight to the server's Presence,
// LiveRelay or ServerLink object) and game textures (kept in Cloudflare's cache).
const HERE = (p) => p === '/api/live' || p === '/api/liveview/ws' || p.startsWith('/api/liveview/assets/') || p.startsWith('/api/mc/') || p.startsWith('/api/skin/');

// What the cookies on a request to server `row` prove. who: { viewer, email }, what goes to the server's
// object. viewer: they joined with this server's password. email: the mcstats account that's signed in
// (src/account.js); what it may do here, if anything, is the server's to say (src/tenant.js, access()).
// account: that account ({ id, email }), and view: the viewer cookie's { stamp, until }, for the account's
// list of servers (src/myservers.js).
async function proof(request, env, row, url) {
  const account = await accountOf(request, env);
  if (env.DEV_NO_AUTH === '1' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return { who: { viewer: true, email: env.DEV_EMAIL ? env.DEV_EMAIL.toLowerCase() : account?.email ?? null }, account, view: null };
  }
  const c = parseCookies(request);
  const token = await verifyToken(env, c.mcs_view, 'view', row.id);
  const view = token && token.p === passwordStamp(row) ? { stamp: token.p, until: token.x } : null;
  return { who: { viewer: !!view, email: account?.email ?? null }, account, view };
}

// POST /s/<server>/api/mine { saved }: this server on or off the signed-in account's list. Answered here rather
// than by the server's object, since the list is the directory's; adding needs the account to be able to see the
// server (someone who can't learns nothing, as everywhere).
async function mine(request, env, url, row, stub, { who, account, view }) {
  const r = await body(request, url, 256);
  if (r instanceof Response) return r;
  if (!account) return json({ error: 'Sign in to mcstats first.', reason: 'signed_out' }, 401);
  if (typeof r.b.saved !== 'boolean') return json({ error: 'expected { saved: true | false }' }, 400);
  if (!r.b.saved) {
    await unsaveServer(env, account.id, row.id);
    return json({ ok: true, saved: false });
  }
  const g = await stub.gate(who);
  if (!g.who) return json({ error: 'unauthorized' }, 401);
  const out = await saveServer(env, account.id, row.id, view);
  return out.error ? json({ error: out.error }, 409) : json({ ok: true, saved: true });
}

// The request as the server's own code expects it: its path without /s/<slug>, and none of our own
// X-MCS- headers unless we put them there.
function forServer(request, url, rest, headers = {}) {
  const u = new URL(url);
  u.pathname = rest;
  const req = new Request(u, request);
  for (const k of [...req.headers.keys()]) if (k.toLowerCase().startsWith('x-mcs-')) req.headers.delete(k);
  for (const [k, v] of Object.entries(headers)) req.headers.set(k, v);
  return req;
}

const page = (location) => new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
// Link previews (Discord and the like) only load an og:image given as a full address, and the pages are
// served from more than one host (workers.dev, the custom domain, localhost), so it's filled in per request.
const absoluteOgImage = (rw, url) => rw.on('meta[property="og:image"]', {
  element(e) { e.setAttribute('content', new URL(e.getAttribute('content') || '/og.png', url).href); },
});
async function withPreviewTags(res, url) {
  if (!(res.headers.get('Content-Type') || '').includes('text/html')) return res;
  return absoluteOgImage(new HTMLRewriter(), url).transform(res);
}

const joinPage = (slug) => page(`/join?server=${encodeURIComponent(slug)}`);

async function ingest(request, env, url, ctx, kind) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  let row = null;
  const id = keyServer(token);
  if (id) row = await serverById(env, id);
  else if ((env.CHAT_INGEST_TOKEN || '').length >= 32 && token && (await sameString(token, env.CHAT_INGEST_TOKEN))) {
    row = await serverBySlug(env, env.LEGACY_SLUG || '');
  }
  if (!row) return json({ error: 'unauthorized' }, 401);
  const stub = tenantStub(env, row.id);
  if (kind === 'link' || kind === 'liveview') {
    // the mod's WebSockets go straight to the server's ServerLink or LiveRelay object, once its key checks out
    const { ok, paused } = await stub.verifyKey(token);
    if (!ok) return json({ error: 'unauthorized' }, 401);
    if (paused) return json({ error: 'paused' }, 503);
    const g = await stub.gate(null);
    return handleApi(request, tenantEnv(env, g.tenant, remoteDb(stub), g.settings, { INGEST_OK: true }), url, ctx);
  }
  return stub.fetch(forServer(request, url, url.pathname, { 'X-MCS-Ingest': '1' }));
}

async function server(request, env, url, ctx, slug, rest) {
  const row = await serverBySlug(env, slug);
  const isApi = rest.startsWith('/api/');

  if (!row) {
    // No such server looks the same as one you can't see.
    if (!isApi) return joinPage(slug);
    return json({ error: 'unauthorized' }, 401);
  }
  const stub = tenantStub(env, row.id);
  const proved = await proof(request, env, row, url);
  const { who, account } = proved;

  if (rest === '/api/mine') return mine(request, env, url, row, stub, proved);
  if (isApi && !HERE(rest)) {
    return stub.fetch(forServer(request, url, rest, { 'X-MCS-Who': JSON.stringify(who) }));
  }

  const g = await stub.gate(who);
  if (isApi) {
    if (!g.who) return json({ error: 'unauthorized' }, 401);
    const env2 = tenantEnv(env, g.tenant, remoteDb(stub), g.settings, { WHO: g.who });
    const req = forServer(request, url, rest);
    return handleApi(req, env2, new URL(req.url), ctx);
  }

  // The stats page: /s/<slug>/ for the current season, /s/<slug>/sN/ for an earlier one.
  const season = /^\/(?:s(\d{1,2})\/)?$/.exec(rest);
  if (!season) {
    if (/^\/s\d{1,2}$/.test(rest)) return page(`/s/${slug}${rest}/${url.search}`);
    return new Response('Not found', { status: 404 });
  }
  if (!g.who) return joinPage(slug);
  const current = currentSeason(g.settings);
  if (season[1] && (Number(season[1]) < 1 || Number(season[1]) >= current)) return new Response('Not found', { status: 404 });
  // Opened by a member, or by someone who joined with the password: it goes on their list of servers by itself
  // (unless they took it off). saved: whether it's on the list; null when nobody's signed in.
  const saved = account
    ? await noteServer(env, account.id, row.id, { auto: g.member || !!proved.view, view: proved.view }).catch((err) => { console.error('my servers:', err.message); return null; })
    : null;
  const html = await env.ASSETS.fetch(new Request(new URL('/stats', url)));
  // What the page needs to know about its server, before app.js runs (public/tenant.js reads it).
  const look = lookOf(g.settings);
  const addons = addonList(g.settings);
  const config = {
    base: `/s/${row.slug}`, slug: row.slug, name: row.name, season: current,
    // email: who they are on this server (a member). account: the mcstats account that's signed in, member or not.
    email: g.who.email, account: who.email, public: g.settings.PUBLIC === '1', accent: look.accent, tabs: look.tabs, addons,
    // whether this server is on the signed-in account's list (/servers); null when nobody's signed in
    saved,
    // how its pages are arranged, its description and its icon (Admin → Layout and Server; src/layout.js)
    layout: layoutOf(g.settings), about: g.settings.ABOUT || '',
    icon: g.settings.ICON_AT ? `/s/${row.slug}/api/icon?v=${g.settings.ICON_AT}` : null,
  };
  // Only this server's add-ons are put on its page (src/addons.js), ahead of app.js so they're there when it starts.
  const extras = addons.flatMap((id) => [
    ...ADDONS[id].styles.map((href) => `<link rel="stylesheet" href="${href}">`),
    ...ADDONS[id].scripts.map((src) => `<script src="${src}" defer></script>`),
  ]).join('');
  const script = `<script>window.MCS=${JSON.stringify(config).replace(/</g, '\\u003c')};</script><script src="/tenant.js"></script>`;
  const out = absoluteOgImage(new HTMLRewriter(), url)
    // the server's accent color and tab style, on <html> before anything is drawn (src/look.js)
    .on('html', { element(e) { for (const [k, v] of Object.entries(lookAttrs(look))) e.setAttribute(k, v); } })
    .on('head', { element(e) { e.prepend(script, { html: true }); } })
    // the server's own icon in the browser tab, when it has one
    .on('link[rel="icon"]', { element(e) { if (config.icon) e.setAttribute('href', config.icon); } })
    // after the site's stylesheet, so an add-on's rules can build on it
    .on('script[src="/app.js"]', { element(e) { if (extras) e.before(extras, { html: true }); } })
    .transform(html);
  const res = new Response(out.body, out);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    const ing = INGEST.exec(p);
    if (ing) return ingest(request, env, url, ctx, ing[1]);
    if (p.startsWith('/api/site/')) return handleSite(request, env, url);
    if (p.startsWith('/api/account/')) return handleAccount(request, env, url);
    if (p.startsWith('/api/ops/')) return handleOps(request, env, url);

    const s = /^\/s\/([^/]+)(\/.*)?$/.exec(p);
    if (s) {
      const slug = decodeURIComponent(s[1]);
      if (!s[2]) return page(`/s/${encodeURIComponent(slug)}/${url.search}`);
      // one spelling per server, or its cookies (Path=/s/<slug>/) wouldn't be sent
      if (slug !== slug.toLowerCase()) return page(`/s/${encodeURIComponent(slug.toLowerCase())}${s[2]}${url.search}`);
      if (!SLUG_RE.test(slug)) return new Response('Not found', { status: 404 });
      return server(request, env, url, ctx, slug, s[2]);
    }

    // The old addresses: the season 1 archive belonged to the first server.
    const old = /^\/s(\d{1,2})(\/.*)?$/.exec(p);
    if (old && env.LEGACY_SLUG) return page(`/s/${env.LEGACY_SLUG}/s${old[1]}/${url.search}`);
    // The stats page only makes sense inside a server.
    if (p === '/stats' || p === '/stats.html') return new Response('Not found', { status: 404 });
    // the landing page's example players, in the game's own textures (only the few it uses)
    if (p.startsWith('/api/mc/') && request.method === 'GET') return serveHomeAsset(env, p.slice(8));
    if (p.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return withPreviewTags(await env.ASSETS.fetch(request), url);
  },
};
