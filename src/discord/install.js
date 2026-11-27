// Adding the bot to a Discord server from the dashboard (DISCORD.md, "Way 1"), and linking a Discord account
// to a player (DISCORD.md, "Linking players", B). Both are pages in the browser, signed in to mcstats.
//
//   GET  /api/discord/install?server=<slug>[&channels=1]   an owner of that server only: off to Discord's own
//        "Add app" screen, with a signed state naming the server and the owner (15 minutes). channels=1 also
//        asks for Manage Channels, for "Make the channels for me".
//   GET  /api/discord/oauth?code&state&guild_id            Discord sends the browser back here. The code is
//        exchanged with Discord (that proves the bot really was added to that guild), then the guild is linked
//        and the browser goes back to Admin → Discord.
//   GET  /api/discord/connect?t=<token>                     from /mcstats connect: "link Discord user X to Steve?"
//   POST /api/discord/connect                               { t }: yes
import { accountOf } from '../account.js';
import { serverById, serverBySlug, SLUG_RE } from '../directory.js';
import { loadPerms } from '../roles.js';
import { playerFor } from '../link.js';
import { signToken, unb64url, verifyToken } from '../session.js';
import { API, INSTALL_PERMISSIONS, isSnowflake, P } from './api.js';
import { linkGuild, openServer } from './server.js';
import { linkPlayer, playerOf, setLink } from './store.js';
import { relayOf } from './relay.js';

const dec = new TextDecoder();
const now = () => Math.floor(Date.now() / 1000);
const go = (location) => new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
const back = (slug, result) => go(`/${slug}?discord=${encodeURIComponent(result)}#/admin/discord`);

// The payload of a signed token, before its signature is checked: only to learn which server's key checks it.
function peek(token) {
  try {
    return JSON.parse(dec.decode(unb64url(String(token).split('.')[0])));
  } catch {
    return null;
  }
}

// Whether the account signed in on this request is an owner of the server: its { email } or null.
async function ownerOf(request, env, srv) {
  const account = await accountOf(request, env);
  if (!account) return null;
  const perms = await loadPerms(srv.env, { email: account.email });
  return perms.owner || perms.super ? account : null;
}

export const redirectUri = (origin) => `${origin}/api/discord/oauth`;

export async function install(request, env, url, origin) {
  const slug = (url.searchParams.get('server') || '').toLowerCase();
  const row = SLUG_RE.test(slug) ? await serverBySlug(env, slug) : null;
  if (!row) return go('/');
  if (!env.DISCORD_APP_ID || !env.DISCORD_CLIENT_SECRET) return back(slug, 'not_set_up');
  const srv = await openServer(env, row, origin);
  const owner = await ownerOf(request, env, srv);
  if (!owner) return go(`/account?${new URLSearchParams({ next: `/${slug}` })}`);
  const perms = INSTALL_PERMISSIONS | (url.searchParams.get('channels') === '1' ? P.MANAGE_CHANNELS : 0n);
  const state = await signToken(env, { k: 'discord', s: row.id, e: owner.email, x: now() + 15 * 60 });
  const q = new URLSearchParams({
    client_id: env.DISCORD_APP_ID, scope: 'bot applications.commands', permissions: perms.toString(), integration_type: '0',
    response_type: 'code', redirect_uri: redirectUri(origin), state,
  });
  // linked already: Discord opens on the same guild
  if (srv.link?.guild_id) q.set('guild_id', srv.link.guild_id);
  return go(`https://discord.com/oauth2/authorize?${q}`);
}

export async function oauth(request, env, url, origin) {
  const state = url.searchParams.get('state') || '';
  const p = peek(state);
  const row = p?.s ? await serverById(env, p.s) : null;
  if (!row) return go('/');
  const ok = await verifyToken(env, state, 'discord', row.id);
  if (!ok) return back(row.slug, 'expired');
  if (url.searchParams.get('error')) return back(row.slug, 'cancelled');
  const srv = await openServer(env, row, origin);
  const owner = await ownerOf(request, env, srv);
  if (!owner || owner.email !== ok.e) return back(row.slug, 'not_owner');
  const code = url.searchParams.get('code') || '';
  // the code is Discord's word that the bot was added, and to which guild
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_APP_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirectUri(origin),
    }),
  }).catch(() => null);
  const token = res?.ok ? await res.json().catch(() => null) : null;
  const guild = token?.guild;
  if (!guild || !isSnowflake(guild.id)) return back(row.slug, 'failed');
  const linked = await linkGuild(env, guild.id, row.id, owner.email);
  if (linked.error) return back(row.slug, 'taken');
  await setLink(srv.db, { guild_id: guild.id, guild_name: guild.name ?? null, guild_icon: guild.icon ?? null, by: owner.email });
  await relayOf(env, row.id).changed();
  console.log(`discord: ${owner.email} linked ${row.slug} to guild ${guild.id}`);
  return back(row.slug, 'linked');
}

