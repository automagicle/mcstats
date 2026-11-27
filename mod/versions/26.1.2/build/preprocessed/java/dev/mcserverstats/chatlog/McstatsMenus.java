package dev.mcserverstats.chatlog;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;

import com.google.gson.JsonObject;

import dev.mcserverstats.chatlog.ChestGui.Button;
import dev.mcserverstats.chatlog.ChestGui.Page;
import dev.mcserverstats.chatlog.PlayerRecords.Entry;
import dev.mcserverstats.chatlog.PlayerRecords.Sort;
import net.minecraft.ChatFormatting;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.core.particles.SimpleParticleType;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.ResolvableProfile;

import static dev.mcserverstats.chatlog.ChestGui.icon;
import static dev.mcserverstats.chatlog.ChestGui.stat;
import static dev.mcserverstats.chatlog.ChestGui.text;

// The /mcstats menus: chest windows you click through, each page with a way back to the one before.
//   Main ─┬─ Your Profile ─┬─ Displayed main hand (pick an item in your inventory)
//         │                ├─ Displayed off hand  (the same)
//         │                ├─ Particle effect
//         │                └─ Your Stats
//         ├─ Server Stats (every player's head) ── Player Stats
//         ├─ Leaderboards ── Server Stats ordered by that number
//         └─ Website, Connect Account (an anvil to type an email in), Commands
final class McstatsMenus {
	// A particle on the dashboard, with the icon it has here and the game's particle to preview it in game.
	record Particle(String id, String label, Item icon, SimpleParticleType preview, ChatFormatting color) {
	}

	static final List<Particle> PARTICLES = List.of(
			new Particle("flame", "Flame", Items.BLAZE_POWDER, ParticleTypes.FLAME, ChatFormatting.GOLD),
			new Particle("heart", "Hearts", Items.POPPY, ParticleTypes.HEART, ChatFormatting.RED),
			new Particle("end_rod", "End Rod", Items.END_ROD, ParticleTypes.END_ROD, ChatFormatting.WHITE),
			new Particle("enchant", "Enchanting Runes", Items.ENCHANTED_BOOK, ParticleTypes.ENCHANT, ChatFormatting.LIGHT_PURPLE),
			new Particle("portal", "Portal", Items.ENDER_PEARL, ParticleTypes.PORTAL, ChatFormatting.DARK_PURPLE),
			new Particle("firework", "Fireworks", Items.FIREWORK_ROCKET, ParticleTypes.FIREWORK, ChatFormatting.YELLOW),
			new Particle("happy_villager", "Happy Villager", Items.EMERALD, ParticleTypes.HAPPY_VILLAGER, ChatFormatting.GREEN),
			new Particle("snowflake", "Snowflakes", Items.SNOWBALL, ParticleTypes.SNOWFLAKE, ChatFormatting.AQUA),
			new Particle("crit", "Critical Hits", Items.IRON_SWORD, ParticleTypes.CRIT, ChatFormatting.WHITE),
			new Particle("electric_spark", "Electric Sparks", Items.BREEZE_ROD, ParticleTypes.ELECTRIC_SPARK, ChatFormatting.YELLOW),
			new Particle("sculk_soul", "Sculk Souls", Items.SCULK, ParticleTypes.SCULK_SOUL, ChatFormatting.DARK_AQUA),
			new Particle("crimson_spore", "Crimson Spores", Items.CRIMSON_FUNGUS, ParticleTypes.CRIMSON_SPORE, ChatFormatting.DARK_RED),
			new Particle("small_gust", "Gusts", Items.WIND_CHARGE, ParticleTypes.SMALL_GUST, ChatFormatting.WHITE),
			new Particle("nautilus", "Nautilus", Items.HEART_OF_THE_SEA, ParticleTypes.NAUTILUS, ChatFormatting.BLUE),
			new Particle("smoke", "Smoke", Items.CAMPFIRE, ParticleTypes.SMOKE, ChatFormatting.DARK_GRAY),
			new Particle("ash", "Ash", Items.GUNPOWDER, ParticleTypes.ASH, ChatFormatting.GRAY),
			new Particle("composter", "Compost", Items.BONE_MEAL, ParticleTypes.COMPOSTER, ChatFormatting.GREEN));

	static Particle particle(String id) {
		for (Particle p : PARTICLES) if (p.id().equals(id)) return p;
		return null;
	}

	private final ProfileStore profiles;
	private final Supplier<String> site; // the server's dashboard page, ending in "/", or null
	private final Accounts accounts;

