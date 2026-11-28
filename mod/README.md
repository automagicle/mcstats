# mcstats (server mod)

A server-side mod, as a Fabric mod and as a Paper plugin (see [Paper](#paper)), that sends the server's public chat to the dashboard's **Chat log** page, every death
to its **Combat** page, what each player wears and carries to the **3D model** on their player page, shows chat
sent from the dashboard in game, and (from 2.0.0) lets the dashboard's admins watch the world live in its
**Liveview** tab.
It's one jar with no other dependencies (the bits of Fabric API it uses are bundled inside), for
Minecraft **26.2** on Fabric Loader 0.18.4 or newer. Players don't install anything.

What each version added is in [CHANGELOG.md](CHANGELOG.md). Everything below is true of both editions unless the
[Paper](#paper) section says otherwise; on Paper, read `plugins/mcstats/` wherever it says `config/` and `plugins/`
wherever it says `mods/`.

**Recorded:** public chat, `/say`, `/me`, joins, leaves, deaths, advancements, and server start/stop.
Names are sent as chat shows them (team prefix and colors), so the dashboard can match. Deaths and
advancements are sent styled as a whole, so a killer's name, a named weapon or an advancement title keeps its color
(needs 1.1.0 or newer; older versions still work, with plainer death messages).
**Deaths** (1.4.0 or newer): each death message also says how it happened, for the Combat page: the game's own name for
the cause (`death.attack.player.item`, `death.fell.accident.generic`, …), who the game credits with it (a player's name
and UUID, or a creature's type like `zombie`) and the named item it was done with. All of it is read off the death
message the game already broadcasts, so nothing extra is tracked. Older versions' deaths still count: the dashboard
works out the killer from the message.
**Advancements** (1.6.0 or newer): the advancement tree as the game lays it out on its advancements screen (every
advancement's title, description, icon, frame, parent and position, data packs' included), sent when the server starts
and after a data pack reload; and each online player's progress in it (which they have and when they got each, and for
the ones they're partway through, how far and which criteria are done), checked every 15 seconds and sent only when it
changed, at most twice a minute per player. Both go to `/api/ingest/advancements` next to the chat url (same token, no
extra setup). The dashboard draws them as the tree at the bottom of each player's page.
**Who's online** (1.7.0 or newer): everyone in the server's tab list (UUID and name), sent to `/api/ingest/online` next
to the chat url (same token, no extra setup) whenever it changes and every 20 seconds regardless, plus an empty list when
the server shuts down. The dashboard adds these players to the ones the server-list ping names, which can leave some
out (it lists at most a sample, and players who turned off "Allow Server Listings" appear as "Anonymous Player").
**Weapon tooltips** (1.5.0 or newer): the item named in a death message (the weapon) is sent with the tooltip the game
shows for it (name, enchantments, attributes, lore), so the dashboard can show it on hover.

**Egg** (1.4.0 or newer): with the gear report, each player's Egg SMP egg type, level and energy, read from the egg
mod's scoreboard scores (`egg.type`, `egg.tier`, `egg.energy`); nothing is sent if those don't exist.
**Gear** (1.2.0 or newer): each online player's armor (with trims and dye), both hands, and the weapons, tools and Egg SMP
eggs in their inventory (nothing else from it). Checked every 10 seconds and sent only when it changed, at most once a
minute per player, to `/api/ingest/gear` next to the chat url (same token, no extra setup).
**Web chat** (1.3.0 or newer): players signed in to the dashboard with a roster email can type in the Chat log. The mod
keeps one WebSocket open to `/api/ingest/link` next to the chat url (same token and service token, no extra setup) and
shows each message to everyone as `[Web] <name> message`, the name in its team's colors. It's logged like other chat,
with a "web" tag on the dashboard. Admins (emails listed as admins on the dashboard's roster) show as `[Web] [Admin] message`, the tag in yellow. If the server isn't connected, the dashboard says so and nothing is queued.
**Messages sent to everyone one by one** (1.8.0 or newer): some mods announce things by sending each player the message
themselves (where a combat logger logged out, say) rather than as a broadcast, so the log never saw them. A system
message that reaches every player on in the same tick is now logged as a server message, like a broadcast. With one
player on, it's logged unless it answers something they did (a command, or anything else of theirs but a player
leaving). Action-bar messages and this mod's own whisper lines are never logged. Uses a second mixin, on the player's
system-message method; it only watches.
**Web chat names** (1.8.0 or newer): a name sent from the dashboard gets its team's colors whatever capitals it's
written in (the dashboard also sends the game's own spelling, which fixes this for older versions).
**Whispers** (1.8.0 or newer): `/w Name text` (or `/msg`, `/tell`) typed on the dashboard comes down the same WebSocket and
is shown only to Name, the way the game shows a whisper, as `[Web] Sender whispers to you: text`. And a whisper typed in
game to someone who isn't on the server but has the dashboard open goes up to their page instead of failing with "No
player was found" (the dashboard sends the mod who's on it whenever that changes); the sender sees `[Web] You whisper to
Name: text`. In game, Tab after `/w`, `/msg` or `/tell` suggests those players too, marked `<web>`, along with everyone in
game (the server answers that argument's suggestions instead of the game's own tab list). This uses the mod's first mixin, on the game's command handler: it only steps in for a whisper to someone who's
on the dashboard and not in game, and if it ever can't apply, that's all that stops working. Whispers between players in
game are never recorded or sent anywhere.
From 1.6.1 the mod's answers can no longer get lost behind a ping, and a message the server was too busy to show within
4 seconds is dropped rather than shown after the sender was told it failed. If no answer comes in time, the dashboard keeps
the message as "sending…" and watches the log for it before saying it failed.
Set `web_chat=false` to turn it off.
**Liveview** (2.0.0 or newer): see [Liveview](#liveview) below.
**/mcstats menus** (2.2.0 or newer): see [In-game menus](#in-game-menus-mcstats) below.
**Never recorded:** private messages (`/msg`, `/tell`, `/w`, `/teammsg`) and commands. Let players know chat is logged.

## How it gets to the dashboard

```
Minecraft server ── mod queues each message ──► every few seconds, one HTTPS POST
                                                 to /api/ingest/chat on the Worker
                    Worker ─────────────────────► the key (token=) says which server it's from; that
                                                  server's own Durable Object checks it and stores the rows
Dashboard ◄──────── /s/<server>/api/chat ◄─────── read by that server's Chat log page

Dashboard ── POST /s/<server>/api/chat/send ──► Worker checks the signed-in email is on the roster
                                     ──► that server's link object ──► the mod's WebSocket (/api/ingest/link)
                                     ──► mod shows "[Web] <name> …" in game, answers ok, logs it as chat
```

The upload runs on a background thread, so the game never waits on it. If the dashboard can't be
reached, messages wait and are retried with backoff. Anything still unsent at shutdown is saved to
`config/mcstats-chat-pending.json` and sent after the next start. Each message has a unique id, so a
retried batch is never stored twice.

## Setup (once)

The dashboard walks you through this: open it, choose **Create a server**, and follow the steps. In short:

1. **Install the mod** on the server: `mcstats-chat-<version>.jar` (from the dashboard's setup page) into the
   server's `mods/` folder. The server needs Fabric Loader and the Minecraft version in `fabric.mod.json`;
   the Fabric API pieces the mod uses are built into its jar. Restart the server once; that creates
   `config/mcstats-chat.properties`.
2. **Connect it.** The setup page makes your server's key (it starts with `mcs_` and is shown once) and shows
   the file filled in. The two lines that matter:

   ```properties
   url=https://<the dashboard>/api/ingest/chat
   token=mcs_…
   ```

   Saved changes are picked up within a few seconds; no restart needed. Making a new key on the setup page stops
   the old one at once. `access_client_id` / `access_client_secret` stay blank (they're only for a dashboard behind
   Cloudflare Access).
3. **Check it.** The server console should say `Sending chat to …`, and the setup page turns green when the
   first upload arrives. If anything is wrong, the console says what (wrong key, wrong url), at most once every
   10 minutes.

A dashboard set up before servers had their own keys still takes its old shared `CHAT_INGEST_TOKEN` in `token=`, for
its first server only.

## In-game menus (/mcstats)

Every player can open chest-style menus with `/mcstats view` (or just `/mcstats`). Nothing in them can be taken
out; clicking an item opens its page, and each page has a Go Back arrow.

- **Your Profile**: choose how your 3D model looks on your dashboard page. *Displayed Main Hand* and
  *Displayed Off Hand*: click it, then click any item in your own inventory below. The item stays shown after
  you put it away; right-click (or *Automatic*) goes back to your best weapon. *Particle Effect*: one of 17
  particles that float around the model (you see a puff of it in game when you pick it). *Reset Display*
  undoes all three. Changes reach the dashboard within a few seconds, with the next gear report.
- **Server Stats**: the head of everyone who has played on the server, online players first. Hovering shows
  their name, playtime, whether they're online (or when they were last seen) and their role (operators show
  as Admin, in red). Clicking opens their stats: playtime, kills, deaths, K/D, damage, distance, jumps,
  trades, fish, and what they show on the website. The hopper changes the order.
- **Leaderboards**: the top 10 for playtime, player kills, mob kills, deaths and distance, with your own place.
- **Website**: a link to your page on the dashboard (needs dashboard 2.2.0, which tells the mod its address).

The numbers are the game's own statistics (`world/stats/<uuid>.json`), so they go back to the world's start.
Choices are kept in `config/mcstats-profiles.json`.

| Command | What it does |
|---|---|
| `/mcstats view` | The main menu |
| `/mcstats profile` | Your Profile |
| `/mcstats stats [player]` | Every player's heads, or one player's stats |
| `/mcstats top` | Leaderboards |
| `/mcstats link [player]` | A link to your (or their) dashboard page |
| `/mcstats connect [email]` | Connect your mcstats account: an anvil to type the email in (or give it here). Once someone signed in with that email clicks Connect above the dashboard's chat box, they chat from the website as you |
| `/mcstats disconnect` | Stop that account chatting as you |
| `/mcstats particle <name\|none>` | Set your particle effect without the menu |
| `/mcstats reset` | Back to the automatic look |
| `/mcstats help` | Lists these in game |

The dashboard's admins can switch any of these off but `/mcstats help` (2.4.0 or newer; Admin → Mod and
commands). A command that's off doesn't run, and leaves tab completion, `/mcstats help` and the menus. What's
off is kept in `config/mcstats-commands-off.txt`, so it holds from the start of the server.

`/liveview help` lists Liveview's commands, as does the dashboard's Liveview page.

## Liveview

Dashboard admins can watch the world from the dashboard's Liveview tab: the terrain around their camera, every
online player, nearby mobs, inventories and chests, and a feed of what happens. Watching never changes the world.
With a second key they can also run commands as the server console and move items in containers. The dashboard's
[README](../README.md#liveview) describes the page; this is the server's side of it. What travels between the
mod and the page, message by message, is in [PROTOCOL.md](PROTOCOL.md).

**The server decides who gets in.** The dashboard has its own permissions (a super admin ticks Liveview and
Liveview controls for an account there), but those are only half: the mod keeps its own list of dashboard
accounts it lets in, checks it itself whenever a page connects or asks for controls, and only tells the dashboard
what's on it. An account gets on the list by entering a key on the dashboard, or by an operator naming it here:

| Command | Who | |
| --- | --- | --- |
| `/liveview key viewer` | operators | Makes a new viewer key and shows it once (click to copy). Admins enter it on the dashboard, once per account, to watch. |
| `/liveview key control` | operators | The same for the control key: commands and item moves from the dashboard. |
| `/liveview access` | operators | The accounts on the server's list, and which may use controls. |
| `/liveview access viewer <email>` | operators | Lets that dashboard account watch, without a key (and takes controls away if it had them). |
| `/liveview access control <email>` | operators | Lets it watch and use controls. |
| `/liveview access remove <email>` | operators | Takes it off the list. If it's watching, it's disconnected. |
| `/liveview who` | operators | The dashboard accounts watching right now, and which have controls on. |

Run the key commands in game rather than from the console, so the key stays out of the server log. Only the
keys' hashes are kept, with the access list, in `config/mcstats-liveview.json`; don't publish that file, and
don't delete it to get a new key: run the command again. A new key replaces the old one at once. A new viewer key also empties the access list: everyone watching
is disconnected and has to enter it (or be allowed by name again). A new control key puts everyone back to
watching only. To take access away from one person, use `/liveview access remove`.

Give the control key only to people you'd make an operator: it runs anything the console can. The viewer key
alone can never change the world. Every command and item move from the dashboard is logged with the account
that made it:

```
Liveview command from someone@example.org: /gamemode creative Steve
```

**How it connects.** Nothing listens on the server. When an admin opens the tab, the dashboard asks for the view
over the web chat connection, and the mod opens a second WebSocket to `/api/ingest/liveview` next to the chat url
(same token and service token, no extra setup). It closes again a minute after the last viewer leaves. Liveview
therefore needs `web_chat=true`.

**Textures.** The server jar has no textures, so the first time someone watches, the mod downloads the official
Minecraft client jar for the server's version from Mojang (checked against Mojang's published hash) into
`config/mcstats-liveview-cache`, and packs the textures from it and from the installed mods. The server needs to
reach `piston-meta.mojang.com` and `piston-data.mojang.com` for that; if it can't, players, mobs and the feed still
show, without terrain, and the console says why. Set `liveview_client_jar` to a client jar's path to skip the
download.

**An empty server.** Minecraft pauses a server 60 seconds after the last player leaves
(`pause-when-empty-seconds` in `server.properties`), and a paused server stops updating the view. Set it to `0`
to keep the view live with nobody on. A host that puts the whole server to sleep when it's empty can't be
watched until it wakes.

**What it costs the server.** Nothing until someone watches. While they do, chunks around each viewer's camera
are kept loaded and ticking, the way they would be for a spectator, and are let go two seconds after the camera
moves on. Mobs near a camera don't despawn for lack of a nearby player. `liveview_camera_chunks` sets how far.

Liveview uses two more mixins (`mcstats_liveview.mixins.json`): one watches the particles and effects the game
sends to players, so the page can show them; the other keeps mobs near a viewer's camera from despawning. Like
the others, if one can't apply, only that part stops working.

## Paper

The same mod as a Paper plugin, `mcstats-paper-<version>+mc<minecraft>.jar`, built from the same source (from 2.4.0).
It goes in the server's `plugins/` folder and keeps its files in `plugins/mcstats/` (the same files the Fabric mod keeps
in `config/`: `mcstats-chat.properties`, the pending messages, profiles, the commands switched off, Liveview's keys and
texture cache). It needs nothing else installed. Paper runs on Mojang's own names, so the plugin calls the game directly,
as the Fabric mod does; that ties each jar to one Minecraft version. On any other it logs which jar to download and stays
off; on an older Paper than it's built for, Paper itself refuses it with "Unsupported API version". It runs on Paper, and
usually on forks of Paper such as Purpur (untested); not on Spigot, Bukkit or Folia.

Built for Paper 1.21.5, 1.21.8, 1.21.10, 1.21.11, 26.1.2, 26.2 and 26.3. Each jar was booted on its Paper version against
a stand-in dashboard; on every version but 26.2 and 26.3 (newer than the test client could join) two test players also
went through chat, /me, /say, joins, leaves, a death, advancements, an announcement sent to each player, web chat and a
web whisper, a whisper to a player who's only on the website, its tab completion, the /mcstats menu and gear. Liveview
(a viewer, terrain, textures and entity models, particles, an explosion, and commands from the dashboard) was tried on
26.1.2.

The Fabric mod's four mixins are replaced like this:

| Fabric | Paper |
| --- | --- |
| Whispers to a player who's only on the website (`CommandsMixin`) | Bukkit's command event, before other plugins see it |
| /msg suggesting website players (`CommandsMixin`) | the same change to the game's /msg, made once the server is up and after each /minecraft:reload |
| Messages sent to everyone one by one (`ServerPlayerMixin`) | the plugin watches the system messages the server sends each player. A message every player on got is logged, as on Fabric, but only with **two or more** players on: with one, there's no telling a message to everyone from an answer to them |
| Liveview's particles and effects (`ServerLevelMixin`) | explosions, block breaks, death poofs, snowballs and eggs breaking and splash potions come from Bukkit's events and show anywhere; other particles (hearts, crits, smoke…) are read from what's sent to players, so they show **only near a player** |
| Mobs near a Liveview camera don't despawn (`MobMixin`) | **left out**: Paper has no way to do it without changing the world. Mobs near a camera far from every player can despawn as usual |

Chat, /say and /me are read from Bukkit's events; joins, leaves, deaths and advancements from Paper's, as Paper finally
words them, so one a plugin rewords is still logged as a join (or leave, death, advancement) of that player. Commands run
from Liveview's control key go through the game's own command system, so other plugins' commands work too, and their
answers come back to the dashboard.

The plugin's User-Agent ends in `Paper` (`mcstats-chat/2.4.0 (Minecraft 26.2) Paper`), so the dashboard offers Paper
jars in its update notices and on Admin → Mod and commands.

## Troubleshooting

Search the server console (latest.log) for `mcstats-chat`:

| Console says | Meaning |
| --- | --- |
| nothing at all | The mod didn't load. Fabric: check that the jar is in `mods/`, that the server runs Fabric, and look for a Fabric error naming `mcstats_chat` near the top of the log. Paper: check that the Paper jar (`mcstats-paper-…`) is in `plugins/`, and look for `mcstats` near the top of the log. |
| `This mcstats jar is for Paper …, but this server runs …` | Paper: the jar is for another Minecraft version. Download the one for the server's version; if there isn't one, update Paper to a version there is. |
| `Unsupported API version …` (naming `mcstats-paper-…`) | Paper: the jar is for a newer Minecraft than the server runs. Download the one for the server's version. |
| `Created …/mcstats-chat.properties` on every start | The filled-in file isn't where the mod looks, or has a different name. It must be exactly `config/mcstats-chat.properties`. |
| `Not sending chat: url is blank` (or `token`) | The file was found but that value is empty. Check spelling of the keys (`url=`, `token=`). |
| `Sending chat to …` then `Chat log connected` | Working. |
| `Web chat connected` | Messages typed on the dashboard will show in game. |
| `The dashboard lost the web chat connection; reconnecting` | 1.7.1 or newer: the dashboard said for 40 seconds that it no longer has the connection (usually just after a deploy); it reconnects by itself. |
| `Web chat isn't connected: …` | Same reasons as below; the dashboard shows the message box as offline meanwhile. |
| `Liveview is ready but has no viewer key yet` | Liveview is on and waiting for an operator to run `/liveview key viewer` in game. |
| `Liveview connected to the dashboard`, `… is watching` | An admin opened the Liveview tab. |
| `Liveview terrain is disabled: …` | The game's textures couldn't be fetched or packed; the rest of the line says why. Players, mobs and the feed still show. |
| `Liveview is off: config/mcstats-liveview.json could not be read` | The keys file is damaged. Running `/liveview key viewer` starts it afresh (players who opted out have to do so again). |
| `Couldn't send chat: …` | The rest of the line says which part is wrong. Note that Cloudflare Access answers 401 for a service token it doesn't recognise and 403 for one it knows but no Service Auth policy allows. |

To test a config file from your own computer, put a copy named `mcstats-chat.properties` in the repo root
(it's gitignored) and run `node scripts/test-chat-ingest.mjs`. It sends one test message the same way the
mod does and says what's wrong, without printing the secrets. Add `--check` to test without storing anything,
or pass another file's path.


| Key | |
| --- | --- |
| `url` | The dashboard address plus `/api/ingest/chat` |
| `token` | Your server's key from the dashboard's setup page (`mcs_…`) |
| `access_client_id`, `access_client_secret` | Only for a dashboard behind Cloudflare Access: its service token |
| `system_messages` | `false` to send only chat, without joins, leaves, deaths and advancements (default `true`) |
| `web_chat` | `false` to stop showing chat sent from the dashboard (default `true`) |
| `liveview` | `false` to turn Liveview off (default `true`; nobody can watch until a viewer key is made) |
| `liveview_control` | `false` to refuse commands and item moves from the dashboard, whatever keys exist (default `true`) |
| `liveview_camera_chunks` | Chunks of terrain sent around a viewer's camera, 2 to 12 (default `8`) |
| `liveview_player_chunks` | Chunks kept ready around each player, so jumping to them is instant, 0 to 4 (default `2`) |
| `liveview_entity_blocks` | How far from a player or camera mobs are sent, in blocks, 0 to 128 (default `64`) |
| `liveview_client_jar` | A Minecraft client jar to read textures from; blank downloads the official one |

A properties file made by an older version has none of the `liveview` keys; add the ones you want to change.
The on/off switches are picked up within a few seconds, like the rest; the three sizes and the client jar
are read when the server starts.

## Building

Needs JDK 25. The Paper jars are built on Java 21 (1.21.x) and 25 (26.x), which Gradle downloads if they aren't
installed (`-Porg.gradle.java.installations.paths=<jdk>` points it at one you have); Paper's own tools for some
versions can't run on a newer JDK.

```bash
cd mod
./gradlew build                  # → versions/<mc>/build/libs/mcstats-chat-2.4.0+mc<mc>.jar (Fabric)
                                 #   paper/<mc>/build/libs/mcstats-paper-2.4.0+mc<mc>.jar (Paper)
./gradlew :26.2:build            # one Fabric version
./gradlew :paper-26.2:build      # one Paper version
```

The source is in three parts: `src/main` is shared, `src/fabric` is the Fabric entry point (`FabricEntry`), the mixins
and `fabric.mod.json`, and `src/paper` is the plugin (`PaperPlugin`, Bukkit's events in `PaperEvents`, the network
watcher in `NetworkTap`) and its `plugin.yml`. All of it goes through the preprocessor (`preprocess.gradle`), which also
takes `//#if PAPER` and `//#if FABRIC` for the odd line in shared code that differs. A Paper version is a folder in
`paper/` with its dev bundle in `gradle.properties`.

For another Minecraft version, update `minecraft_version` and `fabric_api_version` in `gradle.properties`
(see https://fabricmc.net/develop) and the `minecraft` range in `src/main/resources/fabric.mod.json`, then rebuild.
Liveview reads the game's own classes far more than the rest of the mod does (chunks, block models, entity
models), so expect it to need changes for a new Minecraft version; everything that touches Minecraft is in
`dev.mcserverstats.liveview.mc`.

When you release a version, bump `version` in `gradle.properties` and add it to [CHANGELOG.md](CHANGELOG.md).