// ---------- linking a Discord account to a player ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · mcstats</title><link rel="stylesheet" href="/style.css">
<script>document.documentElement.dataset.theme='dark';try{if(localStorage.getItem('theme')==='light')document.documentElement.dataset.theme='light'}catch{}</script>
</head><body class="site"><header class="top"><div class="top-left"><a class="brand" href="/"><span class="logo" aria-hidden="true"></span><span>mcstats</span></a></div></header>
<main class="site-main"><section class="card site-card"><h1 class="site-title">${esc(title)}</h1>${body}</section></main></body></html>`, {
    status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' },
  });
}

async function connectState(env, t, origin) {
  const p = peek(t);
  const row = p?.s ? await serverById(env, p.s) : null;
  const ok = row ? await verifyToken(env, t, 'discordme', row.id) : null;
  if (!ok || !isSnowflake(ok.d)) return null;
  return { row, srv: await openServer(env, row, origin), discord: ok.d, discordName: ok.n || 'your Discord account' };
}

export async function connect(request, env, url, origin) {
  let t = url.searchParams.get('t') || '';
  if (request.method === 'POST') {
    const o = request.headers.get('Origin');
    if (o && o !== url.origin) return page('Not linked', '<p class="site-sub">That came from another site.</p>', 403);
    t = String((await request.formData().catch(() => null))?.get('t') || '');
  } else if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }
  const st = await connectState(env, t, origin);
  if (!st) return page('This link has run out', '<p class="site-sub">Links from <code>/mcstats connect</code> work for 10 minutes. Run it again in Discord for a new one.</p>', 400);
  const { srv, row } = st;
  const account = await accountOf(request, env);
  if (!account) {
    const next = `/api/discord/connect?t=${encodeURIComponent(t)}`;
    return page('Sign in first', `<p class="site-sub">Sign in to the mcstats account your Minecraft player is connected to, and this page comes back.</p>
<p><a class="btn btn-primary" href="/account?${esc(new URLSearchParams({ next }).toString())}">Sign in</a></p>`);
  }
  const player = await playerFor(srv.env, account.email);
  if (!player?.ign) {
    return page('No player yet', `<p class="site-sub">${esc(account.email)} isn’t connected to a player on ${esc(srv.name)}. In game, run <code>/mcstats connect</code> and type this email, then try again.</p>`);
  }
  const uuid = (await srv.db.prepare('SELECT uuid FROM players WHERE name = ? COLLATE NOCASE ORDER BY first_seen DESC LIMIT 1').bind(player.ign).first('uuid')) || '';
  if (request.method === 'GET') {
    const have = await playerOf(srv.db, st.discord);
    return page('Link Discord?', `<p class="site-sub">Link the Discord account <b>${esc(st.discordName)}</b> to <b>${esc(player.ign)}</b> on ${esc(srv.name)}?
Then <code>/me</code> shows your stats there${srv.config.bridge.say !== 'off' ? ', and <code>/say</code> sends chat as you' : ''}.${have ? ` (It’s linked to ${esc(have.name)} now.)` : ''}</p>
<form method="post" action="/api/discord/connect"><input type="hidden" name="t" value="${esc(t)}"><button class="btn btn-primary" type="submit">Link</button> <a class="btn btn-quiet" href="/${esc(row.slug)}">Cancel</a></form>`);
  }
  await linkPlayer(srv.db, st.discord, { uuid, name: player.ign, how: 'account' });
  return page('Linked', `<p class="site-sub">${esc(st.discordName)} is ${esc(player.ign)} on ${esc(srv.name)} now. You can close this page and go back to Discord.</p>`);
}
