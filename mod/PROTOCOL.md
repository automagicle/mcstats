# Liveview protocol

What travels between the server mod and the Liveview tab, and how. The mod's side is
`src/main/java/dev/mcserverstats/liveview` (the messages are built in `hub/Messages.java`, the connection is
`relay/RelayLink.java`); the dashboard's relay is `src/liveview.js`; the page is `public/liveview.js`.

Protocol version: `1`. The mod says it in `hello`; a page that sends a different `protocol` is dropped.

## Transport

The page never talks to the Minecraft server. Three connections are involved:

```
page  ── WebSocket /api/liveview/ws ──►  LiveRelay (a Durable Object)  ◄── WebSocket /api/ingest/liveview ──  mod
page  ── GET /api/liveview/assets/… ──►  Worker ─► LiveRelay ─► (same socket) ─► mod      (cached afterwards)
Worker ── web chat connection (/api/ingest/link) ──► mod      "someone wants to watch", "check this key"
```

- The mod opens its Liveview socket only when asked to over the web chat connection (`{"type":"liveview_open"}`),
  and closes it a minute after the last viewer leaves.
- **Mod → relay**, binary: `0x01`, then for each viewer with something waiting: `u16` viewer number, `u32` length,
  and that many bytes of **frames**. The relay passes each viewer's bytes on as one binary message, untouched.
  One such message goes out at most every 50 ms, for all viewers together.
- A **frame** is `u8` kind, `u32` length (big-endian), payload. Kind `0` is a UTF-8 JSON object with a `type`
  string (everything under "Messages" below); kind `1` is a binary section frame (see Binary section frame).
- **Mod → relay**, binary `0x02`: a piece of an asset: `u32` request id, `u8` flags (1 last piece, 2 no such
  asset), `u16` content type length, content type, bytes.
- **Mod → relay**, text: `ping`; `x{"v":3,"code":"bad_message"}` to drop a viewer (`code`: `bad_message`,
  `oversize`, `protocol_mismatch`, `off`).
- **Relay → mod**, text, told apart by the first character: `o{"v":3,"who":"a@b.c","control":false}` a viewer
  opened the page; `g3` viewer 3 left; `c{"v":3,"on":true}` viewer 3 switched controls on or off;
  `m3 {…}` a message from viewer 3's page, as the page sent it; `a{"id":7,"name":"<sha256>.png"}` an asset
  is wanted; `pong`.
- **Page → relay**, text: JSON messages of at most 8 KiB. `{"type":"arm","on":true}` is answered by the relay
  itself (`{"type":"armed","on","reason"?}`); everything else is passed to the mod.
- **Relay → page**, text: `{"type":"relay","state":"waiting"|"up"}` and `armed`. Close codes: 4400 the mod
  refused a message, 4429 too many pages (8), 4502 the mod's socket ended (server stopped, viewer key replaced,
  Liveview turned off), 4503 the server isn't connected to the dashboard, 4504 it didn't open its socket in time.
- Section payloads are zlib (`java.util.zip.Deflater`); JSON frames are not compressed.

Pages ignore unknown `type` values, and so does the mod (with one log line per type).

## Keys and who may do what

Nothing here is a login: the dashboard has already signed the person in (Cloudflare Access) and checked the
account has its Liveview permission (and, for controls, its Liveview controls permission). On top of that, the
mod keeps its own list of accounts it lets in, and that list is what counts: it is sent to the dashboard as
`access` in `{"type":"liveview","enabled","control","viewer_key","control_key","access":{"a@b.c":"viewer"|"control"}}`
(when the web chat connection opens and whenever anything in it changes), the dashboard never adds to it, and
the mod checks it again itself: a viewer whose account isn't on it is dropped with `x…"code":"denied"` (close
code 4403), and `c` only switches controls on for an account listed as `control`. Accounts get on the list by
entering a key, or by an operator's `/liveview access` command.

- **Watching** needs the viewer key. `POST /api/liveview/unlock {"level":"viewer","key":"…"}` sends the key down
  the web chat connection (`{"type":"liveview_key","id","level","key","who"}`); the mod checks it against the
  hash in `config/mcstats-liveview.json`, puts the account on its list if it's right, sends the new list, and
  answers `{"type":"ack","id","ok","error"?}` with `error` one of `wrong`, `not_set`, `limited` (5 wrong tries a
  minute per account), `off`.
