// The site's own API, under /api/site/: joining a server, and making and setting up servers (/new).
//
//   POST /api/site/join               { server, password }  the viewer cookie for that server's pages
//   GET  /api/site/me                 { email, servers: [{ slug, name, step }], max }
//   GET  /api/site/mod                what to install, from mod/ (src/modinfo.gen.js)
//   GET  /api/site/slug?name=…        { slug, ok, error? }  whether that address is free (signed in only)
//   POST /api/site/servers            { name, slug, visibility, password?, confirm?, tz? }  a new server; you're its owner.
//                                     tz: the maker's time zone ("America/Los_Angeles"), which its times are shown in
//                                     visibility: 'private' (the stats need the join password) or 'public' (anyone
//                                     with the address can look; the password is then optional)
//   GET  /api/site/servers/<slug>     the server as its setup sees it
//   POST /api/site/servers/<slug>/step      { step }   how far setup has got (to pick it up again)
//   POST /api/site/servers/<slug>/key       a new mod key, shown once; the old one stops working at once
//   POST /api/site/servers/<slug>/settings  { NAME, MC_SERVER, PUBLIC, TZ_NAME, CURRENT_SEASON, …, password, confirm }
//   POST /api/site/servers/<slug>/invite    { email, role }  add an admin or member, and email them
//   POST /api/site/servers/<slug>/joinlink  { on }     a new join link (the one before stops working), or none (src/joinlink.js)
//   POST /api/site/servers/<slug>/open      let in to the server's own pages (the viewer cookie)
//   GET  /api/site/mine, POST /api/site/mine/order, /mine/remove   the account's own list of servers (src/myservers.js)
// Everything but /join and /mod needs an mcstats account to be signed in (src/account.js); everything under
// /servers/<slug> is for that server's owner (or a super admin) only.
import { MOD } from './modinfo.gen.js';
import {
  checkPassword, cleanEmail, cookie, DAY, EMAIL_RE, hashPassword, joinLinkPath, MAX_PASSWORD, MIN_PASSWORD, newApiKey, passwordStamp,
  serverPath, sessionReady, sha256Hex, signToken, VIEW_DAYS,
} from './session.js';
import { accountOf } from './account.js';
import { forgetSlug, newServerId, serverBySlug, serversOwnedBy, slugify, slugProblem } from './directory.js';
import { tenantStub } from './tenantenv.js';
import { ipKey, limit, tooMany } from './limiter.js';
import { sendEmail } from './email.js';
import { isSuper } from './roles.js';
import { handleMine, noteServer, saveServer } from './myservers.js';
import { cleanTz, json } from './util.js';

export const JOIN_FAILED = 'That server name and password don’t match.';
const STEPS = 7;

const withCookies = (body, cookies, status = 200) => {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
};

// A POST's JSON body, from this site only. A Response when it isn't one.
export async function body(request, url, max = 4096) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);
  try {
    const raw = await request.text();
    if (raw.length > max) return json({ error: 'too large' }, 413);
    const b = JSON.parse(raw || '{}');
    return b && typeof b === 'object' ? { b } : json({ error: 'bad json' }, 400);
  } catch {
    return json({ error: 'bad json' }, 400);
  }
}

// Where mods are told to upload: the site's own address (the SITE_ORIGIN var), whichever of its addresses
// the owner happens to be browsing at. Without the var, or on a developer's own machine, the address in use.
export function uploadOrigin(env, url) {
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return !local && /^https:\/\/[a-z0-9.-]+$/.test(env.SITE_ORIGIN || '') ? env.SITE_ORIGIN : url.origin;
}

// The file the mod reads, filled in for this server.
export function configFor(origin, key) {
  return MOD.config_template
    .replace(/^url=.*$/m, `url=${origin}/api/ingest/chat`)
    .replace(/^token=.*$/m, `token=${key}`);
}

