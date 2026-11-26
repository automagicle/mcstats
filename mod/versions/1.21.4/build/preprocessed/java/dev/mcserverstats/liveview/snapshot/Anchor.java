package dev.mcserverstats.liveview.snapshot;

public record Anchor(String dimension, double x, double y, double z) {
	public Anchor {
		dimension = dimension == null ? "" : dimension;
	}
}
