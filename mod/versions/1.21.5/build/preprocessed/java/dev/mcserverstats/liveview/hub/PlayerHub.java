package dev.mcserverstats.liveview.hub;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.assets.AssetStore;
import dev.mcserverstats.liveview.snapshot.ActionEvent;
import dev.mcserverstats.liveview.snapshot.Anchor;
import dev.mcserverstats.liveview.snapshot.CameraPoint;
import dev.mcserverstats.liveview.snapshot.EntityFrame;
import dev.mcserverstats.liveview.snapshot.EntitySample;
import dev.mcserverstats.liveview.snapshot.InventorySample;
import dev.mcserverstats.liveview.snapshot.ParticleEvent;
import dev.mcserverstats.liveview.snapshot.PlayerSample;
import dev.mcserverstats.liveview.snapshot.SectionId;
import dev.mcserverstats.liveview.snapshot.SlotSample;
import dev.mcserverstats.liveview.snapshot.ContainerView;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

public final class PlayerHub {
	private static final int QUEUE_CAP = 8;
	static final int OUTBOUND_CAP = 256;

	private final int cameraChunkRadius;
	private final int playerChunkRadius;
	private final int entityRadiusBlocks;
	private final Object lock = new Object();
	private final ArrayDeque<List<PlayerSample>> incoming = new ArrayDeque<>();
	private final ArrayDeque<List<InventorySample>> inventories = new ArrayDeque<>();
	private final ArrayDeque<EntityFrame> entityFrames = new ArrayDeque<>();
	private final ArrayDeque<ActionEvent> actions = new ArrayDeque<>();
	private final Map<Outbound, Viewer> viewers = new LinkedHashMap<>();
	private final Map<Long, CameraPoint> cameras = new LinkedHashMap<>();
	private final AtomicInteger authenticated = new AtomicInteger();
	private final AtomicLong droppedDeltas = new AtomicLong();
	private final AtomicBoolean closed = new AtomicBoolean();
	private final AtomicBoolean inventorySoon = new AtomicBoolean();
	private final AtomicBoolean containerSoon = new AtomicBoolean();
	private final AtomicBoolean entityThrottleSticky = new AtomicBoolean();
	private final AtomicLong actionIds = new AtomicLong();
	private final ExecutorService tasks = Executors.newVirtualThreadPerTaskExecutor();
	private final TerrainHub terrain;
	private final SkinCache skins;
	private List<PlayerSample> latestList = List.of();
	private Map<UUID, PlayerSample> latestMap = Map.of();
	private Map<UUID, InventorySample> latestInventories = Map.of();
	private EntityFrame latestEntities;
	private long nextViewerId = 1;

	public PlayerHub(int cameraChunkRadius, int playerChunkRadius, int entityRadiusBlocks, AssetStore assetStore) {
		this.cameraChunkRadius = cameraChunkRadius;
		this.playerChunkRadius = playerChunkRadius;
		this.entityRadiusBlocks = entityRadiusBlocks;
		this.latestEntities = EntityFrame.empty(entityRadiusBlocks);
		this.terrain = new TerrainHub(cameraChunkRadius, playerChunkRadius, this::latestPlayers);
		this.skins = new SkinCache(assetStore, tasks);
	}

	public TerrainHub terrain() {
		return terrain;
	}

	public void start() {
		terrain.start();
		tasks.submit(this::playerLoop);
		tasks.submit(this::inventoryLoop);
		tasks.submit(this::entityLoop);
		tasks.submit(this::actionLoop);
	}

	public int entityRadius() {
		return entityRadiusBlocks;
	}

	public boolean hasAuthenticatedViewer() {
		return authenticated.get() > 0;
	}

	public int viewerCount() {
		return Math.max(0, authenticated.get());
	}

	public long droppedDeltas() {
		return droppedDeltas.get();
	}

	public void noteDroppedDelta() {
		droppedDeltas.incrementAndGet();
	}

	public boolean atlasReady() {
		return terrain.atlasReady();
	}

	public boolean hasInventorySubscription() {
		synchronized (lock) {
			for (Viewer viewer : viewers.values()) {
				if (viewer.inventoryUuid != null) {
					return true;
				}
			}
			return false;
		}
	}

