package dev.mcserverstats.liveview.snapshot;

import java.util.UUID;

public record EntitySample(
		int id,
		UUID uuid,
		String type,
		String dimension,
		double x,
		double y,
		double z,
		float yaw,
		float pitch,
		Double health,
		float width,
		float height,
		boolean baby,
		float headYaw,
		String item,
		Look look) {

	public EntitySample {
		type = type == null ? "" : type;
		dimension = dimension == null ? "" : dimension;
	}
}
