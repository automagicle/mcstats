package dev.mcserverstats.liveview.hub;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.assets.AssetBundle;
import dev.mcserverstats.liveview.mesh.FrameCodec;
import dev.mcserverstats.liveview.mesh.SectionMesher;
import dev.mcserverstats.liveview.mesh.Tints;
import dev.mcserverstats.liveview.snapshot.BlockTouch;
import dev.mcserverstats.liveview.snapshot.ColumnQuery;
import dev.mcserverstats.liveview.snapshot.ColumnReport;
import dev.mcserverstats.liveview.snapshot.PlayerSample;
import dev.mcserverstats.liveview.snapshot.SectionBatch;
import dev.mcserverstats.liveview.snapshot.SectionId;
import dev.mcserverstats.liveview.snapshot.SectionSnapshot;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/**
 * Per-viewer terrain windows. The server thread only calls {@link #columnQueries()}, {@link #takeRequests(int)},
 * {@link #onColumns(List)}, {@link #onBatch(SectionBatch)} and {@link #touch(BlockTouch)}; each is a short locked
 * copy or a hand-off to a worker. Window math, meshing, compression and sends run on virtual threads.
 */
public final class TerrainHub {
	private static final int MAX_INFLIGHT = 48;
	private static final int MAX_QUEUED_FRAMES = 64;
	private static final int RESCANS_PER_TAKE = 2;
	private static final int PLAYER_SECTIONS_BELOW = 2;
	private static final int PLAYER_SECTIONS_ABOVE = 1;
	private static final long FLUSH_MS = 50;

	private final int cameraRadius;
	private final int playerRadius;
	private final Supplier<List<PlayerSample>> players;
	private final Object lock = new Object();
	private final Map<Long, View> views = new LinkedHashMap<>();
	private final Map<String, ColumnReport> columns = new HashMap<>();
	private final Map<SectionId, Set<Long>> waiting = new HashMap<>();
	private final ExecutorService tasks = Executors.newVirtualThreadPerTaskExecutor();
	private final Semaphore meshPermits = new Semaphore(Math.max(1, Runtime.getRuntime().availableProcessors() / 2));
	private final AtomicBoolean closed = new AtomicBoolean();
	private volatile AssetBundle assets;
	private volatile Tints tints;
	private volatile String assetError;
	private long roundRobin;

	public TerrainHub(int cameraRadius, int playerRadius, Supplier<List<PlayerSample>> players) {
		this.cameraRadius = cameraRadius;
		this.playerRadius = playerRadius;
		this.players = players;
	}

	public void start() {
		tasks.submit(this::flushLoop);
	}

	public void close() {
		closed.set(true);
		tasks.shutdownNow();
	}

	public boolean atlasReady() {
		return assets != null;
	}

	public boolean wantsTerrain() {
		synchronized (lock) {
			for (View view : views.values()) {
				if (view.atlasSent && view.dimension != null) {
					return true;
				}
			}
			return false;
		}
	}

	public void setAssets(AssetBundle bundle) {
		assets = bundle;
		tints = new Tints(bundle.colormaps());
		String message = Messages.atlas(bundle.atlasUrl(), bundle.metaUrl(), bundle.atlas().size());
		synchronized (lock) {
			for (View view : views.values()) {
				if (!view.atlasSent && view.out.enqueue(message, false)) {
					view.atlasSent = true;
				}
			}
		}
	}

	public void assetsFailed(String message) {
		assetError = message;
		String json = Messages.assetsError(message);
		synchronized (lock) {
			for (View view : views.values()) {
				view.out.enqueue(json, false);
			}
		}
	}

	void attach(long viewerId, Outbound out) {
		View view = new View(viewerId, out);
		AssetBundle bundle = assets;
		synchronized (lock) {
			views.put(viewerId, view);
			if (bundle != null) {
				view.atlasSent = out.enqueue(Messages.atlas(bundle.atlasUrl(), bundle.metaUrl(), bundle.atlas().size()), false);
			} else if (assetError != null) {
				out.enqueue(Messages.assetsError(assetError), false);
			}
		}
	}

