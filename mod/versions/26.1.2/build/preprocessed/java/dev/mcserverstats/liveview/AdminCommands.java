package dev.mcserverstats.liveview;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Runs a Minecraft command from the dashboard as the server console (full operator rights). RelayLink checks that
 * the viewer has controls on before calling this; implementations hop to the server thread and complete off it.
 */
public interface AdminCommands {
	CompletableFuture<Outcome> run(String command);

	/** Moves items between a block container, a player's inventory and their ender chest (see ItemMove); server thread inside. */
	default CompletableFuture<Outcome> moveItem(ItemMove move) {
		return CompletableFuture.completedFuture(new Outcome(false, List.of("Item moves are not available.")));
	}

	/**
	 * One atomic item move between two sides: {@code 'c'} the block container at x, y, z (dimension is null when
	 * neither side is one), {@code 'p'} the inventory of {@code player} (0-8 hotbar, 9-35 main, 36-39 feet to head, 40
	 * off hand) and {@code 'e'} that player's ender chest (0-26). {@code toSlot} -1 is a shift-click, sent where the
	 * game would send it. {@code amount} 0 moves the whole stack (swapping when the target holds something else), 1
	 * one item, 2 half, 3 swaps the two slots outright (the number keys). {@code count} above 0 moves exactly that many
	 * instead (never swapping). {@code item}, when given, must still be the item in the source slot, so a click made
	 * on a screen that was out of date fails instead of moving something else.
	 */
	record ItemMove(String dimension, int x, int y, int z, java.util.UUID player, char from, int fromSlot,
			char to, int toSlot, int amount, int count, String item) {
		public boolean touchesContainer() {
			return from == 'c' || to == 'c';
		}
	}

	/** {@code lines} is the text the command sent back, in order; {@code success} comes from the command's own result. */
	record Outcome(boolean success, List<String> lines) {
		public Outcome {
			lines = lines == null ? List.of() : List.copyOf(lines);
		}
	}
}
