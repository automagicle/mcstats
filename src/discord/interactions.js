// POST /api/discord/interactions: everything Discord sends when someone uses the bot (slash commands, their
// buttons and menus, autocomplete). Set as the Interactions Endpoint URL in Discord's developer portal.
//
// The signature is checked before anything else (src/discord/verify.js). The server is the one the guild is
// linked to, and nothing else (src/discord/server.js). Discord wants an answer within 3 seconds: an answer
// that's ready in time goes straight back; a slower one is deferred ("mcstats is thinking…") and finished by
// editing that message once it's ready.
import { discord, isSnowflake } from './api.js';
import { verifiedBody } from './verify.js';
import { serverForGuild } from './server.js';
import { autocomplete, command, component } from './commands.js';
import { NO_PINGS } from './render.js';
import { limit } from '../limiter.js';
import { json } from '../util.js';

const PING = 1, COMMAND = 2, COMPONENT = 3, AUTOCOMPLETE = 4;
const PONG = 1, MESSAGE = 4, DEFERRED = 5, DEFERRED_UPDATE = 6, UPDATE = 7, CHOICES = 8;
const EPHEMERAL = 64;
const IN_TIME_MS = 2200; // leaves room for the answer to get back to Discord within its 3 seconds
const GIVE_UP_MS = 12_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms, null));

// A handler's answer as Discord's message data.
function messageData(out) {
  const data = { allowed_mentions: NO_PINGS };
  for (const k of ['content', 'embeds', 'components']) if (out[k] !== undefined) data[k] = out[k];
  if (out.ephemeral) data.flags = EPHEMERAL;
  return data;
}

export async function handleInteraction(request, env, ctx, origin) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!env.DISCORD_PUBLIC_KEY) return json({ error: 'The Discord bot isn’t set up on this site.' }, 503);
  const raw = await verifiedBody(request, env);
  if (raw == null) return new Response('bad signature', { status: 401 });
  let i;
  try { i = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  if (i.type === PING) return json({ type: PONG });

  const user = i.member?.user || i.user || {};
  if (!isSnowflake(user.id)) return json({ error: 'no user' }, 400);
  // in a DM there's no guild, and so no server
  const srv = i.guild_id && isSnowflake(i.guild_id) ? await serverForGuild(env, i.guild_id, origin).catch((err) => { console.error('discord server:', err.message); return null; }) : null;
  const perms = (() => { try { return BigInt(i.member?.permissions ?? 0); } catch { return 0n; } })();
  const c = { env, srv, i, user, perms, origin };

  if (i.type === AUTOCOMPLETE) {
    const choices = await Promise.race([autocomplete(c).catch(() => []), sleep(IN_TIME_MS).then(() => [])]);
    return json({ type: CHOICES, data: { choices: choices.slice(0, 25) } });
  }
  if (i.type !== COMMAND && i.type !== COMPONENT) return json({ error: 'unknown interaction' }, 400);

  // 20 commands a minute per person per Discord server: a guild can't be used to hammer a server's stats
  const tries = await limit(env, [[`dcmd:${i.guild_id || 'dm'}:${user.id}`, 20, 60]]).catch(() => ({ ok: true }));
  if (!tries.ok) return json({ type: MESSAGE, data: { content: 'Slow down a little: try again in a minute.', flags: EPHEMERAL } });

  const work = (i.type === COMMAND ? command(c) : component(c)).catch((err) => {
    console.error(`discord ${i.data?.name || i.data?.custom_id}:`, err.stack || err.message);
    return { content: 'Something went wrong on mcstats’ side. Try again in a minute.', ephemeral: true };
  });
  const ready = await Promise.race([work, sleep(IN_TIME_MS)]);
  if (ready) return json(answer(i, ready));

  // not ready in time: say so now, and finish it when it is
  const isComponent = i.type === COMPONENT;
  ctx.waitUntil((async () => {
    const out = await Promise.race([work, sleep(GIVE_UP_MS - IN_TIME_MS).then(() => ({ content: 'mcstats is slow right now. Try again in a minute.', ephemeral: true }))]);
    const data = messageData(out);
    delete data.flags; // set by the deferred answer, and can't be changed
    const r = await discord(env, 'PATCH', `/webhooks/${env.DISCORD_APP_ID}/${i.token}/messages/@original`, data, { auth: 'none' });
    if (!r.ok) console.error('discord follow-up:', r.status, JSON.stringify(r.data).slice(0, 200));
  })());
  if (isComponent) return json({ type: DEFERRED_UPDATE });
  // whether the finished answer will be ephemeral isn't known yet: personal commands always are
  const personal = i.data?.name === 'me' || i.data?.name === 'mcstats' || i.data?.name === 'dashboard' || i.data?.name === 'say' || srv?.config.commands.ephemeral;
  return json({ type: DEFERRED, data: personal ? { flags: EPHEMERAL } : {} });
}

function answer(i, out) {
  if (out.update && i.type === COMPONENT) {
    if (out.content === undefined && out.embeds === undefined && out.components === undefined) return { type: DEFERRED_UPDATE };
    const data = messageData(out);
    delete data.flags;
    return { type: UPDATE, data };
  }
  return { type: MESSAGE, data: messageData(out) };
}