	public boolean pullInventorySoon() {
		return inventorySoon.getAndSet(false);
	}

	public void requestInventoryPoll() {
		inventorySoon.set(true);
	}

	public Set<UUID> subscribedPlayers() {
		synchronized (lock) {
			Set<UUID> ids = new LinkedHashSet<>();
			for (Viewer viewer : viewers.values()) {
				if (viewer.inventoryUuid != null) {
					ids.add(viewer.inventoryUuid);
				}
			}
			return Set.copyOf(ids);
		}
	}

	public void submit(List<PlayerSample> samples) {
		offer(incoming, samples, "sample-drop", "Liveview dropped a player sample because the diff worker is behind");
	}

	public void submitInventories(List<InventorySample> samples) {
		offer(inventories, samples, "inventory-drop", "Liveview dropped an inventory sample because the diff worker is behind");
	}

	public void submitEntities(EntityFrame frame) {
		if (frame != null && frame.throttled()) {
			entityThrottleSticky.set(true);
		}
		offer(entityFrames, frame, "entity-drop", "Liveview dropped an entity sample because the diff worker is behind");
	}

	public boolean entityQueuesFull() {
		synchronized (lock) {
			for (Viewer viewer : viewers.values()) {
				if (viewer.outbound.pendingCount() >= OUTBOUND_CAP) {
					return true;
				}
			}
			return false;
		}
	}

	public void setCameraInterest(long viewerId, String dimension, double x, double y, double z) {
		if (viewerId <= 0 || dimension == null || dimension.isBlank()) {
			return;
		}
		synchronized (lock) {
			cameras.put(viewerId, new CameraPoint(viewerId, dimension, x, y, z));
		}
	}

	public void clearCameraInterest(long viewerId) {
		synchronized (lock) {
			cameras.remove(viewerId);
		}
	}

	/** Must not be called while holding this hub's lock: the terrain hub reads the player list. */
	public void camera(Outbound outbound, String dimension, double x, double y, double z) {
		long id = viewerId(outbound);
		if (id <= 0) {
			return;
		}
		setCameraInterest(id, dimension, x, y, z);
		terrain.camera(id, dimension, x, y, z);
	}

	public void sectionDropped(Outbound outbound, SectionId id) {
		terrain.sectionDropped(outbound, id);
	}

	List<PlayerSample> latestPlayers() {
		synchronized (lock) {
			return latestList;
		}
	}

	public List<CameraPoint> cameraInterest() {
		synchronized (lock) {
			return List.copyOf(cameras.values());
		}
	}

	public long viewerId(Outbound outbound) {
		synchronized (lock) {
			Viewer viewer = viewers.get(outbound);
			return viewer == null ? 0L : viewer.id;
		}
	}

	/**
	 * Particles copied this tick. Each viewer gets the ones within 64 blocks of its camera in the same dimension, as a
	 * droppable message, so a viewer that falls behind loses particles before anything else.
	 */
	public void submitParticles(List<ParticleEvent> events) {
		if (closed.get() || events == null || events.isEmpty()) {
			return;
		}
		List<Outbound> outs = new ArrayList<>();
		List<CameraPoint> points = new ArrayList<>();
		synchronized (lock) {
			for (Viewer viewer : viewers.values()) {
				CameraPoint camera = cameras.get(viewer.id);
				if (camera != null) {
					outs.add(viewer.outbound);
					points.add(camera);
				}
			}
		}
		if (outs.isEmpty()) {
			return;
		}
		try {
			tasks.submit(() -> {
				for (int i = 0; i < outs.size(); i++) {
					CameraPoint camera = points.get(i);
					List<ParticleEvent> near = new ArrayList<>();
					for (ParticleEvent event : events) {
						double dx = event.x() - camera.x(), dy = event.y() - camera.y(), dz = event.z() - camera.z();
						if (event.dimension().equals(camera.dimension()) && dx * dx + dy * dy + dz * dz <= 64 * 64) {
							near.add(event);
						}
					}
					if (!near.isEmpty()) {
						outs.get(i).enqueue(Messages.particles(near), true);
					}
				}
			});
		} catch (RuntimeException closing) {
			// The hub is shutting down.
		}
	}

