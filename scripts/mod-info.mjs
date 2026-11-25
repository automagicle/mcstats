// Reads the mod's versions and dependencies from mod/gradle.properties, mod/build.gradle and
// mod/src/main/resources/fabric.mod.json, and writes src/modinfo.gen.js, which /new's "Install the mods"
// step shows. Run by wrangler before every build (wrangler.jsonc "build"); test/modinfo.test.js checks the
// file is up to date.
//   node scripts/mod-info.mjs           write it
//   node scripts/mod-info.mjs --print   print what it would write
//   node scripts/mod-info.mjs --check   fail if src/modinfo.gen.js isn't what it would write (npm test runs this)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

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
  const props = Object.fromEntries(read('mod/gradle.properties').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  const gradle = read('mod/build.gradle');
  const mod = JSON.parse(read('mod/src/main/resources/fabric.mod.json'));
  const archive = /archivesName\s*=\s*'([^']+)'/.exec(gradle)?.[1] ?? 'mcstats-chat';
  const bundled = /for \(name in \[([^\]]+)\]\)[\s\S]*?include dep/.exec(gradle);
  const modules = bundled ? [...bundled[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  const depends = mod.depends || {};
  const others = Object.fromEntries(Object.entries(depends).filter(([k]) => !['fabricloader', 'minecraft', 'java'].includes(k)));
  return {
    id: mod.id,
    name: mod.name,
    version: props.version,
    jar: `${archive}-${props.version}.jar`,
    environment: mod.environment,
    minecraft: depends.minecraft,
    minecraft_built: props.minecraft_version,
    loader: depends.fabricloader,
    loader_built: props.loader_version,
    java: depends.java,
    // Fabric API: only the pieces the mod uses, built into its own jar (build.gradle `include`), so the
    // server needn't install Fabric API. Listed in case the owner has it already.
    fabric_api: { version: props.fabric_api_version, bundled: modules.length > 0, modules },
    other_depends: others,
    config_file: 'config/mcstats-chat.properties',
    // The file the mod writes on its first start (Config.java TEMPLATE), so /new can show it filled in.
    config_template: configTemplate(),
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
