package dev.mcserverstats.liveview.mc.mixin;

import dev.mcserverstats.liveview.mc.CameraChunks;
import net.minecraft.world.entity.Mob;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Keeps mobs around a viewer's camera from despawning because no player is near (VERIFIED by javap on the 26.2 merged
 * jar: {@code public void Mob.checkDespawn()}). Peaceful-difficulty and persistence rules elsewhere are untouched.
 */
@Mixin(Mob.class)
public abstract class MobMixin {
	@Inject(method = "checkDespawn()V", at = @At("HEAD"), cancellable = true)
	private void liveview$watched(CallbackInfo info) {
		Mob self = (Mob) (Object) this;
		if (self.level().getDifficulty() != net.minecraft.world.Difficulty.PEACEFUL && CameraChunks.watching(self)) {
			info.cancel();
		}
	}
}
