package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.Look;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponentType;
import net.minecraft.core.component.DataComponents;
import net.minecraft.util.StringRepresentable;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.TamableAnimal;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.DyedItemColor;
import net.minecraft.world.item.equipment.Equippable;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.lighting.LevelLightEngine;

/**
 * Reads an entity's {@link Look} on the server thread.
 *
 * <p>VERIFIED by javap on the 26.2 merged jar: {@code Entity implements DataComponentGetter} with
 * {@code get(DataComponentType)}; {@code DataComponents.WOLF_VARIANT, CAT_VARIANT, PIG_VARIANT, COW_VARIANT,
 * CHICKEN_VARIANT, FROG_VARIANT} hold {@code Holder}s of records whose textures are {@code ClientAsset.ResourceTexture}
 * ({@code id()} is the texture id, e.g. {@code minecraft:entity/wolf/wolf_ashen}); {@code WolfVariant.adultInfo/babyInfo}
 * with {@code wild/tame}; {@code CatVariant.assetInfo(boolean baby)}; {@code PigVariant/CowVariant/ChickenVariant
 * .modelAndTexture()} ({@code model()} is a StringRepresentable ModelType, {@code asset()}) and {@code babyTexture()};
 * {@code FrogVariant.assetInfo()}; the enum variants FOX, RABBIT, PARROT, LLAMA, AXOLOTL, HORSE and MOOSHROOM implement
 * StringRepresentable; {@code Sheep.getColor/isSheared}, {@code DyeColor.getTextureDiffuseColor};
 * {@code DataComponents.EQUIPPABLE} ({@code Equippable.assetId()}), {@code DYED_COLOR} ({@code DyedItemColor.rgb()});
 * {@code LivingEntity.getItemBySlot/getMainHandItem}; {@code LightEventListener.getLightValue(BlockPos)}.
 */
public final class Looks {
	private static final EquipmentSlot[] ARMOR = {EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET};
	private static final List<DataComponentType<?>> ENUM_VARIANTS = List.of(
			DataComponents.FOX_VARIANT, DataComponents.RABBIT_VARIANT, DataComponents.PARROT_VARIANT,
			DataComponents.LLAMA_VARIANT, DataComponents.AXOLOTL_VARIANT, DataComponents.HORSE_VARIANT,
			DataComponents.MOOSHROOM_VARIANT);

	private Looks() {
	}

	public static Look of(Entity entity) {
		try {
			return read(entity);
		} catch (Throwable thrown) {
			LogOnce.warn("look-" + Ids.entityType(entity), "Liveview could not read how a " + Ids.entityType(entity) + " looks", thrown);
			return new Look(0xF0, null, null, null, -1, List.of(), List.of(), "minecraft:air", "minecraft:air", null, 0, -1, -1, Look.Motion.STILL);
		}
	}

