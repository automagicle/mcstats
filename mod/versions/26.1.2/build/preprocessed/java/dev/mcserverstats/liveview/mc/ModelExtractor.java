package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import org.joml.Vector3fc;

/**
 * Reads Minecraft's own entity geometry out of the client jar.
 *
 * <p>Entity models are Java code ({@code createBodyLayer()} methods), not resource files. The client's
 * {@code LayerDefinitions.createRoots()} returns every model as plain data: a tree of {@code PartDefinition}s, each
 * with a {@code PartPose} and a list of {@code CubeDefinition}s, plus the texture size in a {@code MaterialDefinition}.
 * A dedicated server has none of those classes, so they load from the SHA-1-checked client jar through a child class
 * loader that asks the server's loader first and only defines what the server lacks. In single-player the client classes
 * are already loaded and come from the parent. Nothing from the jar is bundled in the mod.
 *
 * <p>VERIFIED by javap on the 26.2 merged jar, and by running this exact path against the 26.2 server jar plus its bundled
 * libraries (358 layers once {@code Bootstrap} has run, which it has on a running server):
 * {@code LayerDefinitions.createRoots()} returns {@code Map<ModelLayerLocation, LayerDefinition>};
 * {@code LayerDefinition} fields {@code mesh} (MeshDefinition) and {@code material} (MaterialDefinition: {@code xTexSize},
 * {@code yTexSize}); {@code MeshDefinition.getRoot()}; {@code PartDefinition} fields {@code cubes}, {@code partPose},
 * {@code children}; {@code CubeDefinition} fields {@code origin}/{@code dimensions} (joml {@code Vector3fc}),
 * {@code grow} (CubeDeformation: {@code growX/Y/Z}), {@code mirror}, {@code texCoord}/{@code texScale} (UVPair record
 * {@code u()}, {@code v()}), {@code visibleFaces} (Set of Direction); {@code PartPose} record accessors x, y, z, xRot,
 * yRot, zRot, xScale, yScale, zScale. Only reflection is used, so the mod has no compile-time link to client classes.
 */
public final class ModelExtractor {
	private static final Map<String, String> ALIASES = Map.ofEntries(
			Map.entry("minecraft:pufferfish", "minecraft:pufferfish_big"),
			Map.entry("minecraft:tropical_fish", "minecraft:tropical_fish_small"),
			Map.entry("minecraft:camel_husk", "minecraft:camel"),
			Map.entry("minecraft:killer_bunny", "minecraft:rabbit"),
			Map.entry("minecraft:mannequin", "minecraft:player"),
			Map.entry("minecraft:spectral_arrow", "minecraft:arrow"),
			Map.entry("minecraft:breeze_wind_charge", "minecraft:wind_charge"),
			Map.entry("minecraft:boat", "minecraft:boat/oak"),
			Map.entry("minecraft:chest_boat", "minecraft:chest_boat/oak"),
			Map.entry("minecraft:bamboo_raft", "minecraft:boat/bamboo"),
			Map.entry("minecraft:bamboo_chest_raft", "minecraft:chest_boat/bamboo"));

	/** Vanilla's humanoid armor layers, in Liveview's slot order: head, chest, legs, feet. */
	private static final String[] ARMOR_PIECES = {"#helmet", "#chestplate", "#leggings", "#boots"};

	private static final Set<String> SPECIAL_ITEM_LAYERS = Set.of(
			"chest", "double_chest_left", "double_chest_right", "shulker_box", "shield", "trident", "conduit", "decorated_pot_base", "decorated_pot_sides", "bell",
			"player_head", "skeleton_skull", "wither_skeleton_skull", "zombie_head", "creeper_head", "piglin_head", "dragon_skull");

	private ModelExtractor() {
	}