	void detach(long viewerId) {
		synchronized (lock) {
			views.remove(viewerId);
			for (Set<Long> waiters : waiting.values()) {
				waiters.remove(viewerId);
			}
		}
	}

	void camera(long viewerId, String dimension, double x, double y, double z) {
		List<PlayerSample> online = players.get();
		synchronized (lock) {
			View view = views.get(viewerId);
			if (view == null) {
				return;
			}
			int sx = Math.floorDiv((int) Math.floor(x), 16);
			int sy = Math.floorDiv((int) Math.floor(y), 16);
			int sz = Math.floorDiv((int) Math.floor(z), 16);
			view.x = x;
			view.y = y;
			view.z = z;
			if (!dimension.equals(view.dimension)) {
				view.resetFor(dimension);
			} else if (sx == view.sx && sy == view.sy && sz == view.sz) {
				return;
			}
			view.sx = sx;
			view.sy = sy;
			view.sz = sz;
			recompute(view, online);
		}
	}

	/** Server thread: which chunk columns to probe for loaded chunks. */
	public List<ColumnQuery> columnQueries() {
		List<PlayerSample> online = players.get();
		List<ColumnQuery> queries = new ArrayList<>();
		Set<String> dimensions = new HashSet<>();
		synchronized (lock) {
			for (View view : views.values()) {
				if (view.dimension == null) {
					continue;
				}
				dimensions.add(view.dimension);
				queries.add(new ColumnQuery(view.dimension, view.sx, view.sz, cameraRadius + 1));
			}
		}
		for (PlayerSample player : online) {
			if (dimensions.contains(player.dimension())) {
				queries.add(new ColumnQuery(
						player.dimension(),
						Math.floorDiv((int) Math.floor(player.x()), 16),
						Math.floorDiv((int) Math.floor(player.z()), 16),
						playerRadius));
			}
		}
		return queries;
	}

	/** Server thread: hands the reports to a worker. */
	public void onColumns(List<ColumnReport> reports) {
		if (closed.get() || reports.isEmpty()) {
			return;
		}
		tasks.submit(() -> {
			try {
				applyColumns(reports);
			} catch (Throwable thrown) {
				LogOnce.warn("terrain-columns-apply", "Liveview failed to update terrain windows", thrown);
			}
		});
	}

	/** Server thread: the sections to copy this tick, nearest first, bounded per viewer by queue depth. */
	public List<SectionId> takeRequests(int max) {
		if (assets == null) {
			return List.of();
		}
		List<SectionId> out = new ArrayList<>();
		synchronized (lock) {
			if (views.isEmpty()) {
				return out;
			}
			List<View> order = new ArrayList<>(views.values());
			int start = (int) (roundRobin++ % order.size());
			boolean progress = true;
			while (out.size() < max && progress) {
				progress = false;
				for (int i = 0; i < order.size() && out.size() < max; i++) {
					View view = order.get((start + i) % order.size());
					SectionId next = nextRequest(view);
					if (next == null) {
						continue;
					}
					progress = true;
					view.inflight.add(next);
					Set<Long> waiters = waiting.get(next);
					if (waiters == null) {
						waiters = new HashSet<>();
						waiting.put(next, waiters);
						out.add(next);
					}
					waiters.add(view.id);
				}
			}
			for (View view : order) {
				view.rescansThisTake = 0;
			}
		}
		return out;
	}

	/** Server thread: hands the copied sections to a worker. */
	public void onBatch(SectionBatch batch) {
		if (closed.get()) {
			return;
		}
		tasks.submit(() -> {
			try {
				applyBatch(batch);
			} catch (Throwable thrown) {
				LogOnce.warn("terrain-batch", "Liveview failed to process copied sections", thrown);
			}
		});
	}