	McstatsMenus(ProfileStore profiles, Supplier<String> site, Accounts accounts) {
		this.profiles = profiles;
		this.site = site;
		this.accounts = accounts;
	}

	Accounts accounts() {
		return accounts;
	}

	ProfileStore profiles() {
		return profiles;
	}

	/* ---------- the pages ---------- */

	Page main(ServerPlayer player) {
		return new Page(player) {
			@Override
			Component title() {
				return Component.literal("mcstats Menu");
			}

			@Override
			void draw(Map<Integer, Button> b) {
				MinecraftServer server = player.level().getServer();
				Entry me = PlayerRecords.find(server, player.getUUID()).orElse(null);
				List<Component> lore = new ArrayList<>();
				lore.add(text("See your stats and choose how you", ChatFormatting.GRAY));
				lore.add(text("look on the mcstats website.", ChatFormatting.GRAY));
				lore.add(Component.empty());
				if (me != null) lore.add(stat("Playtime", me.playtime(), ChatFormatting.GREEN));
				lore.add(Component.empty());
				lore.add(text("Click to view!", ChatFormatting.YELLOW));
				if (McstatsCommands.on("profile")) b.put(13, new Button(icon(head(player.getUUID(), player), text("Your Profile", ChatFormatting.GREEN), lore), c -> profile(player).open()));

				int online = server.getPlayerList().getPlayerCount();
				int known = PlayerRecords.all(server).size();
				if (McstatsCommands.on("stats")) b.put(20, new Button(icon(Items.FILLED_MAP, text("Server Stats", ChatFormatting.GREEN), List.of(
						text("Every player who has played here.", ChatFormatting.GRAY),
						text("Hover a head for a summary, click", ChatFormatting.GRAY),
						text("it for all of their stats.", ChatFormatting.GRAY),
						Component.empty(),
						stat("Online", online + "", ChatFormatting.GREEN),
						stat("Players", known + "", ChatFormatting.AQUA),
						Component.empty(),
						text("Click to view!", ChatFormatting.YELLOW))), c -> serverStats(player, Sort.ONLINE, 0).open()));

				if (McstatsCommands.on("top")) b.put(22, new Button(icon(Items.GOLD_INGOT, text("Leaderboards", ChatFormatting.GOLD), List.of(
						text("The top players for playtime,", ChatFormatting.GRAY),
						text("kills, deaths and distance.", ChatFormatting.GRAY),
						Component.empty(),
						text("Click to view!", ChatFormatting.YELLOW))), c -> leaderboards(player).open()));

				if (McstatsCommands.on("link")) b.put(24, new Button(icon(Items.SPYGLASS, text("Website", ChatFormatting.AQUA), List.of(
						text("Get a link to your page on the", ChatFormatting.GRAY),
						text("mcstats website.", ChatFormatting.GRAY),
						Component.empty(),
						text("Click for the link!", ChatFormatting.YELLOW))), c -> {
					player.closeContainer();
					sendLink(player, player.getUUID(), "your page");
				}));

				if (McstatsCommands.on("connect")) b.put(32, accountButton(player));

				b.put(30, new Button(icon(Items.WRITABLE_BOOK, text("Commands", ChatFormatting.YELLOW), List.of(
						text("/mcstats help lists them all.", ChatFormatting.GRAY),
						Component.empty(),
						text("Click to list them in chat!", ChatFormatting.YELLOW))), c -> {
					player.closeContainer();
					McstatsCommands.help(player.createCommandSourceStack());
				}));

				b.put(49, ChestGui.close(player));
			}
		};
	}