- **Controls** need the control key, entered the same way with `"level":"control"`, and then have to be switched
  on for each connection: the page sends `arm`, the relay checks the account may use controls (both halves), and tells
  the mod with `c`. The mod only then accepts `command` and `container_move` from that viewer, and reports
  `control` in every `status`. A new connection always starts with controls off.

## Status

Sent to each viewer when it connects, every two seconds, and whenever its controls change:

```json
{"type":"status","viewers":1,"droppedDeltas":0,"atlasReady":true,"control":false,"controlAllowed":true,
 "mspt":12.4,"skyDarken":0,"time":6000,"rain":0,"thunder":0,
 "spawn":{"dimension":"minecraft:overworld","x":0,"y":123,"z":0}}
```

`control` is whether this viewer has controls on; `controlAllowed` is whether the server allows them at all
(`liveview_control`). `mspt` is the average tick time in milliseconds, -1 before the first sample. `spawn` is the
world spawn: with nobody online, the page starts its camera above it.

## Controls

Page → mod `{"type":"command","id":7,"command":"tp Steve 0 80 0"}` (a leading `/` is allowed; at most 1024
characters, one line) runs the command as the server console, with every permission, and is answered with
`{"type":"command_result","id":7,"ok":true,"lines":["…"]}`. `ok` is the command's own result; a parse error is
`ok:false` with Minecraft's error lines. With controls off the answer is `"locked":true` and nothing runs. At
most 40 commands in 10 seconds per viewer. Every command is written to the server log with the account.

Moving items in an open container is `container_move` (below), under the same rule.

# Messages

The rest of this file is the standalone Liveview mod's protocol notes, kept because they are still exact about
each message. "Phase 1" to "Phase 4" and "stage 2" to "stage 4" are the steps it was built in.

`hello` is the first message a viewer gets, then `players` (the full list), `entities`, `status`, and `atlas`
once the textures are ready:

```json
{"type":"hello","protocol":1,"serverTime":0,"view":{"cameraChunkRadius":8,"playerChunkRadius":2,"entityRadiusBlocks":64}}
```

## Players

Full snapshot, sent on connect and whenever the set of online uuids changes:

```json
{
  "type": "players",
  "players": [
    {
      "uuid": "00000000-0000-0000-0000-000000000000",
      "name": "Ada",
      "dimension": "minecraft:overworld",
      "x": 0.0,
      "y": 64.0,
      "z": 0.0,
      "yaw": 0.0,
      "pitch": 0.0,
      "health": 20.0,
      "maxHealth": 20.0,
      "hunger": 20,
      "saturation": 5.0,
      "gameMode": "survival",
      "selectedSlot": 0,
      "heldItem": "minecraft:air",
      "armor": ["minecraft:air", "minecraft:air", "minecraft:air", "minecraft:air"]
    }
  ]
}
```

Deltas at the player sample rate, only for uuids whose pose or stats changed:

```json
{
  "type": "player_deltas",
  "players": [
    {
      "uuid": "00000000-0000-0000-0000-000000000000",
      "x": 1.0,
      "z": 2.0,
      "yaw": 90.0
    }
  ]
}
```

Omitted fields keep their previous value. A uuid that disappeared is listed in:

```json
{"type":"player_remove","uuids":["00000000-0000-0000-0000-000000000000"]}
```

Opted-out players are absent. They are not sent as a redacted stub.

`armor` order is boots, leggings, chest, helmet. Phase 0 VERIFIED this against the 26.2 jar: `Inventory.EQUIPMENT_SLOT_MAPPING` puts `FEET` at 36, `LEGS` at 37, `CHEST` at 38, and `HEAD` at 39, so `armor[i]` is inventory slot `36 + i`.

Phase 1 may omit health, hunger, held item, and armor. The page must tolerate missing fields. Phase 2 fills them.

Phase 4 adds two optional fields to `players` and `player_deltas`:

