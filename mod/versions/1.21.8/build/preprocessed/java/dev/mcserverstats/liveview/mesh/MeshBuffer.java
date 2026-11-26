package dev.mcserverstats.liveview.mesh;

import java.util.Arrays;

/** Growable float buffer of {@code x, y, z, u, v, r, g, b, sky, block} vertices, four per quad. Light is 0-15. */
final class MeshBuffer {
	static final int FLOATS = 10;

	private float[] data = new float[FLOATS * 4 * 256];
	private int size;

	void vertex(float x, float y, float z, float u, float v, float r, float g, float b, float sky, float block) {
		if (size + FLOATS > data.length) {
			data = Arrays.copyOf(data, data.length * 2);
		}
		data[size++] = x;
		data[size++] = y;
		data[size++] = z;
		data[size++] = u;
		data[size++] = v;
		data[size++] = r;
		data[size++] = g;
		data[size++] = b;
		data[size++] = sky;
		data[size++] = block;
	}

	int vertexCount() {
		return size / FLOATS;
	}

	float[] data() {
		return data;
	}

	int floats() {
		return size;
	}
}
