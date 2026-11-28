package dev.mcserverstats.chatlog;

import java.nio.file.Path;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import dev.mcserverstats.liveview.LiveSettings;
import dev.mcserverstats.liveview.LiveviewMod;
import dev.mcserverstats.liveview.relay.RelayLink;
import com.mojang.brigadier.CommandDispatcher;
import dev.mcserverstats.compat.Platform;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.network.chat.Style;
import net.minecraft.network.chat.TextColor;
import net.minecraft.network.chat.contents.TranslatableContents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
//#if MC >= 26.2
import net.minecraft.world.entity.EntityTypes;
//#else
//$$ import net.minecraft.world.entity.EntityType;
//#endif
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.TooltipFlag;
import net.minecraft.world.scores.PlayerTeam;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

// Records public chat (plus joins, leaves, deaths and advancements) and hands it to the
// uploader, which sends it to the dashboard in the background. Private messages
// (/msg, /tell, /teammsg) are never recorded. Also reports what each player is wearing and
// carrying (GearReporter) and their advancements (AdvancementReporter), for their dashboard page,
// shows chat sent from the dashboard in game (WebChatLink), and reports who's online (OnlineReporter).
//
// Nothing here knows which loader it runs on: the Fabric mod (dev.mcserverstats.fabric.FabricEntry) and the
// Paper plugin (dev.mcserverstats.paper.PaperPlugin) each make one of these and call its methods from their
// own events, in the order each method's comment gives.
public final class ChatLogMod {
	public static final Logger LOG = LoggerFactory.getLogger("mcstats-chat");

	// Player names (Java, or Bedrock through Floodgate's "." prefix); mobs' insertions are UUIDs.
	private static final Pattern PLAYER_NAME = Pattern.compile("[A-Za-z0-9_.]{1,20}");

	private final Path dir;
	private final Uploader uploader;
	private final WebChatLink link;
	private final LiveviewMod liveview;
	private final OnlineReporter online;
	private final GearReporter gear;
	private final McstatsMenus menus;
	private final AdvancementReporter advancements;
	private volatile MinecraftServer server;
	private static volatile MinecraftServer current; // the same, for the static helpers
	private static volatile ChatLogMod instance; // for the whisper and system-message hooks
	// "msg Name text", "tell Name text" or "w Name text", as the command arrives (no slash)
	private static final Pattern WHISPER_COMMAND = Pattern.compile("(?i)/?(?:msg|tell|w)\\s+([A-Za-z0-9_.]{1,20})\\s+(\\S.*)", Pattern.DOTALL);
	// set while this mod posts a web message itself, so the system-message logger doesn't log it again
	private boolean postingWeb;

	// dir: the folder the mod's files go in (config/ on Fabric, plugins/mcstats/ on Paper). version: this mod's.
	// minecraft: the game's, which goes in the User-Agent too (2.3.0), so the dashboard can offer the jar built
	// for it; so does the platform when it isn't Fabric ("… (Minecraft 26.2) Paper"), for the same reason.
	public ChatLogMod(Path dir, String version, String minecraft) {
		this.dir = dir;
		String agent = "mcstats-chat/" + version + " (Minecraft " + minecraft + ")"
				+ (Platform.name().equals("Fabric") ? "" : " " + Platform.name());
		uploader = new Uploader(dir.resolve("mcstats-chat.properties"), dir.resolve("mcstats-chat-pending.json"), version);
		link = new WebChatLink(uploader::config, uploader::linkDownFor, agent, new WebChatLink.Handler() {
			@Override
			public CompletableFuture<String> say(String name, String text, java.util.function.BooleanSupplier claim) {
				return webMessage(name, text, claim);
			}

			@Override
			public CompletableFuture<String> sayFromDiscord(String name, String text, boolean guest, java.util.function.BooleanSupplier claim) {
				return discordMessage(name, text, guest, claim);
			}

			@Override
			public CompletableFuture<String> whisper(String from, String to, String text, java.util.function.BooleanSupplier claim) {
				return webWhisper(from, to, text, claim);
			}

			@Override
			public void update(JsonObject m) {
				newUpdate(m);
			}

			@Override
			public void commands(java.util.List<String> off) {
				McstatsCommands.setOff(off, server);
			}
		});
		instance = this;

		// Liveview (dev.mcserverstats.liveview): the dashboard's admins watching the world. It has its own
		// connection for the view, opened only while someone watches; what it needs from this side is the
		// settings, where the dashboard is, and the web chat connection for the handshake.
		liveview = new LiveviewMod(
				() -> {
					Config c = uploader.config();
					// the dashboard asks for the view over the web chat connection, so without it nobody could
					return c.ready() && c.webChat() ? c.liveview() : LiveSettings.DEFAULT.off();
				},
				() -> relayTarget(uploader.config(), agent),
				() -> link.sendLiveInfo());
		link.live(new WebChatLink.Live() {
			@Override
			public String info() {
				return liveview.info();
			}

			@Override
			public void open() {
				liveview.requestRelay();
			}

			@Override
			public void verify(String level, String key, String who, java.util.function.BiConsumer<String, String> done) {
				liveview.verify(level, key, who, r -> done.accept(r.ok() ? null : r.error(), r.keyId()));
			}
		});

		online = new OnlineReporter(uploader);
		// /mcstats: menus for stats, and for players to choose how they look on the dashboard (sent with the gear)
		ProfileStore profiles = new ProfileStore(dir.resolve("mcstats-profiles.json"));
		gear = new GearReporter(uploader, profiles);
		// players connect their mcstats account in game (2.3.0), to chat as themselves from the website
		McstatsCommands.load(dir.resolve("mcstats-commands-off.txt")); // the ones switched off on the dashboard (2.4.0)
		menus = new McstatsMenus(profiles, link::page, new Accounts(link));
		advancements = new AdvancementReporter(uploader);
	}

