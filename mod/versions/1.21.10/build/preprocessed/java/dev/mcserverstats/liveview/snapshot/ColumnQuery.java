package dev.mcserverstats.liveview.snapshot;

public record ColumnQuery(String dimension, int cx, int cz, int radius) {
	public ColumnQuery {
		dimension = dimension == null ? "" : dimension;
		radius = Math.max(0, radius);
	}
}
