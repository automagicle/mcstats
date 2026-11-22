package dev.mcserverstats.liveview;

import dev.mcserverstats.liveview.assets.AssetBundle;
import dev.mcserverstats.liveview.assets.AssetException;
import dev.mcserverstats.liveview.assets.AssetPipeline;
import dev.mcserverstats.liveview.assets.AssetSource;
import dev.mcserverstats.liveview.assets.AssetStore;
import dev.mcserverstats.liveview.assets.ClientJar;
import dev.mcserverstats.liveview.hub.Messages;
import dev.mcserverstats.liveview.hub.PlayerHub;
import dev.mcserverstats.liveview.hub.TerrainHub;
import dev.mcserverstats.liveview.keys.KeyLimiter;
import dev.mcserverstats.liveview.keys.KeyStore;
import dev.mcserverstats.liveview.mc.AssetEnvironment;
import dev.mcserverstats.liveview.mc.ModelExtractor;
import dev.mcserverstats.liveview.relay.RelayLink;
import dev.mcserverstats.liveview.snapshot.ActionEvent;
import dev.mcserverstats.liveview.snapshot.BlockTouch;
import dev.mcserverstats.liveview.snapshot.CameraPoint;
import dev.mcserverstats.liveview.snapshot.EntityFrame;
import dev.mcserverstats.liveview.snapshot.InventorySample;
import dev.mcserverstats.liveview.snapshot.ParticleEvent;
import dev.mcserverstats.liveview.snapshot.WorldSky;
import dev.mcserverstats.liveview.snapshot.PlayerSample;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Liveview for one run of the server: the hubs that turn snapshots into messages, the two keys, and the connection
 * to the dashboard's relay. Nothing here costs anything until someone watches: the game's textures are only fetched
 * and packed when the first viewer arrives.
 */
public final class LiveviewRuntime implements OptOutController, KeyController {
	private final ExecutorService tasks = Executors.newVirtualThreadPerTaskExecutor();
	private final AssetStore assetStore = new AssetStore();
	private final Supplier<LiveSettings> settings;
	private final Supplier<RelayLink.Target> target;
	private final Runnable keysChanged;
	private final KeyLimiter limiter = new KeyLimiter();
	private volatile int cameraRadius = 8;
	private final AtomicBoolean bootStarted = new AtomicBoolean();
	private final AtomicBoolean assetsStarted = new AtomicBoolean();
	private final AtomicBoolean stop = new AtomicBoolean();
	private final Set<UUID> optOut = ConcurrentHashMap.newKeySet();
	private final AtomicBoolean skipEntitySample = new AtomicBoolean();
	private final AtomicBoolean entityThrottled = new AtomicBoolean();
	private final Object keysFile = new Object();
	private volatile boolean running;
	private volatile PlayerHub hub;
	private volatile RelayLink relay;
	private volatile Path configDir;
	private volatile KeyStore keys;
	private volatile LiveSettings startSettings = LiveSettings.DEFAULT;
	private int tick;
	private volatile int entityInterval = 2;
	private volatile AdminCommands commands;
	private volatile long tickNanos = -1;
	private volatile WorldSky sky = WorldSky.UNKNOWN;
	private volatile String spawn;
	private final List<ParticleEvent> particles = new ArrayList<>();

	/**
	 * @param settings    the current settings (the on/off switches are read each time; the rest at start)
	 * @param target      where the relay is, or null while the mod isn't set up
	 * @param keysChanged run after a key is made or replaced, so the dashboard can be told
	 */
	public LiveviewRuntime(Supplier<LiveSettings> settings, Supplier<RelayLink.Target> target, Runnable keysChanged) {
		this.settings = settings;
		this.target = target;
		this.keysChanged = keysChanged;
	}

	public void start(Path configDir, AdminCommands commands) {
		if (!bootStarted.compareAndSet(false, true)) {
			return;
		}
		this.configDir = configDir;
		this.commands = commands;
		tasks.submit(() -> boot(configDir));
	}

	public void stop() {
		stop.set(true);
		running = false;
		closeQuietly();
		tasks.shutdownNow();
	}

	public boolean enabled() {
		return running && settings.get().enabled();
	}

	/** Whether the dashboard may run commands and move items at all (each viewer still needs the control key). */
	public boolean controlAllowed() {
		LiveSettings current = settings.get();
		return current.enabled() && current.control();
	}

