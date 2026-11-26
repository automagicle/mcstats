package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.snapshot.ActionEvent;
import dev.mcserverstats.liveview.snapshot.BlockTouch;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Supplier;
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
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.Style;
import net.minecraft.network.chat.contents.TranslatableContents;
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
	private final Supplier<Set<UUID>> optOut;
	private final Consumer<BlockTouch> touches;
	private int tick;

	public ActionHooks(Consumer<ActionEvent> sink, Supplier<Set<UUID>> optOut, Consumer<BlockTouch> touches) {
		this.sink = sink;
		this.optOut = optOut;
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
				if (message == null || overlay || mentionsHidden(server, message)) {
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
				if (entity instanceof Player target && hidden(target.getUUID())) {
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
				if (hidden(uuid)) {
					return InteractionResult.PASS;
				}
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
				if (hidden(pending.actor)) {
					continue;
				}
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
		if (sender == null || hidden(sender.getUUID())) {
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
		if (actor != null && hidden(actor)) {
			return;
		}
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
		if (player == null || hidden(player.getUUID())) {
			return;
		}
		emit(kind, player.getUUID(), Ids.dimension(level), x, y, z, target, message);
	}

	private void emit(String kind, UUID actor, String dimension, Integer x, Integer y, Integer z, String target, String message) {
		if (actor != null && hidden(actor)) {
			return;
		}
		try {
			sink.accept(ActionEvent.of(kind, actor, dimension, x, y, z, target, message));
		} catch (Throwable thrown) {
			LogOnce.warn("hook-emit", "Liveview failed to enqueue an action", thrown);
		}
	}

	// Terrain is not private, so touches are recorded for opted-out players too; only the section is re-copied.
	private void touch(Level level, BlockPos pos) {
		try {
			touches.accept(new BlockTouch(Ids.dimension(level), pos.getX(), pos.getY(), pos.getZ()));
		} catch (Throwable thrown) {
			LogOnce.warn("hook-touch", "Liveview failed to mark a changed block", thrown);
		}
	}

	/**
	 * GAME_MESSAGE carries vanilla's join, leave, death and advancement broadcasts with no actor, so the opt-out check
	 * in {@link #emit} never sees who they are about. A player's name inside them is {@code Player.getDisplayName()},
	 * whose style holds a {@code HoverEvent.ShowEntity} with the player's UUID and an insertion of their name (VERIFIED
	 * from {@code Player.getDisplayName}, {@code decorateDisplayNameComponent} and {@code Entity.createHoverEvent}
	 * bytecode). The join line is broadcast before the player is added to the player list ({@code PlayerList.placeNewPlayer}
	 * bytecode), so the UUID is the primary check. Names of online opted-out players are a fallback for plugin or command
	 * text that uses a bare name. When unsure, the line is dropped.
	 */
	private boolean mentionsHidden(MinecraftServer server, Component message) {
		Set<UUID> hidden = optOut.get();
		if (hidden == null || hidden.isEmpty()) {
			return false;
		}
		Set<String> names = new HashSet<>();
		try {
			for (ServerPlayer player : server.getPlayerList().getPlayers()) {
				if (hidden.contains(player.getUUID())) {
					String name = player.getPlainTextName();
					if (name != null && !name.isBlank()) {
						names.add(name);
					}
				}
			}
		} catch (Throwable thrown) {
			LogOnce.warn("hidden-names", "Liveview could not read player names for a system message", thrown);
		}
		int[] budget = {512};
		if (refersToHidden(message, hidden, names, 0, budget)) {
			return true;
		}
		if (budget[0] <= 0) {
			return true;
		}
		String text = message.getString();
		for (String name : names) {
			if (containsWord(text, name)) {
				return true;
			}
		}
		return false;
	}

	private static boolean refersToHidden(Component component, Set<UUID> hidden, Set<String> names, int depth, int[] budget) {
		if (component == null) {
			return false;
		}
		if (depth > 16 || --budget[0] <= 0) {
			return false;
		}
		Style style = component.getStyle();
		if (style != null) {
			if (style.getHoverEvent() instanceof HoverEvent.ShowEntity show
					&& show.entity() != null
					&& show.entity().uuid != null
					&& hidden.contains(show.entity().uuid)) {
				return true;
			}
			String insertion = style.getInsertion();
			if (insertion != null && names.contains(insertion)) {
				return true;
			}
		}
		if (component.getContents() instanceof TranslatableContents translatable) {
			for (Object arg : translatable.getArgs()) {
				if (arg instanceof Component inner && refersToHidden(inner, hidden, names, depth + 1, budget)) {
					return true;
				}
			}
		}
		for (Component sibling : component.getSiblings()) {
			if (refersToHidden(sibling, hidden, names, depth + 1, budget)) {
				return true;
			}
		}
		return false;
	}

	// Player names are [A-Za-z0-9_], so a word boundary is any other character.
	private static boolean containsWord(String text, String word) {
		int from = 0;
		while (true) {
			int at = text.indexOf(word, from);
			if (at < 0) {
				return false;
			}
			int end = at + word.length();
			if ((at == 0 || !nameChar(text.charAt(at - 1))) && (end == text.length() || !nameChar(text.charAt(end)))) {
				return true;
			}
			from = at + 1;
		}
	}

	private static boolean nameChar(char c) {
		return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
	}

	private boolean hidden(UUID uuid) {
		Set<UUID> hidden = optOut.get();
		return uuid != null && hidden != null && hidden.contains(uuid);
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
