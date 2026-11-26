package dev.mcserverstats.liveview;

import java.util.UUID;

public interface OptOutController {
	boolean optOut(UUID uuid);

	boolean optIn(UUID uuid);
}
