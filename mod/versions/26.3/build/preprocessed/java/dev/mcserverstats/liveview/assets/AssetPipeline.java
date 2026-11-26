package dev.mcserverstats.liveview.assets;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.json.Json;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Builds the atlas and block models from the client jar plus installed mod jars. Runs once on a worker thread.
 */
public final class AssetPipeline {
	private static final Map<String, String> ENTITY_ALIASES = Map.ofEntries(
			Map.entry("minecraft:ender_dragon", "minecraft:entity/enderdragon/dragon"),
			Map.entry("minecraft:elder_guardian", "minecraft:entity/guardian/guardian_elder"),
			Map.entry("minecraft:mooshroom", "minecraft:entity/cow/red_mooshroom"),
			Map.entry("minecraft:player", "minecraft:entity/player/wide/steve"),
			// Projectiles whose texture is not named after the entity (26.2 jar listing, and the renderers'
			// texture fields: WitherSkullRenderer, ShulkerBulletRenderer, SpectralArrowRenderer, FishingHookRenderer).
			Map.entry("minecraft:spectral_arrow", "minecraft:entity/projectiles/arrow_spectral"),
			Map.entry("minecraft:wither_skull", "minecraft:entity/wither/wither"),
			Map.entry("minecraft:shulker_bullet", "minecraft:entity/shulker/spark"),
			Map.entry("minecraft:breeze_wind_charge", "minecraft:entity/projectiles/wind_charge"),
			Map.entry("minecraft:fishing_bobber", "minecraft:entity/fishing/fishing_hook"));
	/** Second textures some projectiles switch to: tipped arrows and the blue (dangerous) wither skull. */
	private static final List<String> EXTRA_ENTITY_TEXTURES = List.of(
			"minecraft:entity/projectiles/arrow_tipped", "minecraft:entity/wither/wither_invulnerable");
	private static final String WIDE_SKIN = "minecraft:entity/player/wide/steve";
	private static final String SLIM_SKIN = "minecraft:entity/player/slim/alex";

	/**
	 * Game files the page uses as-is: the enchantment glint, the default font and its glyph table, the tooltip sprites
	 * and the container screens. Published under their hash and listed in the meta as {@code files}.
	 */
	private static final Map<String, String> GUI_FILES = Map.ofEntries(
			Map.entry("glint", "assets/minecraft/textures/misc/enchanted_glint_item.png"),
			Map.entry("glint_armor", "assets/minecraft/textures/misc/enchanted_glint_armor.png"),
			Map.entry("shadow", "assets/minecraft/textures/misc/shadow.png"),
			Map.entry("crosshair", "assets/minecraft/textures/gui/sprites/hud/crosshair.png"),
			// The sky: sun, the eight moon phases (MoonPhase order, full moon first), clouds and precipitation.
			Map.entry("sun", "assets/minecraft/textures/environment/celestial/sun.png"),
			Map.entry("moon_0", "assets/minecraft/textures/environment/celestial/moon/full_moon.png"),
			Map.entry("moon_1", "assets/minecraft/textures/environment/celestial/moon/waning_gibbous.png"),
			Map.entry("moon_2", "assets/minecraft/textures/environment/celestial/moon/third_quarter.png"),
			Map.entry("moon_3", "assets/minecraft/textures/environment/celestial/moon/waning_crescent.png"),
			Map.entry("moon_4", "assets/minecraft/textures/environment/celestial/moon/new_moon.png"),
			Map.entry("moon_5", "assets/minecraft/textures/environment/celestial/moon/waxing_crescent.png"),
			Map.entry("moon_6", "assets/minecraft/textures/environment/celestial/moon/first_quarter.png"),
			Map.entry("moon_7", "assets/minecraft/textures/environment/celestial/moon/waxing_gibbous.png"),
			Map.entry("clouds", "assets/minecraft/textures/environment/clouds.png"),
			Map.entry("rain", "assets/minecraft/textures/environment/rain.png"),
			Map.entry("font_ascii", "assets/minecraft/textures/font/ascii.png"),
			Map.entry("font_accented", "assets/minecraft/textures/font/accented.png"),
			Map.entry("font_nonlatin", "assets/minecraft/textures/font/nonlatin_european.png"),
			Map.entry("font_json", "assets/minecraft/font/include/default.json"),
			Map.entry("inventory", "assets/minecraft/textures/gui/container/inventory.png"),
			Map.entry("generic_54", "assets/minecraft/textures/gui/container/generic_54.png"),
			Map.entry("shulker_box", "assets/minecraft/textures/gui/container/shulker_box.png"),
			Map.entry("dispenser", "assets/minecraft/textures/gui/container/dispenser.png"),
			Map.entry("hopper", "assets/minecraft/textures/gui/container/hopper.png"),
			Map.entry("tooltip_background", "assets/minecraft/textures/gui/sprites/tooltip/background.png"),
			Map.entry("tooltip_frame", "assets/minecraft/textures/gui/sprites/tooltip/frame.png"),
			Map.entry("hotbar", "assets/minecraft/textures/gui/sprites/hud/hotbar.png"),
			Map.entry("hotbar_selection", "assets/minecraft/textures/gui/sprites/hud/hotbar_selection.png"),
			Map.entry("slot_helmet", "assets/minecraft/textures/gui/sprites/container/slot/helmet.png"),
			Map.entry("slot_chestplate", "assets/minecraft/textures/gui/sprites/container/slot/chestplate.png"),
			Map.entry("slot_leggings", "assets/minecraft/textures/gui/sprites/container/slot/leggings.png"),
			Map.entry("slot_boots", "assets/minecraft/textures/gui/sprites/container/slot/boots.png"),
			Map.entry("slot_shield", "assets/minecraft/textures/gui/sprites/container/slot/shield.png"),
			Map.entry("heart_full", "assets/minecraft/textures/gui/sprites/hud/heart/full.png"),
			Map.entry("heart_half", "assets/minecraft/textures/gui/sprites/hud/heart/half.png"),
			Map.entry("heart_container", "assets/minecraft/textures/gui/sprites/hud/heart/container.png"),
			Map.entry("food_full", "assets/minecraft/textures/gui/sprites/hud/food_full.png"),
			Map.entry("food_half", "assets/minecraft/textures/gui/sprites/hud/food_half.png"),
			Map.entry("food_empty", "assets/minecraft/textures/gui/sprites/hud/food_empty.png"));