	public AdminCommands commands() {
		return commands;
	}

	/** The dashboard has someone who wants to watch: open the relay connection. */
	public void requestRelay() {
		RelayLink current = relay;
		if (current != null && enabled()) {
			current.request();
		}
	}

	public List<RelayLink.Watcher> watchers() {
		RelayLink current = relay;
		return current == null ? List.of() : current.watchers();
	}

	/** Server thread, once a second: drops viewers after Liveview or its controls were turned off in the settings. */
	public void checkSettings() {
		RelayLink current = relay;
		if (current == null) {
			return;
		}
		LiveSettings now = settings.get();
		if (!now.enabled()) {
			if (!current.watchers().isEmpty()) {
				current.dropViewers("Liveview was turned off");
			}
		} else if (!now.control()) {
			for (RelayLink.Watcher watcher : current.watchers()) {
				if (watcher.control()) {
					current.lockControls();
					break;
				}
			}
		}
	}

	/** What the dashboard is told about this server's Liveview: {"type":"liveview","enabled",…}. */
	public String info() {
		KeyStore store = keys;
		LiveSettings now = settings.get();
		StringBuilder out = new StringBuilder("{\"type\":\"liveview\",\"protocol\":1,\"enabled\":").append(running && now.enabled());
		out.append(",\"control\":").append(now.enabled() && now.control());
		out.append(",\"viewer_key\":");
		keyId(out, store, KeyStore.Level.VIEWER);
		out.append(",\"control_key\":");
		keyId(out, store, KeyStore.Level.CONTROL);
		return out.append('}').toString();
	}

	private static void keyId(StringBuilder out, KeyStore store, KeyStore.Level level) {
		String id = store == null ? null : store.id(level);
		if (id == null) {
			out.append("null");
		} else {
			out.append('"').append(id).append('"');
		}
	}

	/** The status line each viewer gets every couple of seconds: {"type":"status",…}. */
	public String status(boolean control) {
		PlayerHub current = hub;
		long nanos = tickNanos;
		return Messages.status(
				current == null ? 0 : current.viewerCount(),
				current == null ? 0 : current.droppedDeltas(),
				current != null && current.atlasReady(),
				control,
				controlAllowed(),
				nanos < 0 ? Double.NaN : nanos / 1_000_000.0,
				sky,
				spawn);
	}

	/** Server thread: the world spawn as JSON (see ServerChecks.spawn), told to viewers with the status. */
	public void setSpawn(String value) {
		spawn = value;
	}

	/**
	 * Checks a key typed on the dashboard. {@code who} is the account trying, for the limit on wrong tries.
	 * Slow on purpose (PBKDF2), so it runs on a worker and answers through {@code done}.
	 */
	public void verify(String level, String key, String who, Consumer<Verified> done) {
		KeyStore.Level which = KeyStore.Level.of(level);
		KeyStore store = keys;
		LiveSettings now = settings.get();
		if (which == null) {
			done.accept(Verified.failed("bad"));
			return;
		}
		if (!running || store == null || !now.enabled() || (which == KeyStore.Level.CONTROL && !now.control())) {
			done.accept(Verified.failed("off"));
			return;
		}
		if (store.id(which) == null) {
			done.accept(Verified.failed("not_set"));
			return;
		}
		String account = who == null || who.isBlank() ? "?" : who;
		if (limiter.blocked(account) || limiter.blocked("*" + which.id)) {
			LogOnce.logger().info("Liveview refused a {} key try from {}: too many wrong tries", which.id, account);
			done.accept(Verified.failed("limited"));
			return;
		}
		try {
			tasks.submit(() -> {
				boolean ok;
				try {
					ok = store.verify(which, key);
				} catch (Throwable thrown) {
					LogOnce.warn("verify", "Liveview could not check a key", thrown);
					ok = false;
				}
				if (ok) {
					limiter.success(account);
					LogOnce.logger().info("Liveview: {} entered the {} key", account, which.id);
					done.accept(new Verified(true, null, store.id(which)));
				} else {
					limiter.failure(account);
					limiter.failure("*" + which.id);
					LogOnce.logger().info("Liveview: {} entered a wrong {} key", account, which.id);
					done.accept(Verified.failed("wrong"));
				}
			});
		} catch (RuntimeException stopping) {
			done.accept(Verified.failed("off"));
		}
	}

