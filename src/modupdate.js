// Is the server's mod out of date? The newest version is the one this dashboard was deployed with
// (mod/gradle.properties, through src/modinfo.gen.js), and what changed since comes from mod/CHANGELOG.md.
// A release marked "**Urgent:** why" there makes the whole update urgent.
//
// The admin page shows it (src/admin.js → public/app.js), and the mod is told when it connects
// (src/link.js, { type: 'update' }), so a 2.1.0 or newer mod tells operators in game.
import { MOD } from './modinfo.gen.js';

// "2.0.0" → [2, 0, 0]; null if it isn't a version (a dev build, say).
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? m.slice(1).map(Number) : null;
};
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// ---------- Minecraft versions and the ranges in a jar's fabric.mod.json ----------

// "1.21.11" vs "26.2": part by part, so 26.x is newer than 1.21.x; a missing part is 0.
export function compareGame(a, b) {
  const x = String(a ?? '').split('.').map((p) => parseInt(p, 10) || 0), y = String(b ?? '').split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}
// Whether Minecraft `mc` is in a Fabric range: "1.21.11", "~26.2" (26.2 and its patches), ">=1.21.9 <=1.21.10".
export function inRange(mc, range) {
  if (!mc || !range) return false;
  return String(range).trim().split(/\s+/).every((t) => {
    const m = /^(>=|<=|>|<|=|~)?(.+)$/.exec(t);
    const op = m[1] || '=', v = m[2], c = compareGame(mc, v);
    if (op === '~') return c >= 0 && compareGame(mc.split('.').slice(0, 2).join('.'), v.split('.').slice(0, 2).join('.')) === 0;
    return { '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '=': c === 0 }[op];
  });
}
// The lowest version a range takes, for sorting.
export const rangeLow = (range) => /(?:^|\s)(?:>=|~|=)?(\d[\w.]*)/.exec(String(range ?? ''))?.[1] ?? '0';
// A range as people say it: "~26.2" → "26.2.x", ">=26.1 <26.2" → "26.1.x", ">=1.21.9 <=1.21.10" → "1.21.9–1.21.10".
export function gameLabel(range) {
  const r = String(range ?? '').trim();
  let m;
  if ((m = /^~(\d+\.\d+)$/.exec(r))) return `${m[1]}.x`;
  if ((m = /^>=(\d+)\.(\d+)(?:\.0)? <(\d+)\.(\d+)$/.exec(r)) && m[1] === m[3] && Number(m[4]) === Number(m[2]) + 1) return `${m[1]}.${m[2]}.x`;
  if ((m = /^>=([\d.]+) <=([\d.]+)$/.exec(r))) return `${m[1]}–${m[2]}`;
  if (/^[\d.]+$/.test(r)) return r;
  return r || 'unknown';
}

// The two editions: the Fabric mod and the Paper plugin. A jar listed before Paper existed is Fabric's.
export const EDITIONS = ['fabric', 'paper'];
export const editionOf = (d) => (d?.edition === 'paper' ? 'paper' : 'fabric');
// Which one a server runs, from what its mod said when it connected: the plugin's User-Agent ends in "Paper"
// ("mcstats-chat/2.5.0 (Minecraft 26.2) Paper"); the Fabric mod's says nothing more.
export const editionFromAgent = (ua) => (/\)\s*Paper\b/.test(String(ua ?? '')) ? 'paper' : 'fabric');

// The jar to hand a server: the given mod version (the newest when not given) of its edition, built for its
// Minecraft version, or, when that isn't known or nothing matches, the one built for the version the site
// calls default.
export function modJar(minecraft, version = null, mod = MOD, edition = 'fabric') {
  const list = (mod.downloads || []).filter((d) => (!version || d.version === version) && editionOf(d) === (edition === 'paper' ? 'paper' : 'fabric'));
  const pick = (minecraft && list.find((d) => inRange(minecraft, d.minecraft)))
    || list.find((d) => inRange(mod.minecraft_built, d.minecraft)) || list[0] || null;
  if (pick) return { ...pick, url: `/downloads/${pick.file}` };
  const file = edition === 'paper' && mod.paper?.jar ? mod.paper.jar : mod.jar;
  return { file, edition: edition === 'paper' ? 'paper' : 'fabric', version: mod.version, url: `/downloads/${file}` };
}

// What's newer than `version`, or null if nothing is (or the version can't be told):
//   { current, latest, edition, urgent, urgent_why: [why, one per urgent release], behind (releases),
//     jar, jar_url (the server's edition, built for `minecraft` when it's known),
//     releases: [{ version, date, urgent, urgent_why, summary, changes }] newest first }
export function modUpdate(version, mod = MOD, minecraft = null, edition = 'fabric') {
  if (compareVersions(version, mod.version) !== -1) return null;
  const newer = (mod.releases || []).filter((r) => compareVersions(r.version, version) === 1
    && compareVersions(r.version, mod.version) <= 0);
  const urgent = newer.filter((r) => r.urgent);
  const jar = modJar(minecraft, mod.version, mod, edition);
  return {
    current: version,
    latest: mod.version,
    edition: jar.edition ?? 'fabric',
    urgent: urgent.length > 0,
    urgent_why: urgent.map((r) => `${r.version}: ${r.urgent_why}`),
    behind: newer.length,
    minecraft,
    jar: jar.file,
    jar_url: jar.url,
    releases: newer,
  };
}

// The same, made small for the mod's web chat connection (it takes messages up to 8 KB): the headline of
// each change, newest release first, at most `max` of them.
export function modUpdateMessage(version, max = 8, minecraft = null, edition = 'fabric') {
  const u = modUpdate(version, MOD, minecraft, edition);
  if (!u) return null;
  const changes = [];
  for (const r of u.releases) {
    for (const c of r.changes) {
      for (const it of c.items) {
        const line = it.title ?? it.text.split(/(?<=[.!?])\s/)[0].replace(/[.:]$/, '');
        changes.push(`${r.version} ${c.section.toLowerCase()}: ${line.length > 110 ? `${line.slice(0, 109)}…` : line}`);
      }
    }
  }
  return {
    type: 'update',
    current: u.current, latest: u.latest, urgent: u.urgent,
    urgent_why: u.urgent_why.slice(0, 3).map((w) => w.slice(0, 200)),
    changes: changes.slice(0, max), more: Math.max(0, changes.length - max),
    jar: u.jar_url,
  };
}
