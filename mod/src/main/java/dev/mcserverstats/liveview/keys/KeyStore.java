package dev.mcserverstats.liveview.keys;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.json.Json;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * The two Liveview keys and the players who opted out, in {@code config/mcstats-liveview.json}.
 *
 * <p>The viewer key lets a dashboard account watch; the control key lets it also run commands and move items. Only
 * each key's PBKDF2 hash is kept, with a random id that changes whenever the key does: the dashboard remembers which
 * id an account was let in with, so replacing a key ends every account's access under the old one. A key that was
 * never made is null, and nothing can be unlocked with it.
 */
public final class KeyStore {
	public static final String FILE_NAME = "mcstats-liveview.json";

	public enum Level {
		VIEWER("viewer"), CONTROL("control");

		public final String id;

		Level(String id) {
			this.id = id;
		}

		public static Level of(String id) {
			for (Level level : values()) {
				if (level.id.equals(id)) {
					return level;
				}
			}
			return null;
		}
	}

	/** One key: its id and hash. */
	public record Key(String id, byte[] salt, byte[] hash, int iterations) {
		Passwords passwords() {
			return new Passwords(salt, hash, iterations);
		}
	}

	private final Path path;
	private Key viewer;
	private Key control;
	private Set<UUID> optOut = Set.of();

	private KeyStore(Path path) {
		this.path = path;
	}

	/** Reads the file, or starts empty when there is none. An unreadable file is left alone and reported. */
	public static KeyStore load(Path configDir) throws IOException {
		KeyStore store = new KeyStore(configDir.resolve(FILE_NAME));
		if (Files.notExists(store.path)) {
			return store;
		}
		try {
			if (!(Json.parse(Files.readString(store.path, StandardCharsets.UTF_8)) instanceof Json.Obj root)) {
				throw new Json.JsonException("the root must be an object");
			}
			store.viewer = readKey(root.object("viewer"));
			store.control = readKey(root.object("control"));
			store.optOut = readOptOut(root.array("opt-out-uuids"));
		} catch (RuntimeException | Json.JsonException e) {
			throw new IOException("config/" + FILE_NAME + " could not be read (" + e.getMessage() + ")", e);
		}
		return store;
	}

	/** An empty store that will replace whatever is in the file the first time it saves. */
	public static KeyStore fresh(Path configDir) {
		return new KeyStore(configDir.resolve(FILE_NAME));
	}

	public synchronized String id(Level level) {
		Key key = level == Level.VIEWER ? viewer : control;
		return key == null ? null : key.id();
	}

	public synchronized Set<UUID> optOut() {
		return optOut;
	}

	/** Whether {@code candidate} is the current key of that kind. Slow on purpose (PBKDF2): call it off the server thread. */
	public boolean verify(Level level, String candidate) {
		Key key;
		synchronized (this) {
			key = level == Level.VIEWER ? viewer : control;
		}
		return key != null && candidate != null && key.passwords().verify(candidate);
	}

	/** Makes a new key of that kind, saves its hash and returns the key itself, which is kept nowhere. */
	public synchronized String reset(Level level) throws IOException {
		Passwords.Generated generated = Passwords.generate();
		byte[] id = new byte[6];
		new SecureRandom().nextBytes(id);
		Key next = new Key(HexFormat.of().formatHex(id), generated.salt(), generated.hash(), generated.iterations());
		Key oldViewer = viewer, oldControl = control;
		if (level == Level.VIEWER) {
			viewer = next;
		} else {
			control = next;
		}
		try {
			write();
		} catch (IOException e) {
			viewer = oldViewer;
			control = oldControl;
			throw e;
		}
		return generated.password();
	}

	public synchronized void saveOptOut(Set<UUID> ids) throws IOException {
		Set<UUID> old = optOut;
		optOut = Set.copyOf(ids);
		try {
			write();
		} catch (IOException e) {
			optOut = old;
			throw e;
		}
	}

	private static Key readKey(Json.Obj obj) throws Json.JsonException {
		if (obj == null) {
			return null;
		}
		String id = obj.string("id");
		Integer iterations = obj.integer("iterations");
		String salt = obj.string("salt");
		String hash = obj.string("hash");
		if (id == null || !id.matches("[0-9a-f]{8,32}") || iterations == null || iterations < Passwords.ITERATIONS || salt == null || hash == null) {
			throw new Json.JsonException("a key is incomplete or weaker than PBKDF2-HMAC-SHA256 with " + Passwords.ITERATIONS + " iterations");
		}
		try {
			byte[] saltBytes = Base64.getDecoder().decode(salt);
			byte[] hashBytes = Base64.getDecoder().decode(hash);
			if (saltBytes.length != 16 || hashBytes.length == 0) {
				throw new Json.JsonException("a key's salt must be 16 bytes");
			}
			return new Key(id, saltBytes, hashBytes, iterations);
		} catch (IllegalArgumentException e) {
			throw new Json.JsonException("a key's salt or hash is not base64");
		}
	}

	private static Set<UUID> readOptOut(Json.Arr array) {
		if (array == null) {
			return Set.of();
		}
		List<UUID> ids = new ArrayList<>();
		for (Json.Value item : array.items()) {
			if (!(item instanceof Json.Str str)) {
				continue;
			}
			try {
				ids.add(UUID.fromString(str.value()));
			} catch (IllegalArgumentException e) {
				LogOnce.warn("opt-out-" + str.value(), "Liveview skipped an opt-out uuid that is not a UUID", e);
			}
		}
		return Set.copyOf(ids);
	}

	private void write() throws IOException {
		StringBuilder json = new StringBuilder("{\n");
		appendKey(json, "viewer", viewer);
		appendKey(json, "control", control);
		json.append("  \"opt-out-uuids\": [");
		boolean first = true;
		for (UUID uuid : optOut) {
			json.append(first ? "" : ", ").append('"').append(uuid).append('"');
			first = false;
		}
		json.append("]\n}\n");
		Files.createDirectories(path.getParent());
		Path tmp = path.resolveSibling(path.getFileName() + ".tmp");
		Files.writeString(tmp, json, StandardCharsets.UTF_8);
		try {
			Files.setPosixFilePermissions(tmp, Set.of(
					java.nio.file.attribute.PosixFilePermission.OWNER_READ,
					java.nio.file.attribute.PosixFilePermission.OWNER_WRITE));
		} catch (UnsupportedOperationException ignored) {
			// Windows has no POSIX modes. The file only holds hashes.
		}
		try {
			Files.move(tmp, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
		} catch (AtomicMoveNotSupportedException e) {
			Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING);
		}
	}

	private static void appendKey(StringBuilder json, String name, Key key) {
		if (key == null) {
			return;
		}
		json.append("  \"").append(name).append("\": {\"id\": \"").append(key.id())
				.append("\", \"algorithm\": \"PBKDF2WithHmacSHA256\", \"iterations\": ").append(key.iterations())
				.append(", \"salt\": \"").append(Base64.getEncoder().encodeToString(key.salt()))
				.append("\", \"hash\": \"").append(Base64.getEncoder().encodeToString(key.hash())).append("\"},\n");
	}
}
