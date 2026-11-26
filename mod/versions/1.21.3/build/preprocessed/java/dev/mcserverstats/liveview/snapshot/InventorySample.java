package dev.mcserverstats.liveview.snapshot;

import java.util.List;
import java.util.UUID;

public record InventorySample(UUID uuid, List<SlotSample> slots, boolean unavailable) {
	public InventorySample {
		if (uuid == null) {
			throw new IllegalArgumentException("inventory sample is missing uuid");
		}
		slots = slots == null ? List.of() : List.copyOf(slots);
	}

	public static InventorySample unavailable(UUID uuid) {
		return new InventorySample(uuid, List.of(), true);
	}
}
