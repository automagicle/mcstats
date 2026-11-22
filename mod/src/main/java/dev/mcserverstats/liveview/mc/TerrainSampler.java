package dev.mcserverstats.liveview.mc;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.BiomeInfo;
import dev.mcserverstats.liveview.snapshot.ColumnQuery;
import dev.mcserverstats.liveview.snapshot.ColumnReport;
import dev.mcserverstats.liveview.snapshot.SectionBatch;
import dev.mcserverstats.liveview.snapshot.SectionId;
import dev.mcserverstats.liveview.snapshot.SectionSnapshot;
import com.mojang.serialization.JsonOps;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.Holder;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.BiomeSpecialEffects;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.PalettedContainer;
import net.minecraft.core.SectionPos;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.chunk.DataLayer;
import net.minecraft.world.level.lighting.LayerLightEventListener;
import net.minecraft.world.level.lighting.LevelLightEngine;

/**
 * Server-thread terrain reads. Every method here runs on the server thread and returns only snapshot records.
 *
 * <p>VERIFIED by javap on the 26.2 merged jar in Phase 4:
 * {@code ServerLevel.getChunkSource()} returns {@code ServerChunkCache}; {@code ServerChunkCache.getChunkNow(int, int)}
 * reads {@code getVisibleChunkIfPresent} and {@code ChunkHolder.getChunkIfPresent} and never schedules a load;
 * {@code LevelHeightAccessor.getMinSectionY/getMaxSectionY/getSectionIndexFromSectionY};
 * {@code ChunkAccess.getSection(int)}; {@code LevelChunkSection.hasOnlyAir/getStates/getNoiseBiome(int, int, int)};
 * {@code PalettedContainerRO.get(int, int, int)}; {@code BlockStateParser.serialize(BlockState)} which writes
 * {@code namespace:path[prop=value,...]}; {@code Holder.getRegisteredName()}; {@code Biome.getBaseTemperature},
 * {@code Biome.getSpecialEffects}, {@code Biome.NETWORK_CODEC}; {@code BiomeSpecialEffects} record accessors;
 * {@code HolderLookup.Provider.createSerializationContext(DynamicOps)}; {@code MinecraftServer.registryAccess()}.
 * {@code PalettedContainer.getAll} is not used: in 26.2 it visits each distinct palette entry once, not each position.
 */
public final class TerrainSampler {
	private static final Map<BlockState, String> STATE_NAMES = new IdentityHashMap<>();
	private static final Map<String, BiomeInfo> BIOMES = new HashMap<>();
	private static final int SIDE = SectionSnapshot.SIDE;

	private TerrainSampler() {
	}

	/** Server thread, on stop. Biome data can differ after a restart (datapacks), so nothing carries over. */
	public static void clearCaches() {
		STATE_NAMES.clear();
		BIOMES.clear();
	}

	public static List<ColumnReport> columns(MinecraftServer server, List<ColumnQuery> queries) {
		if (queries == null || queries.isEmpty()) {
			return List.of();
		}
		Map<String, List<ColumnQuery>> byDimension = new LinkedHashMap<>();
		for (ColumnQuery query : queries) {
			byDimension.computeIfAbsent(query.dimension(), key -> new ArrayList<>()).add(query);
		}
		List<ColumnReport> reports = new ArrayList<>();
		try {
			for (ServerLevel level : server.getAllLevels()) {
				String dimension = Ids.dimension(level);
				List<ColumnQuery> wanted = byDimension.get(dimension);
				if (wanted == null) {
					continue;
				}
				Set<Long> loaded = new HashSet<>();
				Set<Long> seen = new HashSet<>();
				for (ColumnQuery query : wanted) {
					int r = query.radius();
					for (int dx = -r; dx <= r; dx++) {
						for (int dz = -r; dz <= r; dz++) {
							if (dx * dx + dz * dz > r * r + r) {
								continue;
							}
							int cx = query.cx() + dx;
							int cz = query.cz() + dz;
							long key = ColumnReport.key(cx, cz);
							if (!seen.add(key)) {
								continue;
							}
							if (level.getChunkSource().getChunkNow(cx, cz) != null) {
								loaded.add(key);
							}
						}
					}
				}
				reports.add(new ColumnReport(dimension, level.getMinSectionY(), level.getMaxSectionY(), loaded));
			}
		} catch (Throwable thrown) {
			LogOnce.warn("terrain-columns", "Liveview could not list loaded chunks for a camera", thrown);
		}
		return reports;
	}