	/** {@code error} is one of wrong, not_set, limited, off, bad; {@code keyId} is the id of the key that matched. */
	public record Verified(boolean ok, String error, String keyId) {
		static Verified failed(String error) {
			return new Verified(false, error, null);
		}
	}

	public boolean hasViewers() {
		PlayerHub current = hub;
		return running && current != null && current.hasAuthenticatedViewer();
	}

	/** Server ticks between entity samples: 20 / view.entity-hz, so 10 Hz is 2 and 5 Hz is 4. */
	public int entityInterval() {
		return entityInterval;
	}

	/** Server thread, while someone watches: the average tick time for the status card. */
	public void setTickNanos(long nanos) {
		tickNanos = nanos;
	}

	/** Server thread: the overworld's time, weather and sky darkening, so the page can draw and light the sky. */
	public void setSky(WorldSky value) {
		sky = value == null ? WorldSky.UNKNOWN : value;
	}

	/** Server thread: buffers one particle broadcast until the end of the tick. */
	public void onParticle(ParticleEvent event) {
		if (particles.size() < 256) {
			particles.add(event);
		}
	}

	/** Server thread, end of tick: hands this tick's particles to the hub. */
	public void flushParticles() {
		if (particles.isEmpty()) {
			return;
		}
		List<ParticleEvent> batch = List.copyOf(particles);
		particles.clear();
		PlayerHub current = hub;
		if (running && current != null) {
			current.submitParticles(batch);
		}
	}

	public void resetTick() {
		tick = 0;
	}

	public int advanceTick() {
		tick++;
		return tick;
	}

	public Set<UUID> optOut() {
		return optOut;
	}

	public Set<UUID> subscribedPlayers() {
		PlayerHub current = hub;
		return current == null ? Set.of() : current.subscribedPlayers();
	}

	public boolean inventoryDue() {
		PlayerHub current = hub;
		return current != null && current.hasInventorySubscription() && (tick % 10 == 0 || current.pullInventorySoon());
	}

	public void onSamples(List<PlayerSample> samples) {
		PlayerHub current = hub;
		if (running && current != null) {
			current.submit(samples);
		}
	}

	public void onInventories(List<InventorySample> samples) {
		PlayerHub current = hub;
		if (running && current != null) {
			current.submitInventories(samples);
		}
	}

	public List<PlayerHub.ContainerWatch> containerWatches() {
		PlayerHub current = hub;
		return current == null ? List.of() : current.containerWatches();
	}

	public boolean containerDue() {
		PlayerHub current = hub;
		return current != null && (tick % 10 == 5 || current.pullContainerSoon());
	}

	public void onContainer(long viewerId, dev.mcserverstats.liveview.snapshot.ContainerView view) {
		PlayerHub current = hub;
		if (running && current != null) {
			current.submitContainer(viewerId, view);
		}
	}

	public int cameraChunkRadius() {
		return cameraRadius;
	}

	public int entityRadius() {
		PlayerHub current = hub;
		return current == null ? 64 : current.entityRadius();
	}

	public List<CameraPoint> cameraInterest() {
		PlayerHub current = hub;
		return current == null ? List.of() : current.cameraInterest();
	}

	public void setCameraInterest(long viewerId, String dimension, double x, double y, double z) {
		PlayerHub current = hub;
		if (current != null) {
			current.setCameraInterest(viewerId, dimension, x, y, z);
		}
	}

	public void clearCameraInterest(long viewerId) {
		PlayerHub current = hub;
		if (current != null) {
			current.clearCameraInterest(viewerId);
		}
	}

	public boolean entityQueuesFull() {
		PlayerHub current = hub;
		return current != null && current.entityQueuesFull();
	}

	public boolean consumeEntitySkip() {
		return skipEntitySample.getAndSet(false);
	}

	public void armEntitySkip() {
		skipEntitySample.set(true);
	}

	public void armEntityThrottled() {
		entityThrottled.set(true);
	}

	public boolean consumeEntityThrottled() {
		return entityThrottled.getAndSet(false);
	}

	public void clearEntityShed() {
		skipEntitySample.set(false);
		entityThrottled.set(false);
	}

