package dev.mcserverstats.liveview.hub;

import dev.mcserverstats.liveview.snapshot.SectionId;

public interface Outbound {
	boolean enqueue(String json, boolean droppable);

	/** Queues a binary kind 1 frame. Never called while the implementation's own lock is held by the caller. */
	boolean enqueueSection(byte[] frame, SectionId id);

	int pendingCount();

	int pendingSections();

	void close();
}