	private AssetPipeline() {
	}

	private static void publish(Map<String, byte[]> files, Map<String, String> urls, String name, byte[] bytes, String ext) {
		String file = sha256(bytes) + "." + ext;
		files.put(file, bytes);
		urls.put(name, AssetStore.PREFIX + file);
	}

	public static AssetBundle build(Path clientJar, List<AssetSource.Root> modRoots) throws AssetException {
		return build(clientJar, modRoots, null);
	}

	/** {@code modelsUrl} is the hashed entity models file, or null when model extraction failed. */
	public static AssetBundle build(Path clientJar, List<AssetSource.Root> modRoots, String modelsUrl) throws AssetException {
		long start = System.nanoTime();
		try (AssetSource source = new AssetSource(clientJar, modRoots)) {
			Map<String, byte[]> blockstates = readAll(source, source.list("blockstates", ".json", false));
			Map<String, byte[]> models = readAll(source, source.list("models", ".json", true));
			if (!blockstates.containsKey("minecraft:stone")) {
				throw new AssetException(clientJar + " has no assets/minecraft/blockstates; it is not a client jar");
			}
			AtlasBuilder builder = new AtlasBuilder();
			Map<String, String> textures = new TreeMap<>();
			textures.putAll(prefixed(source.list("textures/block", ".png", true), "block/"));
			textures.putAll(prefixed(source.list("textures/item", ".png", true), "item/"));
			textures.putAll(prefixed(source.list("textures/colormap", ".png", false), "colormap/"));
			textures.putAll(prefixed(source.list("textures/particle", ".png", true), "particle/"));
			Map<String, String> equipmentTextures = source.list("textures/entity/equipment", ".png", true);
			textures.putAll(prefixed(equipmentTextures, "entity/equipment/"));
			Map<String, byte[]> equipment = readAll(source, source.list("equipment", ".json", false));
			Map<String, List<String>> particles = particleSprites(source);
			Map<String, byte[]> itemDefinitions = readAll(source, source.list("items", ".json", false));
			for (String key : ItemModels.specialTextures(source)) {
				textures.putIfAbsent(key, texturePath(key));
			}
			Set<String> forced = new TreeSet<>();
			for (String reference : modelTextures(models, forced)) {
				if (!textures.containsKey(reference)) {
					String path = texturePath(reference);
					if (path != null) {
						textures.put(reference, path);
					}
				}
			}
			Map<String, String> foundEntityTextures = source.list("textures/entity", ".png", true);
			Map<String, String> entityTextures = entityTextures(foundEntityTextures);
			for (String key : new TreeSet<>(entityTextures.values())) {
				textures.putIfAbsent(key, texturePath(key));
			}
			// Every chest texture (single and double halves, trapped, ender, copper stages): the page draws placed chests.
			for (String key : foundEntityTextures.keySet()) {
				if (key.startsWith("minecraft:chest/")) {
					String atlasKey = "minecraft:entity/" + key.substring("minecraft:".length());
					textures.putIfAbsent(atlasKey, texturePath(atlasKey));
				}
			}
			for (String key : EXTRA_ENTITY_TEXTURES) {
				if (foundEntityTextures.containsKey("minecraft:" + key.substring("minecraft:entity/".length()))) {
					textures.putIfAbsent(key, texturePath(key));
				}
			}
			// Baby mobs have their own texture next to the adult one: <adult>_baby.png (26.2 jar listing).
			Map<String, String> babyCandidates = new TreeMap<>();
			for (Map.Entry<String, String> entry : entityTextures.entrySet()) {
				String baby = entry.getValue() + "_baby";
				String foundKey = "minecraft:" + baby.substring(baby.indexOf(':') + 1 + "entity/".length());
				if (baby.startsWith("minecraft:entity/") && foundEntityTextures.containsKey(foundKey)) {
					babyCandidates.put(entry.getKey(), baby);
					textures.putIfAbsent(baby, texturePath(baby));
				}
			}
			textures.putIfAbsent(WIDE_SKIN, texturePath(WIDE_SKIN));
			textures.putIfAbsent(SLIM_SKIN, texturePath(SLIM_SKIN));
			Map<String, Png.Image> colormaps = new HashMap<>();
			for (Map.Entry<String, String> entry : textures.entrySet()) {
				byte[] png = source.read(entry.getValue());
				if (png == null) {
					continue;
				}
				try {
					Png.Image image = Png.decode(png);
					builder.add(entry.getKey(), image, source.read(entry.getValue() + ".mcmeta"));
					if (entry.getKey().startsWith("minecraft:colormap/")) {
						colormaps.put(entry.getKey().substring("minecraft:colormap/".length()), image);
					}
				} catch (IOException e) {
					LogOnce.warn("png-" + entry.getKey(), "Liveview skipped texture " + entry.getKey() + ": " + e.getMessage(), null);
				}
			}
			for (String key : forced) {
				builder.forceTranslucent(key);
			}
			Atlas atlas = builder.build();
			Map<String, String> entities = new TreeMap<>();
			for (Map.Entry<String, String> entry : entityTextures.entrySet()) {
				if (atlas.has(entry.getValue())) {
					entities.put(entry.getKey(), entry.getValue());
				}
			}
			Map<String, String> babies = new TreeMap<>();
			for (Map.Entry<String, String> entry : babyCandidates.entrySet()) {
				if (atlas.has(entry.getValue())) {
					babies.put(entry.getKey(), entry.getValue());
				}
			}
			Map<String, List<String>> particleFrames = new TreeMap<>();
			for (Map.Entry<String, List<String>> entry : particles.entrySet()) {
				List<String> frames = entry.getValue().stream().filter(atlas::has).toList();
				if (!frames.isEmpty()) {
					particleFrames.put(entry.getKey(), frames);
				}
			}
			String equipmentJson = equipmentMeta(equipment, atlas);
			BlockModels blockModels = new BlockModels(blockstates, models, atlas);
			Map<String, byte[]> files = new LinkedHashMap<>();
			Map<String, String> fileUrls = new TreeMap<>();
			try {
				byte[] items = ItemModels.build(itemDefinitions, blockModels, atlas, colormaps);
				publish(files, fileUrls, "items", items, "json");
			} catch (RuntimeException e) {
				LogOnce.warn("item-models", "Liveview could not build item models; items fall back to flat icons", e);
			}
			for (Map.Entry<String, String> gui : GUI_FILES.entrySet()) {
				byte[] bytes = source.read(gui.getValue());
				if (bytes != null) {
					publish(files, fileUrls, gui.getKey(), bytes, gui.getValue().endsWith(".png") ? "png" : "json");
				}
			}
			byte[] meta = meta(atlas, entities, babies, modelsUrl, particleFrames, equipmentJson, fileUrls);
			AssetBundle bundle = new AssetBundle(
					atlas, blockModels, meta, sha256(atlas.png()), sha256(meta), Map.copyOf(colormaps), Map.copyOf(entities), files);
			LogOnce.logger().info(
					"Liveview packed {} textures into a {}px atlas from {} roots in {} ms",
					atlas.rects().size(),
					atlas.size(),
					source.roots().size(),
					(System.nanoTime() - start) / 1_000_000);
			return bundle;
		} catch (IOException e) {
			throw new AssetException("could not read assets from " + clientJar + ": " + e.getMessage());
		}
	}