	// Connect Account: opens the anvil to type an email in (Accounts). The status is what the dashboard said
	// last; it's asked again each time the main menu is drawn.
	private Button accountButton(ServerPlayer player) {
		accounts.refresh(player);
		Accounts.Status s = accounts.known(player.getUUID());
		List<Component> lore = new ArrayList<>();
		lore.add(text("Connect your mcstats account to", ChatFormatting.GRAY));
		lore.add(text("chat as yourself on the website.", ChatFormatting.GRAY));
		lore.add(Component.empty());
		if (s != null && s.email() != null) {
			lore.add(stat(s.confirmed() ? "Connected" : "Waiting for a yes", s.email(), s.confirmed() ? ChatFormatting.GREEN : ChatFormatting.GOLD));
			if (!s.confirmed()) {
				lore.add(text("Sign in to mcstats with it and", ChatFormatting.GRAY));
				lore.add(text("click Connect above the chat box.", ChatFormatting.GRAY));
			}
			lore.add(Component.empty());
			lore.add(text("Click to change the email!", ChatFormatting.YELLOW));
			lore.add(text("Right-click to disconnect.", ChatFormatting.YELLOW));
		} else {
			if (s != null) lore.add(stat("Connected", "Nothing yet", ChatFormatting.DARK_GRAY));
			if (s != null) lore.add(Component.empty());
			lore.add(text("Click to type your email!", ChatFormatting.YELLOW));
		}
		ItemStack tag = icon(Items.NAME_TAG, text("Connect Account", ChatFormatting.LIGHT_PURPLE), lore);
		return new Button(s != null && s.confirmed() ? ChestGui.glow(tag) : tag, c -> {
			if (c.right() && s != null && s.email() != null) {
				player.closeContainer();
				accounts.disconnect(player);
			} else accounts.prompt(player);
		});
	}

	Page profile(ServerPlayer player) {
		McstatsMenus menus = this;
		return new Page(player) {
			@Override
			Component title() {
				return Component.literal("Your Profile");
			}

			@Override
			void draw(Map<Integer, Button> b) {
				MinecraftServer server = player.level().getServer();
				ProfileStore.Display d = profiles.get(player.getUUID());
				Entry me = PlayerRecords.find(server, player.getUUID()).orElse(null);

				List<Component> lore = new ArrayList<>();
				if (me != null) summary(lore, me);
				b.put(4, new Button(icon(head(player.getUUID(), player), text(player.getScoreboardName(), ChatFormatting.GREEN), lore), null));

				b.put(19, new Button(handIcon(d.mainhand(), Items.DIAMOND_SWORD, "Displayed Main Hand",
						"Your best weapon or tool"), c -> {
					if (c.right()) {
						profiles.setMainhand(player.getUUID(), null);
						say(player, "Your main hand on the website is automatic again.");
						open();
					} else menus.pickItem(player, true).open();
				}));
				b.put(21, new Button(handIcon(d.offhand(), Items.SHIELD, "Displayed Off Hand",
						"Nothing (or your server's add-on)"), c -> {
					if (c.right()) {
						profiles.setOffhand(player.getUUID(), null);
						say(player, "Your off hand on the website is automatic again.");
						open();
					} else menus.pickItem(player, false).open();
				}));

				Particle p = particle(d.particle());
				List<Component> pl = new ArrayList<>();
				pl.add(text("Particles that float around your", ChatFormatting.GRAY));
				pl.add(text("3D model on the website.", ChatFormatting.GRAY));
				pl.add(Component.empty());
				pl.add(stat("Selected", p == null ? "None" : p.label(), p == null ? ChatFormatting.DARK_GRAY : p.color()));
				pl.add(Component.empty());
				pl.add(text("Click to choose!", ChatFormatting.YELLOW));
				ItemStack pIcon = icon(p == null ? Items.BLAZE_POWDER : p.icon(), text("Particle Effect", ChatFormatting.LIGHT_PURPLE), pl);
				if (McstatsCommands.on("particle")) b.put(23, new Button(p == null ? pIcon : ChestGui.glow(pIcon), c -> menus.particles(player).open()));

				if (McstatsCommands.on("stats")) b.put(25, new Button(icon(Items.BOOK, text("Your Stats", ChatFormatting.GREEN), List.of(
						text("Everything the game counts", ChatFormatting.GRAY),
						text("about you here.", ChatFormatting.GRAY),
						Component.empty(),
						text("Click to view!", ChatFormatting.YELLOW))), c -> menus.playerStats(player, player.getUUID(), this).open()));

				if (McstatsCommands.on("link")) b.put(39, new Button(icon(Items.PAPER, text("View on Website", ChatFormatting.AQUA), List.of(
						text("Your page, with your 3D model.", ChatFormatting.GRAY),
						text("Changes show up within a minute.", ChatFormatting.GRAY),
						Component.empty(),
						text("Click for the link!", ChatFormatting.YELLOW))), c -> {
					player.closeContainer();
					sendLink(player, player.getUUID(), "your page");
				}));
				if (McstatsCommands.on("reset")) b.put(41, new Button(icon(Items.BARRIER, text("Reset Display", ChatFormatting.RED), List.of(
						text("Go back to the automatic look:", ChatFormatting.GRAY),
						text("your best weapon, no particles.", ChatFormatting.GRAY),
						Component.empty(),
						text("Click to reset!", ChatFormatting.YELLOW))), c -> {
					profiles.reset(player.getUUID());
					say(player, "Your website display is back to automatic.");
					open();
				}));

				if (McstatsCommands.on("view")) b.put(48, ChestGui.back(main(player)));
				b.put(49, ChestGui.close(player));
			}
		};
	}