	public LiveviewMod liveview() {
		return liveview;
	}

	/* ---------- what the entry points call ---------- */

	// Before the worlds load (Fabric SERVER_STARTING; Paper: onEnable).
	public void starting(MinecraftServer s) {
		liveview.starting(s);
	}

	// Once the server is up (Fabric SERVER_STARTED; Paper: its first tick).
	public void started(MinecraftServer s) {
		liveview.started(s, dir);
		this.server = s;
		current = s;
		uploader.start();
		uploader.add("server", null, null, null, null, "Server started");
		link.start();
		advancements.sendTree(s);
	}

	// When it starts to stop (Fabric SERVER_STOPPING; Paper: onDisable).
	public void stopping(MinecraftServer s) {
		liveview.stopping(s);
		link.stop();
		uploader.add("server", null, null, null, null, "Server stopped");
		online.stopping(s);
	}

	// Once it has stopped (Fabric SERVER_STOPPED; Paper: onDisable, after stopping).
	public void stopped(MinecraftServer s) {
		uploader.stop();
		this.server = null;
		current = null;
	}

	// The commands are being built (at start and on /reload).
	public void registerCommands(CommandDispatcher<CommandSourceStack> dispatcher) {
		liveview.registerCommands(dispatcher);
		McstatsCommands.register(dispatcher, menus);
	}

	// A player joined: operators hear about a newer mod each time they join (UpdateNotice).
	public void joined(ServerPlayer player) {
		tellUpdate(player);
	}

	// The end of every server tick.
	public void tick(MinecraftServer s) {
		liveview.tick(s);
		online.tick(s);
		gear.tick(s);
		ChestGui.runQueued(s);
		advancements.tick(s);
		logSentToEveryone(s);
	}

	// Data packs were reloaded (/reload), which can change the advancements.
	public void dataPacksReloaded(MinecraftServer s) {
		advancements.sendTree(s);
	}

	// A player's chat message. name: their name as chat shows it (team prefix, colors, click-to-insert).
	public void chat(ServerPlayer sender, Component name, String text) {
		recentChat(sender.getScoreboardName(), text);
		uploader.add("chat", sender.getUUID(), sender.getScoreboardName(), styled(name, 8), null, text);
	}

	// /say ("say") and /me ("emote"). Other command messages (like /teammsg) only go to some players, so they're
	// not passed here. player: who ran it, if a player did; who: the source's name (Server, a command block's).
	public void sayCommand(String kind, ServerPlayer player, String who, Component name, String text) {
		recentChat(who, text);
		uploader.add(kind, player == null ? null : player.getUUID(), who, styled(name, 8), null, text);
	}

	// A system message broadcast to everyone (joins, leaves, deaths, advancements, …).
	public void gameMessage(MinecraftServer s, Component message, boolean overlay) {
		if (overlay) return;
		broadcastThisTick.add(message.getString()); // so playerMessage doesn't log it a second time
		recent(message.getString());
		if (!postingWeb && uploader.systemMessages()) systemMessage(s, message, null, null);
	}

