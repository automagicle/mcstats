package dev.mcserverstats.compat;

import java.net.URI;
import java.util.UUID;
import java.util.function.Predicate;

import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.Style;
import net.minecraft.world.item.ItemStack;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

// The few things that differ between Minecraft versions and are used in more than one place, each written
// once with the preprocessor (target.gradle) instead of at every caller. Differences used once stay where
// they're used, in //#if blocks; plain renames are in versions/renames.txt.
public final class Compat {
	private Compat() {
	}

	// Operators (permission level 3), as a command's .requires(...) or a check on any source.
	public static Predicate<CommandSourceStack> admins() {
		//#if MC >= 1.21.6
		return Commands.hasPermission(Commands.LEVEL_ADMINS);
		//#else
		//$$ return source -> source.hasPermission(Commands.LEVEL_ADMINS);
		//#endif
	}

	// The world a player is in (before 1.21.6 ServerPlayer.level() was typed as Level).
	public static ServerLevel level(ServerPlayer player) {
		//#if MC >= 1.21.6
		return player.level();
		//#else
		//$$ return player.serverLevel();
		//#endif
	}

	/* ---------- chat click and hover events (records from 1.21.5, one class with an action before) ---------- */

	public static ClickEvent suggestCommand(String command) {
		//#if MC >= 1.21.5
		return new ClickEvent.SuggestCommand(command);
		//#else
		//$$ return new ClickEvent(ClickEvent.Action.SUGGEST_COMMAND, command);
		//#endif
	}

	public static ClickEvent openUrl(URI uri) {
		//#if MC >= 1.21.5
		return new ClickEvent.OpenUrl(uri);
		//#else
		//$$ return new ClickEvent(ClickEvent.Action.OPEN_URL, uri.toString());
		//#endif
	}

	public static ClickEvent copyToClipboard(String text) {
		//#if MC >= 1.21.5
		return new ClickEvent.CopyToClipboard(text);
		//#else
		//$$ return new ClickEvent(ClickEvent.Action.COPY_TO_CLIPBOARD, text);
		//#endif
	}

	public static HoverEvent showText(Component text) {
		//#if MC >= 1.21.5
		return new HoverEvent.ShowText(text);
		//#else
		//$$ return new HoverEvent(HoverEvent.Action.SHOW_TEXT, text);
		//#endif
	}

	// The entity a piece of text stands for (a name in a message carries it as its hover), or null.
	public static HoverEvent.EntityTooltipInfo hoverEntity(Style style) {
		if (style == null) return null;
		//#if MC >= 1.21.5
		return style.getHoverEvent() instanceof HoverEvent.ShowEntity show ? show.entity() : null;
		//#else
		//$$ HoverEvent hover = style.getHoverEvent();
		//$$ return hover == null ? null : hover.getValue(HoverEvent.Action.SHOW_ENTITY);
		//#endif
	}

	public static UUID uuid(HoverEvent.EntityTooltipInfo info) {
		//#if MC >= 1.21.5
		return info.uuid;
		//#else
		//$$ return info.id;
		//#endif
	}

	// The item a piece of text shows when hovered (an item's name in a death message), or null.
	public static ItemStack hoverItem(Style style) {
		if (style == null) return null;
		//#if MC >= 26.1
		//$$ return style.getHoverEvent() instanceof HoverEvent.ShowItem show ? show.item().create() : null;
		//#elseif MC >= 1.21.5
		return style.getHoverEvent() instanceof HoverEvent.ShowItem show ? show.item() : null;
		//#else
		//$$ HoverEvent hover = style.getHoverEvent();
		//$$ HoverEvent.ItemStackInfo info = hover == null ? null : hover.getValue(HoverEvent.Action.SHOW_ITEM);
		//$$ return info == null ? null : info.getItemStack();
		//#endif
	}
}
