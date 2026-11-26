package dev.mcserverstats.liveview.assets;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.json.Json;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Turns {@code assets/<ns>/items/<id>.json} (the 1.21.4+ item model definitions) into one JSON file the page draws
 * items from, for two display contexts: {@code gui} (inventory slots) and {@code hand} (third person, also dropped
 * items). The page then renders exactly what the item renderer would: baked block quads for block items, extruded
 * layer sprites for {@code builtin/generated} items, and the entity model for special renderers (chests, shulker
 * boxes, heads, shields, tridents, conduits, decorated pots).
 *
 * <p>File shape: {@code {"items":{id:{"gui":node,"hand"?:node}},"models":{modelId:model}}}. A node is
 * {@code {"m":modelId,"tints"?:[[kind,rgb]],"t"?:[14]}}, {@code {"c":[node...],"t"?}} for composites, or
 * {@code {"s":{"type","layer","tex","layer2"?,"tex2"?},"m":baseModelId,"t"?}} for specials. {@code t} is the node's
 * transformation: translation xyz, left rotation quaternion xyzw, scale xyz, right rotation quaternion xyzw. A model is
 * {@code {"g":1,"l":[textureKey...]}} (generated) or {@code {"q":[[23 numbers]...]}} (quads: 4 corners xyz in block
 * units, 4 atlas uv pairs, tint index, facing, shade), plus {@code "d":{context:[rx,ry,rz,tx,ty,tz,sx,sy,sz]}},
 * {@code "gl"} (gui_light) and {@code "p"} (particle texture).
 *
 * <p>Tint kinds: {@code c} constant (already resolved, grass included), and {@code dye}, {@code potion},
 * {@code firework}, {@code map_color}, {@code team}, {@code custom_model_data} with their default; the page swaps in the
 * stack's own color for {@code dye} and {@code potion}.
 */
public final class ItemModels {
	private static final Set<String> HAND_CONTEXTS = Set.of("thirdperson_righthand", "thirdperson_lefthand", "firstperson_righthand", "firstperson_lefthand");

	private final BlockModels blocks;
	private final Atlas atlas;
	private final Map<String, Png.Image> colormaps;
	private final Map<String, String> modelJson = new TreeMap<>();

	private ItemModels(BlockModels blocks, Atlas atlas, Map<String, Png.Image> colormaps) {
		this.blocks = blocks;
		this.atlas = atlas;
		this.colormaps = colormaps;
	}

	/** Every special-renderer texture folder the page may need, added to the atlas by the pipeline. */
	static final List<String> SPECIAL_TEXTURE_FOLDERS = List.of(
			"textures/entity/chest", "textures/entity/shulker", "textures/entity/shield", "textures/entity/conduit",
			"textures/entity/decorated_pot", "textures/entity/skeleton", "textures/entity/zombie", "textures/entity/creeper",
			"textures/entity/piglin", "textures/entity/enderdragon", "textures/entity/trident", "textures/entity/bell");

	public static byte[] build(Map<String, byte[]> definitions, BlockModels blocks, Atlas atlas, Map<String, Png.Image> colormaps) {
		ItemModels self = new ItemModels(blocks, atlas, colormaps);
		StringBuilder items = new StringBuilder();
		int count = 0;
		for (Map.Entry<String, byte[]> entry : new TreeMap<>(definitions).entrySet()) {
			try {
				if (!(Json.parse(new String(entry.getValue(), StandardCharsets.UTF_8)) instanceof Json.Obj root)) {
					continue;
				}
				Json.Obj model = root.object("model");
				if (model == null) {
					continue;
				}
				String gui = self.node(model, "gui");
				if (gui == null) {
					continue;
				}
				String hand = self.node(model, "thirdperson_righthand");
				if (count > 0) {
					items.append(',');
				}
				count++;
				string(items, entry.getKey());
				items.append(":{\"gui\":").append(gui);
				if (hand != null && !hand.equals(gui)) {
					items.append(",\"hand\":").append(hand);
				}
				items.append('}');
			} catch (Json.JsonException | RuntimeException e) {
				LogOnce.warn("item-def-" + entry.getKey(), "Liveview skipped item model " + entry.getKey() + ": " + e.getMessage(), null);
			}
		}
		StringBuilder out = new StringBuilder(items.length() + 1024 * 1024);
		out.append("{\"items\":{").append(items).append("},\"models\":{");
		boolean first = true;
		for (Map.Entry<String, String> entry : self.modelJson.entrySet()) {
			if (entry.getValue() == null) {
				continue;
			}
			if (!first) {
				out.append(',');
			}
			first = false;
			string(out, entry.getKey());
			out.append(':').append(entry.getValue());
		}
		out.append("}}");
		LogOnce.logger().info("Liveview resolved {} item models ({} distinct models)", count, self.modelJson.size());
		return out.toString().getBytes(StandardCharsets.UTF_8);
	}

