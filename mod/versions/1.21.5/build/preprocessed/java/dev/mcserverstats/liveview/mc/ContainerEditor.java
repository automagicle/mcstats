package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.AdminCommands;
import dev.mcserverstats.liveview.LogOnce;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.ShulkerBoxBlockEntity;

/**
 * Moves items for a dashboard admin who has controls on: inside a block container, a player's inventory or their ender
 * chest, or between any two of those. Server thread only.
 *
 * <p>Nothing is ever "held" between messages: the page draws the stack on its cursor, but the items stay in their slot
 * until a move puts them somewhere, and each move is one step on the server thread that reads the slots as they are
 * now. A closed page, a dropped connection or a stale screen can make a move fail, but cannot lose or copy an item.
 * Every slot keeps the rules its vanilla screen has: armor slots take one piece of the right kind, shulker boxes
 * refuse shulker boxes, hoppers and brewing stands use {@code canPlaceItem}.
 *
 * <p>VERIFIED by javap on the 26.2 merged jar: {@code Container.setItem/getItem/canPlaceItem(int, ItemStack)/
 * getMaxStackSize(ItemStack)/setChanged}, {@code ItemStack.split/copyWithCount/isSameItemSameComponents/grow/shrink},
 * {@code Item.canFitInsideContainerItems}, {@code PlayerList.getPlayer(UUID)}, {@code Player.getInventory/
 * getEnderChestInventory}, {@code Inventory.EQUIPMENT_SLOT_MAPPING}, {@code LivingEntity.isEquippableInSlot/
 * getEquipmentSlotForItem}, {@code EquipmentSlot.getType}.
 */
public final class ContainerEditor {
	/** Player inventory slots the page can use: hotbar 0-8, main 9-35, armor 36-39 (feet to head), off hand 40. */
	private static final int PLAYER_SLOTS = 41;
	private static final int OFFHAND = 40;

	private ContainerEditor() {
	}

	/** One end of a move, with the rules of the screen slot it stands for. */
	private record Side(char kind, Container box, int size, boolean shulker, ServerPlayer player, String label) {
		boolean accepts(int slot, ItemStack stack) {
			return switch (kind) {
				case 'c' -> box.canPlaceItem(slot, stack) && (!shulker || stack.getItem().canFitInsideContainerItems());
				case 'p' -> slot < 36 || slot == OFFHAND || player.isEquippableInSlot(stack, Inventory.EQUIPMENT_SLOT_MAPPING.get(slot));
				default -> box.canPlaceItem(slot, stack);
			};
		}

		int limit(int slot, ItemStack stack) {
			int max = box.getMaxStackSize(stack);
			return kind == 'p' && slot >= 36 && slot < OFFHAND ? Math.min(max, 1) : max;
		}

		/** Can this whole stack sit in the slot, as a swap would leave it? */
		boolean holds(int slot, ItemStack stack) {
			return stack.isEmpty() || (accepts(slot, stack) && stack.getCount() <= limit(slot, stack));
		}
	}

	public static AdminCommands.Outcome move(MinecraftServer server, AdminCommands.ItemMove move) {
		try {
			Container chest = null;
			boolean shulker = false;
			if (move.touchesContainer()) {
				if (move.dimension() == null) {
					return fail("That container is not loaded.");
				}
				ServerLevel level = server.getLevel(ResourceKey.create(Registries.DIMENSION, ResourceLocation.parse(move.dimension())));
				BlockPos pos = new BlockPos(move.x(), move.y(), move.z());
				if (level == null || !level.isLoaded(pos)) {
					return fail("That container is not loaded.");
				}
				chest = ContainerSampler.container(level, pos);
				if (chest == null) {
					return fail("There is no container there any more.");
				}
				shulker = level.getBlockEntity(pos) instanceof ShulkerBoxBlockEntity;
			}
			ServerPlayer player = null;
			if (move.from() != 'c' || move.to() != 'c') {
				player = move.player() == null ? null : server.getPlayerList().getPlayer(move.player());
				if (player == null) {
					return fail(move.player() == null ? "Pick a player to move items to or from their inventory." : "That player is not online.");
				}
			}
			Side from = side(move.from(), chest, shulker, player);
			Side to = side(move.to(), chest, shulker, player);
			if (from == null || to == null) {
				return fail("That move doesn't make sense.");
			}
			int fs = move.fromSlot(), ts = move.toSlot();
			if (fs < 0 || fs >= from.size() || ts >= to.size()) {
				return fail("No such slot.");
			}
			ItemStack src = from.box().getItem(fs);
			if (src.isEmpty()) {
				return fail("That slot is empty now.");
			}
			String item = Ids.item(src);
			if (move.item() != null && !move.item().equals(item)) {
				return fail("That slot changed before the move arrived. Nothing moved.");
			}
			int have = src.getCount();
			int wanted = move.count() > 0 ? Math.min(move.count(), have)
					: move.amount() == 1 ? 1 : move.amount() == 2 ? (have + 1) / 2 : have;
			int moved;
			boolean swapped = false;
			if (ts < 0) {
				if (from.kind() == to.kind() && from.kind() != 'p') {
					return fail("That move doesn't make sense.");
				}
				ItemStack moving = src.copyWithCount(wanted);
				int left = insert(to, moving, shiftOrder(from, fs, to, src));
				moved = wanted - left;
				if (moved <= 0) {
					return fail("There is no room for that.");
				}
				src.shrink(moved);
			} else {
				if (from.kind() == to.kind() && fs == ts) {
					return fail("That is the same slot.");
				}
				ItemStack dst = to.box().getItem(ts);
				boolean pureSwap = move.amount() == 3 && move.count() <= 0;
				boolean sameItem = !dst.isEmpty() && ItemStack.isSameItemSameComponents(dst, src);
				if (pureSwap || (!dst.isEmpty() && !sameItem && move.amount() == 0 && move.count() <= 0)) {
					// both stacks change places whole, so both slots must be able to hold what lands in them
					if (!to.holds(ts, src) || !from.holds(fs, dst)) {
						return fail(dst.isEmpty() ? "That item cannot go there." : "Those two cannot swap.");
					}
					to.box().setItem(ts, src);
					from.box().setItem(fs, dst);
					moved = src.getCount();
					swapped = true;
				} else if (!to.accepts(ts, src)) {
					return fail("That item cannot go there.");
				} else if (dst.isEmpty()) {
					moved = Math.min(wanted, to.limit(ts, src));
					to.box().setItem(ts, src.split(moved));
				} else if (sameItem) {
					moved = Math.min(wanted, to.limit(ts, dst) - dst.getCount());
					if (moved <= 0) {
						return fail("That stack is full.");
					}
					dst.grow(moved);
					src.shrink(moved);
				} else {
					return fail("That slot holds something else.");
				}
			}
			if (!swapped && src.isEmpty()) {
				from.box().setItem(fs, ItemStack.EMPTY);
			}
			from.box().setChanged();
			to.box().setChanged();
			String place = move.touchesContainer() ? " at " + move.dimension() + " " + move.x() + " " + move.y() + " " + move.z() : "";
			LogOnce.logger().info("Liveview moved {} x {} from {} slot {} to {} {}{}{}", moved, item, from.label(), fs, to.label(),
					ts < 0 ? "(shift-click)" : "slot " + ts, swapped ? " (swapped)" : "", place);
			return new AdminCommands.Outcome(true, List.of("Moved " + moved));
		} catch (Throwable thrown) {
			LogOnce.warn("container-move", "Liveview could not move an item", thrown);
			return fail("The server could not move that item.");
		}
	}

