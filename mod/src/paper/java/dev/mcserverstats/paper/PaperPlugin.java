package dev.mcserverstats.paper;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.brigadier.CommandDispatcher;

import dev.mcserverstats.chatlog.ChatLogMod;
import dev.mcserverstats.compat.Platform;
import dev.mcserverstats.liveview.mc.AssetEnvironment;
import io.papermc.paper.plugin.lifecycle.event.types.LifecycleEvents;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.MinecraftServer;
import org.bukkit.Bukkit;
import org.bukkit.craftbukkit.entity.CraftPlayer;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

// The Paper plugin: the same mcstats as the Fabric mod (ChatLogMod and everything under it), started from
// Paper's plugin life cycle and fed Bukkit's events (PaperEvents). What the Fabric mod's mixins do comes from
// Bukkit's events too, or from watching what the server sends players (NetworkTap); the one thing Paper can't
// do without a mixin, keeping mobs near a Liveview camera from despawning, is left out.
//
// Paper runs on Mojang's names, so the shared code calls the game directly, as on Fabric. That ties each jar to
// the Minecraft version it was built for: on any other, it says which to download and stays off.
public final class PaperPlugin extends JavaPlugin {
	private ChatLogMod mod;
	private PaperEvents events;
	private NetworkTap tap;
	private boolean started;

	@Override
	public void onEnable() {
		String minecraft = Bukkit.getMinecraftVersion();
		String built = builtFor();
		if (built != null && !built.equals(minecraft)) {
			getSLF4JLogger().error("This mcstats jar is for Paper {}, but this server runs {}. Download the one for {} from your dashboard "
					+ "(Admin, or the mod page), put it in plugins/ in place of this one, and restart; if there's none for {}, update Paper "
					+ "to a version there is one for. mcstats stays off until then.",
					built, minecraft, minecraft, minecraft);
			getServer().getPluginManager().disablePlugin(this);
			return;
		}
		String folder = "plugins/" + getDataFolder().getName() + "/";
		Platform.set("Paper", folder, "plugins/");
		// Paper has no mods that add blocks, so Liveview's textures are the game's own.
		AssetEnvironment.set(minecraft, List::of);

		MinecraftServer server = MinecraftServer.getServer();
		mod = new ChatLogMod(getDataFolder().toPath(), getPluginMeta().getVersion(), minecraft);
		mod.starting(server);
		tap = new NetworkTap(mod);
		events = new PaperEvents(this, mod, tap);
		getServer().getPluginManager().registerEvents(events, this);

		// The commands are built at start and again on /minecraft:reload; Paper hands over the game's own dispatcher,
		// whose sources are the game's CommandSourceStack, so /mcstats and /liveview are registered as on Fabric.
		getLifecycleManager().registerEventHandler(LifecycleEvents.COMMANDS, event -> {
			@SuppressWarnings("unchecked")
			CommandDispatcher<CommandSourceStack> dispatcher = (CommandDispatcher<CommandSourceStack>) (Object) event.registrar().getDispatcher();
			try {
				mod.registerCommands(dispatcher);
			} catch (RuntimeException e) {
				ChatLogMod.LOG.error("Couldn't add the /mcstats and /liveview commands", e);
			}
		});

		// The scheduler runs its first task on the server's first tick, once it's up ("Done"), the moment Fabric
		// calls SERVER_STARTED. Enabled later (a plugin manager), that's the next tick.
		Bukkit.getScheduler().runTask(this, () -> {
			started = true;
			events.started();
			mod.started(server);
			whisperSuggestions(server);
			for (Player p : Bukkit.getOnlinePlayers()) tap.attach(((CraftPlayer) p).getHandle());
		});
		ChatLogMod.LOG.info("mcstats {} for Paper {} is on; its files are in {}", getPluginMeta().getVersion(), minecraft, folder);
	}

	@Override
	public void onDisable() {
		if (mod == null) return;
		MinecraftServer server = MinecraftServer.getServer();
		try {
			if (tap != null) tap.detachAll();
		} catch (RuntimeException e) {
			ChatLogMod.LOG.debug("Couldn't stop watching what players are sent", e);
		}
		// Paper turns plugins off as it stops, before it saves the worlds: stopping and stopped together.
		if (started) {
			mod.stopping(server);
			mod.stopped(server);
		}
		mod = null;
		started = false;
	}

	// /msg's name suggestions get the players who are on the dashboard, as CommandsMixin does on Fabric. Paper's
	// lifecycle event hands plugins a copy of the command tree that can only be added to, so this changes the
	// game's own one once it's built: at start and after each /minecraft:reload (PaperEvents), then sends players
	// the new tree.
	void whisperSuggestions(MinecraftServer server) {
		dev.mcserverstats.chatlog.WhisperSuggestions.apply(server.getCommands().getDispatcher());
		for (net.minecraft.server.level.ServerPlayer p : server.getPlayerList().getPlayers()) server.getCommands().sendCommands(p);
	}

	boolean isStarted() {
		return started;
	}

	// The Minecraft version this jar was built for, from its mcstats.json.
	private String builtFor() {
		try (InputStream in = getResource("mcstats.json")) {
			if (in == null) return null;
			JsonObject meta = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
			return meta.has("minecraft") ? meta.get("minecraft").getAsString() : null;
		} catch (Exception e) {
			return null;
		}
	}
}
