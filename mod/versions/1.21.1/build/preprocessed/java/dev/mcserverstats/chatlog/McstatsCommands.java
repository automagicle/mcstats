package dev.mcserverstats.chatlog;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collection;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;

import dev.mcserverstats.chatlog.PlayerRecords.Entry;
import dev.mcserverstats.chatlog.PlayerRecords.Sort;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

// /mcstats: menus for players to see stats and choose how they look on the dashboard (McstatsMenus).
//   /mcstats, /mcstats view        the main menu
//   /mcstats profile               Your Profile: what you hold and your particles on the website
//   /mcstats stats [player]        every player's head, or one player's stats
//   /mcstats top                   leaderboards
//   /mcstats link [player]         a link to your (or their) page on the website
//   /mcstats connect [email]       connect your mcstats account (an anvil to type it in, without one)
//   /mcstats disconnect            stop it chatting as you on the website
//   /mcstats particle <name|none>  set your particles without the menu
//   /mcstats reset                 back to the automatic look
//   /mcstats help                  this list
// Everything here is open to every player; nothing changes the world.
//
// The dashboard's admins can switch any of them off but help (2.4.0; Admin, Mod and commands): the dashboard
// sends the ids that are off over the web chat connection (WebChatLink), and such a command is then gone for
// everyone: it doesn't run, tab completion and /mcstats help leave it out, and the menus lose its button.
// The list is kept in config/mcstats-commands-off.txt, so it still holds after a restart, before the
// dashboard has been heard from.
final class McstatsCommands {
	private McstatsCommands() {
	}

	private static McstatsMenus menus;

	// Also listed on the dashboard's Activity page and README. The third column is the id the dashboard
	// switches the command off by (src/commands.js there); help has none, and stays.
	static final String[][] HELP = {
			{"/mcstats view", "Open the mcstats menu", "view"},
			{"/mcstats profile", "Choose what you hold and your particles on the website", "profile"},
			{"/mcstats stats", "Every player's stats", "stats"},
			{"/mcstats stats <player>", "One player's stats", "stats"},
			{"/mcstats top", "Leaderboards", "top"},
			{"/mcstats link", "A link to your page on the website", "link"},
			{"/mcstats connect", "Connect your mcstats account, to chat as yourself on the website", "connect"},
			{"/mcstats disconnect", "Disconnect your mcstats account", "disconnect"},
			{"/mcstats particle <name>", "Set your particles (or none)", "particle"},
			{"/mcstats reset", "Go back to the automatic look", "reset"},
			{"/mcstats help", "This list", null},
	};
	private static final Set<String> IDS = Set.of("view", "profile", "stats", "top", "link", "connect", "disconnect", "particle", "reset");

	// the commands the dashboard's admins switched off, and the file they're kept in
	private static volatile Set<String> off = Set.of();
	private static volatile Path offFile;

	static boolean on(String id) {
		return !off.contains(id);
	}

	// At startup: what was off when the server last heard from the dashboard.
	static void load(Path file) {
		offFile = file;
		try {
			if (Files.exists(file)) off = known(java.util.List.of(Files.readString(file, StandardCharsets.UTF_8).split("[\\s,]+")));
		} catch (IOException | RuntimeException e) {
			ChatLogMod.LOG.warn("Couldn't read {}; every /mcstats command is on until the dashboard says otherwise", file, e);
		}
	}

	private static Set<String> known(Collection<String> ids) {
		Set<String> out = new TreeSet<>();
		for (String id : ids) if (id != null && IDS.contains(id)) out.add(id);
		return Set.copyOf(out);
	}

	// The dashboard said which commands are off (when the connection opens, and whenever an admin changes it).
	// Any thread. Players get their command list again, so tab completion follows at once.
	static void setOff(Collection<String> ids, MinecraftServer server) {
		Set<String> next = known(ids);
		if (next.equals(off)) return;
		off = next;
		ChatLogMod.LOG.info(next.isEmpty() ? "Every /mcstats command is on again (set on the dashboard)"
				: "/mcstats commands switched off on the dashboard: " + String.join(", ", new TreeSet<>(next)));
		Path file = offFile;
		if (file != null) {
			try {
				Files.writeString(file, String.join(",", new TreeSet<>(next)) + "\n", StandardCharsets.UTF_8);
			} catch (IOException e) {
				ChatLogMod.LOG.warn("Couldn't write {}", file, e);
			}
		}
		if (server != null) {
			server.execute(() -> {
				for (ServerPlayer p : server.getPlayerList().getPlayers()) server.getCommands().sendCommands(p);
			});
		}
	}