	private static Look read(Entity entity) {
		boolean baby = entity instanceof LivingEntity living && living.isBaby();
		String texture = null;
		String model = null;
		//#if MC >= 26.1
		//$$ var wolf = entity.get(DataComponents.WOLF_VARIANT);
		//$$ var cat = entity.get(DataComponents.CAT_VARIANT);
		//$$ var pig = entity.get(DataComponents.PIG_VARIANT);
		//$$ var cow = entity.get(DataComponents.COW_VARIANT);
		//$$ var chicken = entity.get(DataComponents.CHICKEN_VARIANT);
		//$$ var frog = entity.get(DataComponents.FROG_VARIANT);
		//$$ if (wolf != null) {
			//$$ var info = baby ? wolf.value().babyInfo() : wolf.value().adultInfo();
			//$$ boolean tame = entity instanceof TamableAnimal tamable && tamable.isTame();
			//$$ texture = (tame ? info.tame() : info.wild()).id().toString();
		//$$ } else if (cat != null) {
			//$$ texture = cat.value().assetInfo(baby).id().toString();
		//$$ } else if (pig != null) {
			//$$ texture = (baby ? pig.value().babyTexture() : pig.value().modelAndTexture().asset()).id().toString();
			//$$ model = pig.value().modelAndTexture().model().getSerializedName();
		//$$ } else if (cow != null) {
			//$$ texture = (baby ? cow.value().babyTexture() : cow.value().modelAndTexture().asset()).id().toString();
			//$$ model = cow.value().modelAndTexture().model().getSerializedName();
		//$$ } else if (chicken != null) {
			//$$ texture = (baby ? chicken.value().babyTexture() : chicken.value().modelAndTexture().asset()).id().toString();
			//$$ model = chicken.value().modelAndTexture().model().getSerializedName();
		//$$ } else if (frog != null) {
			//$$ texture = frog.value().assetInfo().id().toString();
		//$$ }
		//#elseif MC >= 1.21.5
		// before 26.1 there were no baby textures, and a chicken's variant may be only a name until it's looked up
		var wolf = entity.get(DataComponents.WOLF_VARIANT);
		var cat = entity.get(DataComponents.CAT_VARIANT);
		var pig = entity.get(DataComponents.PIG_VARIANT);
		var cow = entity.get(DataComponents.COW_VARIANT);
		var chicken = entity.get(DataComponents.CHICKEN_VARIANT);
		var frog = entity.get(DataComponents.FROG_VARIANT);
		if (wolf != null) {
			var info = wolf.value().assetInfo();
			boolean tame = entity instanceof TamableAnimal tamable && tamable.isTame();
			texture = (tame ? info.tame() : info.wild()).id().toString();
		} else if (cat != null) {
			texture = cat.value().assetInfo().id().toString();
		} else if (pig != null) {
			texture = pig.value().modelAndTexture().asset().id().toString();
			model = pig.value().modelAndTexture().model().getSerializedName();
		} else if (cow != null) {
			texture = cow.value().modelAndTexture().asset().id().toString();
			model = cow.value().modelAndTexture().model().getSerializedName();
		} else if (chicken != null) {
			var c = chicken.unwrap(entity.registryAccess()).orElse(null);
			if (c != null) {
				texture = c.value().modelAndTexture().asset().id().toString();
				model = c.value().modelAndTexture().model().getSerializedName();
			}
		} else if (frog != null) {
			texture = frog.value().assetInfo().id().toString();
		}
		//#else
		//$$ // before 1.21.5 mobs had no variant components: Liveview draws their default look
		//#endif
		String variant = null;
		for (DataComponentType<?> type : ENUM_VARIANTS) {
			Object value = entity.get(type);
			if (value instanceof StringRepresentable named) {
				variant = named.getSerializedName();
				break;
			}
		}
		int wool = -1;
		if (entity instanceof net.minecraft.world.entity.animal.sheep.Sheep sheep) {
			wool = sheep.isSheared() ? -2 : sheep.getColor().getTextureDiffuseColor() & 0xFFFFFF;
		}
		List<String> armor = new ArrayList<>(4);
		List<Integer> dye = new ArrayList<>(4);
		String main = "minecraft:air";
		String off = "minecraft:air";
		int foil = 0;
		int mainTint = -1;
		int offTint = -1;
		if (entity instanceof LivingEntity living) {
			for (int i = 0; i < ARMOR.length; i++) {
				EquipmentSlot slot = ARMOR[i];
				ItemStack stack = living.getItemBySlot(slot);
				if (!stack.isEmpty() && stack.hasFoil()) {
					foil |= 1 << i;
				}
				Equippable equippable = stack.isEmpty() ? null : stack.get(DataComponents.EQUIPPABLE);
				String asset = equippable == null ? "" : equippable.assetId().map(key -> key.identifier().toString()).orElse("");
				armor.add(asset);
				DyedItemColor dyed = stack.isEmpty() ? null : stack.get(DataComponents.DYED_COLOR);
				dye.add(dyed == null ? -1 : dyed.rgb() & 0xFFFFFF);
			}
			ItemStack mainStack = living.getMainHandItem();
			ItemStack offStack = living.getItemBySlot(EquipmentSlot.OFFHAND);
			main = Ids.item(mainStack);
			off = Ids.item(offStack);
			if (!mainStack.isEmpty() && mainStack.hasFoil()) {
				foil |= 16;
			}
			if (!offStack.isEmpty() && offStack.hasFoil()) {
				foil |= 32;
			}
			mainTint = tint(mainStack);
			offTint = tint(offStack);
		} else if (entity instanceof net.minecraft.world.entity.projectile.arrow.AbstractArrow arrow) {
			// Crit arrows trail crit particles; tipped arrows use arrow_tipped.png and trail their potion color
			// (AbstractArrow.isCritArrow, Arrow.getColor: VERIFIED by javap on the 26.2 merged jar; -1 is untipped).
			if (arrow.isCritArrow()) {
				foil |= Look.FOIL_CRIT;
			}
			if (arrow instanceof net.minecraft.world.entity.projectile.arrow.Arrow tipped && tipped.getColor() != -1) {
				mainTint = tipped.getColor() & 0xFFFFFF;
			}
		} else if (entity instanceof net.minecraft.world.entity.projectile.hurtingprojectile.WitherSkull skull) {
			// The blue skull uses wither_invulnerable.png (WitherSkull.isDangerous: VERIFIED by javap).
			if (skull.isDangerous()) {
				foil |= Look.FOIL_DANGEROUS;
			}
		} else if (entity instanceof net.minecraft.world.entity.projectile.ItemSupplier supplier) {
			// Thrown potions, snowballs, eggs, pearls, bottles o' enchanting, fireballs: ThrownItemRenderer draws the item.
			ItemStack stack = supplier.getItem();
			mainTint = tint(stack);
			if (!stack.isEmpty() && stack.hasFoil()) {
				foil |= 16;
			}
		} else if (entity instanceof net.minecraft.world.entity.AreaEffectCloud cloud
				&& cloud.getParticle() instanceof net.minecraft.core.particles.ColorParticleOption color) {
			mainTint = rgb(color.getRed(), color.getGreen(), color.getBlue());
		}
		return new Look(light(entity), texture, model, variant, wool, armor, dye, main, off, null, foil, mainTint, offTint, motion(entity));
	}

