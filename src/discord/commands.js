// The bot's answers: one handler per slash command, plus its buttons and menus (DISCORD.md, "Commands").
//
// A handler gets { env, srv, i, user, perms, origin, opts } and returns a message: { content?, embeds?,
// components?, ephemeral? }, or { update: true, … } to replace the message a button was on. Who may see
// what is the server's: srv.config.share says what it shares with Discord at all (src/discord/store.js), and
// every number comes through its own API as a viewer (src/discord/server.js).
import { P } from './api.js';
import { signToken } from '../session.js';
import { linkStatus, sendFromDiscord } from '../link.js';
import { limit } from '../limiter.js';
import {
  advancementTotals, closest, combatTotals, isName, lastHours, leaderboard, onlineNow, PERIOD_WORDS, playerCard, recentDeaths, suggestNames, teamsOf,
} from './data.js';
import {
  embedColor, linkButton, onlineEmbed, playerButtons, playerEmbed, row, serverEmbed, topButtons, topEmbed,
} from './render.js';
import { clip, esc, hours, nameMd, stamp } from './text.js';
import { cleanCode, getFeeds, playerOf, PRESETS, setLink, unlinkPlayer, useCode } from './store.js';
import { linkGuild, openServer } from './server.js';
import { applyPreset, FEED_WORDS, guildInfo, suggestChannels, unlink } from './setup.js';
import { relayOf } from './relay.js';
import { serverBySlug, SLUG_RE } from '../directory.js';
import { ADMIN_SUBCOMMANDS } from './definitions.js';

const say = (content, extra = {}) => ({ content, ...extra });
const private_ = (content, extra = {}) => ({ content, ephemeral: true, ...extra });

export const NOT_LINKED = 'This Discord server isn’t linked to mcstats yet. A server owner can link it in two clicks from the '
  + 'dashboard (**Admin → Discord → Add to Discord**), or make a code there for someone with Manage Server to use with `/mcstats setup`.';

const notShared = (srv, what) => private_(`**${esc(srv.name)}** doesn’t share ${what} on Discord.`);
const needsMod = (srv, what) => private_(`**${esc(srv.name)}**’s Minecraft server doesn’t run the mcstats mod, so there are no ${what} to show.`);

async function unknownPlayer(srv, name) {
  const guess = await closest(srv, name).catch(() => null);
  return private_(`Nobody called **${nameMd(name)}** has played on **${esc(srv.name)}**.${guess ? ` Did you mean **${nameMd(guess)}**?` : ''}`);
}

const dashboardRow = (srv) => row(linkButton('Open dashboard', srv.page));
const hasManage = (perms) => !!(perms & (P.MANAGE_GUILD | P.ADMINISTRATOR));

// ---------- for everyone ----------

