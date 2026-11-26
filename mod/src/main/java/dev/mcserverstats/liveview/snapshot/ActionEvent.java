package dev.mcserverstats.liveview.snapshot;

import java.util.UUID;

public record ActionEvent(
		long id,
		long time,
		String kind,
		UUID actor,
		String dimension,
		Integer x,
		Integer y,
		Integer z,
		String target,
		String message,
		String line) {

	public ActionEvent {
		if (kind == null || kind.isBlank()) {
			throw new IllegalArgumentException("action kind is missing");
		}
		target = target == null ? "" : target;
		message = message == null ? "" : message;
	}

	public ActionEvent withId(long nextId) {
		return new ActionEvent(nextId, time, kind, actor, dimension, x, y, z, target, message, line);
	}

	/** {@code line} is the message as the game's chat shows it, as JSON segments ({@code Stacks.line}), or null. */
	public ActionEvent withLine(String json) {
		return new ActionEvent(id, time, kind, actor, dimension, x, y, z, target, message, json);
	}

	public static ActionEvent of(
			String kind,
			UUID actor,
			String dimension,
			Integer x,
			Integer y,
			Integer z,
			String target,
			String message) {
		return new ActionEvent(0L, System.currentTimeMillis(), kind, actor, dimension, x, y, z, target, message, null);
	}
}