	/** Server thread: a block at this position may have changed. */
	public void touch(BlockTouch touch) {
		int sx = Math.floorDiv(touch.x(), 16);
		int sy = Math.floorDiv(touch.y(), 16);
		int sz = Math.floorDiv(touch.z(), 16);
		int lx = Math.floorMod(touch.x(), 16);
		int ly = Math.floorMod(touch.y(), 16);
		int lz = Math.floorMod(touch.z(), 16);
		List<SectionId> ids = new ArrayList<>(4);
		ids.add(new SectionId(touch.dimension(), sx, sy, sz));
		if (lx == 0) ids.add(new SectionId(touch.dimension(), sx - 1, sy, sz));
		if (lx == 15) ids.add(new SectionId(touch.dimension(), sx + 1, sy, sz));
		if (ly == 0) ids.add(new SectionId(touch.dimension(), sx, sy - 1, sz));
		if (ly == 15) ids.add(new SectionId(touch.dimension(), sx, sy + 1, sz));
		if (lz == 0) ids.add(new SectionId(touch.dimension(), sx, sy, sz - 1));
		if (lz == 15) ids.add(new SectionId(touch.dimension(), sx, sy, sz + 1));
		synchronized (lock) {
			for (View view : views.values()) {
				for (SectionId id : ids) {
					if (view.added.contains(id)) {
						view.dirty.add(id);
					}
				}
			}
		}
	}

	void sectionDropped(Outbound out, SectionId id) {
		synchronized (lock) {
			for (View view : views.values()) {
				if (view.out == out) {
					view.added.remove(id);
					view.hashes.remove(id);
					if (view.desired.contains(id)) {
						view.queue.addFirst(id);
					}
				}
			}
		}
	}

	private SectionId nextRequest(View view) {
		if (!view.atlasSent || view.dimension == null) {
			return null;
		}
		if (view.inflight.size() >= MAX_INFLIGHT || view.out.pendingSections() + view.ready.size() >= MAX_QUEUED_FRAMES) {
			return null;
		}
		var dirty = view.dirty.iterator();
		while (dirty.hasNext()) {
			SectionId id = dirty.next();
			dirty.remove();
			if (view.desired.contains(id) && !view.inflight.contains(id)) {
				return id;
			}
		}
		while (!view.queue.isEmpty()) {
			SectionId id = view.queue.pollFirst();
			if (view.desired.contains(id) && !view.added.contains(id) && !view.inflight.contains(id)) {
				return id;
			}
		}
		if (view.rescansThisTake >= RESCANS_PER_TAKE) {
			return null;
		}
		if (view.rescan.isEmpty()) {
			view.rescan.addAll(sorted(view, view.added));
		}
		while (!view.rescan.isEmpty()) {
			SectionId id = view.rescan.pollFirst();
			if (view.added.contains(id) && view.desired.contains(id) && !view.inflight.contains(id)) {
				view.rescansThisTake++;
				return id;
			}
		}
		return null;
	}

	private void applyColumns(List<ColumnReport> reports) {
		List<PlayerSample> online = players.get();
		synchronized (lock) {
			for (ColumnReport report : reports) {
				columns.put(report.dimension(), report);
			}
			for (View view : views.values()) {
				if (view.dimension != null) {
					recompute(view, online);
				}
			}
		}
	}