	private static Map<String, byte[]> readAll(AssetSource source, Map<String, String> paths) {
		Map<String, byte[]> out = new HashMap<>();
		for (Map.Entry<String, String> entry : paths.entrySet()) {
			byte[] bytes = source.read(entry.getValue());
			if (bytes != null) {
				out.put(entry.getKey(), bytes);
			}
		}
		return out;
	}

	private static Map<String, String> prefixed(Map<String, String> found, String prefix) {
		Map<String, String> out = new LinkedHashMap<>();
		for (Map.Entry<String, String> entry : found.entrySet()) {
			int colon = entry.getKey().indexOf(':');
			out.put(entry.getKey().substring(0, colon + 1) + prefix + entry.getKey().substring(colon + 1), entry.getValue());
		}
		return out;
	}

	static String texturePath(String key) {
		int colon = key.indexOf(':');
		if (colon <= 0) {
			return null;
		}
		return "assets/" + key.substring(0, colon) + "/textures/" + key.substring(colon + 1) + ".png";
	}

	private static Set<String> modelTextures(Map<String, byte[]> models, Set<String> forcedTranslucent) {
		Set<String> found = new TreeSet<>();
		for (byte[] bytes : models.values()) {
			try {
				if (!(Json.parse(new String(bytes, StandardCharsets.UTF_8)) instanceof Json.Obj obj)) {
					continue;
				}
				Json.Obj textures = obj.object("textures");
				if (textures == null) {
					continue;
				}
				for (Json.Value value : textures.fields().values()) {
					String name = null;
					if (value instanceof Json.Str str) {
						name = str.value();
					} else if (value instanceof Json.Obj sprite) {
						name = sprite.string("sprite");
						if (name != null && !name.startsWith("#") && Boolean.TRUE.equals(sprite.bool("force_translucent"))) {
							forcedTranslucent.add(BlockModels.normalize(name));
						}
					}
					if (name != null && !name.startsWith("#")) {
						found.add(BlockModels.normalize(name));
					}
				}
			} catch (Json.JsonException e) {
				// BlockModels logs the broken file once when a block state asks for it.
			}
		}
		return found;
	}

