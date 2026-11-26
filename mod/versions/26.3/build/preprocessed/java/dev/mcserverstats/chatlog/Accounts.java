package dev.mcserverstats.chatlog;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import com.google.gson.JsonObject;

import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

// Players connecting their mcstats account (2.3.0): /mcstats connect, or Connect Account in the /mcstats menu,
// opens an anvil (AccountPrompt) to type an email in. The dashboard keeps it as a request and emails the
// address; once someone signed in to mcstats with that email says yes above the Chat log's message box, they
// chat from the website as this player. The dashboard decides all of it (src/connect.js); this side asks and
// passes the answers on in chat. Everything goes over the web chat connection (WebChatLink.account).
final class Accounts {
	// What the dashboard last said a player has: their email (null: none) and whether it's been confirmed.
	record Status(String email, boolean confirmed) {
	}

	private final WebChatLink link;
	private final Map<UUID, Status> known = new ConcurrentHashMap<>();

	Accounts(WebChatLink link) {
		this.link = link;
	}

	// What's known for the player, or null when the dashboard hasn't said yet.
	Status known(UUID player) {
		return known.get(player);
	}

	// Asks the dashboard again, for the next time the menu is drawn.
	void refresh(ServerPlayer player) {
		UUID uuid = player.getUUID();
		link.account("status", uuid, player.getScoreboardName(), null, a -> {
			if (ok(a)) known.put(uuid, new Status(string(a, "email"), a.has("confirmed") && a.get("confirmed").getAsBoolean()));
		});
	}

	// The anvil, with what they have now to edit.
	void prompt(ServerPlayer player) {
		Status s = known.get(player.getUUID());
		AccountPrompt.open(player, s == null ? null : s.email(), email -> connect(player, email));
	}

	void connect(ServerPlayer player, String email) {
		if (!AccountPrompt.isEmail(email)) {
			McstatsMenus.say(player, Component.literal(email + " isn't an email address.").withStyle(ChatFormatting.RED));
			return;
		}
		MinecraftServer server = player.level().getServer();
		UUID uuid = player.getUUID();
		McstatsMenus.say(player, Component.literal("Connecting " + email + "...").withStyle(ChatFormatting.GRAY));
		link.account("connect", uuid, player.getScoreboardName(), email, a -> server.execute(() -> {
			ServerPlayer p = server.getPlayerList().getPlayer(uuid);
			if (p == null) return;
			if (!ok(a)) {
				McstatsMenus.say(p, Component.literal("Couldn't connect your account: " + error(a)).withStyle(ChatFormatting.RED));
				return;
			}
			known.put(uuid, new Status(email, false));
			McstatsMenus.say(p, Component.literal("Almost done! ").withStyle(ChatFormatting.GREEN, ChatFormatting.BOLD)
					.append(Component.literal("Sign in to mcstats as " + email + " and click Connect above the chat box to say it's you."
							+ (a.has("emailed") && a.get("emailed").getAsBoolean() ? " We emailed you a link." : "")).withStyle(ChatFormatting.GREEN)));
			String page = string(a, "page");
			if (page != null) {
				try {
					java.net.URI uri = java.net.URI.create(page);
					McstatsMenus.say(p, Component.literal("Open the chat: ").withStyle(ChatFormatting.GRAY)
							.append(Component.literal(page).withStyle(s -> s.withColor(ChatFormatting.AQUA).withUnderlined(true)
									.withClickEvent(dev.mcserverstats.compat.Compat.openUrl(uri))
									.withHoverEvent(dev.mcserverstats.compat.Compat.showText(Component.literal("Click to open in your browser"))))));
				} catch (IllegalArgumentException ignored) { }
			}
		}));
	}

	void disconnect(ServerPlayer player) {
		MinecraftServer server = player.level().getServer();
		UUID uuid = player.getUUID();
		link.account("disconnect", uuid, player.getScoreboardName(), null, a -> server.execute(() -> {
			ServerPlayer p = server.getPlayerList().getPlayer(uuid);
			if (p == null) return;
			if (!ok(a)) {
				McstatsMenus.say(p, Component.literal("Couldn't disconnect your account: " + error(a)).withStyle(ChatFormatting.RED));
				return;
			}
			known.put(uuid, new Status(null, false));
			String had = string(a, "had");
			McstatsMenus.say(p, had == null ? "No mcstats account was connected." : "Disconnected " + had + ". It can't chat as you on the website any more.");
		}));
	}

	private static boolean ok(JsonObject a) {
		return a.has("ok") && a.get("ok").getAsBoolean();
	}

	private static String error(JsonObject a) {
		String e = string(a, "error");
		return e == null ? "the website said no" : e;
	}

	private static String string(JsonObject a, String key) {
		return a.has(key) && a.get(key).isJsonPrimitive() ? a.get(key).getAsString() : null;
	}
}