	private void recompute(View view, List<PlayerSample> online) {
		ColumnReport report = columns.get(view.dimension);
		if (report == null) {
			return;
		}
		Set<SectionId> desired = new HashSet<>();
		int r = cameraRadius;
		int minY = Math.max(report.minSectionY(), view.sy - r);
		int maxY = Math.min(report.maxSectionY(), view.sy + r);
		for (int dx = -r; dx <= r; dx++) {
			for (int dz = -r; dz <= r; dz++) {
				if (dx * dx + dz * dz > r * r + r || !report.isLoaded(view.sx + dx, view.sz + dz)) {
					continue;
				}
				for (int sy = minY; sy <= maxY; sy++) {
					desired.add(new SectionId(view.dimension, view.sx + dx, sy, view.sz + dz));
				}
			}
		}
		int pr = playerRadius;
		for (PlayerSample player : online) {
			if (!view.dimension.equals(player.dimension())) {
				continue;
			}
			int px = Math.floorDiv((int) Math.floor(player.x()), 16);
			int py = Math.floorDiv((int) Math.floor(player.y()), 16);
			int pz = Math.floorDiv((int) Math.floor(player.z()), 16);
			int low = Math.max(report.minSectionY(), py - PLAYER_SECTIONS_BELOW);
			int high = Math.min(report.maxSectionY(), py + PLAYER_SECTIONS_ABOVE);
			for (int dx = -pr; dx <= pr; dx++) {
				for (int dz = -pr; dz <= pr; dz++) {
					if (dx * dx + dz * dz > pr * pr + pr || !report.isLoaded(px + dx, pz + dz)) {
						continue;
					}
					for (int sy = low; sy <= high; sy++) {
						desired.add(new SectionId(view.dimension, px + dx, sy, pz + dz));
					}
				}
			}
		}
		view.desired = desired;
		for (SectionId id : view.added) {
			if (!desired.contains(id)) {
				view.removes.add(id);
			}
		}
		view.added.removeAll(view.removes);
		for (SectionId id : view.removes) {
			view.hashes.remove(id);
		}
		List<SectionId> missing = new ArrayList<>();
		for (SectionId id : desired) {
			if (!view.added.contains(id) && !view.inflight.contains(id)) {
				missing.add(id);
			}
		}
		view.queue.clear();
		view.queue.addAll(sorted(view, missing));
		view.rescan.clear();
		view.dirty.retainAll(desired);
	}

	private static List<SectionId> sorted(View view, java.util.Collection<SectionId> ids) {
		List<SectionId> list = new ArrayList<>(ids);
		list.sort(Comparator.comparingDouble(id -> distance(view, id)));
		return list;
	}

	private static double distance(View view, SectionId id) {
		double dx = id.blockX() + 8 - view.x;
		double dy = id.blockY() + 8 - view.y;
		double dz = id.blockZ() + 8 - view.z;
		return dx * dx + dy * dy * 1.5 + dz * dz;
	}

	private void applyBatch(SectionBatch batch) {
		synchronized (lock) {
			for (SectionId id : batch.unloaded()) {
				Set<Long> waiters = waiting.remove(id);
				if (waiters == null) {
					continue;
				}
				for (Long viewerId : waiters) {
					View view = views.get(viewerId);
					if (view != null) {
						view.inflight.remove(id);
						view.desired.remove(id);
					}
				}
			}
			for (SectionId id : batch.deferred()) {
				Set<Long> waiters = waiting.remove(id);
				if (waiters == null) {
					continue;
				}
				for (Long viewerId : waiters) {
					View view = views.get(viewerId);
					if (view != null) {
						view.inflight.remove(id);
						if (view.desired.contains(id) && !view.added.contains(id)) {
							view.queue.addFirst(id);
						} else if (view.added.contains(id)) {
							view.dirty.add(id);
						}
					}
				}
			}
		}
		for (SectionSnapshot snapshot : batch.snapshots()) {
			tasks.submit(() -> meshOne(snapshot));
		}
	}

