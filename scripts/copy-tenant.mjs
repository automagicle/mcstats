// Copies the single-server D1 database (everything recorded before servers had their own) into the first
// server's Durable Object, then checks that every table has the same number of rows in both. Run it once,
// after deploying the multi-server Worker:
//
//   OPS_TOKEN=… JOIN_PASSWORD=… node scripts/copy-tenant.mjs --url https://<your worker> --owner you@example.org
//
// Options:
//   --url URL          the deployed Worker (required)
//   --owner EMAIL      the first server's owner (required)
//   --slug SLUG        its address (default: LEGACY_SLUG from wrangler.jsonc, "eggsmp")
//   --name NAME        its display name (default "eggSMP")
//   --local            read the local D1 instead of the remote one (to rehearse against `npm run dev`)
//   --chunk N          rows per request (default 1000)
// Environment: OPS_TOKEN (the Worker's OPS_TOKEN secret), JOIN_PASSWORD (the server's join password, at
// least 8 characters; only used the first time, when the server is made).
//
// What it does:
//   1. makes the server (or finds it) with its old settings (scripts/eggsmp.settings.json, and the Worker's
//      MC_SERVER secret), marked as the one the old shared CHAT_INGEST_TOKEN belongs to, and paused: while
//      paused it refuses uploads with 503 (the mod keeps them and sends them again) and doesn't check the
//      server, so nothing new lands while old rows are copied in;
//   2. copies each table in chunks (a chunk sent twice replaces itself, so it's safe to run again);
//   3. compares row counts table by table and stops, still paused, if any differ;
//   4. otherwise un-pauses the server: the copied permissions become roles (admin where the admin page was
//      allowed), the old ADMIN_EMAIL logins are admins, and the owner is the owner.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DATA_TABLES } from '../src/tenant/schema.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const local = args.includes('--local');
const base = (opt('url') || '').replace(/\/$/, '');
const owner = opt('owner');
const chunk = Number(opt('chunk', 1000));
const wranglerConfig = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const slug = opt('slug', /"LEGACY_SLUG":\s*"([^"]+)"/.exec(wranglerConfig)?.[1] || 'eggsmp');
const name = opt('name', 'eggSMP');
const token = process.env.OPS_TOKEN || '';
if (!base || !owner || token.length < 32) {
  console.error('usage: OPS_TOKEN=… JOIN_PASSWORD=… node scripts/copy-tenant.mjs --url https://… --owner you@example.org [--local]');
  process.exit(2);
}

function d1(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mcstats', local ? '--local' : '--remote', '--json', '--command', sql], {
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const parsed = JSON.parse(out);
  return (Array.isArray(parsed) ? parsed[0] : parsed).results;
}

async function ops(path, body) {
  let res;
  // A kept-alive connection can be closed by the other end while a slow D1 read runs: try again, a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`${base}/api/ops${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const settings = JSON.parse(readFileSync(new URL('./eggsmp.settings.json', import.meta.url), 'utf8'));
delete settings['//'];

console.log(`1. making ${slug} (${name}), paused`);
const made = await ops('/servers', { slug, name, owner, password: process.env.JOIN_PASSWORD, legacy: true, paused: true, settings });
console.log(`   server id ${made.id}`);

const existing = new Set(d1("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
console.log('2. copying');
for (const table of DATA_TABLES) {
  if (!existing.has(table)) {
    console.log(`   ${table}: not in D1, skipped`);
    continue;
  }
  const columns = d1(`PRAGMA table_info(${table})`).map((c) => c.name);
  const withoutRowid = /WITHOUT ROWID/i.test(d1(`SELECT sql FROM sqlite_master WHERE name = '${table}'`)[0]?.sql || '');
  const pk = d1(`PRAGMA table_info(${table})`).filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => `"${c.name}"`);
  let copied = 0;
  let after = -Infinity;
  for (let offset = 0; ; offset += chunk) {
    const cols = columns.map((c) => `"${c}"`).join(', ');
    const rows = withoutRowid
      ? d1(`SELECT ${cols} FROM ${table} ORDER BY ${pk.join(', ')} LIMIT ${chunk} OFFSET ${offset}`)
      : d1(`SELECT rowid AS _rowid_, ${cols} FROM ${table} WHERE rowid > ${after === -Infinity ? -9223372036854775807n : after} ORDER BY rowid LIMIT ${chunk}`);
    if (!rows.length) break;
    if (!withoutRowid) after = rows[rows.length - 1]._rowid_;
    await ops(`/servers/${slug}/import`, { table, columns, rows: rows.map((r) => columns.map((c) => r[c])) });
    copied += rows.length;
    process.stdout.write(`\r   ${table}: ${copied}`);
    if (rows.length < chunk) break;
  }
  process.stdout.write(`\r   ${table}: ${copied}\n`);
}

console.log('3. comparing row counts');
const there = await ops(`/servers/${slug}/counts`);
let bad = 0;
for (const table of DATA_TABLES) {
  const here = existing.has(table) ? d1(`SELECT COUNT(*) AS n FROM ${table}`)[0].n : 0;
  const ok = here === there[table];
  if (!ok) bad += 1;
  console.log(`   ${ok ? 'ok  ' : 'DIFF'} ${table.padEnd(18)} D1 ${String(here).padStart(8)}   server ${String(there[table]).padStart(8)}`);
}
if (bad) {
  console.error(`\n${bad} table(s) differ. The server stays paused (uploads wait, nothing is lost); fix it and run this again.`);
  process.exit(1);
}

console.log('4. every table matches: un-pausing');
const info = await ops(`/servers/${slug}/finish`, {});
console.log(`   done. ${base}/${info.slug}  (members: ${info.members}, checking ${info.mc_server || 'no address'})`);
