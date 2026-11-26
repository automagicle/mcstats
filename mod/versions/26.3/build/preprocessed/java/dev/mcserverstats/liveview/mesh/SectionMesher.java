package dev.mcserverstats.liveview.mesh;

import dev.mcserverstats.liveview.assets.Atlas;
import dev.mcserverstats.liveview.assets.BakedQuad;
import dev.mcserverstats.liveview.assets.BlockModels;
import dev.mcserverstats.liveview.assets.BlockRender;
import dev.mcserverstats.liveview.snapshot.BiomeInfo;
import dev.mcserverstats.liveview.snapshot.SectionSnapshot;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Turns one section snapshot into lit quads. Runs on a worker.
 *
 * <p>Lighting follows vanilla's smooth lighting ({@code ModelBlockRenderer.AmbientOcclusionFace}): each vertex of a face
 * averages the light of the four cells around that corner on the face's outer side, a zero sample takes the center's
 * value, the corner cell is skipped when both side cells are opaque, and each opaque cell darkens the corner to 0.2.
 * Vertices carry sky and block light (0-15); the page turns them into color with the lightmap, so day, night and
 * fullbright are page-side. Ambient occlusion is multiplied into the vertex tint.
 *
 * <p>Faces of opaque full cubes whose UVs are a whole tile are greedy-merged per direction, but only when all four of
 * their vertices have the same light and occlusion, so merging never smears a gradient.
 *
 * <p>Fluids follow {@code LiquidBlockRenderer}: per-corner heights from the four columns around each corner (diagonal
 * included), weighted the vanilla way, a flowing texture turned to the flow direction, and a still texture where
 * there is no flow.
 */
public final class SectionMesher {
	private static final int[][] OFFSETS = {{0, -1, 0}, {0, 1, 0}, {0, 0, -1}, {0, 0, 1}, {-1, 0, 0}, {1, 0, 0}};
	private static final String WATER = "minecraft:block/water_still";
	private static final String LAVA = "minecraft:block/lava_still";
	private static final String WATER_FLOW = "minecraft:block/water_flow";
	private static final String LAVA_FLOW = "minecraft:block/lava_flow";
	private static final float OCCLUDED = 0.2f;

	private SectionMesher() {
	}

