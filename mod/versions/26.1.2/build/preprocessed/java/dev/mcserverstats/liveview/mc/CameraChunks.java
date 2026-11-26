package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.CameraPoint;
import java.util.List;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.TicketType;
import net.minecraft.world.level.ChunkPos;

/**
 * Loads the chunks around each viewer's camera, the way a spectator's own view distance would. Each camera holds a
 * chunk ticket of the configured camera radius at its chunk; tickets time out after 2 seconds unless refreshed, so a
 * camera that moves on or a page that closes lets the server unload what it left behind. The chunks load (and
 * generate, if new) and simulate like a forceloaded area: entities within radius - 2 chunks tick, so mobs move, and
 * blocks within radius - 1 tick. Natural mob spawning still needs a real player nearby, as in vanilla.
 *
 * <p>The ticket is the game's own {@code ender_pearl} type, which is exactly what a camera needs: it loads, it
 * simulates, it keeps the dimension ticking, it times out by itself (40 ticks) and it is never saved. A type of
 * Liveview's own would have to be added to the game's ticket-type registry, which is already frozen when a mod
 * starts unless Fabric API's registry sync is installed, and this mod doesn't ask for that.
 *
 * <p>VERIFIED by javap on the 26.2 merged jar: {@code TicketType.ENDER_PEARL} is {@code register("ender_pearl", 40L,
 * FLAG_LOADING | FLAG_SIMULATION | FLAG_KEEP_DIMENSION_ACTIVE)}; {@code ServerChunkCache.addTicketWithRadius(
 * TicketType, ChunkPos, int)}; and {@code TicketStorage.addTicket} resetting an existing equal ticket's timeout.
 */
public final class CameraChunks {
	/** Mobs closer than this to a camera do not despawn for lack of a nearby player (Mob.checkDespawn's 128). */
	private static final double WATCHED_BLOCKS = 128.0;
	private static final TicketType TICKET = TicketType.ENDER_PEARL;
	private static volatile List<CameraPoint> watched = List.of();
	/** When {@link #watched} was last refreshed; once no page refreshes it (all closed), mobs despawn normally again. */
	private static volatile long watchedAt;

	private CameraChunks() {
	}

	/**
	 * Server thread (MobMixin): whether a viewer's camera is watching this spot. Hostile mobs despawn at once when the
	 * nearest player is over 128 blocks away; around a camera that would empty the view the moment its chunks tick.
	 */
	public static boolean watching(net.minecraft.world.entity.Entity entity) {
		List<CameraPoint> cameras = watched;
		if (cameras.isEmpty() || System.nanoTime() - watchedAt > 5_000_000_000L || !(entity.level() instanceof ServerLevel level)) {
			return false;
		}
		String dimension = Ids.dimension(level);
		for (CameraPoint camera : cameras) {
			if (!dimension.equals(camera.dimension())) {
				continue;
			}
			double dx = entity.getX() - camera.x(), dz = entity.getZ() - camera.z();
			if (dx * dx + dz * dz <= WATCHED_BLOCKS * WATCHED_BLOCKS) {
				return true;
			}
		}
		return false;
	}

	/** Server thread, twice a second (well inside the ticket's 40-tick timeout). */
	public static void refresh(MinecraftServer server, List<CameraPoint> cameras, int radius) {
		watched = cameras == null ? List.of() : List.copyOf(cameras);
		watchedAt = System.nanoTime();
		if (cameras == null || cameras.isEmpty()) {
			return;
		}
		int r = Math.max(1, Math.min(radius, 12));
		for (CameraPoint camera : cameras) {
			try {
				ServerLevel level = server.getLevel(ResourceKey.create(Registries.DIMENSION, Identifier.parse(camera.dimension())));
				if (level == null) {
					continue;
				}
				ChunkPos pos = new ChunkPos((int) Math.floor(camera.x()) >> 4, (int) Math.floor(camera.z()) >> 4);
				level.getChunkSource().addTicketWithRadius(TICKET, pos, r);
			} catch (Throwable thrown) {
				LogOnce.warn("camera-chunks", "Liveview could not load chunks around a viewer's camera", thrown);
			}
		}
	}
}
