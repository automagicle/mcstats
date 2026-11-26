// The bot's slash commands as Discord is told about them (scripts/discord-commands.mjs registers them, and
// src/discord/commands.js answers them). Kept free of imports so the script can read it outside the Worker.
//
// Option types: 1 subcommand, 3 string, 4 integer. contexts [0]: in Discord servers only (not DMs).
// integration_types [0]: added to a server (not to someone's account). default_member_permissions "32" is
// Manage Server: Discord shows those commands only to people who have it (a server can change that under
// Server Settings → Integrations; the bot checks again either way).

const player = (description, required = true) => ({ type: 3, name: 'name', description, required, autocomplete: true, min_length: 1, max_length: 20 });
const PERIOD = {
  type: 3, name: 'period', description: 'Which stretch of time (this season if left out)',
  choices: [
    { name: 'Today', value: 'today' }, { name: 'This week', value: 'week' },
    { name: 'This season', value: 'season' }, { name: 'All time', value: 'all' },
  ],
};
const base = { contexts: [0], integration_types: [0] };

export const COMMANDS = [
  { ...base, name: 'online', description: 'Who’s on the Minecraft server right now' },
  { ...base, name: 'server', description: 'The server at a glance: up or down, today, this week' },
  { ...base, name: 'player', description: 'One player’s stats', options: [player('Their Minecraft name')] },
  { ...base, name: 'me', description: 'Your own stats (link your player first with /mcstats connect)' },
  { ...base, name: 'seen', description: 'When a player was last on', options: [player('Their Minecraft name')] },
  {
    ...base, name: 'top', description: 'The top 10',
    options: [
      {
        type: 3, name: 'by', description: 'What to rank by (playtime if left out)',
        choices: [
          { name: 'Playtime', value: 'playtime' }, { name: 'Kills', value: 'kills' }, { name: 'Deaths', value: 'deaths' },
          { name: 'K/D', value: 'kd' }, { name: 'Advancements', value: 'advancements' },
        ],
      },
      PERIOD,
    ],
  },
  { ...base, name: 'deaths', description: 'The latest deaths', options: [player('Only deaths of (or kills by) this player', false)] },
  { ...base, name: 'dashboard', description: 'A link to the server’s mcstats dashboard' },
  {
    ...base, name: 'say', description: 'Send a message to the game’s chat',
    options: [{ type: 3, name: 'text', description: 'What to say', required: true, min_length: 1, max_length: 256 }],
  },
  {
    ...base, name: 'mcstats', description: 'mcstats: linking, setup and help',
    options: [
      { type: 1, name: 'help', description: 'What the bot can do here' },
      { type: 1, name: 'connect', description: 'Link your Discord account to your Minecraft player' },
      { type: 1, name: 'disconnect', description: 'Unlink your Discord account from your player' },
      {
        type: 1, name: 'setup', description: 'Link this Discord server to an mcstats server, or change its setup (Manage Server)',
        options: [
          { type: 3, name: 'server', description: 'The server’s dashboard address (mcstats.live/<this>)', required: false, max_length: 40 },
          { type: 3, name: 'code', description: 'The code from Admin → Discord on its dashboard', required: false, max_length: 12 },
        ],
      },
      { type: 1, name: 'status', description: 'Whether everything is working, and what to fix if not (Manage Server)' },
      { type: 1, name: 'unlink', description: 'Unlink this Discord server from mcstats (Manage Server)' },
    ],
  },
];

// The /mcstats subcommands only people with Manage Server can use.
export const ADMIN_SUBCOMMANDS = new Set(['setup', 'status', 'unlink']);