	/** Returns the models JSON (see {@code mod/PROTOCOL.md}, "Rendering additions"), or null if extraction failed. */
	public static byte[] extract(Path clientJar) {
		long start = System.nanoTime();
		ClassLoader parent = ModelExtractor.class.getClassLoader();
		try (ClientFirstMissing loader = new ClientFirstMissing(new URL[] {clientJar.toUri().toURL()}, parent)) {
			Class<?> definitions = Class.forName("net.minecraft.client.model.geom.LayerDefinitions", true, loader);
			Map<?, ?> roots = (Map<?, ?>) definitions.getMethod("createRoots").invoke(null);
			Map<String, Object> layers = new TreeMap<>();
			for (Map.Entry<?, ?> entry : roots.entrySet()) {
				layers.put(entry.getKey().toString(), entry.getValue());
			}
			Map<String, String[]> entities = mapEntities(layers.keySet());
			Set<String> wanted = new TreeSet<>(Set.of("minecraft:player#main", "minecraft:player_slim#main", "minecraft:player#cape"));
			for (String piece : ARMOR_PIECES) {
				for (String player : new String[] {"minecraft:player", "minecraft:player_slim"}) {
					if (layers.containsKey(player + piece)) {
						wanted.add(player + piece);
					}
				}
			}
			// Climate variants with their own geometry: cold_pig, warm_cow, cold_chicken and so on (PigVariant.ModelType etc.).
			Map<String, Map<String, String>> variantLayers = new LinkedHashMap<>();
			for (Map.Entry<String, String[]> entry : entities.entrySet()) {
				String main = entry.getValue()[0];
				int colon = main.indexOf(':');
				String ns = main.substring(0, colon + 1);
				String path = main.substring(colon + 1, main.length() - "#main".length());
				for (String climate : new String[] {"cold", "warm"}) {
					String key = ns + climate + "_" + path + "#main";
					if (layers.containsKey(key)) {
						variantLayers.computeIfAbsent(entry.getKey(), k -> new LinkedHashMap<>()).put(climate, key);
						wanted.add(key);
						String baby = ns + climate + "_" + path + "_baby#main";
						if (layers.containsKey(baby)) {
							variantLayers.get(entry.getKey()).put(climate + "_baby", baby);
							wanted.add(baby);
						}
					}
				}
			}
			Map<String, String[]> armorLayers = new LinkedHashMap<>();
			for (Map.Entry<String, String[]> entry : entities.entrySet()) {
				String base = entry.getValue()[0].substring(0, entry.getValue()[0].length() - "#main".length());
				String[] pieces = new String[ARMOR_PIECES.length];
				boolean any = false;
				for (int i = 0; i < ARMOR_PIECES.length; i++) {
					if (layers.containsKey(base + ARMOR_PIECES[i])) {
						pieces[i] = base + ARMOR_PIECES[i];
						wanted.add(pieces[i]);
						any = true;
					}
				}
				if (any) {
					armorLayers.put(entry.getKey(), pieces);
				}
			}
			for (String[] pair : entities.values()) {
				wanted.add(pair[0]);
				if (pair[1] != null) {
					wanted.add(pair[1]);
				}
				for (int i = 2; i < pair.length; i++) {
					wanted.add(pair[i]);
				}
			}
			// Item special renderers (chests, shulker boxes, heads, shields, tridents, conduits, decorated pots, bells)
			// draw these block-entity layers in inventories and hands.
			for (String key : layers.keySet()) {
				String path = key.substring(key.indexOf(':') + 1, key.indexOf('#') < 0 ? key.length() : key.indexOf('#'));
				if (SPECIAL_ITEM_LAYERS.contains(path)) {
					wanted.add(key);
				}
			}
			Reflect reflect = new Reflect(loader);
			StringBuilder out = new StringBuilder(256 * 1024);
			out.append("{\"layers\":{");
			boolean first = true;
			int written = 0;
			for (String key : wanted) {
				Object layer = layers.get(key);
				if (layer == null) {
					continue;
				}
				StringBuilder one = new StringBuilder();
				try {
					reflect.layer(one, layer);
				} catch (ReflectiveOperationException | RuntimeException e) {
					LogOnce.warn("model-layer-" + key, "Liveview could not read model layer " + key + "; that mob stays a box", e);
					continue;
				}
				if (!first) {
					out.append(',');
				}
				first = false;
				string(out, key);
				out.append(':').append(one);
				written++;
			}
			out.append("},\"entities\":{");
			first = true;
			for (Map.Entry<String, String[]> entry : entities.entrySet()) {
				if (!first) {
					out.append(',');
				}
				first = false;
				string(out, entry.getKey());
				out.append(":{\"main\":");
				string(out, entry.getValue()[0]);
				if (entry.getValue()[1] != null) {
					out.append(",\"baby\":");
					string(out, entry.getValue()[1]);
				}
				Map<String, String> climates = variantLayers.get(entry.getKey());
				if (climates != null) {
					out.append(",\"variants\":{");
					boolean firstClimate = true;
					for (Map.Entry<String, String> climate : climates.entrySet()) {
						if (!firstClimate) {
							out.append(',');
						}
						firstClimate = false;
						string(out, climate.getKey());
						out.append(':');
						string(out, climate.getValue());
					}
					out.append('}');
				}
				String[] pieces = armorLayers.get(entry.getKey());
				if (pieces != null) {
					out.append(",\"armor\":[");
					for (int i = 0; i < pieces.length; i++) {
						if (i > 0) {
							out.append(',');
						}
						if (pieces[i] == null) {
							out.append("null");
						} else {
							string(out, pieces[i]);
						}
					}
					out.append(']');
				}
				if (entry.getValue().length > 2) {
					out.append(",\"overlays\":[");
					for (int i = 2; i < entry.getValue().length; i++) {
						if (i > 2) {
							out.append(',');
						}
						string(out, entry.getValue()[i]);
					}
					out.append(']');
				}
				out.append('}');
			}
			out.append("},\"player\":{\"wide\":\"minecraft:player#main\",\"slim\":\"minecraft:player_slim#main\",\"cape\":\"minecraft:player#cape\"");
			for (String player : new String[] {"wide", "slim"}) {
				String base = player.equals("wide") ? "minecraft:player" : "minecraft:player_slim";
				out.append(",\"").append(player).append("Armor\":[");
				for (int i = 0; i < ARMOR_PIECES.length; i++) {
					if (i > 0) {
						out.append(',');
					}
					if (layers.containsKey(base + ARMOR_PIECES[i])) {
						string(out, base + ARMOR_PIECES[i]);
					} else {
						out.append("null");
					}
				}
				out.append(']');
			}
			out.append("}}");
			LogOnce.logger().info(
					"Liveview read {} entity models ({} mob types) from the client jar in {} ms",
					written,
					entities.size(),
					(System.nanoTime() - start) / 1_000_000L);
			return out.toString().getBytes(StandardCharsets.UTF_8);
		} catch (Throwable thrown) {
			LogOnce.warn("model-extract", "Liveview could not read entity models from the client jar; mobs stay boxes", thrown);
			return null;
		}
	}