	private void meshOne(SectionSnapshot snapshot) {
		try {
			meshPermits.acquire();
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			return;
		}
		try {
			SectionId id = snapshot.id();
			long hash = snapshot.contentHash();
			List<View> needing = new ArrayList<>();
			synchronized (lock) {
				Set<Long> waiters = waiting.remove(id);
				if (waiters == null) {
					return;
				}
				for (Long viewerId : waiters) {
					View view = views.get(viewerId);
					if (view == null) {
						continue;
					}
					if (!view.desired.contains(id) || !id.dimension().equals(view.dimension)) {
						view.inflight.remove(id);
						continue;
					}
					Long known = view.hashes.get(id);
					if (view.added.contains(id) && known != null && known == hash) {
						view.inflight.remove(id);
						continue;
					}
					needing.add(view);
				}
			}
			if (needing.isEmpty()) {
				return;
			}
			byte[] frame;
			try {
				SectionMesher.Mesh mesh = SectionMesher.mesh(snapshot, assets.models(), tints);
				frame = FrameCodec.section(id, mesh);
			} catch (Throwable thrown) {
				LogOnce.warn("mesh-" + thrown.getClass().getName(), "Liveview failed to mesh a section; it is sent empty", thrown);
				frame = FrameCodec.section(id, new SectionMesher.Mesh(new float[0], 0, new byte[0], new byte[0]));
			}
			synchronized (lock) {
				for (View view : needing) {
					view.inflight.remove(id);
					if (views.get(view.id) == view && view.desired.contains(id)) {
						view.ready.add(new Ready(id, frame, hash));
					}
				}
			}
		} finally {
			meshPermits.release();
		}
	}

	private void flushLoop() {
		while (!closed.get() && !Thread.currentThread().isInterrupted()) {
			try {
				Thread.sleep(FLUSH_MS);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return;
			}
			try {
				flush();
			} catch (Throwable thrown) {
				LogOnce.warn("terrain-flush", "Liveview failed to send terrain", thrown);
			}
		}
	}

	private void flush() {
		List<Send> sends = new ArrayList<>();
		synchronized (lock) {
			for (View view : views.values()) {
				if (view.dimension == null) {
					view.ready.clear();
					view.removes.clear();
					continue;
				}
				List<SectionId> adds = new ArrayList<>();
				List<Ready> frames = new ArrayList<>();
				for (Ready ready : view.ready) {
					if (!view.desired.contains(ready.id) || !ready.id.dimension().equals(view.dimension)) {
						continue;
					}
					if (view.added.add(ready.id)) {
						adds.add(ready.id);
					}
					view.hashes.put(ready.id, ready.hash);
					frames.add(ready);
				}
				view.ready.clear();
				List<SectionId> removes = new ArrayList<>(view.removes);
				view.removes.clear();
				if (adds.isEmpty() && removes.isEmpty() && frames.isEmpty()) {
					continue;
				}
				String window = adds.isEmpty() && removes.isEmpty() ? null : Messages.window(view.dimension, adds, removes);
				sends.add(new Send(view.out, window, frames));
			}
		}
		for (Send send : sends) {
			if (send.window != null) {
				send.out.enqueue(send.window, false);
			}
			for (Ready ready : send.frames) {
				send.out.enqueueSection(ready.frame, ready.id);
			}
		}
	}

	private record Ready(SectionId id, byte[] frame, long hash) {
	}

	private record Send(Outbound out, String window, List<Ready> frames) {
	}

	private static final class View {
		private final long id;
		private final Outbound out;
		private boolean atlasSent;
		private String dimension;
		private double x;
		private double y;
		private double z;
		private int sx;
		private int sy;
		private int sz;
		private Set<SectionId> desired = new HashSet<>();
		private final Set<SectionId> added = new HashSet<>();
		private final Map<SectionId, Long> hashes = new HashMap<>();
		private final Set<SectionId> inflight = new HashSet<>();
		private final LinkedHashSet<SectionId> dirty = new LinkedHashSet<>();
		private final ArrayDeque<SectionId> queue = new ArrayDeque<>();
		private final ArrayDeque<SectionId> rescan = new ArrayDeque<>();
		private final Set<SectionId> removes = new LinkedHashSet<>();
		private final List<Ready> ready = new ArrayList<>();
		private int rescansThisTake;

		private View(long id, Outbound out) {
			this.id = id;
			this.out = out;
		}

		private void resetFor(String nextDimension) {
			dimension = nextDimension;
			desired = new HashSet<>();
			added.clear();
			hashes.clear();
			dirty.clear();
			queue.clear();
			rescan.clear();
			removes.clear();
			ready.clear();
			sx = Integer.MIN_VALUE;
			sy = Integer.MIN_VALUE;
			sz = Integer.MIN_VALUE;
		}
	}
}
