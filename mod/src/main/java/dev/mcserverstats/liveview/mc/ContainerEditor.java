package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.AdminCommands;
import dev.mcserverstats.liveview.LogOnce;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.ShulkerBoxBlockEntity;

/**
 * Moves items for a dashboard admin who has controls on: inside a block container, or between it and an online player's inventory.
 * Server thread only. Every move is one atomic step (no stack is ever "held" between messages), so a closed page or a
 * dropped connection cannot lose or duplicate items.
 *
 * <p>VERIFIED by javap on the 26.2 merged jar: {@code Container.setItem/getItem/canPlaceItem(int, ItemStack)/
 * getMaxStackSize(ItemStack)/setChanged}, {@code ItemStack.split/copyWithCount/isSameItemSameComponents/grow/shrink},
 * {@code Item.canFitInsideContainerItems}, {@code PlayerList.getPlayer(UUID)}, {@code Player.getInventory}.
 */
public final class ContainerEditor {
	/** Player inventory slots offered on the page: the main rows (9-35), then the hotbar (0-8). Armor stays put. */
	private static final int PLAYER_SLOTS = 36;

	private ContainerEditor() {
	}

	public static AdminCommands.Outcome move(MinecraftServer server, AdminCommands.ItemMove move) {
		try {
			ServerLevel level = server.getLevel(ResourceKey.create(Registries.DIMENSION, Identifier.parse(move.dimension())));
			BlockPos pos = new BlockPos(move.x(), move.y(), move.z());
			if (level == null || !level.isLoaded(pos)) {
				return fail("That container is not loaded.");
			}
			Container chest = ContainerSampler.container(level, pos);
			if (chest == null) {
				return fail("There is no container there any more.");
			}
			boolean shulker = level.getBlockEntity(pos) instanceof ShulkerBoxBlockEntity;
			Container inventory = null;
			String who = null;
			if (move.player() != null) {
				ServerPlayer player = server.getPlayerList().getPlayer(move.player());
				if (player == null) {
					return fail("That player is not online.");
				}
				inventory = player.getInventory();
				who = player.getGameProfile().name();
			}
			Container from = move.fromChest() ? chest : inventory;
			Container to = move.toChest() ? chest : inventory;
			if (from == null || to == null) {
				return fail("Pick a player to move items to or from their inventory.");
			}
			int fromSize = move.fromChest() ? Math.min(chest.getContainerSize(), 54) : PLAYER_SLOTS;
			int toSize = move.toChest() ? Math.min(chest.getContainerSize(), 54) : PLAYER_SLOTS;
			if (move.fromSlot() < 0 || move.fromSlot() >= fromSize || move.toSlot() >= toSize) {
				return fail("No such slot.");
			}
			ItemStack src = from.getItem(move.fromSlot());
			if (src.isEmpty()) {
				return fail("That slot is empty now.");
			}
			if (move.toChest() && shulker && !src.getItem().canFitInsideContainerItems()) {
				return fail("That item cannot go inside a shulker box.");
			}
			String item = Ids.item(src);
			int wanted = move.amount() == 1 ? 1 : move.amount() == 2 ? (src.getCount() + 1) / 2 : src.getCount();
			int moved;
			if (move.toSlot() < 0) {
				ItemStack moving = src.copyWithCount(wanted);
				int left = insert(to, moving, move.toChest() ? chestOrder(toSize) : PLAYER_ORDER);
				moved = wanted - left;
				if (moved <= 0) {
					return fail("There is no room for that.");
				}
				src.shrink(moved);
			} else {
				if (from == to && move.fromSlot() == move.toSlot()) {
					return fail("That is the same slot.");
				}
				ItemStack dst = to.getItem(move.toSlot());
				if (!to.canPlaceItem(move.toSlot(), src)) {
					return fail("That item cannot go there.");
				}
				if (dst.isEmpty()) {
					moved = Math.min(wanted, to.getMaxStackSize(src));
					to.setItem(move.toSlot(), src.split(moved));
				} else if (ItemStack.isSameItemSameComponents(dst, src)) {
					moved = Math.min(wanted, to.getMaxStackSize(dst) - dst.getCount());
					if (moved <= 0) {
						return fail("That stack is full.");
					}
					dst.grow(moved);
					src.shrink(moved);
				} else if (move.amount() == 0) {
					if (!from.canPlaceItem(move.fromSlot(), dst) || (move.fromChest() && shulker && !dst.getItem().canFitInsideContainerItems())) {
						return fail("Those two cannot swap.");
					}
					moved = src.getCount();
					to.setItem(move.toSlot(), src);
					from.setItem(move.fromSlot(), dst);
					src = dst;
				} else {
					return fail("That slot holds something else.");
				}
			}
			if (src.isEmpty()) {
				from.setItem(move.fromSlot(), ItemStack.EMPTY);
			}
			from.setChanged();
			to.setChanged();
			String place = move.dimension() + " " + move.x() + " " + move.y() + " " + move.z();
			LogOnce.logger().info("Liveview moved {} x {} from {} slot {} to {} {} at {}", moved, item,
					move.fromChest() ? "the container" : who, move.fromSlot(), move.toChest() ? "the container" : who,
					move.toSlot() < 0 ? "(any slot)" : "slot " + move.toSlot(), place);
			return new AdminCommands.Outcome(true, List.of("Moved " + moved));
		} catch (Throwable thrown) {
			LogOnce.warn("container-move", "Liveview could not move an item", thrown);
			return fail("The server could not move that item.");
		}
	}

	private static final int[] PLAYER_ORDER = playerOrder();

	private static int[] playerOrder() {
		int[] order = new int[PLAYER_SLOTS];
		for (int i = 0; i < 27; i++) {
			order[i] = 9 + i;
		}
		for (int i = 0; i < 9; i++) {
			order[27 + i] = i;
		}
		return order;
	}

	private static int[] chestOrder(int size) {
		int[] order = new int[size];
		for (int i = 0; i < size; i++) {
			order[i] = i;
		}
		return order;
	}

	/** Merges into matching stacks first, then fills empty slots, as shift-click does. Returns what did not fit. */
	private static int insert(Container to, ItemStack stack, int[] order) {
		for (int slot : order) {
			if (stack.isEmpty()) {
				break;
			}
			ItemStack dst = to.getItem(slot);
			if (!dst.isEmpty() && ItemStack.isSameItemSameComponents(dst, stack)) {
				int put = Math.min(stack.getCount(), to.getMaxStackSize(dst) - dst.getCount());
				if (put > 0) {
					dst.grow(put);
					stack.shrink(put);
				}
			}
		}
		for (int slot : order) {
			if (stack.isEmpty()) {
				break;
			}
			if (to.getItem(slot).isEmpty() && to.canPlaceItem(slot, stack)) {
				to.setItem(slot, stack.split(Math.min(stack.getCount(), to.getMaxStackSize(stack))));
			}
		}
		return stack.getCount();
	}

	private static AdminCommands.Outcome fail(String why) {
		return new AdminCommands.Outcome(false, List.of(why));
	}
}
