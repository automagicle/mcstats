package dev.mcserverstats.liveview.snapshot;

/**
 * The overworld's sky right now, copied on the server thread for the page's sun, moon, clouds, rain and light.
 *
 * @param skyDarken vanilla's sky darkening, 0 at noon to 11 at midnight (rain and thunder included)
 * @param time      the overworld clock in ticks (24000 per day; the day count picks the moon phase), or -1 if unknown
 * @param rain      rain level, 0 to 1
 * @param thunder   thunder level, 0 to 1
 */
public record WorldSky(int skyDarken, long time, float rain, float thunder) {
	public static final WorldSky UNKNOWN = new WorldSky(0, -1, 0f, 0f);
}
