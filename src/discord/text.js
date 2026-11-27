// Turning mcstats' numbers and the game's text into what Discord shows: escaped, cut to Discord's limits, and
// worded the way the dashboard words them.

// Markdown Discord would act on, escaped; mentions and channel links broken with a zero-width space; links
// shown as plain text without a preview. Game text never pings anyone (allowed_mentions is empty as well).
export function esc(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]|§./g, '')
    .replace(/([\\*_~`|>[\]])/g, '\\$1')
    .replace(/^([#-])/gm, '\\$1') // headings and lists only start a line
    .replace(/@/g, '@​')
    .replace(/<(?=[@#:a])/g, '<​')
    .replace(/(https?:\/\/[^\s<]+)/g, '<$1>');
}

// A player's name: only the characters a name can have, with _ escaped.
export const nameMd = (n) => String(n ?? '').replace(/[^A-Za-z0-9_.*]/g, '').replace(/_/g, '\\_');

export const clip = (s, max) => {
  const t = String(s ?? '');
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
};

// 3h 05m, 41h 20m, 12m, just now
export function dur(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

// Hours played, as the dashboard rounds them: 212 h, 4.5 h, 25 min
export function hours(secs) {
  const m = Math.round((Number(secs) || 0) / 60);
  if (m < 60) return `${m} min`;
  const h = m / 60;
  return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10} h`;
}

// 3 hours ago, 2 days ago, just now
export function ago(secs, now = Date.now() / 1000) {
  const d = Math.max(0, now - secs);
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400 * 1.5) return `${Math.round(d / 3600)} hour${Math.round(d / 3600) === 1 ? '' : 's'} ago`;
  if (d < 86400 * 45) return `${Math.round(d / 86400)} days ago`;
  return `${Math.round(d / 86400 / 30)} months ago`;
}

// Discord's own timestamps: shown in each reader's time zone. style R = "3 hours ago", t = "8:41 PM", f = date and time.
export const stamp = (secs, style = 'R') => `<t:${Math.floor(secs)}:${style}>`;

// ▁▂▃▄▅▆▇█ for a row of numbers (scaled to the largest). A row of zeros is all ▁.
const BARS = '▁▂▃▄▅▆▇█';
export function spark(values) {
  const max = Math.max(0, ...values);
  return values.map((v) => (max ? BARS[Math.min(7, Math.round((v / max) * 7))] : BARS[0])).join('');
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The start of the day `secs` falls on, in time zone `tz` (unix seconds).
export function dayStart(tz, secs = Date.now() / 1000) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(secs * 1000));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) / 1000;
  const offset = asUtc - Math.floor(secs);
  return Date.UTC(get('year'), get('month') - 1, get('day')) / 1000 - offset;
}

// The hour of the day (0-23) `secs` falls on in `tz`.
export function hourIn(tz, secs = Date.now() / 1000) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(secs * 1000)));
}

// The server's accent as an embed color (Discord wants an integer). Green unless the server picked another.
const ACCENTS = { green: 0x3d8a26, blue: 0x2f6fd6 };
export function color(accent) {
  if (/^#[0-9a-f]{6}$/i.test(accent || '')) return parseInt(accent.slice(1), 16);
  return ACCENTS[accent] ?? ACCENTS.green;
}

// Death causes (src/combat.js CAUSES), in words.
export const CAUSE_WORDS = {
  melee: 'by players and mobs', shot: 'shot', explosion: 'explosions', fall: 'falling', fire: 'fire', lava: 'lava', drown: 'drowning',
  void: 'the void', border: 'the border', magic: 'magic', wither: 'wither', sonic: 'the warden', lightning: 'lightning', crush: 'crushed',
  suffocation: 'suffocation', starve: 'starving', freeze: 'freezing', thorns: 'thorns', other: 'other',
};