	/**
	 * Picks one texture per entity type from {@code textures/entity}: {@code <type>/<type>.png}, then a top-level
	 * {@code <type>.png}, then any file named {@code <type>.png} in a subfolder, then {@code <type>/<type>_temperate.png},
	 * then the first non-baby file in {@code <type>/}.
	 */
	private static Map<String, String> entityTextures(Map<String, String> found) {
		Map<String, String> exact = new TreeMap<>();
		Map<String, String> top = new TreeMap<>();
		Map<String, String> basename = new TreeMap<>();
		Map<String, String> firstInDir = new TreeMap<>();
		Map<String, String> temperate = new TreeMap<>();
		for (String key : found.keySet()) {
			int colon = key.indexOf(':');
			String namespace = key.substring(0, colon);
			String path = key.substring(colon + 1);
			String textureKey = namespace + ":entity/" + path;
			String[] segments = path.split("/");
			String file = segments[segments.length - 1];
			if (segments.length == 1) {
				top.putIfAbsent(namespace + ":" + file, textureKey);
				continue;
			}
			if (segments.length == 2 && segments[0].equals(file)) {
				exact.putIfAbsent(namespace + ":" + file, textureKey);
			}
			basename.putIfAbsent(namespace + ":" + file, textureKey);
			if (segments.length == 2) {
				String type = namespace + ":" + segments[0];
				if (file.equals(segments[0] + "_temperate")) {
					temperate.put(type, textureKey);
				} else if (!file.endsWith("_baby")) {
					firstInDir.putIfAbsent(type, textureKey);
				}
			}
		}
		Map<String, String> chosen = new TreeMap<>(firstInDir);
		chosen.putAll(temperate);
		chosen.putAll(basename);
		chosen.putAll(top);
		chosen.putAll(exact);
		for (Map.Entry<String, String> alias : ENTITY_ALIASES.entrySet()) {
			String path = alias.getValue().substring(alias.getValue().indexOf(':') + "entity/".length() + 1);
			if (found.containsKey("minecraft:" + path)) {
				chosen.put(alias.getKey(), alias.getValue());
			}
		}
		return chosen;
	}

