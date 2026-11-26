package dev.mcserverstats.liveview.snapshot;

public record CameraPoint(long viewerId, String dimension, double x, double y, double z) {
	public CameraPoint {
		dimension = dimension == null ? "" : dimension;
	}
}