	/** Entity type id -> {main layer, baby layer or null}, by name, then by the alias table. */
	private static Map<String, String[]> mapEntities(Collection<String> layerKeys) {
		Set<String> keys = Set.copyOf(layerKeys);
		Map<String, String[]> out = new LinkedHashMap<>();
		for (Identifier id : BuiltInRegistries.ENTITY_TYPE.keySet()) {
			String type = id.toString();
			String base = ALIASES.getOrDefault(type, type);
			if (type.endsWith("_boat") || type.endsWith("_raft")) {
				String wood = id.getPath().replace("_chest_boat", "").replace("_chest_raft", "").replace("_boat", "").replace("_raft", "");
				base = id.getNamespace() + ":" + (id.getPath().contains("chest") ? "chest_boat/" : "boat/") + wood;
			}
			String main = base + "#main";
			if (!keys.contains(main)) {
				continue;
			}
			String baby = base + "_baby#main";
			// Layers vanilla draws on top of the body with their own texture: sheep wool, slime gel, the clothing
			// overlay of drowned, strays, bogged and parched.
			java.util.List<String> layers = new java.util.ArrayList<>(java.util.List.of(main));
			layers.add(keys.contains(baby) ? baby : null);
			for (String overlay : new String[] {"#wool", "#outer"}) {
				if (keys.contains(base + overlay)) {
					layers.add(base + overlay);
				}
			}
			out.put(type, layers.toArray(String[]::new));
		}
		return out;
	}

