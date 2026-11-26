package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.KeyController;
import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.OptOutController;
import dev.mcserverstats.liveview.keys.KeyStore;
import dev.mcserverstats.liveview.relay.RelayLink;
import com.mojang.brigadier.CommandDispatcher;
import java.util.List;
import java.util.function.Supplier;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/**
 * {@code /liveview}: players hide themselves from it, and operators make its two keys and see who is watching.
 *
 * <p>VERIFIED by javap on the 26.2 merged jar: {@code Commands.hasPermission(PermissionCheck)} returns a
 * {@code PermissionProviderCheck}, which implements {@code Predicate}; {@code Commands.LEVEL_ADMINS};
 * {@code CommandSourceStack.getServer/isPlayer/getPlayer/sendSuccess(Supplier, boolean)};
 * {@code MinecraftServer} extends {@code BlockableEventLoop}, which implements {@code Executor.execute(Runnable)};
 * {@code ClickEvent.CopyToClipboard(String)}; {@code Style.withClickEvent}; {@code MutableComponent.withStyle(UnaryOperator)}.
 */
public final class LiveviewCommands {
	private LiveviewCommands() {
	}

	public static void register(CommandDispatcher<CommandSourceStack> dispatcher, OptOutController optOut, KeyController keys,
			Supplier<List<RelayLink.Watcher>> watchers) {
		dispatcher.register(
				Commands.literal("liveview")
						.executes(context -> help(context.getSource()))
						.then(Commands.literal("help").executes(context -> help(context.getSource())))
						.then(Commands.literal("optout").executes(context -> toggle(context.getSource(), optOut, true)))
						.then(Commands.literal("optin").executes(context -> toggle(context.getSource(), optOut, false)))
						.then(Commands.literal("who")
								.requires(dev.mcserverstats.compat.Compat.admins())
								.executes(context -> who(context.getSource(), watchers)))
						// Who may use Liveview is the server's call: this list names every dashboard account that may.
						.then(Commands.literal("access")
								.requires(dev.mcserverstats.compat.Compat.admins())
								.executes(context -> access(context.getSource(), keys))
								.then(Commands.literal("list").executes(context -> access(context.getSource(), keys)))
								.then(Commands.literal("viewer").then(Commands.argument("account", com.mojang.brigadier.arguments.StringArgumentType.greedyString())
										.executes(context -> setAccess(context.getSource(), keys, com.mojang.brigadier.arguments.StringArgumentType.getString(context, "account"), KeyStore.Level.VIEWER))))
								.then(Commands.literal("control").then(Commands.argument("account", com.mojang.brigadier.arguments.StringArgumentType.greedyString())
										.executes(context -> setAccess(context.getSource(), keys, com.mojang.brigadier.arguments.StringArgumentType.getString(context, "account"), KeyStore.Level.CONTROL))))
								.then(Commands.literal("remove").then(Commands.argument("account", com.mojang.brigadier.arguments.StringArgumentType.greedyString())
										.executes(context -> setAccess(context.getSource(), keys, com.mojang.brigadier.arguments.StringArgumentType.getString(context, "account"), null)))))
						.then(Commands.literal("key")
								.requires(dev.mcserverstats.compat.Compat.admins())
								.then(Commands.literal("viewer").executes(context -> reset(context.getSource(), keys, KeyStore.Level.VIEWER)))
								.then(Commands.literal("control").executes(context -> reset(context.getSource(), keys, KeyStore.Level.CONTROL)))));
	}

	// Every /liveview command, each a line you can click to put it in the chat box. Operators also see theirs.
	// The same list is on the dashboard's Liveview page (public/liveview.js, LIVEVIEW_COMMANDS).
	private static final String[][] PLAYER_HELP = {
			{"/liveview optout", "Hide yourself from Liveview"},
			{"/liveview optin", "Show yourself in Liveview again"},
			{"/liveview help", "This list"},
	};
	private static final String[][] OPERATOR_HELP = {
			{"/liveview who", "Who is watching right now"},
			{"/liveview access", "Which dashboard accounts may use Liveview"},
			{"/liveview access viewer <account>", "Let an account watch"},
			{"/liveview access control <account>", "Let an account watch and use controls"},
			{"/liveview access remove <account>", "Take an account off the list"},
			{"/liveview key viewer", "Make a new viewer key (the old one stops working)"},
			{"/liveview key control", "Make a new control key (the old one stops working)"},
	};

