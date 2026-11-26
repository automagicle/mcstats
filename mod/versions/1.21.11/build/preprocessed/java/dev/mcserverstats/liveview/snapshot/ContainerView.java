package dev.mcserverstats.liveview.snapshot;

import java.util.List;

/**
 * A block container's contents as a viewer would see them in its screen.
 *
 * @param kind  {@code generic} (rows of 9: chests, barrels, trapped chests), {@code shulker}, {@code dispenser} (3x3,
 *              also droppers and crafters), {@code hopper} (5), or {@code other}
 * @param title the screen title as JSON segments, like a tooltip line
 * @param rows  rows of 9 for {@code generic}
 */
public record ContainerView(String dimension, int x, int y, int z, String block, String kind, String title, int rows,
		List<SlotSample> slots, boolean missing) {
	public ContainerView {
		slots = slots == null ? List.of() : List.copyOf(slots);
	}

	public static ContainerView missing(String dimension, int x, int y, int z) {
		return new ContainerView(dimension, x, y, z, "minecraft:air", "other", "[]", 0, List.of(), true);
	}
}