- `skin`: path of the player's skin PNG on this server, shaped `/api/liveview/assets/<sha256>.png`. It is a 64×64 image (a legacy 64×32 skin is widened first). Omitted until the worker has fetched it, and omitted for good when the profile has no skin or the fetch failed. The page then uses the default skin from the atlas meta (`playerSkins`).
- `skinModel`: `"wide"` or `"slim"`, from the profile's `textures` metadata. Omitted when unknown.

The raw profile `textures` property is never sent.

## Inventory

Client subscribes:

```json
{"type":"subscribe_inventory","uuid":"00000000-0000-0000-0000-000000000000"}
```

```json
{"type":"unsubscribe_inventory","uuid":"00000000-0000-0000-0000-000000000000"}
```

One subscribed uuid per viewer in Phase 2. A new subscribe replaces the old one.

Server, full snapshot then diffs:

```json
{
  "type": "inventory",
  "uuid": "00000000-0000-0000-0000-000000000000",
  "slots": [
    {"slot": 0, "item": "minecraft:stone", "count": 64, "customName": "Lucky block"}
  ]
}
```

```json
{
  "type": "inventory_delta",
  "uuid": "00000000-0000-0000-0000-000000000000",
  "slots": [
    {"slot": 3, "item": "minecraft:air", "count": 0}
  ]
}
```

Slot indexes match the server inventory’s own indexes, including armor and offhand. Phase 0 read the 26.2 layout from `Inventory`: hotbar 0–8, main 9–35, boots 36, leggings 37, chest 38, helmet 39, offhand 40, body armor 41, saddle 42. The container size is 43. The ender chest follows in the same list as slots 100–126 (`Player.getEnderChestInventory()`, 27 slots), so the existing `inventory_delta` diff covers it. The page uses this table.

`customName` is omitted when the stack has no custom name. Enchantments and durability are still absent.

An opted-out or offline uuid gets:

```json
{"type":"inventory","uuid":"...","slots":[],"unavailable":true}
```

## Action feed

```json
{
  "type": "action",
  "id": 1,
  "time": 0,
  "kind": "block_break",
  "actor": "00000000-0000-0000-0000-000000000000",
  "dimension": "minecraft:overworld",
  "x": 0,
  "y": 64,
  "z": 0,
  "target": "minecraft:stone",
  "message": ""
}
```

`kind` is one of: `block_break`, `block_place`, `attack`, `item_use`, `chat`, `death`, `join`, `leave`, `dimension_change`, `system_message`.

Nullable fields are JSON `null`, not omitted, so the page can tell “no position” from “delta.” `actor` is null for `system_message`. `message` is the visible text for `chat`, `death`, and `system_message`, and an empty string otherwise.

The server assigns `id` from a monotonic counter per server start. The page dedupes on `id`.

## Entities

Phase 3. Full set when a viewer connects, then deltas.

```json
{
  "type": "entities",
  "entities": [
    {
      "id": 12,
      "uuid": "00000000-0000-0000-0000-000000000000",
      "type": "minecraft:zombie",
      "dimension": "minecraft:overworld",
      "x": 0.0,
      "y": 64.0,
      "z": 0.0,
      "yaw": 0.0,
      "pitch": 0.0,
      "health": 20.0
    }
  ]
}
```

```json
{
  "type": "entity_deltas",
  "entities": [
    {"id": 12, "x": 0.5, "z": 0.25, "yaw": 10.0}
  ],
  "removed": [9]
}
```

Players are not included. `health` is null for non-living entities. `uuid` is null when the entity has none.