	// What a hand shows on the website: the item they picked (drawn as that item), or the automatic choice.
	private static ItemStack handIcon(JsonObject picked, Item fallback, String title, String automatic) {
		List<Component> lore = new ArrayList<>();
		lore.add(text("What your 3D model holds on", ChatFormatting.GRAY));
		lore.add(text("the website.", ChatFormatting.GRAY));
		lore.add(Component.empty());
		ItemStack stack;
		if (picked != null) {
			stack = stackOf(picked);
			lore.add(stat("Selected", picked.has("name") ? picked.get("name").getAsString() : pretty(picked.get("id").getAsString()), ChatFormatting.GREEN));
		} else {
			stack = new ItemStack(fallback);
			lore.add(stat("Selected", "Automatic", ChatFormatting.DARK_GRAY));
			lore.add(text("  " + automatic, ChatFormatting.DARK_GRAY));
		}
		lore.add(Component.empty());
		lore.add(text("Click to pick an item!", ChatFormatting.YELLOW));
		if (picked != null) lore.add(text("Right-click to make it automatic.", ChatFormatting.YELLOW));
		ItemStack out = icon(stack, text(title, ChatFormatting.GREEN), lore);
		return picked != null && picked.has("glint") ? ChestGui.glow(out) : out;
	}

	// Pick what a hand shows by clicking an item in your own inventory.
	Page pickItem(ServerPlayer player, boolean mainhand) {
		String hand = mainhand ? "Main Hand" : "Off Hand";
		return new Page(player) {
			@Override
			Component title() {
				return Component.literal("Pick Your " + hand);
			}

			@Override
			int rows() {
				return 4;
			}

			@Override
			void draw(Map<Integer, Button> b) {
				ProfileStore.Display d = profiles.get(player.getUUID());
				JsonObject now = mainhand ? d.mainhand() : d.offhand();
				b.put(4, new Button(icon(Items.OAK_SIGN, text("Click an item in your inventory", ChatFormatting.YELLOW), List.of(
						text("It's what your 3D model holds in its", ChatFormatting.GRAY),
						text(hand.toLowerCase() + " on the website, and it stays", ChatFormatting.GRAY),
						text("there even after you put it away.", ChatFormatting.GRAY))), null));
				b.put(13, new Button(handIcon(now, mainhand ? Items.DIAMOND_SWORD : Items.SHIELD, "Now Showing",
						mainhand ? "Your best weapon or tool" : "Nothing (or your server's add-on)"), null));
				b.put(22, new Button(icon(Items.HOPPER, text("Automatic", ChatFormatting.GREEN), List.of(
						text(mainhand ? "Show your best weapon or tool." : "Show nothing you picked.", ChatFormatting.GRAY),
						Component.empty(),
						text("Click to use this!", ChatFormatting.YELLOW))), c -> {
					if (mainhand) profiles.setMainhand(player.getUUID(), null);
					else profiles.setOffhand(player.getUUID(), null);
					say(player, "Your " + hand.toLowerCase() + " on the website is automatic again.");
					profile(player).open();
				}));
				b.put(31, ChestGui.back(profile(player)));
			}

			@Override
			void clickInventory(int slot, ItemStack stack, ChestGui.Click click) {
				if (stack.isEmpty()) return;
				JsonObject item = GearReporter.item(stack);
				item.remove("n"); // one of it is shown, however many they carry
				if (mainhand) profiles.setMainhand(player.getUUID(), item);
				else profiles.setOffhand(player.getUUID(), item);
				say(player, Component.literal("Your " + hand.toLowerCase() + " on the website is now ").withStyle(ChatFormatting.GREEN)
						.append(stack.getHoverName().copy().withStyle(ChatFormatting.WHITE)).append(Component.literal(".").withStyle(ChatFormatting.GREEN)));
				profile(player).open();
			}
		};
	}

