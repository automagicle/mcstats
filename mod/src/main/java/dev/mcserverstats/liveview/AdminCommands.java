package dev.mcserverstats.liveview;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Runs a Minecraft command from the dashboard as the server console (full operator rights). RelayLink checks that
 * the viewer has controls on before calling this; implementations hop to the server thread and complete off it.
 */
public interface AdminCommands {
	CompletableFuture<Outcome> run(String command);

	/** Moves items in a block container or between it and a player's inventory (see ItemMove); server thread inside. */
	default CompletableFuture<Outcome> moveItem(ItemMove move) {
		return CompletableFuture.completedFuture(new Outcome(false, List.of("Item moves are not available.")));
	}

	/**
	 * One atomic item move. {@code fromChest}/{@code toChest} pick the container at x, y, z or the inventory of
	 * {@code player} (main slots 0-35); {@code toSlot} -1 is a shift-click into the other side; {@code amount} 0 moves the
	 * whole stack (swapping if the target holds something else), 1 one item, 2 half.
	 */
	record ItemMove(String dimension, int x, int y, int z, java.util.UUID player, boolean fromChest, int fromSlot,
			boolean toChest, int toSlot, int amount) {
	}

	/** {@code lines} is the text the command sent back, in order; {@code success} comes from the command's own result. */
	record Outcome(boolean success, List<String> lines) {
		public Outcome {
			lines = lines == null ? List.of() : List.copyOf(lines);
		}
	}
}
