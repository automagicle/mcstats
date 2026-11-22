# mcstats (server mod)

A server-side Fabric mod that sends the server's public chat to the dashboard's **Chat log** page, every death
to its **Combat** page, what each player wears and carries to the **3D model** on their player page, shows chat
sent from the dashboard in game, and (from 2.0.0) lets the dashboard's admins watch the world live in its
**Liveview** tab.
It's one jar with no other dependencies (the bits of Fabric API it uses are bundled inside), for
Minecraft **26.2** on Fabric Loader 0.18.4 or newer. Players don't install anything.

What each version added is in [CHANGELOG.md](CHANGELOG.md).

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
**Never recorded:** private messages (`/msg`, `/tell`, `/w`, `/teammsg`) and commands. Let players know chat is logged.

## How it gets to the dashboard

```
Minecraft server ── mod queues each message ──► every few seconds, one HTTPS POST
                                                 to /api/ingest/chat on the Worker
                    Cloudflare Access ──────────► lets it through only with the service token
                    Worker ─────────────────────► checks CHAT_INGEST_TOKEN, stores rows in D1 (chat table)
Dashboard ◄──────── /api/chat ◄────────────────── read by the Chat log page (behind your normal login)

Dashboard ── POST /api/chat/send ──► Worker checks the login email is on the roster
                                     ──► Durable Object ──► the mod's WebSocket (/api/ingest/link)
                                     ──► mod shows "[Web] <name> …" in game, answers ok, logs it as chat
```

The upload runs on a background thread, so the game never waits on it. If the dashboard can't be
reached, messages wait and are retried with backoff. Anything still unsent at shutdown is saved to
`config/mcstats-chat-pending.json` and sent after the next start. Each message has a unique id, so a
retried batch is never stored twice.

## Setup (once)

1. **Make a token** (any long random string):

   ```bash
   openssl rand -hex 32
   ```

2. **Give it to the Worker** as a secret named `CHAT_INGEST_TOKEN`:

   ```bash
   npx wrangler secret put CHAT_INGEST_TOKEN
   ```

   You can also add it in the Cloudflare dashboard: **Workers & Pages → mcstats → Settings → Variables and Secrets → Add → Secret**.

3. **Create an Access service token**, so the mod can get past the login page. In Cloudflare
   **Zero Trust → Access → Service credentials → Service Tokens**, click **Create Service Token**,
   name it `mcstats-chat`, and pick **Non-expiring**. Copy the **Client ID** and **Client Secret**
   (the secret is only shown once).

4. **Allow that token on the dashboard's Access application.** Go to **Zero Trust → Access → Applications**,
   open the mcstats `workers.dev` application, then **Policies → Add a policy**:
   - Action: **Service Auth**
   - Include: **Service Token** → `mcstats-chat`

   Save. A service token can only post chat; the Worker won't show it any dashboard data.

5. **Deploy the dashboard.** Merging to `main` deploys it and creates the `chat` table.

6. **Install the mod on mcsh.io.**
   - Upload `mcstats-chat-2.0.0.jar` into the server's `mods` folder.
   - Start the server once. That creates `config/mcstats-chat.properties`.
   - Fill in that file (the template has comments):

     ```properties
     url=https://mcstats.<your-subdomain>.workers.dev/api/ingest/chat
     token=<the CHAT_INGEST_TOKEN from step 1>
     access_client_id=<Client ID from step 3>
     access_client_secret=<Client Secret from step 3>
     ```

     Saved changes are picked up within a few seconds; no restart needed. You can also upload a
     filled-in copy of the file to `config/` before the first start.

7. **Check it.** The server console should say `Sending chat to …`. Say something in chat; it shows up
   on the Chat log page within about 15 seconds. If anything is wrong, the console says what
   (wrong token, Access blocking it, wrong url), at most once every 10 minutes.

## Liveview

Dashboard admins can watch the world from the dashboard's Liveview tab: the terrain around their camera, every
online player, nearby mobs, inventories and chests, and a feed of what happens. Watching never changes the world.
With a second key they can also run commands as the server console and move items in containers. The dashboard's
[README](../README.md#liveview) describes the page; this is the server's side of it. What travels between the
mod and the page, message by message, is in [PROTOCOL.md](PROTOCOL.md).

**The two keys.** Nobody can watch until an operator has made the viewer key, and nobody can run a command
until one has made the control key:

| Command | Who | |
| --- | --- | --- |
| `/liveview key viewer` | operators | Makes a new viewer key and shows it once (click to copy). Admins enter it on the dashboard, once per account, to watch. |
| `/liveview key control` | operators | The same for the control key: commands and item moves from the dashboard. |
| `/liveview who` | operators | The dashboard accounts watching right now, and which have controls on. |
| `/liveview optout`, `/liveview optin` | any player | Hide yourself from Liveview (your marker, inventory and actions), or come back. |

Run the key commands in game rather than from the console, so the key stays out of the server log. Only the
keys' hashes are kept, with the opt-out list, in `config/mcstats-liveview.json`; don't publish that file, and
don't delete it to get a new key (that also forgets who opted out): run the command again. A new key replaces
the old one at once. Everyone watching is disconnected and has to enter the new viewer key, or, for the control
key, goes back to watching only. That is also how you take access away from someone.

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

## Troubleshooting

Search the server console (latest.log) for `mcstats-chat`:

| Console says | Meaning |
| --- | --- |
| nothing at all | The mod didn't load. Check that the jar is in `mods/`, that the server runs Fabric (not Paper/Forge), and look for a Fabric error naming `mcstats_chat` near the top of the log. |
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
| `token` | Must equal the Worker's `CHAT_INGEST_TOKEN` |
| `access_client_id`, `access_client_secret` | The Cloudflare Access service token |
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

Needs JDK 25.

```bash
cd mod
./gradlew build      # → build/libs/mcstats-chat-2.0.0.jar
```

For another Minecraft version, update `minecraft_version` and `fabric_api_version` in `gradle.properties`
(see https://fabricmc.net/develop) and the `minecraft` range in `src/main/resources/fabric.mod.json`, then rebuild.
Liveview reads the game's own classes far more than the rest of the mod does (chunks, block models, entity
models), so expect it to need changes for a new Minecraft version; everything that touches Minecraft is in
`dev.mcserverstats.liveview.mc`.

When you release a version, bump `version` in `gradle.properties` and add it to [CHANGELOG.md](CHANGELOG.md).