	Page particles(ServerPlayer player) {
		return new Page(player) {
			@Override
			Component title() {
				return Component.literal("Particle Effect");
			}

			@Override
			void draw(Map<Integer, Button> b) {
				String chosen = profiles.get(player.getUUID()).particle();
				// 17 particles in the middle three rows, leaving the border
				int[] slots = {10, 11, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 24, 25, 28, 29, 30, 31, 32, 33, 34};
				for (int i = 0; i < PARTICLES.size() && i < slots.length; i++) {
					Particle p = PARTICLES.get(i);
					boolean on = p.id().equals(chosen);
					ItemStack s = icon(p.icon(), text(p.label(), p.color()), List.of(
							text("Floats around your 3D model", ChatFormatting.GRAY),
							text("on the website.", ChatFormatting.GRAY),
							Component.empty(),
							on ? text("Selected!", ChatFormatting.GREEN) : text("Click to select!", ChatFormatting.YELLOW)));
					b.put(slots[i], new Button(on ? ChestGui.glow(s) : s, c -> {
						profiles.setParticle(player.getUUID(), p.id());
						preview(player, p);
						say(player, Component.literal("Your particle effect on the website is now ").withStyle(ChatFormatting.GREEN)
								.append(Component.literal(p.label()).withStyle(p.color())).append(Component.literal(".").withStyle(ChatFormatting.GREEN)));
						open();
					}));
				}
				ItemStack none = icon(Items.GLASS_BOTTLE, text("No Particles", ChatFormatting.RED), List.of(
						text("Nothing around your model.", ChatFormatting.GRAY),
						Component.empty(),
						chosen == null ? text("Selected!", ChatFormatting.GREEN) : text("Click to select!", ChatFormatting.YELLOW)));
				b.put(40, new Button(chosen == null ? ChestGui.glow(none) : none, c -> {
					profiles.setParticle(player.getUUID(), null);
					say(player, "You have no particle effect on the website now.");
					open();
				}));
				b.put(48, ChestGui.back(profile(player)));
				b.put(49, ChestGui.close(player));
			}
		};
	}

	// A puff of the particle around the player, seen only by them, so they know what they picked.
	private static void preview(ServerPlayer player, Particle p) {
		try {
			dev.mcserverstats.compat.Compat.level(player).sendParticles(player, p.preview(), false, false, player.getX(), player.getY() + 1, player.getZ(), 24, 0.5, 0.8, 0.5, 0.02);
		} catch (RuntimeException e) {
			ChatLogMod.LOG.debug("Couldn't show a particle preview", e);
		}
	}

	// Every player's head, 45 to a page. Hover: name, playtime, online or not, role. Click: their stats.
	Page serverStats(ServerPlayer player, Sort sort, int pageNumber) {
		McstatsMenus menus = this;
		return new Page(player) {
			@Override
			Component title() {
				return Component.literal("Server Stats");
			}

			@Override
			void draw(Map<Integer, Button> b) {
				MinecraftServer server = player.level().getServer();
				List<Entry> all = PlayerRecords.sorted(server, sort);
				int pages = Math.max(1, (all.size() + 44) / 45);
				int pageNo = Math.max(0, Math.min(pageNumber, pages - 1));
				Page self = this;
				for (int i = 0; i < 45; i++) {
					int k = pageNo * 45 + i;
					if (k >= all.size()) break;
					Entry e = all.get(k);
					b.put(i, new Button(icon(head(e.uuid(), server.getPlayerList().getPlayer(e.uuid())), nameLine(e), hover(e, sort)),
							c -> menus.playerStats(player, e.uuid(), self).open()));
				}
				if (all.isEmpty()) {
					b.put(22, new Button(icon(Items.BARRIER, text("Nobody yet", ChatFormatting.RED), List.of(
							text("No player stats were found.", ChatFormatting.GRAY))), null));
				}
				if (pageNo > 0) {
					b.put(45, new Button(icon(Items.ARROW, text("Previous Page", ChatFormatting.GREEN), List.of(
							text("Page " + pageNo + " of " + pages, ChatFormatting.GRAY))), c -> serverStats(player, sort, pageNo - 1).open()));
				}
				if (pageNo < pages - 1) {
					b.put(53, new Button(icon(Items.ARROW, text("Next Page", ChatFormatting.GREEN), List.of(
							text("Page " + (pageNo + 2) + " of " + pages, ChatFormatting.GRAY))), c -> serverStats(player, sort, pageNo + 1).open()));
				}
				List<Component> sortLore = new ArrayList<>();
				for (Sort s : Sort.values()) {
					sortLore.add(s == sort ? text("▶ " + s.label, ChatFormatting.AQUA) : text("  " + s.label, ChatFormatting.GRAY));
				}
				sortLore.add(Component.empty());
				sortLore.add(text("Click to change!", ChatFormatting.YELLOW));
				b.put(50, new Button(icon(Items.HOPPER, text("Sorted by " + sort.label, ChatFormatting.GREEN), sortLore),
						c -> serverStats(player, sort.next(), 0).open()));
				if (McstatsCommands.on("view")) b.put(48, ChestGui.back(main(player)));
				b.put(49, ChestGui.close(player));
			}
		};
	}

