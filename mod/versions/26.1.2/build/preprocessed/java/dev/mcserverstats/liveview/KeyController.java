package dev.mcserverstats.liveview;

import dev.mcserverstats.liveview.keys.KeyStore;
import java.util.function.Consumer;

/** Making or replacing a Liveview key. The work runs off the server thread; {@code done} is called from a worker. */
public interface KeyController {
	void resetKey(KeyStore.Level level, Consumer<Result> done);

	/** Every dashboard account the server lets in, and how far. */
	java.util.Map<String, KeyStore.Level> accessList();

	/**
	 * Lets an account in by name ({@code level} VIEWER or CONTROL), or takes it off the list ({@code level} null).
	 * Answers with a sentence to show whoever ran the command.
	 */
	void setAccess(String account, KeyStore.Level level, Consumer<String> done);

	/** Exactly one of {@code key} and {@code error} is set. The key is shown once and kept nowhere. */
	record Result(String key, String error) {
		public static Result failed(String error) {
			return new Result(null, error);
		}
	}
}