Phase 4 adds `width` and `height` (the entity's bounding box in blocks) to each entry in `entities`, and to `entity_deltas` entries when they change. The page sizes the fallback textured box with them.

Interest is server-side. The client does not send an entity radius. The server uses `view.entity-radius-blocks` and the cameras it already knows.

Under load the server skips a tick of entity sampling (10 Hz becomes 5 Hz) rather than growing the queue. It sets `"throttled": true` on the next `entity_deltas`.

## Camera

Phase 4. Client to server, about 5 Hz, and immediately on dimension change:

```json
{
  "type": "camera",
  "dimension": "minecraft:overworld",
  "x": 0.0,
  "y": 80.0,
  "z": 0.0,
  "yaw": 0.0,
  "pitch": 0.0
}
```

The server clamps the position to loaded chunks inside the configured radius of this pose. It does not load chunks from disk to satisfy a camera. Unloaded sections are absent. The page keeps the last mesh it had and shows a gap.

Phase 4 server rules: `dimension` must match `namespace:path` (lowercase, at most 64 + 128 characters), `x` and `z` must be finite with magnitude at most 30,000,000, and `y` finite with magnitude at most 4096. Anything else is `bad_message` and closes the socket. Poses for the same dimension closer than 100 ms to the last accepted one are ignored. A pose in a new dimension is always accepted and resets that viewer's window. `yaw` and `pitch` are optional and unused by the server. The pose also feeds the entity interest set from the Entities section.

The window is the loaded chunk columns within `view.camera-chunk-radius` of the camera (a disc, `dx² + dz² ≤ r² + r`) and `r` sections above and below the camera's section, plus, for each visible player in that dimension, the loaded columns within `view.player-chunk-radius` of them from two sections below to one section above their feet.

Server acknowledgement when the window changes, not on every pose:

```json
{
  "type": "window",
  "dimension": "minecraft:overworld",
  "add": [{"cx": 0, "cz": 0, "sy": 4}],
  "remove": [{"cx": 1, "cz": -1, "sy": 4}]
}
```

`cx` and `cz` are chunk coordinates. `sy` is the section index (block y / 16). Each `add` is followed by one binary section frame. `remove` drops the mesh.

A section the page already has can also receive a fresh kind `1` frame with no `add` when its blocks changed. The page replaces the mesh. If a frame was dropped under backpressure, the server forgets that it sent the section and adds it again later, so an `add` for a section the page already holds is harmless.

The textures are fetched and packed when the first viewer arrives, so `atlas` can come a few seconds after `hello`. If the asset build fails (no client jar, hash mismatch, unreadable jar), the server sends this once per viewer instead of `atlas`, and no section frames follow. Players and entities keep streaming:

```json
{"type":"assets_error","message":"client jar hash mismatch for https://...: expected ..., got ..."}
```

## Atlas

Phase 4. Announced on the WebSocket, downloaded over HTTP:

```json
{
  "type": "atlas",
  "url": "/api/liveview/assets/<sha256>.png",
  "meta": "/api/liveview/assets/<sha256>.json",
  "size": 1024
}
```

The meta JSON:

```json
{
  "size": 2048,
  "textures": {
    "minecraft:block/stone": {"u": 0, "v": 0, "w": 16, "h": 16},
    "minecraft:block/lava_still": {"u": 16, "v": 0, "w": 16, "h": 16}
  },
  "animations": [
    {
      "texture": "minecraft:block/lava_still",
      "frametime": 2,
      "frames": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      "frameCount": 20,
      "frameHeight": 16
    }
  ],
  "translucent": ["minecraft:block/water_still"],
  "entities": {"minecraft:zombie": "minecraft:entity/zombie/zombie"},
  "playerSkins": {"wide": "minecraft:entity/player/wide/steve", "slim": "minecraft:entity/player/slim/alex"}
}
```

`u`, `v`, `w`, `h` are pixels in the atlas. The browser converts to UVs. Every rect starts on a 16-pixel grid and owns the 16-pixel cells it covers, so the page can map any atlas pixel back to its rect. For an animation, `u`, `v`, `w`, `h` is frame 0 and the other frames follow below it as a vertical strip.

Phase 4 changed `frames` from a count to an array, because 26.2's `lava_still.png.mcmeta` lists an explicit frame order. `frames` is the playback order: one entry per step, each an index into the strip (an `.mcmeta` entry with its own `time` is repeated so every step lasts `frametime` ticks). `frameCount` is the number of frames in the strip and `frameHeight` the height of one. The page copies frame `frames[floor(tick / frametime) % frames.length]` over frame 0. `interpolate` is ignored.

`translucent` lists textures with partially transparent pixels, plus textures a model marks `force_translucent`. Quads using them are blended. Other quads are alpha-tested at 0.5.

`entities` maps an entity type id to the texture used for its fallback box. `playerSkins` names the default skins.

Item icons use the same atlas and the same meta. The inventory UI looks up `minecraft:item/<path>` first and `minecraft:block/<path>` second.

A new hash replaces the atlas. The page drops the old texture after the new one loads.

## Binary section frame

Phase 4 fills any UNVERIFIED width after it has seen a real section. The outer layout is fixed:

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | uint8 | kind, always `1` for a section mesh |
| 1 | uint8 | flags, bit 0 set when the payload after the dimension string is zlib-wrapped |
| 2 | int32 big-endian | chunk x |
| 6 | int32 big-endian | chunk z |
| 10 | int32 big-endian | section y |
| 14 | uint16 big-endian | dimension id length, then that many UTF-8 bytes |

After the dimension string, if flag bit 0 is set, the remainder is a zlib stream. Inflated, the mesh is:

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | uint32 big-endian | vertex count |
| 4 | vertex count times 8 floats | x, y, z, u, v, r, g, b per vertex, big-endian IEEE-754 |

Positions are in block space relative to the section origin (0..16 on each axis). `u` and `v` are atlas UVs in the 0..1 range. `r`, `g`, `b` are biome tint multipliers in 0..1. Uncolored faces use `1, 1, 1`.

Quads are four vertices. `vertex count` is a multiple of 4. An empty section is vertex count 0 and is still sent so the page can clear a hole.

Phase 4 details:

- Each quad's vertices are counter-clockwise seen from the side the face points to, so normal back-face culling applies. Triangles are (0, 1, 2) and (0, 2, 3).
- Greedy-merged quads cover several blocks with one texture. Their UVs keep counting past the tile: a quad 3 blocks wide spans 3 tile widths in `u`. Vertex 0 always sits on the tile's own (u0, v0) corner. The page wraps each fragment back into the tile: it finds the rect that owns vertex 0's UV (nudged half a pixel toward the fragment) and samples `rect.xy + mod(pixel - rect.xy, rect.wh)`. Non-greedy quads stay inside their rect, where the wrap changes nothing.
- `r`, `g`, `b` carry only the biome or block tint. The page applies its own fixed face shading.
- The blockstate string form above is confirmed for 26.2 (`BlockStateParser.serialize`).
- Phase 4 implements only kind `1`. A changed section, greedy or not, is resent as a whole kind `1`. Kind `2` is not sent.

Block deltas for a section the viewer already has use kind `2`:

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | uint8 | kind `2` |
| 1 | uint8 | flags, same compression bit |
| 2 | int32 big-endian | chunk x |
| 6 | int32 big-endian | chunk z |
| 10 | int32 big-endian | section y |
| 14 | uint16 big-endian | dimension id length, then that many UTF-8 bytes |

Inflated body: uint16 count, then that many records of uint8 x, uint8 y, uint8 z (0..15 inside the section) and a uint16 index into a string table that follows the records. Each string is a uint16 length plus UTF-8. The string is the blockstate id, shaped like `minecraft:oak_stairs[facing=east,half=bottom]`. Phase 4 confirms that form against the 26.2 jar, records the method it used in `docs/DESIGN.md`, and if no stable string exists switches this paragraph to a numeric id plus a `blockstate_map` JSON message in the same change.

Kind `2` is valid only for a section that was not greedy-meshed. If a greedy section’s faces change, the server sends a fresh kind `1`. The page replaces its mesh on kind `1`. Phase 4 states which path it implemented and does not leave both half-done.

## Ordering and backpressure

- `hello` before any other server message.
- `atlas` before any section frame. If the atlas is not ready, player messages still flow and no section frame is sent.
- Per viewer, one outbound queue. If it exceeds 256 pending messages, drop pending `player_deltas` and `entity_deltas` first, then pending kind `2` frames, and keep `hello`, `players`, `action`, and kind `1`. If kind `1` frames alone exceed the cap, drop the oldest kind `1` and resend the current window when the queue shrinks.
- The server thread never waits for this queue.
- Phase 4: the server keeps at most 48 section copies in flight and 64 kind `1` frames queued per viewer, so terrain cannot fill the 256-message queue on its own. When the queue is full, a pending delta is dropped first, then the oldest kind `1` frame (that section is re-queued and resent with a new `add`), then the oldest message.

## Page behavior that is part of the protocol

- Treat positions as absolute world coordinates in the dimension named on the message. Switching dimension clears meshes.
- Render players and entities even when no mesh exists yet (Phase 1 through Phase 3).
- Sample the atlas with nearest-neighbor filtering.
- The server ignores unknown `type` values. It drops a page that sends `protocol` other than `1`.

## Rendering additions (stage 2, 10 November 2026)

Section frames (kind 1):

- Flag bit 4 (`FLAG_LITTLE_ENDIAN_VERTICES`) means the vertex floats are little-endian, so the page views them as a `Float32Array` in place. The header and the counts stay big-endian.
- Flag bit 2 (`FLAG_LIT`) means each vertex is 10 floats, `x y z u v r g b sky block`, with sky and block light from 0 to 15 after smooth lighting. Ambient occlusion is already multiplied into `r g b`. Without the bit, vertices are 8 floats and fully lit.
- After the vertices: a big-endian `uint32` emitter count, then 4 bytes per emitter (`x y z` inside the section, then the kind). The kinds are: 1 torch, 2 soul torch, 3 fire, 4 soul fire, 5 lit campfire, 6 lava source with air above, 7 nether portal, 8 end rod, 9 lit candle, 10 lit furnace, blast furnace or smoker. These are the blocks whose particles vanilla makes only on the client; the page animates them.
- After the emitters: a big-endian `uint32` chest count, then 5 bytes per chest (`x y z` inside the section, kind, light as `sky << 4 | block`). Kind is `1 + variant * 12 + type * 4 + facing`: variant 0 chest, 1 trapped chest, 2 ender chest, 3–6 copper chest (plain, exposed, weathered, oxidized; waxed counts as unwaxed); type 0 single, 1 left half, 2 right half; facing 0 north, 1 south, 2 west, 3 east. Chests have no block model, so the page builds them from the chest model layers.
- Fluids are drawn the way `LiquidBlockRenderer` draws them: corner heights from the four surrounding columns, a flowing texture turned to the flow direction, and both windings.

Atlas meta gains `particles` (particle type → frame texture keys, from `assets/*/particles/*.json`), `babyEntities` (type → baby texture key), and `models` (the URL of the entity models file, if extraction worked).

The entity models file is `{"layers":{"<ns:id#layer>":{"tw","th","root":part}},"entities":{"<type>":{"main","baby"?,"overlays"?[]}},"player":{"wide","slim"}}`. A part is `{"pose":[x,y,z,xRot,yRot,zRot,xScale,yScale,zScale],"cubes":[[ox,oy,oz,dx,dy,dz,u,v,growX,growY,growZ,mirror,texScaleU,texScaleV,faceMask]],"children":{name:part}}`. The face mask bits are down 1, up 2, north 4, south 8, west 16, east 32.

Entity samples gain `baby` (boolean), `headYaw` (degrees), and `item` (the item id of a dropped item). For living mobs, `yaw` is now the body yaw (`LivingEntity.yBodyRot`).

Server → page `{"type":"particles","p":[[type,x,y,z,count,dx,dy,dz,speed,block|null,color]]}` carries the particles broadcast in one tick within 64 blocks of this viewer's camera. These messages are droppable. A `count` of 0 is one particle moving at `(dx,dy,dz)*speed`; otherwise there are `count` particles offset by gaussian `(dx,dy,dz)`, each with gaussian `speed` velocity. Type `liveview:block_break` is vanilla level event 2001, with `block` set to the broken block. Effects vanilla sends outside the particle packet are copied too: `liveview:explosion` (from `ServerLevel.explode`; `speed` is the power and `count` is 1 when blocks break), `liveview:poof` (entity event 60, a mob's death; `dx` and `dy` are its width and height) and `liveview:item_break` (entity event 3, a snowball or egg breaking; `block` is the item).

