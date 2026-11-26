package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.ContainerView;
import dev.mcserverstats.liveview.snapshot.SlotSample;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.Nameable;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Reads the container at a block, the way its screen would show it. Server thread only, loaded chunks only.
 *
 * <p>VERIFIED by javap on the 26.2 merged jar: {@code MinecraftServer.getLevel(ResourceKey)}, {@code Level.isLoaded/
 * getBlockEntity/getBlockState}, {@code ChestBlock.getContainer(ChestBlock, BlockState, Level, BlockPos, boolean)}
 * (the joined double chest), {@code Container.getContainerSize/getItem}, {@code Nameable.getDisplayName}.
 */
public final class ContainerSampler {
	private ContainerSampler() {
	}

	public static ContainerView read(MinecraftServer server, String dimension, int x, int y, int z) {
		try {
			ServerLevel level = server.getLevel(ResourceKey.create(Registries.DIMENSION, ResourceLocation.parse(dimension)));
			BlockPos pos = new BlockPos(x, y, z);
			if (level == null || !level.isLoaded(pos)) {
				return ContainerView.missing(dimension, x, y, z);
			}
			BlockState state = level.getBlockState(pos);
			BlockEntity entity = level.getBlockEntity(pos);
			Container container = container(level, pos);
			if (container == null) {
				return ContainerView.missing(dimension, x, y, z);
			}
			Component title = entity instanceof Nameable named ? named.getDisplayName() : Component.literal("Container");
			if (state.getBlock() instanceof ChestBlock && container.getContainerSize() > 27 && !(entity instanceof Nameable n && n.hasCustomName())) {
				title = Component.translatable("container.chestDouble");
			}
			int size = Math.min(container.getContainerSize(), 54);
			List<SlotSample> slots = new ArrayList<>(size);
			for (int i = 0; i < size; i++) {
				slots.add(Stacks.slot(i, container.getItem(i), level, null));
			}
			String block = Ids.block(state);
			String kind = kind(block, size);
			int rows = "generic".equals(kind) ? Math.max(1, (size + 8) / 9) : 0;
			return new ContainerView(dimension, x, y, z, block, kind, Stacks.line(title), rows, slots, false);
		} catch (Throwable thrown) {
			LogOnce.warn("container-read", "Liveview could not read a container", thrown);
			return ContainerView.missing(dimension, x, y, z);
		}
	}

	/** The container a screen at this block would show (a double chest joined), or null. Server thread. */
	public static Container container(ServerLevel level, BlockPos pos) {
		BlockState state = level.getBlockState(pos);
		if (!(level.getBlockEntity(pos) instanceof Container single)) {
			return null;
		}
		if (state.getBlock() instanceof ChestBlock chest) {
			Container joined = ChestBlock.getContainer(chest, state, level, pos, true);
			if (joined != null) {
				return joined;
			}
		}
		return single;
	}

	private static String kind(String block, int size) {
		if (block.endsWith("shulker_box")) {
			return "shulker";
		}
		if (block.equals("minecraft:dispenser") || block.equals("minecraft:dropper") || block.equals("minecraft:crafter")) {
			return "dispenser";
		}
		if (block.equals("minecraft:hopper")) {
			return "hopper";
		}
		if (size % 9 == 0) {
			return "generic";
		}
		return "other";
	}

}