	public static Mesh mesh(SectionSnapshot snapshot, BlockModels models, Tints tints) {
		MeshBuffer out = new MeshBuffer();
		if (snapshot.empty()) {
			return new Mesh(out.data(), 0, new byte[0], new byte[0]);
		}
		String[] palette = snapshot.palette();
		BlockRender[] renders = new BlockRender[palette.length];
		for (int i = 0; i < palette.length; i++) {
			renders[i] = models.render(palette[i]);
		}
		Cells cells = new Cells(snapshot.blocks(), snapshot.light(), renders);
		int[] emitterKind = new int[palette.length];
		int[] chestKind = new int[palette.length];
		for (int i = 0; i < palette.length; i++) {
			emitterKind[i] = emitter(palette[i]);
			chestKind[i] = chestKind(palette[i]);
		}
		java.io.ByteArrayOutputStream specials = new java.io.ByteArrayOutputStream();
		java.io.ByteArrayOutputStream emitters = new java.io.ByteArrayOutputStream();
		Atlas atlas = models.atlas();
		int baseX = snapshot.id().blockX();
		int baseY = snapshot.id().blockY();
		int baseZ = snapshot.id().blockZ();
		int[][] greedy = new int[6][];
		Map<GreedyKey, Integer> keyIds = new HashMap<>();
		List<GreedyKey> keys = new ArrayList<>();
		keys.add(null);
		float[] lit = new float[12];
		for (int y = 0; y < 16; y++) {
			for (int z = 0; z < 16; z++) {
				for (int x = 0; x < 16; x++) {
					BlockRender render = cells.render(x, y, z);
					if (render == BlockRender.AIR) {
						continue;
					}
					int kind = emitterKind[snapshot.blocks()[SectionSnapshot.index(x, y, z)]];
					int chest = chestKind[snapshot.blocks()[SectionSnapshot.index(x, y, z)]];
					if (chest != 0 && specials.size() < 5 * 1024) {
						specials.write(x);
						specials.write(y);
						specials.write(z);
						specials.write(chest);
						specials.write(cells.light(x, y, z));
					}
					if (kind == EMIT_LAVA && cells.render(x, y + 1, z) != BlockRender.AIR) {
						kind = 0;
					}
					if (kind != 0 && emitters.size() < 4 * 512) {
						emitters.write(x);
						emitters.write(y);
						emitters.write(z);
						emitters.write(kind);
					}
					BiomeInfo biome = biome(snapshot, x, y, z);
					int hash = seed(baseX + x, baseY + y, baseZ + z);
					for (BlockRender.Part part : render.parts()) {
						List<BakedQuad> quads = part.pick(hash);
						for (BakedQuad quad : quads) {
							if (quad.cull() >= 0 && occluded(cells, render, x, y, z, quad.cull())) {
								continue;
							}
							int color = tintColor(tints, render, quad, biome, baseX + x, baseZ + z);
							quadLight(cells, quad, x, y, z, lit);
							if (render.opaque()
									&& render.parts().size() == 1
									&& quad.canonical()
									&& quad.cull() == quad.facing()
									&& onlyOnSide(quads, quad)
									&& uniform(lit)) {
								int d = quad.facing();
								if (greedy[d] == null) {
									greedy[d] = new int[4096];
								}
								GreedyKey key = new GreedyKey(quad.texture(), color, lit[0], lit[1], lit[2]);
								Integer id = keyIds.get(key);
								if (id == null) {
									id = keys.size();
									keyIds.put(key, id);
									keys.add(key);
								}
								greedy[d][(y * 16 + z) * 16 + x] = id;
								continue;
							}
							emit(out, quad, x, y, z, color, lit);
						}
					}
					if (render.fluid() != BlockRender.Fluid.NONE) {
						fluid(out, cells, atlas, tints, biome, render.fluid(), x, y, z);
					} else if (render.extraFluid() != BlockRender.Fluid.NONE) {
						fluid(out, cells, atlas, tints, biome, render.extraFluid(), x, y, z);
					}
				}
			}
		}
		for (int d = 0; d < 6; d++) {
			if (greedy[d] != null) {
				merge(out, atlas, d, greedy[d], keys);
			}
		}
		return new Mesh(out.data(), out.vertexCount(), emitters.toByteArray(), specials.toByteArray());
	}

	// Blocks whose particles vanilla makes on the client only (animateTick); the page animates these itself.
	static final int EMIT_TORCH = 1, EMIT_SOUL_TORCH = 2, EMIT_FIRE = 3, EMIT_SOUL_FIRE = 4, EMIT_CAMPFIRE = 5,
			EMIT_LAVA = 6, EMIT_PORTAL = 7, EMIT_END_ROD = 8, EMIT_CANDLE = 9, EMIT_FURNACE = 10;

	private static int emitter(String state) {
		int bracket = state.indexOf('[');
		String block = bracket < 0 ? state : state.substring(0, bracket);
		boolean lit = state.contains("lit=true");
		return switch (block) {
			case "minecraft:torch", "minecraft:wall_torch", "minecraft:copper_torch", "minecraft:copper_wall_torch" -> EMIT_TORCH;
			case "minecraft:soul_torch", "minecraft:soul_wall_torch" -> EMIT_SOUL_TORCH;
			case "minecraft:fire" -> EMIT_FIRE;
			case "minecraft:soul_fire" -> EMIT_SOUL_FIRE;
			case "minecraft:campfire", "minecraft:soul_campfire" -> lit ? EMIT_CAMPFIRE : 0;
			case "minecraft:lava" -> state.contains("level=0") || bracket < 0 ? EMIT_LAVA : 0;
			case "minecraft:nether_portal" -> EMIT_PORTAL;
			case "minecraft:end_rod" -> EMIT_END_ROD;
			case "minecraft:furnace", "minecraft:blast_furnace", "minecraft:smoker" -> lit ? EMIT_FURNACE : 0;
			default -> block.endsWith("candle") && lit ? EMIT_CANDLE : 0;
		};
	}

	// Chests have no block model (ChestRenderer draws them), so the page builds them from the chest model layers.
	private static final List<String> CHEST_VARIANTS = List.of("chest", "trapped_chest", "ender_chest", "copper_chest",
			"exposed_copper_chest", "weathered_copper_chest", "oxidized_copper_chest");
	private static final List<String> FACINGS = List.of("north", "south", "west", "east");

