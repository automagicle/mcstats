package dev.mcserverstats.liveview.assets;

/**
 * One face in block space (0..1 per axis) with atlas UVs. {@code cull} and {@code facing} are direction indexes
 * (0 down, 1 up, 2 north, 3 south, 4 west, 5 east) or -1. {@code canonical} marks a full face whose UVs are the
 * default projection of a whole tile, which is the only kind of face the greedy pass may merge. {@code shade} is the
 * element's {@code shade} flag and {@code ao} the model's {@code ambientocclusion} flag; cross plants have both off.
 */
public record BakedQuad(
		float[] positions,
		float[] uvs,
		int cull,
		int facing,
		int tintIndex,
		String texture,
		boolean canonical,
		boolean shade,
		boolean ao) {

	/** Vanilla's fixed face brightness: down 0.5, up 1.0, north/south 0.8, west/east 0.6 (or 1.0 when shade is off). */
	public static final float[] FACE_SHADE = {0.5f, 1.0f, 0.8f, 0.8f, 0.6f, 0.6f};

	public float shadeFactor() {
		return !shade || facing < 0 ? 1f : FACE_SHADE[facing];
	}
}
