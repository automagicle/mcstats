package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.ItemDetail;
import dev.mcserverstats.liveview.snapshot.SlotSample;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.component.DataComponents;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;
import net.minecraft.network.chat.TextColor;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.TooltipFlag;
import net.minecraft.world.item.alchemy.PotionContents;
import net.minecraft.world.item.component.BundleContents;
import net.minecraft.world.item.component.DyedItemColor;
import net.minecraft.world.item.component.ItemContainerContents;
import net.minecraft.world.level.Level;

/**
 * Copies a stack the way the game shows it: the tooltip lines exactly as {@code ItemStack.getTooltipLines} builds them
 * (name with rarity color, enchantments, lore, attributes, potion effects, and so on), the glint, the dye or potion
 * color, durability and nested contents. Server thread only.
 *
 * <p>VERIFIED by javap on the 26.2 merged jar: {@code ItemStack.getTooltipLines(Item.TooltipContext, Player,
 * TooltipFlag)}, {@code Item.TooltipContext.of(Level)}, {@code TooltipFlag.NORMAL}, {@code ItemStack.hasFoil/
 * isDamageableItem/getDamageValue/getMaxDamage}, {@code ItemStack.hashItemAndComponents},
 * {@code FormattedText.visit(StyledContentConsumer, Style)}, {@code Style.getColor/isBold/isItalic/isUnderlined/
 * isStrikethrough/isObfuscated}, {@code TextColor.getValue}, {@code PotionContents.getColor},
 * {@code DyedItemColor.rgb}, {@code ItemContainerContents.allItemsCopyStream}, {@code BundleContents.itemCopyStream}.
 */
public final class Stacks {
	private static final int CACHE = 2048;
	/** Tooltips cost a little to build; identical stacks (same item and components) share one. */
	private static final Map<Integer, Cached> TOOLTIPS = new LinkedHashMap<>(256, 0.75f, true) {
		@Override
		protected boolean removeEldestEntry(Map.Entry<Integer, Cached> eldest) {
			return size() > CACHE;
		}
	};

	private Stacks() {
	}

	public static void clearCache() {
		synchronized (TOOLTIPS) {
			TOOLTIPS.clear();
		}
	}

	/** A full slot with detail, or an empty slot. */
	public static SlotSample slot(int index, ItemStack stack, Level level, Player player) {
		String item = Ids.item(stack);
		int count = Ids.count(stack);
		if (count <= 0 || "minecraft:air".equals(item)) {
			return new SlotSample(index, "minecraft:air", 0, null, null);
		}
		return new SlotSample(index, item, count, Ids.customName(stack), detail(stack, level, player, true));
	}

	public static ItemDetail detail(ItemStack stack, Level level, Player player, boolean withContents) {
		try {
			boolean foil = stack.hasFoil();
			int color = -1;
			PotionContents potion = stack.get(DataComponents.POTION_CONTENTS);
			if (potion != null) {
				color = potion.getColor() & 0xFFFFFF;
			}
			DyedItemColor dyed = stack.get(DataComponents.DYED_COLOR);
			if (dyed != null) {
				color = dyed.rgb() & 0xFFFFFF;
			}
			int damage = stack.isDamageableItem() ? stack.getDamageValue() : 0;
			int maxDamage = stack.isDamageableItem() ? stack.getMaxDamage() : 0;
			List<SlotSample> contents = List.of();
			if (withContents) {
				contents = contents(stack, level, player);
			}
			return new ItemDetail(foil, color, damage, maxDamage, tooltip(stack, level, player), contents, stack.getMaxStackSize());
		} catch (Throwable thrown) {
			LogOnce.warn("stack-detail", "Liveview could not read an item's details", thrown);
			return null;
		}
	}

