package dev.mcserverstats.liveview.snapshot;

import java.util.List;

/**
 * How a mob or player looks right now, beyond its type. Copied on the server thread.
 *
 * @param light    sky light in the high nibble, block light in the low one, at the entity's block
 * @param texture  exact texture id from a data-driven variant (wolf, cat, pig, cow, chicken, frog), or null
 * @param model    the variant's model type ("normal", "cold", "warm") where it changes the geometry, or null
 * @param variant  the serialized name of an enum variant (fox, rabbit, parrot, llama, axolotl, horse, mooshroom), or null
 * @param wool     sheep wool color 0xRRGGBB, -2 when sheared, -1 otherwise
 * @param armor    equipment asset ids for head, chest, legs, feet ("" for none)
 * @param dye      dyed color per armor slot, -1 for undyed
 * @param mainHand held item id, or "minecraft:air"
 * @param offHand  off-hand item id, or "minecraft:air"
 * @param cape     hashed cape asset path for players with a cape, or null
 * @param foil     enchantment glint bits: 1 head, 2 chest, 4 legs, 8 feet, 16 main hand, 32 off hand; on projectiles,
 *                 {@link #FOIL_CRIT} for a crit arrow and {@link #FOIL_DANGEROUS} for a blue wither skull
 * @param mainTint the main-hand stack's dye or potion color (0xRRGGBB), or -1; for a thrown potion or an effect
 *                 cloud, the potion's color
 * @param offTint  the same for the off hand
 * @param motion   how the body is moving right now, for the page's animation
 */
public record Look(
		int light,
		String texture,
		String model,
		String variant,
		int wool,
		List<String> armor,
		List<Integer> dye,
		String mainHand,
		String offHand,
		String cape,
		int foil,
		int mainTint,
		int offTint,
		Motion motion) {
	/** Foil bit: an arrow shot at full charge (it trails crit particles). */
	public static final int FOIL_CRIT = 64;
	/** Foil bit: a dangerous (blue) wither skull. */
	public static final int FOIL_DANGEROUS = 128;

	public Look {
		armor = armor == null ? List.of() : List.copyOf(armor);
		dye = dye == null ? List.of() : List.copyOf(dye);
	}

	public Look withCape(String path) {
		return new Look(light, texture, model, variant, wool, armor, dye, mainHand, offHand, path, foil, mainTint, offTint, motion);
	}

	/**
	 * @param pose      the entity pose name ({@code standing}, {@code crouching}, {@code sleeping}, {@code swimming},
	 *                  {@code fall_flying}, {@code spin_attack}, {@code dying}, ...)
	 * @param sprinting sprinting
	 * @param swing     ticks into the current arm swing (0-5), or -1 when not swinging
	 * @param swingOff  the swing is with the off hand
	 * @param using     ticks the held item has been in use (drawing a bow, eating, blocking), or -1
	 * @param useOff    the item in use is in the off hand
	 * @param hurt      ticks left of the red hurt flash, 0 when none
	 * @param riding    sitting on another entity
	 * @param radius    effect cloud radius, or 0
	 */
	public record Motion(String pose, boolean sprinting, int swing, boolean swingOff, int using, boolean useOff, int hurt,
			boolean riding, float radius) {
		public static final Motion STILL = new Motion("standing", false, -1, false, -1, false, 0, false, 0f);
	}
}