const COMMANDS = {
  async online({ srv }) {
    const [online, today, teams] = await Promise.all([onlineNow(srv), lastHours(srv, 24).catch(() => null), teamsOf(srv)]);
    return { embeds: [onlineEmbed(srv, online, { today: srv.config.share.stats ? today : null, teams })], components: [dashboardRow(srv)] };
  },

  async server({ srv }) {
    const online = await onlineNow(srv);
    let today = null, week = { players: 0, secs: 0 };
    if (srv.config.share.stats) {
      const lb = await leaderboard(srv, 'week');
      today = await lastHours(srv, 24).catch(() => null);
      week = { players: lb.length, secs: lb.reduce((n, p) => n + p.secs, 0) };
    }
    const embed = serverEmbed(srv, { online, today, week });
    if (!srv.config.share.stats) embed.description = embed.description.split('\n').slice(0, 1).join('\n');
    const buttons = [linkButton('Open dashboard', srv.page)];
    if (srv.config.share.joinlink && srv.settings.JOIN_LINK && !srv.isPublic) buttons.push(linkButton('Join link', `${srv.page}/join/${srv.settings.JOIN_LINK}`));
    return { embeds: [embed], components: [row(...buttons)] };
  },

  async player({ srv, opts }) {
    if (!srv.config.share.stats) return notShared(srv, 'player stats');
    const name = String(opts.name || '').trim();
    if (!isName(name)) return private_('That isn’t a Minecraft name.');
    const card = await playerCard(srv, name);
    if (!card) return unknownPlayer(srv, name);
    return { embeds: [playerEmbed(srv, card)], components: playerButtons(srv, card) };
  },

  async me({ srv, user }) {
    const linked = await playerOf(srv.db, user.id);
    if (!linked) return private_(`Your Discord account isn’t linked to a player on **${esc(srv.name)}** yet. Use \`/mcstats connect\`.`);
    if (!srv.config.share.stats) return notShared(srv, 'player stats');
    const card = await playerCard(srv, linked.name);
    if (!card) return private_(`**${nameMd(linked.name)}** hasn’t played on **${esc(srv.name)}** yet.`);
    return { embeds: [playerEmbed(srv, card)], components: playerButtons(srv, card), ephemeral: true };
  },

  async seen({ srv, opts }) {
    if (!srv.config.share.stats) return notShared(srv, 'player stats');
    const name = String(opts.name || '').trim();
    if (!isName(name)) return private_('That isn’t a Minecraft name.');
    const [online, all] = await Promise.all([onlineNow(srv), leaderboard(srv, 'all')]);
    const on = online.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const row_ = all.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!row_ && !on) return unknownPlayer(srv, name);
    const who = `**${nameMd(on?.name || row_.name)}**`;
    if (on) return say(`🟢 ${who} is on **${esc(srv.name)}** now${on.since ? `, for ${hours(Date.now() / 1000 - on.since)}` : ''}.`);
    return say(`${who} was last on **${esc(srv.name)}** ${stamp(row_.last_seen)} (${stamp(row_.last_seen, 'f')}).`);
  },

  async top({ srv, opts }, page = 0) {
    const by = ['playtime', 'kills', 'deaths', 'kd', 'advancements'].includes(opts.by) ? opts.by : 'playtime';
    const period = ['today', 'week', 'season', 'all'].includes(opts.period) ? opts.period : 'season';
    if (!srv.config.share.stats) return notShared(srv, 'stats');
    let rows;
    if (by === 'playtime') {
      rows = (await leaderboard(srv, period)).map((p) => ({ name: p.name, value: hours(p.secs) }));
    } else if (by === 'advancements') {
      if (!srv.config.share.advancements) return notShared(srv, 'advancements');
      if (!srv.hasMod) return needsMod(srv, 'advancements');
      const { players, titles } = await advancementTotals(srv);
      rows = [...players.values()].filter((p) => p.done.size).sort((a, b) => b.done.size - a.done.size)
        .map((p) => ({ name: p.name, value: `${p.done.size} of ${titles.size}` }));
    } else {
      if (!srv.config.share.deaths) return notShared(srv, 'kills and deaths');
      if (!srv.hasMod) return needsMod(srv, 'kills or deaths');
      const all = [...(await combatTotals(srv, period)).values()];
      if (by === 'kd') {
        rows = all.filter((p) => p.kills + p.deaths >= 3).map((p) => ({ ...p, kd: p.kills / Math.max(1, p.deaths) }))
          .sort((a, b) => b.kd - a.kd || b.kills - a.kills).map((p) => ({ name: p.name, value: `${p.kd.toFixed(2)} (${p.kills}/${p.deaths})` }));
      } else {
        rows = all.filter((p) => p[by]).sort((a, b) => b[by] - a[by]).map((p) => ({ name: p.name, value: String(p[by]) }));
      }
    }
    const words = by === 'advancements' ? PERIOD_WORDS.season : PERIOD_WORDS[period];
    const last = Math.max(0, Math.ceil(Math.min(rows.length, 50) / 10) - 1);
    const p = Math.min(Math.max(0, page), last);
    return { embeds: [topEmbed(srv, by, words, rows, p)], components: topButtons(by, period, rows.length, p) };
  },

  async deaths({ srv, opts }) {
    if (!srv.config.share.deaths) return notShared(srv, 'deaths');
    if (!srv.hasMod) return needsMod(srv, 'deaths');
    const name = opts.name ? String(opts.name).trim() : null;
    if (name && !isName(name)) return private_('That isn’t a Minecraft name.');
    const list = await recentDeaths(srv, name, 10);
    const lines = list.map((d) => `☠ ${esc(d.text)} · ${stamp(d.ts)}`);
    return {
      embeds: [{
        title: clip(`Latest deaths${name ? ` · ${name}` : ''} · ${srv.name}`, 256), url: `${srv.page}#/combat`, color: embedColor(srv),
        description: lines.length ? clip(lines.join('\n'), 4000) : 'No deaths this season.',
      }],
    };
  },

  async dashboard({ srv }) {
    const buttons = [linkButton('Open dashboard', srv.page)];
    const join = srv.config.share.joinlink && srv.settings.JOIN_LINK && !srv.isPublic;
    if (join) buttons.push(linkButton('Join (no password needed)', `${srv.page}/join/${srv.settings.JOIN_LINK}`));
    const how = srv.isPublic ? 'Anyone can look.' : join ? 'The Join button lets you in without the password.' : 'It asks for the server’s join password.';
    return private_(`**${esc(srv.name)}** on mcstats: ${srv.page}\n${how}`, { components: [row(...buttons)] });
  },

  async say({ env, srv, user, opts }) {
    const mode = srv.config.bridge.say;
    if (mode === 'off') return private_(`**${esc(srv.name)}** doesn’t take chat from Discord. An owner can switch it on (Admin → Discord).`);
    const text = String(opts.text || '').trim();
    if (!text) return private_('Say something.');
    if (/^\/(w|msg|tell|whisper)\b/i.test(text)) return private_('Whispers can’t be sent from Discord.');
    const linked = await playerOf(srv.db, user.id);
    let name = linked?.name ?? null, guest = false;
    if (!name) {
      if (mode !== 'anyone') return private_(`Link your Discord account to your player first: \`/mcstats connect\`.`);
      name = String(user.global_name || user.username || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'someone';
      guest = true;
      const status = await linkStatus(srv.env);
      if (!atLeast(status?.version, '2.4.0')) {
        return private_(`**${esc(srv.name)}**’s server needs mcstats mod 2.4.0 or newer to take chat from Discord users who haven’t linked a player.`);
      }
    }
    const r = await sendFromDiscord(srv.env, { name, guest, key: `discord:${user.id}`, text });
    if (r.status === 200) return private_(`Sent to **${esc(srv.name)}** as **${nameMd(name)}**${guest ? '*' : ''}.`);
    if (r.status === 202) return private_(`Sent to **${esc(srv.name)}**, but the server didn’t confirm it yet.`);
    return private_(r.body?.error ? esc(r.body.error) : 'The server didn’t take that message.');
  },
};

