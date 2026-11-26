package dev.mcserverstats.compat;

import java.util.function.Predicate;

import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
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
		//$$ return Commands.hasPermission(Commands.LEVEL_ADMINS);
		//#else
		return source -> source.hasPermission(Commands.LEVEL_ADMINS);
		//#endif
	}

	// The world a player is in (before 1.21.6 ServerPlayer.level() was typed as Level).
	public static ServerLevel level(ServerPlayer player) {
		//#if MC >= 1.21.6
		//$$ return player.level();
		//#else
		return player.serverLevel();
		//#endif
	}
}
