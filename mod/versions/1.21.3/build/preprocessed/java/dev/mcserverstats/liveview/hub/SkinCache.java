package dev.mcserverstats.liveview.hub;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.assets.AssetPipeline;
import dev.mcserverstats.liveview.assets.AssetStore;
import dev.mcserverstats.liveview.assets.Png;
import dev.mcserverstats.liveview.json.Json;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.Locale;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Semaphore;

/**
 * Resolves a player's base64 {@code textures} profile property into a hashed skin asset. Decoding and the download
 * run on worker threads; callers only read the map. A failed fetch resolves to no skin, so the page keeps the default.
 *
 * <p>The property embeds a timestamp and changes on every login, so it is not the cache key. It is decoded once
 * (memoized, bounded) into the skin URL plus model, and that pair is the key. Both maps are LRU; evicting a skin also
 * drops its bytes from the {@link AssetStore}.
 */
final class SkinCache {
	private static final int MAX_SKIN_BYTES = 256 * 1024;
	private static final int MAX_SKINS = 256;
	private static final int MAX_PROPERTIES = 1024;
	private static final Target NO_TARGET = new Target("", "wide");

	private final AssetStore store;
	private final ExecutorService tasks;
	private final Semaphore permits = new Semaphore(2);
	private final Object lock = new Object();
	private final LinkedHashMap<String, Target> properties = new LinkedHashMap<>(64, 0.75f, true) {
		@Override
		protected boolean removeEldestEntry(Map.Entry<String, Target> eldest) {
			return size() > MAX_PROPERTIES;
		}
	};
	private final LinkedHashMap<Target, Resolved> skins = new LinkedHashMap<>(64, 0.75f, true);
	private final HttpClient http = HttpClient.newBuilder()
			.connectTimeout(Duration.ofSeconds(10))
			.followRedirects(HttpClient.Redirect.NEVER)
			.build();

	SkinCache(AssetStore store, ExecutorService tasks) {
		this.store = store;
		this.tasks = tasks;
	}

	private final LinkedHashMap<String, Target> capes = new LinkedHashMap<>(64, 0.75f, true) {
		@Override
		protected boolean removeEldestEntry(Map.Entry<String, Target> eldest) {
			return size() > MAX_PROPERTIES;
		}
	};

	/** The hashed cape asset path, or null when the player has no cape or the fetch is still running. */
	String cape(String texturesProperty) {
		if (texturesProperty == null || texturesProperty.isBlank() || texturesProperty.length() > 16 * 1024) {
			return null;
		}
		Target target;
		synchronized (lock) {
			target = capes.get(texturesProperty);
		}
		if (target == null) {
			target = parseCape(texturesProperty);
			synchronized (lock) {
				capes.put(texturesProperty, target);
			}
		}
		if (target == NO_TARGET || target.url() == null) {
			return null;
		}
		Resolved resolved = resolve(target);
		return resolved == null ? null : resolved.path();
	}

	/** Returns the resolved skin, or null while the fetch is still running. */
	Resolved lookup(String texturesProperty) {
		if (texturesProperty == null || texturesProperty.isBlank() || texturesProperty.length() > 16 * 1024) {
			return Resolved.NONE;
		}
		Target target;
		synchronized (lock) {
			target = properties.get(texturesProperty);
		}
		if (target == null) {
			target = parse(texturesProperty);
			synchronized (lock) {
				properties.put(texturesProperty, target);
			}
		}
		if (target == NO_TARGET) {
			return Resolved.NONE;
		}
		if (target.url() == null) {
			return new Resolved(null, target.model());
		}
		return resolve(target);
	}

	private Resolved resolve(Target target) {
		boolean start = false;
		Resolved known;
		synchronized (lock) {
			known = skins.get(target);
			if (known == null) {
				skins.put(target, Resolved.PENDING);
				evictLocked();
				start = true;
			}
		}
		if (start) {
			Target wanted = target;
			try {
				tasks.submit(() -> fetch(wanted));
			} catch (RuntimeException shuttingDown) {
				synchronized (lock) {
					skins.remove(wanted);
				}
			}
			return null;
		}
		return known == Resolved.PENDING ? null : known;
	}

	// Never evicts a pending fetch; its result would be lost and refetched forever.
	private void evictLocked() {
		var iterator = skins.entrySet().iterator();
		while (skins.size() > MAX_SKINS && iterator.hasNext()) {
			Map.Entry<Target, Resolved> eldest = iterator.next();
			if (eldest.getValue() == Resolved.PENDING) {
				continue;
			}
			iterator.remove();
			String path = eldest.getValue().path();
			if (path != null && path.startsWith(AssetStore.PREFIX)) {
				store.remove(path.substring(AssetStore.PREFIX.length()));
			}
		}
	}

