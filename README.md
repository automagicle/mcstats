# mcserverstats

Tracks who's on Minecraft servers and when, and shows each server on its own private dashboard. Many servers
use one site at the same time; each has its own page (`/<server>`), its own password, its own data and its own
members, and none can see or change another's (see [How servers are kept apart](#how-servers-are-kept-apart)).
It runs on Cloudflare (Workers, Durable Objects, D1), so nothing needs to stay on at home.

- **Collector**: each server's Durable Object sets its own alarm to ask [mcstatus.io](https://mcstatus.io) about its Minecraft server every minute, and records the player count plus each named player's session in its own SQLite. The server mod's own list of who's online is added to it, and a server with no address set (it's optional) is checked from the mod's list alone, from its first upload on.
- **Dashboard**: static files in `public/`, served by the same Worker. It shows players online over time, a GitHub-style daily heatmap, a leaderboard, busiest hours, and a page for each player.
- **Chat log, combat, gear and advancements** (optional): a server mod in `mod/`, as a Fabric mod and as a Paper plugin
  built from the same source, posts public chat, every death
  (who died, who or what did it, and how), what each player wears and carries, and their advancements, to the Worker,
  which stores them in D1. It also shows chat typed on the dashboard in game (web chat).
  See [mod/README.md](mod/README.md) for setup, and [mod/CHANGELOG.md](mod/CHANGELOG.md) for what each of its
  versions added.
- **Liveview** (admins only, optional): a fourth tab that shows the world as it is right now, in 3D, straight from
  the server mod: fly a camera through the terrain, follow a player, open inventories and chests, read what's
  happening. It's behind two keys that are made on the Minecraft server (see [Liveview](#liveview)).
- **Discord bot** (optional): one bot for the whole site. An owner adds it to their Discord server from
  Admin → Discord in two clicks. It answers `/online`, `/player`, `/top`, `/seen`, `/deaths` and `/server` from that
  server's stats, and posts a live status message, joins, deaths, advancements, a daily summary and (if the owner
  shares it) the game's chat. Players can talk into the game with `/say`. A Discord server sees only the
  mcstats server it's linked to, and only what that server's owner shares. See [DISCORD.md](DISCORD.md).
