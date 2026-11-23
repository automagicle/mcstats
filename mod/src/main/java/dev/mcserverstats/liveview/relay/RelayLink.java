package dev.mcserverstats.liveview.relay;

import dev.mcserverstats.liveview.AdminCommands;
import dev.mcserverstats.liveview.LiveviewRuntime;
import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.assets.AssetStore;
import dev.mcserverstats.liveview.hub.Messages;
import dev.mcserverstats.liveview.hub.Outbound;
import dev.mcserverstats.liveview.hub.PlayerHub;
import dev.mcserverstats.liveview.json.Json;
import dev.mcserverstats.liveview.snapshot.SectionId;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Liveview's one connection to the dashboard. The mod dials out, as it does for web chat, so the server needs no open
 * port and no certificate: browsers talk to the dashboard (behind its sign-in), and the dashboard's relay passes
 * frames between them and this socket.
 *
 * <p>The socket only exists while someone watches. The dashboard asks for it over the web chat connection
 * ({@link #request}); it is closed again a minute after the last viewer leaves.
 *
 * <p>From the relay, text frames whose first character says what they are:
 * <pre>
 *   o{"v":3,"who":"a@b.c","control":false}   a viewer opened the page (v is its number on this socket)
 *   g3                                       viewer 3 left
 *   c{"v":3,"on":true}                       viewer 3 switched controls on or off (the dashboard checked the control key)
 *   m3 {...}                                 a message from viewer 3's page, as the page sent it
 *   a{"id":7,"name":"&lt;sha256&gt;.png"}          the dashboard wants an asset (texture atlas, models, a skin)
 *   pong
 * </pre>
 * To the relay: {@code ping}; {@code x{"v":3,"code":"bad_message"}} to drop a viewer; and binary frames:
 * <pre>
 *   0x01, then per viewer: u16 viewer, u32 length, and that many bytes of frames for the page, each
 *         u8 kind (0 JSON text, 1 a binary section frame), u32 length, payload
 *   0x02, u32 asset request id, u8 flags (1 last chunk, 2 no such asset), u16 content type length, content type, bytes
 * </pre>
 * Everything for the pages is gathered into one frame every {@value #BATCH_MS} ms, however many viewers there are,
 * because the relay is billed per frame it receives.
 */
public final class RelayLink {
	/** Where and how to connect: the dashboard's {@code /api/ingest/liveview}, with the same credentials as chat. */
	public record Target(URI uri, String token, String accessClientId, String accessClientSecret, String userAgent) {
	}

	/** Someone watching, for {@code /liveview who}. */
	public record Watcher(String who, boolean control, long sinceMs) {
	}

	private static final int BATCH_MS = 50;
	private static final int MAX_BATCH_BYTES = 512 * 1024;
	private static final int ASSET_CHUNK_BYTES = 256 * 1024;
	private static final int MAX_TEXT_BYTES = 8 * 1024;
	private static final int MAX_COMMAND_CHARS = 1024;
	private static final long PING_MS = 20_000;
	private static final long DEAD_MS = 70_000;
	private static final long IDLE_CLOSE_MS = 60_000;
	private static final long STATUS_MS = 2_000;
	private static final long CAMERA_INTERVAL_MS = 100;
	private static final long SEND_TIMEOUT_SECONDS = 20;
	private static final int COMMANDS_PER_10S = 40;
	private static final double MAX_HORIZONTAL = 3.0e7;
	private static final double MAX_VERTICAL = 4096;
	private static final Pattern DIMENSION = Pattern.compile("[a-z0-9_.-]{1,64}:[a-z0-9_./-]{1,128}");

	private final Supplier<Target> target;
	private final LiveviewRuntime runtime;
	private final PlayerHub hub;
	private final AssetStore assets;
	private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

	/** Guards {@link #texts} and {@link #assetJobs} and is what the sender waits on. */
	private final Object work = new Object();
	private final ArrayDeque<String> texts = new ArrayDeque<>();
	private final ArrayDeque<AssetJob> assetJobs = new ArrayDeque<>();
	private final Map<Integer, Viewer> viewers = new ConcurrentHashMap<>();

	private volatile WebSocket socket;
	private volatile boolean connecting;
	private volatile boolean closed;
	private volatile long lastHeard;
	private volatile long lastViewerAt;
	private volatile String lastFailure;

	public RelayLink(Supplier<Target> target, LiveviewRuntime runtime, PlayerHub hub, AssetStore assets) {
		this.target = target;
		this.runtime = runtime;
		this.hub = hub;
		this.assets = assets;
	}

	/** The dashboard has someone who wants to watch: connect, unless already connected or connecting. */
	public void request() {
		if (closed || !runtime.enabled()) {
			return;
		}
		Target t = target.get();
		if (t == null) {
			return;
		}
		synchronized (this) {
			if (socket != null || connecting) {
				return;
			}
			connecting = true;
		}
		WebSocket.Builder builder = http.newWebSocketBuilder()
				.connectTimeout(Duration.ofSeconds(15))
				.header("Authorization", "Bearer " + t.token())
				.header("User-Agent", t.userAgent());
		if (!t.accessClientId().isEmpty()) {
			builder.header("CF-Access-Client-Id", t.accessClientId());
			builder.header("CF-Access-Client-Secret", t.accessClientSecret());
		}
		builder.buildAsync(t.uri(), new Listener()).whenComplete((ws, error) -> {
			if (error != null || closed) {
				connecting = false;
				if (ws != null) {
					ws.abort();
				}
				if (error != null) {
					Throwable cause = error.getCause() != null ? error.getCause() : error;
					String why = cause.getClass().getSimpleName() + (cause.getMessage() != null ? ": " + cause.getMessage() : "");
					if (!why.equals(lastFailure)) {
						lastFailure = why;
						LogOnce.logger().warn("Liveview couldn't connect to the dashboard ({})", why);
					}
				}
				return;
			}
			long now = System.currentTimeMillis();
			lastHeard = now;
			lastViewerAt = now;
			lastFailure = null;
			socket = ws;
			connecting = false;
			Thread.ofVirtual().name("mcstats-liveview-relay").start(() -> sendLoop(ws));
			LogOnce.logger().info("Liveview connected to the dashboard");
		});
	}

	/** Server stopping, or Liveview turned off. */
	public void close(String why) {
		closed = true;
		disconnect(why);
	}

	/** The viewer key changed: everyone watching has to enter the new one. */
	public void dropViewers(String why) {
		disconnect(why);
	}

	/** The control key changed (or controls were turned off): every viewer goes back to watching only. */
	public void lockControls() {
		for (Viewer viewer : viewers.values()) {
			viewer.control = false;
			viewer.queue.enqueue(runtime.status(false), false);
		}
	}

	/** The server took controls away from one account. */
	public void lockControls(String account) {
		for (Viewer viewer : viewers.values()) {
			if (viewer.who.equalsIgnoreCase(account) && viewer.control) {
				viewer.control = false;
				viewer.queue.enqueue(runtime.status(false), false);
			}
		}
	}

	/** The server took one account off its list: its pages are disconnected. */
	public void dropAccount(String account, String why) {
		for (Viewer viewer : List.copyOf(viewers.values())) {
			if (viewer.who.equalsIgnoreCase(account)) {
				text("x{\"v\":" + viewer.id + ",\"code\":\"denied\"}");
				gone(viewer.id);
			}
		}
	}

	public List<Watcher> watchers() {
		List<Watcher> out = new ArrayList<>();
		for (Viewer viewer : viewers.values()) {
			out.add(new Watcher(viewer.who, viewer.control, viewer.since));
		}
		return out;
	}

	private void disconnect(String why) {
		WebSocket ws = socket;
		socket = null;
		dropAll();
		if (ws != null) {
			try {
				ws.sendClose(WebSocket.NORMAL_CLOSURE, why).orTimeout(3, TimeUnit.SECONDS);
			} catch (RuntimeException ignored) {
				// Already closing.
			}
			ws.abort();
		}
		synchronized (work) {
			texts.clear();
			assetJobs.clear();
			work.notifyAll();
		}
	}

	private void dropAll() {
		for (Integer id : List.copyOf(viewers.keySet())) {
			gone(id);
		}
	}

	private void lost(WebSocket ws, String why) {
		if (socket != ws) {
			return;
		}
		socket = null;
		dropAll();
		synchronized (work) {
			texts.clear();
			assetJobs.clear();
			work.notifyAll();
		}
		LogOnce.logger().info("Liveview disconnected from the dashboard ({})", why);
	}

	// ---------- inbound ----------

	private void handle(WebSocket ws, String message) {
		if (message.isEmpty() || message.equals("pong")) {
			return;
		}
		char op = message.charAt(0);
		String rest = message.substring(1);
		try {
			switch (op) {
				case 'o' -> {
					if (Json.parse(rest) instanceof Json.Obj obj) {
						open(obj);
					}
				}
				case 'g' -> gone(Integer.parseInt(rest.trim()));
				case 'c' -> {
					if (Json.parse(rest) instanceof Json.Obj obj && obj.integer("v") != null) {
						control(obj.integer("v"), Boolean.TRUE.equals(obj.bool("on")));
					}
				}
				case 'm' -> {
					int space = rest.indexOf(' ');
					if (space > 0) {
						Viewer viewer = viewers.get(Integer.parseInt(rest.substring(0, space)));
						if (viewer != null) {
							viewerMessage(viewer, rest.substring(space + 1));
						}
					}
				}
				case 'a' -> {
					if (Json.parse(rest) instanceof Json.Obj obj && obj.integer("id") != null) {
						synchronized (work) {
							if (assetJobs.size() < 64) {
								assetJobs.addLast(new AssetJob(obj.integer("id"), obj.string("name")));
							}
							work.notifyAll();
						}
					}
				}
				default -> LogOnce.info("relay-op-" + op, "Liveview ignored an unknown message from the dashboard");
			}
		} catch (Json.JsonException | NumberFormatException e) {
			LogOnce.warn("relay-bad", "Liveview ignored a malformed message from the dashboard", e);
		} catch (Throwable thrown) {
			LogOnce.warn("relay-handle", "Liveview failed to handle a message from the dashboard", thrown);
		}
	}

	private void open(Json.Obj obj) {
		Integer id = obj.integer("v");
		if (id == null || id < 0 || id > 0xFFFF) {
			return;
		}
		if (!runtime.enabled()) {
			text("x{\"v\":" + id + ",\"code\":\"off\"}");
			return;
		}
		String who = clean(obj.string("who"));
		// The dashboard has its own checks, but the server's list is the one that counts.
		if (!runtime.mayWatch(who)) {
			text("x{\"v\":" + id + ",\"code\":\"denied\"}");
			LogOnce.logger().info("Liveview: {} tried to watch but isn't on the server's list", who);
			return;
		}
		gone(id); // a number reused before its "gone" arrived
		Viewer viewer = new Viewer(id, who);
		viewer.control = Boolean.TRUE.equals(obj.bool("control")) && runtime.mayControl(who);
		viewers.put(id, viewer);
		lastViewerAt = System.currentTimeMillis();
		runtime.ensureAssets();
		hub.attach(viewer.queue);
		viewer.queue.enqueue(runtime.status(viewer.control), false);
		LogOnce.logger().info("Liveview: {} is watching", who);
	}

	private void gone(int id) {
		Viewer viewer = viewers.remove(id);
		if (viewer == null) {
			return;
		}
		viewer.queue.shutdown();
		hub.detach(viewer.queue);
		lastViewerAt = System.currentTimeMillis();
		LogOnce.logger().info("Liveview: {} stopped watching", viewer.who);
	}

	private void control(int id, boolean on) {
		Viewer viewer = viewers.get(id);
		if (viewer == null) {
			return;
		}
		boolean next = on && runtime.mayControl(viewer.who);
		if (next != viewer.control) {
			viewer.control = next;
			LogOnce.logger().info("Liveview: {} switched controls {}", viewer.who, next ? "on" : "off");
		}
		viewer.queue.enqueue(runtime.status(viewer.control), false);
	}

	private void fail(Viewer viewer, String code) {
		text("x{\"v\":" + viewer.id + ",\"code\":\"" + code + "\"}");
		gone(viewer.id);
	}

	/** One message from a viewer's page: the same protocol the page always spoke, plus {@code command}. */
	private void viewerMessage(Viewer viewer, String message) {
		if (message.getBytes(StandardCharsets.UTF_8).length > MAX_TEXT_BYTES) {
			fail(viewer, "oversize");
			return;
		}
		Json.Value parsed;
		try {
			parsed = Json.parse(message);
		} catch (Json.JsonException e) {
			fail(viewer, "bad_message");
			return;
		}
		if (!(parsed instanceof Json.Obj obj)) {
			fail(viewer, "bad_message");
			return;
		}
		Double protocol = obj.number("protocol");
		if (protocol != null && protocol != 1.0d) {
			fail(viewer, "protocol_mismatch");
			return;
		}
		String type = obj.string("type");
		if (type == null) {
			fail(viewer, "bad_message");
			return;
		}
		Outbound queue = viewer.queue;
		switch (type) {
			case "subscribe_inventory", "unsubscribe_inventory" -> {
				UUID uuid;
				try {
					String raw = obj.string("uuid");
					uuid = raw == null ? null : UUID.fromString(raw);
				} catch (IllegalArgumentException e) {
					uuid = null;
				}
				if (uuid == null) {
					fail(viewer, "bad_message");
				} else if (type.equals("subscribe_inventory")) {
					hub.subscribeInventory(queue, uuid);
				} else {
					hub.unsubscribeInventory(queue, uuid);
				}
			}
			case "camera" -> camera(viewer, obj);
			case "open_container" -> {
				String dimension = obj.string("dimension");
				Integer x = obj.integer("x"), y = obj.integer("y"), z = obj.integer("z");
				if (!position(dimension, x, y, z)) {
					fail(viewer, "bad_message");
				} else {
					hub.openContainer(queue, dimension, x, y, z);
				}
			}
			case "close_container" -> hub.closeContainer(queue);
			case "container_move" -> containerMove(viewer, obj);
			case "command" -> command(viewer, obj);
			default -> LogOnce.info("inbound-" + type, "Liveview ignored a page message of type " + type);
		}
	}

	private static boolean position(String dimension, Integer x, Integer y, Integer z) {
		return dimension != null && DIMENSION.matcher(dimension).matches() && x != null && y != null && z != null
				&& Math.abs(x) <= MAX_HORIZONTAL && Math.abs(z) <= MAX_HORIZONTAL && Math.abs(y) <= MAX_VERTICAL;
	}

	private void camera(Viewer viewer, Json.Obj obj) {
		String dimension = obj.string("dimension");
		Double x = obj.number("x"), y = obj.number("y"), z = obj.number("z");
		if (dimension == null || !DIMENSION.matcher(dimension).matches() || !finite(x, MAX_HORIZONTAL) || !finite(y, MAX_VERTICAL) || !finite(z, MAX_HORIZONTAL)) {
			fail(viewer, "bad_message");
			return;
		}
		long now = System.currentTimeMillis();
		if (dimension.equals(viewer.cameraDimension) && now - viewer.cameraAt < CAMERA_INTERVAL_MS) {
			return;
		}
		viewer.cameraAt = now;
		viewer.cameraDimension = dimension;
		hub.camera(viewer.queue, dimension, x, y, z);
	}

	private static boolean finite(Double value, double limit) {
		return value != null && Double.isFinite(value) && Math.abs(value) <= limit;
	}

	/**
	 * {"type":"command","id","command"}: runs as the server console and answers {"type":"command_result","id","ok",
	 * "lines"}, or "locked":true when this viewer hasn't switched controls on (which needs the control key).
	 */
	private void command(Viewer viewer, Json.Obj obj) {
		Double rawId = obj.number("id");
		long id = rawId == null ? 0 : rawId.longValue();
		if (!viewer.control || !runtime.mayControl(viewer.who)) {
			viewer.queue.enqueue("{\"type\":\"command_result\",\"id\":" + id + ",\"ok\":false,\"locked\":true,\"lines\":[\"Controls are locked.\"]}", false);
			return;
		}
		String command = obj.string("command");
		if (command != null) {
			command = command.strip();
			if (command.startsWith("/")) {
				command = command.substring(1);
			}
		}
		if (command == null || command.isEmpty() || command.length() > MAX_COMMAND_CHARS || command.indexOf('\n') >= 0 || command.indexOf('\r') >= 0) {
			viewer.queue.enqueue(commandResult(id, false, List.of("That isn't a command the server can run.")), false);
			return;
		}
		if (!viewer.mayRunCommand()) {
			viewer.queue.enqueue(commandResult(id, false, List.of("Too many commands at once; wait a few seconds.")), false);
			return;
		}
		AdminCommands commands = runtime.commands();
		if (commands == null) {
			viewer.queue.enqueue(commandResult(id, false, List.of("The server is still starting.")), false);
			return;
		}
		LogOnce.logger().info("Liveview command from {}: /{}", viewer.who, command);
		commands.run(command).orTimeout(10, TimeUnit.SECONDS).whenComplete((outcome, error) -> {
			if (error instanceof java.util.concurrent.TimeoutException) {
				viewer.queue.enqueue(commandResult(id, false, List.of("The server did not finish the command within 10 seconds.")), false);
			} else if (error != null || outcome == null) {
				viewer.queue.enqueue(commandResult(id, false, List.of("The command failed: " + (error == null ? "no result" : String.valueOf(error.getMessage())))), false);
			} else {
				viewer.queue.enqueue(commandResult(id, outcome.success(), outcome.lines()), false);
			}
		});
	}

	private static String commandResult(long id, boolean ok, List<String> lines) {
		String body = Messages.commandResult(ok, lines); // {"ok":…,"lines":[…]}
		return "{\"type\":\"command_result\",\"id\":" + id + "," + body.substring(1);
	}

	/** Moving items in an open container: needs controls on, like commands. Answers {"type":"container_result",…}. */
	private void containerMove(Viewer viewer, Json.Obj obj) {
		Double rawId = obj.number("id");
		long id = rawId == null ? 0 : rawId.longValue();
		Outbound out = viewer.queue;
		if (!viewer.control || !runtime.mayControl(viewer.who)) {
			out.enqueue("{\"type\":\"container_result\",\"id\":" + id + ",\"ok\":false,\"locked\":true,\"message\":\"Controls are locked.\"}", false);
			return;
		}
		String dimension = obj.string("dimension");
		Integer x = obj.integer("x"), y = obj.integer("y"), z = obj.integer("z");
		Integer fromSlot = obj.integer("fromSlot"), toSlot = obj.integer("toSlot"), amount = obj.integer("amount");
		String from = obj.string("from"), to = obj.string("to"), rawPlayer = obj.string("player");
		UUID player;
		try {
			player = rawPlayer == null || rawPlayer.isEmpty() ? null : UUID.fromString(rawPlayer);
		} catch (IllegalArgumentException e) {
			player = null;
		}
		if (!position(dimension, x, y, z) || fromSlot == null || toSlot == null || amount == null || amount < 0 || amount > 2
				|| !("c".equals(from) || "p".equals(from)) || !("c".equals(to) || "p".equals(to))) {
			out.enqueue("{\"type\":\"container_result\",\"id\":" + id + ",\"ok\":false,\"message\":\"That move doesn't make sense.\"}", false);
			return;
		}
		AdminCommands commands = runtime.commands();
		if (commands == null) {
			out.enqueue("{\"type\":\"container_result\",\"id\":" + id + ",\"ok\":false,\"message\":\"The server is still starting.\"}", false);
			return;
		}
		// what was moved is logged by the move itself (ContainerEditor), right after this line
		LogOnce.logger().info("Liveview item move by {}:", viewer.who);
		commands.moveItem(new AdminCommands.ItemMove(dimension, x, y, z, player, "c".equals(from), fromSlot, "c".equals(to), toSlot, amount))
				.whenComplete((outcome, error) -> {
					boolean ok = error == null && outcome != null && outcome.success();
					String message = error != null || outcome == null || outcome.lines().isEmpty() ? "" : outcome.lines().get(0);
					StringBuilder json = new StringBuilder("{\"type\":\"container_result\",\"id\":").append(id).append(",\"ok\":").append(ok).append(",\"message\":");
					Messages.appendString(json, message);
					out.enqueue(json.append('}').toString(), false);
					hub.refreshSoon();
				});
	}

	private static String clean(String who) {
		if (who == null || who.isBlank()) {
			return "someone";
		}
		String text = who.replaceAll("[\\p{Cntrl}\\s]+", " ").strip();
		return text.length() > 120 ? text.substring(0, 120) : text;
	}

	// ---------- outbound ----------

	private void text(String frame) {
		synchronized (work) {
			if (texts.size() < 256) {
				texts.addLast(frame);
			}
			work.notifyAll();
		}
	}

	private void wake() {
		synchronized (work) {
			work.notifyAll();
		}
	}

	private boolean hasWork() {
		if (!texts.isEmpty() || !assetJobs.isEmpty()) {
			return true;
		}
		for (Viewer viewer : viewers.values()) {
			if (viewer.queue.pendingCount() > 0) {
				return true;
			}
		}
		return false;
	}

	/** The only thread that writes to the socket: java.net.http allows one send at a time. */
	private void sendLoop(WebSocket ws) {
		long lastBatch = 0, lastPing = System.currentTimeMillis(), lastStatus = 0;
		AssetJob job = null;
		int jobOffset = 0;
		try {
			while (socket == ws) {
				String textFrame = null;
				synchronized (work) {
					if (!hasWork() && job == null) {
						work.wait(500);
					}
					textFrame = texts.pollFirst();
					if (job == null) {
						job = assetJobs.pollFirst();
						jobOffset = 0;
					}
				}
				long now = System.currentTimeMillis();
				if (now - lastHeard > DEAD_MS) {
					lost(ws, "no answer");
					ws.abort();
					return;
				}
				if (viewers.isEmpty() && now - lastViewerAt > IDLE_CLOSE_MS) {
					disconnect("nobody is watching");
					return;
				}
				if (textFrame != null) {
					ws.sendText(textFrame, true).get(SEND_TIMEOUT_SECONDS, TimeUnit.SECONDS);
					continue;
				}
				if (now - lastPing > PING_MS) {
					lastPing = now;
					ws.sendText("ping", true).get(SEND_TIMEOUT_SECONDS, TimeUnit.SECONDS);
				}
				if (now - lastStatus > STATUS_MS) {
					lastStatus = now;
					for (Viewer viewer : viewers.values()) {
						viewer.queue.enqueue(runtime.status(viewer.control), true);
					}
				}
				if (job != null) {
					AssetStore.Entry entry = assets.get(job.name());
					byte[] bytes = entry == null ? new byte[0] : entry.bytes();
					int length = Math.min(ASSET_CHUNK_BYTES, bytes.length - jobOffset);
					boolean last = jobOffset + length >= bytes.length;
					byte[] type = (entry == null ? "" : entry.contentType()).getBytes(StandardCharsets.UTF_8);
					ByteBuffer chunk = ByteBuffer.allocate(8 + type.length + length);
					chunk.put((byte) 2).putInt(job.id()).put((byte) ((last ? 1 : 0) | (entry == null ? 2 : 0)));
					chunk.putShort((short) type.length).put(type).put(bytes, jobOffset, length).flip();
					ws.sendBinary(chunk, true).get(SEND_TIMEOUT_SECONDS, TimeUnit.SECONDS);
					jobOffset += length;
					if (last) {
						job = null;
					}
				}
				// one frame for every viewer, at most every BATCH_MS
				long wait = BATCH_MS - (System.currentTimeMillis() - lastBatch);
				if (wait > 0 && job == null) {
					Thread.sleep(wait);
				}
				if (System.currentTimeMillis() - lastBatch >= BATCH_MS) {
					byte[] batch = batch();
					if (batch != null) {
						lastBatch = System.currentTimeMillis();
						ws.sendBinary(ByteBuffer.wrap(batch), true).get(SEND_TIMEOUT_SECONDS, TimeUnit.SECONDS);
					}
				}
			}
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		} catch (Throwable thrown) {
			lost(ws, thrown.getClass().getSimpleName() + (thrown.getMessage() != null ? ": " + thrown.getMessage() : ""));
			ws.abort();
		}
	}

	/** Everything waiting for the pages, up to {@link #MAX_BATCH_BYTES}; null when there is nothing. */
	private byte[] batch() {
		ByteArrayOutputStream out = null;
		int budget = MAX_BATCH_BYTES;
		for (Viewer viewer : viewers.values()) {
			if (budget <= 0) {
				break;
			}
			byte[] frames = viewer.queue.drain(budget);
			if (frames == null) {
				continue;
			}
			if (out == null) {
				out = new ByteArrayOutputStream(frames.length + 16);
				out.write(1);
			}
			out.write(viewer.id >>> 8);
			out.write(viewer.id);
			writeInt(out, frames.length);
			out.writeBytes(frames);
			budget -= frames.length;
		}
		return out == null ? null : out.toByteArray();
	}

	private static void writeInt(ByteArrayOutputStream out, int value) {
		out.write(value >>> 24);
		out.write(value >>> 16);
		out.write(value >>> 8);
		out.write(value);
	}

	private record AssetJob(int id, String name) {
	}

	/** One page watching. Its queue is what the hubs write to; the sender drains it into the next batch. */
	private final class Viewer {
		private final int id;
		private final String who;
		private final long since = System.currentTimeMillis();
		private final ViewerQueue queue = new ViewerQueue();
		private volatile boolean control;
		private long cameraAt;
		private String cameraDimension;
		private final ArrayDeque<Long> commandTimes = new ArrayDeque<>();

		private Viewer(int id, String who) {
			this.id = id;
			this.who = who;
		}

		private synchronized boolean mayRunCommand() {
			long now = System.currentTimeMillis();
			while (!commandTimes.isEmpty() && now - commandTimes.peekFirst() > 10_000) {
				commandTimes.removeFirst();
			}
			if (commandTimes.size() >= COMMANDS_PER_10S) {
				return false;
			}
			commandTimes.addLast(now);
			return true;
		}
	}

	/**
	 * A viewer's outbound queue, with the rules the page's own socket always had: at most 256 waiting; when it is full,
	 * droppable messages (movement) go first, then the oldest terrain section (the hub sends it again), then the oldest
	 * message.
	 */
	private final class ViewerQueue implements Outbound {
		private static final int CAP = 256;
		private final Object lock = new Object();
		private final ArrayDeque<Item> pending = new ArrayDeque<>();
		private boolean open = true;
		private int sections;

		@Override
		public boolean enqueue(String json, boolean droppable) {
			SectionId evicted = null;
			synchronized (lock) {
				if (!open) {
					return false;
				}
				if (pending.size() >= CAP) {
					if (droppable) {
						hub.noteDroppedDelta();
						LogOnce.warn("outbound-drop", "Liveview dropped a movement update because a viewer is behind", null);
						return false;
					}
					evicted = makeRoom();
				}
				pending.addLast(new Item(json.getBytes(StandardCharsets.UTF_8), false, null, droppable));
			}
			if (evicted != null) {
				hub.sectionDropped(this, evicted);
			}
			wake();
			return true;
		}

		@Override
		public boolean enqueueSection(byte[] frame, SectionId id) {
			SectionId evicted = null;
			boolean accepted;
			synchronized (lock) {
				if (!open) {
					return false;
				}
				if (pending.size() >= CAP) {
					evicted = makeRoom();
				}
				accepted = pending.size() < CAP;
				if (accepted) {
					pending.addLast(new Item(frame, true, id, false));
					sections++;
				}
			}
			if (evicted != null) {
				hub.sectionDropped(this, evicted);
			}
			if (!accepted) {
				hub.sectionDropped(this, id);
			} else {
				wake();
			}
			return accepted;
		}

		private SectionId makeRoom() {
			var iterator = pending.iterator();
			while (iterator.hasNext()) {
				if (iterator.next().droppable()) {
					iterator.remove();
					hub.noteDroppedDelta();
					LogOnce.warn("outbound-drop", "Liveview dropped a queued message because a viewer is behind", null);
					return null;
				}
			}
			iterator = pending.iterator();
			while (iterator.hasNext()) {
				Item item = iterator.next();
				if (item.binary()) {
					iterator.remove();
					sections--;
					LogOnce.warn("outbound-drop-section", "Liveview dropped a queued section frame because a viewer is behind; it is resent", null);
					return item.section();
				}
			}
			if (!pending.isEmpty()) {
				pending.removeFirst();
				LogOnce.warn("outbound-drop", "Liveview dropped a queued message because a viewer is behind", null);
			}
			return null;
		}

		/** Frames for the page, as many as fit in {@code budget} bytes (always at least one); null when empty. */
		private byte[] drain(int budget) {
			synchronized (lock) {
				if (pending.isEmpty()) {
					return null;
				}
				ByteArrayOutputStream out = new ByteArrayOutputStream(Math.min(budget, 64 * 1024));
				while (!pending.isEmpty()) {
					Item item = pending.peekFirst();
					if (out.size() > 0 && out.size() + 5 + item.bytes().length > budget) {
						break;
					}
					pending.removeFirst();
					if (item.binary()) {
						sections--;
					}
					out.write(item.binary() ? 1 : 0);
					writeInt(out, item.bytes().length);
					out.writeBytes(item.bytes());
				}
				return out.toByteArray();
			}
		}

		@Override
		public int pendingCount() {
			synchronized (lock) {
				return pending.size();
			}
		}

		@Override
		public int pendingSections() {
			synchronized (lock) {
				return sections;
			}
		}

		@Override
		public void close() {
			shutdown();
		}

		private void shutdown() {
			synchronized (lock) {
				open = false;
				pending.clear();
				sections = 0;
			}
		}

		private record Item(byte[] bytes, boolean binary, SectionId section, boolean droppable) {
		}
	}

	private final class Listener implements WebSocket.Listener {
		private final StringBuilder parts = new StringBuilder();

		@Override
		public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
			lastHeard = System.currentTimeMillis();
			parts.append(data);
			if (last) {
				String message = parts.toString();
				parts.setLength(0);
				if (message.length() <= 2 * MAX_TEXT_BYTES) {
					handle(ws, message);
				}
			} else if (parts.length() > 4 * MAX_TEXT_BYTES) {
				parts.setLength(0);
			}
			ws.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onBinary(WebSocket ws, ByteBuffer data, boolean last) {
			ws.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onPong(WebSocket ws, ByteBuffer message) {
			lastHeard = System.currentTimeMillis();
			ws.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onClose(WebSocket ws, int code, String reason) {
			lost(ws, reason == null || reason.isEmpty() ? "code " + code : reason);
			return null;
		}

		@Override
		public void onError(WebSocket ws, Throwable error) {
			lost(ws, error.getClass().getSimpleName());
		}
	}
}