export function atLeast(version, want) {
  const a = String(version || '0').split(/[.+-]/).map(Number), b = want.split('.').map(Number);
  for (let k = 0; k < 3; k++) { if ((a[k] || 0) !== b[k]) return (a[k] || 0) > b[k]; }
  return true;
}

// ---------- /mcstats ----------

const MCSTATS = {
  async help({ srv }) {
    if (!srv) return private_(`**mcstats** brings a Minecraft server’s stats into Discord.\n\n${NOT_LINKED}`);
    const s = srv.config.share;
    const lines = [
      `This Discord server is linked to **${esc(srv.name)}** (${srv.page}).`, '',
      '`/online` who’s on now · `/server` the server at a glance · `/dashboard` the link',
      ...(s.stats ? ['`/player` `/seen` `/top` stats for any player · `/me` yours'] : []),
      ...(s.deaths && srv.hasMod ? ['`/deaths` the latest deaths · `/top by:kills`'] : []),
      ...(srv.config.bridge.say !== 'off' ? ['`/say` send a message into the game'] : []),
      '`/mcstats connect` link your Discord account to your player',
      '`/mcstats status` `/mcstats setup` for people with Manage Server',
    ];
    return private_(lines.join('\n'));
  },

  async connect({ env, srv, user, origin }) {
    const have = await playerOf(srv.db, user.id);
    if (have) return private_(`Your Discord account is linked to **${nameMd(have.name)}** on **${esc(srv.name)}**. \`/mcstats disconnect\` unlinks it.`);
    const token = await signToken(env, {
      k: 'discordme', s: srv.row.id, d: user.id, n: String(user.global_name || user.username || '').slice(0, 40), x: Math.floor(Date.now() / 1000) + 600,
    });
    return private_(
      `Link your Discord account to your Minecraft player on **${esc(srv.name)}**: open the link below and sign in to mcstats with the account `
      + 'your player is connected to (in game: `/mcstats connect`). The link works for 10 minutes.',
      { components: [row(linkButton('Link with mcstats', `${origin}/api/discord/connect?t=${encodeURIComponent(token)}`))] },
    );
  },

  async disconnect({ srv, user }) {
    return private_((await unlinkPlayer(srv.db, user.id))
      ? `Unlinked. Your Discord account isn’t anyone’s player on **${esc(srv.name)}** any more.`
      : 'Your Discord account wasn’t linked to a player here.');
  },

  // Linking with a code (DISCORD.md, "Way 2"), then the setup wizard. Already linked: just the wizard.
  async setup(c) {
    const { env, i, opts, origin } = c;
    let srv = c.srv;
    if (!srv || opts.code) {
      const slug = String(opts.server || '').trim().toLowerCase().replace(/^https?:\/\/[^/]+\//, '').replace(/\/.*$/, '');
      const code = cleanCode(opts.code);
      if (!slug || !code) {
        return private_(srv ? 'This Discord server is linked already. Run `/mcstats setup` with nothing after it to change its setup.'
          : 'To link this Discord server, a server owner makes a code on the dashboard (**Admin → Discord → Link with a code**). '
            + 'Then run `/mcstats setup server:<its address> code:<the code>`.');
      }
      const tries = await limit(env, [[`dsetup:${i.guild_id}`, 5, 900], [`dsetup-s:${slug}`, 10, 900]]);
      if (!tries.ok) return private_('Too many tries. Wait a few minutes and try again.');
      const wrong = private_('That server and code don’t match. Codes work once, for 15 minutes: make a new one on Admin → Discord.');
      const row_ = SLUG_RE.test(slug) ? await serverBySlug(env, slug) : null;
      if (!row_) return wrong;
      const target = await openServer(env, row_, origin);
      const by = await useCode(target.db, code);
      if (!by) return wrong;
      const linked = await linkGuild(env, i.guild_id, row_.id, by);
      if (linked.error) return private_('This Discord server is already linked to another mcstats server. Unlink it there first (`/mcstats unlink`).');
      const info = await guildInfo(env, i.guild_id);
      await setLink(target.db, { guild_id: i.guild_id, guild_name: info.guild?.name ?? null, guild_icon: info.guild?.icon ?? null, by });
      srv = await openServer(env, row_, origin);
      return wizard(env, srv, i.guild_id, null, `✅ Linked to **${esc(srv.name)}**. Now pick what goes where:`);
    }
    return wizard(env, srv, i.guild_id);
  },

  async status({ env, srv, i }) {
    const [info, feeds, relay, mod] = await Promise.all([
      guildInfo(env, i.guild_id), getFeeds(srv.db), relayOf(env, srv.row.id).state().catch(() => null), linkStatus(srv.env),
    ]);
    const chan = new Map((info.channels || []).map((x) => [x.id, x]));
    const lines = [`Linked to **${esc(srv.name)}** (${srv.page})${srv.link?.linked_at ? ` since ${stamp(srv.link.linked_at, 'D')}` : ''}.`];
    if (srv.link?.broken) lines.push(`⚠️ Posting stopped: ${esc(srv.link.broken)} Set it up again with \`/mcstats setup\`.`);
    lines.push(mod?.linked ? `🟢 The Minecraft server’s mod is connected (${esc(mod.version || 'unknown version')}).`
      : srv.hasMod ? '🔴 The Minecraft server’s mod isn’t connected right now: no chat, deaths or `/say` until it is.' : '⚪ The Minecraft server doesn’t run the mcstats mod: commands work, but there’s no chat, deaths or advancements.');
    lines.push('');
    if (!Object.keys(feeds).length) lines.push('No feeds: only commands. `/mcstats setup` picks some.');
    for (const [feed, f] of Object.entries(feeds)) {
      const ch = chan.get(f.channel_id);
      const missing = ch ? (feed === 'chat' ? ch.missing_webhook : ch.missing) : null;
      const state = !ch ? '⚠️ the bot can’t see that channel'
        : missing.length ? `⚠️ missing ${missing.join(', ')}`
          : f.last_error ? `⚠️ ${esc(f.last_error)} (${stamp(f.last_error_at)})`
            : f.last_ok ? `✅ last post ${stamp(f.last_ok)}` : '✅ nothing posted yet';
      const q = relay?.queued?.[feed]?.n;
      lines.push(`**${FEED_WORDS[feed][0].toUpperCase()}${FEED_WORDS[feed].slice(1)}** → <#${f.channel_id}> · ${state}${q ? ` · ${q} waiting` : ''}`);
    }
    if (relay?.dropped) lines.push(`${relay.dropped} posts were dropped while Discord couldn’t be reached.`);
    const s = srv.config.share;
    lines.push('', `Shared: ${['online', 'stats', 'deaths', 'advancements', 'chat'].filter((k) => s[k]).join(', ')}. Commands answer ${srv.config.commands.ephemeral ? 'only whoever asked' : 'in the channel'}. \`/say\`: ${srv.config.bridge.say}.`);
    return private_(clip(lines.join('\n'), 2000), {
      components: Object.keys(feeds).length ? [row({ type: 2, style: 2, label: 'Send a test to each feed', custom_id: 'status:v1:test' }, linkButton('Admin → Discord', `${srv.page}#/admin/discord`))] : [],
    });
  },

  async unlink({ srv }) {
    return private_(`Unlink this Discord server from **${esc(srv.name)}**? Its feeds stop and the bot’s webhooks and status message are deleted. Linking it again later starts over.`, {
      components: [row({ type: 2, style: 4, label: 'Unlink', custom_id: 'unlink:v1:yes' }, { type: 2, style: 2, label: 'Cancel', custom_id: 'unlink:v1:no' })],
    });
  },
};

// ---------- the setup wizard (stateless: what's been picked rides in the Save button's custom_id) ----------

const PRESET_CODE = { commands: 'c', status: 's', community: 'm', bridge: 'b' };
const CODE_PRESET = Object.fromEntries(Object.entries(PRESET_CODE).map(([k, v]) => [v, k]));
const CHANNEL_FEEDS = { commands: [], status: ['status'], community: ['status', 'events'], bridge: ['status', 'events', 'chat'] };
const CHANNEL_LABEL = { status: 'Channel for the status message and daily summary', events: 'Channel for joins, deaths and advancements', chat: 'Channel for the game’s chat (both ways)' };

const saveId = (st) => `setup:v1:save:${PRESET_CODE[st.preset]}:${st.status || '-'}:${st.events || '-'}:${st.chat || '-'}`;
function stateFrom(message) {
  for (const r of message?.components || []) {
    for (const c of r.components || []) {
      const m = /^setup:v1:save:([csmb]):(\d+|-):(\d+|-):(\d+|-)$/.exec(c.custom_id || '');
      if (m) return { preset: CODE_PRESET[m[1]], status: m[2] === '-' ? null : m[2], events: m[3] === '-' ? null : m[3], chat: m[4] === '-' ? null : m[4] };
    }
  }
  return null;
}

async function wizard(env, srv, guildId, st = null, lead = null) {
  if (!st) {
    const feeds = await getFeeds(srv.db);
    const info = await guildInfo(env, guildId);
    const guess = info.error ? {} : suggestChannels(info, srv.name);
    const preset = feeds.chat ? 'bridge' : feeds.events ? 'community' : feeds.status ? 'status' : 'community';
    st = {
      preset,
      status: feeds.status?.channel_id || guess.status || null,
      events: feeds.events?.channel_id || guess.events || null,
      chat: feeds.chat?.channel_id || guess.chat || null,
    };
  }
  const options = Object.entries(PRESETS).map(([id, p]) => {
    const blocked = p.needs.filter((k) => !srv.config.share[k]);
    return {
      label: p.label, value: id, default: id === st.preset,
      description: clip(blocked.length ? `Needs ${blocked.join(', ')} shared (an owner can on the dashboard)` : PRESET_HELP[id], 100),
    };
  });
  const rows = [row({ type: 3, custom_id: 'setup:v1:preset', placeholder: 'What should the bot do here?', options })];
  for (const feed of CHANNEL_FEEDS[st.preset]) {
    rows.push(row({
      type: 8, custom_id: `setup:v1:ch:${feed}`, placeholder: CHANNEL_LABEL[feed], channel_types: [0, 5],
      ...(st[feed] ? { default_values: [{ id: st[feed], type: 'channel' }] } : {}),
    }));
  }
  rows.push(row({ type: 2, style: 3, label: 'Save', custom_id: saveId(st) }, linkButton('More on the dashboard', `${srv.page}#/admin/discord`)));
  const picked = CHANNEL_FEEDS[st.preset].map((f) => `${FEED_WORDS[f]} → ${st[f] ? `<#${st[f]}>` : '(pick one)'}`);
  return {
    content: clip([lead || `Setup for **${esc(srv.name)}**:`, `**${PRESETS[st.preset].label}**: ${PRESET_HELP[st.preset]}`, ...picked].join('\n'), 2000),
    components: rows, ephemeral: true,
  };
}
const PRESET_HELP = {
  commands: 'slash commands only, nothing posted',
  status: 'a live status message and a daily summary',
  community: 'status message, daily summary, and joins, deaths and advancements',
  bridge: 'everything, plus the game’s chat in a channel',
};

// ---------- buttons and menus ----------

export async function component(c) {
  const { env, srv, i, perms } = c;
  const id = i.data.custom_id || '';
  const [kind, version, ...rest] = id.split(':');
  if (version !== 'v1') return private_('This message is out of date. Run the command again.');
  if (kind === 'player') {
    const [tab, ...name] = rest;
    if (!srv.config.share.stats) return notShared(srv, 'player stats');
    const card = await playerCard(srv, name.join(':'));
    if (!card) return private_('That player isn’t here any more.');
    return { update: true, embeds: [playerEmbed(srv, card, tab)], components: playerButtons(srv, card, tab) };
  }
  if (kind === 'top') {
    const [by, period, page] = rest;
    if (by === 'noop') return { update: true };
    const out = await COMMANDS.top({ ...c, opts: { by, period } }, Number(page) || 0);
    return out.ephemeral ? out : { ...out, update: true };
  }
  if (!hasManage(perms)) return private_('Only people with Manage Server can do that.');
  if (kind === 'status' && rest[0] === 'test') {
    const r = await relayOf(env, srv.row.id).test();
    const lines = Object.entries(r?.results || {}).map(([f, v]) => `${FEED_WORDS[f]}: ${v === 'ok' ? '✅ posted' : `⚠️ ${esc(v)}`}`);
    return private_(lines.join('\n') || 'No feeds to test.');
  }
  if (kind === 'unlink') {
    if (rest[0] !== 'yes') return { update: true, content: 'Left as it is.', components: [] };
    await unlink(env, srv);
    return { update: true, content: `Unlinked from **${esc(srv.name)}**. The bot can be removed from this Discord server under Server Settings → Integrations, or linked again with \`/mcstats setup\`.`, components: [] };
  }
  if (kind === 'setup') {
    const st = stateFrom(i.message) || { preset: 'community', status: null, events: null, chat: null };
    if (rest[0] === 'preset') {
      st.preset = PRESETS[i.data.values?.[0]] ? i.data.values[0] : st.preset;
      return { ...(await wizard(env, srv, i.guild_id, st)), update: true };
    }
    if (rest[0] === 'ch' && ['status', 'events', 'chat'].includes(rest[1])) {
      st[rest[1]] = i.data.values?.[0] || null;
      return { ...(await wizard(env, srv, i.guild_id, st)), update: true };
    }
    if (rest[0] === 'save') {
      const out = await applyPreset(env, srv, { preset: st.preset, channels: st });
      if (out.error) return private_(out.error);
      const done = CHANNEL_FEEDS[st.preset].map((f) => `${FEED_WORDS[f]} → <#${st[f]}>`);
      const notes = out.notes?.length ? `\n⚠️ ${out.notes.map(esc).join('\n⚠️ ')}\n(Without Manage Webhooks, posts come from the bot instead of each player.)` : '';
      return {
        update: true, components: [],
        content: clip(`✅ Saved: **${PRESETS[st.preset].label}**.${done.length ? `\n${done.join('\n')}` : ''}${notes}\n\`/mcstats status\` shows how it’s going.`, 2000),
      };
    }
  }
  return private_('This message is out of date. Run the command again.');
}

// ---------- dispatch ----------

// The answer to a slash command: a message as above.
export async function command(c) {
  const { srv, i, perms } = c;
  const name = i.data.name;
  if (name === 'mcstats') {
    const sub = i.data.options?.[0];
    const subName = sub?.name;
    if (!MCSTATS[subName]) return private_('That isn’t a command.');
    const opts = Object.fromEntries((sub.options || []).map((o) => [o.name, o.value]));
    if (ADMIN_SUBCOMMANDS.has(subName) && !hasManage(perms)) return private_('Only people with Manage Server can do that.');
    if (!srv && subName !== 'help' && subName !== 'setup') return private_(NOT_LINKED);
    return MCSTATS[subName]({ ...c, opts });
  }
  if (!srv) return private_(NOT_LINKED);
  if (!srv.config.commands.on) return private_(`**${esc(srv.name)}** has the bot’s commands switched off.`);
  if (!COMMANDS[name]) return private_('That isn’t a command.');
  const opts = Object.fromEntries((i.data.options || []).map((o) => [o.name, o.value]));
  const out = await COMMANDS[name]({ ...c, opts });
  // the server can have every answer seen only by whoever asked
  return srv.config.commands.ephemeral ? { ...out, ephemeral: true } : out;
}

// Autocomplete for player names: [{ name, value }].
export async function autocomplete({ srv, i }) {
  if (!srv || !srv.config.share.stats) return [];
  const focused = (i.data.options || []).flatMap((o) => (o.type === 1 ? o.options || [] : [o])).find((o) => o.focused);
  if (!focused || focused.name !== 'name') return [];
  return (await suggestNames(srv, focused.value)).map((n) => ({ name: n, value: n }));
}