	public void submitAction(ActionEvent event) {
		if (closed.get() || event == null) {
			return;
		}
		synchronized (actions) {
			if (actions.size() >= 256) {
				actions.removeFirst();
				LogOnce.warn("action-drop", "Liveview dropped an action because the feed worker is behind", null);
			}
			actions.addLast(event);
			actions.notifyAll();
		}
	}

	public void attach(Outbound outbound) {
		synchronized (lock) {
			Viewer viewer = new Viewer(outbound, nextViewerId++);
			viewer.known.putAll(latestMap);
			outbound.enqueue(Messages.hello(System.currentTimeMillis(), cameraChunkRadius, playerChunkRadius, entityRadiusBlocks), false);
			outbound.enqueue(Messages.players(latestList), false);
			sendEntities(viewer, latestEntities, true);
			viewers.put(outbound, viewer);
			authenticated.incrementAndGet();
			terrain.attach(viewer.id, outbound);
		}
	}

	public void detach(Outbound outbound) {
		synchronized (lock) {
			Viewer viewer = viewers.remove(outbound);
			if (viewer != null) {
				authenticated.decrementAndGet();
				cameras.remove(viewer.id);
				terrain.detach(viewer.id);
			}
		}
	}

	public void subscribeInventory(Outbound outbound, UUID uuid) {
		synchronized (lock) {
			Viewer viewer = viewers.get(outbound);
			if (viewer == null) {
				return;
			}
			viewer.inventoryUuid = uuid;
			viewer.knownSlots = new LinkedHashMap<>();
			InventorySample cached = latestInventories.get(uuid);
			if (cached != null) {
				sendInventory(viewer, cached);
			} else {
				inventorySoon.set(true);
			}
		}
	}

	/** A block container one viewer has open. */
	public record ContainerWatch(long viewerId, String dimension, int x, int y, int z) {
	}

	public void openContainer(Outbound outbound, String dimension, int x, int y, int z) {
		synchronized (lock) {
			Viewer viewer = viewers.get(outbound);
			if (viewer == null) {
				return;
			}
			viewer.container = new ContainerWatch(viewer.id, dimension, x, y, z);
			viewer.lastContainer = null;
			containerSoon.set(true);
		}
	}

	public void closeContainer(Outbound outbound) {
		synchronized (lock) {
			Viewer viewer = viewers.get(outbound);
			if (viewer != null) {
				viewer.container = null;
				viewer.lastContainer = null;
			}
		}
	}

	public List<ContainerWatch> containerWatches() {
		synchronized (lock) {
			List<ContainerWatch> out = new ArrayList<>();
			for (Viewer viewer : viewers.values()) {
				if (viewer.container != null) {
					out.add(viewer.container);
				}
			}
			return out;
		}
	}

	/** After an item move: re-read open containers and subscribed inventories on the next tick. */
	public void refreshSoon() {
		containerSoon.set(true);
		inventorySoon.set(true);
	}

	public boolean pullContainerSoon() {
		return containerSoon.getAndSet(false);
	}

	/** Sends a container's contents to the viewer that has it open, only when something changed. */
	public void submitContainer(long viewerId, ContainerView view) {
		if (closed.get() || view == null) {
			return;
		}
		synchronized (lock) {
			for (Viewer viewer : viewers.values()) {
				if (viewer.id != viewerId || viewer.container == null) {
					continue;
				}
				ContainerWatch watch = viewer.container;
				if (watch.x() != view.x() || watch.y() != view.y() || watch.z() != view.z() || !watch.dimension().equals(view.dimension())) {
					continue;
				}
				if (view.equals(viewer.lastContainer)) {
					return;
				}
				viewer.lastContainer = view;
				viewer.outbound.enqueue(Messages.container(view), false);
				return;
			}
		}
	}

	public void unsubscribeInventory(Outbound outbound, UUID uuid) {
		synchronized (lock) {
			Viewer viewer = viewers.get(outbound);
			if (viewer == null) {
				return;
			}
			if (uuid == null || uuid.equals(viewer.inventoryUuid)) {
				viewer.inventoryUuid = null;
				viewer.knownSlots = new LinkedHashMap<>();
			}
		}
	}

