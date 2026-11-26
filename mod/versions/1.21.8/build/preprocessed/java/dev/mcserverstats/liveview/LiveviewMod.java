package dev.mcserverstats.liveview;

import dev.mcserverstats.liveview.mc.ActionHooks;
import dev.mcserverstats.liveview.mc.CommandRunner;
import dev.mcserverstats.liveview.mc.EntitySampler;
import dev.mcserverstats.liveview.mc.InventorySampler;
import dev.mcserverstats.liveview.mc.LiveviewCommands;
import dev.mcserverstats.liveview.hub.TerrainHub;
import dev.mcserverstats.liveview.keys.KeyStore;
import dev.mcserverstats.liveview.relay.RelayLink;
import dev.mcserverstats.liveview.mc.ParticleTap;
import dev.mcserverstats.liveview.mc.CameraChunks;
import dev.mcserverstats.liveview.mc.ContainerSampler;
import dev.mcserverstats.liveview.hub.PlayerHub;
import dev.mcserverstats.liveview.mc.PlayerSampler;
import dev.mcserverstats.liveview.mc.ServerChecks;
import dev.mcserverstats.liveview.mc.TerrainSampler;
import dev.mcserverstats.liveview.snapshot.ActionEvent;
import dev.mcserverstats.liveview.snapshot.BlockTouch;
import dev.mcserverstats.liveview.snapshot.InventorySample;
import dev.mcserverstats.liveview.snapshot.SectionId;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Supplier;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.loader.api.FabricLoader;

/**
 * Liveview: lets dashboard admins watch the world from the dashboard's Liveview tab, and (with a second key) run
 * commands and move items. The mcstats mod creates one of these and calls {@link #init()} once.
 *
 * <p>Fabric callbacks are registered once per launch, while each start of the server gets a fresh
 * {@link LiveviewRuntime} (created on SERVER_STARTING, dropped on SERVER_STOPPING). Every callback reads the current
 * one through {@link #runtime} and does nothing while it is null.
 */
public final class LiveviewMod {
	private static final int SECTIONS_PER_TICK = 48;
	private static final long SECTION_BUDGET_NANOS = 3_000_000L;

	private final Supplier<LiveSettings> settings;
	private final Supplier<RelayLink.Target> target;
	private final Runnable infoChanged;
	private volatile LiveviewRuntime runtime;
	private final ActionHooks actions = new ActionHooks(this::onAction, this::optOutSet, this::onTouch);
	private final Controls controls = new Controls();
	private int settingsTick;

	/**
	 * @param settings    the current settings, read from the mod's properties file
	 * @param target      where the dashboard's relay is, or null while the mod isn't set up
	 * @param infoChanged run whenever {@link #info()} would say something new, so it can be sent to the dashboard
	 */
	public LiveviewMod(Supplier<LiveSettings> settings, Supplier<RelayLink.Target> target, Runnable infoChanged) {
		this.settings = settings;
		this.target = target;
		this.infoChanged = infoChanged;
	}

	/** What the dashboard is told about Liveview here, as a JSON message; null before the server has started. */
	public String info() {
		LiveviewRuntime current = runtime;
		return current == null ? null : current.info();
	}

	/** The dashboard has someone who wants to watch. */
	public void requestRelay() {
		LiveviewRuntime current = runtime;
		if (current != null) {
			current.requestRelay();
		}
	}

	/** Checks a key typed on the dashboard; see {@link LiveviewRuntime#verify}. */
	public void verify(String level, String key, String who, Consumer<LiveviewRuntime.Verified> done) {
		LiveviewRuntime current = runtime;
		if (current == null) {
			done.accept(new LiveviewRuntime.Verified(false, "off", null));
			return;
		}
		current.verify(level, key, who, done);
	}

