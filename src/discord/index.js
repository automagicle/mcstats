// /api/discord/*: the Discord bot's site-level addresses (DISCORD.md). A server's own Admin → Discord is under
// its address instead (/<server>/api/admin/discord, src/discord/admin.js).
//
//   POST /api/discord/interactions     Discord: slash commands, buttons, autocomplete (src/discord/interactions.js)
//   GET  /api/discord/install          the dashboard's "Add to Discord" (src/discord/install.js)
//   GET  /api/discord/oauth            Discord sends the browser back here after adding the bot
//   GET/POST /api/discord/connect      linking a Discord account to a player
//   GET  /api/discord/head/<uuid>.png  a player's face, for webhook avatars and thumbnails (src/discord/head.js)
import { json } from '../util.js';
import { uploadOrigin } from '../site.js';
import { handleInteraction } from './interactions.js';
import { connect, install, oauth } from './install.js';
import { serveHead } from './head.js';

export async function handleDiscord(request, env, url, ctx) {
  const p = url.pathname;
  const origin = uploadOrigin(env, url);
  if (p === '/api/discord/interactions') return handleInteraction(request, env, ctx, origin);
  if (p === '/api/discord/install' && request.method === 'GET') return install(request, env, url, origin);
  if (p === '/api/discord/oauth' && request.method === 'GET') return oauth(request, env, url, origin);
  if (p === '/api/discord/connect') return connect(request, env, url, origin);
  const head = /^\/api\/discord\/head\/([0-9a-f]{32})\.png$/.exec(p);
  if (head && request.method === 'GET') return serveHead(env, head[1]);
  return json({ error: 'not found' }, 404);
}