	public void onEntities(EntityFrame frame) {
		PlayerHub current = hub;
		if (running && current != null && frame != null) {
			current.submitEntities(frame);
		}
	}

	public void onAction(ActionEvent event) {
		PlayerHub current = hub;
		if (current != null) {
			current.submitAction(event);
		}
	}

	/** Null until the hub exists or when nobody is watching terrain. */
	public TerrainHub terrain() {
		PlayerHub current = hub;
		if (!running || current == null) {
			return null;
		}
		TerrainHub terrain = current.terrain();
		return terrain.wantsTerrain() ? terrain : null;
	}

	public void onTouch(BlockTouch touch) {
		PlayerHub current = hub;
		if (running && current != null) {
			current.terrain().touch(touch);
		}
	}

	@Override
	public boolean optOut(UUID uuid) {
		if (uuid == null || !optOut.add(uuid)) {
			return false;
		}
		queuePersist();
		PlayerHub current = hub;
		if (current != null) {
			current.submitInventories(List.of(InventorySample.unavailable(uuid)));
		}
		return true;
	}

	@Override
	public boolean optIn(UUID uuid) {
		if (uuid == null || !optOut.remove(uuid)) {
			return false;
		}
		queuePersist();
		PlayerHub current = hub;
		if (current != null) {
			current.requestInventoryPoll();
		}
		return true;
	}

	private void queuePersist() {
		try {
			tasks.submit(this::persistOptOut);
		} catch (RuntimeException thrown) {
			LogOnce.warn("opt-out-queue", "Liveview could not queue an opt-out save", thrown);
		}
	}

	private void persistOptOut() {
		KeyStore store = keys;
		if (store == null) {
			return;
		}
		try {
			synchronized (keysFile) {
				store.saveOptOut(Set.copyOf(optOut));
			}
		} catch (IOException thrown) {
			LogOnce.warn("opt-out-save", "Liveview could not write opt-out uuids", thrown);
		} catch (Throwable thrown) {
			LogOnce.warn("opt-out-save-unexpected", "Liveview failed while writing opt-out uuids", thrown);
		}
	}

	@Override
	public void resetKey(KeyStore.Level level, Consumer<Result> done) {
		Path dir = configDir;
		if (dir == null || !bootStarted.get()) {
			done.accept(Result.failed("Liveview is still starting. Try again in a few seconds."));
			return;
		}
		try {
			tasks.submit(() -> {
				Result result;
				try {
					String key;
					synchronized (keysFile) {
						KeyStore store = keys;
						if (store == null) {
							// the file couldn't be read at start: a new key starts it afresh
							store = KeyStore.fresh(dir);
							keys = store;
						}
						key = store.reset(level);
					}
					RelayLink current = relay;
					if (current != null) {
						if (level == KeyStore.Level.VIEWER) {
							current.dropViewers("the viewer key was replaced");
						} else {
							current.lockControls();
						}
					}
					LogOnce.logger().info(level == KeyStore.Level.VIEWER
							? "Liveview viewer key was replaced; every account has to enter the new one"
							: "Liveview control key was replaced; controls are locked for every account until it enters the new one");
					result = new Result(key, null);
					try {
						keysChanged.run();
					} catch (Throwable thrown) {
						LogOnce.warn("keys-changed", "Liveview could not tell the dashboard about the new key", thrown);
					}
				} catch (Throwable thrown) {
					LogOnce.logger().warn("Liveview could not make a new key", thrown);
					result = Result.failed("Liveview could not write config/" + KeyStore.FILE_NAME + ". See the server log.");
				}
				done.accept(result);
			});
		} catch (RuntimeException thrown) {
			done.accept(Result.failed("The server is shutting down."));
		}
	}