	public void close() {
		if (!closed.compareAndSet(false, true)) {
			return;
		}
		synchronized (incoming) {
			incoming.notifyAll();
		}
		synchronized (inventories) {
			inventories.notifyAll();
		}
		synchronized (entityFrames) {
			entityFrames.notifyAll();
		}
		synchronized (actions) {
			actions.notifyAll();
		}
		List<Outbound> open;
		synchronized (lock) {
			open = List.copyOf(viewers.keySet());
			viewers.clear();
			authenticated.set(0);
		}
		for (Outbound outbound : open) {
			outbound.close();
		}
		terrain.close();
		tasks.shutdownNow();
	}

	private <T> void offer(ArrayDeque<T> queue, T value, String key, String message) {
		if (closed.get() || value == null) {
			return;
		}
		synchronized (queue) {
			if (queue.size() >= QUEUE_CAP) {
				queue.removeFirst();
				LogOnce.warn(key, message, null);
			}
			queue.addLast(value);
			queue.notifyAll();
		}
	}

	private void playerLoop() {
		while (!closed.get() && !Thread.currentThread().isInterrupted()) {
			List<PlayerSample> sample;
			try {
				sample = take(incoming);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return;
			}
			if (sample == null) {
				return;
			}
			try {
				publishPlayers(sample);
			} catch (Throwable thrown) {
				LogOnce.warn("diff", "Liveview failed to publish a player sample", thrown);
			}
		}
	}

	private void inventoryLoop() {
		while (!closed.get() && !Thread.currentThread().isInterrupted()) {
			List<InventorySample> sample;
			try {
				sample = take(inventories);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return;
			}
			if (sample == null) {
				return;
			}
			try {
				publishInventories(sample);
			} catch (Throwable thrown) {
				LogOnce.warn("inventory-diff", "Liveview failed to publish an inventory sample", thrown);
			}
		}
	}

	private void entityLoop() {
		while (!closed.get() && !Thread.currentThread().isInterrupted()) {
			EntityFrame frame;
			try {
				frame = takeEntities();
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return;
			}
			if (frame == null) {
				return;
			}
			try {
				publishEntities(frame);
			} catch (Throwable thrown) {
				LogOnce.warn("entity-diff", "Liveview failed to publish an entity sample", thrown);
			}
		}
	}

	private void actionLoop() {
		while (!closed.get() && !Thread.currentThread().isInterrupted()) {
			ActionEvent event;
			try {
				event = takeAction();
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return;
			}
			if (event == null) {
				return;
			}
			try {
				publishAction(event.withId(actionIds.incrementAndGet()));
			} catch (Throwable thrown) {
				LogOnce.warn("action-diff", "Liveview failed to publish an action", thrown);
			}
		}
	}

	private <T> T take(ArrayDeque<T> queue) throws InterruptedException {
		synchronized (queue) {
			while (queue.isEmpty() && !closed.get()) {
				queue.wait();
			}
			if (queue.isEmpty()) {
				return null;
			}
			T sample = queue.removeFirst();
			while (!queue.isEmpty()) {
				sample = queue.removeFirst();
			}
			return sample;
		}
	}

	private EntityFrame takeEntities() throws InterruptedException {
		synchronized (entityFrames) {
			while (entityFrames.isEmpty() && !closed.get()) {
				entityFrames.wait();
			}
			if (entityFrames.isEmpty()) {
				return null;
			}
			EntityFrame frame = null;
			boolean throttled = entityThrottleSticky.getAndSet(false);
			while (!entityFrames.isEmpty()) {
				frame = entityFrames.removeFirst();
				throttled = throttled || frame.throttled();
			}
			return frame == null ? null : frame.withThrottled(throttled);
		}
	}

	private ActionEvent takeAction() throws InterruptedException {
		synchronized (actions) {
			while (actions.isEmpty() && !closed.get()) {
				actions.wait();
			}
			if (actions.isEmpty()) {
				return null;
			}
			return actions.removeFirst();
		}
	}