	private static List<SlotSample> contents(ItemStack stack, Level level, Player player) {
		List<SlotSample> out = new ArrayList<>();
		ItemContainerContents container = stack.get(DataComponents.CONTAINER);
		if (container != null) {
			//#if MC >= 26.3
			//$$ List<ItemStack> items = container.itemCopies().toList();
			//#elseif MC >= 26.1
			List<ItemStack> items = container.allItemsCopyStream().toList();
			//#else
			//$$ List<ItemStack> items = container.stream().toList();
			//#endif
			for (int i = 0; i < Math.min(items.size(), 54); i++) {
				out.add(nested(i, items.get(i), level, player));
			}
			return out;
		}
		BundleContents bundle = stack.get(DataComponents.BUNDLE_CONTENTS);
		if (bundle != null) {
			//#if MC >= 26.3
			//$$ List<ItemStack> items = bundle.itemCopies().toList();
			//#else
			List<ItemStack> items = bundle.itemCopyStream().toList();
			//#endif
			for (int i = 0; i < Math.min(items.size(), 64); i++) {
				out.add(nested(i, items.get(i), level, player));
			}
		}
		return out;
	}

	/** Nested stacks keep their tooltip (for hovering inside a preview) but not their own contents. */
	private static SlotSample nested(int index, ItemStack stack, Level level, Player player) {
		String item = Ids.item(stack);
		int count = Ids.count(stack);
		if (count <= 0 || "minecraft:air".equals(item)) {
			return new SlotSample(index, "minecraft:air", 0, null, null);
		}
		return new SlotSample(index, item, count, Ids.customName(stack), detail(stack, level, player, false));
	}

	private static String tooltip(ItemStack stack, Level level, Player player) {
		int key = ItemStack.hashItemAndComponents(stack) * 31 + stack.getCount();
		synchronized (TOOLTIPS) {
			Cached hit = TOOLTIPS.get(key);
			if (hit != null && ItemStack.isSameItemSameComponents(hit.stack, stack)) {
				return hit.json;
			}
		}
		List<Component> lines = stack.getTooltipLines(
				level == null ? Item.TooltipContext.EMPTY : Item.TooltipContext.of(level), player, TooltipFlag.NORMAL);
		StringBuilder out = new StringBuilder("[");
		for (int i = 0; i < lines.size() && i < 64; i++) {
			if (i > 0) {
				out.append(',');
			}
			line(out, lines.get(i));
		}
		String json = out.append(']').toString();
		synchronized (TOOLTIPS) {
			TOOLTIPS.put(key, new Cached(stack.copy(), json));
		}
		return json;
	}

	/** One component as [[text, rgb, flags], ...], the styled runs {@code Component.visit} yields. */
	public static String line(Component component) {
		StringBuilder out = new StringBuilder();
		line(out, component);
		return out.toString();
	}

	private static void line(StringBuilder out, Component component) {
		out.append('[');
		boolean[] first = {true};
		component.visit((Style style, String text) -> {
			if (text.isEmpty()) {
				return java.util.Optional.empty();
			}
			if (!first[0]) {
				out.append(',');
			}
			first[0] = false;
			TextColor color = style.getColor();
			int flags = (style.isBold() ? 1 : 0) | (style.isItalic() ? 2 : 0) | (style.isUnderlined() ? 4 : 0)
					| (style.isStrikethrough() ? 8 : 0) | (style.isObfuscated() ? 16 : 0);
			out.append('[');
			string(out, text.length() > 512 ? text.substring(0, 512) : text);
			out.append(',').append(color == null ? -1 : color.getValue() & 0xFFFFFF).append(',').append(flags).append(']');
			return java.util.Optional.empty();
		}, Style.EMPTY);
		out.append(']');
	}

	static void string(StringBuilder out, String value) {
		out.append('"');
		for (int i = 0; i < value.length(); i++) {
			char c = value.charAt(i);
			if (c == '"' || c == '\\') {
				out.append('\\').append(c);
			} else if (c < 0x20) {
				out.append(String.format("\\u%04x", (int) c));
			} else if (c == ' ' || c == ' ') {
				out.append(String.format("\\u%04x", (int) c));
			} else {
				out.append(c);
			}
		}
		out.append('"');
	}

	private record Cached(ItemStack stack, String json) {
	}
}