	private static int help(CommandSourceStack source) {
		boolean op = dev.mcserverstats.compat.Compat.admins().test(source);
		source.sendSuccess(() -> Component.literal("Liveview commands").withStyle(ChatFormatting.GOLD, ChatFormatting.BOLD), false);
		for (String[] line : PLAYER_HELP) source.sendSuccess(() -> helpLine(line), false);
		if (op) {
			source.sendSuccess(() -> Component.literal("Operators").withStyle(ChatFormatting.YELLOW), false);
			for (String[] line : OPERATOR_HELP) source.sendSuccess(() -> helpLine(line), false);
		}
		return 1;
	}

	static Component helpLine(String[] line) {
		String command = line[0];
		// up to the first "<": the part that can be typed as it is
		String typed = command.contains("<") ? command.substring(0, command.indexOf('<')) : command;
		return Component.literal("  " + command).withStyle(style -> style.withColor(ChatFormatting.AQUA)
						.withClickEvent(new ClickEvent.SuggestCommand(typed)))
				.append(Component.literal("  " + line[1]).withStyle(ChatFormatting.GRAY));
	}

	private static int toggle(CommandSourceStack source, OptOutController optOut, boolean hide) {
		try {
			ServerPlayer player = source.getPlayer();
			if (player == null) {
				source.sendFailure(Component.literal("Only a player can use /liveview optout and /liveview optin."));
				return 0;
			}
			boolean changed = hide ? optOut.optOut(player.getUUID()) : optOut.optIn(player.getUUID());
			String text = hide
					? (changed ? "You are hidden from Liveview." : "You were already hidden from Liveview.")
					: (changed ? "You are visible to Liveview again." : "You were already visible to Liveview.");
			source.sendSuccess(() -> Component.literal(text), false);
			return 1;
		} catch (Throwable thrown) {
			LogOnce.warn("command-liveview", "Liveview command failed", thrown);
			return 0;
		}
	}

	private static int access(CommandSourceStack source, KeyController keys) {
		try {
			var list = keys.accessList();
			if (list.isEmpty()) {
				source.sendSuccess(() -> Component.literal("No dashboard account may use Liveview yet. One gets on the list by entering the viewer key, or with /liveview access viewer <account>."), false);
				return 1;
			}
			source.sendSuccess(() -> Component.literal(list.size() == 1 ? "1 dashboard account may use Liveview:" : list.size() + " dashboard accounts may use Liveview:"), false);
			for (var entry : list.entrySet()) {
				boolean control = entry.getValue() == KeyStore.Level.CONTROL;
				Component line = Component.literal("  " + entry.getKey())
						.append(Component.literal(control ? "  watching and controls" : "  watching only").withStyle(control ? ChatFormatting.GOLD : ChatFormatting.GRAY));
				source.sendSuccess(() -> line, false);
			}
			return list.size();
		} catch (Throwable thrown) {
			LogOnce.warn("command-access", "Liveview could not list who has access", thrown);
			return 0;
		}
	}

	// The file write runs on a worker; like the key commands, this waits for it briefly so RCON sees the answer.
	private static int setAccess(CommandSourceStack source, KeyController keys, String account, KeyStore.Level level) {
		try {
			MinecraftServer server = source.getServer();
			java.util.concurrent.CompletableFuture<String> done = new java.util.concurrent.CompletableFuture<>();
			keys.setAccess(account, level, done::complete);
			try {
				String answer = done.get(2, java.util.concurrent.TimeUnit.SECONDS);
				source.sendSuccess(() -> Component.literal(answer), false);
			} catch (java.util.concurrent.TimeoutException slow) {
				done.thenAccept(answer -> server.execute(() -> source.sendSuccess(() -> Component.literal(answer), false)));
			}
			return 1;
		} catch (Throwable thrown) {
			LogOnce.warn("command-access-set", "Liveview could not change who has access", thrown);
			return 0;
		}
	}

