// Puts the mod's jars where the site serves them: every mod/versions/<mc>/build/libs/mcstats-chat-<version>+mc<mc>.jar
// (Fabric) and mod/paper/<mc>/build/libs/mcstats-paper-<version>+mc<mc>.jar (Paper) that `./gradlew build` made goes
// to public/downloads/ (served at /downloads/), then src/modinfo.gen.js is
// written again so the dashboard lists them (scripts/mod-info.mjs). Older versions' jars already there stay, so
// admins can still pick them.
//   npm run build:mod     build every Minecraft version, then this
//   node scripts/mod-release.mjs     only this (after a build)
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = /^version=(.+)$/m.exec(readFileSync(join(root, 'mod/gradle.properties'), 'utf8'))[1].trim();
const out = join(root, 'public/downloads');
mkdirSync(out, { recursive: true });

const copied = [], missing = [];
for (const mc of readdirSync(join(root, 'mod/versions')).sort()) {
  if (!existsSync(join(root, 'mod/versions', mc, 'gradle.properties'))) continue;
  const file = `mcstats-chat-${version}+mc${mc}.jar`;
  const from = join(root, 'mod/versions', mc, 'build/libs', file);
  if (existsSync(from)) { copyFileSync(from, join(out, file)); copied.push(file); } else missing.push(`${mc} (Fabric)`);
}
// the Paper plugin: mod/paper/<mc>/build/libs/mcstats-paper-<version>+mc<mc>.jar
if (existsSync(join(root, 'mod/paper'))) {
  for (const mc of readdirSync(join(root, 'mod/paper')).sort()) {
    if (!existsSync(join(root, 'mod/paper', mc, 'gradle.properties'))) continue;
    const file = `mcstats-paper-${version}+mc${mc}.jar`;
    const from = join(root, 'mod/paper', mc, 'build/libs', file);
    if (existsSync(from)) { copyFileSync(from, join(out, file)); copied.push(file); } else missing.push(`${mc} (Paper)`);
  }
}
console.log(`Copied ${copied.length} jar(s) to public/downloads:\n  ${copied.join('\n  ')}`);
if (missing.length) console.warn(`Not built (so not offered) for Minecraft ${missing.join(', ')}.`);
execFileSync(process.execPath, [join(root, 'scripts/mod-info.mjs')], { stdio: 'inherit' });
