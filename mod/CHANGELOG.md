# Changelog: the mcstats server mod

Every release of the mod in `mod/`, newest first. The version is `version` in
[gradle.properties](gradle.properties); the jar is `mcstats-chat-<version>.jar`.

The numbers follow [semantic versioning](https://semver.org): a patch release fixes something, a minor
release adds something that older dashboards simply ignore, and a major release changes what the mod is
or what it needs. Each entry says which dashboard features need that version; an older mod keeps working
with a newer dashboard, without those features.

When you release a new version: bump `version`, add an entry at the top of this file, and update the
jar name in [README.md](README.md).

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
  `config/mcstats-liveview.json`. Making a new key ends every account's access under the old one, and
  disconnects everyone watching (viewer key) or locks their controls (control key).
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

Needs a dashboard deployed from this version or newer (the `liveview_access` table and the `LiveRelay`
Durable Object).

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