	/** Reflection over the client model classes, resolved once. */
	private static final class Reflect {
		private final Field mesh;
		private final Field material;
		private final Field texW;
		private final Field texH;
		private final Method getRoot;
		private final Field cubes;
		private final Field partPose;
		private final Field children;
		private final Field origin;
		private final Field dimensions;
		private final Field grow;
		private final Field mirror;
		private final Field texCoord;
		private final Field texScale;
		private final Field visibleFaces;
		private final Field growX;
		private final Field growY;
		private final Field growZ;
		private final Method u;
		private final Method v;
		private final Method[] pose;

		Reflect(ClassLoader loader) throws ReflectiveOperationException {
			Class<?> layer = Class.forName("net.minecraft.client.model.geom.builders.LayerDefinition", false, loader);
			Class<?> meshClass = Class.forName("net.minecraft.client.model.geom.builders.MeshDefinition", false, loader);
			Class<?> materialClass = Class.forName("net.minecraft.client.model.geom.builders.MaterialDefinition", false, loader);
			Class<?> part = Class.forName("net.minecraft.client.model.geom.builders.PartDefinition", false, loader);
			Class<?> cube = Class.forName("net.minecraft.client.model.geom.builders.CubeDefinition", false, loader);
			Class<?> deformation = Class.forName("net.minecraft.client.model.geom.builders.CubeDeformation", false, loader);
			Class<?> uv = Class.forName("net.minecraft.client.model.geom.builders.UVPair", false, loader);
			Class<?> partPoseClass = Class.forName("net.minecraft.client.model.geom.PartPose", false, loader);
			mesh = open(layer, "mesh");
			material = open(layer, "material");
			texW = open(materialClass, "xTexSize");
			texH = open(materialClass, "yTexSize");
			getRoot = meshClass.getMethod("getRoot");
			cubes = open(part, "cubes");
			partPose = open(part, "partPose");
			children = open(part, "children");
			origin = open(cube, "origin");
			dimensions = open(cube, "dimensions");
			grow = open(cube, "grow");
			mirror = open(cube, "mirror");
			texCoord = open(cube, "texCoord");
			texScale = open(cube, "texScale");
			visibleFaces = open(cube, "visibleFaces");
			growX = open(deformation, "growX");
			growY = open(deformation, "growY");
			growZ = open(deformation, "growZ");
			u = uv.getMethod("u");
			v = uv.getMethod("v");
			String[] names = {"x", "y", "z", "xRot", "yRot", "zRot", "xScale", "yScale", "zScale"};
			pose = new Method[names.length];
			for (int i = 0; i < names.length; i++) {
				pose[i] = partPoseClass.getMethod(names[i]);
			}
		}

		void layer(StringBuilder out, Object layer) throws ReflectiveOperationException {
			Object meshValue = mesh.get(layer);
			Object materialValue = material.get(layer);
			out.append("{\"tw\":").append(texW.getInt(materialValue)).append(",\"th\":").append(texH.getInt(materialValue));
			out.append(",\"root\":");
			part(out, getRoot.invoke(meshValue), 0);
			out.append('}');
		}