	private void boot(Path configDir) {
		try {
			if (stop.get()) {
				return;
			}
			LiveSettings config = settings.get();
			startSettings = config;
			entityInterval = Math.max(2, Math.round(20.0f / config.entityHz()));
			cameraRadius = config.cameraChunkRadius();
			try {
				synchronized (keysFile) {
					keys = KeyStore.load(configDir);
				}
				optOut.addAll(keys.optOut());
			} catch (IOException thrown) {
				LogOnce.logger().warn("Liveview is off: {}. Make a new viewer key in game with /liveview key viewer to start afresh.", thrown.getMessage());
			}
			PlayerHub createdHub = new PlayerHub(config.cameraChunkRadius(), config.playerChunkRadius(), config.entityRadiusBlocks(), assetStore);
			createdHub.start();
			hub = createdHub;
			relay = new RelayLink(target, this, createdHub, assetStore);
			if (stop.get()) {
				closeQuietly();
				return;
			}
			running = true;
			KeyStore store = keys;
			if (config.enabled() && store != null && store.id(KeyStore.Level.VIEWER) == null) {
				LogOnce.logger().info("Liveview is ready but has no viewer key yet. An operator runs /liveview key viewer in game to make one; the dashboard asks for it once per account.");
			}
			try {
				keysChanged.run();
			} catch (Throwable thrown) {
				LogOnce.warn("keys-changed", "Liveview could not tell the dashboard it is ready", thrown);
			}
		} catch (Throwable thrown) {
			LogOnce.logger().warn("Liveview failed to start", thrown);
			closeQuietly();
		}
	}

	/** Called when a viewer arrives: fetches the game's textures and packs them, the first time only. */
	public void ensureAssets() {
		PlayerHub current = hub;
		Path dir = configDir;
		if (current == null || dir == null || !assetsStarted.compareAndSet(false, true)) {
			return;
		}
		try {
			tasks.submit(() -> buildAssets(startSettings, dir, current.terrain()));
		} catch (RuntimeException stopping) {
			// The server is stopping.
		}
	}

	private void buildAssets(LiveSettings config, Path configDir, TerrainHub terrain) {
		try {
			long started = System.nanoTime();
			Path jar = ClientJar.resolve(
					config.clientJar(),
					true,
					configDir.resolve("mcstats-liveview-cache"),
					AssetEnvironment.minecraftVersion());
			List<AssetSource.Root> roots = new ArrayList<>();
			for (AssetEnvironment.ModRoot root : AssetEnvironment.modRoots()) {
				roots.add(new AssetSource.Root(root.modId(), root.root()));
			}
			// Entity geometry first, so the meta can point at it. A failure only means mobs stay boxes.
			String modelsUrl = null;
			byte[] models = ModelExtractor.extract(jar);
			if (models != null) {
				String hash = AssetPipeline.sha256(models);
				assetStore.put(hash + ".json", models, "application/json", true);
				modelsUrl = AssetStore.PREFIX + hash + ".json";
			}
			AssetBundle bundle = AssetPipeline.build(jar, roots, modelsUrl);
			if (stop.get()) {
				return;
			}
			assetStore.put(bundle.atlasHash() + ".png", bundle.atlas().png(), "image/png", true);
			assetStore.put(bundle.metaHash() + ".json", bundle.metaJson(), "application/json", true);
			for (Map.Entry<String, byte[]> file : bundle.files().entrySet()) {
				assetStore.put(file.getKey(), file.getValue(), file.getKey().endsWith(".png") ? "image/png" : "application/json", true);
			}
			terrain.setAssets(bundle);
			LogOnce.logger().info(
					"Liveview atlas ready: {}x{} with {} textures in {} ms",
					bundle.atlas().size(),
					bundle.atlas().size(),
					bundle.atlas().rects().size(),
					(System.nanoTime() - started) / 1_000_000L);
		} catch (AssetException thrown) {
			LogOnce.logger().warn("Liveview terrain is disabled: {}", thrown.getMessage());
			terrain.assetsFailed(thrown.getMessage());
		} catch (Throwable thrown) {
			LogOnce.logger().warn("Liveview terrain is disabled because the asset build failed", thrown);
			terrain.assetsFailed("asset build failed: " + thrown.getClass().getSimpleName());
		}
	}

	private void closeQuietly() {
		running = false;
		RelayLink currentRelay = relay;
		PlayerHub currentHub = hub;
		relay = null;
		hub = null;
		if (currentRelay != null) {
			try {
				currentRelay.close("server stopping");
			} catch (Throwable thrown) {
				LogOnce.warn("stop-relay", "Liveview failed to close its connection to the dashboard", thrown);
			}
		}
		if (currentHub != null) {
			try {
				currentHub.close();
			} catch (Throwable thrown) {
				LogOnce.warn("stop-hub", "Liveview failed to close the player hub", thrown);
			}
		}
	}
}