	/** 1 + variant * 12 + type * 4 + facing (type 0 single, 1 left, 2 right; facing north, south, west, east), or 0. */
	static int chestKind(String state) {
		int bracket = state.indexOf('[');
		String block = bracket < 0 ? state : state.substring(0, bracket);
		if (!block.startsWith("minecraft:")) {
			return 0;
		}
		String name = block.substring("minecraft:".length());
		if (name.startsWith("waxed_")) {
			name = name.substring("waxed_".length());
		}
		int variant = CHEST_VARIANTS.indexOf(name);
		if (variant < 0) {
			return 0;
		}
		int type = state.contains("type=left") ? 1 : state.contains("type=right") ? 2 : 0;
		int facing = 0;
		for (int i = 0; i < FACINGS.size(); i++) {
			if (state.contains("facing=" + FACINGS.get(i))) {
				facing = i;
			}
		}
		return 1 + variant * 12 + type * 4 + facing;
	}

	/** Snapshot access with the 18-cell border; coordinates outside -1..16 are clamped onto the border. */
	private record Cells(short[] blocks, byte[] light, BlockRender[] renders) {
		private static int clamp(int v) {
			return v < -1 ? -1 : Math.min(v, 16);
		}

		BlockRender render(int x, int y, int z) {
			return renders[blocks[SectionSnapshot.index(clamp(x), clamp(y), clamp(z))]];
		}

		boolean opaque(int x, int y, int z) {
			return render(x, y, z).opaque();
		}

		/** {@code sky << 4 | block}; a snapshot without light (older format) is treated as full sky. */
		int light(int x, int y, int z) {
			return light == null ? 0xF0 : light[SectionSnapshot.index(clamp(x), clamp(y), clamp(z))] & 0xFF;
		}
	}

	// ---------- light ----------

	/** Fills {@code out} with sky, block, ao for each of the quad's four vertices (12 floats). */
	private static void quadLight(Cells cells, BakedQuad quad, int x, int y, int z, float[] out) {
		int d = quad.facing();
		float[] p = quad.positions();
		if (d < 0 || !quad.ao()) {
			// No smooth lighting (cross plants, "ambientocclusion": false): the light of the cell the face looks into,
			// which for a face inside the block is the block's own cell. No occlusion darkening.
			int own = cells.light(x, y, z);
			if (quad.cull() >= 0) {
				int[] o = OFFSETS[quad.cull()];
				int next = cells.light(x + o[0], y + o[1], z + o[2]);
				own = Math.max(own >> 4, next >> 4) << 4 | Math.max(own & 15, next & 15);
			}
			for (int i = 0; i < 4; i++) {
				out[i * 3] = own >> 4;
				out[i * 3 + 1] = own & 15;
				out[i * 3 + 2] = 1f;
			}
			return;
		}
		for (int i = 0; i < 4; i++) {
			vertexLight(cells, d, x, y, z, p[i * 3], p[i * 3 + 1], p[i * 3 + 2], out, i * 3);
		}
	}

	private static void vertexLight(Cells cells, int d, int x, int y, int z, float vx, float vy, float vz, float[] out, int at) {
		int[] n = OFFSETS[d];
		int axis = n[0] != 0 ? 0 : n[1] != 0 ? 1 : 2;
		float[] v = {vx, vy, vz};
		boolean onFace = n[axis] > 0 ? v[axis] >= 0.999f : v[axis] <= 0.001f;
		int bx = x + (onFace ? n[0] : 0);
		int by = y + (onFace ? n[1] : 0);
		int bz = z + (onFace ? n[2] : 0);
		int t1 = axis == 0 ? 1 : 0;
		int t2 = axis == 2 ? 1 : 2;
		int s1 = v[t1] < 0.5f ? -1 : 1;
		int s2 = v[t2] < 0.5f ? -1 : 1;
		int[] e1 = new int[3];
		int[] e2 = new int[3];
		e1[t1] = s1;
		e2[t2] = s2;
		int la = cells.light(bx, by, bz);
		boolean o1 = cells.opaque(bx + e1[0], by + e1[1], bz + e1[2]);
		boolean o2 = cells.opaque(bx + e2[0], by + e2[1], bz + e2[2]);
		int l1 = cells.light(bx + e1[0], by + e1[1], bz + e1[2]);
		int l2 = cells.light(bx + e2[0], by + e2[1], bz + e2[2]);
		boolean oc;
		int lc;
		if (o1 && o2) {
			oc = true;
			lc = l1;
		} else {
			int cx = bx + e1[0] + e2[0], cy = by + e1[1] + e2[1], cz = bz + e1[2] + e2[2];
			oc = cells.opaque(cx, cy, cz);
			lc = cells.light(cx, cy, cz);
		}
		out[at] = blend(la >> 4, l1 >> 4, l2 >> 4, lc >> 4);
		out[at + 1] = blend(la & 15, l1 & 15, l2 & 15, lc & 15);
		float base = cells.opaque(bx, by, bz) ? OCCLUDED : 1f;
		out[at + 2] = (base + (o1 ? OCCLUDED : 1f) + (o2 ? OCCLUDED : 1f) + (oc ? OCCLUDED : 1f)) * 0.25f;
	}

