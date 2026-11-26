// Setting a linked server up on Discord: its channels, the webhooks its feeds post through, presets, and
// unlinking. Used by Admin → Discord (src/discord/admin.js) and by /mcstats setup's wizard in Discord.
import { channelPermissions, discord, isSnowflake, missingFor, P, problem } from './api.js';
import { CHANNEL_NAMES, clearLink, dropFeed, FEEDS, getFeeds, PRESETS, putFeed } from './store.js';
import { unlinkGuild } from './server.js';
import { relayOf } from './relay.js';

const TEXT_TYPES = new Set([0, 5]); // text and announcement channels

// The guild as the bot sees it: { guild: { id, name, icon }, channels: [{ id, name, parent, perms, missing,
// missing_webhook }] } (text channels the bot can see, in Discord's order), or { error }.
export async function guildInfo(env, guildId) {
  const [g, m, c] = await Promise.all([
    discord(env, 'GET', `/guilds/${guildId}`),
    discord(env, 'GET', `/guilds/${guildId}/members/${env.DISCORD_APP_ID}`),
    discord(env, 'GET', `/guilds/${guildId}/channels`),
  ]);
  if (!g.ok || !m.ok || !c.ok) {
    const bad = [g, m, c].find((r) => !r.ok);
    return { error: bad.kind === 'gone' ? 'The bot isn’t in that Discord server (any more).' : problem(bad), gone: bad.kind === 'gone' };
  }
  const roles = g.data.roles || [];
  const all = c.data || [];
  const categories = new Map(all.filter((x) => x.type === 4).map((x) => [x.id, x]));
  const channels = all
    .filter((x) => TEXT_TYPES.has(x.type))
    .map((x) => {
      const perms = channelPermissions({ guildId, roles, member: { ...m.data, user: { id: env.DISCORD_APP_ID } }, channel: x });
      return {
        id: x.id, name: x.name, parent: categories.get(x.parent_id)?.name ?? null,
        order: [categories.get(x.parent_id)?.position ?? -1, x.position ?? 0],
        visible: !!(perms & P.VIEW_CHANNEL), missing: missingFor(perms), missing_webhook: missingFor(perms, { webhook: true }),
      };
    })
    .filter((x) => x.visible)
    .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1])
    .map(({ order, visible, ...x }) => x);
  const guildPerms = channelPermissions({ guildId, roles, member: { ...m.data, user: { id: env.DISCORD_APP_ID } }, channel: {} });
  return {
    guild: { id: g.data.id, name: g.data.name, icon: g.data.icon ?? null, system_channel_id: g.data.system_channel_id ?? null },
    channels, can_make_channels: !!(guildPerms & (P.MANAGE_CHANNELS | P.ADMINISTRATOR)),
  };
}

