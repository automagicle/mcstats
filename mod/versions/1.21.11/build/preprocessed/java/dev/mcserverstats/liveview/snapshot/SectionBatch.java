package dev.mcserverstats.liveview.snapshot;

import java.util.List;

/** Result of one server-tick snapshot pass: copied sections, sections whose chunk is not loaded, and requests left for the next tick. */
public record SectionBatch(List<SectionSnapshot> snapshots, List<SectionId> unloaded, List<SectionId> deferred) {
	public SectionBatch {
		snapshots = snapshots == null ? List.of() : List.copyOf(snapshots);
		unloaded = unloaded == null ? List.of() : List.copyOf(unloaded);
		deferred = deferred == null ? List.of() : List.copyOf(deferred);
	}
}
