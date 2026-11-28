package dev.mcserverstats.paper;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.destroystokyo.paper.event.block.BlockDestroyEvent;
import com.destroystokyo.paper.event.server.ServerTickEndEvent;
import dev.mcserverstats.chatlog.ChatLogMod;
import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.mc.ActionHooks;
import dev.mcserverstats.liveview.mc.ParticleTap;
import io.papermc.paper.adventure.PaperAdventure;
import io.papermc.paper.event.player.AsyncChatEvent;
import io.papermc.paper.event.player.PrePlayerAttackEntityEvent;
import io.papermc.paper.event.server.ServerResourcesReloadedEvent;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import org.bukkit.ExplosionResult;
import org.bukkit.GameRule;
import org.bukkit.block.BlockFace;
import org.bukkit.command.BlockCommandSender;
import org.bukkit.command.CommandSender;
import org.bukkit.craftbukkit.CraftWorld;
import org.bukkit.craftbukkit.block.CraftBlock;
import org.bukkit.craftbukkit.block.data.CraftBlockData;
import org.bukkit.craftbukkit.damage.CraftDamageSource;
import org.bukkit.craftbukkit.entity.CraftEntity;
import org.bukkit.craftbukkit.entity.CraftPlayer;
import org.bukkit.entity.Egg;
import org.bukkit.entity.Player;
import org.bukkit.entity.Snowball;
import org.bukkit.entity.ThrownPotion;
import org.bukkit.event.Event;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.entity.ExplosionPrimeEvent;
import org.bukkit.event.entity.LingeringPotionSplashEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.entity.PotionSplashEvent;
import org.bukkit.event.entity.ProjectileHitEvent;
import org.bukkit.event.player.PlayerAdvancementDoneEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.server.ServerCommandEvent;
import org.bukkit.inventory.EquipmentSlot;
import org.bukkit.potion.PotionEffect;

// Bukkit's events, passed to the shared code the way FabricEntry passes Fabric API's: the chat log (ChatLogMod)
// and Liveview's action feed (ActionHooks). Each listens at MONITOR, after other plugins have had their say, and
// skips what they cancelled, except where a comment says otherwise. Messages are taken as Paper finally shows
// them (a plugin's own join message, say) and turned into the game's components (PaperAdventure.asVanilla),
// which keep the names, colors and hover text the chat log reads.
final class PaperEvents implements Listener {
	// /say and /me as typed (the game's namespace optional), which the game logs as chat on Fabric
	private static final Pattern SAY = Pattern.compile("(?is)/?(?:minecraft:)?(say|me)\\s+(\\S.*)");

	private final PaperPlugin plugin;
	private final ChatLogMod mod;
	private final ActionHooks actions;
	private final NetworkTap tap;
	private final MinecraftServer server = MinecraftServer.getServer();

	PaperEvents(PaperPlugin plugin, ChatLogMod mod, NetworkTap tap) {
		this.plugin = plugin;
		this.mod = mod;
		this.actions = mod.liveview().actions();
		this.tap = tap;
	}

	void started() {
		poofs.clear();
		primed.clear();
	}

	private static ServerPlayer handle(Player p) {
		return ((CraftPlayer) p).getHandle();
	}

	private static Component vanilla(net.kyori.adventure.text.Component c) {
		return c == null ? null : PaperAdventure.asVanilla(c);
	}

	private static String plain(net.kyori.adventure.text.Component c) {
		return PlainTextComponentSerializer.plainText().serialize(c);
	}

	/* ---------- the server ---------- */

	@EventHandler(priority = EventPriority.MONITOR)
	public void tick(ServerTickEndEvent e) {
		if (!plugin.isStarted()) return;
		try {
			boolean watched = mod.liveview().watched();
			tap.watching(watched);
			tick = e.getTickNumber();
			if (watched) poofs();
			else poofs.clear();
			tap.endTick(server);
		} catch (Throwable thrown) {
			LogOnce.warn("paper-tick", "mcstats failed a Paper tick check", thrown);
		}
		mod.tick(server);
	}

	@EventHandler(priority = EventPriority.MONITOR)
	public void reloaded(ServerResourcesReloadedEvent e) {
		if (!plugin.isStarted()) return;
		mod.dataPacksReloaded(server);
		plugin.whisperSuggestions(server);
	}

	/* ---------- players coming and going, dying, and advancing ---------- */

	@EventHandler(priority = EventPriority.MONITOR)
	public void join(PlayerJoinEvent e) {
		ServerPlayer p = handle(e.getPlayer());
		tap.attach(p);
		actions.joined(p);
		announce(e.joinMessage(), "join", p);
		mod.joined(p);
	}

