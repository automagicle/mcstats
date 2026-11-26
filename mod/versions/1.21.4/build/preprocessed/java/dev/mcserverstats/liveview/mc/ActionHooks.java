package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.ActionEvent;
import dev.mcserverstats.liveview.snapshot.BlockTouch;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.entity.event.v1.ServerPlayerEvents;
import net.fabricmc.fabric.api.event.player.AttackEntityCallback;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.fabricmc.fabric.api.event.player.UseItemCallback;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.PlayerChatMessage;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;

public final class ActionHooks {
	private static final int PLACE_CHECK_TICKS = 1;

	private final List<PendingPlace> pendingPlaces = new ArrayList<>();
	private final Consumer<ActionEvent> sink;
	private final Consumer<BlockTouch> touches;
	private int tick;

	public ActionHooks(Consumer<ActionEvent> sink, Consumer<BlockTouch> touches) {
		this.sink = sink;
		this.touches = touches;
	}

	public void register() {
		PlayerBlockBreakEvents.AFTER.register((level, player, pos, state, blockEntity) -> {
			try {
				if (level.isClientSide()) {
					return;
				}
				touch(level, pos);
				emit(
						"block_break",
						player,
						level,
						pos.getX(),
						pos.getY(),
						pos.getZ(),
						Ids.block(state),
						"");
			} catch (Throwable thrown) {
				LogOnce.warn("hook-block-break", "Liveview block_break hook failed", thrown);
			}
		});
		ServerLivingEntityEvents.AFTER_DEATH.register((entity, source) -> {
			try {
				if (!(entity instanceof ServerPlayer player)) {
					return;
				}
				String message = "";
				try {
					Component text = source.getLocalizedDeathMessage(entity);
					message = text == null ? "" : text.getString();
				} catch (Throwable thrown) {
					LogOnce.warn("death-message", "Liveview could not read a death message", thrown);
				}
				emit(
						"death",
						player.getUUID(),
						Ids.dimension(player.level()),
						player.getBlockX(),
						player.getBlockY(),
						player.getBlockZ(),
						Ids.entityType(source.getEntity()),
						message);
			} catch (Throwable thrown) {
				LogOnce.warn("hook-death", "Liveview death hook failed", thrown);
			}
		});
		ServerPlayerEvents.JOIN.register(player -> {
			try {
				emit("join", player, player.level(), player.getBlockX(), player.getBlockY(), player.getBlockZ(), "", "");
			} catch (Throwable thrown) {
				LogOnce.warn("hook-join", "Liveview join hook failed", thrown);
			}
		});
		ServerPlayerEvents.LEAVE.register(player -> {
			try {
				emit("leave", player, player.level(), player.getBlockX(), player.getBlockY(), player.getBlockZ(), "", "");
			} catch (Throwable thrown) {
				LogOnce.warn("hook-leave", "Liveview leave hook failed", thrown);
			}
		});
		ServerMessageEvents.GAME_MESSAGE.register((server, message, overlay) -> {
			try {
				// overlay messages are the action bar above the hotbar, not chat
				if (message == null || overlay) {
					return;
				}
				emitLine("system_message", null, "", null, null, null, "", message.getString(), message);
			} catch (Throwable thrown) {
				LogOnce.warn("hook-system", "Liveview system_message hook failed", thrown);
			}
		});
		ServerMessageEvents.CHAT_MESSAGE.register((message, sender, params) -> {
			try {
				emitChat(message, sender, params);
			} catch (Throwable thrown) {
				LogOnce.warn("hook-chat", "Liveview chat hook failed", thrown);
			}
		});
		ServerMessageEvents.COMMAND_MESSAGE.register((message, source, params) -> {
			try {
				ServerPlayer sender = source.getPlayer();
				if (sender == null) {
					return;
				}
				emitChat(message, sender, params);
			} catch (Throwable thrown) {
				LogOnce.warn("hook-command-chat", "Liveview command chat hook failed", thrown);
			}
		});
		AttackEntityCallback.EVENT.register((player, level, hand, entity, hit) -> {
			try {
				if (level.isClientSide()) {
					return InteractionResult.PASS;
				}
				emit(
						"attack",
						player,
						level,
						entity.getBlockX(),
						entity.getBlockY(),
						entity.getBlockZ(),
						Ids.entityType(entity),
						"");
			} catch (Throwable thrown) {
				LogOnce.warn("hook-attack", "Liveview attack hook failed", thrown);
			}
			return InteractionResult.PASS;
		});
		UseItemCallback.EVENT.register((player, level, hand) -> {
			try {
				if (level.isClientSide()) {
					return InteractionResult.PASS;
				}
				emit(
						"item_use",
						player,
						level,
						player.getBlockX(),
						player.getBlockY(),
						player.getBlockZ(),
						Ids.item(player.getItemInHand(hand)),
						"");
			} catch (Throwable thrown) {
				LogOnce.warn("hook-item-use", "Liveview item_use hook failed", thrown);
			}
			return InteractionResult.PASS;
		});
		UseBlockCallback.EVENT.register((player, level, hand, hit) -> {
			try {
				if (level.isClientSide() || hit == null) {
					return InteractionResult.PASS;
				}
				touch(level, hit.getBlockPos());
				if (hit.getDirection() != null) {
					touch(level, hit.getBlockPos().relative(hit.getDirection()));
				}
				UUID uuid = player.getUUID();
				BlockPos pos = hit.getBlockPos();
				Direction face = hit.getDirection();
				String dimension = Ids.dimension(level);
				remember(uuid, dimension, pos, level.getBlockState(pos));
				if (face != null) {
					BlockPos next = pos.relative(face);
					remember(uuid, dimension, next, level.getBlockState(next));
				}
			} catch (Throwable thrown) {
				LogOnce.warn("hook-use-block", "Liveview use-block hook failed", thrown);
			}
			return InteractionResult.PASS;
		});
	}