	// The same for a message the platform says is a join, leave, death or advancement (Paper's events), so it's
	// logged as that kind about that player even when a plugin has worded it its own way.
	public void announced(MinecraftServer s, Component message, String kind, ServerPlayer about) {
		recent(message.getString());
		if (uploader.systemMessages()) systemMessage(s, message, kind, about);
	}

	/* ---------- messages players were sent one by one, as seen on the network (Paper) ---------- */

	// Texts this mod sent itself or logged already in the last few seconds, so a copy seen going out to each
	// player isn't logged again; and chat lines (name, text), which a chat plugin may send on as system messages
	// ("<Name> text"). Only the Paper plugin reads these; Fabric sees its own sends on the server thread.
	private static final java.util.Map<String, Long> RECENT = new java.util.concurrent.ConcurrentHashMap<>();
	private static final java.util.Map<java.util.Map.Entry<String, String>, Long> RECENT_CHAT = new java.util.concurrent.ConcurrentHashMap<>();
	private static final long RECENT_NANOS = 5_000_000_000L;

	private static <K> void remember(java.util.Map<K, Long> map, K key) {
		long now = System.nanoTime();
		if (map.size() > 500) map.values().removeIf(t -> now - t > RECENT_NANOS);
		map.put(key, now);
	}

	private static void recent(String text) {
		if (text != null && !text.isBlank()) remember(RECENT, text);
	}

	private static void recentChat(String name, String text) {
		if (name != null && text != null && !text.isBlank()) remember(RECENT_CHAT, java.util.Map.entry(name, text));
	}

	// Whether `text` is one of those: this mod's own, already logged, or a chat line passed on.
	public static boolean recentlySeen(String text) {
		long now = System.nanoTime();
		Long at = RECENT.get(text);
		if (at != null && now - at <= RECENT_NANOS) return true;
		for (java.util.Map.Entry<java.util.Map.Entry<String, String>, Long> e : RECENT_CHAT.entrySet()) {
			if (now - e.getValue() <= RECENT_NANOS && text.contains(e.getKey().getKey()) && text.contains(e.getKey().getValue())) return true;
		}
		return false;
	}

	// A system message every player on got, one by one: logged as a server message (unless system messages are off).
	public void sentToEveryone(MinecraftServer s, Component message) {
		if (uploader.systemMessages()) systemMessage(s, message, null, null);
	}

	// Where Liveview connects: /api/ingest/liveview next to the chat url, with the same token. Null until
	// the mod is set up.
	private static RelayLink.Target relayTarget(Config c, String userAgent) {
		if (!c.ready()) return null;
		try {
			java.net.URI uri = java.net.URI.create(c.url().replaceFirst("/chat/?$", "/liveview").replaceFirst("^http", "ws"));
			return new RelayLink.Target(uri, c.token(), c.accessClientId(), c.accessClientSecret(), userAgent);
		} catch (IllegalArgumentException e) {
			return null;
		}
	}

	// A message sent from the dashboard by a roster player: shown to everyone as "[Web] <name> text",
	// the name in their team's colors, and logged as their chat (marked as from the web). An admin's
	// (name null) shows as "[Web] [Admin] text" with the tag in yellow. Runs on the server thread;
	// the answer is "" when it was shown.
	// `claim` says whether it's still wanted: false once the wait for the server thread ran out and the
	// sender was told it wasn't shown, so it mustn't turn up afterwards.
	private CompletableFuture<String> webMessage(String name, String text, java.util.function.BooleanSupplier claim) {
		MinecraftServer s = server;
		if (s == null) return CompletableFuture.completedFuture("the server is starting or stopping");
		CompletableFuture<String> done = new CompletableFuture<>();
		s.execute(() -> {
			if (!claim.getAsBoolean()) return;
			try {
				Component who;
				MutableComponent line = Component.empty().append(Component.literal("[Web] ").withStyle(ChatFormatting.GRAY));
				if (name == null) {
					who = Component.literal("[Admin]").withStyle(ChatFormatting.YELLOW);
					line.append(who).append(" ").append(Component.literal(text));
				} else {
					who = PlayerTeam.formatNameForTeam(teamOf(s, name), Component.literal(name).withStyle(st -> st.withInsertion(name)));
					line.append(Component.translatable("chat.type.text", who, Component.literal(text)));
				}
				postingWeb = true;
				recent(line.getString());
				try {
					s.getPlayerList().broadcastSystemMessage(line, false);
				} finally {
					postingWeb = false;
				}
				if (name == null) {
					uploader.add("chat", null, null, styled(who, 8), null, text, "admin");
				} else {
					ServerPlayer online = s.getPlayerList().getPlayerByName(name);
					uploader.add("chat", online == null ? null : online.getUUID(), name, styled(who, 8), null, text, "web");
				}
				uploader.flushSoon();
				done.complete("");
			} catch (RuntimeException e) {
				LOG.error("Couldn't show a web chat message", e);
				done.complete("the server couldn't show it");
			}
		});
		return done;
	}