	private static Component nameLine(Entry e) {
		return Component.literal(e.name()).withStyle(e.op() ? ChatFormatting.RED : e.online() ? ChatFormatting.GREEN : ChatFormatting.WHITE);
	}

	private static List<Component> hover(Entry e, Sort sort) {
		List<Component> lore = new ArrayList<>();
		lore.add(stat("Playtime", e.playtime(), ChatFormatting.GREEN));
		lore.add(e.online() ? stat("Status", "Online", ChatFormatting.GREEN) : stat("Status", "Offline · seen " + PlayerRecords.ago(e.lastSeenMs()), ChatFormatting.GRAY));
		lore.add(stat("Role", e.op() ? "Admin (operator)" : "Player", e.op() ? ChatFormatting.RED : ChatFormatting.WHITE));
		switch (sort) {
			case PLAYER_KILLS -> lore.add(stat("Player kills", PlayerRecords.number(e.playerKills()), ChatFormatting.GOLD));
			case MOB_KILLS -> lore.add(stat("Mob kills", PlayerRecords.number(e.mobKills()), ChatFormatting.GOLD));
			case DEATHS -> lore.add(stat("Deaths", PlayerRecords.number(e.deaths()), ChatFormatting.GOLD));
			case DISTANCE -> lore.add(stat("Travelled", PlayerRecords.distance(e.travelledCm()), ChatFormatting.GOLD));
			default -> {
			}
		}
		lore.add(Component.empty());
		lore.add(text("Click to see their stats!", ChatFormatting.YELLOW));
		return lore;
	}

	private static void summary(List<Component> lore, Entry e) {
		lore.add(stat("Playtime", e.playtime(), ChatFormatting.GREEN));
		lore.add(e.online() ? stat("Status", "Online", ChatFormatting.GREEN) : stat("Status", "Offline · seen " + PlayerRecords.ago(e.lastSeenMs()), ChatFormatting.GRAY));
		lore.add(stat("Role", e.op() ? "Admin (operator)" : "Player", e.op() ? ChatFormatting.RED : ChatFormatting.WHITE));
	}

