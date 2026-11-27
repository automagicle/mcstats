// What the bot's messages look like: the embeds and lines shared by the commands (src/discord/commands.js)
// and the feeds (src/discord/relay.js). DISCORD.md has an example of each.
import { ago, CAUSE_WORDS, clip, color, dur, esc, hours, nameMd, plural, spark, stamp } from './text.js';

export const NO_PINGS = { parse: [] };
export const LINK = 5; // button style: a link

export const linkButton = (label, url) => ({ type: 2, style: LINK, label, url });
export const row = (...components) => ({ type: 1, components });

const footer = (srv) => ({ text: `mcstats · ${clip(srv.name, 60)}${srv.season > 1 ? ` · Season ${srv.season}` : ''}` });
export const embedColor = (srv) => color(srv.settings.ACCENT);
export const faceUrl = (srv, uuid) => (uuid ? `${new URL(srv.page).origin}/api/discord/head/${uuid.replace(/-/g, '')}.png` : null);
export const playerUrl = (srv, uuid) => (uuid ? `${srv.page}#/player/${uuid}` : srv.page);

const STATE = {
  up: ['🟢', 'is up'], down: ['🔴', 'is offline'], paused: ['⏸️', 'is paused'], unknown: ['⚪', 'hasn’t been checked lately'],
};

// /online, and the status message.
export function onlineEmbed(srv, online, { today = null, teams = new Map(), live = false } = {}) {
  const [dot, words] = STATE[online.status] || STATE.unknown;
  const of = online.max ? ` of ${online.max}` : '';
  const title = online.status === 'up' ? `${dot} ${srv.name}: ${online.online}${of} online` : `${dot} ${srv.name} ${words}`;
  const t = Date.now() / 1000;
  const lines = online.players.slice(0, 40).map((p) => {
    const team = teams.get(p.name.toLowerCase());
    return `**${nameMd(p.name)}**${p.since ? ` · ${dur(t - p.since)}` : ''}${team ? ` · ${esc(team)}` : ''}`;
  });
  if (online.players.length > 40) lines.push(`and ${online.players.length - 40} more`);
  if (online.status === 'up' && online.online > online.players.length) lines.push(`and ${online.online - online.players.length} not named by the server`);
  if (online.status === 'up' && !online.online) lines.push('Nobody’s on right now.');
  const desc = [lines.join('\n')];
  if (today) desc.push(`Today \`${spark(today.values)}\` peak ${today.peak}`);
  if (online.status === 'down' && online.status_api?.last?.ts) desc.push(`Last checked ${stamp(online.status_api.last.ts)}`);
  return {
    title: clip(title, 256), description: clip(desc.filter(Boolean).join('\n\n'), 4000), color: embedColor(srv), url: srv.page,
    footer: footer(srv), ...(live ? { timestamp: new Date().toISOString() } : {}),
  };
}

// /server.
export function serverEmbed(srv, { online, today, week }) {
  const [dot, words] = STATE[online.status] || STATE.unknown;
  const bits = [`${dot} ${online.status === 'up' ? `Up · ${online.online} online` : words.replace(/^is /, '').replace(/^./, (c) => c.toUpperCase())}`];
  if (srv.settings.MC_SERVER) bits.push(`\`${esc(srv.settings.MC_SERVER).replace(/\\/g, '')}\``);
  const lines = [bits.join(' · ')];
  if (today) lines.push(`Today \`${spark(today.values)}\` peak ${today.peak}`);
  lines.push(`This week: ${plural(week.players, 'player')} · ${hours(week.secs)} played`);
  return {
    title: clip(`${srv.name}${srv.season > 1 ? ` · Season ${srv.season}` : ''}`, 256), url: srv.page,
    description: lines.join('\n'), color: embedColor(srv), footer: footer(srv),
  };
}

const TAB = { playtime: 'Playtime', combat: 'Combat', advancements: 'Advancements' };

// /player and /me. tab: playtime (the default), combat or advancements.
export function playerEmbed(srv, c, tab = 'playtime') {
  const head = [];
  if (c.team) head.push(`${esc(c.team)} team`);
  if (c.first_seen) head.push(`first seen ${stamp(c.first_seen, 'D')}`);
  head.push(c.online ? `on now${c.since ? ` (${dur(Date.now() / 1000 - c.since)})` : ''}` : c.last_seen ? `last seen ${stamp(c.last_seen)}` : 'not seen lately');
  const lines = [head.join(' · '), ''];
  if (tab === 'combat' && c.combat) {
    const kd = c.combat.deaths ? (c.combat.kills / c.combat.deaths).toFixed(1) : c.combat.kills ? '∞' : '0';
    lines.push(`**Kills** ${c.combat.kills} · **Deaths** ${c.combat.deaths} · **K/D** ${kd}`);
    const causes = Object.entries(c.combat.causes).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, n]) => `${n} ${k === 'player' ? 'by players' : CAUSE_WORDS[k] || k}`);
    if (causes.length) lines.push(`Died: ${causes.join(' · ')}`);
  } else if (tab === 'advancements' && c.advancements) {
    lines.push(`**${c.advancements.count}** of ${c.advancements.of} advancements this season`);
    if (c.advancements.newest) lines.push(`Newest: ★ ${esc(c.advancements.newest.title)} (${stamp(c.advancements.newest.at)})`);
  } else {
    lines.push(`**This season** ${hours(c.season_secs)}${c.season_rank ? ` · #${c.season_rank} of ${c.season_players}` : ''}`);
    lines.push(`**All time** ${hours(c.all_secs)}`);
    if (c.combat) lines.push(`**Combat** ${c.combat.kills} kills · ${c.combat.deaths} deaths`);
    if (c.advancements) lines.push(`**Advancements** ${c.advancements.count} of ${c.advancements.of}`);
  }
  const face = faceUrl(srv, c.uuid);
  return {
    title: nameMd(c.name).replace(/\\_/g, '_'), url: playerUrl(srv, c.uuid), description: lines.join('\n'),
    color: embedColor(srv), footer: footer(srv), ...(face ? { thumbnail: { url: face } } : {}),
  };
}