	private void publishPlayers(List<PlayerSample> samples) {
		Map<UUID, PlayerSample> previous;
		Map<UUID, PlayerSample> before;
		synchronized (lock) {
			before = latestMap;
		}
		Map<UUID, PlayerSample> next = new LinkedHashMap<>();
		for (PlayerSample sample : samples) {
			next.put(sample.uuid(), withSkin(sample, before.get(sample.uuid())));
		}
		List<PlayerSample> ordered = List.copyOf(next.values());
		synchronized (lock) {
			previous = latestMap;
			latestList = ordered;
			latestMap = Map.copyOf(next);
			for (Viewer viewer : viewers.values()) {
				sendPlayers(viewer, next, ordered);
			}
		}
		for (PlayerSample sample : ordered) {
			PlayerSample was = previous.get(sample.uuid());
			if (was != null && !was.dimension().equals(sample.dimension())) {
				submitAction(ActionEvent.of(
						"dimension_change",
						sample.uuid(),
						sample.dimension(),
						(int) Math.floor(sample.x()),
						(int) Math.floor(sample.y()),
						(int) Math.floor(sample.z()),
						sample.dimension(),
						""));
			}
		}
	}

	private PlayerSample withSkin(PlayerSample sample, PlayerSample previous) {
		SkinCache.Resolved skin = skins.lookup(sample.skinTextures());
		String cape = skins.cape(sample.skinTextures());
		if (cape == null && previous != null && previous.look() != null) {
			cape = previous.look().cape();
		}
		if (skin == null) {
			return previous == null ? sample.withSkin(null, null, cape) : sample.withSkin(previous.skin(), previous.skinModel(), cape);
		}
		return sample.withSkin(skin.path(), skin.model(), cape);
	}

	private void publishInventories(List<InventorySample> samples) {
		synchronized (lock) {
			Map<UUID, InventorySample> next = new LinkedHashMap<>(latestInventories);
			for (InventorySample sample : samples) {
				next.put(sample.uuid(), sample);
			}
			latestInventories = Map.copyOf(next);
			for (Viewer viewer : viewers.values()) {
				if (viewer.inventoryUuid == null) {
					continue;
				}
				InventorySample sample = next.get(viewer.inventoryUuid);
				if (sample != null) {
					sendInventory(viewer, sample);
				}
			}
		}
	}

	private void publishEntities(EntityFrame frame) {
		synchronized (lock) {
			latestEntities = frame;
			for (Viewer viewer : viewers.values()) {
				if (frame.throttled()) {
					viewer.entityThrottled = true;
				}
				sendEntities(viewer, frame, false);
			}
		}
	}

	private void publishAction(ActionEvent event) {
		String json = Messages.action(event);
		synchronized (lock) {
			for (Viewer viewer : viewers.values()) {
				viewer.outbound.enqueue(json, false);
			}
		}
	}

	private static void sendPlayers(Viewer viewer, Map<UUID, PlayerSample> next, List<PlayerSample> ordered) {
		Set<UUID> removed = new LinkedHashSet<>(viewer.known.keySet());
		removed.removeAll(next.keySet());
		boolean added = !viewer.known.keySet().containsAll(next.keySet());
		boolean setChanged = added || !removed.isEmpty();
		if (!removed.isEmpty()) {
			viewer.outbound.enqueue(Messages.remove(removed), false);
		}
		if (setChanged) {
			if (viewer.outbound.enqueue(Messages.players(ordered), false)) {
				viewer.known.clear();
				viewer.known.putAll(next);
			}
			return;
		}
		String deltas = Messages.deltas(viewer.known, next);
		if (deltas == null) {
			return;
		}
		if (viewer.outbound.enqueue(deltas, true) || viewer.outbound.enqueue(Messages.players(ordered), false)) {
			viewer.known.clear();
			viewer.known.putAll(next);
		}
	}

	private void sendEntities(Viewer viewer, EntityFrame frame, boolean join) {
		Map<Integer, EntitySample> visible = visible(viewer, frame);
		if (join || !viewer.entitiesReady) {
			if (viewer.outbound.enqueue(Messages.entities(visible.values()), false)) {
				viewer.knownEntities.clear();
				viewer.knownEntities.putAll(visible);
				viewer.entitiesReady = true;
			}
			return;
		}
		boolean throttled = viewer.entityThrottled;
		String deltas = Messages.entityDeltas(viewer.knownEntities, visible, throttled);
		if (deltas == null) {
			return;
		}
		if (viewer.outbound.enqueue(deltas, true)) {
			viewer.knownEntities.clear();
			viewer.knownEntities.putAll(visible);
			viewer.entityThrottled = false;
		}
	}

