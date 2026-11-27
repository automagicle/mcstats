// Discord's REST API, as the bot uses it (DISCORD.md). One small client for everything: requests made with the
// bot's token, and requests to the webhooks the bot made (those carry their own token in the address).
//
// Every answer is sorted into what to do about it:
//   ok     2xx
//   rate   429: wait retryAfter seconds and send it again
//   retry  5xx or no answer: send it again later
//   gone   401/403/404: the bot, the channel or the webhook isn't there (or isn't allowed) any more. Never
//          sent again as it is: Discord bans addresses that keep making requests like that.
//   bad    any other 4xx: the request itself was wrong
//
// Config (wrangler.jsonc vars and secrets): DISCORD_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN,
// DISCORD_CLIENT_SECRET. Without the first three the bot is simply off (discordReady).

export const API = 'https://discord.com/api/v10';

// The permissions the bot asks for when it's added (DISCORD.md, "Permissions"), and the ones it checks.
export const P = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_WEBHOOKS: 1n << 29n,
};
export const INSTALL_PERMISSIONS = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS | P.READ_MESSAGE_HISTORY | P.MANAGE_WEBHOOKS; // 536955904
export const PERMISSION_NAMES = [
  [P.VIEW_CHANNEL, 'View Channel'], [P.SEND_MESSAGES, 'Send Messages'], [P.EMBED_LINKS, 'Embed Links'],
  [P.READ_MESSAGE_HISTORY, 'Read Message History'], [P.MANAGE_WEBHOOKS, 'Manage Webhooks'],
];

export const discordReady = (env) => !!(env.DISCORD_APP_ID && env.DISCORD_PUBLIC_KEY && env.DISCORD_BOT_TOKEN);

const SNOWFLAKE_RE = /^\d{15,22}$/;
export const isSnowflake = (v) => typeof v === 'string' && SNOWFLAKE_RE.test(v);

// method, path (under API, or a full https://discord.com address), body (JSON, or null).
// auth: 'bot' (the bot's token) or 'none' (a webhook: its token is in the path).
// -> { ok, kind, status, data, retryAfter, bucket, remaining, resetAfter }
export async function discord(env, method, path, body = null, { auth = 'bot', reason = null } = {}) {
  const url = path.startsWith('https://') ? path : `${API}${path}`;
  const headers = { 'User-Agent': 'DiscordBot (https://mcstats.live, 1)' };
  if (auth === 'bot') headers.Authorization = `Bot ${env.DISCORD_BOT_TOKEN}`;
  if (body != null) headers['Content-Type'] = 'application/json';
  if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason).slice(0, 400);
  let res;
  try {
    res = await fetch(url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  } catch (err) {
    return { ok: false, kind: 'retry', status: 0, data: { message: err.message } };
  }
  let data = null;
  const text = await res.text().catch(() => '');
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  const num = (h) => (res.headers.get(h) == null ? null : Number(res.headers.get(h)));
  const out = {
    ok: res.ok, status: res.status, data,
    bucket: res.headers.get('X-RateLimit-Bucket'), remaining: num('X-RateLimit-Remaining'), resetAfter: num('X-RateLimit-Reset-After'),
    retryAfter: null, global: false,
  };
  if (res.ok) return { ...out, kind: 'ok' };
  if (res.status === 429) {
    const after = Number(data?.retry_after ?? res.headers.get('Retry-After'));
    return { ...out, kind: 'rate', retryAfter: Number.isFinite(after) && after > 0 ? Math.min(after, 600) : 5, global: !!data?.global };
  }
  if (res.status >= 500) return { ...out, kind: 'retry' };
  if (res.status === 401 || res.status === 403 || res.status === 404) return { ...out, kind: 'gone' };
  return { ...out, kind: 'bad' };
}

// What went wrong, in a few plain words, for the admin page and /mcstats status.
export function problem(r) {
  if (r.ok) return null;
  const code = r.data?.code;
  if (code === 50013) return 'The bot is missing a permission in that channel.';
  if (code === 50001) return 'The bot can’t see that channel.';
  if (code === 10003) return 'That channel was deleted.';
  if (code === 10015) return 'Its webhook was deleted.';
  if (code === 10004) return 'The bot was removed from the Discord server.';
  if (code === 30007) return 'That channel has too many webhooks (Discord allows 15).';
  if (r.kind === 'rate') return 'Discord is rate limiting the bot.';
  if (r.kind === 'retry') return 'Discord didn’t answer.';
  if (r.status === 401) return 'The bot’s token was refused.';
  return String(r.data?.message || `HTTP ${r.status}`).slice(0, 160);
}

// The bot's permissions in a channel, from the guild's roles, the bot's member record and the channel's
// overwrites (Discord's documented order: @everyone, then roles, then the member).
export function channelPermissions({ guildId, roles, member, channel }) {
  const byId = new Map(roles.map((r) => [r.id, BigInt(r.permissions)]));
  let base = byId.get(guildId) ?? 0n;
  for (const id of member.roles || []) base |= byId.get(id) ?? 0n;
  if (base & P.ADMINISTRATOR) return ~0n & ((1n << 64n) - 1n);
  const ow = channel.permission_overwrites || [];
  const apply = (o) => { if (o) base = (base & ~BigInt(o.deny)) | BigInt(o.allow); };
  apply(ow.find((o) => o.id === guildId));
  let deny = 0n, allow = 0n;
  for (const o of ow) if (o.type === 0 && o.id !== guildId && (member.roles || []).includes(o.id)) { deny |= BigInt(o.deny); allow |= BigInt(o.allow); }
  base = (base & ~deny) | allow;
  apply(ow.find((o) => o.type === 1 && o.id === member.user?.id));
  return base;
}

// The names of the permissions a feed needs in a channel that the bot doesn't have there.
export function missingFor(perms, { webhook = false } = {}) {
  const need = [P.VIEW_CHANNEL, P.SEND_MESSAGES, P.EMBED_LINKS, P.READ_MESSAGE_HISTORY, ...(webhook ? [P.MANAGE_WEBHOOKS] : [])];
  return PERMISSION_NAMES.filter(([bit]) => need.includes(bit) && !(perms & bit)).map(([, name]) => name);
}
