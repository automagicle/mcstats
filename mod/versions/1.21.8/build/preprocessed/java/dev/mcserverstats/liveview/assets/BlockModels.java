package dev.mcserverstats.liveview.assets;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.json.Json;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Resource-pack block models: blockstate {@code variants} and {@code multipart}, model {@code parent} chains,
 * texture variables, element faces with {@code uv}, face {@code rotation}, {@code cullface} and {@code tintindex},
 * element {@code rotation}, variant {@code x}/{@code y} and {@code uvlock}. Bakes lazily per block state string on
 * mesh workers and caches the result. Never touches Minecraft classes.
 */
public final class BlockModels {
	static final String[] DIRECTIONS = {"down", "up", "north", "south", "west", "east"};
	private static final int[][] NORMALS = {{0, -1, 0}, {0, 1, 0}, {0, 0, -1}, {0, 0, 1}, {-1, 0, 0}, {1, 0, 0}};
	private static final Set<String> IMPLICIT_WATER = Set.of(
			"minecraft:kelp", "minecraft:kelp_plant", "minecraft:seagrass", "minecraft:tall_seagrass", "minecraft:bubble_column");

	private final Map<String, byte[]> blockstateFiles;
	private final Map<String, byte[]> modelFiles;
	private final Atlas atlas;
	private final Map<String, Json.Obj> parsedStates = new ConcurrentHashMap<>();
	private final Map<String, Resolved> resolved = new ConcurrentHashMap<>();
	private final Map<String, List<BakedQuad>> baked = new ConcurrentHashMap<>();
	private final Map<String, BlockRender> renders = new ConcurrentHashMap<>();

	BlockModels(Map<String, byte[]> blockstateFiles, Map<String, byte[]> modelFiles, Atlas atlas) {
		this.blockstateFiles = Map.copyOf(blockstateFiles);
		this.modelFiles = Map.copyOf(modelFiles);
		this.atlas = atlas;
	}

	public Atlas atlas() {
		return atlas;
	}

	/** Returns the render for a state like {@code minecraft:oak_stairs[facing=east,half=bottom]}, never null. */
	public BlockRender render(String state) {
		BlockRender cached = renders.get(state);
		if (cached != null) {
			return cached;
		}
		BlockRender made;
		try {
			made = bake(state);
		} catch (RuntimeException e) {
			LogOnce.warn("bake-" + blockOf(state), "Liveview skipped " + blockOf(state) + " because its model failed to bake", e);
			made = BlockRender.AIR;
		}
		renders.putIfAbsent(state, made);
		return renders.get(state);
	}

	private BlockRender bake(String state) {
		String block = blockOf(state);
		Map<String, String> props = propsOf(state);
		if (block.equals("minecraft:air") || block.equals("minecraft:cave_air") || block.equals("minecraft:void_air")) {
			return BlockRender.AIR;
		}
		BlockRender.Fluid fluid = BlockRender.Fluid.NONE;
		if (block.equals("minecraft:water")) {
			fluid = BlockRender.Fluid.WATER;
		} else if (block.equals("minecraft:lava")) {
			fluid = BlockRender.Fluid.LAVA;
		}
		BlockRender.Fluid extra = "true".equals(props.get("waterlogged")) || IMPLICIT_WATER.contains(block)
				? BlockRender.Fluid.WATER
				: BlockRender.Fluid.NONE;
		int power = parseInt(props.get("power"));
		int age = parseInt(props.get("age"));
		// Fluid "level": 0 is a source, 1-7 flow outward, 8-15 are falling (VERIFIED: LiquidBlock.LEVEL in the 26.2 jar).
		int level = fluid == BlockRender.Fluid.NONE ? 0 : parseInt(props.get("level"));
		List<BlockRender.Part> parts = fluid == BlockRender.Fluid.NONE ? parts(block, props) : List.of();
		if (parts == null) {
			return new BlockRender(block, List.of(), false, false, fluid, extra, power, age, level);
		}
		boolean full = fullCube(parts);
		boolean opaque = full && opaque(parts);
		return new BlockRender(block, parts, full, opaque, fluid, extra, power, age, level);
	}

