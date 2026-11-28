package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.AdminCommands;
import dev.mcserverstats.liveview.LogOnce;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.RejectedExecutionException;
import net.minecraft.commands.CommandResultCallback;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;

/**
 * Executes commands sent from the dashboard on the server thread, as the console.
 *
 * <p>VERIFIED by javap on the 26.2 merged jar: {@code MinecraftServer.createCommandSourceStack()} (the console source,
 * full permissions), {@code getCommands()}, {@code Commands.performPrefixedCommand(CommandSourceStack, String)},
 * {@code CommandSourceStack.withSource(CommandSource)} and {@code withCallback(CommandResultCallback)},
 * {@code CommandSource.sendSystemMessage/acceptsSuccess/acceptsFailure/shouldInformAdmins},
 * {@code CommandResultCallback.onResult(boolean, int)}, and {@code BlockableEventLoop.execute(Runnable)}.
 */
public final class CommandRunner implements AdminCommands {
	private static final int MAX_LINES = 200;
	private static final int MAX_LINE_CHARS = 2000;

	private final MinecraftServer server;

	public CommandRunner(MinecraftServer server) {
		this.server = server;
	}

	@Override
	public CompletableFuture<Outcome> moveItem(ItemMove move) {
		CompletableFuture<Outcome> done = new CompletableFuture<>();
		try {
			server.execute(() -> done.complete(ContainerEditor.move(server, move)));
		} catch (RejectedExecutionException stopping) {
			done.complete(new Outcome(false, List.of("The server is stopping.")));
		}
		return done;
	}

	@Override
	public CompletableFuture<Outcome> run(String command) {
		CompletableFuture<Outcome> done = new CompletableFuture<>();
		try {
			server.execute(() -> {
				List<String> lines = new ArrayList<>();
				boolean[] success = {false};
				boolean[] reported = {false};
				try {
					CommandSource capture = new CommandSource() {
						@Override
						public void sendSystemMessage(Component message) {
							if (lines.size() < MAX_LINES && message != null) {
								String text = message.getString();
								lines.add(text.length() > MAX_LINE_CHARS ? text.substring(0, MAX_LINE_CHARS) : text);
							}
						}

						@Override
						public boolean acceptsSuccess() {
							return true;
						}

						@Override
						public boolean acceptsFailure() {
							return true;
						}

						// Ops in game see "[Server: ...]" for state-changing commands, as they would from the console.
						@Override
						public boolean shouldInformAdmins() {
							return true;
						}
						//#if PAPER
						//$$ // Paper runs plugins' commands as a Bukkit sender: one with the console's permissions whose
						//$$ // answers come back here too (Server.createCommandSender).
						//$$ private org.bukkit.command.CommandSender bukkit;
						//$$
						//$$ @Override
						//$$ public org.bukkit.command.CommandSender getBukkitSender(CommandSourceStack stack) {
						//$$ 	if (bukkit == null) {
						//$$ 		bukkit = org.bukkit.Bukkit.createCommandSender(c -> sendSystemMessage(io.papermc.paper.adventure.PaperAdventure.asVanilla(c)));
						//$$ 	}
						//$$ 	return bukkit;
						//$$ }
						//#endif
					};
					CommandSourceStack source = server.createCommandSourceStack()
							.withSource(capture)
							.withCallback((CommandResultCallback) (ok, result) -> {
								success[0] |= ok;
								reported[0] = true;
							});
					server.getCommands().performPrefixedCommand(source, command);
				} catch (Throwable thrown) {
					LogOnce.warn("web-command", "Liveview command failed", thrown);
					lines.add("Command failed: " + thrown.getClass().getSimpleName());
				}
				// Parse errors never reach the callback; they only send a failure line.
				done.complete(new Outcome(reported[0] && success[0], lines));
			});
		} catch (RejectedExecutionException stopping) {
			done.complete(new Outcome(false, List.of("The server is stopping.")));
		}
		return done;
	}
}
