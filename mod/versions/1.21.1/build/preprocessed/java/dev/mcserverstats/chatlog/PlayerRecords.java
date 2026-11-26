package dev.mcserverstats.chatlog;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.ToLongFunction;

import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
//#if MC >= 1.21.9
//$$ import net.minecraft.server.players.NameAndId;
//#else
import com.mojang.authlib.GameProfile;
//#endif
import net.minecraft.stats.ServerStatsCounter;
import net.minecraft.stats.Stats;
import net.minecraft.stats.StatsCounter;
import net.minecraft.world.level.storage.LevelResource;

// Everyone who has played on this server, with the game's own statistics for each (the numbers on the
// game's Statistics screen): online players from memory, everyone else from world/stats/<uuid>.json.
// Read when a /mcstats page asks, and kept for 30 seconds so paging through doesn't read every file again.
final class PlayerRecords {
	record Entry(UUID uuid, String name, boolean online, boolean op, long lastSeenMs,
			long playTicks, int deaths, int playerKills, int mobKills, long damageDealt,
			long walkedCm, long flownCm, long swumCm, int jumps, int fishCaught, int tradedWithVillager) {

		String playtime() {
			return duration(playTicks / 20);
		}

		long travelledCm() {
			return walkedCm + flownCm + swumCm;
		}
	}

	// The ways the player list and leaderboards can be ordered.
	enum Sort {
		PLAYTIME("Playtime", e -> e.playTicks()),
		ONLINE("Online first", e -> (e.online() ? 1L << 40 : 0) + e.playTicks()),
		PLAYER_KILLS("Player kills", e -> e.playerKills()),
		MOB_KILLS("Mob kills", e -> e.mobKills()),
		DEATHS("Deaths", e -> e.deaths()),
		DISTANCE("Distance travelled", Entry::travelledCm),
		NAME("Name", e -> 0);

		final String label;
		final ToLongFunction<Entry> key;

		Sort(String label, ToLongFunction<Entry> key) {
			this.label = label;
			this.key = key;
		}

		Comparator<Entry> order() {
			if (this == NAME) return Comparator.comparing(e -> e.name().toLowerCase());
			return Comparator.comparingLong(key).reversed().thenComparing(e -> e.name().toLowerCase());
		}

		Sort next() {
			Sort[] all = values();
			return all[(ordinal() + 1) % all.length];
		}
	}

	private static final int MAX_PLAYERS = 500;
	private static final long KEEP_MS = 30_000;

	private static List<Entry> cached = List.of();
	private static long cachedAt;

	static List<Entry> all(MinecraftServer server) {
		long now = System.currentTimeMillis();
		if (now - cachedAt > KEEP_MS) {
			cached = load(server);
			cachedAt = now;
		} else {
			// who's online changes more often than 30 seconds: always fresh for them
			cached = refreshOnline(server, cached);
		}
		return cached;
	}

	static List<Entry> sorted(MinecraftServer server, Sort sort) {
		List<Entry> list = new ArrayList<>(all(server));
		list.sort(sort.order());
		return list;
	}

	static Optional<Entry> find(MinecraftServer server, String name) {
		return all(server).stream().filter(e -> e.name().equalsIgnoreCase(name)).findFirst();
	}

	static Optional<Entry> find(MinecraftServer server, UUID uuid) {
		return all(server).stream().filter(e -> e.uuid().equals(uuid)).findFirst();
	}

	private static List<Entry> load(MinecraftServer server) {
		Map<UUID, Entry> out = new HashMap<>();
		for (ServerPlayer p : server.getPlayerList().getPlayers()) out.put(p.getUUID(), of(server, p));
		Path dir = server.getWorldPath(LevelResource.PLAYER_STATS_DIR);
		if (Files.isDirectory(dir)) {
			try (DirectoryStream<Path> files = Files.newDirectoryStream(dir, "*.json")) {
				for (Path file : files) {
					if (out.size() >= MAX_PLAYERS) break;
					String base = file.getFileName().toString().replaceFirst("\\.json$", "");
					UUID id;
					try {
						id = UUID.fromString(base);
					} catch (IllegalArgumentException e) {
						continue;
					}
					if (out.containsKey(id)) continue;
					try {
						Entry e = offline(server, id, file);
						if (e != null) out.put(id, e);
					} catch (RuntimeException e) {
						ChatLogMod.LOG.debug("Couldn't read {}", file, e);
					}
				}
			} catch (IOException e) {
				ChatLogMod.LOG.debug("Couldn't list {}", dir, e);
			}
		}
		return List.copyOf(out.values());
	}

