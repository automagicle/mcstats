package dev.mcserverstats.liveview.mc;

import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

final class Ids {
	private Ids() {
	}

	// VERIFIED by compiling against minecraft-merged-a8e9c7b123-26.2.jar: ItemStack.isEmpty/getItem/getCount, BuiltInRegistries.ITEM.getKey,
	// ResourceLocation.toString.
	static String item(ItemStack stack) {
		if (stack == null || stack.isEmpty()) {
			return "minecraft:air";
		}
		ResourceLocation id = BuiltInRegistries.ITEM.getKey(stack.getItem());
		return id == null ? "minecraft:air" : id.toString();
	}

	static int count(ItemStack stack) {
		if (stack == null || stack.isEmpty()) {
			return 0;
		}
		return stack.getCount();
	}

	static String customName(ItemStack stack) {
		if (stack == null || stack.isEmpty()) {
			return null;
		}
		// VERIFIED by javap on minecraft-merged-a8e9c7b123-26.2.jar: the deprecated ItemStack.getCustomName() is get(DataComponents.CUSTOM_NAME)
		// with a written-book-title fallback. Only a rename (the CUSTOM_NAME component) counts as a custom name here.
		// DataComponents.CUSTOM_NAME is DataComponentType<Component>; get comes from DataComponentHolder.
		Component name = stack.get(DataComponents.CUSTOM_NAME);
		if (name == null) {
			return null;
		}
		String text = name.getString();
		return text == null || text.isBlank() ? null : text;
	}

	// VERIFIED by compiling against minecraft-merged-a8e9c7b123-26.2.jar: BlockState.getBlock, BlockBehaviour.BlockStateBase.isAir,
	// BuiltInRegistries.BLOCK.getKey.
	static String block(BlockState state) {
		if (state == null || state.isAir()) {
			return "minecraft:air";
		}
		ResourceLocation id = BuiltInRegistries.BLOCK.getKey(state.getBlock());
		return id == null ? "minecraft:air" : id.toString();
	}

	static String entityType(Entity entity) {
		if (entity == null) {
			return "";
		}
		ResourceLocation id = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType());
		return id == null ? "" : id.toString();
	}

	static String dimension(net.minecraft.world.level.Level level) {
		if (level == null) {
			return "";
		}
		return level.dimension().location().toString();
	}
}
