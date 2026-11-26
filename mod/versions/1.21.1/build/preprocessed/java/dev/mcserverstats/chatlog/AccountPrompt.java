package dev.mcserverstats.chatlog;

import java.util.List;
import java.util.function.Consumer;
import java.util.regex.Pattern;

import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.SimpleMenuProvider;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AnvilMenu;
import net.minecraft.world.inventory.ContainerLevelAccess;
//#if MC >= 26.1
//$$ import net.minecraft.world.inventory.ContainerInput;
//#else
import net.minecraft.world.inventory.ClickType;
//#endif
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import static dev.mcserverstats.chatlog.ChestGui.icon;
import static dev.mcserverstats.chatlog.ChestGui.text;

// An anvil used as a text box, drawn and run on the server like ChestGui, so players need nothing installed:
// a paper sits in the first slot, the player types their email in the anvil's name field, and the result slot
// shows what clicking it would do (connect that email, or a barrier while it isn't an email yet). Clicking the
// result sends it; nothing is ever taken out, put in, or charged in levels.
//
// The anvil's name field is how the game sends typed text to the server: each change arrives as a rename
// (AnvilMenu.setItemName), at most 50 characters.
//
// VERIFIED by javap on the 1.21.1 and 26.3 merged jars: AnvilMenu(int, Inventory, ContainerLevelAccess);
// public boolean setItemName(String); public void createResult(); ItemCombinerMenu's protected inputSlots
// (Container) and resultSlots (ResultContainer); removed(Player) and stillValid(Player). With
// ContainerLevelAccess.NULL, ItemCombinerMenu.removed hands nothing back (it runs through the access), and
// removed below empties the slots anyway.
final class AccountPrompt extends AnvilMenu {
	// like the dashboard's EMAIL_RE (src/session.js), within the anvil's 50 characters
	private static final Pattern EMAIL = Pattern.compile("[^\\s@\"'<>,;]{1,64}@[^\\s@\"'<>,;]{1,180}\\.[^\\s@\"'<>,;]{2,}");
	private static final int RESULT = 2;

	// Opens the prompt. current: the email already there to edit, or null. submit runs (at the end of the
	// tick, with the window closed) with the email clicked.
	static void open(ServerPlayer player, String current, Consumer<String> submit) {
		player.openMenu(new SimpleMenuProvider(
				(id, inventory, p) -> new AccountPrompt(id, inventory, player, current, submit),
				Component.literal("Type your email")));
	}

	static boolean isEmail(String s) {
		return s != null && EMAIL.matcher(s).matches();
	}

	private final ServerPlayer owner;
	private final Consumer<String> submit;
	private String typed;

	private AccountPrompt(int id, Inventory inventory, ServerPlayer owner, String current, Consumer<String> submit) {
		super(id, inventory, ContainerLevelAccess.NULL);
		this.owner = owner;
		this.submit = submit;
		this.typed = current == null ? "" : current;
		// the name field starts as the paper's name: the email there now, or empty to type into
		ItemStack paper = icon(Items.PAPER, Component.literal(typed), List.of(
				text("Type the email of your mcstats", ChatFormatting.GRAY),
				text("account above, then click the", ChatFormatting.GRAY),
				text("result on the right.", ChatFormatting.GRAY)));
		inputSlots.setItem(0, paper);
		createResult();
	}

	@Override
	public boolean setItemName(String name) {
		String s = name == null ? "" : name;
		typed = s.length() > 50 ? s.substring(0, 50) : s;
		createResult();
		return true;
	}

	// What clicking the result would do, in the result slot. No level cost: the anvil shows none.
	@Override
	public void createResult() {
		String email = typed == null ? "" : typed.strip();
		ItemStack result;
		if (isEmail(email)) {
			result = ChestGui.glow(icon(Items.NAME_TAG, text("Connect " + email, ChatFormatting.GREEN), List.of(
					text("Click to connect this email.", ChatFormatting.GRAY),
					text("Then sign in to mcstats with it", ChatFormatting.GRAY),
					text("and say yes above the chat box.", ChatFormatting.GRAY))));
		} else {
			result = icon(Items.BARRIER, text(email.isEmpty() ? "Type your email above" : "That isn't an email yet", ChatFormatting.RED), List.of(
					text("Like name@example.com", ChatFormatting.GRAY)));
		}
		// the game sends it to the player with the menu's next update, each tick
		resultSlots.setItem(0, result);
	}

	@Override
	//#if MC >= 26.1
	//$$ public void clicked(int slotId, int button, ContainerInput input, Player player) {
		//$$ boolean press = input == ContainerInput.PICKUP || input == ContainerInput.QUICK_MOVE;
	//#else
	public void clicked(int slotId, int button, ClickType input, Player player) {
		boolean press = input == ClickType.PICKUP || input == ClickType.QUICK_MOVE;
	//#endif
		// nothing moves: no super.clicked. A click on the result is the button.
		if (press && slotId == RESULT) {
			String email = typed == null ? "" : typed.strip();
			if (isEmail(email)) {
				ChestGui.later(() -> {
					owner.closeContainer();
					submit.accept(email);
				});
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

	@Override
	public void removed(Player player) {
		// the paper and the result are only drawn here: nobody gets to keep them
		inputSlots.clearContent();
		resultSlots.clearContent();
		super.removed(player);
	}
}