	public static SectionBatch snapshot(MinecraftServer server, List<SectionId> wanted, long budgetNanos) {
		if (wanted == null || wanted.isEmpty()) {
			return new SectionBatch(List.of(), List.of(), List.of());
		}
		long start = System.nanoTime();
		Map<String, ServerLevel> levels = new HashMap<>();
		try {
			for (ServerLevel level : server.getAllLevels()) {
				levels.put(Ids.dimension(level), level);
			}
		} catch (Throwable thrown) {
			LogOnce.warn("terrain-levels", "Liveview could not list dimensions for terrain", thrown);
			return new SectionBatch(List.of(), List.of(), wanted);
		}
		List<SectionSnapshot> snapshots = new ArrayList<>();
		List<SectionId> unloaded = new ArrayList<>();
		List<SectionId> deferred = new ArrayList<>();
		for (int i = 0; i < wanted.size(); i++) {
			SectionId id = wanted.get(i);
			if (i > 0 && System.nanoTime() - start > budgetNanos) {
				deferred.addAll(wanted.subList(i, wanted.size()));
				break;
			}
			try {
				ServerLevel level = levels.get(id.dimension());
				if (level == null) {
					unloaded.add(id);
					continue;
				}
				SectionSnapshot copied = copy(server, level, id);
				if (copied == null) {
					unloaded.add(id);
				} else {
					snapshots.add(copied);
				}
			} catch (Throwable thrown) {
				LogOnce.warn("terrain-copy", "Liveview skipped a chunk section it could not copy", thrown);
				unloaded.add(id);
			}
		}
		return new SectionBatch(snapshots, unloaded, deferred);
	}

	private static SectionSnapshot copy(MinecraftServer server, ServerLevel level, SectionId id) {
		if (id.sy() < level.getMinSectionY() || id.sy() > level.getMaxSectionY()) {
			return null;
		}
		LevelChunk chunk = level.getChunkSource().getChunkNow(id.cx(), id.cz());
		if (chunk == null) {
			return null;
		}
		LevelChunkSection section = chunk.getSection(level.getSectionIndexFromSectionY(id.sy()));
		if (section == null) {
			return null;
		}
		Map<String, BiomeInfo> biomeInfo = new HashMap<>();
		List<String> biomes = new ArrayList<>();
		byte[] biomeCells = new byte[64];
		for (int qy = 0; qy < 4; qy++) {
			for (int qz = 0; qz < 4; qz++) {
				for (int qx = 0; qx < 4; qx++) {
					Holder<Biome> holder = section.getNoiseBiome(qx, qy, qz);
					String name = holder.getRegisteredName();
					int index = biomes.indexOf(name);
					if (index < 0) {
						index = biomes.size();
						biomes.add(name);
						biomeInfo.put(name, biomeInfo(server, name, holder.value()));
					}
					biomeCells[(qy * 4 + qz) * 4 + qx] = (byte) index;
				}
			}
		}
		String[] biomeArray = biomes.toArray(new String[0]);
		if (section.hasOnlyAir()) {
			return new SectionSnapshot(id, new String[] {"minecraft:air"}, null, biomeArray, biomeCells, biomeInfo, null);
		}
		Palette palette = new Palette();
		short[] blocks = new short[SIDE * SIDE * SIDE];
		PalettedContainer<BlockState> states = section.getStates();
		for (int y = 0; y < 16; y++) {
			for (int z = 0; z < 16; z++) {
				for (int x = 0; x < 16; x++) {
					blocks[SectionSnapshot.index(x, y, z)] = palette.id(states.get(x, y, z));
				}
			}
		}
		border(level, chunk, id, palette, blocks);
		return new SectionSnapshot(id, palette.names(), blocks, biomeArray, biomeCells, biomeInfo, light(level, id));
	}

