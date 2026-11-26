package dev.mcserverstats.liveview.assets;

import java.util.Map;

/** Everything the asset worker produced. Immutable once published. */
public record AssetBundle(
		Atlas atlas,
		BlockModels models,
		byte[] metaJson,
		String atlasHash,
		String metaHash,
		Map<String, Png.Image> colormaps,
		Map<String, String> entityTextures,
		Map<String, byte[]> files) {

	/** Extra content-addressed files (item models, GUI textures, font) keyed by their {@code <sha256>.<ext>} name. */
	public AssetBundle {
		files = files == null ? Map.of() : Map.copyOf(files);
	}

	public String atlasUrl() {
		return AssetStore.PREFIX + atlasHash + ".png";
	}

	public String metaUrl() {
		return AssetStore.PREFIX + metaHash + ".json";
	}
}