The `status` message (see Status) carries `skyDarken` (the overworld's `Level.getSkyDarken()`, 0 at noon to 11 at midnight), `time` (`Level.getOverworldClockTime()`, ticks; -1 if unknown), `rain` and `thunder` (0 to 1). The page runs the clock on between messages and draws the sun, moon phase, stars, clouds, rain and lightning from them; `skyDarken` is the fallback when `time` is missing.

### Looks (stage 3, 10 November 2026)

Entity samples and player samples carry `"look":{"light","texture"?,"model"?,"variant"?,"wool","armor":[4],"dye":[4],"main","off","cape"?}`, sent in full whenever any field changes:

- `light`: sky light × 16 + block light, at the entity's block. The page tints the model with the same lightmap as the terrain.
- `texture`: the exact texture id of a data-driven variant (wolf, cat, pig, cow, chicken, frog), already picked for baby, tame and so on.
- `model`: the variant's model type (`normal`, `cold`, `warm`).
- `variant`: the serialized name of an enum variant (fox, rabbit, parrot, llama, axolotl, horse, mooshroom).
- `wool`: sheep wool color as 0xRRGGBB, -2 when sheared, -1 otherwise.
- `armor` and `dye`: equipment asset ids for head, chest, legs and feet (`""` for none), and the dyed color per slot (-1 when undyed).
- `main` and `off`: the held item ids.
- `cape`: the hashed cape asset path, for players only.

The models file adds `variants` (climate → layer, for example `cold_pig#main`), `armor` (the `#helmet`, `#chestplate`, `#leggings` and `#boots` layers per mob), and on `player`: `cape`, `wideArmor` and `slimArmor`. The atlas meta adds `equipment`, an object of the form `{asset:{kind:[[textureKey, undyedColor|null]]}}`, read from `assets/*/equipment/*.json`.

### Items, containers, motion (stage 4, 10 November 2026)

- Section frame flag bit 8 (`FLAG_SHADED`): vanilla face shading and each element's `shade` flag are already in the vertex color; models with `"ambientocclusion": false` (cross plants) get flat light and no occlusion. The page must not shade again.
- Atlas meta gains `files`: `{name: url}` for `items` (resolved item models, see `ItemModels.java`), the glint textures, the default font and its glyph table, the tooltip sprites and the container screens.
- Inventory slots gain `foil`, `color` (dye or potion tint), `damage`/`maxDamage`, `tooltip` (lines of `[text, rgb|-1, flags]` exactly as `ItemStack.getTooltipLines` builds them) and `contents` (shulker box, chest item or bundle contents).
- Page → server `{"type":"open_container","dimension","x","y","z"}` and `{"type":"close_container"}`; server → page `{"type":"container",...,"kind","title","rows","slots","missing"}`, resent whenever the contents change (checked every 10 ticks).
- Page → server `{"type":"container_move","id","dimension","x","y","z","player","from":"c"|"p","fromSlot","to":"c"|"p","toSlot","amount"}` moves items in the open container (`c`) or between it and an online player's main inventory (`p`, slots 0–35). `toSlot` -1 is a shift-click into the other side; `amount` 0 is the whole stack (swapping if the target holds something else), 1 one item, 2 half. Each move is one atomic step on the server thread, needs controls on (see Controls), and is written to the server log with the account that made it. Server → page `{"type":"container_result","id","ok","message","locked"?}`; `locked` means controls are off.
- Chunks around each viewer's camera now simulate (`FLAG_SIMULATION`), so mobs there move; mobs within 128 blocks of a camera do not despawn for lack of a nearby player while a page is open.
- `look` gains `foil` (bits: head 1, chest 2, legs 4, feet 8, main 16, off 32; on projectiles 64 is a crit arrow and 128 a dangerous wither skull, and a tipped arrow's `mainTint` is its potion color), `mainTint`, `offTint` and `motion` `{pose, sprint, swing, swingOff, using, useOff, hurt, riding, radius?}`.
- Particles gain `liveview:potion_splash` and `liveview:instant_splash` (level events 2002 and 2007, `color` is the potion color); item particles carry the item id in `block`.
- Each viewer's camera holds a chunk ticket of the game's own `ender_pearl` type (camera radius, at most 12; 2 s timeout, refreshed twice a second), so the server loads and generates the chunks the camera flies to.