	/**
	 * Sky and block light for the section and its one-block border, as {@code sky << 4 | block}.
	 *
	 * <p>VERIFIED by javap on the 26.2 merged jar: {@code Level.getLightEngine()}, {@code LevelLightEngine.getLayerListener(LightLayer)},
	 * {@code LayerLightEventListener.getDataLayerData(SectionPos)} (null when the section stores no light),
	 * {@code DataLayer.get(int, int, int)}, {@code SectionPos.of(int, int, int)}, {@code DimensionType.hasSkyLight()}.
	 * A section with no sky data takes the bottom row of the nearest stored section above it, the way sky light falls
	 * straight down through empty sections; with nothing stored above, it is open sky (15).
	 */
	private static byte[] light(ServerLevel level, SectionId id) {
		byte[] out = new byte[SIDE * SIDE * SIDE];
		boolean hasSky = level.dimensionType().hasSkyLight();
		LevelLightEngine engine = level.getLightEngine();
		LayerLightEventListener skyLayer = engine.getLayerListener(LightLayer.SKY);
		LayerLightEventListener blockLayer = engine.getLayerListener(LightLayer.BLOCK);
		DataLayer[] sky = new DataLayer[27];
		DataLayer[] skyAbove = new DataLayer[27];
		DataLayer[] block = new DataLayer[27];
		boolean[] openSky = new boolean[27];
		int top = level.getMaxSectionY() + 1;
		for (int dy = -1; dy <= 1; dy++) {
			for (int dz = -1; dz <= 1; dz++) {
				for (int dx = -1; dx <= 1; dx++) {
					int n = (dy + 1) * 9 + (dz + 1) * 3 + (dx + 1);
					int cx = id.cx() + dx, sy = id.sy() + dy, cz = id.cz() + dz;
					block[n] = blockLayer.getDataLayerData(SectionPos.of(cx, sy, cz));
					if (!hasSky) {
						continue;
					}
					sky[n] = skyLayer.getDataLayerData(SectionPos.of(cx, sy, cz));
					if (sky[n] == null) {
						for (int up = sy + 1; up <= top && skyAbove[n] == null; up++) {
							skyAbove[n] = skyLayer.getDataLayerData(SectionPos.of(cx, up, cz));
						}
						openSky[n] = skyAbove[n] == null;
					}
				}
			}
		}
		for (int y = -1; y <= 16; y++) {
			int dy = y < 0 ? -1 : y > 15 ? 1 : 0;
			int ly = y & 15;
			for (int z = -1; z <= 16; z++) {
				int dz = z < 0 ? -1 : z > 15 ? 1 : 0;
				int lz = z & 15;
				for (int x = -1; x <= 16; x++) {
					int dx = x < 0 ? -1 : x > 15 ? 1 : 0;
					int lx = x & 15;
					int n = (dy + 1) * 9 + (dz + 1) * 3 + (dx + 1);
					int b = block[n] == null ? 0 : block[n].get(lx, ly, lz);
					int s = 0;
					if (hasSky) {
						if (sky[n] != null) {
							s = sky[n].get(lx, ly, lz);
						} else if (skyAbove[n] != null) {
							s = skyAbove[n].get(lx, 0, lz);
						} else if (openSky[n]) {
							s = 15;
						}
					}
					out[SectionSnapshot.index(x, y, z)] = (byte) (s << 4 | b);
				}
			}
		}
		return out;
	}

