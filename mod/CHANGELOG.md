# Changelog: the mcstats server mod

Every release of the mod in `mod/`, newest first. The version is `version` in
[gradle.properties](gradle.properties); the jar is `mcstats-chat-<version>.jar`.

The numbers follow [semantic versioning](https://semver.org): a patch release fixes something, a minor
release adds something that older dashboards simply ignore, and a major release changes what the mod is
or what it needs. Each entry says which dashboard features need that version; an older mod keeps working
with a newer dashboard, without those features.

When you release a new version: bump `version`, add an entry at the top of this file, and update the
jar name in [README.md](README.md).

This file is also what admins are shown when their server runs an older mod: the dashboard's Admin page
lists every entry newer than the server's version, and the mod (2.1.0 or newer) tells operators in game.
So write entries for a server admin, with each change as a `- ` bullet under a `###` heading (a bold
lead-in like `**Whispers.**` becomes its title). If servers should update soon (a security fix, data being
lost), put this line straight under the version's heading, and the notice says so louder:

    **Urgent:** why, in one sentence.

## 2.4.0 (2026-11-26)

### Added

- **Switch commands off from the dashboard.** Admin → Mod and commands lists every `/mcstats` command with a
  switch. A command that's switched off is gone in game for everyone within a moment: it doesn't run, it
  leaves tab completion and `/mcstats help`, and the menus lose its button. `/mcstats help` always stays.
  The choice is kept in `config/mcstats-commands-off.txt`, so it holds after a restart even before the
  dashboard is reached. Needs this version: an older mod keeps every command whatever the dashboard says.
- **Chat from Discord.** A message sent with the Discord bot's `/say` (see DISCORD.md in the repository)
  shows in game with a blue `[Discord]` tag instead of `[Web]`, and is logged as sent from Discord, so the
  dashboard's chat log tags it and the bot doesn't post it back. Someone on Discord who hasn't linked a player
  shows in grey italics with a `*` after their name, and isn't logged as any player. Older versions show these
  messages with the `[Web]` tag, and the bot won't send guests' messages to them.

## 2.3.0 (2026-11-26)

### Added

- **Connect your mcstats account.** `/mcstats connect`, or **Connect Account** in the `/mcstats` menu, opens
  an anvil: type the email of your mcstats account and click the result. The dashboard emails that address,
  and once someone signed in with it clicks **Connect** above the Chat log's message box, they chat from the
  website as you, with your name in game. Admins see the connected email on the player's page under
  Admin → Players and can disconnect it; `/mcstats disconnect` does it in game. Needs this version.

### Fixed

- **Liveview inventory screens.** The mod now sends the page's textures and font several files at a time
  instead of one per frame, and keeps up to 512 waiting requests instead of dropping those past 64. A page
  opening while the world was loading could miss the inventory texture and the game's font, and show a plain
  grey box with no slot grid.

### Removed

- **`/liveview optout` and `/liveview optin`.** Every player online now shows in Liveview. Earlier opt-outs
  in `config/mcstats-liveview.json` are no longer read.

## 2.2.0 (2026-11-25)

### Added

- **In-game menus.** `/mcstats view` opens a chest menu every player can click through, with a Go Back
  arrow on each page. **Your Profile** picks what your 3D model on the dashboard holds in each hand (click
  any item in your inventory) and a particle effect around it. **Server Stats** shows every player's head:
  hover for their playtime, whether they're online and whether they're an operator, click for all their
  stats. **Leaderboards** shows the top 10 for playtime, kills, deaths and distance.
- **More /mcstats commands.** `/mcstats profile`, `stats [player]`, `top`, `link [player]` (a link to
  a dashboard page), `particle <name>`, `reset` and `help`.
- **/liveview help.** Lists the Liveview commands you may use (operators see theirs too). The dashboard's
  Liveview page lists them as well.

## 2.1.0 (2026-11-25)

### Added

- **Update notices.** When the dashboard has a newer version of the mod than the server runs, operators
  (permission level 3) are told in game each time they join: the versions, whether the update is urgent and
  why, the headline of each change since, and a link that downloads the new jar. The server log says it
  once too. The dashboard sends this when the mod connects, so it needs nothing in the config file.
- **Edit inventories from Liveview.** With controls on, an admin can move items in a player's whole
  inventory (armor and off hand included) and their ender chest, as well as in chests, barrels, shulker
  boxes, hoppers and dispensers. The clicks work as in the game: pick up, right-click for half or one,
  drag to spread, double-click to gather, shift-click, the number keys and F. Every slot keeps its game
  rules (armor slots take one piece of the right kind, shulker boxes refuse shulker boxes), and each move
  checks the slots as they are at that moment, so nothing can be copied or lost. Needs this version.
- **Liveview chat as the game shows it.** Chat lines now carry their colors, team names and formatting,
  /say and /me read as they do in game, action bar text no longer shows up as chat, and joins, leaves and
  deaths appear once instead of twice. Needs this version; older mods still show plain chat.

## 2.0.0 (2026-11-22)

Liveview becomes part of the mod. Until now it was a separate mod with its own web page, port and
passwords; from this version it lives here and shows in the dashboard's **Liveview** tab.

### Added

- **Liveview.** Dashboard admins can watch the world live from the dashboard: fly a camera through the
  terrain (drawn with the game's own textures), see every online player and the mobs around them, open a
  player's inventory and ender chest, look inside chests, and follow a feed of what happens (blocks broken
  and placed, attacks, chat, deaths, joins and leaves). Watching never changes the world.
- **Two keys, made in game.** `/liveview key viewer` makes the key that lets a dashboard account watch;
  `/liveview key control` makes the one that lets it also run commands as the server console and move
  items in containers. An operator runs the command, the key is shown once (click to copy), and an admin
  enters it on the dashboard once per account. Only the keys' hashes are kept, in
  `config/mcstats-liveview.json`. A new viewer key empties the access list and disconnects everyone watching;
  a new control key puts everyone back to watching only.
- **The server decides who gets in.** The mod keeps its own list of the dashboard accounts it lets watch or
  control, checks it whenever a page connects or asks for controls, and only tells the dashboard what's on it.
  Entering a key puts an account on the list; `/liveview access viewer <email>` and
  `/liveview access control <email>` do it by name, `/liveview access remove <email>` takes an account off (and
  disconnects it), and `/liveview access` lists them.
- `/liveview who` (operators): which dashboard accounts are watching right now, and which have controls on.
- `/liveview optout` and `/liveview optin` (any player): hide yourself from Liveview, or come back.
- Every command and item move made from the dashboard is written to the server log with the account
  that made it.
- New settings in `config/mcstats-chat.properties`: `liveview`, `liveview_control`,
  `liveview_camera_chunks`, `liveview_player_chunks`, `liveview_entity_blocks`, `liveview_client_jar`.
  A file from an older version has none of them and gets the defaults (Liveview on, with no keys yet).

### Changed

- The mod's name is now **mcstats** (its id stays `mcstats_chat`, and the jar and config file keep their
  names, so updating is a matter of swapping the jar).