	private Map<Integer, EntitySample> visible(Viewer viewer, EntityFrame frame) {
		Map<Integer, EntitySample> visible = new LinkedHashMap<>();
		int cameraRadius = frame.cameraRadius();
		for (EntitySample entity : frame.entities()) {
			if (near(entity, frame.players(), frame.radius()) || nearCamera(entity, viewer.id, frame.cameras(), cameraRadius)) {
				visible.put(entity.id(), entity);
			}
		}
		return visible;
	}

	private static boolean near(EntitySample entity, List<Anchor> anchors, int radius) {
		double limit = (double) radius * radius;
		for (Anchor anchor : anchors) {
			if (!anchor.dimension().equals(entity.dimension())) {
				continue;
			}
			if (distanceSquared(entity, anchor.x(), anchor.y(), anchor.z()) <= limit) {
				return true;
			}
		}
		return false;
	}

	private static boolean nearCamera(EntitySample entity, long viewerId, List<CameraPoint> cameras, int radius) {
		double limit = (double) radius * radius;
		for (CameraPoint camera : cameras) {
			if (camera.viewerId() != viewerId || !camera.dimension().equals(entity.dimension())) {
				continue;
			}
			if (distanceSquared(entity, camera.x(), camera.y(), camera.z()) <= limit) {
				return true;
			}
		}
		return false;
	}

	private static double distanceSquared(EntitySample entity, double x, double y, double z) {
		double dx = entity.x() - x;
		double dy = entity.y() - y;
		double dz = entity.z() - z;
		return dx * dx + dy * dy + dz * dz;
	}

	private static void sendInventory(Viewer viewer, InventorySample sample) {
		if (sample.unavailable()) {
			if (viewer.outbound.enqueue(Messages.inventory(sample), false)) {
				viewer.knownSlots.clear();
			}
			return;
		}
		if (viewer.knownSlots.isEmpty()) {
			if (viewer.outbound.enqueue(Messages.inventory(sample), false)) {
				rememberSlots(viewer, sample);
			}
			return;
		}
		List<SlotSample> changed = new ArrayList<>();
		Map<Integer, SlotSample> next = new LinkedHashMap<>();
		for (SlotSample slot : sample.slots()) {
			next.put(slot.slot(), slot);
			SlotSample previous = viewer.knownSlots.get(slot.slot());
			if (previous == null || !sameSlot(previous, slot)) {
				changed.add(slot);
			}
		}
		for (Integer slot : viewer.knownSlots.keySet()) {
			if (!next.containsKey(slot)) {
				changed.add(new SlotSample(slot, "minecraft:air", 0, null));
			}
		}
		if (changed.isEmpty()) {
			return;
		}
		if (viewer.outbound.enqueue(Messages.inventoryDelta(sample.uuid(), changed), true)
				|| viewer.outbound.enqueue(Messages.inventory(sample), false)) {
			rememberSlots(viewer, sample);
		}
	}

	private static void rememberSlots(Viewer viewer, InventorySample sample) {
		viewer.knownSlots.clear();
		for (SlotSample slot : sample.slots()) {
			viewer.knownSlots.put(slot.slot(), slot);
		}
	}

	private static boolean sameSlot(SlotSample left, SlotSample right) {
		return left.slot() == right.slot()
				&& left.count() == right.count()
				&& left.item().equals(right.item())
				&& same(left.customName(), right.customName())
				&& same(left.detail(), right.detail());
	}

	private static boolean same(Object left, Object right) {
		return left == null ? right == null : left.equals(right);
	}

	private static final class Viewer {
		private final Outbound outbound;
		private final long id;
		private final Map<UUID, PlayerSample> known = new LinkedHashMap<>();
		private final Map<Integer, EntitySample> knownEntities = new LinkedHashMap<>();
		private Map<Integer, SlotSample> knownSlots = new LinkedHashMap<>();
		private UUID inventoryUuid;
		private ContainerWatch container;
		private ContainerView lastContainer;
		private boolean entitiesReady;
		private boolean entityThrottled;

		private Viewer(Outbound outbound, long id) {
			this.outbound = outbound;
			this.id = id;
		}
	}
}