	/** Walks one item model node for a display context; returns its JSON, or null for an empty model. */
	private String node(Json.Obj n, String context) {
		String type = BlockModels.normalize(n.string("type") == null ? "minecraft:model" : n.string("type"));
		String transform = transformation(n.get("transformation"));
		String body;
		switch (type) {
			case "minecraft:model" -> {
				String model = n.string("model");
				if (model == null || !model(BlockModels.normalize(model))) {
					return null;
				}
				StringBuilder b = new StringBuilder("{\"m\":");
				string(b, BlockModels.normalize(model));
				Json.Arr tints = n.array("tints");
				if (tints != null && !tints.items().isEmpty()) {
					b.append(",\"tints\":[");
					for (int i = 0; i < tints.items().size(); i++) {
						if (i > 0) {
							b.append(',');
						}
						b.append(tint(tints.items().get(i)));
					}
					b.append(']');
				}
				body = b.toString();
			}
			case "minecraft:composite" -> {
				Json.Arr models = n.array("models");
				StringBuilder b = new StringBuilder("{\"c\":[");
				int parts = 0;
				if (models != null) {
					for (Json.Value value : models.items()) {
						if (value instanceof Json.Obj child) {
							String made = node(child, context);
							if (made != null) {
								if (parts++ > 0) {
									b.append(',');
								}
								b.append(made);
							}
						}
					}
				}
				if (parts == 0) {
					return null;
				}
				body = b.append(']').toString();
			}
			case "minecraft:condition" -> {
				// Conditions (using_item, broken, fishing cast, has_component...) are false for an idle item in a slot.
				Json.Obj pick = n.object("on_false");
				return pick == null ? null : wrap(node(pick, context), transform);
			}
			case "minecraft:select" -> {
				Json.Obj pick = null;
				String property = BlockModels.normalize(String.valueOf(n.string("property")));
				Json.Arr cases = n.array("cases");
				if ("minecraft:display_context".equals(property) && cases != null) {
					for (Json.Value value : cases.items()) {
						if (value instanceof Json.Obj c && matchesContext(c.get("when"), context)) {
							pick = c.object("model");
							break;
						}
					}
				}
				if (pick == null) {
					pick = n.object("fallback");
				}
				if (pick == null && cases != null && !cases.items().isEmpty() && cases.items().get(0) instanceof Json.Obj c) {
					pick = c.object("model");
				}
				return pick == null ? null : wrap(node(pick, context), transform);
			}
			case "minecraft:range_dispatch" -> {
				Json.Arr entries = n.array("entries");
				Json.Obj pick = null;
				if (entries != null && !entries.items().isEmpty() && entries.items().get(0) instanceof Json.Obj e) {
					pick = e.object("model");
				}
				if (pick == null) {
					pick = n.object("fallback");
				}
				return pick == null ? null : wrap(node(pick, context), transform);
			}
			case "minecraft:special" -> {
				String base = n.string("base");
				Json.Obj special = n.object("model");
				if (base == null) {
					return null;
				}
				base = BlockModels.normalize(base);
				model(base);
				StringBuilder b = new StringBuilder("{\"m\":");
				string(b, base);
				String s = special == null ? null : special(special);
				if (s != null) {
					b.append(",\"s\":").append(s);
				}
				body = b.toString();
			}
			case "minecraft:empty" -> {
				return null;
			}
			default -> {
				// bundle/selected_item and other dynamic kinds: show their fallback or base, if any.
				Json.Obj pick = n.object("fallback");
				if (pick == null) {
					pick = n.object("model");
				}
				return pick == null ? null : wrap(node(pick, context), transform);
			}
		}
		return wrap(body + "}", transform);
	}

