package dev.mcserverstats.chatlog;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

// How each player chose to be shown on the dashboard (/mcstats view → Your Profile): an item for each
// hand of their 3D model and a particle effect around it. Kept in config/mcstats-profiles.json:
//   { "<uuid>": { "mainhand"?: <item>, "offhand"?: <item>, "particle"?: "flame" } }
// where <item> is the item as GearReporter reports one (id, name, glint, …), saved when it was picked,
// so it stays shown even after it leaves their inventory. Read and written on the server thread.
final class ProfileStore {
	// The particles a player may pick. The dashboard draws each (public/player3d.js, ACCENT) in the colors
	// public/app.js gives it (PARTICLE_AURAS); anything else is ignored there.
	static final String[] PARTICLES = {
			"flame", "heart", "end_rod", "enchant", "portal", "firework", "happy_villager", "snowflake",
			"crit", "electric_spark", "sculk_soul", "crimson_spore", "small_gust", "nautilus", "smoke", "ash", "composter",
	};

	record Display(JsonObject mainhand, JsonObject offhand, String particle) {
		static final Display NONE = new Display(null, null, null);

		boolean isEmpty() {
			return mainhand == null && offhand == null && particle == null;
		}

		JsonObject toJson() {
			JsonObject o = new JsonObject();
			if (mainhand != null) o.add("mainhand", mainhand);
			if (offhand != null) o.add("offhand", offhand);
			if (particle != null) o.addProperty("particle", particle);
			return o;
		}

		static Display fromJson(JsonObject o) {
			JsonObject main = o.has("mainhand") && o.get("mainhand").isJsonObject() ? o.getAsJsonObject("mainhand") : null;
			JsonObject off = o.has("offhand") && o.get("offhand").isJsonObject() ? o.getAsJsonObject("offhand") : null;
			String particle = o.has("particle") && o.get("particle").isJsonPrimitive() ? o.get("particle").getAsString() : null;
			if (particle != null && !isParticle(particle)) particle = null;
			return new Display(main, off, particle);
		}
	}

	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

	private final Path file;
	private final Map<UUID, Display> byPlayer = new HashMap<>();
	private Consumer<UUID> onChange = id -> {};

	ProfileStore(Path file) {
		this.file = file;
		load();
	}

	// Told whenever a player's display changes (GearReporter sends it to the dashboard soon after).
	void onChange(Consumer<UUID> listener) {
		this.onChange = listener;
	}

	static boolean isParticle(String name) {
		for (String p : PARTICLES) if (p.equals(name)) return true;
		return false;
	}

	Display get(UUID player) {
		return byPlayer.getOrDefault(player, Display.NONE);
	}

	void setMainhand(UUID player, JsonObject item) {
		Display d = get(player);
		put(player, new Display(item, d.offhand(), d.particle()));
	}

	void setOffhand(UUID player, JsonObject item) {
		Display d = get(player);
		put(player, new Display(d.mainhand(), item, d.particle()));
	}

	void setParticle(UUID player, String particle) {
		Display d = get(player);
		put(player, new Display(d.mainhand(), d.offhand(), particle));
	}

	void reset(UUID player) {
		put(player, Display.NONE);
	}

	private void put(UUID player, Display d) {
		if (d.isEmpty()) byPlayer.remove(player);
		else byPlayer.put(player, d);
		save();
		onChange.accept(player);
	}

	private void load() {
		if (!Files.exists(file)) return;
		try {
			JsonElement root = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8));
			if (!root.isJsonObject()) return;
			for (Map.Entry<String, JsonElement> e : root.getAsJsonObject().entrySet()) {
				try {
					if (e.getValue().isJsonObject()) byPlayer.put(UUID.fromString(e.getKey()), Display.fromJson(e.getValue().getAsJsonObject()));
				} catch (IllegalArgumentException ignored) {
					// not a UUID: skip that entry
				}
			}
		} catch (IOException | RuntimeException e) {
			ChatLogMod.LOG.warn("Couldn't read {}; players' display choices start empty", file, e);
		}
	}

	// Written to a temporary file first, so a crash mid-write never leaves half a file.
	private void save() {
		JsonObject root = new JsonObject();
		byPlayer.forEach((id, d) -> root.add(id.toString(), d.toJson()));
		try {
			Files.createDirectories(file.getParent());
			Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
			Files.writeString(tmp, GSON.toJson(root), StandardCharsets.UTF_8);
			Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			ChatLogMod.LOG.warn("Couldn't save {}", file, e);
		}
	}
}
