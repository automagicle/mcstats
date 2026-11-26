package dev.mcserverstats.liveview.assets;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.json.Json;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Packs sprites into one power-of-two RGBA atlas with a skyline packer. Every rect starts on a 16-pixel grid and is
 * padded to a multiple of 16, so the page can find the rect that owns any atlas pixel from a coarse 16x16 cell map.
 */
final class AtlasBuilder {
	static final int CELL = 16;
	private static final int[] SIZES = {512, 1024, 2048, 4096, 8192};

	private final Map<String, Sprite> sprites = new LinkedHashMap<>();
	private final Set<String> forcedTranslucent = new HashSet<>();

	void add(String key, Png.Image image, byte[] mcmeta) {
		if (sprites.containsKey(key) || image == null) {
			return;
		}
		Animation animation = parseAnimation(key, image, mcmeta);
		sprites.put(key, new Sprite(key, image, animation));
	}

	boolean contains(String key) {
		return sprites.containsKey(key);
	}

	void forceTranslucent(String key) {
		forcedTranslucent.add(key);
	}

	Atlas build() throws IOException {
		addMissing();
		List<Sprite> ordered = new ArrayList<>(sprites.values());
		ordered.sort(Comparator.comparingInt((Sprite sprite) -> padded(sprite.image.height())).reversed()
				.thenComparing(sprite -> sprite.key));
		for (int size : SIZES) {
			Map<String, int[]> placed = pack(ordered, size);
			if (placed != null) {
				return render(ordered, placed, size);
			}
		}
		throw new IOException("atlas does not fit in " + SIZES[SIZES.length - 1] + " pixels");
	}

	private void addMissing() {
		int[] pixels = new int[16 * 16];
		for (int y = 0; y < 16; y++) {
			for (int x = 0; x < 16; x++) {
				boolean magenta = (x < 8) == (y < 8);
				pixels[y * 16 + x] = magenta ? 0xFFF800F8 : 0xFF000000;
			}
		}
		sprites.putIfAbsent(Atlas.MISSING, new Sprite(Atlas.MISSING, new Png.Image(16, 16, pixels), null));
	}

	// Skyline bottom-left on the 16-pixel grid: each sprite goes where its top edge ends lowest.
	private static Map<String, int[]> pack(List<Sprite> ordered, int size) {
		Map<String, int[]> placed = new LinkedHashMap<>();
		int columns = size / CELL;
		int[] skyline = new int[columns];
		for (Sprite sprite : ordered) {
			int w = padded(sprite.image.width()) / CELL;
			int h = padded(sprite.image.height()) / CELL;
			if (w > columns || h > columns) {
				return null;
			}
			int bestX = -1;
			int bestY = Integer.MAX_VALUE;
			for (int x = 0; x + w <= columns; x++) {
				int y = 0;
				for (int i = x; i < x + w; i++) {
					y = Math.max(y, skyline[i]);
				}
				if (y < bestY) {
					bestY = y;
					bestX = x;
				}
			}
			if (bestX < 0 || bestY + h > columns) {
				return null;
			}
			for (int i = bestX; i < bestX + w; i++) {
				skyline[i] = bestY + h;
			}
			placed.put(sprite.key, new int[] {bestX * CELL, bestY * CELL});
		}
		return placed;
	}

