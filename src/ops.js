// For the site's operator only (Authorization: Bearer <OPS_TOKEN secret>): bringing the single-server
// database from before into its own server, with scripts/copy-tenant.mjs.
//
//   POST /api/ops/servers                  { slug, name, owner, password, settings, legacy, paused }
//                                          make (or update) a server in the directory and set up its object
//   POST /api/ops/servers/<slug>/import    { table, columns, rows }   rows into that server's own database
//   GET  /api/ops/servers/<slug>/counts    rows in each of its tables
//   POST /api/ops/servers/<slug>/finish    copying is done: take uploads and check the server again
import { sameString, hashPassword, MIN_PASSWORD, cleanEmail, EMAIL_RE } from './session.js';
import { forgetSlug, newServerId, serverBySlug, slugProblem } from './directory.js';
import { tenantStub } from './tenantenv.js';
import { json } from './util.js';

const list = (v) => String(v || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export async function handleOps(request, env, url) {
  const token = env.OPS_TOKEN || '';
  const auth = request.headers.get('Authorization') || '';
  if (token.length < 32 || !auth.startsWith('Bearer ') || !(await sameString(auth.slice(7), token))) return json({ error: 'not found' }, 404);
  let b = {};
  if (request.method === 'POST') {
    try {
      b = JSON.parse(await request.text());
    } catch {
      return json({ error: 'bad json' }, 400);
    }
  }
  const path = url.pathname.slice('/api/ops'.length);

  if (path === '/servers' && request.method === 'POST') {
    const slug = String(b.slug || '');
    const bad = slugProblem(slug);
    if (bad) return json({ error: bad }, 400);
    const owner = cleanEmail(b.owner);
    if (!EMAIL_RE.test(owner)) return json({ error: 'owner is an email' }, 400);
    const name = String(b.name || slug).slice(0, 60);
    let row = await serverBySlug(env, slug, { fresh: true });
    const now = Math.floor(Date.now() / 1000);
    if (!row) {
      if (typeof b.password !== 'string' || b.password.length < MIN_PASSWORD) return json({ error: `password: at least ${MIN_PASSWORD} characters` }, 400);
      const h = await hashPassword(b.password);
      const id = newServerId();
      await env.DIRECTORY.batch([
        env.DIRECTORY.prepare('INSERT INTO servers (id, slug, name, join_salt, join_hash, join_iter, owner_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, slug, name, h.join_salt, h.join_hash, h.join_iter, owner, now),
        env.DIRECTORY.prepare('INSERT INTO wizard (server_id, step, updated_at) VALUES (?, 7, ?)').bind(id, now),
      ]);
      forgetSlug(slug);
      row = await serverBySlug(env, slug, { fresh: true });
    }
    const settings = { ...(b.settings || {}) };
    // the old server's address was a Worker secret
    if (b.legacy && !settings.MC_SERVER && env.MC_SERVER) settings.MC_SERVER = env.MC_SERVER.trim();
    const stub = tenantStub(env, row.id);
    const info = await stub.setup({ slug, name, owner, settings, legacy: !!b.legacy, paused: !!b.paused });
    // the old ADMIN_EMAIL logins were admins by default: they become admins of this server (once the copy
    // is finished, if it's paused for one)
    if (b.legacy && !info.paused) await stub.finishImport({ owner, admins: list(env.ADMIN_EMAIL) });
    return json({ ok: true, id: row.id, info });
  }

  const m = /^\/servers\/([a-z0-9-]{1,32})\/(import|counts|finish)$/.exec(path);
  if (!m) return json({ error: 'not found' }, 404);
  const row = await serverBySlug(env, m[1], { fresh: true });
  if (!row) return json({ error: 'no such server' }, 404);
  const stub = tenantStub(env, row.id);
  if (m[2] === 'counts') return json(await stub.counts());
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (m[2] === 'import') {
    const out = await stub.importRows(b.table, b.columns, b.rows);
    return json(out, out.error ? 400 : 200);
  }
  return json(await stub.finishImport({ owner: row.owner_email, admins: list(env.ADMIN_EMAIL) }));
}
