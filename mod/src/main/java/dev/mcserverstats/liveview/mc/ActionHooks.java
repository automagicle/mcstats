package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.ActionEvent;
import dev.mcserverstats.liveview.snapshot.BlockTouch;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.PlayerChatMessage;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.BlockHitResult;
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

	// One method per event Liveview's feed is built from. The platform calls each on the server thread:
	// Fabric from Fabric API's events (FabricEntry), Paper from Bukkit's (PaperEvents).

	/** A player broke a block (after it's gone). */
	public void blockBroken(Level level, Player player, BlockPos pos, BlockState state) {
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
	}

	/** Something died; only players are reported. */
	public void died(LivingEntity entity, DamageSource source) {
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
	}

	public void joined(ServerPlayer player) {
		try {
			emit("join", player, player.level(), player.getBlockX(), player.getBlockY(), player.getBlockZ(), "", "");
		} catch (Throwable thrown) {
			LogOnce.warn("hook-join", "Liveview join hook failed", thrown);
		}
	}

	public void left(ServerPlayer player) {
		try {
			emit("leave", player, player.level(), player.getBlockX(), player.getBlockY(), player.getBlockZ(), "", "");
		} catch (Throwable thrown) {
			LogOnce.warn("hook-leave", "Liveview leave hook failed", thrown);
		}
	}

	/** A system message broadcast to everyone. */
	public void gameMessage(Component message, boolean overlay) {
		try {
			// overlay messages are the action bar above the hotbar, not chat
			if (message == null || overlay) {
				return;
			}
			emitLine("system_message", null, "", null, null, null, "", message.getString(), message);
		} catch (Throwable thrown) {
			LogOnce.warn("hook-system", "Liveview system_message hook failed", thrown);
		}
	}

	/** A chat message (Fabric: with the game's own message and chat type). */
	public void chat(PlayerChatMessage message, ServerPlayer sender, net.minecraft.network.chat.ChatType.Bound params) {
		try {
			emitChat(message, sender, params);
		} catch (Throwable thrown) {
			LogOnce.warn("hook-chat", "Liveview chat hook failed", thrown);
		}
	}

	/** /say or /me (Fabric); only a player's are reported. */
	public void commandMessage(PlayerChatMessage message, ServerPlayer sender, net.minecraft.network.chat.ChatType.Bound params) {
		try {
			if (sender == null) {
				return;
			}
			emitChat(message, sender, params);
		} catch (Throwable thrown) {
			LogOnce.warn("hook-command-chat", "Liveview command chat hook failed", thrown);
		}
	}

	/** A player's chat, /say or /me, as its text and the whole line as players see it (Paper). */
	public void chatLine(ServerPlayer sender, String text, Component shown) {
		try {
			if (sender == null) {
				return;
			}
			emitLine("chat", sender.getUUID(), Ids.dimension(sender.level()), sender.getBlockX(), sender.getBlockY(), sender.getBlockZ(), "",
					text == null ? "" : text, shown);
		} catch (Throwable thrown) {
			LogOnce.warn("hook-chat", "Liveview chat hook failed", thrown);
		}
	}

	/** A player swung at an entity. */
	public void attacked(Player player, Level level, Entity entity) {
		try {
			if (level.isClientSide()) {
				return;
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
	}

	/** A player used the item in a hand (right-click, not on a block). */
	public void usedItem(Player player, Level level, InteractionHand hand) {
		try {
			if (level.isClientSide()) {
				return;
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
	}

	/** A player right-clicked a block: checked a tick later for a block placed there or next to it. */
	public void usedBlock(Player player, Level level, BlockHitResult hit) {
		try {
			if (level.isClientSide() || hit == null) {
				return;
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