	static void register(CommandDispatcher<CommandSourceStack> dispatcher, McstatsMenus m) {
		menus = m;
		dispatcher.register(Commands.literal("mcstats")
				.executes(c -> on("view") ? openOrHelp(c, "main") : help(c.getSource()))
				.then(Commands.literal("help").executes(c -> help(c.getSource())))
				.then(Commands.literal("view").requires(s -> on("view")).executes(c -> openOrHelp(c, "main")))
				.then(Commands.literal("menu").requires(s -> on("view")).executes(c -> openOrHelp(c, "main")))
				.then(Commands.literal("profile").requires(s -> on("profile")).executes(c -> openOrHelp(c, "profile")))
				.then(Commands.literal("top").requires(s -> on("top")).executes(c -> openOrHelp(c, "top")))
				.then(Commands.literal("stats")
						.requires(s -> on("stats"))
						.executes(c -> openOrHelp(c, "stats"))
						.then(Commands.argument("player", StringArgumentType.word())
								.suggests((c, b) -> SharedSuggestionProvider.suggest(
										PlayerRecords.all(c.getSource().getServer()).stream().map(Entry::name), b))
								.executes(McstatsCommands::statsOf)))
				.then(Commands.literal("link")
						.requires(s -> on("link"))
						.executes(c -> link(c, null))
						.then(Commands.argument("player", StringArgumentType.word())
								.suggests((c, b) -> SharedSuggestionProvider.suggest(
										PlayerRecords.all(c.getSource().getServer()).stream().map(Entry::name), b))
								.executes(c -> link(c, StringArgumentType.getString(c, "player")))))
				.then(Commands.literal("connect")
						.requires(s -> on("connect"))
						.executes(c -> connect(c, null))
						.then(Commands.argument("email", StringArgumentType.greedyString())
								.executes(c -> connect(c, StringArgumentType.getString(c, "email").strip()))))
				.then(Commands.literal("disconnect").requires(s -> on("disconnect")).executes(McstatsCommands::disconnect))
				.then(Commands.literal("particle")
						.requires(s -> on("particle"))
						.then(Commands.argument("name", StringArgumentType.word())
								.suggests((c, b) -> SharedSuggestionProvider.suggest(
										java.util.stream.Stream.concat(java.util.stream.Stream.of("none"),
												McstatsMenus.PARTICLES.stream().map(McstatsMenus.Particle::id)), b))
								.executes(McstatsCommands::particle)))
				.then(Commands.literal("reset").requires(s -> on("reset")).executes(McstatsCommands::reset)));
	}

	static int help(CommandSourceStack source) {
		source.sendSuccess(() -> Component.literal("mcstats commands").withStyle(ChatFormatting.GOLD, ChatFormatting.BOLD), false);
		for (String[] line : HELP) {
			if (line[2] != null && !on(line[2])) continue; // switched off on the dashboard
			String command = line[0];
			String typed = command.contains("<") ? command.substring(0, command.indexOf('<')) : command;
			Component c = Component.literal("  " + command).withStyle(s -> s.withColor(ChatFormatting.AQUA)
							.withClickEvent(dev.mcserverstats.compat.Compat.suggestCommand(typed)))
					.append(Component.literal("  " + line[1]).withStyle(ChatFormatting.GRAY));
			source.sendSuccess(() -> c, false);
		}
		source.sendSuccess(() -> Component.literal("  /liveview help").withStyle(s -> s.withColor(ChatFormatting.AQUA)
						.withClickEvent(dev.mcserverstats.compat.Compat.suggestCommand("/liveview help")))
				.append(Component.literal("  Liveview's commands").withStyle(ChatFormatting.GRAY)), false);
		return 1;
	}