	// All of one player's numbers, with what they show on the website.
	Page playerStats(ServerPlayer player, UUID who, Page back) {
		McstatsMenus menus = this;
		return new Page(player) {
			@Override
			Component title() {
				Entry e = PlayerRecords.find(player.level().getServer(), who).orElse(null);
				return Component.literal(e == null ? "Player Stats" : e.name() + "'s Stats");
			}

			@Override
			void draw(Map<Integer, Button> b) {
				MinecraftServer server = player.level().getServer();
				Entry e = PlayerRecords.find(server, who).orElse(null);
				b.put(48, ChestGui.back(back));
				b.put(49, ChestGui.close(player));
				if (e == null) {
					b.put(22, new Button(icon(Items.BARRIER, text("No stats", ChatFormatting.RED), List.of(
							text("This player has no stats here.", ChatFormatting.GRAY))), null));
					return;
				}
				List<Component> lore = new ArrayList<>();
				summary(lore, e);
				b.put(4, new Button(icon(head(e.uuid(), server.getPlayerList().getPlayer(e.uuid())), nameLine(e), lore), null));

				b.put(19, info(Items.CLOCK, "Playtime", e.playtime(), "Time spent on this server."));
				b.put(20, info(Items.DIAMOND_SWORD, "Player Kills", PlayerRecords.number(e.playerKills()), "Other players they killed."));
				b.put(21, info(Items.SKELETON_SKULL, "Mob Kills", PlayerRecords.number(e.mobKills()), "Mobs they killed."));
				b.put(22, info(Items.TOTEM_OF_UNDYING, "Deaths", PlayerRecords.number(e.deaths()), "Times they died."));
				b.put(23, info(Items.IRON_SWORD, "Damage Dealt", PlayerRecords.number(e.damageDealt() / 20) + " ❤", "Hearts of damage they dealt."));
				b.put(24, info(Items.LEATHER_BOOTS, "Distance Travelled", PlayerRecords.distance(e.travelledCm()),
						"Walked: " + PlayerRecords.distance(e.walkedCm()),
						"Flown: " + PlayerRecords.distance(e.flownCm()),
						"Swum: " + PlayerRecords.distance(e.swumCm())));
				b.put(25, info(Items.FIREWORK_ROCKET, "Jumps", PlayerRecords.number(e.jumps()), "Times they jumped."));
				double kd = e.deaths() == 0 ? e.playerKills() : (double) e.playerKills() / e.deaths();
				b.put(30, info(Items.NETHER_STAR, "K/D Ratio", String.format("%.2f", kd), "Player kills for each death."));
				b.put(31, info(Items.EMERALD, "Villager Trades", PlayerRecords.number(e.tradedWithVillager()), "Times they traded with a villager."));
				b.put(32, info(Items.COMPASS, "Fish Caught", PlayerRecords.number(e.fishCaught()), "Fish they reeled in."));

				// what they show on the website
				ProfileStore.Display d = profiles.get(who);
				Particle p = particle(d.particle());
				List<Component> shown = new ArrayList<>();
				shown.add(stat("Main hand", d.mainhand() == null ? "Automatic" : label(d.mainhand()), ChatFormatting.WHITE));
				shown.add(stat("Off hand", d.offhand() == null ? "Automatic" : label(d.offhand()), ChatFormatting.WHITE));
				shown.add(stat("Particles", p == null ? "None" : p.label(), p == null ? ChatFormatting.DARK_GRAY : p.color()));
				shown.add(Component.empty());
				shown.add(text("Click for a link to their page!", ChatFormatting.YELLOW));
				ItemStack shownIcon = d.mainhand() != null ? stackOf(d.mainhand()) : new ItemStack(Items.ARMOR_STAND);
				b.put(40, new Button(icon(shownIcon, text("On the Website", ChatFormatting.AQUA), shown), c -> {
					player.closeContainer();
					sendLink(player, who, e.name() + "'s page");
				}));
				if (who.equals(player.getUUID())) {
					b.put(50, new Button(icon(Items.ANVIL, text("Edit Your Display", ChatFormatting.GREEN), List.of(
							text("Change what you hold and your", ChatFormatting.GRAY),
							text("particles on the website.", ChatFormatting.GRAY))), c -> menus.profile(player).open()));
				}
			}
		};
	}

	private static Button info(Item item, String title, String value, String... about) {
		List<Component> lore = new ArrayList<>();
		lore.add(Component.literal(value).withStyle(ChatFormatting.GREEN, ChatFormatting.BOLD));
		lore.add(Component.empty());
		for (String a : about) lore.add(text(a, ChatFormatting.GRAY));
		return new Button(icon(item, text(title, ChatFormatting.YELLOW), lore), null);
	}

	Page leaderboards(ServerPlayer player) {
		McstatsMenus menus = this;
		return new Page(player) {
			@Override
			Component title() {
				return Component.literal("Leaderboards");
			}

			@Override
			void draw(Map<Integer, Button> b) {
				MinecraftServer server = player.level().getServer();
				b.put(20, board(server, Items.CLOCK, Sort.PLAYTIME, Entry::playtime));
				b.put(21, board(server, Items.DIAMOND_SWORD, Sort.PLAYER_KILLS, e -> PlayerRecords.number(e.playerKills())));
				b.put(22, board(server, Items.SKELETON_SKULL, Sort.MOB_KILLS, e -> PlayerRecords.number(e.mobKills())));
				b.put(23, board(server, Items.TOTEM_OF_UNDYING, Sort.DEATHS, e -> PlayerRecords.number(e.deaths())));
				b.put(24, board(server, Items.LEATHER_BOOTS, Sort.DISTANCE, e -> PlayerRecords.distance(e.travelledCm())));
				if (McstatsCommands.on("view")) b.put(48, ChestGui.back(main(player)));
				b.put(49, ChestGui.close(player));
			}

			private Button board(MinecraftServer server, Item item, Sort sort, java.util.function.Function<Entry, String> value) {
				List<Entry> top = PlayerRecords.sorted(server, sort);
				List<Component> lore = new ArrayList<>();
				ChatFormatting[] medal = {ChatFormatting.GOLD, ChatFormatting.WHITE, ChatFormatting.RED};
				for (int i = 0; i < Math.min(10, top.size()); i++) {
					Entry e = top.get(i);
					boolean me = e.uuid().equals(player.getUUID());
					lore.add(Component.literal("#" + (i + 1) + " ").withStyle(i < 3 ? medal[i] : ChatFormatting.DARK_GRAY)
							.append(Component.literal(e.name()).withStyle(me ? ChatFormatting.AQUA : ChatFormatting.WHITE))
							.append(Component.literal("  " + value.apply(e)).withStyle(ChatFormatting.GRAY)));
				}
				if (top.isEmpty()) lore.add(text("Nobody yet.", ChatFormatting.GRAY));
				for (int i = 10; i < top.size(); i++) {
					if (top.get(i).uuid().equals(player.getUUID())) {
						lore.add(Component.empty());
						lore.add(Component.literal("You: #" + (i + 1) + "  ").withStyle(ChatFormatting.AQUA)
								.append(Component.literal(value.apply(top.get(i))).withStyle(ChatFormatting.GRAY)));
						break;
					}
				}
				lore.add(Component.empty());
				lore.add(text("Click to see everyone!", ChatFormatting.YELLOW));
				return new Button(icon(item, text(sort.label, ChatFormatting.GOLD), lore), c -> menus.serverStats(player, sort, 0).open());
			}
		};
	}

