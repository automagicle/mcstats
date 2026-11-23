// Written by scripts/mod-info.mjs from mod/ — don't edit; run `node scripts/mod-info.mjs`.
export const MOD = {
  "id": "mcstats_chat",
  "name": "mcstats",
  "version": "2.0.0",
  "jar": "mcstats-chat-2.0.0.jar",
  "environment": "server",
  "minecraft": "~26.2",
  "minecraft_built": "26.2",
  "loader": ">=0.18.4",
  "loader_built": "0.20.1",
  "java": ">=25",
  "fabric_api": {
    "version": "0.161.0+26.2",
    "bundled": true,
    "modules": [
      "fabric-api-base",
      "fabric-message-api-v1",
      "fabric-lifecycle-events-v1",
      "fabric-command-api-v2",
      "fabric-entity-events-v1",
      "fabric-events-interaction-v0",
      "fabric-networking-api-v1"
    ]
  },
  "other_depends": {},
  "config_file": "config/mcstats-chat.properties",
  "config_template": "# mcstats chat log: sends this server's public chat to your mcstats dashboard.\n# Saved changes are picked up within a few seconds; no restart needed.\n\n# Your dashboard's address followed by /api/ingest/chat,\n# e.g. https://mcstats.example.workers.dev/api/ingest/chat\nurl=\n\n# This server's key, from the dashboard's setup page (/new, \"Connect the mod\"). It starts with mcs_\n# and is shown once; making a new one there stops the old one at once.\ntoken=\n\n# Only if the dashboard sits behind Cloudflare Access: a service token, so the request gets past\n# the login page (Zero Trust > Access > Service credentials > Service tokens). Otherwise leave blank.\naccess_client_id=\naccess_client_secret=\n\n# Also log joins, leaves, deaths and advancements.\nsystem_messages=true\n\n# Show chat sent from the dashboard in game, as \"[Web] <name> message\". Only players whose\n# login email is on the dashboard's roster can send.\nweb_chat=true\n\n# Liveview: lets the dashboard's admins watch the world from its Liveview tab. Nobody can watch until\n# an operator makes the viewer key in game (/liveview key viewer) and an admin enters it on the\n# dashboard. Needs web_chat=true (that connection is how the dashboard asks for the view).\nliveview=true\n\n# Also let admins who entered the control key (/liveview key control) run commands as the server\n# console and move items in containers, from the dashboard.\nliveview_control=true\n\n# How much of the world a viewer is sent: chunks around the camera (2-12), chunks kept ready around\n# each player (0-4), and how far from a player or camera mobs are sent, in blocks (0-128).\nliveview_camera_chunks=8\nliveview_player_chunks=2\nliveview_entity_blocks=64\n\n# A Minecraft client jar to read the game's textures from. Leave blank to download the official one\n# for this version from Mojang the first time someone watches (kept in config/mcstats-liveview-cache).\nliveview_client_jar=\n"
};