	/** Vanilla's AmbientOcclusionFace.blend: a zero sample borrows the center's light so dark seams do not appear. */
	private static float blend(int center, int a, int b, int c) {
		if (a == 0) {
			a = center;
		}
		if (b == 0) {
			b = center;
		}
		if (c == 0) {
			c = center;
		}
		return (center + a + b + c) * 0.25f;
	}

	private static boolean uniform(float[] lit) {
		for (int i = 3; i < 12; i++) {
			if (lit[i] != lit[i % 3]) {
				return false;
			}
		}
		return true;
	}

	// ---------- quads ----------

	private static boolean onlyOnSide(List<BakedQuad> quads, BakedQuad quad) {
		int count = 0;
		for (BakedQuad other : quads) {
			if (other.facing() == quad.facing() && other.cull() == quad.cull()) {
				count++;
			}
		}
		return count == 1;
	}

	private static boolean occluded(Cells cells, BlockRender self, int x, int y, int z, int dir) {
		int[] o = OFFSETS[dir];
		BlockRender neighbor = cells.render(x + o[0], y + o[1], z + o[2]);
		if (neighbor.opaque()) {
			return true;
		}
		return self.fullCube()
				&& neighbor.fullCube()
				&& neighbor.block().equals(self.block())
				&& !self.block().endsWith("_leaves");
	}

	private static int tintColor(Tints tints, BlockRender render, BakedQuad quad, BiomeInfo biome, int x, int z) {
		if (quad.tintIndex() < 0) {
			return 0xFFFFFF;
		}
		int color = tints.color(render.block(), render.power(), render.age(), biome, x, z);
		return color < 0 ? 0xFFFFFF : color;
	}

	private static void emit(MeshBuffer out, BakedQuad quad, int x, int y, int z, int color, float[] lit) {
		float shade = quad.shadeFactor();
		float r = ((color >> 16) & 0xFF) / 255f * shade;
		float g = ((color >> 8) & 0xFF) / 255f * shade;
		float b = (color & 0xFF) / 255f * shade;
		float[] p = quad.positions();
		float[] uv = quad.uvs();
		for (int i = 0; i < 4; i++) {
			float ao = lit[i * 3 + 2];
			out.vertex(p[i * 3] + x, p[i * 3 + 1] + y, p[i * 3 + 2] + z, uv[i * 2], uv[i * 2 + 1],
					r * ao, g * ao, b * ao, lit[i * 3], lit[i * 3 + 1]);
		}
	}

	// ---------- fluids ----------

	private static boolean hasFluid(BlockRender render, BlockRender.Fluid fluid) {
		return render.fluid() == fluid || render.extraFluid() == fluid;
	}

	/** FluidState.getAmount: a source or a falling column is 8, flowing level L is 8 - L. Waterlogged blocks are sources. */
	private static int amount(BlockRender render, BlockRender.Fluid fluid) {
		if (render.fluid() != fluid) {
			return 8;
		}
		int level = render.level();
		return level == 0 || level >= 8 ? 8 : 8 - level;
	}