	private static List<Entry> refreshOnline(MinecraftServer server, List<Entry> before) {
		Map<UUID, Entry> out = new HashMap<>();
		for (Entry e : before) {
			// someone who was online when this was read has since left: still listed, now offline
			out.put(e.uuid(), e.online() ? withOnline(e, false) : e);
		}
		for (ServerPlayer p : server.getPlayerList().getPlayers()) out.put(p.getUUID(), of(server, p));
		return List.copyOf(out.values());
	}

	private static Entry withOnline(Entry e, boolean online) {
		return new Entry(e.uuid(), e.name(), online, e.op(), online ? System.currentTimeMillis() : e.lastSeenMs(),
				e.playTicks(), e.deaths(), e.playerKills(), e.mobKills(), e.damageDealt(), e.walkedCm(), e.flownCm(), e.swumCm(),
				e.jumps(), e.fishCaught(), e.tradedWithVillager());
	}

	private static Entry of(MinecraftServer server, ServerPlayer p) {
		return entry(p.getUUID(), p.getScoreboardName(), true, isOp(server, p), System.currentTimeMillis(), p.getStats());
	}

	private static boolean isOp(MinecraftServer server, ServerPlayer p) {
		//#if MC >= 1.21.9
		//$$ return server.getPlayerList().isOp(p.nameAndId());
		//#else
		return server.getPlayerList().isOp(p.getGameProfile());
		//#endif
	}

	private static Entry offline(MinecraftServer server, UUID id, Path file) {
		//#if MC >= 1.21.9
		//$$ Optional<NameAndId> known = server.services().nameToIdCache().get(id);
		//$$ if (known.isEmpty()) return null; // never seen by name: nothing to show it as
		//$$ String name = known.get().name();
		//#else
		Optional<GameProfile> known = server.getProfileCache() == null ? Optional.empty() : server.getProfileCache().get(id);
		if (known.isEmpty()) return null; // never seen by name: nothing to show it as
		String name = known.get().getName();
		//#endif
		//#if MC >= 1.21.11
		//$$ ServerStatsCounter stats = new ServerStatsCounter(server, file);
		//#else
		ServerStatsCounter stats = new ServerStatsCounter(server, file.toFile());
		//#endif
		long lastSeen;
		try {
			lastSeen = Files.getLastModifiedTime(file).toMillis();
		} catch (IOException e) {
			lastSeen = 0;
		}
		return entry(id, name, false, server.getPlayerList().isOp(known.get()), lastSeen, stats);
	}

	private static Entry entry(UUID id, String name, boolean online, boolean op, long lastSeen, StatsCounter s) {
		return new Entry(id, name, online, op, lastSeen,
				custom(s, Stats.PLAY_TIME), (int) custom(s, Stats.DEATHS), (int) custom(s, Stats.PLAYER_KILLS),
				(int) custom(s, Stats.MOB_KILLS), custom(s, Stats.DAMAGE_DEALT),
				custom(s, Stats.WALK_ONE_CM) + custom(s, Stats.SPRINT_ONE_CM) + custom(s, Stats.CROUCH_ONE_CM),
				custom(s, Stats.AVIATE_ONE_CM) + custom(s, Stats.FLY_ONE_CM),
				custom(s, Stats.SWIM_ONE_CM) + custom(s, Stats.WALK_UNDER_WATER_ONE_CM) + custom(s, Stats.WALK_ON_WATER_ONE_CM),
				(int) custom(s, Stats.JUMP), (int) custom(s, Stats.FISH_CAUGHT), (int) custom(s, Stats.TRADED_WITH_VILLAGER));
	}

	private static long custom(StatsCounter s, ResourceLocation stat) {
		return Math.max(0, s.getValue(Stats.CUSTOM, stat));
	}

	/* ---------- formatting ---------- */

	static String duration(long seconds) {
		long d = seconds / 86_400, h = seconds % 86_400 / 3600, m = seconds % 3600 / 60;
		if (d > 0) return d + "d " + h + "h";
		if (h > 0) return h + "h " + m + "m";
		return m + "m";
	}

	static String distance(long cm) {
		double km = cm / 100_000.0;
		return km >= 1 ? String.format("%.1f km", km) : (cm / 100) + " m";
	}

	static String number(long n) {
		return String.format("%,d", n);
	}

	static String ago(long ms) {
		if (ms <= 0) return "a while ago";
		long s = Math.max(0, (System.currentTimeMillis() - ms) / 1000);
		if (s < 60) return "just now";
		return duration(s) + " ago";
	}
}