	@EventHandler(priority = EventPriority.MONITOR)
	public void quit(PlayerQuitEvent e) {
		ServerPlayer p = handle(e.getPlayer());
		actions.left(p);
		announce(e.quitMessage(), "leave", p);
	}

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void death(PlayerDeathEvent e) {
		ServerPlayer p = handle(e.getPlayer());
		try {
			if (e.getDamageSource() instanceof CraftDamageSource source) actions.died(p, source.getHandle());
		} catch (Throwable thrown) {
			LogOnce.warn("paper-death", "Liveview could not read a death", thrown);
		}
		// the game only says a death to everyone with showDeathMessages on
		Boolean shown = e.getPlayer().getWorld().getGameRuleValue(GameRule.SHOW_DEATH_MESSAGES);
		if (shown == null || shown) announce(e.deathMessage(), "death", p);
	}

	@EventHandler(priority = EventPriority.MONITOR)
	public void advancement(PlayerAdvancementDoneEvent e) {
		announce(e.message(), "advancement", handle(e.getPlayer()));
	}

	// A join, leave, death or advancement as Paper says it to everyone (null or empty: a plugin hid it).
	private void announce(net.kyori.adventure.text.Component message, String kind, ServerPlayer about) {
		if (message == null || !plugin.isStarted()) return;
		try {
			Component m = vanilla(message);
			if (m.getString().isBlank()) return;
			actions.gameMessage(m, false);
			mod.announced(server, m, kind, about);
		} catch (RuntimeException ex) {
			ChatLogMod.LOG.error("Couldn't log a {} message", kind, ex);
		}
	}

	/* ---------- chat, /say and /me, and whispers to the website ---------- */

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void chat(AsyncChatEvent e) {
		String text = plain(e.message());
		Player sender = e.getPlayer();
		Runnable log = () -> {
			if (!plugin.isStarted() || !sender.isOnline()) return;
			ServerPlayer p = handle(sender);
			Component name = p.getDisplayName();
			actions.chatLine(p, text, Component.translatable("chat.type.text", name, Component.literal(text)));
			mod.chat(p, name, text);
		};
		// chat arrives on its own thread; everything else here runs on the server's
		if (e.isAsynchronous()) server.execute(log);
		else log.run();
	}

	// Before other plugins see it (Essentials' /msg, say): a whisper to someone who's only on the website goes to
	// them there, as CommandsMixin does on Fabric. Everything else goes on as usual.
	@EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
	public void whisper(PlayerCommandPreprocessEvent e) {
		try {
			ServerPlayer p = handle(e.getPlayer());
			if (ChatLogMod.whisperToWeb(p.createCommandSourceStack(), e.getMessage())) e.setCancelled(true);
		} catch (RuntimeException ex) {
			ChatLogMod.LOG.error("Couldn't check a whisper for the website", ex);
		}
	}

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void playerCommand(PlayerCommandPreprocessEvent e) {
		say(e.getPlayer(), e.getMessage());
	}

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void serverCommand(ServerCommandEvent e) {
		say(e.getSender(), e.getCommand());
	}

	// /say and /me, from a player, the console or a command block, if they may run it.
	private void say(CommandSender sender, String command) {
		if (!plugin.isStarted()) return;
		Matcher m = SAY.matcher(command.strip());
		if (!m.matches()) return;
		String kind = m.group(1).equalsIgnoreCase("me") ? "emote" : "say";
		if (!sender.hasPermission(kind.equals("emote") ? "minecraft.command.me" : "minecraft.command.say")) return;
		String text = m.group(2).strip();
		try {
			if (sender instanceof Player player) {
				ServerPlayer p = handle(player);
				Component name = p.getDisplayName();
				actions.chatLine(p, text, Component.translatable(kind.equals("emote") ? "chat.type.emote" : "chat.type.announcement", name, Component.literal(text)));
				mod.sayCommand(kind, p, p.getScoreboardName(), name, text);
			} else {
				String who = sender instanceof BlockCommandSender ? sender.getName() : "Server";
				mod.sayCommand(kind, null, who, Component.literal(who), text);
			}
		} catch (RuntimeException ex) {
			ChatLogMod.LOG.error("Couldn't log a /{}", m.group(1), ex);
		}
	}

	/* ---------- Liveview's action feed ---------- */

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void blockBreak(BlockBreakEvent e) {
		CraftBlock block = (CraftBlock) e.getBlock();
		ServerLevel level = ((CraftWorld) block.getWorld()).getHandle();
		BlockPos pos = block.getPosition();
		BlockState state = level.getBlockState(pos);
		actions.blockBroken(level, handle(e.getPlayer()), pos, state);
		// the block-break effect the game shows (levelEvent 2001 on Fabric)
		ParticleTap.onLevelEvent(level, 2001, pos, Block.getId(state));
	}

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void attack(PrePlayerAttackEntityEvent e) {
		if (!e.willAttack()) return;
		ServerPlayer p = handle(e.getPlayer());
		actions.attacked(p, p.level(), ((CraftEntity) e.getAttacked()).getHandle());
	}