	// Discord's blurple, for the [Discord] tag.
	private static final TextColor DISCORD = TextColor.fromRgb(0x5865F2);

	// A message sent from Discord with /say (2.4.0): "[Discord] <name> text". A linked player's name is in their
	// team's colors and logged as their chat, like one from the dashboard; a guest's (someone on Discord who isn't
	// linked to a player) is grey, italic and ends in *, and is logged under no player, so it can't pass for one.
	// Logged with via "discord", so the dashboard doesn't post it back to Discord.
	private CompletableFuture<String> discordMessage(String name, String text, boolean guest, java.util.function.BooleanSupplier claim) {
		MinecraftServer s = server;
		if (s == null) return CompletableFuture.completedFuture("the server is starting or stopping");
		CompletableFuture<String> done = new CompletableFuture<>();
		s.execute(() -> {
			if (!claim.getAsBoolean()) return;
			try {
				Component who = guest
						? Component.literal(name + "*").withStyle(ChatFormatting.GRAY, ChatFormatting.ITALIC)
						: PlayerTeam.formatNameForTeam(teamOf(s, name), Component.literal(name).withStyle(st -> st.withInsertion(name)));
				MutableComponent line = Component.empty()
						.append(Component.literal("[Discord] ").withStyle(st -> st.withColor(DISCORD)))
						.append(Component.translatable("chat.type.text", who, Component.literal(text)));
				postingWeb = true;
				recent(line.getString());
				try {
					s.getPlayerList().broadcastSystemMessage(line, false);
				} finally {
					postingWeb = false;
				}
				ServerPlayer online = guest ? null : s.getPlayerList().getPlayerByName(name);
				uploader.add("chat", online == null ? null : online.getUUID(), guest ? null : name, styled(who, 8), null, text, "discord");
				uploader.flushSoon();
				done.complete("");
			} catch (RuntimeException e) {
				LOG.error("Couldn't show a message from Discord", e);
				done.complete("the server couldn't show it");
			}
		});
		return done;
	}

	// A whisper typed on the dashboard, shown only to `to` (if they're on) the way the game shows one,
	// with a [Web] tag: "[Web] Name whispers to you: text", the name in their team's colors (an admin's,
	// from null, as a yellow [Admin]). Never logged. Runs on the server thread; "" when it was shown.
	private CompletableFuture<String> webWhisper(String from, String to, String text, java.util.function.BooleanSupplier claim) {
		MinecraftServer s = server;
		if (s == null) return CompletableFuture.completedFuture("the server is starting or stopping");
		CompletableFuture<String> done = new CompletableFuture<>();
		s.execute(() -> {
			if (!claim.getAsBoolean()) return;
			try {
				ServerPlayer target = s.getPlayerList().getPlayerByName(to);
				if (target == null) {
					done.complete("No player was found");
					return;
				}
				Component line = webTag().append(Component.translatable("commands.message.display.incoming",
						from == null ? Component.literal("[Admin]").withStyle(ChatFormatting.YELLOW) : teamName(s, from), Component.literal(text))
						.withStyle(ChatFormatting.GRAY, ChatFormatting.ITALIC));
				unlogged(line, () -> target.sendSystemMessage(line));
				done.complete("");
			} catch (RuntimeException e) {
				LOG.error("Couldn't show a web whisper", e);
				done.complete("the server couldn't show it");
			}
		});
		return done;
	}

	// A newer version of this mod, as the dashboard last said (2.1.0); null while this one is the newest.
	private volatile JsonObject update;

