// Sets the Discord app up for mcstats, with nothing but the bot's token (DISCORD.md, "Operator setup"):
//
//   DISCORD_BOT_TOKEN=… npm run discord:setup
//       reads the app's Application ID and Public Key from Discord and writes them into wrangler.jsonc,
//       sets the install link (guild install, bot + applications.commands, the bot's permissions),
//       registers the slash commands, and checks the OAuth2 redirect is there
//   DISCORD_BOT_TOKEN=… npm run discord:setup -- --endpoint [https://mcstats.live]
//       after deploying: sets the Interactions Endpoint URL (Discord checks it right away, so the Worker must
//       already be deployed with this app's Public Key)
//
// What only the app's owner can do on https://discord.com/developers/applications (create the app, copy the bot
// token and the client secret, add the redirect) the script can't, and says so when it's missing.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COMMANDS } from '../src/discord/definitions.js';

const API = 'https://discord.com/api/v10';
const PERMISSIONS = String((1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 16n) | (1n << 29n)); // 536955904
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const at = args.indexOf('--endpoint');
const endpointOrigin = at < 0 ? null : (args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : null);

const token = (process.env.DISCORD_BOT_TOKEN || '').trim();
if (!token) {
  console.error('Set DISCORD_BOT_TOKEN: Developer Portal → your app → Bot → Reset Token.');
  process.exit(1);
}

async function discord(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://mcstats.live, 1)' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}
const fail = (what, r) => {
  console.error(`✘ ${what}: Discord answered ${r.status} ${JSON.stringify(r.data)}`);
  process.exit(1);
};

const wranglerPath = join(root, 'wrangler.jsonc');
const origin = (endpointOrigin || readFileSync(wranglerPath, 'utf8').match(/"SITE_ORIGIN":\s*"([^"]+)"/)?.[1] || 'https://mcstats.live').replace(/\/$/, '');

const me = await discord('GET', '/applications/@me');
if (me.status === 401) fail('The token was refused (reset it on the Bot page and try again)', me);
if (!me.ok) fail('Reading the app', me);
const app = me.data;
console.log(`App: ${app.name} (${app.id})`);

if (at >= 0) {
  // after deploying: the Interactions Endpoint URL, which Discord checks with a signed PING right away
  const url = `${origin}/api/discord/interactions`;
  const r = await discord('PATCH', '/applications/@me', { interactions_endpoint_url: url });
  if (!r.ok) {
    console.error(`✘ Discord didn't accept ${url}: ${JSON.stringify(r.data)}`);
    console.error('  Is the Worker deployed, with DISCORD_PUBLIC_KEY in wrangler.jsonc matching this app? (run this script without --endpoint, then deploy)');
    process.exit(1);
  }
  console.log(`✓ Interactions Endpoint URL: ${url}`);
  console.log('\nDone. Open a server’s dashboard → Admin → Discord → Add to Discord.');
  process.exit(0);
}

// 1. the two public values, into wrangler.jsonc
let w = readFileSync(wranglerPath, 'utf8');
const set = (key, value) => {
  const re = new RegExp(`("${key}":\\s*)"[^"]*"`);
  if (!re.test(w)) {
    console.error(`✘ wrangler.jsonc has no "${key}" var to fill in.`);
    process.exit(1);
  }
  w = w.replace(re, `$1"${value}"`);
};
set('DISCORD_APP_ID', app.id);
set('DISCORD_PUBLIC_KEY', app.verify_key);
writeFileSync(wranglerPath, w);
console.log(`✓ wrangler.jsonc: DISCORD_APP_ID ${app.id}, DISCORD_PUBLIC_KEY ${app.verify_key.slice(0, 8)}…`);

// 2. the install link: added to Discord servers only, with the bot and its commands and only the permissions it needs
const install = { scopes: ['bot', 'applications.commands'], permissions: PERMISSIONS };
let r = await discord('PATCH', '/applications/@me', { integration_types_config: { 0: { oauth2_install_params: install } }, install_params: install });
if (r.ok) console.log('✓ Install link: guild install, bot + applications.commands, permissions 536955904');
else console.log(`! Couldn't set the install link (${r.status}): set it on the Installation page by hand (DISCORD.md, "Operator setup" step 5).`);

// 3. the slash commands
r = await discord('PUT', `/applications/${app.id}/commands`, COMMANDS);
if (!r.ok) fail('Registering the commands', r);
console.log(`✓ ${r.data.length} slash commands registered: ${r.data.map((c) => `/${c.name}`).join(' ')}`);

// 4. things only the owner can set on the portal: checked, not set
const redirect = `${origin}/api/discord/oauth`;
const redirects = app.redirect_uris || [];
if (redirects.includes(redirect)) console.log(`✓ OAuth2 redirect ${redirect} is there`);
else console.log(`! Add the OAuth2 redirect ${redirect} (Developer Portal → OAuth2 → Redirects → Add Redirect → Save).`);
if (app.bot_public === false) console.log('! The bot isn’t public: other people’s Discord servers can’t add it (Bot → Public Bot).');
if (app.interactions_endpoint_url) console.log(`  Interactions Endpoint URL is ${app.interactions_endpoint_url}`);

console.log(`
Next:
  npx wrangler secret put DISCORD_BOT_TOKEN       (the same token)
  npx wrangler secret put DISCORD_CLIENT_SECRET   (OAuth2 → Client Secret)
  npm run deploy
  DISCORD_BOT_TOKEN=… npm run discord:setup -- --endpoint`);
