package dev.mcserverstats.liveview.snapshot;

import java.util.Map;

/**
 * One chunk section copied on the server thread.
 *
 * <p>{@code blocks} covers the section plus a one-block border taken from the six face neighbors, so it is
 * {@code SIDE * SIDE * SIDE} indexes into {@code palette}, edges and corners included (fluid corner heights and smooth
 * lighting need the diagonal neighbors). {@code light} uses the same layout, one byte per cell, sky light in the high
 * nibble and block light in the low one; it is null when {@code blocks} is. A null
 * {@code blocks} means the section held only air. {@code biomeCells} is 64 indexes into {@code biomes}, one per
 * 4x4x4 cell, ordered {@code (y * 4 + z) * 4 + x}. The arrays are never written after construction.
 */
public record SectionSnapshot(
		SectionId id,
		String[] palette,
		short[] blocks,
		String[] biomes,
		byte[] biomeCells,
		Map<String, BiomeInfo> biomeInfo,
		byte[] light) {

	public static final int SIDE = 18;

	public SectionSnapshot {
		palette = palette == null ? new String[] {"minecraft:air"} : palette;
		biomes = biomes == null ? new String[0] : biomes;
		biomeCells = biomeCells == null ? new byte[64] : biomeCells;
		biomeInfo = biomeInfo == null ? Map.of() : Map.copyOf(biomeInfo);
	}

	public static int index(int x, int y, int z) {
		return ((y + 1) * SIDE + (z + 1)) * SIDE + (x + 1);
	}

	public boolean empty() {
		return blocks == null;
	}

	public long contentHash() {
		long hash = 0xcbf29ce484222325L;
		for (String entry : palette) {
			hash = mix(hash, entry.hashCode());
		}
		if (blocks != null) {
			for (short value : blocks) {
				hash = mix(hash, value);
			}
		}
		for (String biome : biomes) {
			hash = mix(hash, biome.hashCode());
		}
		for (byte cell : biomeCells) {
			hash = mix(hash, cell);
		}
		if (light != null) {
			for (byte value : light) {
				hash = mix(hash, value);
			}
		}
		return hash;
	}

	private static long mix(long hash, int value) {
		hash ^= value;
		return hash * 0x100000001b3L;
	}
}