	// The dashboard says there's a newer mod. It says so on every reconnect, so the server log and the
	// operators online now only hear about it when it's news; operators who join later hear each time.
	private void newUpdate(JsonObject m) {
		JsonObject old = update;
		update = m;
		if (old != null && old.equals(m)) return;
		String latest = str(m, "latest");
		boolean urgent = m.has("urgent") && m.get("urgent").getAsBoolean();
		if (urgent) LOG.warn("An urgent mcstats update is out: {} (this server runs {}). Download it from the dashboard: {}", latest, str(m, "current"), jarUrl(m));
		else LOG.info("A newer mcstats is out: {} (this server runs {}). Download it from the dashboard: {}", latest, str(m, "current"), jarUrl(m));
		MinecraftServer s = server;
		if (s != null) s.execute(() -> {
			for (ServerPlayer p : s.getPlayerList().getPlayers()) tellUpdate(p);
		});
	}

	// Tells an operator (permission level 3, like /liveview key) about the newer mod, if there is one.
	private void tellUpdate(ServerPlayer p) {
		JsonObject m = update;
		if (m == null || !dev.mcserverstats.compat.Compat.admins().test(p.createCommandSourceStack())) return;
		boolean urgent = m.has("urgent") && m.get("urgent").getAsBoolean();
		ChatFormatting tone = urgent ? ChatFormatting.RED : ChatFormatting.YELLOW;
		MutableComponent msg = Component.empty()
				.append(Component.literal("[mcstats] ").withStyle(ChatFormatting.GRAY))
				.append(Component.literal(urgent ? "Urgent update: " : "Update available: ").withStyle(tone, ChatFormatting.BOLD))
				.append(Component.literal(WebChatLink.clean(str(m, "current")) + " → " + WebChatLink.clean(str(m, "latest"))).withStyle(tone));
		for (String why : strings(m, "urgent_why")) {
			msg.append(Component.literal("\n  ! " + why).withStyle(ChatFormatting.RED));
		}
		for (String change : strings(m, "changes")) {
			msg.append(Component.literal("\n  - " + change).withStyle(ChatFormatting.GRAY));
		}
		int more = m.has("more") ? m.get("more").getAsInt() : 0;
		if (more > 0) msg.append(Component.literal("\n  …and " + more + " more").withStyle(ChatFormatting.DARK_GRAY));
		msg.append(Component.literal("\n  "));
		String jar = jarUrl(m);
		if (jar != null) {
			msg.append(Component.literal("[Download " + WebChatLink.clean(str(m, "latest")) + "]")
					.withStyle(st -> st.withColor(ChatFormatting.AQUA).withUnderlined(true).withClickEvent(dev.mcserverstats.compat.Compat.openUrl(java.net.URI.create(jar)))));
			msg.append(Component.literal(" ").withStyle(ChatFormatting.GRAY));
		}
		msg.append(Component.literal("swap the jar in " + Platform.jarFolder() + " and restart. The whole changelog is on the dashboard's Admin page.").withStyle(ChatFormatting.GRAY));
		unlogged(msg, () -> p.sendSystemMessage(msg));
	}

	private static String str(JsonObject m, String key) {
		return m.has(key) && m.get(key).isJsonPrimitive() ? m.get(key).getAsString() : "?";
	}

	private static java.util.List<String> strings(JsonObject m, String key) {
		java.util.List<String> out = new java.util.ArrayList<>();
		if (m.has(key) && m.get(key).isJsonArray()) {
			for (var e : m.getAsJsonArray(key)) {
				if (e.isJsonPrimitive() && out.size() < 12) out.add(WebChatLink.clean(e.getAsString()));
			}
		}
		return out;
	}

	// The jar's address on the dashboard: its path from the message, on the host of the chat url.
	private String jarUrl(JsonObject m) {
		String path = m.has("jar") ? m.get("jar").getAsString() : "";
		if (!path.matches("/downloads/[A-Za-z0-9._+-]+\\.jar")) return null;
		try {
			java.net.URI u = java.net.URI.create(uploader.config().url());
			if (u.getScheme() == null || u.getHost() == null) return null;
			return new java.net.URI(u.getScheme(), null, u.getHost(), u.getPort(), path, null, null).toString();
		} catch (Exception e) {
			return null;
		}
	}

	// Sends something of this mod's own (a whisper, say) without the chat log picking it up.
	private void unlogged(Component message, Runnable send) {
		recent(message.getString());
		boolean was = postingWeb;
		postingWeb = true;
		try {
			send.run();
		} finally {
			postingWeb = was;
		}
	}

	private static MutableComponent webTag() {
		return Component.empty().append(Component.literal("[Web] ").withStyle(ChatFormatting.GRAY));
	}

