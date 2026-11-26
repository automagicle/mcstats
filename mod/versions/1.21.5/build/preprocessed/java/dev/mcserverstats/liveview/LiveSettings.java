package dev.mcserverstats.liveview;

/**
 * Liveview's settings, from {@code config/mcstats-chat.properties}.
 *
 * @param enabled            whether the dashboard may watch at all ({@code liveview})
 * @param control            whether the dashboard may run commands and move items, with the control key ({@code liveview_control})
 * @param cameraChunkRadius  chunks of terrain sent around a viewer's camera, at most 12
 * @param playerChunkRadius  chunks kept ready around each player, at most 4
 * @param entityRadiusBlocks how far from a player or camera mobs are sent
 * @param entityHz           mob updates a second, at most 10
 * @param clientJar          a Minecraft client jar to read textures from, or blank to download the official one
 */
public record LiveSettings(
		boolean enabled,
		boolean control,
		int cameraChunkRadius,
		int playerChunkRadius,
		int entityRadiusBlocks,
		int entityHz,
		String clientJar) {

	public static final LiveSettings DEFAULT = new LiveSettings(true, true, 8, 2, 64, 10, "");

	public LiveSettings {
		cameraChunkRadius = clamp(cameraChunkRadius, 8, 2, 12);
		playerChunkRadius = clamp(playerChunkRadius, 2, 0, 4);
		entityRadiusBlocks = clamp(entityRadiusBlocks, 64, 0, 128);
		entityHz = clamp(entityHz, 10, 1, 10);
		clientJar = clientJar == null ? "" : clientJar.trim();
	}

	/** The same settings with Liveview switched off. */
	public LiveSettings off() {
		return new LiveSettings(false, false, cameraChunkRadius, playerChunkRadius, entityRadiusBlocks, entityHz, clientJar);
	}

	/** Reads a whole number setting; blank or not a number gives -1, which the constructor turns into the default. */
	public static int number(String text) {
		try {
			return text == null || text.isBlank() ? -1 : Integer.parseInt(text.trim());
		} catch (NumberFormatException e) {
			return -1;
		}
	}

	private static int clamp(int value, int fallback, int min, int max) {
		return value < 0 ? fallback : Math.max(min, Math.min(max, value));
	}
}
