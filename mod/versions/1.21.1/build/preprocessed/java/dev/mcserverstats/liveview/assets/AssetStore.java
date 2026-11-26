package dev.mcserverstats.liveview.assets;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/** Content-addressed bytes the dashboard serves at {@code /api/liveview/assets/<sha256>.<ext>}, fetched from here over the relay. */
public final class AssetStore {
	/** Where the dashboard serves these; every path sent to the page starts with it. */
	public static final String PREFIX = "/api/liveview/assets/";
	private static final Pattern NAME = Pattern.compile("[0-9a-f]{64}\\.(png|json)");
	private static final int MAX_ENTRIES = 512;

	private final Map<String, Entry> entries = new ConcurrentHashMap<>();

	public void put(String name, byte[] bytes, String contentType, boolean publicCache) {
		if (entries.size() >= MAX_ENTRIES && !entries.containsKey(name)) {
			return;
		}
		entries.put(name, new Entry(bytes, contentType, publicCache));
	}

	public void remove(String name) {
		if (name != null) {
			entries.remove(name);
		}
	}

	public Entry get(String name) {
		if (name == null || !NAME.matcher(name).matches()) {
			return null;
		}
		return entries.get(name);
	}

	public record Entry(byte[] bytes, String contentType, boolean publicCache) {
	}
}
