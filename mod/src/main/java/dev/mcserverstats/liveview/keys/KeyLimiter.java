package dev.mcserverstats.liveview.keys;

import java.util.ArrayDeque;
import java.util.Iterator;
import java.util.concurrent.ConcurrentHashMap;

/** Wrong keys tried lately, per dashboard account: after {@link #LIMIT} in a minute, further tries are refused. */
public final class KeyLimiter {
	public static final int LIMIT = 5;
	private static final long WINDOW_MS = 60_000L;
	private static final int MAX_KEYS = 4096;

	private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();

	public boolean blocked(String key) {
		if (key == null || key.isBlank()) {
			return false;
		}
		Window window = windows.get(key);
		return window != null && window.size(now()) >= LIMIT;
	}

	public void failure(String key) {
		if (key == null || key.isBlank()) {
			return;
		}
		if (windows.size() >= MAX_KEYS && !windows.containsKey(key)) {
			evictOne();
		}
		windows.computeIfAbsent(key, ignored -> new Window()).add(now());
	}

	public void success(String key) {
		if (key != null) {
			windows.remove(key);
		}
	}

	private void evictOne() {
		Iterator<String> iterator = windows.keySet().iterator();
		if (iterator.hasNext()) {
			windows.remove(iterator.next());
		}
	}

	private static long now() {
		return System.currentTimeMillis();
	}

	private static final class Window {
		private final ArrayDeque<Long> times = new ArrayDeque<>();

		synchronized void add(long now) {
			trim(now);
			times.addLast(now);
		}

		synchronized int size(long now) {
			trim(now);
			return times.size();
		}

		private void trim(long now) {
			long oldest = now - WINDOW_MS;
			while (!times.isEmpty() && times.peekFirst() < oldest) {
				times.removeFirst();
			}
		}
	}
}