	/** LiquidBlockRenderer.getHeight: 1 under the same fluid, amount / 9 for this fluid, -1 for solid, else 0. */
	private static float height(Cells cells, BlockRender.Fluid fluid, int x, int y, int z) {
		BlockRender here = cells.render(x, y, z);
		if (hasFluid(here, fluid)) {
			if (hasFluid(cells.render(x, y + 1, z), fluid)) {
				return 1f;
			}
			return amount(here, fluid) / 9f;
		}
		return here.opaque() ? -1f : 0f;
	}

	/** LiquidBlockRenderer.calculateAverageHeight, with heights >= 0.8 weighted ten times. */
	private static float corner(Cells cells, BlockRender.Fluid fluid, float center, float a, float b, int dx, int dy, int dz) {
		if (a >= 1f || b >= 1f) {
			return 1f;
		}
		float[] sum = new float[2];
		if (a > 0f || b > 0f) {
			float diagonal = height(cells, fluid, dx, dy, dz);
			if (diagonal >= 1f) {
				return 1f;
			}
			weigh(sum, diagonal);
		}
		weigh(sum, center);
		weigh(sum, b);
		weigh(sum, a);
		return sum[1] == 0f ? 0f : sum[0] / sum[1];
	}

	private static void weigh(float[] sum, float h) {
		if (h >= 0.8f) {
			sum[0] += h * 10f;
			sum[1] += 10f;
		} else if (h >= 0f) {
			sum[0] += h;
			sum[1] += 1f;
		}
	}

	/** FlowingFluid.getFlow, horizontal part: pushes from higher toward lower neighbors, including over a drop. */
	private static float[] flow(Cells cells, BlockRender.Fluid fluid, int x, int y, int z) {
		float own = amount(cells.render(x, y, z), fluid) / 9f;
		float fx = 0f, fz = 0f;
		for (int d = 2; d < 6; d++) {
			int[] o = OFFSETS[d];
			BlockRender next = cells.render(x + o[0], y, z + o[2]);
			float g = 0f;
			if (hasFluid(next, fluid)) {
				g = own - amount(next, fluid) / 9f;
			} else if (!next.opaque()) {
				BlockRender below = cells.render(x + o[0], y - 1, z + o[2]);
				if (hasFluid(below, fluid)) {
					g = own - (amount(below, fluid) / 9f - 0.8888889f);
				}
			}
			fx += o[0] * g;
			fz += o[2] * g;
		}
		return new float[] {fx, fz};
	}

