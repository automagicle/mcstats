package dev.mcserverstats.liveview.snapshot;

public record SectionId(String dimension, int cx, int sy, int cz) {
	public SectionId {
		dimension = dimension == null ? "" : dimension;
	}

	public int blockX() {
		return cx << 4;
	}

	public int blockY() {
		return sy << 4;
	}

	public int blockZ() {
		return cz << 4;
	}
}
