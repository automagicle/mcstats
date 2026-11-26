package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.Anchor;
import dev.mcserverstats.liveview.snapshot.CameraPoint;
import dev.mcserverstats.liveview.snapshot.EntityFrame;
import dev.mcserverstats.liveview.snapshot.EntitySample;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.entity.EntityTypeTest;
import net.minecraft.world.phys.AABB;

public final class EntitySampler {
	private EntitySampler() {
	}

	// VERIFIED by javap and by compiling against minecraft-merged-a8e9c7b123-26.2.jar (listed in DESIGN.md "Sampler names"):
	// MinecraftServer.getPlayerList/getAllLevels, PlayerList.getPlayers, ServerPlayer.level,
	// Level.getEntities(EntityTypeTest, AABB, Predicate), EntityTypeTest.forClass, AABB(double, double, double, double, double, double),
	// Entity.getId/getUUID/getX/getY/getZ/getYRot/getXRot/getType, LivingEntity.getHealth,
	// Entity.getBbWidth/getBbHeight (Phase 4, javap: both public final float),
	// BuiltInRegistries.ENTITY_TYPE.getKey via Ids.entityType.
	public static Optional<EntityFrame> sample(
			MinecraftServer server,
			Set<UUID> optedOut,
			int radiusBlocks,
			List<CameraPoint> cameras) {
		int radius = Math.max(0, radiusBlocks);
		int cameraRadius = EntityFrame.cameraRadius(radius);
		Set<UUID> hidden = optedOut == null ? Set.of() : optedOut;
		List<CameraPoint> cameraPoints = cameras == null ? List.of() : cameras;
		try {
			List<ServerPlayer> players = List.copyOf(server.getPlayerList().getPlayers());
			Map<ServerLevel, List<Probe>> probes = new LinkedHashMap<>();
			List<Anchor> anchors = new ArrayList<>();
			for (ServerPlayer player : players) {
				try {
					if (hidden.contains(player.getUUID())) {
						continue;
					}
					ServerLevel level = dev.mcserverstats.compat.Compat.level(player);
					double x = player.getX();
					double y = player.getY();
					double z = player.getZ();
					anchors.add(new Anchor(Ids.dimension(level), x, y, z));
					probes.computeIfAbsent(level, key -> new ArrayList<>()).add(new Probe(x, y, z, radius));
				} catch (Throwable thrown) {
					LogOnce.warn("entity-anchor", "Liveview skipped a player while building entity interest", thrown);
				}
			}
			if (!cameraPoints.isEmpty()) {
				addCameras(server, probes, cameraPoints, cameraRadius);
			}
			Map<Integer, EntitySample> found = new LinkedHashMap<>();
			for (Map.Entry<ServerLevel, List<Probe>> entry : probes.entrySet()) {
				copyLevel(entry.getKey(), entry.getValue(), found);
			}
			return Optional.of(new EntityFrame(List.copyOf(found.values()), anchors, cameraPoints, radius, false));
		} catch (Throwable thrown) {
			LogOnce.warn("entity-sample", "Liveview could not sample nearby entities", thrown);
			return Optional.empty();
		}
	}

	private static void addCameras(
			MinecraftServer server,
			Map<ServerLevel, List<Probe>> probes,
			List<CameraPoint> cameras,
			int cameraRadius) {
		Map<String, List<CameraPoint>> byDimension = new LinkedHashMap<>();
		for (CameraPoint camera : cameras) {
			if (camera.dimension().isBlank()) {
				continue;
			}
			byDimension.computeIfAbsent(camera.dimension(), key -> new ArrayList<>()).add(camera);
		}
		if (byDimension.isEmpty()) {
			return;
		}
		try {
			for (ServerLevel level : server.getAllLevels()) {
				List<CameraPoint> points = byDimension.get(Ids.dimension(level));
				if (points == null) {
					continue;
				}
				List<Probe> levelProbes = probes.computeIfAbsent(level, key -> new ArrayList<>());
				for (CameraPoint point : points) {
					levelProbes.add(new Probe(point.x(), point.y(), point.z(), cameraRadius));
				}
			}
		} catch (Throwable thrown) {
			LogOnce.warn("entity-camera", "Liveview skipped camera interest while sampling entities", thrown);
		}
	}

	private static void copyLevel(ServerLevel level, List<Probe> probes, Map<Integer, EntitySample> found) {
		String dimension;
		try {
			dimension = Ids.dimension(level);
		} catch (Throwable thrown) {
			LogOnce.warn("entity-dimension", "Liveview skipped a dimension while sampling entities", thrown);
			return;
		}
		for (Probe probe : probes) {
			List<Entity> nearby;
			try {
				nearby = level.getEntities(
						EntityTypeTest.forClass(Entity.class),
						new AABB(
								probe.x - probe.radius,
								probe.y - probe.radius,
								probe.z - probe.radius,
								probe.x + probe.radius,
								probe.y + probe.radius,
								probe.z + probe.radius),
						entity -> true);
			} catch (Throwable thrown) {
				LogOnce.warn("entity-query", "Liveview skipped an entity query", thrown);
				continue;
			}
			for (Entity entity : nearby) {
				try {
					if (entity == null || entity instanceof Player || found.containsKey(entity.getId())) {
						continue;
					}
					if (!within(entity, probe)) {
						continue;
					}
					copy(entity, dimension, found);
				} catch (Throwable thrown) {
					LogOnce.warn("entity-read", "Liveview skipped an entity that disappeared mid-copy", thrown);
				}
			}
		}
	}

	private static void copy(Entity entity, String dimension, Map<Integer, EntitySample> found) {
		Double health = null;
		boolean baby = false;
		// Living mobs face their body yaw and turn the head separately (LivingEntity.yBodyRot, getYHeadRot, isBaby:
		// VERIFIED by javap on the 26.2 merged jar). Everything else uses its plain rotation for both.
		float yaw = entity.getYRot();
		float headYaw = entity.getYHeadRot();
		// Dropped items carry their item id so the page can draw the item's icon (ItemEntity.getItem: VERIFIED by javap).
		String item = entity instanceof net.minecraft.world.entity.item.ItemEntity drop ? Ids.item(drop.getItem())
				: entity instanceof net.minecraft.world.entity.projectile.ItemSupplier supplier ? Ids.item(supplier.getItem()) : null;
		if (entity instanceof LivingEntity living) {
			health = (double) living.getHealth();
			baby = living.isBaby();
			yaw = living.yBodyRot;
		}
		int id = entity.getId();
		found.put(id, new EntitySample(
				id,
				entity.getUUID(),
				Ids.entityType(entity),
				dimension,
				entity.getX(),
				entity.getY(),
				entity.getZ(),
				yaw,
				entity.getXRot(),
				health,
				entity.getBbWidth(),
				entity.getBbHeight(),
				baby,
				headYaw,
				item,
				Looks.of(entity)));
	}

	private static boolean within(Entity entity, Probe probe) {
		double dx = entity.getX() - probe.x;
		double dy = entity.getY() - probe.y;
		double dz = entity.getZ() - probe.z;
		double radius = probe.radius;
		return dx * dx + dy * dy + dz * dz <= radius * radius;
	}

	private record Probe(double x, double y, double z, double radius) {
	}
}