export async function handleSite(request, env, url) {
  if (!sessionReady(env)) return json({ error: 'The site isn’t set up yet (no SESSION_SECRET).' }, 503);
  const path = url.pathname.slice('/api/site'.length);

  if (path === '/mod') {
    return json({
      ...MOD, config_template: undefined,
      jar_url: `/downloads/${MOD.jar}`,
      loader_installer: 'https://fabricmc.net/use/server/',
      fabric_api_url: 'https://modrinth.com/mod/fabric-api/versions',
      ingest_url: `${uploadOrigin(env, url)}/api/ingest/chat`,
    });
  }

  if (path === '/join') {
    const r = await body(request, url);
    if (r instanceof Response) return r;
    const slug = slugify(r.b.server);
    const password = typeof r.b.password === 'string' ? r.b.password : '';
    const ip = await ipKey(env, request);
    // The same limits whether or not the server exists, so trying names tells nobody which ones do.
    const lim = await limit(env, [[`join:${slug}:${ip}`, 10, 600], [`join:${slug}`, 100, 600], [`join-ip:${ip}`, 30, 600]]);
    if (!lim.ok) return tooMany(lim.retry);
    const row = slug ? await serverBySlug(env, slug, { fresh: true }) : null;
    // checkPassword works through a made-up hash when there's no such server, so both take as long
    // a public server made without a password has none to join with
    const ok = (await checkPassword(password, row)) && row?.has_password !== 0;
    if (!ok) return json({ error: JOIN_FAILED }, 401);
    const until = Math.floor(Date.now() / 1000) + VIEW_DAYS * DAY;
    const token = await signToken(env, { k: 'view', s: row.id, p: passwordStamp(row), x: until });
    // joined while signed in: it goes on the account's list of servers (unless they took it off before)
    const account = await accountOf(request, env);
    if (account) await noteServer(env, account.id, row.id, { auto: true, view: { stamp: passwordStamp(row), until } });
    return withCookies({ ok: true, url: serverPath(row.slug) }, [cookie('mcs_view', token, { path: serverPath(row.slug), maxAge: VIEW_DAYS * DAY })]);
  }

  const account = await accountOf(request, env);
  const email = account?.email ?? null;
  const max = Number(env.MAX_SERVERS_PER_OWNER) || 3;

  if (path === '/me') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    if (!email) return json({ email: null, servers: [], max });
    const servers = await serversOwnedBy(env, email);
    return json({ email, max, super: isSuper(env, { email }), servers: servers.map((s) => ({ slug: s.slug, name: s.name, step: s.step ?? STEPS, created_at: s.created_at })) });
  }

  if (!email) return json({ error: 'Sign in first.', reason: 'signed_out' }, 401);

  if (path === '/mine' || path.startsWith('/mine/')) {
    let b = {};
    if (request.method === 'POST') {
      const r = await body(request, url);
      if (r instanceof Response) return r;
      b = r.b;
    }
    return handleMine(request, env, path, account, b);
  }

  // Whether an address can be had, for the form on /new as it's typed. Signed in only, and limited: making a
  // server says the same thing (that address is taken), so this tells nobody more than they could find out.
  if (path === '/slug') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const lim = await limit(env, [[`slug-check:${email}`, 120, 600]]);
    if (!lim.ok) return tooMany(lim.retry);
    const slug = slugify(url.searchParams.get('name') || '');
    const bad = slug ? slugProblem(slug) : 'Type an address.';
    if (bad) return json({ slug, ok: false, error: bad });
    const taken = await serverBySlug(env, slug, { fresh: true });
    return json(taken ? { slug, ok: false, error: 'That address is taken. Pick another.' } : { slug, ok: true });
  }

  if (path === '/servers') {
    const r = await body(request, url);
    if (r instanceof Response) return r;
    const name = typeof r.b.name === 'string' ? r.b.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 60) return json({ error: 'The name is 1 to 60 characters.', field: 'name' }, 400);
    const slug = typeof r.b.slug === 'string' && r.b.slug.trim() ? r.b.slug.trim().toLowerCase() : slugify(name);
    const bad = slugProblem(slug);
    if (bad) return json({ error: bad, field: 'slug' }, 400);
    const visibility = r.b.visibility ?? 'private';
    if (visibility !== 'private' && visibility !== 'public') return json({ error: 'Choose who can see the stats: private or public.', field: 'visibility' }, 400);
    const password = typeof r.b.password === 'string' ? r.b.password : '';
    // a private server needs a password; a public one may have one ready for if it's made private later
    if (visibility === 'private' || password) {
      if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return json({ error: `The password is ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`, field: 'password' }, 400);
      if (password !== r.b.confirm) return json({ error: 'The two passwords aren’t the same.', field: 'confirm' }, 400);
    }
    const owned = await serversOwnedBy(env, email);
    if (owned.length >= max && !isSuper(env, { email })) return json({ error: `You can have up to ${max} servers.` }, 403);
    const id = newServerId();
    const now = Math.floor(Date.now() / 1000);
    // no password: the hash of a random one nobody is told, so joining with a password can't succeed
    const h = await hashPassword(password || crypto.randomUUID() + crypto.randomUUID());
    try {
      await env.DIRECTORY.batch([
        env.DIRECTORY.prepare('INSERT INTO servers (id, slug, name, join_salt, join_hash, join_iter, has_password, owner_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, slug, name, h.join_salt, h.join_hash, h.join_iter, password ? 1 : 0, email, now),
        env.DIRECTORY.prepare('INSERT INTO wizard (server_id, step, updated_at) VALUES (?, 3, ?)').bind(id, now),
      ]);
    } catch (err) {
      if (/UNIQUE/i.test(String(err?.message))) return json({ error: 'That address is taken. Pick another.', field: 'slug' }, 409);
      throw err;
    }
    forgetSlug(slug);
    // its times are shown in the zone of whoever made it: the one their browser says, or else the one their
    // connection comes from; with neither it's UTC until they pick one (Admin → Server)
    const tz = cleanTz(r.b.tz) || cleanTz(request.cf?.timezone);
    await tenantStub(env, id).setup({ slug, name, owner: email, settings: { PUBLIC: visibility === 'public' ? '1' : '', ...(tz && { TZ_NAME: tz }) } });
    await saveServer(env, account.id, id);
    return json({ ok: true, server: { slug, name, step: 3, public: visibility === 'public' } });
  }

  const m = /^\/servers\/([a-z0-9-]{1,32})(\/[a-z]+)?$/.exec(path);
  if (!m) return json({ error: 'not found' }, 404);
  const row = await serverBySlug(env, m[1], { fresh: true });
  // someone else's server looks the same as no server
  if (!row || (row.owner_email !== email && !isSuper(env, { email }))) return json({ error: 'not found' }, 404);
  const stub = tenantStub(env, row.id);
  const action = m[2] || '';
  const step = async () => (await env.DIRECTORY.prepare('SELECT step FROM wizard WHERE server_id = ?').bind(row.id).first())?.step ?? STEPS;
  const setStep = (n) => env.DIRECTORY.prepare(
    'INSERT INTO wizard (server_id, step, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(server_id) DO UPDATE SET step = MAX(step, excluded.step), updated_at = excluded.updated_at'
  ).bind(row.id, Math.max(3, Math.min(STEPS, n)), Math.floor(Date.now() / 1000)).run();
  const state = async () => {
    let info = await stub.info();
    // making it was interrupted before its object was set up: finish that now
    if (!info.slug) info = await stub.setup({ slug: row.slug, name: row.name, owner: row.owner_email });
    const token = await stub.joinLink();
    return {
      slug: row.slug, name: row.name, url: `${url.origin}${serverPath(row.slug)}`, step: await step(), has_password: row.has_password !== 0,
      // the link that lets players in without the name and password; null when there's none
      join_link: token ? `${url.origin}${joinLinkPath(row.slug, token)}` : null,
      info,
    };
  };

  if (!action) {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return json(await state());
  }

  const r = await body(request, url);
  if (r instanceof Response) return r;

  if (action === '/step') {
    const n = Number(r.b.step);
    if (!Number.isInteger(n)) return json({ error: 'bad step' }, 400);
    await setStep(n);
    return json(await state());
  }

  if (action === '/key') {
    const key = newApiKey(row.id);
    const keyHash = await sha256Hex(key);
    const created = await stub.setKey(keyHash); // the old key stops working here
    await env.DIRECTORY.prepare(
      'INSERT INTO api_keys (server_id, key_hash, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(server_id) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at'
    ).bind(row.id, keyHash, created).run();
    await setStep(5);
    console.log(`site: ${email} made a new mod key for ${row.slug}`);
    return json({ key, created_at: created, config_file: MOD.config_file, config: configFor(uploadOrigin(env, url), key), state: await state() });
  }

  if (action === '/settings') {
    const { password, confirm, ...patch } = r.b;
    if (password != null && password !== '') {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return json({ error: `The password is ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`, field: 'password' }, 400);
      if (password !== confirm) return json({ error: 'The two passwords aren’t the same.', field: 'confirm' }, 400);
    }
    // a server can only be made private once it has a password to join with
    if ('PUBLIC' in patch && !['1', 'true', true].includes(patch.PUBLIC) && row.has_password === 0 && !password) {
      return json({ error: 'Set a join password to make it private, so players can still get in.', field: 'password' }, 400);
    }
    const out = await stub.updateSettings(patch);
    if (out.error) return json({ error: out.error }, 400);
    const sets = [];
    if (patch.NAME) sets.push(env.DIRECTORY.prepare('UPDATE servers SET name = ? WHERE id = ?').bind(String(patch.NAME).trim(), row.id));
    if (password) {
      // a new password ends every viewer session made with the old one (their cookies carry its stamp)
      const h = await hashPassword(password);
      sets.push(env.DIRECTORY.prepare('UPDATE servers SET join_salt = ?, join_hash = ?, join_iter = ?, has_password = 1 WHERE id = ?').bind(h.join_salt, h.join_hash, h.join_iter, row.id));
      row.has_password = 1;
    }
    if (sets.length) await env.DIRECTORY.batch(sets);
    forgetSlug(row.slug);
    return json(await state());
  }

  if (action === '/invite') {
    const who = cleanEmail(r.b.email);
    const role = r.b.role === 'member' ? 'member' : 'admin';
    if (!EMAIL_RE.test(who)) return json({ error: 'That isn’t an email address.' }, 400);
    const lim = await limit(env, [[`invite:${row.id}`, 30, 86400]]);
    if (!lim.ok) return tooMany(lim.retry);
    const out = await stub.addMember(who, role, email);
    if (out.error) return json({ error: out.error }, 400);
    const where = `${url.origin}${serverPath(row.slug)}`;
    await sendEmail(env, {
      to: who,
      subject: `You’re ${role === 'admin' ? 'an admin' : 'a member'} of ${row.name} on mcstats`,
      text: `${email} added you to ${row.name} on mcstats as ${role === 'admin' ? 'an admin' : 'a member'}.\n\nSign in to mcstats with this address (${who}) to get in. If you don’t have an account yet, choose "Create an account" there:\n\n${url.origin}/account?${new URLSearchParams({ next: serverPath(row.slug) })}\n\n${where}\n`,
    });
    return json({ ok: true });
  }

  if (action === '/joinlink') {
    if (typeof r.b.on !== 'boolean') return json({ error: 'expected { on: true | false }' }, 400);
    await stub.setJoinLink(r.b.on);
    console.log(`site: ${email} ${r.b.on ? 'made a new join link for' : 'turned off the join link of'} ${row.slug}`);
    return json(await state());
  }

  if (action === '/open') {
    const now = Math.floor(Date.now() / 1000);
    const view = await signToken(env, { k: 'view', s: row.id, p: passwordStamp(row), x: now + VIEW_DAYS * DAY });
    await setStep(STEPS);
    const p = serverPath(row.slug);
    return withCookies({ ok: true, url: p }, [cookie('mcs_view', view, { path: p, maxAge: VIEW_DAYS * DAY })]);
  }

  return json({ error: 'not found' }, 404);
}