	private List<BlockRender.Part> parts(String block, Map<String, String> props) {
		Json.Obj root = blockstate(block);
		if (root == null) {
			LogOnce.warn("blockstate-" + block, "Liveview has no blockstate file for " + block + "; it is not drawn", null);
			return null;
		}
		List<BlockRender.Part> parts = new ArrayList<>();
		Json.Obj variants = root.object("variants");
		if (variants != null) {
			for (Map.Entry<String, Json.Value> entry : variants.fields().entrySet()) {
				if (matchesVariant(entry.getKey(), props)) {
					BlockRender.Part part = part(block, entry.getValue());
					if (part != null) {
						parts.add(part);
					}
					break;
				}
			}
		}
		Json.Arr multipart = root.array("multipart");
		if (multipart != null) {
			for (Json.Value item : multipart.items()) {
				if (!(item instanceof Json.Obj caseObj)) {
					continue;
				}
				Json.Value when = caseObj.get("when");
				if (when != null && !matchesWhen(when, props)) {
					continue;
				}
				BlockRender.Part part = part(block, caseObj.get("apply"));
				if (part != null) {
					parts.add(part);
				}
			}
		}
		if (parts.isEmpty() && variants == null && multipart == null) {
			LogOnce.warn("blockstate-shape-" + block, "Liveview could not read the blockstate file for " + block, null);
			return null;
		}
		return List.copyOf(parts);
	}

	private BlockRender.Part part(String block, Json.Value apply) {
		List<Json.Obj> options = new ArrayList<>();
		if (apply instanceof Json.Obj one) {
			options.add(one);
		} else if (apply instanceof Json.Arr many) {
			for (Json.Value value : many.items()) {
				if (value instanceof Json.Obj obj) {
					options.add(obj);
				}
			}
		}
		List<List<BakedQuad>> choices = new ArrayList<>();
		List<Integer> weights = new ArrayList<>();
		for (Json.Obj option : options) {
			String model = option.string("model");
			if (model == null) {
				continue;
			}
			int x = intOr(option, "x", 0);
			int y = intOr(option, "y", 0);
			boolean uvlock = Boolean.TRUE.equals(option.bool("uvlock"));
			List<BakedQuad> quads = bakeModel(block, normalize(model), x, y, uvlock);
			if (quads == null) {
				continue;
			}
			choices.add(quads);
			weights.add(Math.max(1, intOr(option, "weight", 1)));
		}
		if (choices.isEmpty()) {
			return null;
		}
		int[] w = new int[weights.size()];
		int total = 0;
		for (int i = 0; i < w.length; i++) {
			w[i] = weights.get(i);
			total += w[i];
		}
		return new BlockRender.Part(List.copyOf(choices), w, total);
	}

	private List<BakedQuad> bakeModel(String block, String model, int rotX, int rotY, boolean uvlock) {
		String key = model + "|" + rotX + "|" + rotY + "|" + uvlock;
		List<BakedQuad> cached = baked.get(key);
		if (cached != null) {
			return cached;
		}
		Resolved source = resolve(model);
		if (source == null) {
			LogOnce.warn("model-" + model, "Liveview has no model " + model + " (used by " + block + "); it is not drawn", null);
			return null;
		}
		List<BakedQuad> quads = new ArrayList<>();
		for (Json.Value value : source.elements) {
			if (value instanceof Json.Obj element) {
				bakeElement(model, source, element, rotX, rotY, uvlock, quads);
			}
		}
		List<BakedQuad> result = List.copyOf(quads);
		baked.putIfAbsent(key, result);
		return baked.get(key);
	}

