# Discord bot (design)

A Discord app for mcstats. Once it's added to a Discord server it can:

- **answer questions**: `/online`, `/player Steve`, `/top kills week`, `/seen Alex`, `/server`;
- **post what happens in game**: chat, joins, deaths, advancements, the server going up or down, a live status
  message, and a daily summary;
- **let Discord talk into the game** with `/say`, and later a whole bridged channel.

It's one app for the whole site, added to many Discord servers. This doc calls a Discord server a **guild** and
a Minecraft server on mcstats a **server**. Each guild is linked to one server and can only ever see that one,
the same way everything else on the site is kept apart.

Status: phases 1 and 2 are built (code in `src/discord/`, tests in `test/discord.test.js`), apart from the
pieces listed here. Phase 3 (a whole bridged channel) isn't built.

| Not built yet | Instead, for now |
| --- | --- |
| Linking a player from in game (`/mcstats discord` code, "Way A") | linking through the mcstats account ("Way B"), which needs no mod change |
| The optional "Add to Discord" step on `/new` ("Way 3") | Admin → Discord, once the server is made |
| Joins and leaves for servers without the mod (from polling) | joins and leaves come from the mod's chat lines |
| The team next to a player's name in the chat feed | the player's name only |
| Mod 2.4.0 itself | the mod change is in `mod/` and `mod/CHANGELOG.md` ("Unreleased"), not built or released. Until it is, chat from Discord shows in game with the `[Web]` tag, and `/say` from Discord users who haven't linked a player is refused |