	private static Side side(char kind, Container chest, boolean shulker, ServerPlayer player) {
		return switch (kind) {
			case 'c' -> chest == null ? null : new Side('c', chest, Math.min(chest.getContainerSize(), 54), shulker, null, "the container");
			case 'p' -> player == null ? null : new Side('p', player.getInventory(), PLAYER_SLOTS, false, player, player.getScoreboardName());
			case 'e' -> player == null ? null : new Side('e', player.getEnderChestInventory(),
					Math.min(player.getEnderChestInventory().getContainerSize(), 27), false, player, player.getScoreboardName() + "'s ender chest");
			default -> null;
		};
	}

	/**
	 * Where a shift-click sends a stack, in the order the vanilla screens try slots ({@code quickMoveStack}). Into a
	 * player from a chest: the hotbar right to left, then the main rows from the bottom. Out of a player into a chest:
	 * its first slot onwards. Inside the player's own inventory: armor to its empty armor slot (a shield to an empty
	 * off hand), the hotbar to the main rows and back, armor and the off hand to the main rows then the hotbar.
	 */
	private static int[] shiftOrder(Side from, int fromSlot, Side to, ItemStack stack) {
		if (to.kind() != 'p') {
			return range(0, to.size());
		}
		if (from.kind() != 'p') {
			int[] order = new int[36];
			for (int i = 0; i < 9; i++) {
				order[i] = 8 - i;
			}
			for (int i = 0; i < 27; i++) {
				order[9 + i] = 35 - i;
			}
			return order;
		}
		if (fromSlot >= 36) {
			return concat(range(9, 36), range(0, 9));
		}
		EquipmentSlot wears = to.player().getEquipmentSlotForItem(stack);
		int worn = -1;
		for (var entry : Inventory.EQUIPMENT_SLOT_MAPPING.int2ObjectEntrySet()) {
			if (entry.getValue() == wears && entry.getIntKey() >= 36 && entry.getIntKey() <= OFFHAND) {
				worn = entry.getIntKey();
			}
		}
		boolean wearable = wears.getType() == EquipmentSlot.Type.HUMANOID_ARMOR || wears == EquipmentSlot.OFFHAND;
		if (wearable && worn >= 0 && to.box().getItem(worn).isEmpty() && to.accepts(worn, stack)) {
			return new int[] {worn};
		}
		return fromSlot < 9 ? range(9, 36) : range(0, 9);
	}

	private static int[] range(int start, int end) {
		int[] out = new int[Math.max(0, end - start)];
		for (int i = 0; i < out.length; i++) {
			out[i] = start + i;
		}
		return out;
	}

	private static int[] concat(int[] a, int[] b) {
		int[] out = new int[a.length + b.length];
		System.arraycopy(a, 0, out, 0, a.length);
		System.arraycopy(b, 0, out, a.length, b.length);
		return out;
	}

	/** Merges into matching stacks first, then fills empty slots, as shift-click does. Returns what did not fit. */
	private static int insert(Side to, ItemStack stack, int[] order) {
		for (int slot : order) {
			if (stack.isEmpty()) {
				break;
			}
			ItemStack dst = to.box().getItem(slot);
			if (!dst.isEmpty() && ItemStack.isSameItemSameComponents(dst, stack) && to.accepts(slot, stack)) {
				int put = Math.min(stack.getCount(), to.limit(slot, dst) - dst.getCount());
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
			if (to.box().getItem(slot).isEmpty() && to.accepts(slot, stack)) {
				to.box().setItem(slot, stack.split(Math.min(stack.getCount(), to.limit(slot, stack))));
			}
		}
		return stack.getCount();
	}

	private static AdminCommands.Outcome fail(String why) {
		return new AdminCommands.Outcome(false, List.of(why));
	}
}