	private static ServerPlayer playerOrSay(CommandSourceStack source) {
		ServerPlayer p = source.getPlayer();
		if (p == null) source.sendFailure(Component.literal("Only a player in game can open the mcstats menus. Try /mcstats help."));
		return p;
	}

	private static int openOrHelp(CommandContext<CommandSourceStack> c, String which) {
		ServerPlayer p = c.getSource().getPlayer();
		if (p == null) return help(c.getSource());
		try {
			switch (which) {
				case "profile" -> menus.profile(p).open();
				case "stats" -> menus.serverStats(p, Sort.ONLINE, 0).open();
				case "top" -> menus.leaderboards(p).open();
				default -> menus.main(p).open();
			}
			return 1;
		} catch (RuntimeException e) {
			ChatLogMod.LOG.warn("Couldn't open the /mcstats menu", e);
			c.getSource().sendFailure(Component.literal("The menu couldn't open; the server log says why."));
			return 0;
		}
	}

	private static int statsOf(CommandContext<CommandSourceStack> c) {
		ServerPlayer p = playerOrSay(c.getSource());
		if (p == null) return 0;
		String name = StringArgumentType.getString(c, "player");
		Optional<Entry> e = PlayerRecords.find(c.getSource().getServer(), name);
		if (e.isEmpty()) {
			c.getSource().sendFailure(Component.literal("No stats for " + name + " on this server."));
			return 0;
		}
		menus.playerStats(p, e.get().uuid(), menus.serverStats(p, Sort.ONLINE, 0)).open();
		return 1;
	}

	private static int link(CommandContext<CommandSourceStack> c, String name) {
		ServerPlayer p = playerOrSay(c.getSource());
		if (p == null) return 0;
		if (name == null) {
			menus.sendLink(p, p.getUUID(), "your page");
			return 1;
		}
		Optional<Entry> e = PlayerRecords.find(c.getSource().getServer(), name);
		if (e.isEmpty()) {
			c.getSource().sendFailure(Component.literal("No stats for " + name + " on this server."));
			return 0;
		}
		menus.sendLink(p, e.get().uuid(), e.get().name() + "'s page");
		return 1;
	}

	private static int connect(CommandContext<CommandSourceStack> c, String email) {
		ServerPlayer p = playerOrSay(c.getSource());
		if (p == null) return 0;
		if (email == null) menus.accounts().prompt(p);
		else menus.accounts().connect(p, email);
		return 1;
	}

	private static int disconnect(CommandContext<CommandSourceStack> c) {
		ServerPlayer p = playerOrSay(c.getSource());
		if (p == null) return 0;
		menus.accounts().disconnect(p);
		return 1;
	}

	private static int particle(CommandContext<CommandSourceStack> c) {
		ServerPlayer p = playerOrSay(c.getSource());
		if (p == null) return 0;
		String name = StringArgumentType.getString(c, "name").toLowerCase();
		if (name.equals("none") || name.equals("off")) {
			menus.profiles().setParticle(p.getUUID(), null);
			McstatsMenus.say(p, "You have no particle effect on the website now.");
			return 1;
		}
		McstatsMenus.Particle particle = McstatsMenus.particle(name);
		if (particle == null) {
			c.getSource().sendFailure(Component.literal("No particle called " + name + ". Tab shows the ones there are."));
			return 0;
		}
		menus.profiles().setParticle(p.getUUID(), particle.id());
		McstatsMenus.say(p, Component.literal("Your particle effect on the website is now ").withStyle(ChatFormatting.GREEN)
				.append(Component.literal(particle.label()).withStyle(particle.color())).append(Component.literal(".").withStyle(ChatFormatting.GREEN)));
		return 1;
	}

	private static int reset(CommandContext<CommandSourceStack> c) {
		ServerPlayer p = playerOrSay(c.getSource());
		if (p == null) return 0;
		menus.profiles().reset(p.getUUID());
		McstatsMenus.say(p, "Your website display is back to automatic.");
		return 1;
	}
}
