package dev.mcserverstats.chatlog;

import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

import dev.mcserverstats.liveview.LiveSettings;

// config/mcstats-chat.properties. Created with blank values on first start; edits are
// picked up within a few seconds, without a restart.
record Config(String url, String token, String accessClientId, String accessClientSecret, boolean systemMessages, boolean webChat,
		LiveSettings liveview) {
	static final Config EMPTY = new Config("", "", "", "", true, true, LiveSettings.DEFAULT);

	private static final String TEMPLATE = """
			# mcstats chat log: sends this server's public chat to your mcstats dashboard.
			# Saved changes are picked up within a few seconds; no restart needed.

			# Your dashboard's address followed by /api/ingest/chat,
			# e.g. https://mcstats.example.workers.dev/api/ingest/chat
			url=

			# This server's key, from the dashboard's setup page (/new, "Connect the mod"). It starts with mcs_
			# and is shown once; making a new one there stops the old one at once.
			token=

			# Only if the dashboard sits behind Cloudflare Access: a service token, so the request gets past
			# the login page (Zero Trust > Access > Service credentials > Service tokens). Otherwise leave blank.
			access_client_id=
			access_client_secret=

			# Also log joins, leaves, deaths and advancements.
			system_messages=true

			# Show chat sent from the dashboard in game, as "[Web] <name> message". Only players whose
			# login email is on the dashboard's roster can send.
			web_chat=true

			# Liveview: lets the dashboard's admins watch the world from its Liveview tab. Nobody can watch until
			# an operator makes the viewer key in game (/liveview key viewer) and an admin enters it on the
			# dashboard. Needs web_chat=true (that connection is how the dashboard asks for the view).
			liveview=true

			# Also let admins who entered the control key (/liveview key control) run commands as the server
			# console and move items in containers, from the dashboard.
			liveview_control=true

			# How much of the world a viewer is sent: chunks around the camera (2-12), chunks kept ready around
			# each player (0-4), and how far from a player or camera mobs are sent, in blocks (0-128).
			liveview_camera_chunks=8
			liveview_player_chunks=2
			liveview_entity_blocks=64

			# A Minecraft client jar to read the game's textures from. Leave blank to download the official one
			# for this version from Mojang the first time someone watches (kept in config/mcstats-liveview-cache).
			liveview_client_jar=
			""";

	boolean ready() {
		return !url.isEmpty() && !token.isEmpty();
	}

	static Config load(Path file) throws IOException {
		if (!Files.exists(file)) {
			Files.createDirectories(file.getParent());
			Files.writeString(file, TEMPLATE, StandardCharsets.UTF_8);
			ChatLogMod.LOG.warn("Created {}. Fill in url and token to start sending chat.", file);
		}
		// Files saved by some web panels and Windows editors start with a byte-order mark,
		// which would otherwise become part of the first key.
		String text = Files.readString(file, StandardCharsets.UTF_8);
		if (text.startsWith("\uFEFF")) text = text.substring(1);
		Properties p = new Properties();
		p.load(new StringReader(text));
		return new Config(
				get(p, "url"), get(p, "token"), get(p, "access_client_id"), get(p, "access_client_secret"),
				!get(p, "system_messages").equalsIgnoreCase("false"),
				!get(p, "web_chat").equalsIgnoreCase("false"),
				new LiveSettings(
						!get(p, "liveview").equalsIgnoreCase("false"),
						!get(p, "liveview_control").equalsIgnoreCase("false"),
						LiveSettings.number(get(p, "liveview_camera_chunks")),
						LiveSettings.number(get(p, "liveview_player_chunks")),
						LiveSettings.number(get(p, "liveview_entity_blocks")),
						-1,
						get(p, "liveview_client_jar")));
	}

	private static String get(Properties p, String key) {
		return p.getProperty(key, "").trim();
	}
}