	private void bakeElement(String model, Resolved source, Json.Obj element, int rotX, int rotY, boolean uvlock, List<BakedQuad> out) {
		float[] from = vec(element.array("from"));
		float[] to = vec(element.array("to"));
		Json.Obj faces = element.object("faces");
		if (from == null || to == null || faces == null) {
			return;
		}
		Json.Obj rotation = element.object("rotation");
		boolean shade = !Boolean.FALSE.equals(element.bool("shade"));
		for (int d = 0; d < 6; d++) {
			Json.Obj face = faces.object(DIRECTIONS[d]);
			if (face == null) {
				continue;
			}
			float[] pos = facePositions(d, from, to);
			float[] uv = faceUv(d, from, to, face);
			if (rotation != null) {
				rotateElement(pos, rotation);
			}
			int facing = d;
			int cull = direction(face.string("cullface"));
			if (rotX != 0 || rotY != 0) {
				rotateVariant(pos, rotX, rotY);
				facing = rotateDirection(d, rotX, rotY);
				if (cull >= 0) {
					cull = rotateDirection(cull, rotX, rotY);
				}
				if (uvlock) {
					uv = projectUv(facing, pos);
				}
			}
			TextureRef texture = texture(model, source, face.get("texture"));
			Atlas.Rect rect = atlas.rect(texture.key);
			String atlasKey = atlas.has(texture.key) ? texture.key : Atlas.MISSING;
			boolean full = fullFace(facing, pos);
			boolean canonical = full && sameUv(uv, projectUv(facing, pos));
			Integer tint = face.integer("tintindex");
			float[] atlasUv = new float[8];
			for (int i = 0; i < 4; i++) {
				atlasUv[i * 2] = (rect.x() + uv[i * 2] / 16f * rect.w()) / atlas.size();
				atlasUv[i * 2 + 1] = (rect.y() + uv[i * 2 + 1] / 16f * rect.h()) / atlas.size();
			}
			float[] blockPos = new float[12];
			for (int i = 0; i < 12; i++) {
				blockPos[i] = pos[i] / 16f;
			}
			out.add(new BakedQuad(blockPos, atlasUv, cull, facing, tint == null ? -1 : tint, atlasKey, canonical, shade, source.ambientOcclusion));
		}
	}

	// Vertex order per face matches vanilla FaceInfo: counter-clockwise seen from outside, vertex 0 at the (u0, v0)
	// corner of the default UV.
	public static float[] facePositions(int d, float[] f, float[] t) {
		float x0 = f[0], y0 = f[1], z0 = f[2], x1 = t[0], y1 = t[1], z1 = t[2];
		return switch (d) {
			case 0 -> new float[] {x0, y0, z1, x0, y0, z0, x1, y0, z0, x1, y0, z1};
			case 1 -> new float[] {x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0};
			case 2 -> new float[] {x1, y1, z0, x1, y0, z0, x0, y0, z0, x0, y1, z0};
			case 3 -> new float[] {x0, y1, z1, x0, y0, z1, x1, y0, z1, x1, y1, z1};
			case 4 -> new float[] {x0, y1, z0, x0, y0, z0, x0, y0, z1, x0, y1, z1};
			default -> new float[] {x1, y1, z1, x1, y0, z1, x1, y0, z0, x1, y1, z0};
		};
	}

