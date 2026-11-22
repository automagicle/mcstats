package dev.mcserverstats.liveview.snapshot;

import java.util.List;
import java.util.UUID;

/**
 * {@code skinTextures} is the raw base64 {@code textures} profile property copied on the server thread. It never goes
 * on the wire. A worker resolves it into {@code skin} (a hashed asset path) and {@code skinModel} ({@code wide} or
 * {@code slim}).
 */
public record PlayerSample(
		UUID uuid,
		String name,
		String dimension,
		double x,
		double y,
		double z,
		float yaw,
		float pitch,
		Double health,
		Double maxHealth,
		Integer hunger,
		Float saturation,
		String gameMode,
		Integer selectedSlot,
		String heldItem,
		List<String> armor,
		String skinTextures,
		String skin,
		String skinModel,
		Look look) {

	public PlayerSample {
		if (uuid == null || name == null || dimension == null) {
			throw new IllegalArgumentException("player sample is missing identity");
		}
		armor = armor == null ? List.of() : List.copyOf(armor);
	}

	public PlayerSample withSkin(String resolvedSkin, String resolvedModel, String cape) {
		return new PlayerSample(
				uuid,
				name,
				dimension,
				x,
				y,
				z,
				yaw,
				pitch,
				health,
				maxHealth,
				hunger,
				saturation,
				gameMode,
				selectedSlot,
				heldItem,
				armor,
				skinTextures,
				resolvedSkin,
				resolvedModel,
				look == null ? null : look.withCape(cape));
	}

	public static PlayerSample pose(
			UUID uuid,
			String name,
			String dimension,
			double x,
			double y,
			double z,
			float yaw,
			float pitch) {
		return new PlayerSample(
				uuid,
				name,
				dimension,
				x,
				y,
				z,
				yaw,
				pitch,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				List.of(),
				null,
				null,
				null,
				null);
	}
}