	/** Server thread only. Drops pending place checks from before (a server start, or a stretch with nobody watching). */
	public void reset() {
		pendingPlaces.clear();
		tick = 0;
	}

	public void onEndTick(MinecraftServer server) {
		tick++;
		if (pendingPlaces.isEmpty()) {
			return;
		}
		Iterator<PendingPlace> iterator = pendingPlaces.iterator();
		while (iterator.hasNext()) {
			PendingPlace pending = iterator.next();
			if (pending.checkAt > tick) {
				continue;
			}
			iterator.remove();
			try {
				ServerLevel level = level(server, pending.dimension);
				if (level == null) {
					continue;
				}
				BlockState state = level.getBlockState(pending.pos);
				String now = Ids.block(state);
				if (now.equals(pending.was) || "minecraft:air".equals(now)) {
					continue;
				}
				emit(
						"block_place",
						pending.actor,
						pending.dimension,
						pending.pos.getX(),
						pending.pos.getY(),
						pending.pos.getZ(),
						now,
						"");
			} catch (Throwable thrown) {
				LogOnce.warn("hook-block-place", "Liveview block_place check failed", thrown);
			}
		}
	}

	private void remember(UUID actor, String dimension, BlockPos pos, BlockState state) {
		pendingPlaces.add(new PendingPlace(actor, dimension, pos.immutable(), Ids.block(state), tick + PLACE_CHECK_TICKS));
		if (pendingPlaces.size() > 256) {
			pendingPlaces.remove(0);
		}
	}

	private void emitChat(PlayerChatMessage message, ServerPlayer sender, net.minecraft.network.chat.ChatType.Bound params) {
		if (sender == null) {
			return;
		}
		String text = "";
		if (message != null) {
			Component decorated = message.decoratedContent();
			text = decorated == null ? "" : decorated.getString();
			if (text.isBlank()) {
				String signed = message.signedContent();
				text = signed == null ? "" : signed;
			}
		}
		// the whole line as players see it: "<Name> text", "[Name] text" for /say, "* Name text" for /me, team colors
		Component shown = null;
		try {
			if (message != null && params != null) {
				shown = params.decorate(message.decoratedContent());
			}
		} catch (Throwable thrown) {
			LogOnce.warn("chat-decorate", "Liveview could not build a chat line as the game shows it", thrown);
		}
		emitLine("chat", sender.getUUID(), Ids.dimension(sender.level()), sender.getBlockX(), sender.getBlockY(), sender.getBlockZ(), "", text, shown);
	}

	/** Like emit, with the line as the chat shows it (colors and all) for the page's chat. */
	private void emitLine(String kind, UUID actor, String dimension, Integer x, Integer y, Integer z, String target, String message, Component shown) {
		try {
			ActionEvent event = ActionEvent.of(kind, actor, dimension, x, y, z, target, message);
			if (shown != null) {
				event = event.withLine(Stacks.line(shown));
			}
			sink.accept(event);
		} catch (Throwable thrown) {
			LogOnce.warn("hook-emit", "Liveview failed to enqueue an action", thrown);
		}
	}

	private void emit(String kind, Player player, Level level, int x, int y, int z, String target, String message) {
		if (player == null) {
			return;
		}
		emit(kind, player.getUUID(), Ids.dimension(level), x, y, z, target, message);
	}

	private void emit(String kind, UUID actor, String dimension, Integer x, Integer y, Integer z, String target, String message) {
		try {
			sink.accept(ActionEvent.of(kind, actor, dimension, x, y, z, target, message));
		} catch (Throwable thrown) {
			LogOnce.warn("hook-emit", "Liveview failed to enqueue an action", thrown);
		}
	}

	private void touch(Level level, BlockPos pos) {
		try {
			touches.accept(new BlockTouch(Ids.dimension(level), pos.getX(), pos.getY(), pos.getZ()));
		} catch (Throwable thrown) {
			LogOnce.warn("hook-touch", "Liveview failed to mark a changed block", thrown);
		}
	}

	private static ServerLevel level(MinecraftServer server, String dimension) {
		for (ServerLevel level : server.getAllLevels()) {
			if (dimension.equals(Ids.dimension(level))) {
				return level;
			}
		}
		return null;
	}

	private record PendingPlace(UUID actor, String dimension, BlockPos pos, String was, int checkAt) {
	}
}