	/**
	 * {@code assets/<ns>/particles/<type>.json} lists a particle type's sprite frames in order, as texture ids under
	 * {@code textures/particle}. Returns type id -> atlas keys ({@code ns:particle/name}).
	 */
	private static Map<String, List<String>> particleSprites(AssetSource source) {
		Map<String, List<String>> out = new TreeMap<>();
		for (Map.Entry<String, byte[]> entry : readAll(source, source.list("particles", ".json", false)).entrySet()) {
			try {
				if (!(Json.parse(new String(entry.getValue(), StandardCharsets.UTF_8)) instanceof Json.Obj obj)) {
					continue;
				}
				Json.Arr textures = obj.array("textures");
				if (textures == null) {
					continue;
				}
				List<String> frames = new java.util.ArrayList<>();
				for (Json.Value value : textures.items()) {
					if (value instanceof Json.Str str) {
						String name = str.value();
						int colon = name.indexOf(':');
						String ns = colon < 0 ? "minecraft" : name.substring(0, colon);
						frames.add(ns + ":particle/" + name.substring(colon + 1));
					}
				}
				if (!frames.isEmpty()) {
					out.put(entry.getKey(), frames);
				}
			} catch (Json.JsonException e) {
				LogOnce.warn("particle-json-" + entry.getKey(), "Liveview skipped particle definition " + entry.getKey(), null);
			}
		}
		return out;
	}

	/**
	 * {@code assets/<ns>/equipment/<asset>.json} lists texture layers per body kind (humanoid, humanoid_leggings, ...),
	 * each {@code {"texture": "ns:name", "dyeable": {"color_when_undyed": argb}}}; the texture lives at
	 * {@code textures/entity/equipment/<kind>/<name>.png}. Emits {asset: {kind: [[textureKey, undyedColor or null]]}}
	 * with only layers whose texture made it into the atlas.
	 */
	private static String equipmentMeta(Map<String, byte[]> equipment, Atlas atlas) {
		StringBuilder out = new StringBuilder("{");
		boolean firstAsset = true;
		for (Map.Entry<String, byte[]> entry : new TreeMap<>(equipment).entrySet()) {
			try {
				if (!(Json.parse(new String(entry.getValue(), StandardCharsets.UTF_8)) instanceof Json.Obj obj)) {
					continue;
				}
				Json.Obj layers = obj.object("layers");
				if (layers == null) {
					continue;
				}
				StringBuilder kinds = new StringBuilder();
				boolean firstKind = true;
				for (Map.Entry<String, Json.Value> kind : layers.fields().entrySet()) {
					if (!(kind.getValue() instanceof Json.Arr list)) {
						continue;
					}
					StringBuilder entries = new StringBuilder();
					for (Json.Value item : list.items()) {
						if (!(item instanceof Json.Obj layer) || layer.string("texture") == null) {
							continue;
						}
						String texture = layer.string("texture");
						int colon = texture.indexOf(':');
						String ns = colon < 0 ? "minecraft" : texture.substring(0, colon);
						String key = ns + ":entity/equipment/" + kind.getKey() + "/" + texture.substring(colon + 1);
						if (!atlas.has(key)) {
							continue;
						}
						Json.Obj dyeable = layer.object("dyeable");
						Integer undyed = dyeable == null ? null : dyeable.integer("color_when_undyed");
						if (entries.length() > 0) {
							entries.append(',');
						}
						entries.append('[');
						string(entries, key);
						entries.append(',').append(dyeable == null ? "null" : String.valueOf(undyed == null ? -1 : undyed & 0xFFFFFF)).append(']');
					}
					if (entries.length() == 0) {
						continue;
					}
					if (!firstKind) {
						kinds.append(',');
					}
					firstKind = false;
					string(kinds, kind.getKey());
					kinds.append(":[").append(entries).append(']');
				}
				if (kinds.length() == 0) {
					continue;
				}
				if (!firstAsset) {
					out.append(',');
				}
				firstAsset = false;
				string(out, entry.getKey());
				out.append(":{").append(kinds).append('}');
			} catch (Json.JsonException e) {
				LogOnce.warn("equipment-json-" + entry.getKey(), "Liveview skipped equipment definition " + entry.getKey(), null);
			}
		}
		return out.append('}').toString();
	}