Contents: [What it builds on](#what-the-bot-builds-on) · [Who it's for](#who-its-for) ·
[Adding it to Discord](#adding-it-to-a-discord-server) · [How it fits](#how-it-fits) ·
[Data](#data) · [Interactions](#interactions) · [Commands](#commands) · [Feeds](#feeds-game--discord) ·
[Bridge](#bridge-discord--game) · [Linking players](#linking-players) · [Admin → Discord](#admin--discord) ·
[Privacy and security](#privacy-and-security) · [Limits and failures](#limits-and-failures) · [Cost](#cost) ·
[Operator setup](#operator-setup-once-for-the-site) · [Testing](#testing) · [Phases](#phases) ·
[Open questions](#open-questions)

## What the bot builds on

**mcstats** (the site) tracks who's on a Minecraft server and when, and shows each server on its own private
dashboard (`/<server>/`). It polls the server every minute and records player counts and each player's sessions.
From those it shows players online over time, a daily heatmap, a leaderboard, busiest hours, a page for each
player, and seasons. Each server has its own join password and join link (or is public), its own members and
roles, and its own data. No server can see another's.

**The mod** (an optional Fabric server mod, `mod/`) adds what polling can't see. It sends the server's public
chat, every death (who, by whom or what, and how), each player's gear and their advancements, and a live list of
who's online. It also keeps a socket open so chat typed on the dashboard shows up in game, players can connect
their mcstats account from in game with `/mcstats connect`, and admins can watch the world live in 3D (Liveview).

What the bot can do without the mod:

| Works without the mod | Needs the mod |
| --- | --- |
| `/online`, `/server`, `/seen`, and the playtime parts of `/player` and `/top` | deaths, kills, advancements, chat |
| joins and leaves (from polling, up to a minute late), up/down, status message, daily summary (playtime only) | chat feed, death feed, advancement feed |
| | `/say` and the bridged channel; linking a player from in game |

## Who it's for

- **Players** check who's on before logging in (`/online`), look up themselves and others (`/me`, `/player`), and
  argue about `/top kills`. If they've linked their player, they can chat into the game from their phone with
  `/say`.
- **Server owners** get their server's life into the Discord where their community already is, with nothing to
  host. They decide exactly what's shared: a private server can share only an online count.
- **Discord admins** (often the same people) get a two-click install, a preset that sets up sensible channels,
  and a `/mcstats status` that says what's wrong when something stops posting.

## Adding it to a Discord server

The aim is that a typical owner is done in under a minute and never types a code. There are three ways in, and
all of them end at the same place: the guild is linked to the server, and a preset has picked what goes where.

### Way 1: from the dashboard (recommended, about 30 seconds)

For an owner who is also an admin of the guild.

1. Open the server's dashboard → **Admin → Discord** → **Add to Discord**.
2. Discord's own "Add app" screen opens. Pick the guild and click **Authorize**. Discord only lists guilds where
   you have **Manage Server**, so that check is Discord's.
3. You land back on **Admin → Discord**, linked, with the **Choose a setup** step open:
   - pick a preset (below);
   - for each feed it switches on, pick a channel. The picker suggests the guild's channels whose names
     contain `minecraft`, `mc`, `server` or the server's name, and otherwise its system channel;
   - or tick **Make the channels for me**. That's a second, short Discord prompt that adds Manage Channels for
     this one step, and it makes a `Minecraft` category with the channels the preset uses.
4. **Save**. The bot posts a welcome message in the first feed channel ("mcstats is connected to Egg SMP. Try
   `/online`."), and the status message appears if the preset has one.

The link button is a normal Discord OAuth2 install link with a signed `state`:

```
https://discord.com/oauth2/authorize
  ?client_id=<DISCORD_APP_ID>
  &scope=bot+applications.commands
  &permissions=536955904                       (see "Permissions" below)
  &integration_type=0                          (guild install)
  &response_type=code
  &redirect_uri=https://mcstats.live/api/discord/oauth
  &state=<signToken({ k: 'discord', s: <server id>, e: <owner email>, x: now + 15 min })>
```

Discord sends the browser back to `/api/discord/oauth?code&state&guild_id&permissions`. The Worker:

1. reads `s` from the state's body, then checks the signature and expiry with
   `verifyToken(env, state, 'discord', s)` (`src/session.js`);
2. checks that the mcstats account signed in now (the site-wide account cookie) is the one in `e`, and that
   it's still an owner of server `s`;
3. exchanges `code` at `POST https://discord.com/api/oauth2/token` (with `DISCORD_CLIENT_SECRET`). The answer
   includes the guild the app was added to. That proves the install really happened, so it isn't taken from the
   query string alone;
4. links the guild (below), or refuses if it's already linked to another server: "This Discord server is
   already linked to another mcstats server. Unlink it there first." It never names the other server;
5. sends the browser to `/<slug>/#/admin/discord?linked=1`.

If someone cancels on Discord's screen, Discord sends `?error=access_denied`. The page shows "Not added. Nothing
changed."

### Way 2: from Discord (for a Discord admin who isn't the owner)

1. A guild admin adds the app from its Discord profile or App Directory ("Add App"). It works out of the box:
   every command answers with how to finish linking.
2. The mcstats owner opens **Admin → Discord → Link with a code** and gets a code like `K7QM-2XPA` (8 characters,
   15 minutes, used once, stored hashed in the server's Tenant), plus the exact command to send.
3. The guild admin runs `/mcstats setup server:eggsmp code:K7QM-2XPA`. The `server` option is the dashboard
   address and autocompletes nothing, so no server names leak.
4. The bot answers with the **setup wizard**: an ephemeral message with a preset picker and a channel picker for
   each feed (Discord's own channel select menus). Submitting saves it the same as the dashboard does.

Wrong codes are rate limited with the existing `Limiter` (`src/limiter.js`): 5 tries in 15 minutes per guild, and
per server. A wrong code and an unknown server give the same answer.

### Way 3: while making the server

`/new` gets an optional last step, **Add to Discord**, after the mod key. It's Way 1 at the moment the owner is
most motivated, and skipping it costs nothing.

### Presets

A preset only fills in feeds and channels, and anything can be changed afterwards. What's offered is limited by
what the owner allows to be shared (see [Privacy](#privacy-and-security)). A preset that would share more than that
is greyed out, with a note saying why.

| Preset | Commands | Status message | Events (joins, deaths, advancements, up/down, season) | Chat relay | `/say` | Daily summary | Channels it uses |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Just commands** | ✓ | | | | | | none |
| **Status board** | ✓ | ✓ | up/down only | | | ✓ | `#server-status` |
| **Community** (default) | ✓ | ✓ | ✓ | | | ✓ | `#server-status`, `#mc-events` |
| **Full bridge** | ✓ | ✓ | ✓ | ✓ | owner's choice | ✓ | `#server-status`, `#mc-events`, `#mc-chat` |

All three channels can be the same channel. A preset never switches `/say` on: who may talk into the game is the owner's call, set on its own. **Make the channels for me** makes the ones the preset uses.

### Permissions

The install link asks for only what's needed. Each permission is listed with what breaks without it, so
**Admin → Discord** and `/mcstats status` can say "The bot can't post in #mc-chat: it needs Manage Webhooks
there" instead of failing silently.

| Permission | Bit | Why | Without it |
| --- | --- | --- | --- |
| View Channel | `1 << 10` | See the feed channels | nothing posts there |
| Send Messages | `1 << 11` | Welcome message, and posts when a webhook can't be made | fallback posting fails |
| Embed Links | `1 << 14` | Embeds for `/player`, deaths, the status message | plain-text fallback |
| Read Message History | `1 << 16` | Find and edit its own status message after a restart | a new status message is posted each time |
| Manage Webhooks | `1 << 29` | Chat shown as each player (name and face) | chat posts as the bot, with the name in the text |

Total: `536955904`. **Make the channels for me** asks once more with Manage Channels (`1 << 4`) added. Nothing
asks for Administrator, Manage Roles, Manage Messages, or any privileged gateway intent (until phase 3, which
needs Message Content).

Slash commands need no permissions, since interactions are answered over HTTP. Admin commands use
`default_member_permissions: "32"` (Manage Server). Discord hides them from everyone else, and the guild can change
that under Server Settings → Integrations.

### Removing it

- **Admin → Discord → Unlink**, or `/mcstats unlink` (Manage Server). Either one deletes the link, the webhooks
  the bot made, and the status message. The app stays in the guild until someone kicks it, and commands then say
  it isn't linked.
- Kicking the bot from the guild: the next post fails with 403/404, the relay stops that guild's feeds and
  **Admin → Discord** says "The bot was removed from <guild>". The link stays, so adding the bot back carries on
  where it was.
- Deleting the mcstats server unlinks first.

## How it fits

```
                       ┌──────────────────────── Worker (src/index.js) ────────────────────────┐
Discord ─interaction──▶│ /api/discord/interactions  verify Ed25519 → guild_id → server         │
 (HTTP, signed)        │ /api/discord/oauth         install callback                            │
                       │ /api/discord/head/<uuid>.png  player faces (public)                    │
                       └───────────────┬──────────────────────────────────┬────────────────────┘
                                       │ reads, as a viewer                │ link, settings, codes
                                       ▼                                   ▼
                              Tenant /api/status, /api/leaderboard,   Tenant (server's own SQLite)
                              /api/combat, /api/advancements …        discord_* tables, DISCORD_* settings
                                                                           │
mod ──/api/ingest/chat, /online, /advancements──▶ Tenant ──tellRelay()──▶ DiscordRelay (one per server)
                                                                           │ queue · batch · rate limits
                                                                           ▼
                                                                    Discord webhooks / REST

/say, bridged channel ──▶ ServerLink (one per server) ──socket──▶ mod ──▶ "[Discord] Steve: hi" in game

phase 3 only:  DiscordGateway (one for the app) ── Gateway WebSocket ── MESSAGE_CREATE in bridged channels
```

### Pieces

| Piece | File | What it does |
| --- | --- | --- |
| Routing | `src/index.js` | `/api/discord/*` goes to `src/discord/index.js` before the `/api/` 404. It's site level, like `/api/site/*`, so it isn't under a server's address. |
| Interactions | `src/discord/interactions.js` | Checks the signature, answers PING, finds the server from `guild_id`, sends commands, autocomplete, buttons and menus to their handlers. |
| Commands | `src/discord/commands.js` | One handler per command. Each reads the dashboard's own API from the server's Tenant (see [The bot is a viewer](#the-bot-is-a-viewer)), so the numbers always match the site. |
| Messages | `src/discord/render.js`, `src/discord/text.js` | Turns API answers into embeds, components and plain text. It escapes markdown and keeps to Discord's size limits. |
| Data | `src/discord/data.js`, `src/discord/store.js`, `src/discord/server.js` | Reads a server's stats as a viewer; the server's Discord tables; finding the server for a guild. |
| Install | `src/discord/install.js`, `src/discord/setup.js` | The OAuth callback and the account-linking page; presets, webhooks, channel permissions, unlinking. |
| Discord API | `src/discord/api.js` | A small REST client: bot-token requests, webhook requests, rate-limit buckets, error kinds. |
| `DiscordRelay` | `src/discord/relay.js` | A new DO class, one per server, named by the server id like LINK and PRESENCE. It holds the outbox, the status message, the daily summary, and post ↔ event ids for deletes. |
| `DiscordGateway` | `src/discord/gateway.js` | Phase 3 only: one DO for the app, holding the Gateway WebSocket. |
| Admin → Discord | `src/discord/admin.js` and a section of the admin page | Link, presets, feeds and channels, what may be shared, health. |
| Command registration | `scripts/discord-commands.mjs` | Puts the command definitions to Discord. |
| Mod | `McstatsCommands.java`, `WebChatLink.java` | Phase 2: `/mcstats discord` (link code), and showing `via: 'discord'` chat with its own tag. |

## Data

### DIRECTORY (`directory-migrations/0005_discord.sql`)

Only the guild → server lookup goes in DIRECTORY, because every interaction needs it before it knows which server
it's for. The same reasoning puts slug → server there.

```sql
CREATE TABLE discord_guilds (
  guild_id   TEXT PRIMARY KEY,          -- Discord snowflake
  server_id  TEXT NOT NULL,             -- the Tenant id (16 hex)
  linked_at  INTEGER NOT NULL,
  linked_by  TEXT NOT NULL              -- mcstats account email of the owner who linked it
);
CREATE INDEX discord_guilds_server ON discord_guilds (server_id);
```

`linked_by` is shown to that server's owners only. It's in DIRECTORY so that unlinking a deleted server can still
find its guilds.

### The server's Tenant (`src/tenant/schema.js`, the next version)

```sql
-- the guild this server is linked to (a copy of the directory row, so the Tenant can answer without D1)
CREATE TABLE IF NOT EXISTS discord_link (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  guild_id   TEXT NOT NULL,
  guild_name TEXT,
  guild_icon TEXT,
  linked_at  INTEGER NOT NULL,
  broken     TEXT                         -- why posting stopped (bot removed, …), or NULL
);
-- one-time link codes (Way 2)
CREATE TABLE IF NOT EXISTS discord_codes (
  hash       TEXT PRIMARY KEY,            -- codeHash('discord', '', code)
  made_by    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
-- where each feed goes. Webhook URLs are secrets: they never leave this object.
CREATE TABLE IF NOT EXISTS discord_feeds (
  feed        TEXT PRIMARY KEY,           -- status | events | chat | digest
  channel_id  TEXT NOT NULL,
  webhook_id  TEXT,
  webhook_url TEXT,                       -- NULL: post with the bot token instead
  options     TEXT NOT NULL DEFAULT '{}'  -- per feed: which events, digest hour, …
);
-- Discord users linked to players on this server
CREATE TABLE IF NOT EXISTS discord_players (
  discord_id TEXT PRIMARY KEY,
  uuid       TEXT NOT NULL,
  how        TEXT NOT NULL,               -- 'game' (code typed in Discord) | 'account' (mcstats account)
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS discord_players_uuid ON discord_players (uuid);
```

The relay's outbox and post map are in `DiscordRelay`'s own SQLite. They're working state, not the server's
data, and they're dropped after 7 days:

```sql
CREATE TABLE outbox (seq INTEGER PRIMARY KEY, feed TEXT, at INTEGER, kind TEXT, body TEXT, tries INTEGER DEFAULT 0);
CREATE TABLE posts  (event_id TEXT PRIMARY KEY, feed TEXT, message_id TEXT, at INTEGER);
CREATE TABLE state  (key TEXT PRIMARY KEY, value TEXT);  -- status message id, last digest day, buckets
```

### Settings

There are three Discord settings for each server. They're kept in the server's `discord_config` table (`src/discord/store.js`), not with
its other settings, because only the bot reads them:

| Setting | Value | Set by |
| --- | --- | --- |
| `share` | what may go to Discord at all: `{ online, stats, deaths, advancements, chat, joinlink }` (`online` is always on) | owners only |
| `commands` | `{ on, ephemeral }`: commands on or off, and whether answers are seen only by whoever asked | admins |
| `bridge` | `{ say: 'off' \| 'linked' \| 'anyone' }`: who may `/say` | owners only |

`share` is the most a guild can ever get. Feeds and presets (on the dashboard or in Discord) can only
choose within it. On a public server everything defaults to on except `chat`. On a private server everything
defaults to off except `online`.

## Interactions

### The endpoint

`POST /api/discord/interactions`, set as the Interactions Endpoint URL in the Discord developer portal.

```js
// src/discord/interactions.js (sketch)
const key = await crypto.subtle.importKey('raw', hexBytes(env.DISCORD_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
const sig = request.headers.get('X-Signature-Ed25519');
const ts = request.headers.get('X-Signature-Timestamp');
const raw = await request.text();                                   // at most 64 KiB, or 413
if (!sig || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300
    || !(await crypto.subtle.verify('Ed25519', key, hexBytes(sig), enc.encode(ts + raw)))) {
  return new Response('bad signature', { status: 401 });           // Discord tests this on purpose
}
const i = JSON.parse(raw);
if (i.type === 1) return json({ type: 1 });                         // PING → PONG
```

Then it routes on the interaction type: 2 command, 3 button or menu, 4 autocomplete, 5 modal.

1. **Which server.** It's taken only from `i.guild_id`, looked up in `discord_guilds` and then the server's Tenant.
   Nothing in a command option ever picks a server. The one exception is `/mcstats setup server:`, which is
   checked against a code made by that server's owner. A DM, or a guild with no link, gets the "not linked yet"
   answer with both ways to link.
2. **Who.** `i.member.user.id` is the Discord user. `i.member.permissions` is a string bit set. Manage Server
   (`0x20`) is checked again here for admin commands, rather than trusting `default_member_permissions` alone.
3. **Deadline.** Discord needs an answer within 3 seconds. Fast reads (`/online`, `/server`, autocomplete,
   buttons) answer straight away with type 4 (or 7 to update a message, 8 for autocomplete). Anything that may
   be slower, like `/player` or `/top` on a cold cache, answers with type 5 (deferred, "mcstats is thinking…")
   and finishes in `ctx.waitUntil` with `PATCH /webhooks/{app}/{token}/messages/@original`. The token lasts 15
   minutes.
4. **Answers.** `flags: 64` (only the person who asked sees it) for anything personal, any error, and everything
   when `commands.ephemeral` is on. `allowed_mentions: { parse: [] }` always.

### The bot is a viewer

Commands don't get their own queries. The Worker asks the server's Tenant the same API the dashboard uses, as a
viewer with no account. It does that with `forServer(...)` and `X-MCS-Who: {"viewer":true,"email":null}`, which only
the Worker can set, since it strips incoming `X-MCS-` headers:

| Command | API it reads |
| --- | --- |
| `/online` | `Tenant.onlineNow()`, and `/api/status` for session lengths |
| `/server` | `/api/status`, `/api/hourly` (today's sparkline) |
| `/player`, `/me`, `/seen` | `/api/sessions`, `/api/leaderboard`, `/api/combat`, `/api/advancements`, `/api/roster` |
| `/top` | `/api/leaderboard` (playtime), `/api/combat` (kills, deaths, K/D), `/api/advancements` |
| `/deaths` | `/api/combat/log` |

So hidden players, aliases, seasons, chat resets, deleted chat, "don't count in combat" and the per-server
`cache` table all apply to Discord exactly as on the page, and a change to a dashboard query reaches Discord with
no extra work. On top of that, `share` is checked before each read. With `deaths` off, `/deaths` says
"This server doesn't share deaths on Discord" and the death lines in `/player` are left out.

### Stateless components

Buttons and menus carry what they need in their `custom_id`, so nothing is stored per message:

```
top:v1:kills:week:2          page 2 of /top kills week
player:v1:<uuid>:deaths      the Deaths tab on a /player answer
setup:v1:preset              the setup wizard's preset menu
```

Each handler checks that the guild is still linked, and the setup ones check Manage Server again. Old
`custom_id` versions are answered with "This message is out of date. Run the command again."

## Commands

The definitions live in `src/discord/definitions.js` and `scripts/discord-commands.mjs` registers them (global
commands, `contexts: [0]`, `integration_types: [0]`). Every player option has autocomplete from the server's
known players, without hidden ones: the 25 best matches, preferring people online now, then recent players.

### For everyone

**`/online`**: who's on now.

```
🟢 Egg SMP: 4 of 20 online
Steve        1h 12m      Red
Alex         34m         Blue
Notch        5m          Red
jeb_         just now
Peak today 9 at 8:40 PM · checked 20 s ago
[ Open dashboard ]
```

If the mod's list is fresh, it uses that, and otherwise the last minute's check (as `onlineNow()` does). Down:
"🔴 Egg SMP is offline. Last up 2h ago." Paused or unknown say so.

**`/server`**: status, address, season, today at a glance.

```
Egg SMP · Season 3 (day 12)
🟢 Up · play.eggsmp.net · 26.2 · 4 online
Today  ▁▁▁▂▃▅▇█▆▃   peak 9
This week  37 players · 212 h played
[ Open dashboard ]  [ Join link ]  ← only if the owner shares it
```

The sparkline is 24 hourly averages from `/api/hourly` drawn with `▁▂▃▄▅▆▇█`. Discord can't show the site's SVG
charts, and Workers can't draw a PNG without a library, so text it is.

**`/player name:`**: one player's card.

```
Steve                                                     [face]
Red team · first seen Oct 2 · last seen now (online)
Playtime  41h 20m this season · rank #3
Combat    22 kills · 9 deaths · K/D 2.4 · top weapon Netherite Sword
Deaths    6 by players · 2 falling · 1 lava
Newest    ★ Hidden in the Depths (2 days ago)
[ Playtime ] [ Combat ] [ Advancements ]  [ View on mcstats ]
```

The tabs are buttons that edit the same message (type 7). The face thumbnail comes from `/api/discord/head/<uuid>.png`.
The View on mcstats link opens `/<slug>/#/player/<name>`, which still needs the server's password or join link
when it's private.

**`/me`**: `/player` for the player linked to your Discord account, always ephemeral. If you aren't linked, it
says how to link.

**`/seen name:`**: "Alex was last on 3 hours ago, for 2h 05m" or "Alex is on now (34m)".

**`/top by: period:`**: the top 10, with buttons to page and to switch what's ranked.

| `by` | Ranked by | Needs |
| --- | --- | --- |
| `playtime` (default) | time online | |
| `kills` · `deaths` · `kd` | Combat's counts (K/D needs 5 deaths or more to rank) | mod, `deaths` shared |
| `advancements` | advancements made | mod, `advancements` shared |

`period`: `today`, `week`, `season` (the default), or `all`. These use the dashboard's own time windows in the
server's `TZ_NAME`.

**`/deaths name:?`**: the last 10 deaths, worded as on Combat ("Steve was slain by Alex using Netherite Sword ·
2h ago").

**`/dashboard`**: the server's address. If the owner allows it (`share.joinlink`), it also has a
**Join** button with the server's join link, so players get in with one click. It's always ephemeral, so a link
in a big guild isn't left sitting in the channel.

**`/say text:`** (phase 2): see [Bridge](#bridge-discord--game).

**`/mcstats connect`** · **`/mcstats disconnect`**: link or unlink your Discord account and your player. See
[Linking players](#linking-players).

**`/mcstats help`**: what the bot can do here, which depends on what this server shares.

### For guild admins (Manage Server)

| Command | Does |
| --- | --- |
| `/mcstats setup server: code:` | Link this guild (Way 2), then open the wizard. When already linked, it just opens the wizard. |
| `/mcstats status` | The link, each feed and its channel, whether the bot can post there (missing permissions named), the queue, last post, last error, whether the mod is connected and its version. A **Send test** button posts a test to each feed. |
| `/mcstats unlink` | Asks first (a confirm button), then unlinks. |

Feeds and channels are chosen in the wizard or on the dashboard, not with more commands. A form is easier than
remembering options.

### When something's off

Every error is ephemeral and says what to do:

| Situation | Answer |
| --- | --- |
| guild not linked | "This Discord server isn't linked to mcstats yet. A server owner can link it from the dashboard (Admin → Discord), or give you a code for `/mcstats setup`." |
| feature not shared | "Egg SMP doesn't share deaths on Discord." |
| needs the mod | "Egg SMP's server doesn't run the mcstats mod, so there are no deaths to show." |
| unknown player | "Nobody called Stve has played on Egg SMP. Did you mean Steve?" |
| Tenant slow | the deferred answer becomes "mcstats is slow right now. Try again in a minute." after 10 s |

## Feeds (game → Discord)

### What each feed posts

**Status message** (`status` feed). One message, edited in place so the channel always shows the current state.
The guild can pin it.

```
🟢 Egg SMP is up: 4 online
Steve · Alex · Notch · jeb_
Today ▁▁▁▂▃▅▇█▆▃  peak 9 · Season 3, day 12
Updated 8:41 PM
```

It's edited when someone joins or leaves or the server goes up or down, at most once every 30 seconds (the edits
are coalesced), and once every 10 minutes regardless so "Updated" stays true. If it's deleted, the next update
posts a new one.

**Events** (`events` feed). Each kind can be switched off on its own (`discord_feeds.options`):

```
▶ Steve joined (4 online)
◀ Alex left after 1h 12m
☠ Steve was slain by Alex using Netherite Sword
★ Notch made the advancement Diamonds!
🔴 Egg SMP went offline · 🟢 Egg SMP is back up (down 4 min)
🏁 Season 3 has started
```

- Joins and leaves come from the mod's chat lines when there are any, and otherwise from polling. A player who
  leaves and comes back within 3 minutes (`SESSION_GAP`) isn't posted twice.
- Deaths come from the `deaths` rows written with the chat batch. Deaths an admin leaves out of Combat after
  they're posted are deleted from Discord (see [Deletes](#deletes-follow-the-dashboard)).
- Advancements only include the ones the dashboard shows. Recipes and hidden root advancements are never posted.
  The first time anyone makes a challenge advancement it can get its own embed (option `highlight_challenges`).
- When more than 5 events are waiting at once, they go out as one message with one line each, not 5 messages.

**Chat** (`chat` feed). Every chat line, including `via = web` and `via = admin`, is posted through the channel's
webhook as the player:

- `username` is the player's name, and `avatar_url` is
  `/api/discord/head/<uuid>.png`;
- `[Web]` and `[Admin]` messages keep their tag;
- server lines (`/say` from console, broadcasts) post as "Server".

There's no webhook (Manage Webhooks is missing)? Then it posts as the bot with `**Steve**: text`.

**Daily summary** (`digest` feed). It's posted at a chosen hour (default 9:00) in the server's `TZ_NAME`, from the
Tenant's alarm, and skipped on days with no players:

```
Yesterday on Egg SMP
14 players · 22h 40m played · peak 9 at 9 PM
Most time   Steve 4h 10m · Alex 3h 02m · Notch 2h 45m
Combat      31 deaths · most kills Alex (7)
New         ★ 12 advancements · 2 new players: jeb_, Dinnerbone
[ Open dashboard ]
```

### Filters every feed follows

- `share` first: something not shared is never queued.
- Hidden players (`hidden_players`) never appear, not even in counts. Other accounts are shown as the player they
  belong to (`player_aliases`).
- Lines hidden by chat rules (`chat.hidden = 1`) and lines before the latest chat reset aren't posted.
- Lines from Discord (`via = 'discord'`) are never posted back to Discord, so there's no echo.
- Text is cleaned: `§` codes stripped, Discord markdown escaped (`\*`, `\_`, `\~`, `\|`, `` \` ``, `\>`), `@` and `#`
  followed by a zero-width space, and links left as text (`<https://…>`, which Discord shows without a preview).
  `allowed_mentions: { parse: [] }` means nobody can ping anyone from in game.

### Deletes follow the dashboard

When an admin deletes a chat line, or marks a death "Don't count in combat", on the dashboard (`src/admin.js`),
the relay looks the event up in `posts` and deletes or edits the Discord message:

- `DELETE /webhooks/{id}/{token}/messages/{message_id}` for a message of its own;
- or the line is taken out of a batched message.

**Restore** on the dashboard doesn't repost. That avoids surprising a channel with an old message.

### DiscordRelay, the outbox

Everything outbound goes through one `DiscordRelay` per server, so one server's traffic never waits behind
another's, and a Discord outage never touches ingest.

```
ingestChat / ingestOnline / ingestAdvancements / poll / seasonadmin
   └─ await tellRelay(env, events)        // like tellPresence: errors are logged, never thrown
        └─ DiscordRelay.enqueue()  → outbox rows → setAlarm(now + 1 s) if none set
DiscordRelay.alarm()
   ├─ per feed: take what's due, coalesce (chat lines into ≤ 2,000 characters, events into one list)
   ├─ per bucket: wait if X-RateLimit-Remaining is 0 until X-RateLimit-Reset-After
   ├─ send; on 2xx record posts(event_id → message_id)
   ├─ on 429: wait retry_after (global or bucket), keep the rows
   ├─ on 5xx / network: retry with backoff 2 s, 4 s, … up to 1 min, at most 6 tries
   ├─ on 401 / 403 / 404: stop that feed, set discord_link.broken / feed error, drop its rows
   ├─ drop chat older than 10 min and events older than 1 h, so stale history isn't dumped later
   └─ setAlarm for the next due row, or none (the object sleeps)
```

- The order is kept within each feed. Chat and events don't wait for each other.
- The outbox is capped at 2,000 rows per server. Past that, the oldest chat is dropped and counted ("312 chat
  lines weren't posted while Discord was unreachable" in the health panel).
- The status message and the daily summary are kept in `state` and driven by the same alarm.

### Player faces

Webhook avatars and embed thumbnails must be public URLs that Discord fetches itself. A server's `/api/skin/` is
behind the server's password, so there's a small public route:

- `GET /api/discord/head/<uuid>.png` (the uuid without dashes) returns the 64×64 face (with the hat layer) cut from the Mojang
  skin (`src/discord/head.js`). The cache that `src/mcassets.js` already uses for skins is shared and keyed by name/uuid, as the README
  says.
- It takes a UUID only, never a name, and says nothing about which servers that player plays on. Skins are public
  at Mojang anyway. It's cached at the edge for a day, so a new skin shows within a day.

## Bridge (Discord → game)

A server can have neither of these, the first, or both.

### `/say text:` (phase 2)

```
Discord: /say text: anyone at spawn?
In game: [Discord] Steve: anyone at spawn?
Chat log (dashboard): Steve (Discord) anyone at spawn?
```

1. The Worker checks `bridge.say`. The sender is the linked player, or, if `anyone` is allowed, the Discord
   display name (cleaned with the same `IGN_RE` and shown as `[Discord] name*` so it can't pass as a player).
2. It cleans the text as `cleanWebText` (`src/link.js`) does, with the same 256-character limit. Admin → Chat
   rules apply.
3. It applies the web chat limits for each sender (1.5 s apart, 8 in 30 s), keyed by Discord user.
4. It goes to that server's `ServerLink` as `{ type: 'chat', via: 'discord', name, text }`. If the mod isn't
   connected, the answer is "Egg SMP's server isn't connected right now". Nothing is queued, as with web chat.
5. The ephemeral answer is "Sent", or "Sent (not confirmed yet)" when the mod's ack doesn't arrive within 5 s
   (as `sendWebChat`'s `unsure`).
6. The line comes back through the chat ingest with `via = 'discord'`. The dashboard shows it with a Discord tag,
   and the relay doesn't post it back.

Whispers aren't bridged in v1. `/say /w Alex hi` is refused.

### Bridged channel (phase 3)

Every ordinary message in one chosen channel goes to game chat, and with the chat feed pointed at the same
channel, the channel becomes the game chat. Reading messages needs the Gateway and the **Message Content**
privileged intent. Discord gives that freely below 100 guilds, and after that only with verification.

- `DiscordGateway`: one DO for the app. It connects to the Gateway with intents `GUILDS | GUILD_MESSAGES |
  MESSAGE_CONTENT`, handles heartbeats, `RESUME`, and reconnects, and keeps the session id and sequence in its
  storage.
- Each `MESSAGE_CREATE` in a channel listed as bridged (an in-memory map, refreshed from DIRECTORY when it
  changes) is handed to that server's ServerLink, exactly like `/say`. Messages from bots and webhooks are ignored,
  so there's no echo.
- Attachments become `[image]`, replies become `↩ Alex: …`, and messages over 256 characters are cut with `…`.
- It's sharded when the app reaches about 2,500 guilds (Discord requires shards past that). By then it's one
  DO per shard.

## Linking players

A Discord user linked to a player gets `/me`, can `/say` as themselves, and shows as their player in the bridge.
There are two ways, and both prove both sides.

**A. From the game** (needs mod 2.x with `/mcstats discord`):

1. In game: `/mcstats discord`. The mod asks the Worker over its link socket
   (`{ type: 'discord', action: 'code', uuid }`). The Worker makes a 6-digit code (10 minutes, stored hashed with
   the uuid). The mod shows it as click-to-copy: "Your Discord code is 481 207. In Discord, run
   `/mcstats connect code:481207`."
2. In Discord: `/mcstats connect code:481207`. The game proved the player and the interaction proves the Discord
   user, so they're linked. The answer is "Linked to Steve".

**B. From the mcstats account** (no mod change, using the in-game account connect that already exists):

1. In Discord: `/mcstats connect` with no code. The answer is an ephemeral **Link with mcstats** button that
   opens `/api/discord/connect?t=<token>`. The token is signed and lasts 10 minutes:
   `{ k: 'discordme', s: server id, d: discord user id }`.
2. On the site, signed in: "Link Discord user @steve to Steve?" → **Link**. It uses the player the account is
   connected to (`connectedPlayer`, `src/connect.js`). An account with no player is told to run
   `/mcstats connect` in game first.

Either side can undo it: `/mcstats disconnect` in Discord, `/mcstats discord off` in game, or an admin on
Admin → Players, where the Discord user shows on the player's profile beside their emails. One Discord user has
one player per server, and one player can have more than one Discord user (alts).

## Admin → Discord

A new section on the admin page (`#/admin/discord`, `renderDiscordAdmin` in `public/app.js`). Unlike the rest of
Admin, each change saves at once, because linking happens partly on Discord's side and every change shows in
Discord straight away.

```
┌ Discord ──────────────────────────────────────────────────────────────────────┐
│ [icon] Egg SMP Community        linked Nov 26 by you            [ Unlink ]   │
│ ✓ Bot can post in all feed channels · mod connected (2.4.0)                   │
│                                                                               │
│ Shared with Discord (owners)                                                  │
│   [✓] Who's online   [✓] Stats   [✓] Deaths   [✓] Advancements                │
│   [ ] Chat           [ ] Join link in /dashboard                              │
│                                                                               │
│ Setup  ( ) Just commands  ( ) Status board  (•) Community  ( ) Full bridge    │
│                                                                               │
│ Feed            Channel             What                         Health       │
│ Status message  #server-status  ▾   —                            ✓ 20 s ago   │
│ Events          #mc-events      ▾   [✓]joins [✓]deaths [✓]adv…   ✓ 3 min ago  │
│ Chat            —               ▾   needs "Chat" shared          —            │
│ Daily summary   #server-status  ▾   at [09:00] ▾                 ✓ yesterday  │
│                                                         [ Send test ]         │
│ Commands  [✓] on   answers ( ) public  (•) only to who asked                  │
│ /say      (•) off  ( ) linked players  ( ) anyone (shown with *)             │
└───────────────────────────────────────────────────────────────────────────────┘
```

- Before linking, the section shows **Add to Discord** (Way 1), **Link with a code** (Way 2) and a short list of
  what the bot will and won't do.
- The channel menus come from `GET /guilds/{id}/channels` (text and announcement channels), each marked with
  whether the bot can post there, worked out from the guild's roles and the channel's overwrites. Choosing a
  channel makes its webhook ("mcstats · Egg SMP") when Save is pressed.
- Health is the relay's per-feed last success and last error, in plain words ("Missing Manage Webhooks in
  #mc-chat", "Discord rate limited us; caught up 2 min ago").
- Admins (not only owners) can change feeds, channels and commands. Only owners can change what's shared, and
  `/say`, and unlink.

## Privacy and security

- **The owner sets the ceiling.** `share` is the most a guild can get, and Discord-side admins only choose
  within it. Turning something off stops it at once: queued posts are dropped, and commands refuse.
- **A guild is a viewer, never a member.** It can read what the password lets you read, minus what isn't shared.
  It never reaches admin actions, Liveview, whispers, emails or real names. Real names stay off unless
  `share.names` (not built: real names are never shared). Gear isn't shared in v1.
- **Which server is never up to the request.** It comes from `guild_id` → DIRECTORY, the same rule as for page
  addresses and mod keys. `test/isolation.test.js` gets Discord cases.
- **Linking needs both sides.** An mcstats owner (the signed state or the code) and a Discord user with Manage
  Server (Discord's own install screen or `member.permissions`). Neither one can link alone.
- **Signatures** are checked on every interaction before anything is parsed, with a 5-minute timestamp window.
- **Secrets.** `DISCORD_BOT_TOKEN` and `DISCORD_CLIENT_SECRET` are Worker secrets. Webhook URLs live only in the
  server's Tenant, never in settings sent to pages, and never in logs. Codes are stored hashed, like the mod keys.
- **No pings, no injection.** `allowed_mentions` is always empty, markdown is escaped, and links aren't
  previewed.
- **Rate limits** on everything a person can trigger: link codes, `/say`, and commands (20 a minute per Discord
  user per guild, through `Limiter`), so a guild can't be used to hammer a Tenant.

## Limits and failures

| Limit (Discord) | Value | How the bot stays inside it |
| --- | --- | --- |
| Answer an interaction | 3 s | defer anything not instant |
| Follow-up token | 15 min | finish long work well inside it |
| Message content | 2,000 characters | chat batches are cut at 2,000, lines at 256 |
| Embed | 6,000 characters total, 4,096 in the description, 25 fields | `/top` shows 10 a page, and lists are cut with "and 12 more" |
| Autocomplete | 25 choices | 25 best matches |
| Per webhook / route | from headers (about 5 per 2 s) | buckets per webhook in the relay, batching |
| Global | 50 requests/s per bot | far below at expected volume. The relay also has a site-wide token bucket in its alarm loop. |
| Invalid requests | 10,000 per 10 min gets the IP banned | stop a feed on its first 401/403/404, never retry those |

| Failure | What people see |
| --- | --- |
| Discord down | commands fail on Discord's side. Feeds queue for up to 10 min (chat) or 1 h (events), then drop, with a count in health. |
| Bot kicked, channel deleted, webhook deleted | that feed stops, health says why, and a fix is one channel pick away. A deleted webhook is remade once by itself. |
| Tenant or D1 slow | the deferred answer turns into "mcstats is slow right now" after 10 s |
| Mod offline | `/say` refuses at once. Events fall back to polling (joins and leaves only). The status message says "mod offline". |
| Cloudflare egress IP limited by Discord (shared IPs) | shows up as 429s with no bucket headers. The relay backs off. If it happens a lot, the relay's sends can go through a small proxy. That's a known risk to watch, not built up front. |

## Cost

- **Commands**: one Worker request each, plus a Tenant read that's usually cached. Negligible.
- **Feeds**: a `DiscordRelay` wakes on an alarm only when there's something to post, and sleeps otherwise. A busy
  server might send a few thousand Discord requests a day. The status message's 10-minute refresh is 144
  edits a day.
- **Bridged channel (phase 3)**: `DiscordGateway` never sleeps, since outbound WebSockets don't hibernate. That's
  one object running all month: a few dollars at most on the Workers paid plan, and the reason it's last and
  optional.

## Operator setup (once, for the site)

The quick way: do steps 1, 3 (the token) and 4 on the Developer Portal, then run
`DISCORD_BOT_TOKEN=… npm run discord:setup` (`scripts/discord-setup.mjs`). It fills in step 2, sets step 5, runs
step 6, and checks the redirect from step 4. After the secrets and a deploy (step 7),
`DISCORD_BOT_TOKEN=… npm run discord:setup -- --endpoint` sets the Interactions Endpoint URL. The steps by hand:

1. Make an application at <https://discord.com/developers/applications>, named `mcstats`, with the mcstats icon.
2. **General**: copy the Application ID and Public Key into `wrangler.jsonc` `vars` (`DISCORD_APP_ID`,
   `DISCORD_PUBLIC_KEY`). Set the Interactions Endpoint URL to
   `https://mcstats.live/api/discord/interactions` after the first deploy (Discord PINGs it when it's saved).
3. **Bot**: reset and copy the token, then run `npx wrangler secret put DISCORD_BOT_TOKEN`. Leave **Public Bot** on.
   Leave every privileged intent off until phase 3.
4. **OAuth2**: copy the Client Secret, then run `npx wrangler secret put DISCORD_CLIENT_SECRET`. Add the redirect
   `https://mcstats.live/api/discord/oauth`.
5. **Installation**: Guild Install only. Install link "Discord Provided Link" with scopes `bot` and
   `applications.commands` and permissions `536955904` (this is Way 2's "Add App").
6. `npm run discord:commands` (`node scripts/discord-commands.mjs`) registers the commands. Run it again whenever
   `src/discord/definitions.js` changes. `-- --guild <id>` registers them in one Discord server only, where they show up at once. Global commands show up within a minute or so.
7. Deploy (`npm run deploy`, which runs the directory migration first, as always).

For local development: `wrangler dev` with a tunnel (`cloudflared tunnel --url http://localhost:8787`), and a
second Discord app ("mcstats dev") pointed at the tunnel, so the real bot is never pointed at a laptop.
`DEV_NO_AUTH` doesn't skip the signature check.

## Testing

`test/discord.test.js`, Vitest in the Workers runtime like the rest. Discord's API is faked with `fetchMock`, and a
test Ed25519 key pair stands in for Discord's.

- **Signatures**: a good one passes; a bad one, a missing header, an old timestamp or a changed body gets 401;
  PING gets PONG.
- **Isolation** (also in `isolation.test.js`): guild A gets server A's numbers and can never get B's. That covers
  command options naming B, a `custom_id` naming B's players, and `/mcstats setup server:B` with A's code.
- **Linking**: OAuth state for another server, an expired one, another account, a non-owner, and a guild already
  linked are all refused. Codes work once, expire, and are rate limited.
- **Sharing**: with each `share` key off, the matching commands refuse and nothing is queued.
- **Filters**: hidden players aren't in `/online`, `/top`, feeds or autocomplete. Aliases are merged. Rule-hidden
  and pre-reset chat isn't posted. `via = 'discord'` isn't echoed. `@everyone` comes out harmless.
- **Relay**: batching, 429 with `retry_after`, 5xx backoff, a 404 stopping the feed, stale drops, the outbox cap,
  deletes following the dashboard.
- **Bridge**: `/say` limits, refused when the mod is offline, `unsure` when there's no ack, and the line comes back
  marked `via = 'discord'`.
- **Mod** (Java, phase 2): `/mcstats discord` asks for a code and shows it; `via: 'discord'` shows `[Discord]`;
  older mods still get `[Web]` (`modupdate.js` version check).

## Phases

### Phase 1: commands and install (no mod change)

- [x] `directory-migrations/0005_discord.sql`, the Tenant schema version 7, the server's `discord_config`
- [x] `/api/discord/interactions`: signature, PING, routing, the viewer bridge to the Tenant API
- [x] `/online`, `/server`, `/player`, `/me` (linked via Way B), `/seen`, `/top`, `/deaths`, `/dashboard`,
      `/mcstats help | setup | status | unlink | connect | disconnect`, with autocomplete and component buttons
- [x] Way 1 (OAuth install), Way 2 (codes and the wizard)
- [ ] `/new`'s optional step (Way 3)
- [x] `/api/discord/head/<uuid>.png`
- [x] Admin → Discord: link, sharing, commands
- [x] `scripts/discord-commands.mjs` (`npm run discord:commands`), tests

### Phase 2: feeds, `/say`, linking from the game

- [x] `DiscordRelay` (outbox, buckets, retries, posts, deletes), and `tellRelay` from the chat ingest, admin
      deletes and seasons
- [x] status message, events, chat (webhooks), daily summary, presets, "Make the channels for me"
- [x] `/say` through ServerLink, with `via: 'discord'` through the chat ingest
- [x] Mod: `[Discord]` display and guests (in `mod/`, not built or released yet)
- [ ] Mod: `/mcstats discord`, and Way A linking
- [ ] Joins and leaves from polling, for servers without the mod
- [x] Admin → Discord: feeds, channels, health, Send test

### Phase 3: bridged channel (if servers ask for it)

- [ ] `DiscordGateway`, the Message Content intent (verification past 100 guilds), and the bridged-channel option

## Open questions

- **One guild, several servers?** Some communities run a survival and a creative server in one Discord. Per-channel
  links (`discord_guilds` keyed by guild and channel) would allow it, but then every command needs to know which
  server it means. v1 is one server per guild.
- **Discord roles for players?** For example "Verified player", or each team's role kept in sync. It needs Manage
  Roles, which makes the bot partly a moderation tool. Discord's own **Linked Roles** would avoid that, but its data
  is kept per app and user, not per guild, so with one app for many servers "hours played" would be ambiguous.
  It's left out until there's a clear answer.
- **Join link in Discord**: sharing it is the owner's call (`share.joinlink`). Should `/dashboard` with it
  be limited to Discord users who've linked a player?
- **Per-channel digest hour**, or one per server?
