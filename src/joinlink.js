// Join links: https://<site>/<server>/join/<token>. Opening one lets the browser in to that server's pages,
// exactly as typing the server's name and join password on /join does (the same viewer cookie), so players can
// be sent one link instead of two things to type.
//
// A server has at most one link at a time. Its token is kept by the server's own object (src/tenant.js,
// the JOIN_LINK setting) as it is, not hashed: admins need to copy the link again later, and unlike a password
// it's random and used nowhere else. Admins make, replace and turn off the link on Admin → Server
// (src/serveradmin.js), and owners while setting the server up on /new (src/site.js).
//
// Replacing or turning off the link stops it letting anyone new in. People it already let in stay in until
// the join password changes, which ends every viewer session however it began.
import { serverBySlug } from './directory.js';
import { tenantStub } from './tenantenv.js';
import { ipKey, limit } from './limiter.js';
import { accountOf } from './account.js';
import { noteServer } from './myservers.js';
import { cookie, DAY, JOIN_TOKEN_RE, passwordStamp, serverPath, signToken, VIEW_DAYS } from './session.js';

// The address never stays in the bar or the history, and isn't passed on to the next page as its referrer.
const go = (location, cookies = []) => {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
};

// GET /<slug>/join/<token>. A link that doesn't work (wrong, replaced, turned off, or no such server: all the
// same) leads to /join, which says so and still takes the password.
export async function joinByLink(request, env, slug, token) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  const fail = (why) => go(`/join?${new URLSearchParams({ server: slug, link: why })}`);
  const ip = await ipKey(env, request);
  // the same limits whether or not the server exists
  const lim = await limit(env, [[`joinlink:${slug}:${ip}`, 20, 600], [`joinlink:${slug}`, 300, 600], [`joinlink-ip:${ip}`, 60, 600]]);
  if (!lim.ok) return fail('wait');
  const row = await serverBySlug(env, slug, { fresh: true });
  const ok = !!row && JOIN_TOKEN_RE.test(token) && (await tenantStub(env, row.id).joinLinkOk(token));
  if (!ok) return fail('gone');
  const until = Math.floor(Date.now() / 1000) + VIEW_DAYS * DAY;
  const view = await signToken(env, { k: 'view', s: row.id, p: passwordStamp(row), x: until });
  // opened while signed in: it goes on the account's list of servers (unless they took it off before)
  const account = await accountOf(request, env);
  if (account) {
    await noteServer(env, account.id, row.id, { auto: true, view: { stamp: passwordStamp(row), until } })
      .catch((err) => console.error('my servers:', err.message));
  }
  return go(serverPath(row.slug), [cookie('mcs_view', view, { path: serverPath(row.slug), maxAge: VIEW_DAYS * DAY })]);
}
