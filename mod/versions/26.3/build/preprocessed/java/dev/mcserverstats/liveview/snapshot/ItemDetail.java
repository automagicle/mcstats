package dev.mcserverstats.liveview.snapshot;

import java.util.List;

/**
 * What a player sees of a stack in game, copied on the server thread.
 *
 * @param foil      the enchantment glint is drawn ({@code ItemStack.hasFoil})
 * @param color     the stack's own tint for {@code dye} and {@code potion} item tints (0xRRGGBB), or -1
 * @param damage    damage taken, for the durability bar (0 when undamaged or not damageable)
 * @param maxDamage the stack's max damage, or 0
 * @param tooltip   the tooltip lines as JSON: an array of lines, each an array of {@code [text, rgb or -1, flags]}
 *                  segments, flags bit 1 bold, 2 italic, 4 underlined, 8 strikethrough, 16 obfuscated
 * @param maxStack  how many fit in one slot ({@code ItemStack.getMaxStackSize}), so the page can predict merges
 * @param contents  the stacks inside a shulker box, chest item or bundle (empty slots included for containers), or empty
 */
public record ItemDetail(boolean foil, int color, int damage, int maxDamage, String tooltip, List<SlotSample> contents, int maxStack) {
	public ItemDetail {
		contents = contents == null ? List.of() : List.copyOf(contents);
	}
}