	private static String wrap(String node, String transform) {
		if (node == null || transform == null) {
			return node;
		}
		if (node.contains("\"t\":")) {
			// A nested node already has its own transformation; compose as a one-child composite.
			return "{\"c\":[" + node + "],\"t\":" + transform + "}";
		}
		return node.substring(0, node.length() - 1) + ",\"t\":" + transform + "}";
	}

	private static boolean matchesContext(Json.Value when, String context) {
		if (when instanceof Json.Str str) {
			return contextMatches(str.value(), context);
		}
		if (when instanceof Json.Arr arr) {
			for (Json.Value v : arr.items()) {
				if (v instanceof Json.Str str && contextMatches(str.value(), context)) {
					return true;
				}
			}
		}
		return false;
	}

	private static boolean contextMatches(String when, String context) {
		return when.equals(context) || (HAND_CONTEXTS.contains(context) && HAND_CONTEXTS.contains(when) && when.startsWith("thirdperson"));
	}

	/** Registers a model in the shared table; false when the model file is missing. */
	private boolean model(String id) {
		if (modelJson.containsKey(id)) {
			return modelJson.get(id) != null;
		}
		BlockModels.ItemModel m;
		try {
			m = blocks.itemModel(id);
		} catch (RuntimeException e) {
			LogOnce.warn("item-model-" + id, "Liveview could not resolve item model " + id, e);
			m = null;
		}
		if (m == null) {
			modelJson.put(id, null);
			return false;
		}
		StringBuilder b = new StringBuilder("{");
		if (m.generated()) {
			b.append("\"g\":1,\"l\":[");
			for (int i = 0; i < m.layers().size(); i++) {
				if (i > 0) {
					b.append(',');
				}
				string(b, m.layers().get(i));
			}
			b.append(']');
		} else {
			b.append("\"q\":[");
			for (int i = 0; i < m.quads().size(); i++) {
				BakedQuad q = m.quads().get(i);
				if (i > 0) {
					b.append(',');
				}
				b.append('[');
				for (float v : q.positions()) {
					num(b, v).append(',');
				}
				for (float v : q.uvs()) {
					num(b, v * 1f).append(',');
				}
				b.append(q.tintIndex()).append(',').append(q.facing()).append(',').append(q.shade() ? 1 : 0).append(']');
			}
			b.append(']');
		}
		b.append(",\"d\":{");
		boolean first = true;
		for (Map.Entry<String, float[]> d : new TreeMap<>(m.display()).entrySet()) {
			if (!first) {
				b.append(',');
			}
			first = false;
			string(b, d.getKey());
			b.append(":[");
			for (int i = 0; i < 9; i++) {
				if (i > 0) {
					b.append(',');
				}
				num(b, d.getValue()[i]);
			}
			b.append(']');
		}
		b.append("},\"gl\":");
		string(b, m.guiLight());
		if (m.particle() != null) {
			b.append(",\"p\":");
			string(b, m.particle());
		}
		modelJson.put(id, b.append('}').toString());
		return true;
	}