	/** Copies every border cell, edges and corners included, from the 26 neighboring sections that are loaded. */
	private static void border(ServerLevel level, LevelChunk chunk, SectionId id, Palette palette, short[] blocks) {
		@SuppressWarnings("unchecked")
		PalettedContainer<BlockState>[] around = new PalettedContainer[27];
		for (int dy = -1; dy <= 1; dy++) {
			for (int dz = -1; dz <= 1; dz++) {
				for (int dx = -1; dx <= 1; dx++) {
					if (dx == 0 && dy == 0 && dz == 0) {
						continue;
					}
					around[(dy + 1) * 9 + (dz + 1) * 3 + (dx + 1)] =
							sectionStates(level, dx == 0 && dz == 0 ? chunk : null, id.cx() + dx, id.sy() + dy, id.cz() + dz);
				}
			}
		}
		for (int y = -1; y <= 16; y++) {
			int dy = y < 0 ? -1 : y > 15 ? 1 : 0;
			for (int z = -1; z <= 16; z++) {
				int dz = z < 0 ? -1 : z > 15 ? 1 : 0;
				for (int x = -1; x <= 16; x++) {
					int dx = x < 0 ? -1 : x > 15 ? 1 : 0;
					if (dx == 0 && dy == 0 && dz == 0) {
						continue;
					}
					PalettedContainer<BlockState> states = around[(dy + 1) * 9 + (dz + 1) * 3 + (dx + 1)];
					if (states != null) {
						blocks[SectionSnapshot.index(x, y, z)] = palette.id(states.get(x & 15, y & 15, z & 15));
					}
				}
			}
		}
	}

	private static PalettedContainer<BlockState> sectionStates(ServerLevel level, LevelChunk known, int cx, int sy, int cz) {
		if (sy < level.getMinSectionY() || sy > level.getMaxSectionY()) {
			return null;
		}
		LevelChunk chunk = known != null ? known : level.getChunkSource().getChunkNow(cx, cz);
		if (chunk == null) {
			return null;
		}
		LevelChunkSection section = chunk.getSection(level.getSectionIndexFromSectionY(sy));
		if (section == null || section.hasOnlyAir()) {
			return null;
		}
		return section.getStates();
	}

	private static BiomeInfo biomeInfo(MinecraftServer server, String name, Biome biome) {
		BiomeInfo cached = BIOMES.get(name);
		if (cached != null) {
			return cached;
		}
		BiomeSpecialEffects effects = biome.getSpecialEffects();
		BiomeInfo info = new BiomeInfo(
				name,
				biome.getBaseTemperature(),
				downfall(server, name, biome),
				effects.grassColorOverride().orElse(null),
				effects.foliageColorOverride().orElse(null),
				effects.dryFoliageColorOverride().orElse(null),
				effects.grassColorModifier().getSerializedName(),
				effects.waterColor());
		BIOMES.put(name, info);
		return info;
	}

	// Biome keeps downfall in a private ClimateSettings record. NETWORK_CODEC is the public form the client receives and
	// flattens that record into "temperature" and "downfall" fields.
	private static float downfall(MinecraftServer server, String name, Biome biome) {
		try {
			JsonElement encoded = Biome.NETWORK_CODEC
					.encodeStart(server.registryAccess().createSerializationContext(JsonOps.INSTANCE), biome)
					.result()
					.orElse(null);
			if (encoded instanceof JsonObject object && object.has("downfall")) {
				return object.get("downfall").getAsFloat();
			}
		} catch (Throwable thrown) {
			LogOnce.warn("biome-downfall-" + name, "Liveview could not read downfall for " + name + "; using 0.5", thrown);
			return 0.5f;
		}
		LogOnce.warn("biome-downfall-" + name, "Liveview found no downfall for " + name + "; using 0.5", null);
		return 0.5f;
	}

	private static final class Palette {
		private final Map<BlockState, Short> ids = new IdentityHashMap<>();
		private final List<String> names = new ArrayList<>();
		private BlockState lastState;
		private short lastId;

		private Palette() {
			names.add("minecraft:air");
		}

		private short id(BlockState state) {
			if (state == lastState) {
				return lastId;
			}
			Short known = ids.get(state);
			if (known == null) {
				String name = STATE_NAMES.computeIfAbsent(state, BlockStateParser::serialize);
				int index = names.indexOf(name);
				if (index < 0) {
					index = names.size();
					names.add(name);
				}
				known = (short) index;
				ids.put(state, known);
			}
			lastState = state;
			lastId = known;
			return known;
		}

		private String[] names() {
			return names.toArray(new String[0]);
		}
	}
}
