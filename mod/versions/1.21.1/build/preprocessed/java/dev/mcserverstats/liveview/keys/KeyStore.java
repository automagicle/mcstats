package dev.mcserverstats.liveview.keys;

import dev.mcserverstats.liveview.json.Json;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Set;

/**
 * The two Liveview keys and who may use them, in {@code config/mcstats-liveview.json}. (Files written before 2.3.0
 * also list players who had hidden themselves, as {@code opt-out-uuids}; that's no longer read.)
 *
 * <p>The viewer key lets a dashboard account watch; the control key lets it also run commands and move items. Only
 * each key's PBKDF2 hash is kept. A key that was never made is null, and nothing can be unlocked with it.
 *
 * <p>The server decides who is let in: the {@code access} list here names every dashboard account that may watch
 * or control. An account gets on it by entering a key, or by an operator allowing it by name in game, and comes
 * off it when an operator removes it or a new key is made (a new viewer key empties the list; a new control key
 * puts everyone back to watching). The dashboard is told the list and can't add to it.
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
	/** Dashboard accounts (sign-in emails, lowercased) the server lets in, and how far: watching, or controls too. */
	private final java.util.TreeMap<String, Level> access = new java.util.TreeMap<>();
	private static final java.util.regex.Pattern ACCOUNT = java.util.regex.Pattern.compile("[a-z0-9._%+@-]{3,120}");
	private static final int MAX_ACCOUNTS = 500;

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
			Json.Obj accounts = root.object("access");
			if (accounts != null) {
				for (var entry : accounts.fields().entrySet()) {
					String account = account(entry.getKey());
					Level level = entry.getValue() instanceof Json.Str str ? Level.of(str.value()) : null;
					if (account != null && level != null) {
						store.access.put(account, level);
					}
				}
			}
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

	/** An account as this file keeps it (lowercased), or null if it isn't something that could be a sign-in email. */
	public static String account(String who) {
		if (who == null) {
			return null;
		}
		String text = who.strip().toLowerCase(java.util.Locale.ROOT);
		return ACCOUNT.matcher(text).matches() && text.indexOf('@') > 0 ? text : null;
	}

	/** How far the server lets this account in: null (not at all), VIEWER, or CONTROL (which includes watching). */
	public synchronized Level access(String who) {
		String account = account(who);
		return account == null ? null : access.get(account);
	}

	/** Every account the server lets in, in name order. */
	public synchronized java.util.Map<String, Level> accessList() {
		return new java.util.LinkedHashMap<>(access);
	}

	/**
	 * Lets an account in at this level, or changes its level. Entering the viewer key never takes controls away
	 * from an account that already has them. False if nothing changed or the account can't be kept.
	 */
	public synchronized boolean allow(String who, Level level, boolean keepHigher) throws IOException {
		String account = account(who);
		if (account == null || (!access.containsKey(account) && access.size() >= MAX_ACCOUNTS)) {
			return false;
		}
		Level old = access.get(account);
		if (old == level || (keepHigher && old == Level.CONTROL)) {
			return false;
		}
		access.put(account, level);
		try {
			write();
		} catch (IOException e) {
			if (old == null) {
				access.remove(account);
			} else {
				access.put(account, old);
			}
			throw e;
		}
		return true;
	}

	/** Takes an account off the list. False if it wasn't on it. */
	public synchronized boolean remove(String who) throws IOException {
		String account = account(who);
		Level old = account == null ? null : access.remove(account);
		if (old == null) {
			return false;
		}
		try {
			write();
		} catch (IOException e) {
			access.put(account, old);
			throw e;
		}
		return true;
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
		java.util.Map<String, Level> oldAccess = new java.util.HashMap<>(access);
		if (level == Level.VIEWER) {
			viewer = next;
			access.clear(); // a new viewer key: everyone enters it again (or is allowed again by name)
		} else {
			control = next;
			access.replaceAll((account, had) -> Level.VIEWER); // a new control key: everyone is back to watching
		}
		try {
			write();
		} catch (IOException e) {
			viewer = oldViewer;
			control = oldControl;
			access.clear();
			access.putAll(oldAccess);
			throw e;
		}
		return generated.password();
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

	private void write() throws IOException {
		StringBuilder json = new StringBuilder("{\n");
		appendKey(json, "viewer", viewer);
		appendKey(json, "control", control);
		json.append("  \"access\": {");
		boolean firstAccount = true;
		for (var entry : access.entrySet()) {
			json.append(firstAccount ? "" : ", ").append('"').append(entry.getKey()).append("\": \"").append(entry.getValue().id).append('"');
			firstAccount = false;
		}
		json.append("}\n}\n");
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