	private Atlas render(List<Sprite> ordered, Map<String, int[]> placed, int size) throws IOException {
		int[] pixels = new int[size * size];
		Map<String, Atlas.Rect> rects = new LinkedHashMap<>();
		List<Atlas.Animation> animations = new ArrayList<>();
		Set<String> opaque = new HashSet<>();
		Set<String> translucent = new HashSet<>();
		for (Sprite sprite : ordered) {
			int[] at = placed.get(sprite.key);
			Png.Image image = sprite.image;
			for (int row = 0; row < image.height(); row++) {
				System.arraycopy(image.pixels(), row * image.width(), pixels, (at[1] + row) * size + at[0], image.width());
			}
			int frameHeight = sprite.animation == null ? image.height() : sprite.animation.frameHeight;
			int frameWidth = sprite.animation == null ? image.width() : sprite.animation.frameWidth;
			rects.put(sprite.key, new Atlas.Rect(at[0], at[1], frameWidth, frameHeight));
			if (sprite.animation != null) {
				animations.add(new Atlas.Animation(
						sprite.key,
						sprite.animation.frametime,
						sprite.animation.frames,
						sprite.animation.frameCount,
						frameHeight));
			}
			if (image.opaque(0, frameHeight)) {
				opaque.add(sprite.key);
			}
			if (forcedTranslucent.contains(sprite.key) || image.translucent(0, frameHeight)) {
				translucent.add(sprite.key);
			}
		}
		byte[] png = Png.encode(new Png.Image(size, size, pixels));
		return new Atlas(size, Map.copyOf(rects), List.copyOf(animations), Set.copyOf(opaque), Set.copyOf(translucent), png);
	}

	private static int padded(int value) {
		return Math.max(CELL, (value + CELL - 1) / CELL * CELL);
	}

	// .mcmeta "animation": frametime (ticks, default 1), optional frames (ints or {"index","time"}), optional
	// width/height of one frame. Frames without an explicit list run 0..n-1. Per-frame "time" is expanded by
	// repeating that index time/frametime times so the page only needs one frametime.
	private static Animation parseAnimation(String key, Png.Image image, byte[] mcmeta) {
		if (mcmeta == null) {
			return null;
		}
		try {
			if (!(Json.parse(new String(mcmeta, StandardCharsets.UTF_8)) instanceof Json.Obj root)) {
				return null;
			}
			Json.Obj animation = root.object("animation");
			if (animation == null) {
				return null;
			}
			Integer frametime = animation.integer("frametime");
			int time = frametime == null || frametime < 1 ? 1 : frametime;
			Integer width = animation.integer("width");
			Integer height = animation.integer("height");
			int side = Math.min(image.width(), image.height());
			int frameWidth = width != null && width > 0 ? width : (height != null && height > 0 ? image.width() : side);
			int frameHeight = height != null && height > 0 ? height : (width != null && width > 0 ? image.height() : side);
			if (frameWidth != image.width() || frameHeight <= 0 || image.height() % frameHeight != 0) {
				LogOnce.warn("mcmeta-shape-" + key, "Liveview drew " + key + " unanimated because its frames are not a vertical strip", null);
				return null;
			}
			int count = image.height() / frameHeight;
			if (count <= 1) {
				return null;
			}
			List<Integer> frames = new ArrayList<>();
			Json.Arr explicit = animation.array("frames");
			if (explicit == null) {
				for (int i = 0; i < count; i++) {
					frames.add(i);
				}
			} else {
				for (Json.Value value : explicit.items()) {
					int index;
					int repeat = 1;
					if (value instanceof Json.Num num) {
						index = (int) num.value();
					} else if (value instanceof Json.Obj obj && obj.integer("index") != null) {
						index = obj.integer("index");
						Integer frameTime = obj.integer("time");
						if (frameTime != null && frameTime > 0) {
							repeat = Math.max(1, Math.round(frameTime / (float) time));
						}
					} else {
						continue;
					}
					if (index < 0 || index >= count) {
						continue;
					}
					for (int r = 0; r < repeat; r++) {
						frames.add(index);
					}
				}
				if (frames.isEmpty()) {
					return null;
				}
			}
			return new Animation(time, List.copyOf(frames), count, frameWidth, frameHeight);
		} catch (Json.JsonException | RuntimeException e) {
			LogOnce.warn("mcmeta-" + key, "Liveview ignored a broken .mcmeta for " + key, e);
			return null;
		}
	}

	private record Sprite(String key, Png.Image image, Animation animation) {
	}

	private record Animation(int frametime, List<Integer> frames, int frameCount, int frameWidth, int frameHeight) {
	}
}