// The channel a preset would pick for each feed when nobody's picked one: one named for it, then one with
// minecraft, mc or server (or the server's own name) in its name, then the guild's system channel.
export function suggestChannels(info, serverName) {
  const usable = info.channels.filter((c) => !c.missing.length);
  const slug = String(serverName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const named = (n) => usable.find((c) => c.name === n);
  const likely = usable.find((c) => /minecraft|(^|-)mc(-|$)|server/.test(c.name) || (slug && c.name.includes(slug)));
  const fallback = likely?.id || usable.find((c) => c.id === info.guild.system_channel_id)?.id || usable[0]?.id || null;
  return {
    status: named('server-status')?.id || fallback,
    events: named('mc-events')?.id || fallback,
    chat: named('mc-chat')?.id || likely?.id || null,
  };
}

// Makes a "Minecraft" category with the channels the preset uses (needs Manage Channels). -> { channels } or { error }.
export async function makeChannels(env, guildId, preset) {
  const want = [...new Set(PRESETS[preset].feeds.map((f) => CHANNEL_NAMES[f]))];
  if (!want.length) return { channels: {} };
  const cat = await discord(env, 'POST', `/guilds/${guildId}/channels`, { name: 'Minecraft', type: 4 }, { reason: 'mcstats setup' });
  if (!cat.ok) return { error: cat.status === 403 ? 'needs_manage_channels' : problem(cat) };
  const made = {};
  for (const name of want) {
    const r = await discord(env, 'POST', `/guilds/${guildId}/channels`, {
      name, type: 0, parent_id: cat.data.id,
      topic: name === 'mc-chat' ? 'Minecraft chat, both ways (mcstats)' : name === 'mc-events' ? 'Joins, deaths and advancements (mcstats)' : 'Who’s on the server (mcstats)',
    }, { reason: 'mcstats setup' });
    if (!r.ok) return { error: problem(r) };
    made[name] = r.data.id;
  }
  return { channels: Object.fromEntries(['status', 'events', 'chat'].map((f) => [f, made[CHANNEL_NAMES[f]] ?? null])) };
}

async function makeWebhook(env, channelId, serverName) {
  const r = await discord(env, 'POST', `/channels/${channelId}/webhooks`, { name: `mcstats · ${serverName}`.slice(0, 80) }, { reason: 'mcstats feeds' });
  return r.ok ? { id: r.data.id, token: r.data.token } : { error: problem(r) };
}

export async function deleteWebhook(env, id) {
  if (id) await discord(env, 'DELETE', `/webhooks/${id}`, null, { reason: 'mcstats unlinked' }).catch(() => {});
}

// Points feeds at channels. feeds: { status?: { channel_id, options? } | null, … }; null (or a missing
// channel) switches that feed off. Feeds in the same channel share one webhook; a webhook no feed uses any
// more is deleted. -> { ok, feeds, notes: [why a webhook couldn't be made] }
export async function setFeeds(env, srv, wanted) {
  const have = await getFeeds(srv.db, { secrets: true });
  const notes = [];
  const byChannel = new Map();
  for (const f of Object.values(have)) if (f.webhook_id && f.webhook_token) byChannel.set(f.channel_id, { id: f.webhook_id, token: f.webhook_token });
  const next = { ...have };
  for (const feed of FEEDS) {
    if (!(feed in wanted)) continue;
    const w = wanted[feed];
    if (!w || !isSnowflake(w.channel_id)) {
      await dropFeed(srv.db, feed);
      delete next[feed];
      continue;
    }
    let hook = byChannel.get(w.channel_id);
    if (!hook) {
      const made = await makeWebhook(env, w.channel_id, srv.name);
      if (made.error) notes.push(`${feed}: ${made.error}`);
      else { hook = made; byChannel.set(w.channel_id, hook); }
    }
    const options = w.options ?? have[feed]?.options;
    await putFeed(srv.db, feed, { channel_id: w.channel_id, webhook_id: hook?.id ?? null, webhook_token: hook?.token ?? null, options });
    next[feed] = { channel_id: w.channel_id, webhook_id: hook?.id ?? null };
  }
  // webhooks that nothing uses any more
  const used = new Set(Object.values(next).map((f) => f.webhook_id).filter(Boolean));
  for (const f of Object.values(have)) if (f.webhook_id && !used.has(f.webhook_id)) { await deleteWebhook(env, f.webhook_id); used.add(f.webhook_id); }
  await relayOf(env, srv.row.id).changed();
  return { ok: true, feeds: await getFeeds(srv.db), notes };
}

// A preset, with a channel for each kind of feed: { preset, channels: { status, events, chat } }. Feeds the
// preset doesn't use are switched off. -> { ok, feeds, notes } or { error, reason }.
export async function applyPreset(env, srv, { preset, channels = {} }) {
  const p = PRESETS[preset];
  if (!p) return { error: 'That isn’t a setup.', reason: 'preset' };
  const missing = p.needs.filter((k) => !srv.config.share[k]);
  if (missing.length) return { error: `${srv.name} doesn’t share ${missing.join(' or ')} with Discord. An owner can change that on Admin → Discord.`, reason: 'share' };
  const pick = {
    status: channels.status, digest: channels.status,
    events: channels.events || channels.status, chat: channels.chat,
  };
  const wanted = {};
  for (const feed of FEEDS) {
    const on = p.feeds.includes(feed);
    if (on && !isSnowflake(pick[feed])) return { error: `Pick a channel for ${FEED_WORDS[feed]}.`, reason: feed };
    wanted[feed] = on ? { channel_id: pick[feed] } : null;
  }
  const out = await setFeeds(env, srv, wanted);
  if (p.feeds.length) await relayOf(env, srv.row.id).welcome();
  return out;
}
export const FEED_WORDS = { status: 'the status message', events: 'events', chat: 'the chat relay', digest: 'the daily summary' };

// Unlinks the server from its guild: the bot's webhooks and status message go, then both records of the link.
export async function unlink(env, srv) {
  const feeds = await getFeeds(srv.db, { secrets: true });
  await relayOf(env, srv.row.id).forget().catch((err) => console.error('discord relay forget:', err.message));
  for (const id of new Set(Object.values(feeds).map((f) => f.webhook_id).filter(Boolean))) await deleteWebhook(env, id);
  await clearLink(srv.db);
  await unlinkGuild(env, srv.row.id);
}
