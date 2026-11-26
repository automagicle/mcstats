package dev.mcserverstats.liveview.mc.mixin;

import dev.mcserverstats.liveview.mc.ParticleTap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.particles.ParticleOptions;
import net.minecraft.server.level.ServerLevel;
//#if MC >= 1.21.9
//$$ import net.minecraft.util.random.WeightedList;
//#endif
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.ExplosionDamageCalculator;
import net.minecraft.world.level.Level;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Observes particle broadcasts and the block-break effect. Both injections only read their arguments and never cancel.
 *
 * <p>VERIFIED by javap on the 26.2 merged jar: the 9-argument {@code sendParticles} forwards to this 11-argument one,
 * so one injection sees every broadcast once; {@code levelEvent(Entity, int, BlockPos, int)} is public on ServerLevel.
 */
@Mixin(ServerLevel.class)
public abstract class ServerLevelMixin {
	// Every mixin target's descriptor was checked by javap -s on each version's jar (1.21.1 to 26.3): they
	// aren't checked when compiling, and with defaultRequire 0 a wrong one only stops that hook working.
	//#if MC >= 1.21.4
	@Inject(
			method = "sendParticles(Lnet/minecraft/core/particles/ParticleOptions;ZZDDDIDDDD)I",
			at = @At("HEAD"))
	private void liveview$particles(ParticleOptions options, boolean overrideLimiter, boolean alwaysShow,
			double x, double y, double z, int count, double dx, double dy, double dz, double speed,
			CallbackInfoReturnable<Integer> info) {
	//#else
	//$$ // before 1.21.4 the broadcast without the two flags is the one every other overload ends in
	//$$ @Inject(
	//$$ 		method = "sendParticles(Lnet/minecraft/core/particles/ParticleOptions;DDDIDDDD)I",
	//$$ 		at = @At("HEAD"))
	//$$ private void liveview$particles(ParticleOptions options,
	//$$ 		double x, double y, double z, int count, double dx, double dy, double dz, double speed,
	//$$ 		CallbackInfoReturnable<Integer> info) {
	//#endif
		ParticleTap.onParticles((ServerLevel) (Object) this, options, x, y, z, count, dx, dy, dz, speed);
	}

	/**
	 * Explosions reach players as ClientboundExplodePacket, not as a particle broadcast. VERIFIED by javap -s on the 26.2
	 * merged jar: every other {@code explode} overload on ServerLevel ends in this one.
	 */
	//#if MC >= 1.21.9
	//$$ @Inject(
			//$$ method = "explode(Lnet/minecraft/world/entity/Entity;Lnet/minecraft/world/damagesource/DamageSource;"
					//$$ + "Lnet/minecraft/world/level/ExplosionDamageCalculator;DDDFZLnet/minecraft/world/level/Level$ExplosionInteraction;"
					//$$ + "Lnet/minecraft/core/particles/ParticleOptions;Lnet/minecraft/core/particles/ParticleOptions;"
					//$$ + "Lnet/minecraft/util/random/WeightedList;Lnet/minecraft/core/Holder;)V",
			//$$ at = @At("HEAD"))
	//$$ private void liveview$explode(Entity source, DamageSource damage, ExplosionDamageCalculator calculator,
			//$$ double x, double y, double z, float power, boolean fire, Level.ExplosionInteraction interaction,
			//$$ ParticleOptions small, ParticleOptions large, WeightedList<?> blockParticles, Holder<?> sound, CallbackInfo info) {
	//#elseif MC >= 1.21.2
	@Inject(
			method = "explode(Lnet/minecraft/world/entity/Entity;Lnet/minecraft/world/damagesource/DamageSource;"
					+ "Lnet/minecraft/world/level/ExplosionDamageCalculator;DDDFZLnet/minecraft/world/level/Level$ExplosionInteraction;"
					+ "Lnet/minecraft/core/particles/ParticleOptions;Lnet/minecraft/core/particles/ParticleOptions;"
					+ "Lnet/minecraft/core/Holder;)V",
			at = @At("HEAD"))
	private void liveview$explode(Entity source, DamageSource damage, ExplosionDamageCalculator calculator,
			double x, double y, double z, float power, boolean fire, Level.ExplosionInteraction interaction,
			ParticleOptions small, ParticleOptions large, Holder<?> sound, CallbackInfo info) {
	//#else
	//$$ @Inject(
	//$$ 		method = "explode(Lnet/minecraft/world/entity/Entity;Lnet/minecraft/world/damagesource/DamageSource;"
	//$$ 				+ "Lnet/minecraft/world/level/ExplosionDamageCalculator;DDDFZLnet/minecraft/world/level/Level$ExplosionInteraction;"
	//$$ 				+ "Lnet/minecraft/core/particles/ParticleOptions;Lnet/minecraft/core/particles/ParticleOptions;"
	//$$ 				+ "Lnet/minecraft/core/Holder;)Lnet/minecraft/world/level/Explosion;",
	//$$ 		at = @At("HEAD"))
	//$$ private void liveview$explode(Entity source, DamageSource damage, ExplosionDamageCalculator calculator,
	//$$ 		double x, double y, double z, float power, boolean fire, Level.ExplosionInteraction interaction,
	//$$ 		ParticleOptions small, ParticleOptions large, Holder<?> sound, CallbackInfoReturnable<?> info) {
	//#endif
		ParticleTap.onExplosion((ServerLevel) (Object) this, x, y, z, power, interaction != Level.ExplosionInteraction.NONE);
	}

	/** Entity events the client turns into particles (60: a mob's death poof, 3: a snowball or egg breaking). */
	@Inject(method = "broadcastEntityEvent(Lnet/minecraft/world/entity/Entity;B)V", at = @At("HEAD"))
	private void liveview$entityEvent(Entity entity, byte event, CallbackInfo info) {
		ParticleTap.onEntityEvent((ServerLevel) (Object) this, entity, event);
	}

	//#if MC >= 1.21.5
	@Inject(method = "levelEvent(Lnet/minecraft/world/entity/Entity;ILnet/minecraft/core/BlockPos;I)V", at = @At("HEAD"))
	private void liveview$levelEvent(Entity entity, int type, BlockPos pos, int data, CallbackInfo info) {
	//#else
	//$$ @Inject(method = "levelEvent(Lnet/minecraft/world/entity/player/Player;ILnet/minecraft/core/BlockPos;I)V", at = @At("HEAD"))
	//$$ private void liveview$levelEvent(net.minecraft.world.entity.player.Player entity, int type, BlockPos pos, int data, CallbackInfo info) {
	//#endif
		ParticleTap.onLevelEvent((ServerLevel) (Object) this, type, pos, data);
	}
}