	// Paper marks a right-click in the air as cancelled from the start (there's no block to use), so this one
	// listens to cancelled events too and reads what will actually happen.
	@EventHandler(priority = EventPriority.MONITOR)
	public void interact(PlayerInteractEvent e) {
		ServerPlayer p = handle(e.getPlayer());
		InteractionHand hand = e.getHand() == EquipmentSlot.OFF_HAND ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND;
		if (e.getAction() == Action.RIGHT_CLICK_AIR && e.useItemInHand() != Event.Result.DENY) {
			actions.usedItem(p, p.level(), hand);
		} else if (e.getAction() == Action.RIGHT_CLICK_BLOCK && e.getClickedBlock() != null && e.useInteractedBlock() != Event.Result.DENY) {
			BlockPos pos = ((CraftBlock) e.getClickedBlock()).getPosition();
			Direction face = direction(e.getBlockFace());
			actions.usedBlock(p, p.level(), new BlockHitResult(Vec3.atCenterOf(pos), face, pos, false));
		}
	}

	private static Direction direction(BlockFace face) {
		return switch (face) {
			case DOWN -> Direction.DOWN;
			case NORTH -> Direction.NORTH;
			case SOUTH -> Direction.SOUTH;
			case WEST -> Direction.WEST;
			case EAST -> Direction.EAST;
			default -> Direction.UP;
		};
	}

	/* ---------- Liveview's effects (ServerLevelMixin on Fabric) ---------- */

	// A block the game destroys itself (water washing a torch away, a falling block landing on one, …).
	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void blockDestroy(BlockDestroyEvent e) {
		if (!e.playEffect()) return;
		CraftBlock block = (CraftBlock) e.getBlock();
		ParticleTap.onLevelEvent(((CraftWorld) block.getWorld()).getHandle(), 2001, block.getPosition(),
				Block.getId(((CraftBlockData) e.getEffectBlock()).getState()));
	}

	// How big each explosion is, from just before it goes off (the explode events don't say).
	private final Map<UUID, Float> primed = new HashMap<>();

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void primed(ExplosionPrimeEvent e) {
		if (primed.size() > 256) primed.clear();
		primed.put(e.getEntity().getUniqueId(), e.getRadius());
	}

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void entityExplode(EntityExplodeEvent e) {
		Float power = primed.remove(e.getEntity().getUniqueId());
		explosion(e.getLocation(), power == null ? 3f : power, e.getExplosionResult());
	}

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void blockExplode(BlockExplodeEvent e) {
		// beds and respawn anchors in the wrong dimension, both power 5
		explosion(e.getBlock().getLocation().add(0.5, 0.5, 0.5), 5f, e.getExplosionResult());
	}

	private static void explosion(org.bukkit.Location at, float power, ExplosionResult result) {
		ParticleTap.onExplosion(((CraftWorld) at.getWorld()).getHandle(), at.getX(), at.getY(), at.getZ(), power, result != ExplosionResult.KEEP);
	}

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void projectileHit(ProjectileHitEvent e) {
		// a snowball or egg breaking into bits (entity event 3 on Fabric)
		if (!(e.getEntity() instanceof Snowball) && !(e.getEntity() instanceof Egg)) return;
		net.minecraft.world.entity.Entity entity = ((CraftEntity) e.getEntity()).getHandle();
		if (entity.level() instanceof ServerLevel level) ParticleTap.onEntityEvent(level, entity, (byte) 3);
	}

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void splash(PotionSplashEvent e) {
		potion(e.getPotion());
	}

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void lingering(LingeringPotionSplashEvent e) {
		potion(e.getEntity());
	}

	// The bottle breaking and its burst of color (levelEvent 2002, or 2007 for an instant potion, on Fabric).
	private static void potion(ThrownPotion potion) {
		try {
			boolean instant = false;
			for (PotionEffect effect : potion.getEffects()) instant |= effect.getType().isInstant();
			org.bukkit.Color color = potion.getPotionMeta().computeEffectiveColor();
			net.minecraft.world.entity.Entity entity = ((CraftEntity) potion).getHandle();
			if (entity.level() instanceof ServerLevel level) {
				ParticleTap.onLevelEvent(level, instant ? 2007 : 2002, entity.blockPosition(), color == null ? 0x385DC6 : color.asRGB());
			}
		} catch (RuntimeException ex) {
			LogOnce.warn("paper-potion", "Liveview could not read a splash potion", ex);
		}
	}

	// A mob's death poof comes 20 ticks after it dies, as its body vanishes (entity event 60 on Fabric).
	private record Poof(net.minecraft.world.entity.Entity entity, int at) {
	}

	private final List<Poof> poofs = new ArrayList<>();
	private int tick;

	@EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
	public void entityDeath(EntityDeathEvent e) {
		if (e.getEntity() instanceof Player || !mod.liveview().watched() || poofs.size() > 256) return;
		poofs.add(new Poof(((CraftEntity) e.getEntity()).getHandle(), tick + 20));
	}

	private void poofs() {
		int now = tick;
		for (Iterator<Poof> it = poofs.iterator(); it.hasNext(); ) {
			Poof p = it.next();
			if (p.at() > now && !p.entity().isRemoved()) continue;
			it.remove();
			if (p.entity().level() instanceof ServerLevel level) ParticleTap.onEntityEvent(level, p.entity(), (byte) 60);
		}
	}
}
