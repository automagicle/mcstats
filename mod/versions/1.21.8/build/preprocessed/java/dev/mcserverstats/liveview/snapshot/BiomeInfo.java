package dev.mcserverstats.liveview.snapshot;

public record BiomeInfo(
		String id,
		float temperature,
		float downfall,
		Integer grassOverride,
		Integer foliageOverride,
		Integer dryFoliageOverride,
		String grassModifier,
		int waterColor) {

	public BiomeInfo {
		id = id == null ? "" : id;
		grassModifier = grassModifier == null ? "none" : grassModifier;
	}
}
