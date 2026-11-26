package dev.mcserverstats.liveview.assets;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * A packed texture atlas. Rects are in atlas pixels. For an animated texture the rect is frame 0 and the remaining
 * frames follow below it as a vertical strip.
 */
public record Atlas(
		int size,
		Map<String, Rect> rects,
		List<Animation> animations,
		Set<String> opaque,
		Set<String> translucent,
		byte[] png) {

	public static final String MISSING = "liveview:missing";

	public Rect rect(String key) {
		Rect rect = rects.get(key);
		return rect != null ? rect : rects.get(MISSING);
	}

	public boolean has(String key) {
		return rects.containsKey(key);
	}

	public record Rect(int x, int y, int w, int h) {
	}

	public record Animation(String texture, int frametime, List<Integer> frames, int frameCount, int frameHeight) {
	}
}
