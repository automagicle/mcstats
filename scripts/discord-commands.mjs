// Tells Discord about the bot's slash commands (src/discord/definitions.js). Run it once when setting the bot
// up, and again whenever the commands change (DISCORD.md, "Operator setup"):
//
//   DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… npm run discord:commands
//   … npm run discord:commands -- --guild <id>   only in one Discord server: shows up at once, for trying changes
//   … npm run discord:commands -- --print        print what would be sent, and send nothing
//
// It replaces the whole list, so a command taken out of definitions.js disappears from Discord too.
import { COMMANDS } from '../src/discord/definitions.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1] ?? true;
};

if (flag('--print')) {
  console.log(JSON.stringify(COMMANDS, null, 2));
  process.exit(0);
}

const app = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (!/^\d{15,22}$/.test(app || '') || !token) {
  console.error('Set DISCORD_APP_ID and DISCORD_BOT_TOKEN (Discord Developer Portal → your app → General / Bot).');
  process.exit(1);
}
const guild = flag('--guild');
if (guild && !/^\d{15,22}$/.test(String(guild))) {
  console.error('--guild takes a Discord server id (right-click the server with Developer Mode on → Copy Server ID).');
  process.exit(1);
}

const url = `https://discord.com/api/v10/applications/${app}${guild ? `/guilds/${guild}` : ''}/commands`;
const res = await fetch(url, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://mcstats.live, 1)' },
  // a guild's own commands can't say where they're used; they're only ever in that guild anyway
  body: JSON.stringify(guild ? COMMANDS.map(({ contexts, integration_types, ...c }) => c) : COMMANDS),
});
const body = await res.json().catch(() => null);
if (!res.ok) {
  console.error(`Discord answered ${res.status}:`, JSON.stringify(body, null, 2));
  process.exit(1);
}
console.log(`Registered ${body.length} commands${guild ? ` in Discord server ${guild}` : ' (global: they show up in every server the bot is in)'}:`);
for (const c of body) console.log(`  /${c.name}  ${c.description}`);