		private void part(StringBuilder out, Object part, int depth) throws ReflectiveOperationException {
			if (depth > 32) {
				throw new IllegalStateException("model part tree deeper than 32");
			}
			out.append("{\"pose\":[");
			Object poseValue = partPose.get(part);
			for (int i = 0; i < pose.length; i++) {
				if (i > 0) {
					out.append(',');
				}
				number(out, ((Number) pose[i].invoke(poseValue)).floatValue());
			}
			out.append("],\"cubes\":[");
			boolean first = true;
			for (Object cube : (Collection<?>) cubes.get(part)) {
				if (!first) {
					out.append(',');
				}
				first = false;
				Vector3fc o = (Vector3fc) origin.get(cube);
				Vector3fc d = (Vector3fc) dimensions.get(cube);
				Object g = grow.get(cube);
				Object tc = texCoord.get(cube);
				Object ts = texScale.get(cube);
				out.append('[');
				number(out, o.x()); out.append(','); number(out, o.y()); out.append(','); number(out, o.z()); out.append(',');
				number(out, d.x()); out.append(','); number(out, d.y()); out.append(','); number(out, d.z()); out.append(',');
				number(out, (Float) u.invoke(tc)); out.append(','); number(out, (Float) v.invoke(tc)); out.append(',');
				number(out, growX.getFloat(g)); out.append(','); number(out, growY.getFloat(g)); out.append(','); number(out, growZ.getFloat(g)); out.append(',');
				out.append(mirror.getBoolean(cube) ? 1 : 0).append(',');
				number(out, (Float) u.invoke(ts)); out.append(','); number(out, (Float) v.invoke(ts)); out.append(',');
				out.append(faceMask((Set<?>) visibleFaces.get(cube)));
				out.append(']');
			}
			out.append("],\"children\":{");
			first = true;
			for (Map.Entry<?, ?> child : ((Map<?, ?>) children.get(part)).entrySet()) {
				if (!first) {
					out.append(',');
				}
				first = false;
				string(out, String.valueOf(child.getKey()));
				out.append(':');
				part(out, child.getValue(), depth + 1);
			}
			out.append("}}");
		}

		/** Bits by Direction name: down 1, up 2, north 4, south 8, west 16, east 32. 63 is every face. */
		private static int faceMask(Set<?> faces) {
			if (faces == null) {
				return 63;
			}
			int mask = 0;
			for (Object face : faces) {
				mask |= switch (String.valueOf(face).toLowerCase(java.util.Locale.ROOT)) {
					case "down" -> 1;
					case "up" -> 2;
					case "north" -> 4;
					case "south" -> 8;
					case "west" -> 16;
					case "east" -> 32;
					default -> 0;
				};
			}
			return mask;
		}

		private static Field open(Class<?> owner, String name) throws NoSuchFieldException {
			Field field = owner.getDeclaredField(name);
			field.setAccessible(true);
			return field;
		}
	}

	private static void number(StringBuilder out, float value) {
		if (!Float.isFinite(value)) {
			out.append('0');
		} else if (value == Math.rint(value) && Math.abs(value) < 1e7) {
			out.append((long) value);
		} else {
			out.append(Math.round(value * 10000.0) / 10000.0);
		}
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

	/** Parent first; only classes the server does not have are defined from the client jar. */
	private static final class ClientFirstMissing extends URLClassLoader {
		ClientFirstMissing(URL[] urls, ClassLoader parent) {
			super(urls, parent);
		}

		@Override
		protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
			synchronized (getClassLoadingLock(name)) {
				Class<?> c = findLoadedClass(name);
				if (c == null) {
					try {
						c = getParent().loadClass(name);
					} catch (ClassNotFoundException missing) {
						// A production dedicated server has no client classes at all.
						c = findClass(name);
					} catch (RuntimeException refused) {
						// Fabric's loader in a dev server has them (merged jar) but refuses client-only classes with
						// "Cannot load class ... in environment type SERVER".
						c = findClass(name);
					}
				}
				if (resolve) {
					resolveClass(c);
				}
				return c;
			}
		}
	}
}