	/** Maps a special model to the entity layer and texture its renderer uses. Unknown kinds return just the type. */
	private String special(Json.Obj s) {
		String type = BlockModels.normalize(String.valueOf(s.string("type")));
		String texture = s.string("texture");
		String layer = null;
		String tex = null;
		String layer2 = null;
		String tex2 = null;
		switch (type) {
			case "minecraft:chest" -> {
				layer = "minecraft:chest#main";
				tex = textureKey(texture, "entity/chest/", "minecraft:normal");
			}
			case "minecraft:shulker_box" -> {
				layer = "minecraft:shulker_box#main";
				tex = textureKey(texture, "entity/shulker/", "minecraft:shulker");
			}
			case "minecraft:shield" -> {
				layer = "minecraft:shield#main";
				tex = first("minecraft:entity/shield/base_nopattern", "minecraft:entity/shield_base_nopattern", "minecraft:entity/shield/base");
			}
			case "minecraft:trident" -> {
				layer = "minecraft:trident#main";
				tex = first("minecraft:entity/trident/trident", "minecraft:entity/trident");
			}
			case "minecraft:conduit" -> {
				layer = "minecraft:conduit#shell";
				tex = first("minecraft:entity/conduit/base");
			}
			case "minecraft:decorated_pot" -> {
				layer = "minecraft:decorated_pot_base#main";
				tex = first("minecraft:entity/decorated_pot/decorated_pot_base");
				layer2 = "minecraft:decorated_pot_sides#main";
				tex2 = first("minecraft:entity/decorated_pot/decorated_pot_side");
			}
			case "minecraft:player_head" -> {
				layer = "minecraft:player_head#main";
				tex = first("minecraft:entity/player/wide/steve");
			}
			case "minecraft:head" -> {
				String kind = String.valueOf(s.string("kind")).toLowerCase(Locale.ROOT);
				switch (kind) {
					case "skeleton" -> { layer = "minecraft:skeleton_skull#main"; tex = first("minecraft:entity/skeleton/skeleton"); }
					case "wither_skeleton" -> { layer = "minecraft:wither_skeleton_skull#main"; tex = first("minecraft:entity/skeleton/wither_skeleton"); }
					case "zombie" -> { layer = "minecraft:zombie_head#main"; tex = first("minecraft:entity/zombie/zombie"); }
					case "creeper" -> { layer = "minecraft:creeper_head#main"; tex = first("minecraft:entity/creeper/creeper"); }
					case "piglin" -> { layer = "minecraft:piglin_head#main"; tex = first("minecraft:entity/piglin/piglin"); }
					case "dragon" -> { layer = "minecraft:dragon_skull#main"; tex = first("minecraft:entity/enderdragon/dragon"); }
					default -> { }
				}
			}
			case "minecraft:bell" -> {
				layer = "minecraft:bell#main";
				tex = first("minecraft:entity/bell/bell_body");
			}
			default -> { }
		}
		StringBuilder b = new StringBuilder("{\"type\":");
		string(b, type);
		if (layer != null && tex != null) {
			b.append(",\"layer\":");
			string(b, layer);
			b.append(",\"tex\":");
			string(b, tex);
			if (layer2 != null && tex2 != null) {
				b.append(",\"layer2\":");
				string(b, layer2);
				b.append(",\"tex2\":");
				string(b, tex2);
			}
		}
		return b.append('}').toString();
	}

	private String textureKey(String texture, String folder, String fallback) {
		String id = BlockModels.normalize(texture == null ? fallback : texture);
		int colon = id.indexOf(':');
		return first(id.substring(0, colon + 1) + folder + id.substring(colon + 1));
	}

	private String first(String... keys) {
		for (String key : keys) {
			if (atlas.has(key)) {
				return key;
			}
		}
		return null;
	}

