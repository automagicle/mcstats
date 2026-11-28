package dev.mcserverstats.paper;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;

import dev.mcserverstats.chatlog.ChatLogMod;
import dev.mcserverstats.liveview.mc.ParticleTap;
import io.netty.channel.Channel;
import io.netty.channel.ChannelDuplexHandler;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelPromise;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.BundlePacket;
import net.minecraft.network.protocol.game.ClientboundLevelParticlesPacket;
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

// Watches what the server sends each player, for the two things the Fabric mod's mixins catch inside the game
// and Paper has no event for. It only reads what goes by; nothing is changed, held up or dropped.
//
//  - System messages sent to every player one by one (ServerPlayerMixin on Fabric). Plugins announce things that
//    way (Bukkit.broadcast sends each player the message), so the chat log never saw them. A message every player
//    on got, at least two of them, within a moment, is logged as a server message, as on Fabric. What this mod sent
//    itself, and what's logged already (joins, deaths, …, chat), is skipped (ChatLogMod.recentlySeen). Unlike on
//    Fabric, with only one player on nothing is logged this way: on the network there's no telling a message to
//    everyone from an answer to something that player did.
//  - Particles (ServerLevelMixin's sendParticles on Fabric), for Liveview, while someone watches. Only the ones sent
//    to a player can be seen here, so a camera far from every player shows none of these; explosions, block breaks,
//    death poofs and splashes come from Bukkit's events instead (PaperEvents) and show anywhere.
//
// Packets are written on Netty's threads, so what's seen goes in a queue that the server thread empties at the end
// of each tick (endTick).
final class NetworkTap {
	private static final String HANDLER = "mcstats_tap";
	// A message counts as sent to everyone if it reached them all within this long.
	private static final long GROUP_NANOS = 150_000_000L;

	private final ChatLogMod mod;
	private final ConcurrentLinkedQueue<Seen> messages = new ConcurrentLinkedQueue<>();
	private final ConcurrentLinkedQueue<SeenParticles> particles = new ConcurrentLinkedQueue<>();
	private final Map<String, Group> groups = new LinkedHashMap<>();
	// One broadcast is one packet sent to each player near it; this keeps it to one copy.
	private final Set<ClientboundLevelParticlesPacket> particlesSeen = Collections.newSetFromMap(new IdentityHashMap<>());
	private volatile boolean watching;

	private record Seen(UUID player, Component message, long at) {
	}

	private record SeenParticles(ServerLevel level, ClientboundLevelParticlesPacket packet) {
	}

	private static final class Group {
		final Component message;
		final Set<UUID> to = new HashSet<>();
		final long first;

		Group(Component message, long first) {
			this.message = message;
			this.first = first;
		}
	}

	NetworkTap(ChatLogMod mod) {
		this.mod = mod;
	}

	/** Server thread: starts watching a player's connection (on join, and for everyone on at start). */
	void attach(ServerPlayer player) {
		try {
			Channel channel = player.connection.connection.channel;
			if (channel == null) return;
			channel.eventLoop().execute(() -> {
				try {
					if (channel.pipeline().get(HANDLER) == null && channel.pipeline().get("packet_handler") != null) {
						channel.pipeline().addBefore("packet_handler", HANDLER, new Handler(player));
					}
				} catch (RuntimeException e) {
					ChatLogMod.LOG.debug("Couldn't watch what a player is sent", e);
				}
			});
		} catch (RuntimeException e) {
			ChatLogMod.LOG.debug("Couldn't watch what a player is sent", e);
		}
	}

	/** Server thread: stops watching everyone (the plugin is turning off). */
	void detachAll() {
		for (ServerPlayer player : MinecraftServer.getServer().getPlayerList().getPlayers()) {
			try {
				Channel channel = player.connection.connection.channel;
				if (channel != null && channel.pipeline().get(HANDLER) != null) channel.pipeline().remove(HANDLER);
			} catch (RuntimeException e) {
				ChatLogMod.LOG.debug("Couldn't stop watching what a player is sent", e);
			}
		}
		messages.clear();
		particles.clear();
	}

	/** Server thread, every tick before Liveview's: whether someone is watching, so particles are worth copying. */
	void watching(boolean now) {
		watching = now;
		if (!now) particles.clear();
	}

	/** Server thread, at the end of each tick, before Liveview's tick sends what it has. */
	void endTick(MinecraftServer server) {
		particlesSeen.clear();
		for (SeenParticles p; (p = particles.poll()) != null; ) {
			if (!particlesSeen.add(p.packet())) continue;
			ClientboundLevelParticlesPacket packet = p.packet();
			//#if MC >= 26.3
			ParticleTap.onParticles(p.level(), packet.particle(), packet.x(), packet.y(), packet.z(), packet.count(),
					packet.xDist(), packet.yDist(), packet.zDist(), packet.xMaxSpeed());
			//#else
			//$$ ParticleTap.onParticles(p.level(), packet.getParticle(), packet.getX(), packet.getY(), packet.getZ(), packet.getCount(),
			//$$ 		packet.getXDist(), packet.getYDist(), packet.getZDist(), packet.getMaxSpeed());
			//#endif
		}
		particlesSeen.clear();

		for (Seen s; (s = messages.poll()) != null; ) {
			String text = s.message().getString();
			if (text.isBlank() || text.length() > 1000 || ChatLogMod.recentlySeen(text)) continue;
			Group g = groups.get(text);
			if (g == null) {
				if (groups.size() >= 200) continue;
				g = new Group(s.message(), s.at());
				groups.put(text, g);
			}
			g.to.add(s.player());
		}
		if (groups.isEmpty()) return;
		long now = System.nanoTime();
		List<ServerPlayer> online = server.getPlayerList().getPlayers();
		List<Component> everyone = new ArrayList<>();
		for (Iterator<Map.Entry<String, Group>> it = groups.entrySet().iterator(); it.hasNext(); ) {
			Map.Entry<String, Group> e = it.next();
			Group g = e.getValue();
			if (now - g.first < GROUP_NANOS) continue;
			it.remove();
			// skipped if it turned out to be this mod's own or logged already since it was seen
			if (ChatLogMod.recentlySeen(e.getKey())) continue;
			if (g.to.size() >= 2 && online.size() >= 2 && online.stream().allMatch(p -> g.to.contains(p.getUUID()))) everyone.add(g.message);
		}
		for (Component message : everyone) {
			try {
				mod.sentToEveryone(server, message);
			} catch (RuntimeException ex) {
				ChatLogMod.LOG.debug("Couldn't log a message sent to everyone", ex);
			}
		}
	}

	private final class Handler extends ChannelDuplexHandler {
		private final ServerPlayer player;

		Handler(ServerPlayer player) {
			this.player = player;
		}

		@Override
		public void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) throws Exception {
			try {
				look(msg);
			} catch (Throwable thrown) {
				// whatever happens here, the packet still goes
			}
			super.write(ctx, msg, promise);
		}

		private void look(Object msg) {
			if (msg instanceof ClientboundSystemChatPacket chat) {
				if (!chat.overlay() && chat.content() != null && messages.size() < 2000) {
					messages.add(new Seen(player.getUUID(), chat.content(), System.nanoTime()));
				}
			} else if (msg instanceof ClientboundLevelParticlesPacket p) {
				if (watching && particles.size() < 2000 && player.level() instanceof ServerLevel level) particles.add(new SeenParticles(level, p));
			} else if (msg instanceof BundlePacket<?> bundle) {
				for (Object inner : bundle.subPackets()) look(inner);
			}
		}
	}
}
