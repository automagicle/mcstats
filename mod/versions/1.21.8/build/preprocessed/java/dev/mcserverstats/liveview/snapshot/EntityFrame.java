package dev.mcserverstats.liveview.snapshot;

import java.util.List;

public record EntityFrame(
		List<EntitySample> entities,
		List<Anchor> players,
		List<CameraPoint> cameras,
		int radius,
		boolean throttled) {

	public static final int CAMERA_BLOCKS = 48;

	public EntityFrame {
		entities = entities == null ? List.of() : List.copyOf(entities);
		players = players == null ? List.of() : List.copyOf(players);
		cameras = cameras == null ? List.of() : List.copyOf(cameras);
		radius = Math.max(0, radius);
	}

	public static int cameraRadius(int entityRadius) {
		return Math.min(CAMERA_BLOCKS, Math.max(0, entityRadius));
	}

	public int cameraRadius() {
		return cameraRadius(radius);
	}

	public EntityFrame withThrottled(boolean value) {
		if (value == throttled) {
			return this;
		}
		return new EntityFrame(entities, players, cameras, radius, value);
	}

	public static EntityFrame empty(int radius) {
		return new EntityFrame(List.of(), List.of(), List.of(), radius, false);
	}
}