	public void init() {
		actions.register();
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
			try {
				LiveviewCommands.register(dispatcher, controls, controls, this::watchers);
			} catch (Throwable thrown) {
				LogOnce.warn("commands", "Liveview failed to register commands", thrown);
			}
		});
		ServerLifecycleEvents.SERVER_STARTING.register(server -> {
			try {
				actions.reset();
				runtime = new LiveviewRuntime(settings, target, infoChanged);
			} catch (Throwable thrown) {
				LogOnce.warn("create", "Liveview failed to prepare for a server start", thrown);
			}
		});
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			try {
				LiveviewRuntime current = runtime;
				if (current == null) {
					current = new LiveviewRuntime(settings, target, infoChanged);
					runtime = current;
				}
				current.start(FabricLoader.getInstance().getConfigDir(), new CommandRunner(server));
				current.setSpawn(ServerChecks.spawn(server));
			} catch (Throwable thrown) {
				LogOnce.warn("start", "Liveview failed to start", thrown);
			}
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			LiveviewRuntime current = runtime;
			runtime = null;
			ParticleTap.sink(null);
			try {
				if (current != null) {
					current.stop();
				}
			} catch (Throwable thrown) {
				LogOnce.warn("stop", "Liveview failed to stop", thrown);
			}
			try {
				actions.reset();
				TerrainSampler.clearCaches();
			} catch (Throwable thrown) {
				LogOnce.warn("stop-caches", "Liveview failed to clear its per-world caches", thrown);
			}
			// Let the next start log its own first failures.
			LogOnce.reset();
		});
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			LiveviewRuntime runtime = this.runtime;
			if (runtime == null) {
				return;
			}
			try {
				ParticleTap.endTick();
				if (++settingsTick >= 20) {
					settingsTick = 0;
					runtime.checkSettings();
				}
				if (!runtime.hasViewers()) {
					ParticleTap.sink(null);
					runtime.resetTick();
					runtime.clearEntityShed();
					// UseBlockCallback keeps recording while nobody watches; without this, the first viewer would get
					// up to 256 stale right-clicks reported as block_place.
					actions.reset();
					return;
				}
				ParticleTap.sink(runtime::onParticle);
				runtime.flushParticles();
				int tick = runtime.advanceTick();
				if (tick == 1) {
					ServerChecks.onFirstViewer(server);
				}
				if (tick % 20 == 0) {
					runtime.setTickNanos(ServerChecks.averageTickNanos(server));
					runtime.setSky(ServerChecks.sky(server));
					runtime.setSpawn(ServerChecks.spawn(server));
				}
				try {
					actions.onEndTick(server);
				} catch (Throwable thrown) {
					LogOnce.warn("place-tick", "Liveview failed a block_place check", thrown);
				}
				if (tick % 2 == 0) {
					try {
						PlayerSampler.sample(server, runtime.optOut()).ifPresent(runtime::onSamples);
					} catch (Throwable thrown) {
						LogOnce.warn("player-tick", "Liveview failed a player sample", thrown);
					}
				}
				// view.entity-hz sets the base rate; load-shed skips one sample on top of that when queues are full.
				if (tick % runtime.entityInterval() == 0) {
					try {
						if (runtime.consumeEntitySkip()) {
							runtime.armEntityThrottled();
						} else {
							boolean throttled = runtime.consumeEntityThrottled();
							EntitySampler.sample(server, runtime.optOut(), runtime.entityRadius(), runtime.cameraInterest())
									.ifPresent(frame -> runtime.onEntities(frame.withThrottled(throttled)));
							if (runtime.entityQueuesFull()) {
								runtime.armEntitySkip();
							}
						}
					} catch (Throwable thrown) {
						LogOnce.warn("entity-tick", "Liveview failed an entity sample", thrown);
					}
				}
				if (tick % 10 == 3) {
					try {
						CameraChunks.refresh(server, runtime.cameraInterest(), runtime.cameraChunkRadius());
					} catch (Throwable thrown) {
						LogOnce.warn("camera-chunk-tick", "Liveview failed to load chunks around a camera", thrown);
					}
				}
				if (runtime.containerDue()) {
					try {
						for (PlayerHub.ContainerWatch watch : runtime.containerWatches()) {
							runtime.onContainer(watch.viewerId(), ContainerSampler.read(server, watch.dimension(), watch.x(), watch.y(), watch.z()));
						}
					} catch (Throwable thrown) {
						LogOnce.warn("container-tick", "Liveview failed a container read", thrown);
					}
				}
				if (runtime.inventoryDue()) {
					try {
						Set<UUID> wanted = runtime.subscribedPlayers();
						if (!wanted.isEmpty()) {
							List<InventorySample> samples = InventorySampler.sample(server, wanted, runtime.optOut());
							runtime.onInventories(samples);
						}
					} catch (Throwable thrown) {
						LogOnce.warn("inventory-tick", "Liveview failed an inventory sample", thrown);
					}
				}
				try {
					TerrainHub terrain = runtime.terrain();
					if (terrain != null) {
						if (tick % 10 == 1) {
							terrain.onColumns(TerrainSampler.columns(server, terrain.columnQueries()));
						}
						List<SectionId> wanted = terrain.takeRequests(SECTIONS_PER_TICK);
						if (!wanted.isEmpty()) {
							terrain.onBatch(TerrainSampler.snapshot(server, wanted, SECTION_BUDGET_NANOS));
						}
					}
				} catch (Throwable thrown) {
					LogOnce.warn("terrain-tick", "Liveview failed a terrain copy", thrown);
				}
			} catch (Throwable thrown) {
				LogOnce.warn("tick", "Liveview tick failed", thrown);
			}
		});
	}

	private void onAction(ActionEvent event) {
		LiveviewRuntime current = runtime;
		if (current != null) {
			current.onAction(event);
		}
	}

	private void onTouch(BlockTouch touch) {
		LiveviewRuntime current = runtime;
		if (current != null) {
			current.onTouch(touch);
		}
	}

	private Set<UUID> optOutSet() {
		LiveviewRuntime current = runtime;
		return current == null ? Set.of() : current.optOut();
	}

	private List<RelayLink.Watcher> watchers() {
		LiveviewRuntime current = runtime;
		return current == null ? List.of() : current.watchers();
	}

	/** Commands are registered with this stable object; it forwards to whichever runtime is current. */
	private final class Controls implements OptOutController, KeyController {
		@Override
		public boolean optOut(UUID uuid) {
			LiveviewRuntime current = runtime;
			return current != null && current.optOut(uuid);
		}

		@Override
		public boolean optIn(UUID uuid) {
			LiveviewRuntime current = runtime;
			return current != null && current.optIn(uuid);
		}

		@Override
		public void resetKey(KeyStore.Level level, Consumer<Result> done) {
			LiveviewRuntime current = runtime;
			if (current == null) {
				done.accept(Result.failed("Liveview is not running on this server."));
				return;
			}
			current.resetKey(level, done);
		}

		@Override
		public java.util.Map<String, KeyStore.Level> accessList() {
			LiveviewRuntime current = runtime;
			return current == null ? java.util.Map.of() : current.accessList();
		}

		@Override
		public void setAccess(String account, KeyStore.Level level, Consumer<String> done) {
			LiveviewRuntime current = runtime;
			if (current == null) {
				done.accept("Liveview is not running on this server.");
				return;
			}
			current.setAccess(account, level, done);
		}
	}
}