	/* ---------- helpers ---------- */

	// A player's head with their skin: from their profile when they're online, else looked up by the game.
	static ItemStack head(UUID uuid, ServerPlayer online) {
		ItemStack head = new ItemStack(Items.PLAYER_HEAD);
		//#if MC >= 1.21.9
		head.set(DataComponents.PROFILE, online != null
				? ResolvableProfile.createResolved(online.getGameProfile())
				: ResolvableProfile.createUnresolved(uuid));
		//#else
		//$$ head.set(DataComponents.PROFILE, online != null
		//$$ 		? new ResolvableProfile(online.getGameProfile())
		//$$ 		: new ResolvableProfile(java.util.Optional.empty(), java.util.Optional.of(uuid), new com.mojang.authlib.properties.PropertyMap()));
		//#endif
		return head;
	}

	// The item a saved pick was (its id, look and name), to draw it in a menu.
	static ItemStack stackOf(JsonObject item) {
		String id = item.has("model") ? item.get("model").getAsString() : item.get("id").getAsString();
		Identifier key = Identifier.tryParse(id.contains(":") ? id : "minecraft:" + id);
		Item it = key == null ? Items.BARRIER : BuiltInRegistries.ITEM.getOptional(key).orElse(Items.BARRIER);
		if (it == Items.AIR) it = Items.BARRIER;
		ItemStack stack = new ItemStack(it);
		if (item.has("glint")) stack.set(DataComponents.ENCHANTMENT_GLINT_OVERRIDE, true);
		return stack;
	}

	private static String label(JsonObject item) {
		return item.has("name") ? item.get("name").getAsString() : pretty(item.get("id").getAsString());
	}

	static String pretty(String id) {
		String s = id.replaceFirst("^minecraft:", "").replace('_', ' ');
		StringBuilder out = new StringBuilder();
		for (String w : s.split(" ")) {
			if (w.isEmpty()) continue;
			if (!out.isEmpty()) out.append(' ');
			out.append(Character.toUpperCase(w.charAt(0))).append(w.substring(1));
		}
		return out.toString();
	}

	static void say(ServerPlayer player, String message) {
		say(player, Component.literal(message).withStyle(ChatFormatting.GREEN));
	}

	static void say(ServerPlayer player, Component message) {
		player.sendSystemMessage(message);
	}

	// A clickable link to a player's page on the dashboard, in chat.
	void sendLink(ServerPlayer to, UUID who, String what) {
		String base = site.get();
		if (base == null) {
			say(to, Component.literal("The website's address isn't known yet: the server isn't connected to mcstats.").withStyle(ChatFormatting.RED));
			return;
		}
		String url = base + "#/player/" + who;
		try {
			java.net.URI uri = java.net.URI.create(url);
			say(to, Component.literal("Open " + what + " on mcstats: ").withStyle(ChatFormatting.GREEN)
					.append(Component.literal(url).withStyle(s -> s.withColor(ChatFormatting.AQUA).withUnderlined(true)
							.withClickEvent(dev.mcserverstats.compat.Compat.openUrl(uri))
							.withHoverEvent(dev.mcserverstats.compat.Compat.showText(Component.literal("Click to open in your browser"))))));
		} catch (IllegalArgumentException e) {
			say(to, Component.literal(url).withStyle(ChatFormatting.AQUA));
		}
	}
}
