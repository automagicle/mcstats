package dev.mcserverstats.liveview.mesh;

import dev.mcserverstats.liveview.snapshot.SectionId;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.zip.Deflater;

/** Binary section frame, kind 1, exactly as {@code mod/PROTOCOL.md} lays it out. Always zlib-wrapped. */
public final class FrameCodec {
	public static final byte KIND_SECTION = 1;
	public static final byte FLAG_ZLIB = 1;
	/** Vertices carry sky and block light after the color: 10 floats instead of 8. */
	public static final byte FLAG_LIT = 2;
	/** Vertex floats are little-endian, so the page can view them as a Float32Array without converting each one. */
	public static final byte FLAG_LITTLE_ENDIAN_VERTICES = 4;
	/** Face shading (and the element's shade flag) is already in the vertex color; the page must not shade again. */
	public static final byte FLAG_SHADED = 8;

	private FrameCodec() {
	}

	public static byte[] section(SectionId id, SectionMesher.Mesh mesh) {
		int vertices = mesh.vertexCount();
		byte[] emitters = mesh.emitters() == null ? new byte[0] : mesh.emitters();
		byte[] specials = mesh.specials() == null ? new byte[0] : mesh.specials();
		ByteBuffer body = ByteBuffer.allocate(4 + vertices * MeshBuffer.FLOATS * 4 + 4 + emitters.length + 4 + specials.length).order(ByteOrder.BIG_ENDIAN);
		body.putInt(vertices);
		float[] data = mesh.data();
		body.order(ByteOrder.LITTLE_ENDIAN);
		for (int i = 0; i < vertices * MeshBuffer.FLOATS; i++) {
			body.putFloat(data[i]);
		}
		body.order(ByteOrder.BIG_ENDIAN);
		// After the vertices: emitter count, then 4 bytes each (x, y, z, kind). Older pages stop reading at the vertices.
		body.putInt(emitters.length / 4);
		body.put(emitters);
		// Then block entities the page draws itself (chests): count, then 5 bytes each (x, y, z, kind, light).
		body.putInt(specials.length / 5);
		body.put(specials);
		byte[] compressed = deflate(body.array());
		byte[] dimension = id.dimension().getBytes(StandardCharsets.UTF_8);
		ByteBuffer frame = ByteBuffer.allocate(16 + dimension.length + compressed.length).order(ByteOrder.BIG_ENDIAN);
		frame.put(KIND_SECTION);
		frame.put((byte) (FLAG_ZLIB | FLAG_LIT | FLAG_LITTLE_ENDIAN_VERTICES | FLAG_SHADED));
		frame.putInt(id.cx());
		frame.putInt(id.cz());
		frame.putInt(id.sy());
		frame.putShort((short) dimension.length);
		frame.put(dimension);
		frame.put(compressed);
		return frame.array();
	}

	private static byte[] deflate(byte[] input) {
		Deflater deflater = new Deflater(Deflater.BEST_SPEED, false);
		try {
			deflater.setInput(input);
			deflater.finish();
			ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(64, input.length / 4));
			byte[] buffer = new byte[16 * 1024];
			while (!deflater.finished()) {
				int n = deflater.deflate(buffer);
				out.write(buffer, 0, n);
			}
			return out.toByteArray();
		} finally {
			deflater.end();
		}
	}
}
