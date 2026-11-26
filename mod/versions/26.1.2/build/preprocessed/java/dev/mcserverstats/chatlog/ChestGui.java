package dev.mcserverstats.chatlog;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.function.Consumer;

import net.minecraft.ChatFormatting;
import net.minecraft.core.component.DataComponents;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.SimpleMenuProvider;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.ChestMenu;
//#if MC >= 26.1
import net.minecraft.world.inventory.ContainerInput;
//#else
//$$ import net.minecraft.world.inventory.ClickType;
//#endif
import net.minecraft.world.inventory.MenuType;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.ItemLore;
import net.minecraft.world.item.component.TooltipDisplay;

// A chest window used as a menu, drawn and run entirely on the server, so players need nothing installed:
// each slot shows an icon and clicking it does something (opens another page, picks a setting). Nothing
// can be taken out or put in: every click is refused and the window redrawn as the server has it.
//
// VERIFIED by javap on the 26.2 merged jar: ChestMenu(MenuType, int, Inventory, Container, int);
// AbstractContainerMenu.clicked(int, int, ContainerInput, Player) (ContainerInput was ClickType);
// sendAllDataToRemote(); MenuType.GENERIC_9x1..9x6; Slot.container / getContainerSlot().
final class ChestGui extends ChestMenu {
	// What a click was: which mouse button, and whether shift was held.
	record Click(boolean right, boolean shift) {
	}

	record Button(ItemStack icon, Consumer<Click> action) {
	}

	// One page of a menu. Pages are rebuilt each time they're shown, so they always show the latest.
	abstract static class Page {
		final ServerPlayer player;

		Page(ServerPlayer player) {
			this.player = player;
		}

		abstract Component title();

		int rows() {
			return 6;
		}

		// Fill in the buttons, by slot (0 is the top left).
		abstract void draw(Map<Integer, Button> buttons);

		// A click on an item in the player's own inventory, below the menu. `slot` is its slot in their
		// inventory (0-8 the hotbar, 40 the off hand).
		void clickInventory(int slot, ItemStack stack, Click click) {
		}

		void open() {
			ChestGui.open(this);
		}
	}

	private static final MenuType<?>[] TYPES = {
			MenuType.GENERIC_9x1, MenuType.GENERIC_9x2, MenuType.GENERIC_9x3,
			MenuType.GENERIC_9x4, MenuType.GENERIC_9x5, MenuType.GENERIC_9x6,
	};

	// Opening a window from inside a click would close the window still handling it, so whatever a click
	// does runs at the end of the tick instead (ChatLogMod calls runQueued).
	private static final Queue<Runnable> QUEUED = new ArrayDeque<>();

	static void runQueued(MinecraftServer server) {
		for (int n = QUEUED.size(); n > 0; n--) {
			Runnable r = QUEUED.poll();
			if (r == null) break;
			try {
				r.run();
			} catch (RuntimeException e) {
				ChatLogMod.LOG.warn("A /mcstats menu action failed", e);
			}
		}
	}

	// Runs at the end of the tick, like a button's action (for the other server-drawn windows, AccountPrompt).
	static void later(Runnable r) {
		QUEUED.add(r);
	}

	static void open(Page page) {
		int rows = Math.max(1, Math.min(6, page.rows()));
		Map<Integer, Button> buttons = new HashMap<>();
		page.draw(buttons);
		SimpleContainer container = new SimpleContainer(rows * 9);
		ItemStack filler = filler();
		for (int i = 0; i < rows * 9; i++) {
			Button b = buttons.get(i);
			container.setItem(i, b != null ? b.icon() : filler.copy());
		}
		page.player.openMenu(new SimpleMenuProvider(
				(id, inventory, p) -> new ChestGui(TYPES[rows - 1], id, inventory, container, rows, page, buttons),
				page.title()));
	}

	private final int rows;
	private final Page page;
	private final Map<Integer, Button> buttons;

	private ChestGui(MenuType<?> type, int id, net.minecraft.world.entity.player.Inventory inventory, SimpleContainer container,
			int rows, Page page, Map<Integer, Button> buttons) {
		super(type, id, inventory, container, rows);
		this.rows = rows;
		this.page = page;
		this.buttons = buttons;
	}

