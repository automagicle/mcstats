package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.WorldSky;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.dedicated.DedicatedServer;

/** Start-time hints about server settings that change what Liveview can show. */
public final class ServerChecks {
	private ServerChecks() {
	}

	// VERIFIED by javap on the 26.2 merged jar: MinecraftServer.overworld(), Level.getSkyDarken() (a plain field read,
	// 0 at noon up to 11 at midnight; vanilla subtracts it from sky light), Level.getOverworldClockTime() (long),
	// Level.getRainLevel(float) and Level.getThunderLevel(float).
	public static WorldSky sky(MinecraftServer server) {
		try {
			var level = server.overworld();
			//#if MC >= 26.1
			//$$ return new WorldSky(level.getSkyDarken(), level.getOverworldClockTime(), level.getRainLevel(1f), level.getThunderLevel(1f));
			//#else
			return new WorldSky(level.getSkyDarken(), level.getDayTime(), level.getRainLevel(1f), level.getThunderLevel(1f));
			//#endif
		} catch (Throwable thrown) {
			LogOnce.warn("sky-darken", "Liveview could not read the time of day", thrown);
			return WorldSky.UNKNOWN;
		}
	}

	// VERIFIED by javap on the 26.2 merged jar: MinecraftServer.getRespawnData() returns LevelData.RespawnData, a
	// record with dimension() (ResourceKey<Level>) and pos() (BlockPos); ResourceKey.identifier().
	/** The world spawn as JSON ({"dimension","x","y","z"}), so a viewer with nobody to look at starts somewhere sensible. */
	public static String spawn(MinecraftServer server) {
		try {
			//#if MC >= 1.21.9
			var data = server.getRespawnData();
			var pos = data.pos();
			String dimension = data.dimension().identifier().toString();
			//#else
			//$$ // before 1.21.9 the world spawn was always in the overworld
			//$$ var pos = server.overworld().getSharedSpawnPos();
			//$$ String dimension = "minecraft:overworld";
			//#endif
			return "{\"dimension\":\"" + dimension + "\",\"x\":" + pos.getX() + ",\"y\":" + pos.getY() + ",\"z\":" + pos.getZ() + "}";
		} catch (Throwable thrown) {
			LogOnce.warn("spawn", "Liveview could not read the world spawn", thrown);
			return null;
		}
	}

	// VERIFIED by javap on the 26.2 merged jar: MinecraftServer.getAverageTickTimeNanos() is public long.
	public static long averageTickNanos(MinecraftServer server) {
		try {
			return server.getAverageTickTimeNanos();
		} catch (Throwable thrown) {
			LogOnce.warn("tick-time", "Liveview could not read the tick time", thrown);
			return -1;
		}
	}

	// VERIFIED by javap on the 26.2 merged jar: DedicatedServer overrides pauseWhenEmptySeconds() as public; on
	// MinecraftServer it is protected.
	/** Said once, when the first viewer arrives: an empty server that pauses stops updating the view. */
	public static void onFirstViewer(MinecraftServer server) {
		try {
			if (!(server instanceof DedicatedServer dedicated)) {
				return;
			}
			//#if MC >= 1.21.9
			int pause = dedicated.pauseWhenEmptySeconds();
			//#elseif MC >= 1.21.2
			//$$ int pause = dedicated.pauseWhileEmptySeconds();
			//#else
			//$$ int pause = 0; // servers only learned to pause when empty in 1.21.2
			//#endif
			if (pause > 0) {
				LogOnce.info("pause-when-empty",
						"Liveview: pause-when-empty-seconds is " + pause + ", so the server stops ticking " + pause
								+ " s after the last player leaves, and the view freezes until someone joins. "
								+ "Set it to 0 in server.properties to keep the view live on an empty server.");
			}
		} catch (Throwable thrown) {
			LogOnce.warn("server-checks", "Liveview could not read server settings", thrown);
		}
	}
}
