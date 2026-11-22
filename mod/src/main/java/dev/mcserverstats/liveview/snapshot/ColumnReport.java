package dev.mcserverstats.liveview.snapshot;

import java.util.Set;

public record ColumnReport(String dimension, int minSectionY, int maxSectionY, Set<Long> loaded) {
	public ColumnReport {
		dimension = dimension == null ? "" : dimension;
		loaded = loaded == null ? Set.of() : Set.copyOf(loaded);
	}

	public static long key(int cx, int cz) {
		return ((long) cx << 32) | (cz & 0xffffffffL);
	}

	public boolean isLoaded(int cx, int cz) {
		return loaded.contains(key(cx, cz));
	}
}
