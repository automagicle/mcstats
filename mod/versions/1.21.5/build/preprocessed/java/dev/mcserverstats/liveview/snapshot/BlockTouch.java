package dev.mcserverstats.liveview.snapshot;

public record BlockTouch(String dimension, int x, int y, int z) {
	public BlockTouch {
		dimension = dimension == null ? "" : dimension;
	}
}
