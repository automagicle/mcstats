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

// What's newer than `version`, or null if nothing is (or the version can't be told):
//   { current, latest, urgent, urgent_why: [why, one per urgent release], behind (releases),
//     jar, jar_url, releases: [{ version, date, urgent, urgent_why, summary, changes }] newest first }
export function modUpdate(version, mod = MOD) {
  if (compareVersions(version, mod.version) !== -1) return null;
  const newer = (mod.releases || []).filter((r) => compareVersions(r.version, version) === 1
    && compareVersions(r.version, mod.version) <= 0);
  const urgent = newer.filter((r) => r.urgent);
  return {
    current: version,
    latest: mod.version,
    urgent: urgent.length > 0,
    urgent_why: urgent.map((r) => `${r.version}: ${r.urgent_why}`),
    behind: newer.length,
    jar: mod.jar,
    jar_url: `/downloads/${mod.jar}`,
    releases: newer,
  };
}

// The same, made small for the mod's web chat connection (it takes messages up to 8 KB): the headline of
// each change, newest release first, at most `max` of them.
export function modUpdateMessage(version, max = 8) {
  const u = modUpdate(version);
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
