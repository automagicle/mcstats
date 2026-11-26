package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.InventorySample;
import dev.mcserverstats.liveview.snapshot.SlotSample;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.PlayerEnderChestContainer;

public final class InventorySampler {
	private InventorySampler() {
	}

	public static List<InventorySample> sample(MinecraftServer server, Set<UUID> wanted, Set<UUID> optedOut) {
		if (wanted == null || wanted.isEmpty()) {
			return List.of();
		}
		Set<UUID> hidden = optedOut == null ? Set.of() : optedOut;
		List<InventorySample> samples = new ArrayList<>(wanted.size());
		for (UUID uuid : wanted) {
			try {
				if (hidden.contains(uuid)) {
					samples.add(InventorySample.unavailable(uuid));
					continue;
				}
				ServerPlayer player = server.getPlayerList().getPlayer(uuid);
				if (player == null) {
					samples.add(InventorySample.unavailable(uuid));
					continue;
				}
				InventorySample main = copy(uuid, player.getInventory(), player);
				List<SlotSample> all = new ArrayList<>(main.slots());
				// VERIFIED by javap on the 26.2 merged jar: Player.getEnderChestInventory() returns
				// PlayerEnderChestContainer (a SimpleContainer with getContainerSize and getItem(int)).
				copyEnder(all, player.getEnderChestInventory(), player);
				samples.add(new InventorySample(uuid, all, false));
			} catch (Throwable thrown) {
				LogOnce.warn("inventory-read", "Liveview could not read an inventory", thrown);
				samples.add(InventorySample.unavailable(uuid));
			}
		}
		return List.copyOf(samples);
	}

	// VERIFIED (DESIGN.md Inventory row, Phase 0 javap; compiles against minecraft-merged-a8e9c7b123-26.2.jar): Inventory.getContainerSize/getItem.
	// Re-run javap on a version bump.
	private static InventorySample copy(UUID uuid, Inventory inventory, ServerPlayer player) {
		int size = inventory.getContainerSize();
		List<SlotSample> slots = new ArrayList<>(size);
		for (int i = 0; i < size; i++) {
			slots.add(Stacks.slot(i, inventory.getItem(i), player.level(), player));
		}
		return new InventorySample(uuid, slots, false);
	}

	/** Ender chest slots travel in the same list as indexes 100-126, so the existing slot diff covers them. */
	public static final int ENDER_BASE = 100;

	private static void copyEnder(List<SlotSample> slots, PlayerEnderChestContainer ender, ServerPlayer player) {
		if (ender == null) {
			return;
		}
		int size = Math.min(ender.getContainerSize(), 54);
		for (int i = 0; i < size; i++) {
			slots.add(Stacks.slot(ENDER_BASE + i, ender.getItem(i), player.level(), player));
		}
	}
}