	private String tint(Json.Value value) {
		if (!(value instanceof Json.Obj t)) {
			return "[\"c\",-1]";
		}
		String type = BlockModels.normalize(String.valueOf(t.string("type")));
		switch (type) {
			case "minecraft:constant" -> {
				Integer v = t.integer("value");
				return "[\"c\"," + (v == null ? -1 : v & 0xFFFFFF) + "]";
			}
			case "minecraft:grass" -> {
				Double temperature = t.number("temperature");
				Double downfall = t.number("downfall");
				return "[\"c\"," + grass(temperature == null ? 0.5 : temperature, downfall == null ? 1.0 : downfall) + "]";
			}
			default -> {
				Integer d = t.integer("default");
				String kind = type.substring(type.indexOf(':') + 1);
				return "[\"" + kind + "\"," + (d == null ? -1 : d & 0xFFFFFF) + "]";
			}
		}
	}

	/** GrassColor.get: the colormap pixel at ((1 - downfall * temperature) * 255, (1 - temperature) * 255). */
	private int grass(double temperature, double downfall) {
		Png.Image map = colormaps.get("grass");
		if (map == null) {
			return 0x7CBD6B;
		}
		double t = Math.max(0, Math.min(1, temperature));
		double d = Math.max(0, Math.min(1, downfall)) * t;
		int x = (int) ((1 - t) * 255);
		int y = (int) ((1 - d) * 255);
		int index = y << 8 | x;
		if (index >= map.width() * map.height()) {
			return 0x7CBD6B;
		}
		return map.argb(index % map.width(), index / map.width()) & 0xFFFFFF;
	}

	private static String transformation(Json.Value value) {
		if (!(value instanceof Json.Obj t)) {
			return null;
		}
		float[] tr = floats(t.array("translation"), 3, 0f);
		float[] left = floats(t.array("left_rotation"), 4, 0f);
		float[] scale = floats(t.array("scale"), 3, 1f);
		float[] right = floats(t.array("right_rotation"), 4, 0f);
		if (t.array("left_rotation") == null) {
			left[3] = 1f;
		}
		if (t.array("right_rotation") == null) {
			right[3] = 1f;
		}
		StringBuilder b = new StringBuilder("[");
		float[][] parts = {tr, left, scale, right};
		boolean first = true;
		for (float[] part : parts) {
			for (float v : part) {
				if (!first) {
					b.append(',');
				}
				first = false;
				num(b, v);
			}
		}
		return b.append(']').toString();
	}

	private static float[] floats(Json.Arr arr, int n, float fill) {
		float[] out = new float[n];
		java.util.Arrays.fill(out, fill);
		if (arr == null) {
			return out;
		}
		for (int i = 0; i < Math.min(n, arr.items().size()); i++) {
			if (arr.items().get(i) instanceof Json.Num num) {
				out[i] = (float) num.value();
			}
		}
		return out;
	}

	private static StringBuilder num(StringBuilder b, float v) {
		if (!Float.isFinite(v)) {
			return b.append('0');
		}
		float r = Math.round(v * 100000f) / 100000f;
		if (r == (int) r) {
			return b.append((int) r);
		}
		return b.append(r);
	}

	static void string(StringBuilder out, String value) {
		out.append('"');
		for (int i = 0; i < value.length(); i++) {
			char c = value.charAt(i);
			if (c == '"' || c == '\\') {
				out.append('\\').append(c);
			} else if (c < 0x20) {
				out.append(String.format("\\u%04x", (int) c));
			} else {
				out.append(c);
			}
		}
		out.append('"');
	}

	/** Texture keys of every folder in {@link #SPECIAL_TEXTURE_FOLDERS}, for the pipeline to add. */
	static Set<String> specialTextures(AssetSource source) {
		Set<String> out = new TreeSet<>();
		for (String folder : SPECIAL_TEXTURE_FOLDERS) {
			String sub = folder.substring("textures/".length());
			for (String key : source.list(folder, ".png", true).keySet()) {
				int colon = key.indexOf(':');
				if (folder.endsWith("/shield") && !key.endsWith(":base")) {
					continue;
				}
				out.add(key.substring(0, colon + 1) + sub + "/" + key.substring(colon + 1));
			}
		}
		return out;
	}
}
