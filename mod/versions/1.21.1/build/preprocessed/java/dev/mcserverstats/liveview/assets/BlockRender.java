package dev.mcserverstats.liveview.assets;

import java.util.List;

/**
 * Everything the mesher needs for one block state. Each part is a weighted list of baked alternatives; the mesher
 * picks one per part from the block position, the way vanilla picks a random variant.
 */
public record BlockRender(
		String block,
		List<Part> parts,
		boolean fullCube,
		boolean opaque,
		Fluid fluid,
		Fluid extraFluid,
		int power,
		int age,
		int level) {

	public static final BlockRender AIR = new BlockRender("minecraft:air", List.of(), false, false, Fluid.NONE, Fluid.NONE, 0, 0, 0);

	public enum Fluid {
		NONE,
		WATER,
		LAVA
	}

	public record Part(List<List<BakedQuad>> choices, int[] weights, int totalWeight) {
		public List<BakedQuad> pick(int hash) {
			if (choices.size() == 1 || totalWeight <= 0) {
				return choices.get(0);
			}
			int roll = Math.floorMod(hash, totalWeight);
			for (int i = 0; i < choices.size(); i++) {
				roll -= weights[i];
				if (roll < 0) {
					return choices.get(i);
				}
			}
			return choices.get(0);
		}
	}
}
