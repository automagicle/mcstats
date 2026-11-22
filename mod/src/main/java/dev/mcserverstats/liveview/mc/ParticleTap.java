package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.ParticleEvent;
import java.util.function.Consumer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.particles.BlockParticleOption;
import net.minecraft.core.particles.DustParticleOptions;
import net.minecraft.core.particles.ParticleOptions;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import org.joml.Vector3f;

/**
 * Copies particle broadcasts out of {@code ServerLevel} (called from {@code ServerLevelMixin} on the server thread).
 * Vanilla has no event for particles, so this is the one place Liveview uses mixins.
 *
 * <p>VERIFIED by javap on the 26.2 merged jar: {@code ParticleOptions.getType()}, {@code BuiltInRegistries.PARTICLE_TYPE},
 * {@code BlockParticleOption.getState()}, {@code DustParticleOptions.getColor()} (joml Vector3f, 0-1 per channel),
 * {@code Block.stateById(int)}. Level event 2001 is vanilla's block-break effect with {@code Block.getId(state)} as data.
 */
public final class ParticleTap {
	/** Most events copied per server tick; the rest of that tick is skipped. */
	private static final int PER_TICK = 96;
	private static final int BLOCK_BREAK_EVENT = 2001;
	private static final int POTION_SPLASH_EVENT = 2002;
	private static final int INSTANT_SPLASH_EVENT = 2007;

	private static volatile Consumer<ParticleEvent> sink;
	private static int thisTick;

	private ParticleTap() {
	}

	/** Set while someone is watching; null turns the tap into a no-op. */
	public static void sink(Consumer<ParticleEvent> next) {
		sink = next;
	}

	/** Server thread, once per tick. */
	public static void endTick() {
		thisTick = 0;
	}

	public static void onParticles(ServerLevel level, ParticleOptions options, double x, double y, double z,
			int count, double dx, double dy, double dz, double speed) {
		Consumer<ParticleEvent> out = sink;
		if (out == null || options == null || thisTick >= PER_TICK) {
			return;
		}
		try {
			Identifier id = BuiltInRegistries.PARTICLE_TYPE.getKey(options.getType());
			if (id == null) {
				return;
			}
			String block = null;
			int color = -1;
			if (options instanceof BlockParticleOption blockOption) {
				block = Ids.block(blockOption.getState());
			} else if (options instanceof DustParticleOptions dust) {
				Vector3f c = dust.getColor();
				color = rgb(c.x(), c.y(), c.z());
			} else if (options instanceof net.minecraft.core.particles.ColorParticleOption tinted) {
				color = rgb(tinted.getRed(), tinted.getGreen(), tinted.getBlue());
			} else if (options instanceof net.minecraft.core.particles.ItemParticleOption itemOption) {
				block = Ids.item(itemOption.getItem().create());
			}
			thisTick++;
			out.accept(new ParticleEvent(Ids.dimension(level), id.toString(), x, y, z, Math.max(0, Math.min(count, 256)),
					(float) dx, (float) dy, (float) dz, (float) speed, block, color));
		} catch (Throwable thrown) {
			LogOnce.warn("particle-tap", "Liveview could not copy a particle broadcast", thrown);
		}
	}

	public static void onLevelEvent(ServerLevel level, int type, BlockPos pos, int data) {
		Consumer<ParticleEvent> out = sink;
		if (out == null || pos == null || thisTick >= PER_TICK) {
			return;
		}
		// 2002 splash potion and 2007 instant splash: LevelRenderer draws the bottle shards and a burst of colored
		// effect particles on the client; data is the potion color.
		if (type == POTION_SPLASH_EVENT || type == INSTANT_SPLASH_EVENT) {
			thisTick++;
			out.accept(new ParticleEvent(Ids.dimension(level), type == INSTANT_SPLASH_EVENT ? "liveview:instant_splash" : "liveview:potion_splash",
					pos.getX() + 0.5, pos.getY(), pos.getZ() + 0.5, 0, 0f, 0f, 0f, 0f, null, data & 0xFFFFFF));
			return;
		}
		if (type != BLOCK_BREAK_EVENT) {
			return;
		}
		try {
			String block = Ids.block(Block.stateById(data));
			if ("minecraft:air".equals(block)) {
				return;
			}
			thisTick++;
			out.accept(new ParticleEvent(Ids.dimension(level), "liveview:block_break", pos.getX() + 0.5, pos.getY() + 0.5,
					pos.getZ() + 0.5, 0, 0f, 0f, 0f, 0f, block, -1));
		} catch (Throwable thrown) {
			LogOnce.warn("particle-break", "Liveview could not copy a block-break effect", thrown);
		}
	}

	/**
	 * An explosion: {@code speed} carries the power and {@code count} is 1 when it breaks blocks, which is when the
	 * client draws the big emitter (ServerExplosion picks the large particle for power >= 2 with block interaction).
	 */
	public static void onExplosion(ServerLevel level, double x, double y, double z, float power, boolean breaks) {
		Consumer<ParticleEvent> out = sink;
		if (out == null || thisTick >= PER_TICK) {
			return;
		}
		try {
			thisTick++;
			out.accept(new ParticleEvent(Ids.dimension(level), "liveview:explosion", x, y, z, breaks ? 1 : 0, 0f, 0f, 0f, power, null, -1));
		} catch (Throwable thrown) {
			LogOnce.warn("particle-explode", "Liveview could not copy an explosion", thrown);
		}
	}

	/**
	 * Entity events that are particles on the client: 60 is LivingEntity's death poof (spread over the hitbox, carried
	 * in dx and dy), 3 is a thrown snowball or egg breaking into item particles.
	 */
	public static void onEntityEvent(ServerLevel level, net.minecraft.world.entity.Entity entity, byte event) {
		Consumer<ParticleEvent> out = sink;
		if (out == null || entity == null || thisTick >= PER_TICK) {
			return;
		}
		try {
			if (event == 60 && entity instanceof net.minecraft.world.entity.LivingEntity) {
				thisTick++;
				out.accept(new ParticleEvent(Ids.dimension(level), "liveview:poof", entity.getX(), entity.getY(), entity.getZ(), 20,
						entity.getBbWidth(), entity.getBbHeight(), 0f, 0f, null, -1));
			} else if (event == 3 && entity instanceof net.minecraft.world.entity.projectile.ItemSupplier supplier) {
				thisTick++;
				out.accept(new ParticleEvent(Ids.dimension(level), "liveview:item_break", entity.getX(), entity.getY(), entity.getZ(), 8,
						0f, 0f, 0f, 0f, Ids.item(supplier.getItem()), -1));
			}
		} catch (Throwable thrown) {
			LogOnce.warn("particle-entity", "Liveview could not copy an entity effect", thrown);
		}
	}

	private static int rgb(float r, float g, float b) {
		int ri = Math.max(0, Math.min(255, Math.round(r * 255f)));
		int gi = Math.max(0, Math.min(255, Math.round(g * 255f)));
		int bi = Math.max(0, Math.min(255, Math.round(b * 255f)));
		return ri << 16 | gi << 8 | bi;
	}
}