// The tab buttons under a player card (stateless: the player and tab are in the custom_id).
export function playerButtons(srv, c, tab = 'playtime') {
  const tabs = ['playtime', ...(c.combat ? ['combat'] : []), ...(c.advancements ? ['advancements'] : [])];
  const buttons = tabs.length > 1
    ? tabs.map((t) => ({ type: 2, style: t === tab ? 1 : 2, label: TAB[t], custom_id: `player:v1:${t}:${c.name}`, disabled: t === tab }))
    : [];
  return [row(...buttons, linkButton('View on mcstats', playerUrl(srv, c.uuid)))];
}

export const TOP_WORDS = { playtime: 'Playtime', kills: 'Kills', deaths: 'Deaths', kd: 'K/D', advancements: 'Advancements' };

// /top: rows [{ name, value (shown) }], already ranked.
export function topEmbed(srv, by, periodWords, rows, page = 0) {
  const start = page * 10;
  const lines = rows.slice(start, start + 10).map((r, i) => `\`${String(start + i + 1).padStart(2)}\` **${nameMd(r.name)}** · ${r.value}`);
  return {
    title: clip(`${TOP_WORDS[by]} · ${periodWords} · ${srv.name}`, 256), url: srv.page, color: embedColor(srv), footer: footer(srv),
    description: lines.length ? lines.join('\n') : 'Nobody yet.',
  };
}

export function topButtons(by, period, total, page) {
  const pages = Math.max(1, Math.ceil(Math.min(total, 50) / 10));
  const nav = pages > 1 ? [
    { type: 2, style: 2, label: '◀', custom_id: `top:v1:${by}:${period}:${page - 1}`, disabled: page <= 0 },
    { type: 2, style: 2, label: `${page + 1} / ${pages}`, custom_id: `top:v1:noop:${by}:${period}`, disabled: true },
    { type: 2, style: 2, label: '▶', custom_id: `top:v1:${by}:${period}:${page + 1}`, disabled: page >= pages - 1 },
  ] : [];
  return nav.length ? [row(...nav)] : [];
}

// One feed line for an event from the game (src/discord/relay.js).
export function eventLine(e) {
  const who = e.name ? `**${nameMd(e.name)}**` : '';
  switch (e.kind) {
    case 'join': return `▶ ${who} joined${e.online != null ? ` (${e.online} online)` : ''}`;
    case 'leave': return `◀ ${who} left${e.secs ? ` after ${dur(e.secs)}` : ''}`;
    case 'death': return `☠ ${esc(e.text)}`;
    case 'advancement': return `★ ${esc(e.text)}`;
    case 'server': return `${/stop|down|offline|clos/i.test(e.text) ? '🔴' : '🟢'} ${esc(e.text)}`;
    case 'season': return `🏁 **Season ${e.n}** has started`;
    default: return esc(e.text);
  }
}

// The daily summary.
export function digestEmbed(srv, d) {
  const lines = [
    `${plural(d.players, 'player')} · ${hours(d.secs)} played · peak ${d.peak}${d.peak_at ? ` at ${stamp(d.peak_at, 't')}` : ''}`,
    `**Most time** ${d.top.map((p) => `${nameMd(p.name)} ${dur(p.secs)}`).join(' · ')}`,
  ];
  if (d.deaths != null) lines.push(`**Combat** ${plural(d.deaths, 'death')}${d.top_killer ? ` · most kills ${nameMd(d.top_killer.name)} (${d.top_killer.kills})` : ''}`);
  const fresh = [];
  if (d.advancements) fresh.push(`★ ${plural(d.advancements, 'advancement')}`);
  if (d.new_players.length) fresh.push(`${plural(d.new_players.length, 'new player')}: ${d.new_players.slice(0, 8).map(nameMd).join(', ')}`);
  if (fresh.length) lines.push(`**New** ${fresh.join(' · ')}`);
  return { title: clip(`Yesterday on ${srv.name}`, 256), url: srv.page, description: lines.join('\n'), color: embedColor(srv), footer: footer(srv) };
}

export const sinceWords = (secs) => ago(secs);