	@Override
	//#if MC >= 26.1
	public void clicked(int slotId, int button, ContainerInput input, Player player) {
		boolean pickup = input == ContainerInput.PICKUP, shift = input == ContainerInput.QUICK_MOVE;
	//#else
	//$$ public void clicked(int slotId, int button, ClickType input, Player player) {
	//$$ 	boolean pickup = input == ClickType.PICKUP, shift = input == ClickType.QUICK_MOVE;
	//#endif
		// nothing moves: no super.clicked. A plain or shift click on a slot is read as a button press.
		if ((pickup || shift) && slotId >= 0 && slotId < slots.size()) {
			Click click = new Click(button == 1, shift);
			if (slotId < rows * 9) {
				Button b = buttons.get(slotId);
				if (b != null && b.action() != null) QUEUED.add(() -> b.action().accept(click));
			} else {
				Slot slot = slots.get(slotId);
				if (slot.container == player.getInventory()) {
					int index = slot.getContainerSlot();
					ItemStack stack = slot.getItem().copy();
					QUEUED.add(() -> page.clickInventory(index, stack, click));
				}
			}
		}
		// the player's game already moved the item on their screen; put everything back as it is
		sendAllDataToRemote();
	}

	@Override
	public ItemStack quickMoveStack(Player player, int slot) {
		return ItemStack.EMPTY;
	}

	@Override
	public boolean stillValid(Player player) {
		return true;
	}

	/* ---------- icons ---------- */

	static ItemStack filler() {
		//#if MC >= 26.2
		//$$ ItemStack pane = new ItemStack(Items.STAINED_GLASS_PANE.black());
		//#else
		ItemStack pane = new ItemStack(Items.BLACK_STAINED_GLASS_PANE);
		//#endif
		pane.set(DataComponents.TOOLTIP_DISPLAY, new TooltipDisplay(true, new java.util.LinkedHashSet<>()));
		return pane;
	}

	static ItemStack icon(Item item, Component name, List<Component> lore) {
		return icon(new ItemStack(item), name, lore);
	}

	// The item with this name (not in italics, as a renamed item would be) and these lines under it. Its
	// own tooltip lines (attributes, enchantments) are left out.
	static ItemStack icon(ItemStack stack, Component name, List<Component> lore) {
		stack.set(DataComponents.CUSTOM_NAME, plain(name));
		List<Component> lines = new ArrayList<>();
		for (Component c : lore) lines.add(plain(c));
		stack.set(DataComponents.LORE, new ItemLore(lines));
		TooltipDisplay hide = TooltipDisplay.DEFAULT
				.withHidden(DataComponents.ATTRIBUTE_MODIFIERS, true)
				.withHidden(DataComponents.ENCHANTMENTS, true)
				.withHidden(DataComponents.STORED_ENCHANTMENTS, true)
				.withHidden(DataComponents.TRIM, true)
				.withHidden(DataComponents.DYED_COLOR, true)
				.withHidden(DataComponents.UNBREAKABLE, true);
		stack.set(DataComponents.TOOLTIP_DISPLAY, hide);
		return stack;
	}

	static ItemStack glow(ItemStack stack) {
		stack.set(DataComponents.ENCHANTMENT_GLINT_OVERRIDE, true);
		return stack;
	}

	private static Component plain(Component c) {
		MutableComponent m = c.copy();
		return m.withStyle(s -> s.withItalic(false).withColor(s.getColor() == null ? net.minecraft.network.chat.TextColor.fromLegacyFormat(ChatFormatting.GRAY) : s.getColor()));
	}

	static Component text(String s, ChatFormatting... style) {
		return Component.literal(s).withStyle(style);
	}

	// "Label: value", the label grey and the value in a color.
	static Component stat(String label, String value, ChatFormatting color) {
		return Component.literal(label + ": ").withStyle(ChatFormatting.GRAY).append(Component.literal(value).withStyle(color));
	}

	static Button back(Page to) {
		return new Button(icon(Items.ARROW, text("Go Back", ChatFormatting.GREEN), List.of(text("To " + plainTitle(to), ChatFormatting.GRAY))), c -> to.open());
	}

	static Button close(ServerPlayer player) {
		return new Button(icon(Items.BARRIER, text("Close", ChatFormatting.RED), List.of()), c -> player.closeContainer());
	}

	private static String plainTitle(Page page) {
		return page.title().getString();
	}
}
