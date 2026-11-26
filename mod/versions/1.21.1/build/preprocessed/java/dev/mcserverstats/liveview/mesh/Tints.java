package dev.mcserverstats.liveview.mesh;

import dev.mcserverstats.liveview.assets.Png;
import dev.mcserverstats.liveview.snapshot.BiomeInfo;
import java.util.Map;

/**
 * Block tint colors without client classes. The block-to-source table mirrors the registrations in the 26.2
 * client's {@code BlockColors} (read with javap in Phase 4). Colormap lookups use the same formula as
 * {@code ColorMapColorUtil.get}: {@code downfall *= temperature}, index {@code (1-downfall)*255 << 8 | (1-temperature)*255}.
 */
public final class Tints {
	private static final int GRASS_DEFAULT = 0x48B518;
	private static final int FOLIAGE_DEFAULT = 0x48B518;
	private static final int DRY_FOLIAGE_DEFAULT = 0xA0732D;

	enum Source {
		NONE,
		GRASS,
		FOLIAGE,
		DRY_FOLIAGE,
		WATER,
		CONSTANT,
		REDSTONE,
		STEM
	}

	private static final Map<String, Source> SOURCES = Map.ofEntries(
			Map.entry("minecraft:grass_block", Source.GRASS),
			Map.entry("minecraft:short_grass", Source.GRASS),
			Map.entry("minecraft:tall_grass", Source.GRASS),
			Map.entry("minecraft:fern", Source.GRASS),
			Map.entry("minecraft:large_fern", Source.GRASS),
			Map.entry("minecraft:potted_fern", Source.GRASS),
			Map.entry("minecraft:bush", Source.GRASS),
			Map.entry("minecraft:sugar_cane", Source.GRASS),
			Map.entry("minecraft:pink_petals", Source.GRASS),
			Map.entry("minecraft:wildflowers", Source.GRASS),
			Map.entry("minecraft:oak_leaves", Source.FOLIAGE),
			Map.entry("minecraft:jungle_leaves", Source.FOLIAGE),
			Map.entry("minecraft:acacia_leaves", Source.FOLIAGE),
			Map.entry("minecraft:dark_oak_leaves", Source.FOLIAGE),
			Map.entry("minecraft:mangrove_leaves", Source.FOLIAGE),
			Map.entry("minecraft:vine", Source.FOLIAGE),
			Map.entry("minecraft:leaf_litter", Source.DRY_FOLIAGE),
			Map.entry("minecraft:water", Source.WATER),
			Map.entry("minecraft:water_cauldron", Source.WATER),
			Map.entry("minecraft:bubble_column", Source.WATER),
			Map.entry("minecraft:spruce_leaves", Source.CONSTANT),
			Map.entry("minecraft:birch_leaves", Source.CONSTANT),
			Map.entry("minecraft:attached_melon_stem", Source.CONSTANT),
			Map.entry("minecraft:attached_pumpkin_stem", Source.CONSTANT),
			Map.entry("minecraft:lily_pad", Source.CONSTANT),
			Map.entry("minecraft:redstone_wire", Source.REDSTONE),
			Map.entry("minecraft:melon_stem", Source.STEM),
			Map.entry("minecraft:pumpkin_stem", Source.STEM));

	private static final Map<String, Integer> CONSTANTS = Map.of(
			"minecraft:spruce_leaves", 0x619961,
			"minecraft:birch_leaves", 0x80A755,
			"minecraft:attached_melon_stem", 0xE0C71C,
			"minecraft:attached_pumpkin_stem", 0xE0C71C,
			"minecraft:lily_pad", 0x208030);

	private final Png.Image grass;
	private final Png.Image foliage;
	private final Png.Image dryFoliage;

	public Tints(Map<String, Png.Image> colormaps) {
		this.grass = colormaps.get("grass");
		this.foliage = colormaps.get("foliage");
		this.dryFoliage = colormaps.get("dry_foliage");
	}

	static Source source(String block) {
		return SOURCES.getOrDefault(block, Source.NONE);
	}

	/** RGB color for a tinted face, or -1 when the block has no tint. */
	int color(String block, int power, int age, BiomeInfo biome, int x, int z) {
		Source source = source(block);
		return switch (source) {
			case NONE -> -1;
			case GRASS -> grass(biome);
			case FOLIAGE -> biome != null && biome.foliageOverride() != null
					? biome.foliageOverride() & 0xFFFFFF
					: colormap(foliage, biome, FOLIAGE_DEFAULT);
			case DRY_FOLIAGE -> biome != null && biome.dryFoliageOverride() != null
					? biome.dryFoliageOverride() & 0xFFFFFF
					: colormap(dryFoliage, biome, DRY_FOLIAGE_DEFAULT);
			case WATER -> water(biome);
			case CONSTANT -> CONSTANTS.getOrDefault(block, 0xFFFFFF);
			case REDSTONE -> redstone(power);
			case STEM -> stem(age);
		};
	}

	int water(BiomeInfo biome) {
		return biome == null ? 0x3F76E4 : biome.waterColor() & 0xFFFFFF;
	}

	// Swamp grass in vanilla picks one of two colors from a noise field; this uses the more common one everywhere.
	private int grass(BiomeInfo biome) {
		int base = biome != null && biome.grassOverride() != null
				? biome.grassOverride() & 0xFFFFFF
				: colormap(grass, biome, GRASS_DEFAULT);
		if (biome == null) {
			return base;
		}
		return switch (biome.grassModifier()) {
			case "dark_forest" -> ((base & 0xFEFEFE) + 0x28340A) >> 1;
			case "swamp" -> 0x6A7039;
			default -> base;
		};
	}

	private static int colormap(Png.Image map, BiomeInfo biome, int fallback) {
		if (map == null || biome == null || map.width() < 256 || map.height() < 256) {
			return fallback;
		}
		double temperature = clamp(biome.temperature());
		double downfall = clamp(biome.downfall()) * temperature;
		int i = (int) ((1.0 - temperature) * 255.0);
		int j = (int) ((1.0 - downfall) * 255.0);
		int index = j << 8 | i;
		if (index < 0 || index >= map.pixels().length) {
			return fallback;
		}
		return map.pixels()[index] & 0xFFFFFF;
	}

	private static double clamp(float value) {
		return Math.max(0.0, Math.min(1.0, value));
	}

	private static int redstone(int power) {
		float f = power / 15.0f;
		float r = f * 0.6f + (f > 0.0f ? 0.4f : 0.3f);
		float g = Math.max(0.0f, Math.min(1.0f, f * f * 0.7f - 0.5f));
		float b = Math.max(0.0f, Math.min(1.0f, f * f * 0.6f - 0.7f));
		return ((int) (r * 255) << 16) | ((int) (g * 255) << 8) | (int) (b * 255);
	}

	private static int stem(int age) {
		return (age * 32) << 16 | (255 - age * 8) << 8 | age * 4;
	}
}
