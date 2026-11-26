package dev.mcserverstats.liveview.snapshot;

/** One inventory slot. {@code detail} is null for empty slots and for older callers that only know the id. */
public record SlotSample(int slot, String item, int count, String customName, ItemDetail detail) {
	public SlotSample {
		if (item == null) {
			throw new IllegalArgumentException("slot item is missing");
		}
		if (count < 0) {
			count = 0;
		}
	}

	public SlotSample(int slot, String item, int count, String customName) {
		this(slot, item, count, customName, null);
	}

	public boolean empty() {
		return count <= 0 || item.isEmpty() || "minecraft:air".equals(item);
	}
}
