package dev.mcserverstats.fabric;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import dev.mcserverstats.chatlog.ChatLogMod;
import dev.mcserverstats.compat.Platform;
import dev.mcserverstats.liveview.LiveviewMod;
import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.mc.ActionHooks;
import dev.mcserverstats.liveview.mc.AssetEnvironment;
import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.entity.event.v1.ServerPlayerEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.AttackEntityCallback;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.fabricmc.fabric.api.event.player.UseItemCallback;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.loader.api.ModContainer;
import net.minecraft.network.chat.ChatType;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionResult;

// The Fabric mod: hands Fabric API's events to the shared code (ChatLogMod, and Liveview through it). The rest
// of what's Fabric-only is the four mixins (chatlog.mixin, liveview.mc.mixin), which call ChatLogMod's and
// Liveview's static hooks themselves.
public final class FabricEntry implements DedicatedServerModInitializer {
	// Mods whose files aren't textures Liveview should pack.
	private static final Set<String> SKIP = Set.of("minecraft", "java", "fabricloader", "liveview", "mixinextras");

	@Override
	public void onInitializeServer() {
		Path dir = FabricLoader.getInstance().getConfigDir();
		String version = FabricLoader.getInstance().getModContainer("mcstats_chat")
				.map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("dev");
		String minecraft = FabricLoader.getInstance().getModContainer("minecraft")
				.map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("unknown");
		Platform.set("Fabric", "config/", "mods/");
		AssetEnvironment.set(minecraft.equals("unknown") ? null : minecraft, FabricEntry::modRoots);

		ChatLogMod mod = new ChatLogMod(dir, version, minecraft);
		LiveviewMod liveview = mod.liveview();
		ActionHooks actions = liveview.actions();

		// Liveview's action feed first, then the chat log's own: the order they've always been registered in.
		PlayerBlockBreakEvents.AFTER.register((level, player, pos, state, blockEntity) -> actions.blockBroken(level, player, pos, state));
		ServerLivingEntityEvents.AFTER_DEATH.register(actions::died);
		ServerPlayerEvents.JOIN.register(actions::joined);
		ServerPlayerEvents.LEAVE.register(actions::left);
		ServerMessageEvents.GAME_MESSAGE.register((server, message, overlay) -> actions.gameMessage(message, overlay));
		ServerMessageEvents.CHAT_MESSAGE.register((message, sender, params) -> actions.chat(message, sender, params));
		ServerMessageEvents.COMMAND_MESSAGE.register((message, source, params) -> actions.commandMessage(message, source.getPlayer(), params));
		AttackEntityCallback.EVENT.register((player, level, hand, entity, hit) -> {
			actions.attacked(player, level, entity);
			return InteractionResult.PASS;
		});
		UseItemCallback.EVENT.register((player, level, hand) -> {
			actions.usedItem(player, level, hand);
			return InteractionResult.PASS;
		});
		UseBlockCallback.EVENT.register((player, level, hand, hit) -> {
			actions.usedBlock(player, level, hit);
			return InteractionResult.PASS;
		});

		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> mod.registerCommands(dispatcher));
		ServerLifecycleEvents.SERVER_STARTING.register(mod::starting);
		ServerLifecycleEvents.SERVER_STARTED.register(mod::started);
		ServerLifecycleEvents.SERVER_STOPPING.register(mod::stopping);
		ServerLifecycleEvents.SERVER_STOPPED.register(mod::stopped);
		ServerLifecycleEvents.END_DATA_PACK_RELOAD.register((server, resources, success) -> {
			if (success) mod.dataPacksReloaded(server);
		});
		ServerTickEvents.END_SERVER_TICK.register(mod::tick);
		ServerPlayConnectionEvents.JOIN.register((handler, sender, s) -> mod.joined(handler.player));

		ServerMessageEvents.CHAT_MESSAGE.register((message, sender, params) ->
				mod.chat(sender, params.name(), message.decoratedContent().getString()));
		// /say and /me. Other command messages (like /teammsg) only go to some players, so they're skipped.
		ServerMessageEvents.COMMAND_MESSAGE.register((message, source, params) -> {
			String kind = params.chatType().is(ChatType.EMOTE_COMMAND) ? "emote"
					: params.chatType().is(ChatType.SAY_COMMAND) ? "say" : null;
			if (kind == null) return;
			ServerPlayer player = source.getPlayer();
			mod.sayCommand(kind, player, source.getTextName(), params.name(), message.decoratedContent().getString());
		});
		ServerMessageEvents.GAME_MESSAGE.register(mod::gameMessage);
	}

	/**
	 * Root paths of every installed mod except Minecraft itself, Java, and the loader. Fabric Loader 0.20.1, VERIFIED by
	 * javap in Phase 4: {@code getAllMods()} lists nested jar-in-jar mods as their own containers, and their root paths
	 * open the nested jar, so nested mod assets are scanned the same way as top-level ones.
	 */
	private static List<AssetEnvironment.ModRoot> modRoots() {
		List<AssetEnvironment.ModRoot> roots = new ArrayList<>();
		try {
			for (ModContainer container : FabricLoader.getInstance().getAllMods()) {
				String id = container.getMetadata().getId();
				if (SKIP.contains(id)) {
					continue;
				}
				for (Path root : container.getRootPaths()) {
					roots.add(new AssetEnvironment.ModRoot(id, root));
				}
			}
		} catch (Throwable thrown) {
			LogOnce.warn("mod-roots", "Liveview could not list mod jars; only vanilla assets will load", thrown);
		}
		return roots;
	}
}