- The view reaches the dashboard through a connection the mod opens itself, to `/api/ingest/liveview`
  next to the chat url, with the same token. It is only open while someone is watching. The standalone
  Liveview mod's built-in web server, its port and its `config/liveview.json` are gone: nothing on the
  server listens for the view any more.
- The game's textures are downloaded from Mojang and packed the first time someone watches (into
  `config/mcstats-liveview-cache`), not at every start.
- The jar bundles four more Fabric API modules (commands, entity events, interaction events, networking).
  It still needs nothing else installed.

### Coming from the standalone Liveview mod

Remove `liveview-1.0.0.jar` (and Fabric API, if nothing else needs it). Its viewer and admin passwords
are not carried over: make the two keys with the commands above. Players who had opted out need to run
`/liveview optout` again. `config/liveview.json`, `config/liveview-secrets.json` and
`config/liveview-cache` can be deleted, and the extra port it used can be closed.

Needs a dashboard deployed from this version or newer (the `LiveRelay` Durable Object, and the Liveview
permissions on its Roles page).

## 1.9.0 (2026-11-20)

### Added

- The gear report includes the tooltip the game shows for each weapon and tool (name, enchantments,
  attributes, lore), so a player's page shows their real enchantments instead of working them out from
  death messages.

## 1.8.0 (2026-11-18)

### Added

- **Whispers.** `/w`, `/msg` or `/tell` typed on the dashboard is shown to that player in game as
  `[Web] Sender whispers to you: text`. A whisper typed in game to someone who is only on the dashboard
  goes up to their page instead of failing with "No player was found". Whispers between two players in
  game are untouched and never recorded. This is the mod's first mixin, on the game's command handler.