	private static void fluid(MeshBuffer out, Cells cells, Atlas atlas, Tints tints, BiomeInfo biome, BlockRender.Fluid fluid, int x, int y, int z) {
		boolean water = fluid == BlockRender.Fluid.WATER;
		Atlas.Rect still = atlas.rect(water ? WATER : LAVA);
		Atlas.Rect flowing = atlas.rect(water ? WATER_FLOW : LAVA_FLOW);
		if (flowing == null) {
			flowing = still;
		}
		if (still == null) {
			return;
		}
		int color = water ? tints.water(biome) : 0xFFFFFF;
		float r = ((color >> 16) & 0xFF) / 255f;
		float g = ((color >> 8) & 0xFF) / 255f;
		float b = (color & 0xFF) / 255f;
		int own = cells.light(x, y, z);
		boolean sameAbove = hasFluid(cells.render(x, y + 1, z), fluid);
		float h = height(cells, fluid, x, y, z);
		float hN, hS, hE, hW, nw, ne, se, sw;
		if (h >= 1f) {
			nw = ne = se = sw = 1f;
		} else {
			hN = height(cells, fluid, x, y, z - 1);
			hS = height(cells, fluid, x, y, z + 1);
			hE = height(cells, fluid, x + 1, y, z);
			hW = height(cells, fluid, x - 1, y, z);
			nw = corner(cells, fluid, h, hN, hW, x - 1, y, z - 1);
			ne = corner(cells, fluid, h, hN, hE, x + 1, y, z - 1);
			se = corner(cells, fluid, h, hS, hE, x + 1, y, z + 1);
			sw = corner(cells, fluid, h, hS, hW, x - 1, y, z + 1);
		}
		if (!sameAbove) {
			int up = Math.max(own, cells.light(x, y + 1, z));
			float sky = Math.max(own >> 4, up >> 4), blk = Math.max(own & 15, up & 15);
			float[] f = flow(cells, fluid, x, y, z);
			float[] uv;
			Atlas.Rect sprite;
			if (f[0] == 0f && f[1] == 0f) {
				sprite = still;
				uv = new float[] {0f, 0f, 0f, 1f, 1f, 1f, 1f, 0f};
			} else {
				sprite = flowing;
				float angle = (float) Math.atan2(f[1], f[0]) - (float) Math.PI / 2f;
				float s = (float) Math.sin(angle) * 0.25f;
				float c = (float) Math.cos(angle) * 0.25f;
				uv = new float[] {
					0.5f + (-c - s), 0.5f + (-c + s),
					0.5f + (-c + s), 0.5f + (c + s),
					0.5f + (c + s), 0.5f + (c - s),
					0.5f + (c - s), 0.5f + (-c - s)};
			}
			float[][] corners = {{0, nw - 0.001f, 0}, {0, sw - 0.001f, 1}, {1, se - 0.001f, 1}, {1, ne - 0.001f, 0}};
			fluidQuad(out, atlas, sprite, corners, uv, x, y, z, r, g, b, sky, blk);
		}
		BlockRender below = cells.render(x, y - 1, z);
		if (!hasFluid(below, fluid) && !below.opaque()) {
			int down = cells.light(x, y - 1, z);
			float[][] corners = {{0, 0.001f, 1}, {0, 0.001f, 0}, {1, 0.001f, 0}, {1, 0.001f, 1}};
			fluidQuad(out, atlas, still, corners, new float[] {0, 1, 0, 0, 1, 0, 1, 1}, x, y, z, r * 0.5f, g * 0.5f, b * 0.5f, down >> 4, down & 15);
		}
		// Sides: north (z0, x0->x1), south (z1, x1->x0), west (x0, z1->z0), east (x1, z0->z1); vanilla uses the flowing
		// sprite's left half, cut at the corner heights, with vanilla's face shading baked in.
		float[][] sides = {
			{2, 0, 0, 1, 0, nw, ne, 0.8f},
			{3, 1, 1, 0, 1, se, sw, 0.8f},
			{4, 0, 1, 0, 0, sw, nw, 0.6f},
			{5, 1, 0, 1, 1, ne, se, 0.6f}};
		for (float[] side : sides) {
			int d = (int) side[0];
			int[] o = OFFSETS[d];
			BlockRender next = cells.render(x + o[0], y, z + o[2]);
			if (hasFluid(next, fluid) || next.opaque()) {
				continue;
			}
			float x0 = side[1], z0 = side[2], x1 = side[3], z1 = side[4], h0 = side[5], h1 = side[6];
			float[][] corners = {{x0, h0, z0}, {x1, h1, z1}, {x1, 0, z1}, {x0, 0, z0}};
			float[] uv = {0f, (1f - h0) * 0.5f, 0.5f, (1f - h1) * 0.5f, 0.5f, 0.5f, 0f, 0.5f};
			int light = Math.max(own, cells.light(x + o[0], y, z + o[2]));
			fluidQuad(out, atlas, flowing, corners, uv, x, y, z, r * side[7], g * side[7], b * side[7], light >> 4, light & 15);
		}
	}

	/** Emits both windings so the surface shows from above and from under water. UVs are fractions of the sprite. */
	private static void fluidQuad(MeshBuffer out, Atlas atlas, Atlas.Rect sprite, float[][] corners, float[] uv,
			int x, int y, int z, float r, float g, float b, float sky, float blk) {
		float size = atlas.size();
		for (int pass = 0; pass < 2; pass++) {
			for (int k = 0; k < 4; k++) {
				int i = pass == 0 ? k : 3 - k;
				out.vertex(corners[i][0] + x, corners[i][1] + y, corners[i][2] + z,
						(sprite.x() + uv[i * 2] * sprite.w()) / size,
						(sprite.y() + uv[i * 2 + 1] * sprite.h()) / size,
						r, g, b, sky, blk);
			}
		}
	}

	// ---------- greedy ----------