	private static MutableComponent teamName(MinecraftServer s, String name) {
		return PlayerTeam.formatNameForTeam(teamOf(s, name), Component.literal(name).withStyle(st -> st.withInsertion(name)));
	}

	// Roster players with the dashboard open who aren't in game: who /msg can suggest, besides the game's own.
	static java.util.List<String> webOnlyPlayers() {
		ChatLogMod mod = instance;
		MinecraftServer s = current;
		if (mod == null || s == null) return java.util.List.of();
		java.util.List<String> out = new java.util.ArrayList<>();
		for (String name : mod.link.webPlayers()) if (s.getPlayerList().getPlayerByName(name) == null) out.add(name);
		out.sort(String.CASE_INSENSITIVE_ORDER);
		return out;
	}

	// Called by CommandsMixin before any command runs: a whisper (/msg, /tell, /w) to a player who isn't
	// in game but has the dashboard open goes to them there instead of failing with "No player was
	// found". The sender sees it the way the game shows one sent, with a [Web] tag. True if it was
	// handled (the command doesn't run); anything else, including whispers between players in game,
	// runs as usual and isn't recorded.
	public static boolean whisperToWeb(CommandSourceStack source, String command) {
		ChatLogMod mod = instance;
		MinecraftServer s = current;
		if (mod == null || s == null || command == null) return false;
		var m = WHISPER_COMMAND.matcher(command.strip());
		if (!m.matches()) return false;
		String to = m.group(1);
		if (s.getPlayerList().getPlayerByName(to) != null) return false; // in game: the game's own whisper
		String webName = mod.link.webPlayer(to);
		if (webName == null) return false;
		ServerPlayer player = source.getPlayer();
		String from = player != null ? player.getScoreboardName() : null;
		if (from == null) return false; // the console and command blocks whisper as usual
		String text = WebChatLink.clean(m.group(2));
		if (text.isEmpty()) return false;
		boolean sent = mod.link.whisperUp(from, webName, text, why -> s.execute(() -> {
			ServerPlayer p = s.getPlayerList().getPlayer(player.getUUID());
			if (p == null) return;
			Component failed = webTag().append(Component.literal("Couldn't reach " + webName + " on the website: " + why).withStyle(ChatFormatting.RED));
			mod.unlogged(failed, () -> p.sendSystemMessage(failed));
		}));
		if (!sent) return false;
		Component outgoing = webTag().append(Component.translatable("commands.message.display.outgoing", teamName(s, webName), Component.literal(text))
				.withStyle(ChatFormatting.GRAY, ChatFormatting.ITALIC));
		mod.unlogged(outgoing, () -> source.sendSystemMessage(outgoing));
		return true;
	}

	// System messages sent to players one at a time this tick: text -> who got it. Some mods announce
	// things to everyone that way (a combat logger's location, say) rather than as a broadcast.
	private static final class Sent {
		final Component message;
		final java.util.Set<UUID> to = new java.util.HashSet<>();
		boolean onlyOneOnline; // sent while one player was on: public unless it answers something they did
		boolean answer;

		Sent(Component message) {
			this.message = message;
		}
	}

	private final java.util.Map<String, Sent> sentThisTick = new java.util.LinkedHashMap<>();
	private final java.util.Set<String> broadcastThisTick = new java.util.HashSet<>();

	// Called by ServerPlayerMixin for every system message a player is sent (on the server thread).
	public static void playerMessage(ServerPlayer player, Component message, boolean overlay) {
		ChatLogMod mod = instance;
		MinecraftServer s = current;
		if (mod == null || s == null || overlay || mod.postingWeb || !s.isSameThread() || !mod.uploader.systemMessages()) return;
		if (mod.sentThisTick.size() >= 200) return;
		String text = message.getString();
		if (text.isBlank() || text.length() > 1000) return;
		Sent sent = mod.sentThisTick.get(text);
		if (sent == null) {
			sent = new Sent(message);
			mod.sentThisTick.put(text, sent);
			// With one player on, "sent to everyone" and "sent to them" look the same. It counts as an
			// answer to them (not logged) when it comes out of a command, or out of handling something
			// they did other than a player leaving.
			if (s.getPlayerList().getPlayerCount() <= 1) {
				sent.onlyOneOnline = true;
				sent.answer = StackWalker.getInstance().walk(frames -> frames.limit(80).anyMatch(f -> {
					String c = f.getClassName();
					return c.startsWith("com.mojang.brigadier.")
							|| (c.endsWith("ServerGamePacketListenerImpl") && !f.getMethodName().toLowerCase().contains("disconnect"));
				}));
			}
		}
		sent.to.add(player.getUUID());
	}

