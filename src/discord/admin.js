// Admin → Discord (GET/POST /<server>/api/admin/discord). Answered by the Worker (src/index.js) rather than the
// server's own object, because it talks to Discord and to the directory.
//
//   GET                                   everything the section shows (below)
//   POST { action: 'code' }               owners: a link code for /mcstats setup (15 minutes, used once)
//   POST { action: 'unlink' }             owners: unlink the Discord server
//   POST { action: 'share', share }       owners: what may go to Discord at all
//   POST { action: 'bridge', bridge }     owners: who may /say ({ say: 'off' | 'linked' | 'anyone' })
//   POST { action: 'commands', commands } admins: commands on or off, answers seen by everyone or only the asker
//   POST { action: 'preset', preset, channels: { status, events, chat } }   admins: a preset (Way 1's last step)
//   POST { action: 'feeds', feeds: { status: { channel_id, options } | null, … } }   admins: feeds one by one
//   POST { action: 'test' }               admins: a test post in each feed
//   POST { action: 'player.unlink', discord_id }   admins: a Discord user no longer counts as their player
import { json } from '../util.js';
import { loadPerms } from '../roles.js';
import { linkStatus } from '../link.js';
import { discordReady, isSnowflake } from './api.js';
import { openServer } from './server.js';
import { DEFAULT_OPTIONS, FEEDS, getFeeds, newCode, playersLinked, PRESETS, setConfig, unlinkPlayer, CODE_MINUTES } from './store.js';
import { applyPreset, guildInfo, makeChannels, setFeeds, suggestChannels, unlink } from './setup.js';
import { relayOf } from './relay.js';
import { setBroken } from './store.js';

const MAX_BODY = 16 * 1024;

export async function discordAdmin(request, env, url, row, stub, who, origin) {
  const g = await stub.gate(who);
  if (!g.who?.email) return json({ error: 'unauthorized' }, 401);
  const srv = await openServer(env, row, origin);
  const perms = await loadPerms(srv.env, { email: g.who.email });
  if (!perms.admin && !perms.super) return json({ error: 'forbidden' }, 403);
  const owner = !!(perms.owner || perms.super);

  if (request.method === 'GET') return json(await state(env, srv, owner));
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const o = request.headers.get('Origin');
  if (o && o !== url.origin) return json({ error: 'wrong origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, 413);
  let b;
  try { b = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  const ownersOnly = () => json({ error: 'Only the server’s owners can change that.' }, 403);
  const needLink = () => json({ error: 'Link a Discord server first.' }, 409);

  switch (b?.action) {
    case 'code': {
      if (!owner) return ownersOnly();
      const code = await newCode(srv.db, g.who.email);
      return json({ ok: true, code, minutes: CODE_MINUTES, command: `/mcstats setup server:${row.slug} code:${code}` });
    }
    case 'unlink': {
      if (!owner) return ownersOnly();
      if (!srv.link) return needLink();
      await unlink(env, srv);
      console.log(`discord: ${g.who.email} unlinked ${row.slug}`);
      break;
    }
    case 'share':
    case 'bridge': {
      if (!owner) return ownersOnly();
      await setConfig(srv.db, srv.isPublic, { [b.action]: b[b.action] || {} });
      await relayOf(env, row.id).changed();
      break;
    }
    case 'commands':
      await setConfig(srv.db, srv.isPublic, { commands: b.commands || {} });
      break;
    case 'preset': {
      if (!srv.link) return needLink();
      let channels = b.channels || {};
      if (b.make === true) {
        const made = await makeChannels(env, srv.link.guild_id, b.preset);
        if (made.error) return json({ error: made.error === 'needs_manage_channels' ? 'The bot needs Manage Channels to make channels.' : made.error, reason: made.error }, 409);
        channels = made.channels;
      }
      const out = await applyPreset(env, srv, { preset: b.preset, channels });
      if (out.error) return json(out, 400);
      await setBroken(srv.db, null);
      return json({ ...(await state(env, await openServer(env, row, origin), owner)), notes: out.notes });
    }
    case 'feeds': {
      if (!srv.link) return needLink();
      const wanted = {};
      for (const f of FEEDS) {
        if (!(f in (b.feeds || {}))) continue;
        const v = b.feeds[f];
        if (v && !isSnowflake(v.channel_id)) return json({ error: `Pick a channel for ${f}.` }, 400);
        if (f === 'chat' && v && !srv.config.share.chat) return json({ error: 'Chat isn’t shared with Discord.' }, 400);
        wanted[f] = v ? { channel_id: v.channel_id, options: v.options } : null;
      }
      const out = await setFeeds(env, srv, wanted);
      return json({ ...(await state(env, srv, owner)), notes: out.notes });
    }
    case 'test': {
      if (!srv.link) return needLink();
      return json({ ok: true, ...(await relayOf(env, row.id).test()) });
    }
    case 'player.unlink': {
      if (!isSnowflake(b.discord_id)) return json({ error: 'bad id' }, 400);
      await unlinkPlayer(srv.db, b.discord_id);
      break;
    }
    default:
      return json({ error: 'unknown action' }, 400);
  }
  return json(await state(env, await openServer(env, row, origin), owner));
}

async function state(env, srv, owner) {
  const ready = discordReady(env);
  const base = {
    ready, can_install: ready && !!env.DISCORD_CLIENT_SECRET, owner,
    install_url: `/api/discord/install?server=${encodeURIComponent(srv.row.slug)}`,
    public: srv.isPublic, has_mod: srv.hasMod, has_join_link: !!srv.settings.JOIN_LINK,
    config: srv.config,
    presets: Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, { label: p.label, feeds: p.feeds, needs: p.needs }])),
    defaults: DEFAULT_OPTIONS,
    link: null,
  };
  if (!srv.link) return base;
  const [feeds, info, relay, mod, players] = await Promise.all([
    getFeeds(srv.db),
    ready ? guildInfo(env, srv.link.guild_id) : { error: 'not set up' },
    relayOf(env, srv.row.id).state().catch(() => null),
    linkStatus(srv.env),
    playersLinked(srv.db),
  ]);
  return {
    ...base,
    link: { ...srv.link, linked_by: owner ? srv.link.linked_by : null, guild_name: info.guild?.name ?? srv.link.guild_name },
    guild: info.error ? { error: info.error } : { channels: info.channels, can_make_channels: info.can_make_channels, suggested: suggestChannels(info, srv.name) },
    feeds, relay, mod: { linked: !!mod?.linked, version: mod?.version ?? mod?.last_version ?? null },
    players,
  };
}
