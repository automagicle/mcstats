package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.PlayerSample;
import com.mojang.authlib.GameProfile;
import com.mojang.authlib.properties.Property;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.food.FoodData;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.GameType;

public final class PlayerSampler {
	private PlayerSampler() {
	}

	// VERIFIED by compiling against minecraft-merged-a8e9c7b123-26.2.jar (listed in DESIGN.md "Sampler names"): MinecraftServer.getPlayerList, PlayerList.getPlayers, Entity.getX/getY/getZ/getYRot/getXRot/getUUID,
	// Player.getPlainTextName, ServerPlayer.level, Level.dimension, ResourceKey.location, ResourceLocation.toString,
	// LivingEntity.getHealth/getMaxHealth, Player.getFoodData, FoodData.getFoodLevel/getSaturationLevel,
	// ServerPlayer.gameMode, GameType.getName, Player.getInventory, Inventory.getSelectedSlot/getSelectedItem/getItem.
	public static Optional<List<PlayerSample>> sample(MinecraftServer server, Set<UUID> optedOut) {
		Set<UUID> hidden = optedOut == null ? Set.of() : optedOut;
		List<ServerPlayer> players;
		try {
			players = List.copyOf(server.getPlayerList().getPlayers());
		} catch (Throwable thrown) {
			LogOnce.warn("player-list", "Liveview could not read the player list", thrown);
			return Optional.empty();
		}
		List<PlayerSample> samples = new ArrayList<>(players.size());
		for (ServerPlayer player : players) {
			try {
				UUID uuid = player.getUUID();
				if (hidden.contains(uuid)) {
					continue;
				}
				String name = player.getPlainTextName();
				Inventory inventory = player.getInventory();
				FoodData food = player.getFoodData();
				GameType mode = player.gameMode();
				ItemStack held = inventory.getSelectedItem();
				samples.add(new PlayerSample(
						uuid,
						name == null ? "" : name,
						player.level().dimension().location().toString(),
						player.getX(),
						player.getY(),
						player.getZ(),
						player.getYRot(),
						player.getXRot(),
						(double) player.getHealth(),
						(double) player.getMaxHealth(),
						food == null ? 0 : food.getFoodLevel(),
						food == null ? 0.0f : food.getSaturationLevel(),
						mode == null ? "" : mode.getName(),
						inventory.getSelectedSlot(),
						Ids.item(held),
						List.of(
								Ids.item(inventory.getItem(36)),
								Ids.item(inventory.getItem(37)),
								Ids.item(inventory.getItem(38)),
								Ids.item(inventory.getItem(39))),
						texturesProperty(player),
						null,
						null,
						Looks.of(player)));
			} catch (Throwable thrown) {
				LogOnce.warn("player-read", "Liveview could not read a player", thrown);
			}
		}
		return Optional.of(List.copyOf(samples));
	}

	// Player.getGameProfile() returns the authlib 9.0.75 record GameProfile(id, name, properties); PropertyMap is a
	// Guava multimap of Property(name, value, signature). VERIFIED by javap in Phase 4. Only the raw string is copied;
	// decoding and the download happen on a worker.
	private static String texturesProperty(ServerPlayer player) {
		try {
			GameProfile profile = player.getGameProfile();
			//#if MC >= 1.21.9
			var properties = profile == null ? null : profile.properties();
			//#else
			//$$ var properties = profile == null ? null : profile.getProperties();
			//#endif
			if (properties == null) {
				return null;
			}
			for (Property property : properties.get("textures")) {
				if (property != null && property.value() != null && !property.value().isBlank()) {
					return property.value();
				}
			}
		} catch (Throwable thrown) {
			LogOnce.warn("player-skin-property", "Liveview could not read a player's textures property", thrown);
		}
		return null;
	}
}