	// At the end of each tick: whatever was sent to every player on (and wasn't a broadcast, which is
	// logged already) goes in the chat log as a server message.
	private void logSentToEveryone(MinecraftServer server) {
		if (sentThisTick.isEmpty()) {
			broadcastThisTick.clear();
			return;
		}
		try {
			java.util.List<ServerPlayer> online = server.getPlayerList().getPlayers();
			for (java.util.Map.Entry<String, Sent> e : sentThisTick.entrySet()) {
				Sent sent = e.getValue();
				if (broadcastThisTick.contains(e.getKey())) continue;
				boolean everyone = sent.to.size() >= 2 && online.stream().allMatch(p -> sent.to.contains(p.getUUID()));
				if (everyone || (sent.onlyOneOnline && !sent.answer)) systemMessage(server, sent.message, null, null);
			}
		} finally {
			sentThisTick.clear();
			broadcastThisTick.clear();
		}
	}

	// A player's team by name, whatever capitals the name was given in (teams hold names exactly).
	private static PlayerTeam teamOf(MinecraftServer s, String name) {
		PlayerTeam team = s.getScoreboard().getPlayersTeam(name);
		if (team != null) return team;
		for (PlayerTeam t : s.getScoreboard().getPlayerTeams()) {
			for (String member : t.getPlayers()) if (member.equalsIgnoreCase(name)) return t;
		}
		return null;
	}

	// Broadcast server messages, sorted by their translation key. The first argument of a
	// join/leave/death/advancement message is the player it's about. forced and about, when given (Paper's join,
	// leave, death and advancement events), say what it is and who it's about whatever its wording.
	private void systemMessage(MinecraftServer server, Component message, String forced, ServerPlayer about) {
		String kind = "system";
		String name = null;
		JsonArray display = null;
		JsonObject death = null;
		if (message.getContents() instanceof TranslatableContents tc) {
			String key = tc.getKey();
			if (key.startsWith("multiplayer.player.joined")) kind = "join";
			else if (key.equals("multiplayer.player.left")) kind = "leave";
			else if (key.startsWith("death.")) kind = "death";
			else if (key.startsWith("chat.type.advancement.")) kind = "advancement";
			Object[] args = tc.getArgs();
			if (!kind.equals("system") && args.length > 0 && args[0] instanceof Component who) {
				name = plainName(who);
				display = styled(who, 8);
			}
			if (kind.equals("death")) death = deathDetails(key, args);
		}
		if (forced != null && about != null && (!kind.equals(forced) || name == null)) {
			kind = forced;
			name = about.getScoreboardName();
			display = styled(about.getDisplayName(), 8);
		}
		UUID uuid = null;
		if (name != null) {
			// exactly that name first: the game's own lookup ignores case, and on an offline-mode server
			// "Name" and "name" are different accounts (both can be on, e.g. while one reconnects)
			ServerPlayer player = null;
			for (ServerPlayer p : server.getPlayerList().getPlayers()) {
				if (p.getScoreboardName().equals(name)) { player = p; break; }
			}
			if (player == null) player = server.getPlayerList().getPlayerByName(name);
			if (player != null) uuid = player.getUUID();
		}
		// The whole message too, so other names in it (a killer) and item names keep their colors.
		uploader.add(kind, uuid, name, display, kind.equals("system") ? null : styled(message, 32), message.getString(), null, death);
	}

	// How a death happened, from the death message itself, for the dashboard's combat page:
	// { cause, killer?, killer_uuid?, mob?, weapon? }. cause is the message's translation key
	// (death.attack.player.item, death.fell.accident.generic, …). The second argument of a death
	// message is who the game credits with it: a player (killer, killer_uuid) or another creature
	// (mob, its entity type, like "zombie"). The third is the named item it was done with.
	private static JsonObject deathDetails(String key, Object[] args) {
		JsonObject d = new JsonObject();
		d.addProperty("cause", key);
		if (args.length > 1 && args[1] instanceof Component by) {
			HoverEvent.EntityTooltipInfo info = entityOf(by);
			//#if MC >= 26.2
			if (info != null && info.type == EntityTypes.PLAYER) {
			//#else
			//$$ if (info != null && info.type == EntityType.PLAYER) {
			//#endif
				d.addProperty("killer", plainName(by));
				d.addProperty("killer_uuid", dev.mcserverstats.compat.Compat.uuid(info).toString());
			} else if (info != null) {
				String type = BuiltInRegistries.ENTITY_TYPE.getKey(info.type).toString();
				d.addProperty("mob", type.startsWith("minecraft:") ? type.substring(10) : type);
			}
		}
		if (args.length > 2 && args[2] instanceof Component item) {
			String weapon = item.getString().replaceAll("^\\[|\\]$", "");
			if (!weapon.isBlank()) d.addProperty("weapon", weapon.length() > 60 ? weapon.substring(0, 60) : weapon);
		}
		return d;
	}

