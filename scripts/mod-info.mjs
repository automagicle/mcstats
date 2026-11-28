// Reads the mod's versions and dependencies from mod/gradle.properties, mod/build.gradle and
// mod/src/fabric/resources/fabric.mod.json, and writes src/modinfo.gen.js, which /new's "Install the mods"
// step shows. Run by wrangler before every build (wrangler.jsonc "build"); test/modinfo.test.js checks the
// file is up to date.
//   node scripts/mod-info.mjs           write it
//   node scripts/mod-info.mjs --print   print what it would write
//   node scripts/mod-info.mjs --check   fail if src/modinfo.gen.js isn't what it would write (npm test runs this)
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseChangelog } from '../src/changelog.js';
import { compareGame, gameLabel, rangeLow } from '../src/modupdate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const properties = (text) => Object.fromEntries(text.split('\n')
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

// One file out of a zip (a jar): found through the central directory, stored or deflated.
export function zipEntry(buf, wanted) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) return null;
  let at = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    if (buf.readUInt32LE(at) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    if (buf.toString('utf8', at + 46, at + 46 + nameLen) === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 8 ? inflateRawSync(data) : method === 0 ? data : null;
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// Every jar in public/downloads (what the site serves at /downloads/), with its edition ('fabric', the mod, or
// 'paper', the plugin), the mod version and the Minecraft versions it says it runs on (a Fabric jar's own
// fabric.mod.json, a Paper jar's mcstats.json), newest mod first, then newest Minecraft first.
export function downloads(dir = join(root, 'public/downloads')) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jar') && !f.endsWith('-sources.jar')).sort()) {
    const buf = readFileSync(join(dir, file));
    const fabric = zipEntry(buf, 'fabric.mod.json');
    if (fabric) {
      const meta = JSON.parse(fabric.toString('utf8'));
      const minecraft = String(meta.depends?.minecraft ?? '');
      out.push({ file, edition: 'fabric', version: meta.version, minecraft, label: gameLabel(minecraft), java: meta.depends?.java ?? null, loader: meta.depends?.fabricloader ?? null });
      continue;
    }
    const paper = zipEntry(buf, 'mcstats.json');
    if (!paper) continue;
    const meta = JSON.parse(paper.toString('utf8'));
    const minecraft = String(meta.minecraft ?? '');
    out.push({ file, edition: 'paper', version: meta.version, minecraft, label: gameLabel(minecraft), java: meta.java ?? null, loader: null });
  }
  const parts = (v) => String(v).split(/[.+-]/).map((x) => Number(x) || 0);
  const cmp = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  return out.sort((a, b) => cmp(b.version, a.version) || compareGame(rangeLow(b.minecraft), rangeLow(a.minecraft)) || a.edition.localeCompare(b.edition));
}

// Config.java's TEMPLATE text block, with its indentation taken off as Java does.
function configTemplate() {
  const java = read('mod/src/main/java/dev/mcserverstats/chatlog/Config.java');
  const m = /TEMPLATE = """\n([\s\S]*?)""";/.exec(java);
  if (!m) throw new Error('Config.java: TEMPLATE not found');
  const lines = m[1].split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n').replace(/\s+$/, '') + '\n';
}

export function modInfo() {
  const props = properties(read('mod/gradle.properties'));
  // one jar per folder in mod/versions/ (target.gradle); the default one is the version gradle.properties names
  const target = properties(read(`mod/versions/${props.minecraft_version}/gradle.properties`));
  const gradle = read('mod/target.gradle');
  const mod = JSON.parse(read('mod/src/fabric/resources/fabric.mod.json'));
  const archive = /archivesName\s*=\s*'([^']+)'/.exec(gradle)?.[1] ?? 'mcstats-chat';
  const bundled = /fabricApiModules\s*=\s*\[([^\]]+)\]/.exec(gradle);
  const modules = bundled ? [...bundled[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  const depends = mod.depends || {};
  const others = Object.fromEntries(Object.entries(depends).filter(([k]) => !['fabricloader', 'minecraft', 'java'].includes(k)));
  const files = downloads();
  // the newest version's jar for the default Minecraft version, as built (target.gradle: <version>+mc<folder>)
  const jar = files.find((d) => d.edition === 'fabric' && d.version === props.version && d.file.includes(`+mc${props.minecraft_version}.jar`))?.file
    ?? `${archive}-${props.version}+mc${props.minecraft_version}.jar`;
  // the Paper plugin: one jar per Minecraft version (mod/paper/<mc>/, mod/paper.gradle)
  const paperDir = join(root, 'mod/paper');
  const paperBuilt = existsSync(paperDir) ? readdirSync(paperDir).filter((d) => existsSync(join(paperDir, d, 'gradle.properties')))
    .map((d) => properties(read(`mod/paper/${d}/gradle.properties`))) : [];
  const paperJar = files.find((d) => d.edition === 'paper' && d.version === props.version && d.file.includes(`+mc${props.minecraft_version}.jar`))?.file
    ?? `mcstats-paper-${props.version}+mc${props.minecraft_version}.jar`;
  return {
    id: mod.id,
    name: mod.name,
    version: props.version,
    jar,
    environment: mod.environment,
    minecraft: target.minecraft_range,
    minecraft_built: props.minecraft_version,
    loader: `>=${target.loader_min}`,
    loader_built: props.loader_version,
    java: `>=${target.java_version}`,
    // every jar the site has, for picking one by Minecraft version and mod version (src/modupdate.js modJar)
    downloads: files,
    // Fabric API: only the pieces the mod uses, built into its own jar (build.gradle `include`), so the
    // server needn't install Fabric API. Listed in case the owner has it already.
    fabric_api: { version: props.fabric_api_version, bundled: modules.length > 0, modules },
    other_depends: others,
    config_file: 'config/mcstats-chat.properties',
    // The same mod as a Paper plugin (mod/src/paper): everything above but Fabric's loader and API. Its jars are
    // in `downloads` with edition 'paper'; each runs on exactly the Minecraft version it was built for.
    paper: {
      jar: paperJar,
      minecraft: paperBuilt.map((p) => p.minecraft_version).sort(compareGame),
      java: `>=${paperBuilt.find((p) => p.minecraft_version === props.minecraft_version)?.java_version ?? target.java_version}`,
      config_file: 'plugins/mcstats/mcstats-chat.properties',
    },
    // The file the mod writes on its first start (Config.java TEMPLATE), so /new can show it filled in.
    config_template: configTemplate(),
    // mod/CHANGELOG.md, for telling admins what a newer version brings (src/modupdate.js)
    releases: parseChangelog(read('mod/CHANGELOG.md')),
  };
}

const text = `// Written by scripts/mod-info.mjs from mod/ — don't edit; run \`node scripts/mod-info.mjs\`.\nexport const MOD = ${JSON.stringify(modInfo(), null, 2)};\n`;
if (process.argv.includes('--print')) process.stdout.write(text);
else if (process.argv.includes('--check')) {
  if (readFileSync(join(root, 'src/modinfo.gen.js'), 'utf8') !== text) {
    console.error('src/modinfo.gen.js is out of date: run node scripts/mod-info.mjs');
    process.exit(1);
  }
}
// only when it changed: `wrangler dev` runs this on every build and rebuilds when the file is touched
else if (import.meta.url === `file://${process.argv[1]}`) {
  let old = null;
  try { old = readFileSync(join(root, 'src/modinfo.gen.js'), 'utf8'); } catch {}
  if (old !== text) writeFileSync(join(root, 'src/modinfo.gen.js'), text);
}
export { text as MOD_INFO_TEXT };