- In game, Tab after `/w`, `/msg` or `/tell` also suggests the players who have the dashboard open,
  marked `<web>`.
- **Messages sent to everyone one by one.** A system message that reaches every player in the same tick
  is logged as a server message, so other mods' announcements sent player by player (a combat logger's
  location, say) reach the chat log. A second mixin, on the player's system-message method, that only
  watches.

### Fixed

- A name sent from the dashboard gets its team's colors whatever capitals it is written in.

## 1.7.1 (2026-11-18)

### Fixed

- After a dashboard deploy the web chat connection could look open to the mod while the dashboard no
  longer had it, so chat from the website said the server wasn't connected until the server restarted.
  The mod now reconnects after the dashboard has said for 40 seconds that it doesn't hold the
  connection, and gives up on a connection attempt that hasn't finished within a minute.

## 1.7.0 (2026-11-16)

### Added

- **Who's online.** Everyone in the tab list (UUID and name) is sent to `/api/ingest/online` whenever it
  changes and every 20 seconds, plus an empty list when the server shuts down. The dashboard adds these
  players to the ones the server-list ping names, which can leave some out.

## 1.6.1 (2026-11-16)

### Fixed

- The mod's answer to a message from the dashboard could get stuck behind a ping.
- A message the server was too busy to show within 4 seconds is dropped, instead of turning up in game
  after the sender had been told it failed.

## 1.6.0 (2026-11-14)

### Added

- **Advancements.** The advancement tree as the game lays it out (titles, descriptions, icons, frames,
  positions, data packs' included), sent at start and after a data pack reload, and each online player's
  progress in it, checked every 15 seconds and sent when it changes. Both go to
  `/api/ingest/advancements`.

## 1.5.0 (2026-11-14)

### Added

- The item named in a death message (the weapon) is sent with the tooltip the game shows for it, so the
  dashboard can show it on hover.

## 1.4.0 (2026-11-14)

### Added

- **Deaths, for the Combat page.** Each death message also says how it happened: the game's own name for
  the cause, who the game credits with it (a player, or a creature's type) and the named item it was
  done with. All of it is read off the message the game already broadcasts.
- **Egg.** The gear report includes each player's Egg SMP egg type, level and energy, read from the egg
  mod's scoreboard scores. Nothing is sent where those don't exist.

## 1.3.0 (2026-11-13)

### Added

- **Web chat.** Players signed in to the dashboard with a roster email can type in the Chat log. The mod
  keeps one WebSocket open to `/api/ingest/link` and shows each message in game as
  `[Web] <name> message`, the name in its team's colors; admins show as `[Web] [Admin] message`.
  `web_chat=false` turns it off.

## 1.2.0 (2026-11-13)

### Added

- **Gear.** Each online player's armor (with trims and dye), both hands, and the weapons, tools and Egg
  SMP eggs in their inventory, checked every 10 seconds and sent to `/api/ingest/gear` when it changes,
  at most once a minute per player. The dashboard draws the 3D player model from it.

## 1.1.0 (2026-10-30)

### Added

- Deaths and advancements are sent styled as a whole, so a killer's name, a named weapon or an
  advancement's title keeps its color on the dashboard.

## 1.0.2 (2026-10-30)

### Fixed

- The console now tells Cloudflare Access refusing the service token apart from the dashboard refusing
  the mod's own token, so a wrong setting can be found from the message.

## 1.0.1 (2026-10-30)

### Fixed

- A config file saved with a byte-order mark (some web panels and Windows editors add one) is read
  correctly.
- The console says when the config's `url` or `token` is blank, and when the chat log has connected.

## 1.0.0 (2026-10-29)

The first release: a server-side Fabric mod for Minecraft 26.2, as one jar with the Fabric API modules it
uses bundled inside.

### Added

- Public chat, `/say`, `/me`, joins, leaves, deaths, advancements and server start and stop are sent to
  the dashboard's `/api/ingest/chat` in batches, in the background.
- Names are sent as chat shows them, with team prefixes and colors.
- If the dashboard can't be reached, messages wait and are retried with backoff; anything unsent at
  shutdown is kept in `config/mcstats-chat-pending.json` and sent after the next start.
- `config/mcstats-chat.properties`, created on first start and read again within seconds of a change.