- **Seasons**: a server's main page shows its current season; `/<server>/s1` is its season 1 archive. Seasons split
  the recorded data by time, so nothing is copied or deleted (see [Seasons](#seasons)).
- **Privacy**: looking at a server needs its join password (or the owner can make it public); chatting from the
  website and the admin pages need an mcstats account (email and password) that's a member of that server. The mod's uploads need that server's key.

The look of the dashboard (colors, type, the 2px pixel shapes, spacing, components) is written down in [DESIGN.md](DESIGN.md).

## Deploy

```bash
npm install
npx wrangler login
npx wrangler d1 create mcstats-directory     # paste its database_id into wrangler.jsonc (DIRECTORY)
npm run dir:migrate:remote
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
npx wrangler secret put RESEND_API_KEY        # sends account codes; EMAIL_FROM's domain must be verified in Resend
npx wrangler secret put SUPER_ADMIN_EMAIL     # you: can do everything on any server you sign in to
npm run build:mod                             # the Fabric and Paper jars that /new offers (needs Java 25; Java 21 is fetched for the 1.21.x Paper jars)
npm run deploy
```

The Discord bot is optional: without its settings it's off and Admin → Discord says so. To switch it on, make a
Discord app and follow "Operator setup" in [DISCORD.md](DISCORD.md). In short: `DISCORD_APP_ID` and
`DISCORD_PUBLIC_KEY` in `wrangler.jsonc`, the secrets `DISCORD_BOT_TOKEN` and `DISCORD_CLIENT_SECRET`, the
Interactions Endpoint URL `https://<site>/api/discord/interactions`, the OAuth2 redirect
`https://<site>/api/discord/oauth`, and `npm run discord:commands` once.

Then open the site, choose **Create a server**, and follow the steps: create your mcstats account (or sign in), name the server, pick
its address (`/<address>`, checked as you type; names the site uses or may come to use, like `/settings`, can't be taken) and whether its stats are **private** (players need its join
password) or **public** (anyone with the address can look; no password needed), install the mod, paste the key it
shows into the mod's config, and wait for the first upload. Players of a private server get in with its **join
link** (the last step offers to make one: a single address that lets in whoever opens it), or at `/join` with the
server's name and password; a public server's stats are simply at its address. A public server can be made private
later once it has a password.

Updating an existing deployment: `npm run deploy` brings the directory database up to date first (it runs
`wrangler d1 migrations apply mcstats-directory --remote`, then deploys), so new code never meets an old database.
Deploying with `wrangler deploy` directly skips that: run `npm run dir:migrate:remote` yourself first, or every
request that looks a server up fails with HTTP 500 (`no such column`).

Nothing else is set per deployment: each server's address, time zone, seasons and chat resets are its own settings
(the **Optional setup** step on `/new`, or `POST /api/site/servers/<server>/settings` with `MC_SERVER`, `TZ_NAME`,
`CURRENT_SEASON`, `SEASONn_START`, `SEASONn_OPENS`, `CHAT_RESETS`, `PUBLIC`). Its name, address, join password and
look are changed from its own dashboard (Admin → Server, below).

`npm test` runs the tests (Vitest inside the Workers runtime), including the ones that check servers stay apart.

### Moving from the single-server version

The single-server version kept everything in the `mcstats` D1 database and was behind Cloudflare Access. To move it
into the first server (`LEGACY_SLUG`, `eggsmp`) without stopping the mod:

1. Do the [Deploy](#deploy) steps above, and also `openssl rand -base64 48 | npx wrangler secret put OPS_TOKEN`.
   Keep the `CHAT_INGEST_TOKEN`, `MC_SERVER` and `ADMIN_EMAIL` secrets: the old shared token keeps working for the
   first server, the address and the admins are copied into it.
2. Remove the Cloudflare Access application from the Worker's address (Zero Trust → Access → Applications), or it
   keeps asking everyone, players and the mod included, for an Access login first.
3. Copy the data and check it:
   `OPS_TOKEN=… JOIN_PASSWORD=… npm run copy-tenant -- --url https://<worker address> --owner you@example.org`.
   Uploads from the mod wait (it keeps them) until the copy is checked; the script prints each table's row count
   on both sides and only finishes if they all match.
4. Give players `/join`, the name `eggsmp` and the join password. Old links to `/s1/` go to `/eggsmp/s1`.
5. When you're ready, make the first server a key of its own on `/new` (signed in to the owner's account) and put it
   in the mod's `token=`; then the old `CHAT_INGEST_TOKEN` secret can be deleted.

## How servers are kept apart

- **One object per server.** Every server's data (stats, chat, deaths, gear, roster, members, settings, its mod key)
  lives only in its own Durable Object's SQLite (`src/tenant.js`), named by a random id. Its migrations
  (`src/tenant/schema.js`) run inside it when it starts; a stored version number says which have run. Its web chat,
  live updates and Liveview objects are named by the same id, so they can't reach another server's either.
- **The directory** (`DIRECTORY`, a D1 database: `directory-migrations/`) says which servers exist (slug, name,
  hashed join password, hashed mod key, owner, created date) and holds the mcstats accounts (email, hashed password,
  hashed session tokens: see [Sign-in](#sign-in)). No stats. A D1 database rather than one directory object,
  because every page load looks a server up and one object would make every request in the world wait in one line.
- **Which server** a request is for is decided once, in the Worker (`src/index.js`): from the address (`/<server>`)
  for pages, and only from the key (`mcs_<server id>_…`) for the mod. A server named in a body or query string is ignored.
- **Addresses**: servers sit at the top of the site (`/<server>`), beside its own pages (`/join`, `/new`, …:
  `SITE_PATHS` in `src/directory.js`, which always win). They used to be at `/s/<server>/`: those addresses redirect
  for good (301, or 308 for a request with a body), keeping the rest of the address, and a viewer cookie made at the
  old address is moved to the new one on the way. The site's old `mcstats.<account>.workers.dev` address redirects to
  `SITE_ORIGIN` the same way, except `/api/ingest/*` and `/downloads/*`: mods set up before the domain still upload
  there, and the mod doesn't follow redirects.
- **The viewer cookie** (from joining with a server's password) is signed with a key derived from `SESSION_SECRET` and
  the server's id, and sent only to that server's pages (`Path=/<server>`, HttpOnly, Secure, SameSite=Lax). Joining A
  gives nothing on B. An mcstats **account** is signed in site-wide, but it's nobody on a server until it's a member
  there: being a member of A makes you nobody on B.
- **Roles** are per server: `owner`, `admin`, `member` (src/roles.js), each a starting set of the five permissions.
  Owners and admins can do the same things (the Roles tab, the address, password and visibility, Discord linking),
  except that only an owner makes owners, and no one but a super admin changes or removes an owner.
  Every admin check asks "is this email an admin *of this server*".
- **Caches** are per server: the `cache` table is in each server's own database, and Liveview's assets are cached
  under the server's id. Only the game's own textures and Mojang skins are shared, keyed by version and name.
- **Joining** gives the same answer for a wrong password and a server that doesn't exist, takes the same time
  (PBKDF2 runs either way), and is rate limited the same way: per server and address, per server, and per address.
  Passwords are PBKDF2-SHA256 with a per-server salt and 100,000 iterations (the most the Workers runtime allows).

## Seasons

Each server has its own seasons. A season is only a stretch of time: season 1 runs from the first thing recorded,
and season `n` from its start to the start of season `n+1`. Nothing is copied or deleted by changing them; a moment
just counts towards whichever season it falls in. A new server is in season 1 and stays there until its admins say
otherwise.

Admins manage them on **Admin → Server → Seasons** (`src/seasonadmin.js`, `/api/admin/seasons`):

- **Start a new season**: now, or at a set time. The main page becomes the new season at once; if it starts later, the
  page says when and the season before keeps recording until then. It asks for the season's name to be typed
  ("Season 3") before it does anything, and can bring over the teams, players and sign-in emails, which are per season.
  A season that hasn't started yet can't be followed by another.
- **Move a start** (and so the end of the season before): any time after the previous season's start and before the
  next one's. Moving it across time that's already recorded asks first, since that time changes season.
- **Officially opens** (optional): see below.
- **Remove the newest season**: its time counts as the season before again, which goes back to being the main page.
  Typed confirmation too; its teams and players stay in the database in case it's made again.

Underneath these are the server's settings `CURRENT_SEASON`, `SEASONn_START` and `SEASONn_OPENS`.

**Switching seasons** on the page is the **Season** menu at the far right of the footer, apart from the footer's
links; it's only there once a server has more than one season. Earlier seasons live at `/<server>/s1`, `/s2`, ….

**Recording before the official start**: to test before a season opens, set the season's start to when recording
should begin and "officially opens" (`SEASON2_OPENS`) to the official start. Everything from `SEASON2_START` on is season 2 and counts; charts hatch
the time before `SEASON2_OPENS` ("Season starts Sun 7:30 PM", then "Before the season") with what was recorded drawn
over it, and a line at the top says the season hasn't started. To drop the test data once the season is on, move
`SEASON2_START` to the official time (it then counts as the end of season 1) and remove `SEASON2_OPENS`.

From then on `/s1/` is frozen at the end of season 1: its charts show its final days, the tiles show its length, peak and
total, the leaderboard opens on All, and it stops refreshing.

**Chat resets**: `CHAT_RESETS` (a server setting) is a list of times, separated by commas, like
`"2026-11-15T18:00:00-08:00"`. At each one the chat log starts over: messages from before the latest reset that has
passed are no longer shown, searched or counted (the unread badge and each player's message count included). Nothing is
deleted: they stay in the database, and removing the time (and deploying) brings them back. A time in the future takes
effect by itself when it arrives. Deaths on the Combat page are not affected.

**Teams**: each season's teams, players' real names, their eggs and their login emails live in the database (the
`roster` and `roster_email` tables), so they stay out of this public repository. Keep them in `roster-s2.json` (git
ignores `roster-*.json`; see `roster.example.json` for the format:
`"IGN": { "name": "Real name", "egg": "gravity", "email": "them@example.org" }`, egg ids as in the Egg SMP datapack;
`email` can be a list) and run `npm run roster:remote` after each change; it replaces the season's roster, takes effect
at once and needs no deploy. `npm run roster:local` does the same for local development.
A player's emails are who may send chat from the dashboard as them, whether or not the player is on a team yet. They stay off the public pages; admins set them on Admin → Players.
Who sends chat as **Admin** (a yellow Admin tag instead of a name; in game: `[Web] [Admin] message`) is picked on
Admin → Roles, under **Chats as**. `"admins": ["someone@example.org"]` beside the teams in the roster file still does
the same thing.

**Sample data**: `/?dummydata` fills the main page with made-up activity for the season's real players (from the roster), to
see the page full before there's real data. It's generated in the browser (`public/dummy.js`) and never stored; the chat
log is left empty.

## Admin page

`#/admin` (linked in the footer for admins only) is one page with a menu down the left: **Players**, **Teams**,
**Layout**, **Server**, **Chat and deaths**, **Mod and commands**, **Connection and data**, **Analytics**, and, for
owners and admins, **Roles**. On a
phone the menu is a strip that scrolls sideways. One Save bar at the bottom covers every section. It only
appears when something is unsaved, lists each change, and puts a count on the section it belongs to. Reset
puts that draft back. Nothing on the site changes until Save, and Save applies all of it or none of it.
Unsaved changes stay while you look at other pages, and the browser warns before the tab is closed with some.

### Server (the server's own details)

Admin → **Server** (`src/serveradmin.js`, `GET`/`POST /api/admin/server`) changes the server itself. Like the rest of
Admin it is a draft on the Save bar; nothing changes until Save.

| What | Who | Notes |
| --- | --- | --- |
| **Name** | admins | Shown at the top of its pages and in emails. |
| **Icon** | admins | A square picture, dropped on the box or picked with the button, cropped to a 128px PNG. The game's own 64×64 `server-icon.png` stays sharp. It sits beside the name in the About header on Activity, and it becomes the browser tab's icon. |
| **Description** | admins | Up to 280 characters under the name in that header. A line break starts a new line. The header stays hidden until there is an icon or a description, and Admin → Layout can switch it off altogether. |
| **Address** (`/<address>`) | owners and admins | Moves the server: the old address stops existing (its join link too) and everyone joins again at the new one (cookies are per address). It can't be a name the site uses or may come to use (`RESERVED` in `src/directory.js`). Whoever moves it is let in at the new address straight away. The first server can't be moved while the old shared `CHAT_INGEST_TOKEN` is still set, because that token finds it by its address. At most 5 moves a day. |
| **Private or public** | owners and admins | A public server can only be made private once it has a join password. |
| **Join password** | owners and admins | 8 characters or more. A new one makes everyone who joined with the old one join again. |
| **Join link** | admins | One address (`/<server>/join/<token>`) that lets in whoever opens it, with no name or password to type: made, copied, replaced and turned off here, at once (not with the Save bar). A new link stops the old one working; people it already let in stay in until the join password changes. Not offered while the server is public. |
| **Accent color** | admins | Green (the default), blue, or any color (`#rrggbb`). |
| **Tab style** | admins | Line (the default: the current tab is greyer with a line in the accent color under it) or Frame (set in, framed, no color). |
| **Add-ons** | the site's operators (`SUPER_ADMIN_EMAIL`) | Features only some servers have; see Add-ons below. |

The look is tried on the page as you pick, and put back if you leave without saving. Once saved, the Worker writes it
on the page's `<html>` before anything is drawn (`data-accent`, `data-tabs`; `src/look.js`), so there's no flash of
another color. DESIGN.md has the tokens.

### Add-ons

Features only some servers have are kept out of the dashboard every server gets:

- `public/addons/<id>/` holds the add-on: `addon.js` (registers itself on `window.MCS_ADDONS`), its stylesheet and its data.
- `src/addons.js` lists the add-ons the site has.
- A server's `ADDONS` setting names the ones it has. The Worker puts only those on its page (`src/index.js`), ahead
  of `app.js`, which asks them at a handful of named places (search `app.js` for "add-ons" for the list of hooks:
  a tag beside a player's team, a line under their 3D model, what the model holds in its off hand, a card beside
  Combat, a column on the roster, and options for the sample data). With no add-ons those places are simply empty.

**Egg SMP** (`public/addons/eggsmp/`) is the one add-on so far: each player's egg on their page, in their model's
hand with its particles, and an Egg column on the roster. The first server (the one copied in from the single-server
version) has it switched on; servers made on `/new` don't. The roster's `egg` column and the gear report's `egg`
field are still stored for every server (they're simply empty elsewhere), so switching the add-on off and on loses nothing.

### Players

Admin → **Players** is a list beside an editor for one player. The list searches by in-game name or real name and
filters to the roster, people not on it, or hidden players. The editor sets their team, real name, any add-on
fields, the teams they were on earlier, which sign-in emails can send chat from the site as them, whether they
are hidden (and the note that goes with that), and which accounts merge into them. Typing a name the server has
not seen yet offers to add that player. On a phone, picking a player hides the list; **All players** brings it back.

### Layout

Admin → **Layout** arranges the Activity, Player and Combat pages. Each section is a block: drag it, or use its
arrows, to reorder; set it to a third, a half, two thirds or full width; hide it; and, where the page allows,
rename its heading. The number tiles (Online now, and the ones on a player page) reorder and hide the same way.
Widths are a row of six columns, and the last block in a row stretches so a hidden section leaves no gap. On a
phone every section is full width whatever width it was given. The real pages show the draft as you edit, with a
note that it is not saved yet; everyone else still sees the saved layout. It is one server setting (`LAYOUT`,
`src/layout.js`) and the Worker puts it on the page before the dashboard draws, so the pages are already arranged.

### Chat and deaths

**Done right away**: the deaths left out of Combat and the deleted chat messages (so either can be undone), filling
gaps, and testing the web chat connection. Admins can also right-click a chat line or a death: **Delete message**
takes it out of the chat log (and Combat), and **Don't count in combat** leaves a death out of Combat while the chat
log keeps it. Shift + right-click opens the browser's own menu. Deleted lines are kept in `deleted_chat` and come
back with Restore; a copy the mod resends stays out.

### Teams

**Teams** (table `teams`): the Teams card makes new teams, renames them, picks each one's color (a dark page
uses a lighter shade of it), and orders them with the arrows; that order is the one they're listed and stacked in
everywhere. Three settings per team say how much of the dashboard it's part of:

- **Combat scoreboard**: *Shown* (two teams shown make the tug-of-war bar; one, or three or more, get a block
  each), *In the middle*, or *Hidden*. A team in the middle sits between the two sides of the tug-of-war bar with no
  kills and deaths headline of its own: its deaths as one segment, its kills of the first side to their left and of
  the second side to their right. Segments that would be empty aren't drawn, so with nothing in the middle the bar
  is the plain two-team one.
- **Kills chart**: its kills as their own color in the Combat chart, otherwise with the other deaths.
- **Activity charts** (Players online by team and share, Daily activity's stacks, Busiest times): *Show*, *Hide*, or
  *Group with* another team: the team has no series of its own there and its players' time counts as the other
  team's (`teams.activity_with`). In Daily activity a team with no time that day isn't in the bar or its tooltip.

A team left out of a chart still has its players, in their color, everywhere else. A team can be removed once
nobody's on it.

**Teams over time** (table `team_history`): changing a player's team counts from now on. What they did before stays
with the team they were on then: their playtime in the by-team charts and their kills and deaths in Combat (names
show the team they're on now). Each player's row opens an editor of their earlier teams, oldest first, with a bar of
the season in the teams' colors: move the moment a stretch ended (to the minute), change which team (or no team)
they were on in it, add a stretch, or remove one. Removing the earlier team makes the new one count for everything.
The web chat connection card shows the server mod's link and tests it.

### Roles (who may do what)

`#/admin/roles` (**Roles**, super admins only) is a table of everyone the site knows about (whoever has
opened it, is on the roster, or was added there by email) with five permissions each, ticked independently and
saved at once (table `user_perms`, `src/roles.js`):

| Permission | Lets them |
| --- | --- |
| **View** | See the dashboard at all. Without it every page says the account has no access. |
| **Chat** | Send chat and whispers from the Chat log, as whoever the row's **Chats as** says (below). |
| **Admin page** | The admin page, except Roles. |
| **Liveview** | Watch through Liveview, once the Minecraft server lets the account in. |
| **Liveview controls** | Run commands and move items from Liveview, once the server allows that too. |

Everything here is per server. Each member has a **role**, which sets their ticks: **Owner** (all five, and this
section), **Admin** (all five) and **Member** (View and Chat). Anyone who can look at the server becomes a member by
signing in on it; owners add admins and members here (or on `/new`), switch single ticks, and remove members.

**Making an owner**: the role dropdown's **Owner…** opens a dialog that says what an owner can do and asks for the
account password of whoever is doing it (checked by the server; 5 tries in 10 minutes). An owner can't be changed
back or removed from the page afterwards, only by a super admin.

**Chats as** is who each member's messages from the Chat log come from: their **player** (the one Admin → Players
links their email to) or **Admin** (the yellow Admin tag instead of a name). It's a dropdown wherever there's a
choice: anyone can be set to chat as Admin, whatever their role and whether or not they have a player, and set back
(`user_perms.chat_admin`; the player stays linked). Owners and admins with no player always send as Admin; a member
with none can't send until they're linked or set to Admin.
"Changed" means someone's ticks differ from their role's; **Reset** puts them back. The last column shows the Minecraft server's own say for Liveview (see [Liveview](#liveview)): a tick here
is only half of it, and that half can't be given from the dashboard.

**Super admins** are the account emails in the `SUPER_ADMIN_EMAIL` secret (comma-separated): the site's operators.
Signed in on any server, they can do everything there and can't be changed from the page:

```bash
npx wrangler secret put SUPER_ADMIN_EMAIL
```

For local development, add `SUPER_ADMIN_EMAIL=` with your `DEV_EMAIL` to `.dev.vars`.

The old `ADMIN_EMAIL` secret only matters once: `scripts/copy-tenant.mjs` makes those emails admins of the first
server. Players, teams, real names, chat emails and eggs changed on the page are
replaced the next time `npm run roster:remote` runs, so copy lasting ones into the roster file.

### Analytics

`#/admin/analytics` (**Analytics**) is website analytics kept in our own database
(table `site_visits`, `src/analytics.js`), with no outside service. The page sends `POST /api/hit` with only its
route (home, chat, combat, admin, or `player:<uuid>`) on each page view, and once a minute while a page is open and
visible. Rows are per visitor (their Cloudflare Access login), page and UTC day, so storage stays small. The tab shows
visitors, page views, time on the site and the share on phones for the last 7, 30 or 90 days or year, a chart of
each day, the most viewed pages, and each visitor (by IGN where their login is on the roster) with their views, days,
time and when they were last on. **Leave out admins** (on by default) hides this server's admins' own visits.

## Liveview

`#/live`, the **Liveview** tab, is only there for accounts with the **Liveview** permission (see
[Roles](#roles-who-may-do-what); by default, the `ADMIN_EMAIL` logins). It shows the Minecraft world
live: the terrain around your camera with the game's own textures, every online player, the mobs around them, and
a feed of what happens. The server mod (2.0.0 or newer) does the work; nothing about the world is stored here.
It used to be a separate mod with its own web page and passwords, and is now part of this one.

**Turning it on**:

1. Update the dashboard: `npm run db:migrate:remote` (adds the `user_perms` table), `npx wrangler secret put
   SUPER_ADMIN_EMAIL`, then `npm run deploy` (adds the `LiveRelay` Durable Object).
2. Put `mcstats-chat-2.0.0.jar` in the server's `mods` folder in place of the older jar, and restart the server. If
   the standalone Liveview mod was installed, remove it (see [mod/CHANGELOG.md](mod/CHANGELOG.md)).
3. In game, as an operator, run `/liveview key viewer`, open the Liveview tab and enter the key. For controls,
   do the same with `/liveview key control` when the page asks.

**Watching** (the World, Players and Log sections):

- Click the view to fly (WASD, Space and Shift for up and down, Ctrl to go faster, Esc to stop), or drag to look
  around. **Keys** on the view lists everything; **Settings** has fly speed, mouse sensitivity, field of view, sky
  and weather. With nobody online the camera starts over the world spawn.
- **Players** (or M) lists who's on: go to one, follow them in first person or from behind, open their inventory
  or ender chest. Clicking a player in the world opens their inventory too; right-clicking a chest, barrel or
  shulker box looks inside. Items show the game's own tooltips.
- A player's page there has their health, food, game mode and position as they change, and their inventory.
- T or Enter types a chat message, sent the same way as from the Chat log (`[Web] <you> message`).
- Watching never changes the world. A player can hide from it in game with `/liveview optout`.

**The Minecraft server decides who gets in.** The Liveview permission isn't enough to watch: the server keeps its
own list of dashboard accounts it lets in (in the mod's `config/mcstats-liveview.json`), and the dashboard can
read that list but not add to it. An account gets on it in one of two ways:

- **With the viewer key.** The first time, the page asks for it. An operator makes it in game with
  `/liveview key viewer`; the game shows it once (click to copy). The mod checks what you type and puts the
  account on its list, so it's asked once per account.
- **By name.** An operator runs `/liveview access viewer <email>` (or `/liveview access control <email>`) in game.

`/liveview access` lists who's on it, and `/liveview access remove <email>` takes an account off, disconnecting
it if it's watching.

**Controls** (running commands as the server console from the Console section or the in-view chat with `/`,
moving items in an open chest, and the buttons that change a player: game mode, heal, teleport, kick…) are a
second step: the **Liveview controls** permission here, and the server's say, which is the **control key**
(`/liveview key control`) entered once per account, or `/liveview access control <email>` in game. Even
then controls are off every time the page opens: the button at the top says **Watching only** until you switch it
to **Controls on** (amber), and nothing switches it on for you. Without controls the page can't change anything:
the Worker and the mod both refuse.

- Making a new viewer key empties the server's list: everyone watching is sent back to the key prompt. A new
  control key puts everyone back to watching only. Either way the old key stops working at once.
- `/liveview who` (operators) lists the accounts watching and which have controls on. Every command and item move
  from the dashboard is written to the server log with the account that made it.
- On the server, `liveview=false` in `config/mcstats-chat.properties` turns it all off, and
  `liveview_control=false` turns off only the controls. See [mod/README.md](mod/README.md).

**How the view gets here.** The mod can't be reached from the internet, so, as with web chat, it dials out: one
WebSocket to `/api/ingest/liveview` (same token as chat), opened only while someone watches; the Worker asks for it
over the web chat connection. It lands in a Durable Object, `LiveRelay`, with the pages' own WebSockets
(`/api/liveview/ws`), which passes frames between them (`src/liveview.js`). The game's textures and models (the mod
packs them from Mojang's client jar the first time someone watches) come through the same socket once and are
kept in Cloudflare's cache and the browser after that.

**Cost.** Nothing while nobody watches. While someone does, the relay is awake and the mod sends it one frame every
50 ms for all viewers together (a Durable Object is billed per frame received, 20 frames to a request): about
3,600 requests and 460 GB-seconds per hour of watching, against the free plan's 100,000 requests and 13,000
GB-seconds a day. A page left on another tab of the dashboard lets go of its connection after 30 seconds, and one
in a background browser tab after 2 minutes; both pick it up again when you come back. At most 8 pages can watch
at once.

## Live online list

The charts and totals come from the once-a-minute check (mcstatus.io plus the server mod's list, below). What's online
*right now* is live instead: the online badges, the **Online now** count and the pill at the top (on the Activity page,
and the Chat log's online bar) change within a second or two of someone joining or leaving (`src/presence.js`).

- The server mod sends each join, leave and server start/stop line with the chat log, and its full tab list whenever it
  changes (and every 20 seconds regardless). The Worker hands both to a Durable Object, `Presence`, which pushes the
  result to every open page over a WebSocket (`GET /api/live`, signed in like the rest of `/api/`).
- A join line puts the badge up at once, with the time the player actually joined; a leave line takes it down. The tab
  list is the final word: whatever a line got wrong (one lost or sent late) the next list puts right.
- Hidden players are left out and other accounts are shown as the player they belong to, as everywhere else; the admin
  page's changes reach open pages at once.
- With no list for 75 seconds (the server asleep, the mod not running, or the connection down) a page goes back to the
  minute check's numbers, and keeps trying to reconnect (up to a minute apart). A shutdown shows as *Paused* at once.
- Cost: no database reads per page. The object sleeps between updates and keeps what it knows in its own storage; it reads
  the hidden players and aliases at most every 5 minutes and a newcomer's session start when there's no join line for
  them. A tab in the background lets go of its connection after 15 minutes (whispers reach it until then).
- The same connection also tells pages at once when new chat is logged (they fetch it then, with the 10-second check
  as a fallback), and when the server mod's web chat connection comes up or goes down (the message box says so).

## Whispers

Players typing in the Chat log can whisper with `/w <player> <message>` (or `/msg`, `/tell`, as in game); the box turns to
italics while typing one, and `/` then Tab suggests the command, then the names (in their team colors), the way the game
does. Whispers to you and the ones you send show in your log as the game shows them ("You whisper to …", "… whispers to
you: …"), and only to the two people in each (`src/whisper.js`, table `whispers`).

- To a player in game: through the server mod (1.8.0 or newer), shown to them as `[Web] Name whispers to you: text`.
- To someone not in game who has the dashboard open: straight to their page (this works even when the server is off).
- In game, a `/w` to someone who's only on the dashboard reaches them there instead of "No player was found"; the mod
  knows who's on the dashboard because the `Presence` object sends it the list whenever it changes, and suggests those
  names (marked `<web>`) when you press Tab after `/w` in game. Whispers between two
  players in game are untouched and never recorded.
- A whisper that arrives while you're on another page shows as a note at the bottom of the screen.

## Missed checks (outages)

If a minute's check can't be recorded (the database refusing queries, or the status API and the server mod both
unreachable), that minute is lost: nothing else keeps it. The server mod keeps the chat it couldn't send and sends it
later, though, so once an hour (at :07) the Worker fills such gaps in from the chat log's joins, leaves and server
starts/stops (`src/gapfill.js`): a check for each missing minute with whoever was on, sessions carried across the gap,
and the hourly figures recomputed. It waits until the chat log has caught up past the gap and the gap ended at least
15 minutes before, and looks back 2 days. The admin page's **Fill gaps now** runs it at once.

## Database reads

Cloudflare's free D1 plan allows 5 million rows read a day; past that every query is refused until midnight UTC (the
page then says so). Each open dashboard tab refreshes once a minute, so those queries must read only what changed:
sessions by the `end_ts` index, combat updates by row number, the latest server start/stop by `chat_kind`, and the
season's player total and peak kept for 5 minutes in the `cache` table. A refresh reads under ~100 rows, however long
the season gets.

## Hiding a player

A name in the `hidden_players` table is left out of the Activity and Combat pages as if it had never been on the
server: its playtime, its place in player counts, peaks and lists, its player page, its deaths. It covers everything
already recorded, and nothing more is recorded for it while it's listed. The chat log still shows its messages.
Nothing is deleted, so taking the name off brings back what was recorded before it was added.

The admin page does this, or:

```bash
npx wrangler d1 execute mcstats --remote --command "INSERT OR IGNORE INTO hidden_players (name, note) VALUES ('Name', 'why')"
npx wrangler d1 execute mcstats --remote --command "DELETE FROM hidden_players WHERE name = 'Name'"
```

## Merging a player's accounts

The server runs in offline mode, so a player who changes their name gets a new account (a new UUID). A row in
`player_aliases` merges the other account into the main one everywhere: playtime, player counts and lists, the player
page (both accounts' sessions, chat, gear and advancements), Combat and team colors. Like hidden players it applies to
everything already recorded and nothing is rewritten; delete the row and the accounts show apart again. Chat log
messages still show the name they were sent under (with the main account's team color). Put the main name in the
roster file. The admin page does this, or:

```bash
npx wrangler d1 execute mcstats --remote --command "INSERT OR REPLACE INTO player_aliases (alias, name) VALUES ('OldName', 'MainName')"
npx wrangler d1 execute mcstats --remote --command "DELETE FROM player_aliases WHERE alias = 'OldName'"
```

**Mod and commands** has the mod's download (every jar, starting on the one for the Minecraft version the server
runs), what changed when a newer one is out, and the mod's in-game commands (`src/commands.js`). Each `/mcstats`
command has a switch, saved as it's clicked: one that's off is gone in game for everyone (it doesn't run, and
leaves tab completion, `/mcstats help`, the menus and the list on the Activity page). `/mcstats help` always stays,
and the `/liveview` commands are listed to read. The mod hears at once over its connection, and again every time it
connects; it needs mod 2.4.0, and an older mod keeps every command. The same section decides whether the **In-game
commands** box on the Activity page starts closed (it does unless switched off; its heading opens it).

## Getting the mod

The jars are in `public/downloads/` (kept in git, so a deploy from a push serves them): `mcstats-chat-*.jar` is the
Fabric mod, `mcstats-paper-*.jar` the Paper plugin. People find them at **`/mod`**: first "What does your Minecraft
server run?" (Fabric or Paper, two cards; the pick is remembered in the browser), then that edition's download, what
the server needs (read from the mod itself) and where the key comes from. /new asks the same on its install step and
shows the config file's path for the edition picked. On **Admin → Mod and commands** the edition starts on the one the
server's mod said it is when it last connected (the plugin's User-Agent ends in `Paper`), and update notices (on the page
and in game) offer that edition's jar. `/mod` is linked from the home
page (top bar, the closing section, the footer) and, on a server's page, from **Admin → Mod and commands** (for its admins)
and a small "Server owners: get the mod" link in the footer. Players never need it, and nothing else points them at it.
The Worker serves `/downloads/` itself so it can count jar downloads for the [site analytics](#site-analytics).

## Sign-in

Two things, separately:

- **Looking**: the server's join password, on `/join`, or its **join link** (`src/joinlink.js`). Either gives a
  cookie for that server's pages, good for 30 days or until the owner changes the password. An owner can make a
  server public instead. No account needed. A join link is `/<server>/join/<token>`: opening it sets the cookie and
  goes on to `/<server>`, so the token doesn't stay in the address bar. A server has one link at a time; the token
  is kept as it is (not hashed) in the server's own object so admins can copy it again, and a link that no longer
  works leads to `/join`, which says so.
- **Being someone**: an **mcstats account**, an email address and a password, signed in for the whole site at
  `/account` (**Sign in** at the top of any page leads there). One account is used on every server; what it may do on
  each is that server's own business (Roles, above). Someone who can look at a server becomes a **member** of it by
  choosing to (**Sign in** on its page, then "Continue as…"): it's asked for rather than automatic, because a server's
  owner can see its members' emails. People an owner added by email get in by signing in to an account with that
  address, without the join password.

**Your servers** (`/servers`, `src/myservers.js`): every account has its own list of servers, linked from the top of
the site's pages and from the account menu on a server's page. A server goes on it by itself when you make it, join it
with its password while signed in, or open it as a member; any server you can see can be added with **Add to my
servers** at the top of its page. Each row shows your role there and who's on now (asked of the server's own object,
which says nothing to an account that can no longer see it), and can be dragged to reorder or removed. Removing only
takes it off the list, and it isn't put back by itself afterwards. The list is kept in the directory
(`account_servers`); members from before it existed show up the next time they open their server.

**Sending chat** also needs the email to be linked to a player on Admin → Players, or set to chat as Admin on
Admin → Roles (owners and admins without a player send as Admin anyway); anyone else sees the message box disabled with the reason. Making servers (`/new`) needs an account too.

### Accounts (`src/account.js`, `src/password.js`)

- **Making one** needs a 6-digit code emailed to the address (through Resend; it works once, for 10 minutes, and allows
  5 tries), with a link that carries the same code after the `#` of `/account`, which is never sent to a server. The
  code proves the address is yours; then you choose the password. This matters because access goes by email: an
  account for an address nobody proved would be someone else's access. **Forgot password** is the same thing: a code,
  then a new password, which also signs the account out everywhere.
- **Passwords** are never stored or logged. What's kept is PBKDF2-HMAC-SHA512 with a per-account random salt, 300,000
  iterations in all (three chained calls, because the Workers runtime allows 100,000 per call), then HMAC'd with a key
  derived from `SESSION_SECRET`, so a copy of the database alone isn't enough to start guessing. The parameters are
  written into each hash; a hash made with older ones is replaced at the next sign-in. A password needs 8 to 200
  characters and can't be one of the most common ones or the email itself.
- **Sessions**: the cookie (`__Host-mcs`: HttpOnly, Secure, SameSite=Lax, 30 days) holds a random token and nothing
  else. The directory keeps the token's SHA-256 and which account it is, so nothing in the database can be used as a
  cookie, and a session can be ended from the server: **Sign out** deletes it, **Sign out everywhere** and a new
  password delete them all. (An ended session may still be honoured for up to 10 seconds, the time who's-signed-in is
  remembered in memory.)
- **Guessing** is slowed: a wrong password and an address with no account get the same answer, taking the same time;
  asking for a code says the same thing either way; sign-in tries are limited per email and address (10 in 10
  minutes), per email, and per address. Requests that change anything must come from the site's own pages (Origin and
  `Sec-Fetch-Site` are checked, and only JSON is taken).
- **Changing `SESSION_SECRET`** makes every password stop matching (it's part of the hash) and ends the viewer
  cookies. Everyone gets back in with **Forgot password**; nothing else is lost.
- **Before accounts**, signing in was an emailed code per server. Those cookies (`mcs_id`, `mcs_site`) aren't read any
  more, so everyone who was signed in that way is signed out and makes an account with the same email; their roles
  and servers are still theirs, since those go by email.
- **Later**: signing in with Google or Discord would add a table of (provider, their id for you) → account; an
  account's password is allowed to be empty for that.

Cloudflare Access isn't used any more; the mod's `access_client_id` / `access_client_secret` settings are only for a
dashboard still behind it.

## Site analytics

`/site-analytics` (`src/siteanalytics.js`, `src/census.js`, `public/site-analytics.html` and `.js`) is mcstats' own
dashboard about itself, for the site's operators: the numbers a page-view tool like Google Analytics can't see,
because they live behind sign-in or inside each server's own objects. Nothing on the site links to it.

**Who can see it**: the super admins (`SUPER_ADMIN_EMAIL`), signed in to their mcstats account, and the accounts
they add on the page itself (**Who can see this page**, table `site_viewers`). Viewers can look and press Refresh;
only super admins set baselines or change who's let in. Anyone else gets a plain **Not authorized** page (403, with
a link to sign in when nobody is), its script isn't served and its API says `not authorized`. No server can be called
`site-analytics` (or `siteanalytics`): both are reserved names (`src/directory.js`). With `DEV_NO_AUTH=1` on localhost, `DEV_EMAIL` counts as
signed in, as everywhere else.

**What it shows**, over 30 days, 90 days, a year or all time:

| Section | What | Where it comes from |
| --- | --- | --- |
| Growth | Accounts and servers, total and above your baseline, as charts with the baseline as a dashed line | `accounts.created_at`, `servers.created_at` (whole history); baselines in `site_baselines` |
| People | Devices by day, week and month (signed in, never signed in, opened a dashboard, new), and an estimate of people | `site_counts` from `public/visit.js`; active accounts from `accounts.seen_day` |
| Accounts | Active today, this week, this month; what accounts are across servers (player only, admin only, owner only, mixed, in no server); servers per account; members invited by email with no account yet | the census, matched against `accounts` |
| Servers | From created to active (finished setup, mod connected, active in 30 days, 7 days, 24 hours, players on now); public or private, address set, Discord linked; members and Minecraft players per server; players and chat lines across the site | the census and the directory |
| Mod | Servers with the mod connected now and this week; versions in use (and how many are on the latest); Minecraft versions; downloads by day and by jar | the census (each server's mod connection), `site_counts` |
| Discord bot | Discord servers the bot is in (Discord's own count), how many are linked to a server, feeds switched on, Discord users linked to players | `GET /applications/@me`, `discord_guilds`, the census |
| Trends | Active servers, players this week, accounts active this month, servers with the mod connected, one point a day | `site_snapshots` |

"Active" for a server means the mod uploaded something or a player was seen (by the mod or by pinging its address)
in that time. Weeks run Monday to Sunday and months are calendar months, in UTC, everywhere on the page.

**Baselines**: a number you set for accounts or servers (your own test accounts, what there was at launch…). The
baseline on a day is the latest one from on or before it; one with no date counts from the start. The Growth charts
draw it as a dashed line and can show the totals with it taken off.

**The census**: every server's numbers are in its own Durable Object, so the site's totals are put together by
asking each one (`Tenant.census()`, plus its `ServerLink` for the mod's version and connection), 30 at a time,
oldest first, and keeping each answer in `server_census`. A cron runs it every hour (`17 * * * *`; servers older than
6 hours are asked again), reads the bot's Discord count, and saves the day's totals in `site_snapshots`. **Refresh**
on the page asks every server now; the page asks the stale ones by itself when it opens.

**Privacy**, which is the point of doing it this way:

- **Devices** are counted without being told apart. Each browser keeps, in its own `localStorage` (`mcs_seen`), the
  day, week and month it was last counted (for any page, signed in, and a server's dashboard), and sends those back
  once a day to `POST /api/site/visit`; the Worker adds 1 to each period it's behind on and says what to remember.
  No id, cookie, IP address or user agent is stored, so nobody can be followed from one day to the next. Browsers with
  Do Not Track or Global Privacy Control, and automated ones, aren't counted. Whether a visit was signed in is
  checked from the account cookie, not taken from the browser.
- **People, estimated** = active accounts + devices never signed in ÷ devices per account (signed-in devices ÷ active
  accounts, at least 1). Private windows and cleared storage count as new devices; Do Not Track browsers don't count.
- **Active accounts**: the last UTC day each account used the site (`accounts.seen_day`, a day and not a time),
  updated on the first signed-in request of the day (`src/sitecounts.js`). The days before that were filled in once from the sign-ins
  still on record and the days accounts were made (`directory-migrations/0007_backfill_active_accounts.sql`), so active
  accounts reach back about 30 days further than devices, which can only be counted from the deploy on. The page marks
  periods where device counting began partway through with *, and its tiles say which period each number covers
  (accounts and servers all time; people and devices this month).
- **The census** has no names (of servers, players or members) and no emails: members come as keyed hashes of their
  emails (`emailTag` in `src/session.js`, keyed with `SESSION_SECRET`), matched against the accounts' own when the
  page is drawn and then forgotten.
- **Downloads** of `/downloads/*.jar` count once per address and jar a day (browsers apart from curl, wget and the
  like); the address is only ever a hashed rate-limit key, never stored. Crawlers and resumed downloads aren't counted.

Counting starts when this is deployed: accounts, servers and Discord links have their whole history already, the rest
fills in from then on.

## Local development

```bash
printf 'SESSION_SECRET=local-session-secret-0123456789abcdef\nEMAIL_DEV_LOG=1\nOPS_TOKEN=local-ops-token-0123456789abcdef0123\nCHAT_INGEST_TOKEN=local-dev-token-0123456789abcdef0123456789\n' > .dev.vars
npm run dir:migrate:local
npm run dev               # http://localhost:8787: Create a server; account codes are printed in this terminal
```

`EMAIL_DEV_LOG=1` prints emails instead of sending them. `DEV_NO_AUTH=1` (with an optional `DEV_EMAIL=`) lets
`localhost` into every server without a password or sign-in. To try the stats page with fake data: `npm run
db:migrate:local && npm run seed:local` fills the old single-server database, and `OPS_TOKEN=… JOIN_PASSWORD=… npm run
copy-tenant -- --url http://localhost:8787 --owner you@example.org --local` copies it into a server.

**Liveview locally**: add `ADMIN_EMAIL=` and `SUPER_ADMIN_EMAIL=` with your `DEV_EMAIL` to `.dev.vars`, then run the mod against the local
dashboard: in `mod/run/config/mcstats-chat.properties` set `url=http://localhost:8787/api/ingest/chat` and `token=`
to the `CHAT_INGEST_TOKEN` above, accept the EULA in `mod/run/eula.txt`, and `cd mod && ./gradlew runServer`. Type
`liveview key viewer` in the server console and enter the key on `http://localhost:8787/#/live`. Set
`pause-when-empty-seconds=0` in `mod/run/server.properties`, or the view freezes a minute after the server starts
with nobody on it. `wrangler dev` restarts the Worker whenever a file changes, which drops the view's
connections; the page reconnects by itself.

## Dashboard

- **Header**: S1 / S2 switch between seasons. When the season has a roster, **IGN / Name** switches every player's name
  (leaderboard, online chips, charts' who-was-online, chat, player pages and cards) between their in-game name and their
  real name, with the other one on hover; the choice is remembered in the browser. On the leaderboard, names are in
  their team's color (red or blue), and player pages show the team.

- **Home**: an About header (the server's icon, name and description, once an admin has set one), live status and online players, stat tiles, players online over time, daily activity bars,
  leaderboard (bars in each player's team color), and busiest hours as a week calendar (days across, hours down)
  that can show everyone, one team in its color, or both teams blended by their share. The players online chart adds a 1-hour moving-average trend line
  for ranges over 6 hours, switches to hourly average/peak for longer ranges, and its
  tooltip lists who was online. Its y-axis always reaches at least the most players ever online at once,
  so every range is drawn on the same scale.
- **Player pages**: the name as chat shows it, totals, chat messages sent (total or today), an activity chart (hourly bars
  on a fixed 0–60 min scale for 24h, daily bars for longer ranges) with an Online strip and a Chat strip underneath, when they
  usually play, and recent sessions. The Chat strip has an orange line per message, a red diamond per death and a yellow star
  per advancement; clicking one previews it, with a button to open the chat log there. It opens on the last 24 hours. Player data is fetched when you
  hover a leaderboard row or online chip, so pages usually open instantly; otherwise placeholders show until it loads.

- **Combat** (its own page): every death the mod logs, for the range picked at the top (all time by default; up to two
  days is drawn by the hour, longer by the day).
  - **Red vs Blue**: one bar. Left of the divider is every Blue death: the ones no enemy caused (hatched), Blue's own
    team kills, then Red's kills up to the divider. Right of it, mirrored, every Red death. Each side's kills hang off
    the divider.
  - **Kills and deaths over time**: stacked bars per hour or day (Red kills, Blue kills, other deaths), or running
    totals as lines.
  - **Leaderboard**: kills, deaths and K/D (kills ÷ deaths) for everyone on the roster. Click a heading to sort by it,
    again to reverse; the sorted column is highlighted and the bar under each name follows it. The sort is remembered.
  - **Death log** (beside the page, foldable): every death message, newest at the bottom, as the game worded it, with a bar in
    the killer's faction color; All / PvP / Other filters it, a row's time opens the chat log at that moment, and new
    deaths slide in as they're logged.
  A kill is a death the game credits to another player (being knocked off a cliff counts). Deaths logged before mod
  1.4.0 are worked out from the message itself.
- **Player pages: egg and combat**: an **egg card** (servers with the Egg SMP add-on only: what the player's egg does: passive, primary, secondary
  and their cost, from `public/addons/eggsmp/eggdata.js`, plus its level and energy as the mod last reported them) and a **combat
  card** (kills, deaths, K/D and where that ranks, who they kill most, who kills them most, what else kills them, and
  their latest kills and deaths: like the chat log, the newest at the bottom with its time, a line where the day
  changes, and older ones loading as you scroll up).
  **Show the full in-game description** on the egg card unfolds the egg's item tooltip word for word as the game
  shows it, at the player's level and energy (either level can be looked at). It comes from `public/addons/eggsmp/eggtips.js`,
  which `python3 scripts/egg-tooltips.py [path to the Egg SMP datapack]` writes from the datapack's own tooltip
  reader (`tools/generate_tooltips.py`); run it again when the datapack changes.
- **3D player model**: player pages show the player in 3D with their skin, the armor they last wore (trims, leather dye
  and the enchantment shimmer included), their best weapon in the main hand (mace, then trident, sword, spear, axe,
  pickaxe, shovel; better material first) and, with the Egg SMP add-on, their egg in the off hand (the one they carry, else their roster egg). It turns a
  little toward the mouse. Under it, the weapon's name is in the game's colors with its in-game tooltip on hover, and
  their egg is on the line below. With mod 1.9.0 or newer, each weapon and tool comes with its tooltip, enchantments
  included. Before that, a named item takes its colors and tooltip from the latest death message that named it (their
  own kills first), and other items use their rarity color (aqua when enchanted). The button next to the name lists every weapon and tool they carry; picking one puts it in
  the model's hand. Gear comes from the server mod (1.2.0 or newer); until a player has been on with it, the model
  shows just their skin and roster egg. Armor and item textures are read on demand from Mojang's official game client
  for `MC_VERSION` (in `wrangler.jsonc`; set it to the server's version) by `/api/mc/…`, so none of Mojang's files are in
  this repository; skins come from Mojang through `/api/skin/<name>`. Drawn with three.js, loaded only on player pages.
- **Advancements**: the last card on a player's page is the game's advancements screen for that player: a tab per
  category (Minecraft, Nether, The End, Adventure, Husbandry, plus any a data pack adds) with how many they have, and the
  tree laid out exactly where the game puts each advancement, with the game's frames (gold once earned), connecting
  lines, tab background and inventory-style icons, at twice the game's size. Hover (or tap) one for its title,
  description, and when it was earned or how far along it is; drag or scroll to move around. Every advancement shows,
  earned or not, except hidden ones, which appear once earned as in the game. The tree and progress come from the server
  mod (1.6.0 or newer; the card stays hidden until the mod has sent the tree). Icons are drawn in the browser from the
  game's own item models and textures (`public/mcicons.js`, through `/api/mc/item/<id>.json` and `/api/mc/textures/…`),
  so blocks, chests, skulls and beds look as they do in an inventory.
- **Player cards**: clicking a player's name or head (in the chat log, the online chips, who was online) opens a small card:
  their name as chat shows it, online or last seen, messages and time played today, time played this week, a little
  graph of when they're usually on (the last two weeks, by hour), and a button to their page. The leaderboard still
  opens player pages directly, and ⌘/Ctrl-click opens the page in a new tab.
- **Time ranges**: each chart and the leaderboard has presets, a date picker (custom ranges show a temporary "Custom" option),
  and ‹ › to step back or forward by the current range (charts scroll sideways as they page). Players online
  defaults to the last 24 hours, and stepping back with ‹ pages through whole days (midnight to midnight).
  Its y-axis always reaches at least 10 players, so a quiet range doesn't stretch to fill the chart.
  A step scrolls the chart by exactly the time it moved, with the y-axis held still, also when that's less than a
  whole range (stepping forward to now after scrolling back a little).
  The leaderboard defaults to 1d (today since midnight; ‹ › steps a day at a time), and the other
  charts to the smallest preset that covers all the data so far. Anything before tracking began is hatched out.
- **Pinch to zoom**: on Players online, Daily activity and a player's Activity chart, a trackpad pinch (or Ctrl+scroll,
  or two fingers on a phone) zooms the time range in or out around the point under the fingers, and scrolling
  sideways moves it along.
- **Tooltips**: clicking what a tooltip is for (a bar, a cell, an item named in chat, an advancement) keeps it
  open where it is, so it can be read, scrolled and selected; a click anywhere else, or Escape, closes it.
- **Leaderboard**: keeps the height of the most rows seen for the current range size, so paging doesn't
  shift the page, and rows glide to their new ranks.
- **Live updates**: about 20 seconds after each minute's check, the page refreshes in place (only while the
  tab is visible), with animations that are skipped when the system's reduce-motion setting is on.
- **Chat log**: the server's chat, newest at the bottom, loading older messages as you scroll up and new ones every
  10 seconds. Scrolled back to another day, that day's date floats at the top of the log (the Death log and a
  player's latest kills and deaths do the same). Accounts with the Chat permission can **send chat** from the box under the log, as their linked player or as Admin: it shows in game
  as `[Web] <name> message` (needs mod 1.3.0 and the server online; the box says when it can't send) and comes back into
  the log with a "web" tag. At most one message every 1.5 seconds and 8 per 30 seconds per player, 256 characters each.
  Above it, a players online graph follows the chat. Its cursor marks the time of the bottom message on screen,
  and the graph pages back a day when that time leaves its left edge. Beside it is who was online at that moment.
  Clicking the graph jumps the chat to that time. Names show as they do in game chat, with team prefixes and colors
  (exact on the light page, with a Minecraft-style shadow on pale ones; lightened where needed on the dark page). Deaths and advancements show the whole message in its
  game colors: a killer's name, a named weapon, the advancement's title. Deaths are highlighted in red, as are leaves.
  **Search** (the button at the top, or ⌘F / Ctrl+F on the chat page) finds messages and names as you type; its filters
  narrow it to message text or names only, one player, or one kind of message (chat, deaths, advancements, joins and
  leaves). Picking a result opens the chat there. When the server shuts down (the mod logs "Server stopped"), the status
  at the top says **Paused** until it's back. Chat, deaths and advancements you haven't seen yet are counted in red
  on the Chat log tab and in the page title, and on the jump button while you're scrolled up. The count is remembered in
  the browser, and a "New" line marks where they start when you open the page. Both the graph and the bar of who's online now
  (along the bottom) fold away, and the page remembers that.
- **Liveview** (admins): see [Liveview](#liveview).
- **Theme**: dark by default on every device; the switch at the top picks light or dark and the choice is
  remembered in the browser.
- Times are shown in each server's `TZ_NAME` setting (UTC until it's set).

## Notes

- Who's online comes from two places, merged each minute: the server-list ping (through mcstatus.io), and the server
  mod's list of everyone in the tab list (mod 1.7.0 or newer, sent every 20 seconds and whenever it changes). The ping
  can leave players out: it names at most a sample, and players who turned off "Allow Server Listings" show as
  "Anonymous Player". Each check counts everyone either one names, once. While the mod's list is recent (75 seconds),
  the player count is that union and the server counts as up even if the ping fails; a mod shutdown report marks it
  down. Without a recent list it's the ping alone, as before, and if the server reports more players than it names,
  the dashboard shows a warning.
- Minutes from before mod 1.7.0 where the server counted more players than it named can be filled in from the chat
  log's joins and leaves: `node scripts/backfill-presence.mjs` (a dry run that shows what it would do), then with
  `--apply`. It never names more players at a minute than the server counted then, pairs joins and leaves by name
  (ignoring case), skips hidden players, saves an undo file (`presence-undo-…-backup.sql`) first, and changes nothing
  on a second run.
- Time played is counted in 1-minute steps. A player missing for up to 3.5 minutes stays in the same session.
- Occasionally a check wrongly reports nobody online for a minute. When the same players are seen again within
  3.5 minutes, that empty (or offline) reading is replaced by the number of players whose sessions span it.
  Smaller dips are left alone, since someone may really have relogged.
- Usage on Cloudflare's free tier: about 1,440 Cron runs per day, plus a few D1 rows written per check (1 per player).
  The chat mod adds at most one request every 3 seconds while people are talking (one row per message), and an open
  Chat log page checks for new messages every 10 seconds while it's visible. The Combat page loads the season's deaths
  once, then only what's new each minute. Web chat uses one Durable Object holding
  the mod's WebSocket, which sleeps between messages (it wakes for the mod's ping every 30 seconds, about
  2,900 short wake-ups a day, so a connection lost in a deploy is noticed and remade).
  The live online list uses a second one (`Presence`), woken by the mod's reports (about every 20 seconds while the
  server's up) and holding the pages' WebSockets, which also sleep between updates. Liveview uses a third
  (`LiveRelay`), which only exists while an admin is watching (see [Liveview](#liveview) for what that costs).