	private static float[] faceUv(int d, float[] f, float[] t, Json.Obj face) {
		float[] rect = vec4(face.array("uv"));
		if (rect == null) {
			rect = switch (d) {
				case 0 -> new float[] {f[0], 16 - t[2], t[0], 16 - f[2]};
				case 1 -> new float[] {f[0], f[2], t[0], t[2]};
				case 2 -> new float[] {16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]};
				case 3 -> new float[] {f[0], 16 - t[1], t[0], 16 - f[1]};
				case 4 -> new float[] {f[2], 16 - t[1], t[2], 16 - f[1]};
				default -> new float[] {16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]};
			};
		}
		float[][] corners = {
				{rect[0], rect[1]},
				{rect[0], rect[3]},
				{rect[2], rect[3]},
				{rect[2], rect[1]}
		};
		int shift = Math.floorMod(intOr(face, "rotation", 0) / 90, 4);
		float[] uv = new float[8];
		for (int i = 0; i < 4; i++) {
			float[] corner = corners[(i + shift) % 4];
			uv[i * 2] = corner[0];
			uv[i * 2 + 1] = corner[1];
		}
		return uv;
	}

	/** Default UV projection of block-space positions (0..16) onto a face, the same one vanilla uses for unspecified UVs. */
	public static float[] projectUv(int d, float[] pos) {
		float[] uv = new float[8];
		for (int i = 0; i < 4; i++) {
			float x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
			float u;
			float v;
			switch (d) {
				case 0 -> { u = x; v = 16 - z; }
				case 1 -> { u = x; v = z; }
				case 2 -> { u = 16 - x; v = 16 - y; }
				case 3 -> { u = x; v = 16 - y; }
				case 4 -> { u = z; v = 16 - y; }
				default -> { u = 16 - z; v = 16 - y; }
			}
			uv[i * 2] = u;
			uv[i * 2 + 1] = v;
		}
		return uv;
	}

	private static boolean sameUv(float[] a, float[] b) {
		for (int i = 0; i < 8; i++) {
			if (Math.abs(a[i] - b[i]) > 1.0e-3f) {
				return false;
			}
		}
		return true;
	}

	private static boolean fullFace(int d, float[] pos) {
		int axis = d / 2 == 0 ? 1 : d / 2 == 1 ? 2 : 0;
		float plane = d % 2 == 0 ? 0f : 16f;
		float minA = Float.MAX_VALUE, maxA = -Float.MAX_VALUE, minB = Float.MAX_VALUE, maxB = -Float.MAX_VALUE;
		int a = (axis + 1) % 3;
		int b = (axis + 2) % 3;
		for (int i = 0; i < 4; i++) {
			if (Math.abs(pos[i * 3 + axis] - plane) > 1.0e-3f) {
				return false;
			}
			minA = Math.min(minA, pos[i * 3 + a]);
			maxA = Math.max(maxA, pos[i * 3 + a]);
			minB = Math.min(minB, pos[i * 3 + b]);
			maxB = Math.max(maxB, pos[i * 3 + b]);
		}
		return minA <= 1.0e-3f && minB <= 1.0e-3f && maxA >= 16 - 1.0e-3f && maxB >= 16 - 1.0e-3f;
	}

	// Legacy form {"origin", "axis", "angle", "rescale"}. The 26.2 form {"x", "y", "z", "origin"} (only hanging sign
	// chain models use it) is applied as X, then Y, then Z; that order is an assumption, not read from the client.
	private static void rotateElement(float[] pos, Json.Obj rotation) {
		float[] origin = vec(rotation.array("origin"));
		if (origin == null) {
			origin = new float[] {8, 8, 8};
		}
		String axis = rotation.string("axis");
		Double angle = rotation.number("angle");
		if (axis != null && angle != null) {
			double radians = Math.toRadians(angle);
			boolean rescale = Boolean.TRUE.equals(rotation.bool("rescale"));
			double scale = rescale && Math.abs(Math.cos(radians)) > 1.0e-6 ? 1.0 / Math.cos(radians) : 1.0;
			int axisIndex = switch (axis) {
				case "x" -> 0;
				case "z" -> 2;
				default -> 1;
			};
			rotate(pos, origin, axisIndex, radians, scale);
			return;
		}
		Double rx = rotation.number("x");
		Double ry = rotation.number("y");
		Double rz = rotation.number("z");
		if (rx != null) {
			rotate(pos, origin, 0, Math.toRadians(rx), 1.0);
		}
		if (ry != null) {
			rotate(pos, origin, 1, Math.toRadians(ry), 1.0);
		}
		if (rz != null) {
			rotate(pos, origin, 2, Math.toRadians(rz), 1.0);
		}
	}

	private static void rotate(float[] pos, float[] origin, int axis, double radians, double scale) {
		double c = Math.cos(radians);
		double s = Math.sin(radians);
		for (int i = 0; i < 4; i++) {
			double x = pos[i * 3] - origin[0];
			double y = pos[i * 3 + 1] - origin[1];
			double z = pos[i * 3 + 2] - origin[2];
			double nx = x, ny = y, nz = z;
			switch (axis) {
				case 0 -> {
					ny = (y * c - z * s) * scale;
					nz = (y * s + z * c) * scale;
				}
				case 1 -> {
					nx = (x * c + z * s) * scale;
					nz = (-x * s + z * c) * scale;
				}
				default -> {
					nx = (x * c - y * s) * scale;
					ny = (x * s + y * c) * scale;
				}
			}
			pos[i * 3] = (float) (nx + origin[0]);
			pos[i * 3 + 1] = (float) (ny + origin[1]);
			pos[i * 3 + 2] = (float) (nz + origin[2]);
		}
	}

	// Blockstate rotation: X first, then Y, both by the negative angle around the block centre, matching vanilla
	// (y=90 turns an east-facing model south; x=270 turns north to up).
	private static void rotateVariant(float[] pos, int rotX, int rotY) {
		float[] centre = {8, 8, 8};
		if (rotX != 0) {
			rotate(pos, centre, 0, Math.toRadians(-rotX), 1.0);
		}
		if (rotY != 0) {
			rotate(pos, centre, 1, Math.toRadians(-rotY), 1.0);
		}
		for (int i = 0; i < pos.length; i++) {
			pos[i] = Math.round(pos[i] * 1024f) / 1024f;
		}
	}

	static int rotateDirection(int d, int rotX, int rotY) {
		float[] normal = {NORMALS[d][0], NORMALS[d][1], NORMALS[d][2]};
		float[] point = {normal[0] + 8, normal[1] + 8, normal[2] + 8, 8, 8, 8, 8, 8, 8, 8, 8, 8};
		rotateVariant(point, rotX, rotY);
		float x = point[0] - 8, y = point[1] - 8, z = point[2] - 8;
		for (int i = 0; i < 6; i++) {
			if (Math.abs(NORMALS[i][0] - x) < 0.01f && Math.abs(NORMALS[i][1] - y) < 0.01f && Math.abs(NORMALS[i][2] - z) < 0.01f) {
				return i;
			}
		}
		return d;
	}

	private static boolean fullCube(List<BlockRender.Part> parts) {
		boolean[] covered = new boolean[6];
		for (BlockRender.Part part : parts) {
			for (BakedQuad quad : part.choices().get(0)) {
				if (quad.cull() >= 0 && quad.cull() == quad.facing() && fullFace(quad.facing(), scaled(quad.positions()))) {
					covered[quad.facing()] = true;
				}
			}
		}
		for (boolean side : covered) {
			if (!side) {
				return false;
			}
		}
		return true;
	}

	private boolean opaque(List<BlockRender.Part> parts) {
		for (BlockRender.Part part : parts) {
			for (BakedQuad quad : part.choices().get(0)) {
				if (quad.cull() >= 0 && quad.cull() == quad.facing() && quad.tintIndex() < 0 && !atlas.opaque().contains(quad.texture())) {
					return false;
				}
				if (quad.cull() >= 0 && quad.cull() == quad.facing() && quad.tintIndex() >= 0
						&& !atlas.opaque().contains(quad.texture()) && isBaseLayer(part, quad)) {
					return false;
				}
			}
		}
		return true;
	}

	// A tinted face counts toward opacity only when it is the only full face on that side, so a grass block's
	// transparent side overlay does not stop the block from occluding.
	private static boolean isBaseLayer(BlockRender.Part part, BakedQuad quad) {
		int count = 0;
		for (BakedQuad other : part.choices().get(0)) {
			if (other.cull() == quad.cull() && other.facing() == quad.facing()) {
				count++;
			}
		}
		return count == 1;
	}

	private static float[] scaled(float[] blockPos) {
		float[] out = new float[blockPos.length];
		for (int i = 0; i < out.length; i++) {
			out[i] = blockPos[i] * 16f;
		}
		return out;
	}

	/**
	 * An item's model as the item renderer sees it: {@code builtin/generated} layers (flat sprites the client extrudes),
	 * or baked element quads like a block. {@code display} is merged down the parent chain per context, child first.
	 */
	public record ItemModel(boolean generated, List<String> layers, Map<String, float[]> display, String guiLight,
			List<BakedQuad> quads, String particle) {
	}

	private final Map<String, ItemModel> itemModels = new ConcurrentHashMap<>();

	public ItemModel itemModel(String model) {
		ItemModel cached = itemModels.get(model);
		if (cached != null) {
			return cached;
		}
		boolean generated = false;
		Map<String, float[]> display = new LinkedHashMap<>();
		String guiLight = null;
		String current = model;
		boolean any = false;
		for (int depth = 0; depth < 32 && current != null; depth++) {
			if (current.endsWith("builtin/generated")) {
				generated = true;
				break;
			}
			if (current.startsWith("builtin/") || current.startsWith("minecraft:builtin/")) {
				break;
			}
			Json.Obj obj = modelJson(current);
			if (obj == null) {
				break;
			}
			any = true;
			if (guiLight == null) {
				guiLight = obj.string("gui_light");
			}
			Json.Obj shown = obj.object("display");
			if (shown != null) {
				for (Map.Entry<String, Json.Value> entry : shown.fields().entrySet()) {
					if (display.containsKey(entry.getKey()) || !(entry.getValue() instanceof Json.Obj t)) {
						continue;
					}
					float[] r = vec(t.array("rotation"));
					float[] tr = vec(t.array("translation"));
					float[] sc = vec(t.array("scale"));
					display.put(entry.getKey(), new float[] {
						r == null ? 0 : r[0], r == null ? 0 : r[1], r == null ? 0 : r[2],
						tr == null ? 0 : tr[0], tr == null ? 0 : tr[1], tr == null ? 0 : tr[2],
						sc == null ? 1 : sc[0], sc == null ? 1 : sc[1], sc == null ? 1 : sc[2]});
				}
			}
			String parent = obj.string("parent");
			current = parent == null ? null : normalize(parent);
		}
		if (!any) {
			return null;
		}
		Resolved source = resolve(model);
		List<String> layers = new ArrayList<>();
		List<BakedQuad> quads = List.of();
		String particle = null;
		if (source != null) {
			if (source.textures.containsKey("particle")) {
				particle = texture(model, source, source.textures.get("particle")).key;
			}
			if (generated) {
				for (int i = 0; i < 10; i++) {
					Json.Value layer = source.textures.get("layer" + i);
					if (layer == null) {
						break;
					}
					layers.add(texture(model, source, layer).key);
				}
			} else if (!source.elements.isEmpty()) {
				List<BakedQuad> made = bakeModel("item", model, 0, 0, false);
				quads = made == null ? List.of() : made;
			}
		}
		ItemModel made = new ItemModel(generated, List.copyOf(layers), Map.copyOf(display),
				guiLight == null ? "side" : guiLight, quads, particle);
		itemModels.putIfAbsent(model, made);
		return itemModels.get(model);
	}

	private Resolved resolve(String model) {
		Resolved cached = resolved.get(model);
		if (cached != null) {
			return cached;
		}
		List<Json.Obj> chain = new ArrayList<>();
		String current = model;
		for (int depth = 0; depth < 32 && current != null; depth++) {
			if (current.startsWith("builtin/") || current.startsWith("minecraft:builtin/")) {
				break;
			}
			Json.Obj obj = modelJson(current);
			if (obj == null) {
				if (depth == 0) {
					return null;
				}
				LogOnce.warn("model-parent-" + current, "Liveview has no parent model " + current + " (from " + model + ")", null);
				break;
			}
			chain.add(obj);
			String parent = obj.string("parent");
			current = parent == null ? null : normalize(parent);
		}
		Map<String, Json.Value> textures = new LinkedHashMap<>();
		List<Json.Value> elements = List.of();
		boolean ambientOcclusion = true;
		for (int i = chain.size() - 1; i >= 0; i--) {
			Json.Obj obj = chain.get(i);
			Boolean ao = obj.bool("ambientocclusion");
			if (ao != null) {
				ambientOcclusion = ao;
			}
			Json.Obj tex = obj.object("textures");
			if (tex != null) {
				textures.putAll(tex.fields());
			}
			Json.Arr els = obj.array("elements");
			if (els != null) {
				elements = els.items();
			}
		}
		Resolved made = new Resolved(Map.copyOf(textures), List.copyOf(elements), ambientOcclusion);
		resolved.putIfAbsent(model, made);
		return resolved.get(model);
	}

	private TextureRef texture(String model, Resolved source, Json.Value ref) {
		Json.Value current = ref;
		for (int depth = 0; depth < 16; depth++) {
			String name = null;
			if (current instanceof Json.Str str) {
				name = str.value();
			} else if (current instanceof Json.Obj obj) {
				name = obj.string("sprite");
			}
			if (name == null) {
				break;
			}
			if (name.startsWith("#")) {
				current = source.textures.get(name.substring(1));
				continue;
			}
			String key = normalize(name);
			if (!atlas.has(key)) {
				LogOnce.warn("texture-" + key, "Liveview has no texture " + key + " (used by " + model + "); drawing the missing texture", null);
			}
			return new TextureRef(key);
		}
		LogOnce.warn("texture-ref-" + model, "Liveview could not resolve a texture variable in " + model, null);
		return new TextureRef(Atlas.MISSING);
	}

	private Json.Obj blockstate(String block) {
		Json.Obj cached = parsedStates.get(block);
		if (cached != null) {
			return cached;
		}
		byte[] bytes = blockstateFiles.get(block);
		Json.Obj parsed = parseObject(bytes, "blockstate " + block);
		if (parsed != null) {
			parsedStates.putIfAbsent(block, parsed);
		}
		return parsed;
	}

	private final Map<String, Json.Obj> parsedModels = new ConcurrentHashMap<>();

	private Json.Obj modelJson(String model) {
		Json.Obj cached = parsedModels.get(model);
		if (cached != null) {
			return cached;
		}
		Json.Obj parsed = parseObject(modelFiles.get(model), "model " + model);
		if (parsed != null) {
			parsedModels.putIfAbsent(model, parsed);
		}
		return parsed;
	}

	private static Json.Obj parseObject(byte[] bytes, String what) {
		if (bytes == null) {
			return null;
		}
		try {
			if (Json.parse(new String(bytes, StandardCharsets.UTF_8)) instanceof Json.Obj obj) {
				return obj;
			}
		} catch (Json.JsonException e) {
			LogOnce.warn("json-" + what, "Liveview could not parse " + what + ": " + e.getMessage(), null);
		}
		return null;
	}

	private static boolean matchesVariant(String key, Map<String, String> props) {
		if (key.isEmpty() || key.equals("normal")) {
			return true;
		}
		for (String pair : key.split(",")) {
			int eq = pair.indexOf('=');
			if (eq <= 0) {
				return false;
			}
			if (!pair.substring(eq + 1).equals(props.get(pair.substring(0, eq)))) {
				return false;
			}
		}
		return true;
	}

	private static boolean matchesWhen(Json.Value when, Map<String, String> props) {
		if (!(when instanceof Json.Obj obj)) {
			return false;
		}
		Json.Arr or = obj.array("OR");
		if (or != null) {
			for (Json.Value item : or.items()) {
				if (matchesWhen(item, props)) {
					return true;
				}
			}
			return false;
		}
		Json.Arr and = obj.array("AND");
		if (and != null) {
			for (Json.Value item : and.items()) {
				if (!matchesWhen(item, props)) {
					return false;
				}
			}
			return true;
		}
		for (Map.Entry<String, Json.Value> entry : obj.fields().entrySet()) {
			String wanted;
			if (entry.getValue() instanceof Json.Str str) {
				wanted = str.value();
			} else if (entry.getValue() instanceof Json.Bool bool) {
				wanted = Boolean.toString(bool.value());
			} else if (entry.getValue() instanceof Json.Num num) {
				wanted = Integer.toString((int) num.value());
			} else {
				return false;
			}
			boolean negate = wanted.startsWith("!");
			if (negate) {
				wanted = wanted.substring(1);
			}
			String actual = props.get(entry.getKey());
			boolean hit = false;
			for (String option : wanted.split("\\|")) {
				if (option.equals(actual)) {
					hit = true;
					break;
				}
			}
			if (hit == negate) {
				return false;
			}
		}
		return true;
	}

	public static String blockOf(String state) {
		int bracket = state.indexOf('[');
		return bracket < 0 ? state : state.substring(0, bracket);
	}

	public static Map<String, String> propsOf(String state) {
		int open = state.indexOf('[');
		int close = state.lastIndexOf(']');
		if (open < 0 || close <= open) {
			return Map.of();
		}
		Map<String, String> props = new HashMap<>();
		for (String pair : state.substring(open + 1, close).split(",")) {
			int eq = pair.indexOf('=');
			if (eq > 0) {
				props.put(pair.substring(0, eq), pair.substring(eq + 1));
			}
		}
		return props;
	}

	static String normalize(String id) {
		return id.indexOf(':') >= 0 ? id : "minecraft:" + id;
	}

	private static int direction(String name) {
		if (name == null) {
			return -1;
		}
		for (int i = 0; i < 6; i++) {
			if (DIRECTIONS[i].equals(name)) {
				return i;
			}
		}
		if (name.equals("bottom")) {
			return 0;
		}
		return -1;
	}

	private static int intOr(Json.Obj obj, String key, int fallback) {
		Double value = obj.number(key);
		return value == null ? fallback : (int) Math.round(value);
	}

	private static int parseInt(String value) {
		if (value == null) {
			return 0;
		}
		try {
			return Integer.parseInt(value);
		} catch (NumberFormatException e) {
			return 0;
		}
	}

	private static float[] vec(Json.Arr arr) {
		if (arr == null || arr.items().size() != 3) {
			return null;
		}
		float[] out = new float[3];
		for (int i = 0; i < 3; i++) {
			if (!(arr.items().get(i) instanceof Json.Num num)) {
				return null;
			}
			out[i] = (float) num.value();
		}
		return out;
	}

	private static float[] vec4(Json.Arr arr) {
		if (arr == null || arr.items().size() != 4) {
			return null;
		}
		float[] out = new float[4];
		for (int i = 0; i < 4; i++) {
			if (!(arr.items().get(i) instanceof Json.Num num)) {
				return null;
			}
			out[i] = (float) num.value();
		}
		return out;
	}

	private record Resolved(Map<String, Json.Value> textures, List<Json.Value> elements, boolean ambientOcclusion) {
	}

	private record TextureRef(String key) {
	}
}
