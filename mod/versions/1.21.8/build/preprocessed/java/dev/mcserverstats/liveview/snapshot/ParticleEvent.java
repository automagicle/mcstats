package dev.mcserverstats.liveview.snapshot;

/**
 * One particle broadcast the server sent to players, copied on the server thread. {@code count} 0 means one particle
 * moving at {@code (dx, dy, dz) * speed}; otherwise {@code count} particles spread by a gaussian of {@code (dx, dy, dz)}
 * with gaussian speed, which is how the client unpacks the vanilla packet. {@code block} is a block id for block and
 * break particles; {@code color} is 0xRRGGBB for dust, or -1.
 */
public record ParticleEvent(
		String dimension,
		String type,
		double x,
		double y,
		double z,
		int count,
		float dx,
		float dy,
		float dz,
		float speed,
		String block,
		int color) {
}