	private static void merge(MeshBuffer out, Atlas atlas, int d, int[] mask, List<GreedyKey> keys) {
		int[] cell = new int[3];
		int normal = d < 2 ? 1 : d < 4 ? 2 : 0;
		int axisA = d < 2 ? 0 : d < 4 ? 0 : 2;
		int axisB = d < 2 ? 2 : 1;
		int[] slice = new int[256];
		for (int layer = 0; layer < 16; layer++) {
			boolean any = false;
			for (int b = 0; b < 16; b++) {
				for (int a = 0; a < 16; a++) {
					cell[normal] = layer;
					cell[axisA] = a;
					cell[axisB] = b;
					int key = mask[(cell[1] * 16 + cell[2]) * 16 + cell[0]];
					slice[b * 16 + a] = key;
					any |= key != 0;
				}
			}
			if (!any) {
				continue;
			}
			for (int b = 0; b < 16; b++) {
				for (int a = 0; a < 16; ) {
					int key = slice[b * 16 + a];
					if (key == 0) {
						a++;
						continue;
					}
					int w = 1;
					while (a + w < 16 && slice[b * 16 + a + w] == key) {
						w++;
					}
					int h = 1;
					grow:
					while (b + h < 16) {
						for (int k = 0; k < w; k++) {
							if (slice[(b + h) * 16 + a + k] != key) {
								break grow;
							}
						}
						h++;
					}
					for (int bb = 0; bb < h; bb++) {
						for (int aa = 0; aa < w; aa++) {
							slice[(b + bb) * 16 + a + aa] = 0;
						}
					}
					emitMerged(out, atlas, d, normal, axisA, axisB, layer, a, b, w, h, keys.get(key));
					a += w;
				}
			}
		}
	}

	private static void emitMerged(MeshBuffer out, Atlas atlas, int d, int normal, int axisA, int axisB, int layer,
			int a, int b, int w, int h, GreedyKey key) {
		float[] from = new float[3];
		float[] to = new float[3];
		float plane = layer + (d % 2 == 1 ? 1 : 0);
		from[normal] = plane;
		to[normal] = plane;
		from[axisA] = a;
		to[axisA] = a + w;
		from[axisB] = b;
		to[axisB] = b + h;
		float[] pos = BlockModels.facePositions(d, from, to);
		Atlas.Rect rect = atlas.rect(key.texture);
		float ao = key.ao * BakedQuad.FACE_SHADE[d];
		float r = ((key.color >> 16) & 0xFF) / 255f * ao;
		float g = ((key.color >> 8) & 0xFF) / 255f * ao;
		float bl = (key.color & 0xFF) / 255f * ao;
		for (int i = 0; i < 4; i++) {
			float x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
			float u;
			float v;
			switch (d) {
				case 0 -> { u = x - from[0]; v = to[2] - z; }
				case 1 -> { u = x - from[0]; v = z - from[2]; }
				case 2 -> { u = to[0] - x; v = to[1] - y; }
				case 3 -> { u = x - from[0]; v = to[1] - y; }
				case 4 -> { u = z - from[2]; v = to[1] - y; }
				default -> { u = to[2] - z; v = to[1] - y; }
			}
			out.vertex(x, y, z, (rect.x() + u * rect.w()) / atlas.size(), (rect.y() + v * rect.h()) / atlas.size(),
					r, g, bl, key.sky, key.block);
		}
	}

	private static BiomeInfo biome(SectionSnapshot snapshot, int x, int y, int z) {
		int cell = snapshot.biomeCells()[((y >> 2) * 4 + (z >> 2)) * 4 + (x >> 2)];
		String[] biomes = snapshot.biomes();
		if (cell < 0 || cell >= biomes.length) {
			return null;
		}
		return snapshot.biomeInfo().get(biomes[cell]);
	}

	// Same mixing as vanilla Mth.getSeed, so weighted variants spread the way players are used to.
	private static int seed(int x, int y, int z) {
		long seed = (long) (x * 3129871) ^ (long) z * 116129781L ^ (long) y;
		seed = seed * seed * 42317861L + seed * 11L;
		return (int) (seed >> 16);
	}

	/**
	 * {@code emitters} is 4 bytes per entry: x, y, z inside the section, then the EMIT_* kind. {@code specials} is 5 bytes
	 * per chest: x, y, z, {@link #chestKind} and the light (sky << 4 | block) in its cell.
	 */
	public record Mesh(float[] data, int vertexCount, byte[] emitters, byte[] specials) {
	}

	private record GreedyKey(String texture, int color, float sky, float block, float ao) {
	}
}