	private static int tint(ItemStack stack) {
		if (stack == null || stack.isEmpty()) {
			return -1;
		}
		DyedItemColor dyed = stack.get(DataComponents.DYED_COLOR);
		if (dyed != null) {
			return dyed.rgb() & 0xFFFFFF;
		}
		var potion = stack.get(DataComponents.POTION_CONTENTS);
		return potion == null ? -1 : potion.getColor() & 0xFFFFFF;
	}

	private static int rgb(float r, float g, float b) {
		return Math.round(Math.max(0, Math.min(1, r)) * 255) << 16 | Math.round(Math.max(0, Math.min(1, g)) * 255) << 8
				| Math.round(Math.max(0, Math.min(1, b)) * 255);
	}

	/**
	 * VERIFIED by javap on the 26.2 merged jar: {@code Entity.getPose/isSprinting/isPassenger},
	 * {@code LivingEntity.swinging/swingTime/swingingArm/hurtTime/isUsingItem/getTicksUsingItem/getUsedItemHand},
	 * {@code AreaEffectCloud.getRadius}.
	 */
	private static Look.Motion motion(Entity entity) {
		String pose = entity.getPose().name().toLowerCase(java.util.Locale.ROOT);
		float radius = entity instanceof net.minecraft.world.entity.AreaEffectCloud cloud ? cloud.getRadius() : 0f;
		if (!(entity instanceof LivingEntity living)) {
			return new Look.Motion(pose, false, -1, false, -1, false, 0, entity.isPassenger(), radius);
		}
		//#if MC >= 26.3
		//$$ // 26.3 keeps the swing in a private state: how far through it is (0 to 1) times how long it lasts
		//$$ LivingEntity.SwingDescription current = living.isSwinging() ? living.getCurrentSwing() : null;
		//$$ int swing = current == null ? -1 : Math.round(living.getSwingAnimation(0f) * current.durationTicks());
		//$$ boolean swingOff = current != null && current.hand() == net.minecraft.world.InteractionHand.OFF_HAND;
		//#else
		int swing = living.swinging ? Math.max(0, living.swingTime) : -1;
		boolean swingOff = living.swingingArm == net.minecraft.world.InteractionHand.OFF_HAND;
		//#endif
		int using = living.isUsingItem() ? living.getTicksUsingItem() : -1;
		boolean useOff = living.isUsingItem() && living.getUsedItemHand() == net.minecraft.world.InteractionHand.OFF_HAND;
		return new Look.Motion(pose, entity.isSprinting(), swing, swingOff, using, useOff, Math.max(0, living.hurtTime),
				entity.isPassenger(), radius);
	}

	private static int light(Entity entity) {
		BlockPos pos = entity.blockPosition();
		LevelLightEngine engine = entity.level().getLightEngine();
		int sky = engine.getLayerListener(LightLayer.SKY).getLightValue(pos);
		int block = engine.getLayerListener(LightLayer.BLOCK).getLightValue(pos);
		return (Math.max(0, Math.min(15, sky)) << 4) | Math.max(0, Math.min(15, block));
	}
}