	private static byte[] meta(Atlas atlas, Map<String, String> entities, Map<String, String> babies, String modelsUrl,
			Map<String, List<String>> particles, String equipmentJson, Map<String, String> files) {
		StringBuilder out = new StringBuilder();
		out.append("{\"size\":").append(atlas.size()).append(",\"textures\":{");
		boolean first = true;
		for (Map.Entry<String, Atlas.Rect> entry : new TreeMap<>(atlas.rects()).entrySet()) {
			if (!first) {
				out.append(',');
			}
			first = false;
			Atlas.Rect r = entry.getValue();
			string(out, entry.getKey());
			out.append(":{\"u\":").append(r.x()).append(",\"v\":").append(r.y())
					.append(",\"w\":").append(r.w()).append(",\"h\":").append(r.h()).append('}');
		}
		out.append("},\"animations\":[");
		first = true;
		for (Atlas.Animation animation : atlas.animations()) {
			if (!first) {
				out.append(',');
			}
			first = false;
			out.append("{\"texture\":");
			string(out, animation.texture());
			out.append(",\"frametime\":").append(animation.frametime());
			out.append(",\"frames\":[");
			for (int i = 0; i < animation.frames().size(); i++) {
				if (i > 0) {
					out.append(',');
				}
				out.append(animation.frames().get(i));
			}
			out.append("],\"frameCount\":").append(animation.frameCount());
			out.append(",\"frameHeight\":").append(animation.frameHeight()).append('}');
		}
		out.append("],\"translucent\":[");
		first = true;
		for (String key : new TreeSet<>(atlas.translucent())) {
			if (!first) {
				out.append(',');
			}
			first = false;
			string(out, key);
		}
		out.append("],\"entities\":{");
		first = true;
		for (Map.Entry<String, String> entry : entities.entrySet()) {
			if (!first) {
				out.append(',');
			}
			first = false;
			string(out, entry.getKey());
			out.append(':');
			string(out, entry.getValue());
		}
		out.append("},\"babyEntities\":{");
		first = true;
		for (Map.Entry<String, String> entry : babies.entrySet()) {
			if (!first) {
				out.append(',');
			}
			first = false;
			string(out, entry.getKey());
			out.append(':');
			string(out, entry.getValue());
		}
		out.append('}');
		out.append(",\"equipment\":").append(equipmentJson);
		out.append(",\"particles\":{");
		first = true;
		for (Map.Entry<String, List<String>> entry : particles.entrySet()) {
			if (!first) {
				out.append(',');
			}
			first = false;
			string(out, entry.getKey());
			out.append(":[");
			for (int i = 0; i < entry.getValue().size(); i++) {
				if (i > 0) {
					out.append(',');
				}
				string(out, entry.getValue().get(i));
			}
			out.append(']');
		}
		out.append('}');
		if (modelsUrl != null) {
			out.append(",\"models\":");
			string(out, modelsUrl);
		}
		out.append(",\"files\":{");
		first = true;
		for (Map.Entry<String, String> entry : files.entrySet()) {
			if (!first) {
				out.append(',');
			}
			first = false;
			string(out, entry.getKey());
			out.append(':');
			string(out, entry.getValue());
		}
		out.append('}');
		out.append(",\"playerSkins\":{\"wide\":");
		string(out, WIDE_SKIN);
		out.append(",\"slim\":");
		string(out, SLIM_SKIN);
		out.append("}}");
		return out.toString().getBytes(StandardCharsets.UTF_8);
	}

	private static void string(StringBuilder out, String value) {
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

	public static String sha256(byte[] bytes) {
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException("JDK has no SHA-256", e);
		}
	}
}
