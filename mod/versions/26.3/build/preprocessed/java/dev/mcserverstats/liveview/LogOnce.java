package dev.mcserverstats.liveview;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class LogOnce {
	private static final Logger LOGGER = LoggerFactory.getLogger("mcstats-liveview");
	private static final Set<String> SEEN = ConcurrentHashMap.newKeySet();

	private LogOnce() {
	}

	public static void info(String key, String message) {
		if (SEEN.add(key)) {
			LOGGER.info(message);
		}
	}

	public static void warn(String key, String message, Throwable error) {
		if (!SEEN.add(key)) {
			return;
		}
		if (error == null) {
			LOGGER.warn(message);
		} else {
			LOGGER.warn(message, error);
		}
	}

	/** Called when a server stops, so the next start reports its own first failures. */
	public static void reset() {
		SEEN.clear();
	}

	public static Logger logger() {
		return LOGGER;
	}
}