	private static int who(CommandSourceStack source, Supplier<List<RelayLink.Watcher>> watchers) {
		try {
			List<RelayLink.Watcher> list = watchers.get();
			if (list.isEmpty()) {
				source.sendSuccess(() -> Component.literal("Nobody is watching through Liveview."), false);
				return 1;
			}
			long now = System.currentTimeMillis();
			source.sendSuccess(() -> Component.literal(list.size() == 1 ? "1 account is watching through Liveview:" : list.size() + " accounts are watching through Liveview:"), false);
			for (RelayLink.Watcher watcher : list) {
				long minutes = Math.max(0, (now - watcher.sinceMs()) / 60_000);
				Component line = Component.literal("  " + watcher.who())
						.append(Component.literal(watcher.control() ? "  controls on" : "  watching only")
								.withStyle(watcher.control() ? ChatFormatting.GOLD : ChatFormatting.GRAY))
						.append(Component.literal(minutes < 1 ? "  just now" : "  for " + minutes + " min").withStyle(ChatFormatting.GRAY));
				source.sendSuccess(() -> line, false);
			}
			return list.size();
		} catch (Throwable thrown) {
			LogOnce.warn("command-who", "Liveview could not list who is watching", thrown);
			return 0;
		}
	}

	// Hashing and the file write run on a Liveview worker. The command waits for it briefly (a tenth of a second,
	// usually), so the answer is part of the command's own output: that's the only output RCON ever sees. If the
	// worker is slow the answer follows on the server thread instead.
	// The new key goes only to the caller (broadcastToAdmins false). From the console it also lands in the log,
	// which is why the hint below says to run it in game.
	private static int reset(CommandSourceStack source, KeyController keys, KeyStore.Level level) {
		String which = level == KeyStore.Level.VIEWER ? "viewer key" : "control key";
		try {
			MinecraftServer server = source.getServer();
			boolean fromPlayer = source.isPlayer();
			java.util.concurrent.CompletableFuture<KeyController.Result> done = new java.util.concurrent.CompletableFuture<>();
			keys.resetKey(level, done::complete);
			KeyController.Result now = null;
			try {
				now = done.get(2, java.util.concurrent.TimeUnit.SECONDS);
			} catch (java.util.concurrent.TimeoutException slow) {
				source.sendSuccess(() -> Component.literal("Making a new Liveview " + which + "..."), false);
				done.thenAccept(result -> server.execute(() -> show(source, result, level, which, fromPlayer)));
				return 1;
			}
			return show(source, now, level, which, fromPlayer);
		} catch (Throwable thrown) {
			LogOnce.warn("command-key", "Liveview could not make a new key", thrown);
			return 0;
		}
	}

	private static int show(CommandSourceStack source, KeyController.Result result, KeyStore.Level level, String which, boolean fromPlayer) {
		try {
			if (result.key() == null) {
				source.sendFailure(Component.literal(result.error()));
				return 0;
			}
			String key = result.key();
			Component secret = Component.literal(key)
					.withStyle(style -> style.withClickEvent(new ClickEvent.CopyToClipboard(key)))
					.withStyle(ChatFormatting.GREEN, ChatFormatting.UNDERLINE);
			source.sendSuccess(() -> Component.literal("New Liveview " + which + " (click to copy, shown once): ").append(secret), false);
			source.sendSuccess(() -> Component.literal(level == KeyStore.Level.VIEWER
					? "Dashboard admins enter it once to watch. Any earlier viewer key no longer works, and everyone watching was disconnected."
					: "Dashboard admins who can already watch enter it once to run commands and move items. Any earlier control key no longer works."), false);
			if (!fromPlayer) {
				source.sendSuccess(() -> Component.literal("Run this command in game next time to keep the key out of the server log."), false);
			}
			return 1;
		} catch (Throwable thrown) {
			LogOnce.warn("command-key-reply", "Liveview could not show the new key", thrown);
			return 0;
		}
	}
}