	// The entity a name in a message stands for (names carry it as their hover text).
	private static HoverEvent.EntityTooltipInfo entityOf(Component c) {
		return c.visit((style, text) -> Optional.ofNullable(dev.mcserverstats.compat.Compat.hoverEntity(style)), Style.EMPTY).orElse(null);
	}

	// Text as chat shows it (team prefixes, colors), as [{ t: text, c: "#rrggbb", p: player }] pieces.
	// p marks pieces of a player's name (its click-to-insert text), so the dashboard can link it.
	static JsonArray styled(Component c, int max) {
		JsonArray out = new JsonArray();
		HoverEvent[] seen = new HoverEvent[1];
		c.visit((style, text) -> {
			if (!text.isEmpty() && out.size() < max) {
				JsonObject piece = new JsonObject();
				piece.addProperty("t", text);
				TextColor color = style.getColor();
				if (color != null) piece.addProperty("c", String.format("#%06x", color.getValue() & 0xFFFFFF));
				String who = style.getInsertion();
				if (who != null && PLAYER_NAME.matcher(who).matches()) piece.addProperty("p", who);
				// An item's name (the weapon in a death message): marked, and the first piece of it
				// carries what hovering over it shows in game.
				ItemStack shown = dev.mcserverstats.compat.Compat.hoverItem(style);
				if (shown != null) {
					piece.addProperty("w", true);
					if (seen[0] != style.getHoverEvent()) {
						seen[0] = style.getHoverEvent();
						JsonArray lines = hoverTooltip(shown);
						if (lines != null) piece.add("i", lines);
					}
				}
				out.add(piece);
			}
			return Optional.empty();
		}, Style.EMPTY);
		return out.isEmpty() ? null : out;
	}

	// An item's tooltip as the game shows it (name, enchantments, attributes, lore): a list of
	// lines, each a list of { t, c?, i? (italic) } pieces. An empty list is a blank line.
	private static JsonArray hoverTooltip(ItemStack shown) {
		try {
			return tooltip(shown);
		} catch (RuntimeException e) {
			LOG.debug("Couldn't read an item's tooltip", e);
			return null;
		}
	}

	// The same for an item in hand (GearReporter: the weapons and tools a player carries).
	static JsonArray tooltip(ItemStack stack) {
		try {
			MinecraftServer s = current;
			Item.TooltipContext context = s == null ? Item.TooltipContext.EMPTY : Item.TooltipContext.of(s.registryAccess());
			JsonArray lines = new JsonArray();
			for (Component line : stack.getTooltipLines(context, null, TooltipFlag.NORMAL)) {
				if (lines.size() >= 24) break;
				JsonArray pieces = new JsonArray();
				line.visit((style, text) -> {
					if (!text.isEmpty() && pieces.size() < 8) {
						JsonObject piece = new JsonObject();
						piece.addProperty("t", text.length() > 120 ? text.substring(0, 120) : text);
						TextColor color = style.getColor();
						if (color != null) piece.addProperty("c", String.format("#%06x", color.getValue() & 0xFFFFFF));
						if (style.isItalic()) piece.addProperty("i", true);
						pieces.add(piece);
					}
					return Optional.empty();
				}, Style.EMPTY);
				lines.add(pieces);
			}
			return lines.isEmpty() ? null : lines;
		} catch (RuntimeException e) {
			LOG.debug("Couldn't read an item's tooltip", e);
			return null;
		}
	}

	// A player's display name can carry a team prefix; its click-to-insert text is the bare name.
	private static String plainName(Component c) {
		String insertion = c.getStyle().getInsertion();
		return insertion != null && !insertion.isEmpty() ? insertion : c.getString();
	}
}