	private void fetch(Target target) {
		Resolved result = new Resolved(null, target.model());
		try {
			permits.acquire();
			try {
				result = download(target);
			} finally {
				permits.release();
			}
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		} catch (Throwable thrown) {
			LogOnce.warn("skin-fetch", "Liveview could not fetch a player skin; the default skin is shown", thrown);
		}
		synchronized (lock) {
			if (skins.containsKey(target)) {
				skins.put(target, result);
			}
		}
	}

	private static Target parseCape(String property) {
		try {
			String decoded = new String(Base64.getDecoder().decode(property.trim()), StandardCharsets.UTF_8);
			if (!(Json.parse(decoded) instanceof Json.Obj root)) {
				return NO_TARGET;
			}
			Json.Obj textures = root.object("textures");
			Json.Obj cape = textures == null ? null : textures.object("CAPE");
			String url = cape == null ? null : cape.string("url");
			if (url == null) {
				return NO_TARGET;
			}
			URI uri = URI.create(url);
			String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
			if (!"textures.minecraft.net".equals(host)) {
				return NO_TARGET;
			}
			return new Target("https://textures.minecraft.net" + uri.getRawPath(), "cape");
		} catch (RuntimeException | Json.JsonException e) {
			return NO_TARGET;
		}
	}

	/** Decodes the property. {@code NO_TARGET} for garbage; a null url means "default skin of this model". */
	private static Target parse(String property) {
		try {
			String decoded = new String(Base64.getDecoder().decode(property.trim()), StandardCharsets.UTF_8);
			if (!(Json.parse(decoded) instanceof Json.Obj root)) {
				return NO_TARGET;
			}
			Json.Obj textures = root.object("textures");
			Json.Obj skin = textures == null ? null : textures.object("SKIN");
			String url = skin == null ? null : skin.string("url");
			if (url == null) {
				return NO_TARGET;
			}
			Json.Obj metadata = skin.object("metadata");
			String model = metadata != null && "slim".equals(metadata.string("model")) ? "slim" : "wide";
			URI uri = URI.create(url);
			String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
			if (!"textures.minecraft.net".equals(host) || !("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))) {
				LogOnce.warn("skin-host-" + host, "Liveview refused a skin URL outside textures.minecraft.net", null);
				return new Target(null, model);
			}
			return new Target("https://textures.minecraft.net" + uri.getRawPath(), model);
		} catch (RuntimeException | Json.JsonException e) {
			LogOnce.warn("skin-property", "Liveview could not decode a player's textures property", e);
			return NO_TARGET;
		}
	}

	private Resolved download(Target target) throws IOException, InterruptedException {
		String model = target.model();
		HttpRequest request = HttpRequest.newBuilder(URI.create(target.url())).timeout(Duration.ofSeconds(15)).GET().build();
		HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
		byte[] bytes;
		try (InputStream in = response.body()) {
			if (response.statusCode() != 200) {
				LogOnce.warn("skin-status-" + response.statusCode(), "Liveview skin fetch returned HTTP " + response.statusCode(), null);
				return new Resolved(null, model);
			}
			bytes = in.readNBytes(MAX_SKIN_BYTES + 1);
		}
		if (bytes.length > MAX_SKIN_BYTES) {
			return new Resolved(null, model);
		}
		Png.Image image = Png.decode(bytes);
		if ("cape".equals(model)) {
			if (image.width() > 128 || image.height() > 128) {
				return new Resolved(null, model);
			}
			byte[] png = Png.encode(image);
			String hash = AssetPipeline.sha256(png);
			store.put(hash + ".png", png, "image/png", false);
			return new Resolved(AssetStore.PREFIX + hash + ".png", model);
		}
		if (image.width() != 64 || (image.height() != 64 && image.height() != 32)) {
			LogOnce.warn("skin-size", "Liveview ignored a skin that is not 64x64 or 64x32", null);
			return new Resolved(null, model);
		}
		if (image.height() == 32) {
			image = legacy(image);
		}
		byte[] png = Png.encode(image);
		String hash = AssetPipeline.sha256(png);
		store.put(hash + ".png", png, "image/png", false);
		return new Resolved(AssetStore.PREFIX + hash + ".png", model);
	}

	private record Target(String url, String model) {
	}

	// A 64x32 skin has no left arm or leg. Vanilla mirrors the right limbs; copying them is close enough for a viewer.
	private static Png.Image legacy(Png.Image old) {
		int[] pixels = new int[64 * 64];
		System.arraycopy(old.pixels(), 0, pixels, 0, 64 * 32);
		copy(old.pixels(), pixels, 0, 16, 16, 48, 16, 16);
		copy(old.pixels(), pixels, 40, 16, 32, 48, 16, 16);
		return new Png.Image(64, 64, pixels);
	}

	private static void copy(int[] from, int[] to, int sx, int sy, int dx, int dy, int w, int h) {
		for (int y = 0; y < h; y++) {
			System.arraycopy(from, (sy + y) * 64 + sx, to, (dy + y) * 64 + dx, w);
		}
	}

	record Resolved(String path, String model) {
		static final Resolved NONE = new Resolved(null, null);
		static final Resolved PENDING = new Resolved(null, null);
	}
}
