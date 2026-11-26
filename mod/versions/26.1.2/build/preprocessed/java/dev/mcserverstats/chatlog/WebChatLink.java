package dev.mcserverstats.chatlog;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.LongUnaryOperator;
import java.util.function.Supplier;
import java.util.regex.Pattern;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

// Chat sent from the dashboard: keeps one WebSocket open to the Worker (/api/ingest/link, next to
// the chat url) and hands each message it brings to the game. The Worker decides who may send
// (players whose login email is on the roster); this side checks the message is well formed,
// posts it in game chat on the server thread and answers whether that worked.
//
// Whispers go both ways (1.8.0): "/w Name text" typed on the dashboard comes down as a whisper for
// Name, and a whisper typed in game to someone who's only on the website goes up (ChatLogMod decides
// that, from the list of who's on the website the dashboard sends whenever it changes).
//
// Reconnects by itself with backoff, and pings every 30 seconds so a dead connection is noticed.
final class WebChatLink {
	// Answers "" if the message was shown, or why it wasn't. Called on a background thread.
	// name is null for an admin (shown with an [Admin] tag instead of a name).
	interface Handler {
		// claim is asked once, on the server thread, right before showing the message: false means the
		// wait ran out and the sender was already told no, so it must not be shown (and never answer).
		CompletableFuture<String> say(String name, String text, BooleanSupplier claim);

		// The same for a whisper to one player in game (`to`); from is null for an admin.
		CompletableFuture<String> whisper(String from, String to, String text, BooleanSupplier claim);

		// The dashboard has a newer version of this mod (2.1.0): { current, latest, urgent, urgent_why: [],
		// changes: [], more, jar }, sent each time the connection opens while this one is out of date.
		default void update(JsonObject m) {}
	}

	// Liveview (2.0.0) borrows this connection for three small things: telling the dashboard whether it's on
	// and which keys exist, checking a key an admin typed on the dashboard, and being asked to open its own
	// connection when someone wants to watch. The view itself never travels here.
	interface Live {
		// What to tell the dashboard, as a {"type":"liveview",…} message; null when there's nothing to say yet.
		String info();

		// The dashboard has someone who wants to watch.
		void open();

		// Checks a key ("viewer" or "control") typed by the dashboard account `who`. Calls done with
		// (error, keyId): error is null when the key is right, and keyId then says which key it was.
		void verify(String level, String key, String who, java.util.function.BiConsumer<String, String> done);
	}

	private static final long PING_MS = 30_000;
	private static final long DEAD_MS = 75_000;
	// the dashboard saying this long (in its answers to the online list) that it doesn't have the connection
	private static final long DASHBOARD_LOST_MS = 40_000;
	private static final long CONNECT_STUCK_MS = 60_000; // a connect attempt that hasn't finished by now
	private static final long MAX_BACKOFF_MS = 2 * 60_000;
	private static final long MISSING_BACKOFF_MS = 10 * 60_000; // an older dashboard without the endpoint
	private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_.]{1,32}");
	static final int MAX_TEXT = 256;

	private final Supplier<Config> config;
	private final LongUnaryOperator dashboardLostFor;
	private final String userAgent;
	private final Handler handler;
	private volatile Live live;
	// this server's pages on the dashboard ("https://…/s/<server>/"), as its hello said; null until then
	private volatile String page;
	private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

	private ScheduledExecutorService exec;
	private volatile WebSocket socket;
	private volatile long lastHeard;
	private volatile boolean connecting;
	private volatile long nextAttempt;
	private volatile long backoff;
	private volatile String lastWarning;
	private volatile Config connectedWith;
	private volatile long connectedAt;
	private volatile long connectStarted;
	// roster players with the dashboard open, lowercased name -> name (from the dashboard)
	private volatile Map<String, String> webPlayers = Map.of();
	// whispers sent up to the dashboard, waiting for its answer: id -> what to do if it says no
	private final Map<String, Consumer<String>> waiting = new ConcurrentHashMap<>();
	// account requests sent up (2.3.0), waiting for the dashboard's answer: id -> what to do with it
	private final Map<String, Consumer<JsonObject>> asked = new ConcurrentHashMap<>();

	// dashboardLostFor(since): how long the dashboard has been saying, since then, that it doesn't have
	// this connection (Uploader.linkDownFor).
	WebChatLink(Supplier<Config> config, LongUnaryOperator dashboardLostFor, String userAgent, Handler handler) {
		this.config = config;
		this.dashboardLostFor = dashboardLostFor;
		this.userAgent = userAgent;
		this.handler = handler;
	}

	void live(Live live) {
		this.live = live;
	}

	// Liveview's settings or keys changed: tell the dashboard, if connected.
	void sendLiveInfo() {
		WebSocket ws = socket;
		Live l = live;
		String info = ws == null || l == null ? null : l.info();
		if (info != null) send(ws, info);
	}

	void start() {
		if (exec != null) return;
		exec = Executors.newSingleThreadScheduledExecutor(r -> {
			Thread t = new Thread(r, "mcstats-web-chat");
			t.setDaemon(true);
			return t;
		});
		exec.scheduleWithFixedDelay(this::tick, 2, 2, TimeUnit.SECONDS);
	}

	void stop() {
		if (exec == null) return;
		exec.shutdownNow();
		exec = null;
		close("server stopping");
	}

	// Every 2 seconds: connect if needed, ping, and notice dead or outdated connections.
	private void tick() {
		try {
			Config c = config.get();
			boolean wanted = c.ready() && c.webChat();
			WebSocket ws = socket;
			if (ws != null && (!wanted || !c.equals(connectedWith))) {
				close(wanted ? "settings changed" : "web chat turned off");
				ws = null;
			}
			long now = System.currentTimeMillis();
			if (ws != null) {
				if (now - lastHeard > DEAD_MS) {
					ChatLogMod.LOG.warn("Web chat connection went quiet; reconnecting");
					close("no answer");
				} else if (dashboardLostFor.applyAsLong(connectedAt) >= DASHBOARD_LOST_MS) {
					// open as far as this side can tell, but the dashboard no longer has it (say, after a deploy)
					ChatLogMod.LOG.warn("The dashboard lost the web chat connection; reconnecting");
					close("the dashboard lost it");
				} else if (now - lastHeard > PING_MS) {
					send(ws, "ping");
				}
				return;
			}
			if (connecting && now - connectStarted > CONNECT_STUCK_MS) {
				connecting = false; // its answer, if it ever comes, is dropped (see connect)
				fail("connecting took too long", 0);
			}
			if (!wanted || connecting || now < nextAttempt) return;
			connect(c);
		} catch (Throwable t) {
			ChatLogMod.LOG.error("Web chat failed unexpectedly", t);
		}
	}

	private void connect(Config c) {
		URI uri;
		try {
			uri = URI.create(c.url().replaceFirst("/chat/?$", "/link").replaceFirst("^http", "ws"));
		} catch (IllegalArgumentException e) {
			fail("the url isn't valid", MAX_BACKOFF_MS);
			return;
		}
		connecting = true;
		long attempt = System.currentTimeMillis();
		connectStarted = attempt;
		WebSocket.Builder b = http.newWebSocketBuilder()
				.connectTimeout(Duration.ofSeconds(15))
				.header("Authorization", "Bearer " + c.token())
				.header("User-Agent", userAgent);
		if (!c.accessClientId().isEmpty()) {
			b.header("CF-Access-Client-Id", c.accessClientId());
			b.header("CF-Access-Client-Secret", c.accessClientSecret());
		}
		b.buildAsync(uri, new Listener()).whenComplete((ws, err) -> {
			if (connectStarted != attempt || !connecting) { // given up on as stuck; a newer attempt may be under way
				if (ws != null) ws.abort();
				return;
			}
			connecting = false;
			if (err != null) {
				Throwable cause = err.getCause() != null ? err.getCause() : err;
				if (cause instanceof WebSocketHandshakeException h) {
					int status = h.getResponse().statusCode();
					String type = h.getResponse().headers().firstValue("Content-Type").orElse("");
					if (status == 404 && type.contains("application/json")) {
						fail("the dashboard doesn't have web chat yet (update it with npm run deploy)", MISSING_BACKOFF_MS);
					} else {
						fail(Uploader.why(status, !type.contains("application/json")), 0);
					}
				} else {
					fail("couldn't reach the dashboard (" + cause.getClass().getSimpleName()
							+ (cause.getMessage() != null ? ": " + cause.getMessage() : "") + ")", 0);
				}
				return;
			}
			socket = ws;
			connectedWith = c;
			lastHeard = System.currentTimeMillis();
			connectedAt = lastHeard;
			backoff = 0;
			ChatLogMod.LOG.info("Web chat connected; messages sent from the dashboard will show in game");
			lastWarning = null;
			sendLiveInfo();
		});
	}

	// The name of a roster player with the dashboard open, as the dashboard has it, or null. Only while
	// connected (a whisper to them couldn't be passed on otherwise).
	String webPlayer(String name) {
		return socket == null || name == null ? null : webPlayers.get(name.toLowerCase());
	}

	// Everyone on the website, while connected.
	java.util.Collection<String> webPlayers() {
		return socket == null ? java.util.List.of() : webPlayers.values();
	}

	// Passes a whisper typed in game up to the dashboard, for a player who's only on the website.
	// onRefused runs (on a background thread) with the reason if the dashboard says no or doesn't
	// answer. False if it couldn't be sent at all.
	boolean whisperUp(String from, String to, String text, Consumer<String> onRefused) {
		WebSocket ws = socket;
		if (ws == null) return false;
		String id = UUID.randomUUID().toString();
		JsonObject m = new JsonObject();
		m.addProperty("type", "whisper");
		m.addProperty("id", id);
		m.addProperty("from", from);
		m.addProperty("to", to);
		m.addProperty("text", text);
		waiting.put(id, onRefused);
		send(ws, m.toString());
		ScheduledExecutorService e = exec;
		if (e != null) {
			try {
				e.schedule(() -> {
					Consumer<String> c = waiting.remove(id);
					if (c != null) c.accept("the website didn't answer");
				}, 8, TimeUnit.SECONDS);
			} catch (RuntimeException ignored) { } // stopping
		}
		return true;
	}

	// A player's mcstats account (2.3.0, the dashboard's src/connect.js): action "status", "connect" (with the
	// email they typed) or "disconnect". done gets the dashboard's answer, { ok, error?, email?, confirmed?,
	// emailed?, page? }, on a background thread; if the website isn't connected or doesn't answer in time,
	// { ok: false, error, offline: true }.
	void account(String action, UUID player, String name, String email, Consumer<JsonObject> done) {
		WebSocket ws = socket;
		if (ws == null) {
			done.accept(offline("the server isn't connected to the mcstats website right now"));
			return;
		}
		String id = UUID.randomUUID().toString();
		JsonObject m = new JsonObject();
		m.addProperty("type", "account");
		m.addProperty("id", id);
		m.addProperty("action", action);
		m.addProperty("uuid", player.toString());
		m.addProperty("name", name);
		if (email != null) m.addProperty("email", email);
		asked.put(id, done);
		send(ws, m.toString());
		ScheduledExecutorService e = exec;
		if (e != null) {
			try {
				e.schedule(() -> {
					Consumer<JsonObject> c = asked.remove(id);
					if (c != null) c.accept(offline("the website didn't answer"));
				}, 8, TimeUnit.SECONDS);
			} catch (RuntimeException ignored) { } // stopping
		}
	}

	private static JsonObject offline(String why) {
		JsonObject o = new JsonObject();
		o.addProperty("ok", false);
		o.addProperty("error", why);
		o.addProperty("offline", true);
		return o;
	}

	private void close(String why) {
		WebSocket ws = socket;
		socket = null;
		if (ws != null) {
			try {
				ws.sendClose(WebSocket.NORMAL_CLOSURE, why).orTimeout(3, TimeUnit.SECONDS);
			} catch (Exception ignored) { }
			ws.abort();
		}
	}

	private void fail(String why, long wait) {
		backoff = wait > 0 ? wait : Math.min(MAX_BACKOFF_MS, Math.max(5_000, backoff * 2));
		nextAttempt = System.currentTimeMillis() + backoff;
		if (!why.equals(lastWarning)) {
			ChatLogMod.LOG.warn("Web chat isn't connected: {}. Retrying in {}s", why, backoff / 1000);
			lastWarning = why;
		}
	}

	private void dropped(WebSocket ws, String why) {
		if (socket != ws) return; // already replaced or closed on purpose
		socket = null;
		ChatLogMod.LOG.info("Web chat disconnected ({}); reconnecting", why);
		nextAttempt = System.currentTimeMillis() + 3_000;
	}

	String page() {
		return page;
	}

	private void handle(WebSocket ws, String message) {
		if (message.equals("pong")) return;
		JsonObject m;
		try {
			m = JsonParser.parseString(message).getAsJsonObject();
		} catch (Exception e) {
			return;
		}
		String type = m.has("type") ? m.get("type").getAsString() : "";
		if (type.equals("hello")) { // the dashboard's greeting; from 2.2.0's dashboard it says where this server's pages are
			if (m.has("page") && m.get("page").isJsonPrimitive()) {
				String p = m.get("page").getAsString();
				if (p.matches("https?://[A-Za-z0-9.:-]+(/[A-Za-z0-9._~/-]*)?/")) page = p;
			}
			return;
		}
		if (type.equals("web")) { // who's on the website now
			Map<String, String> names = new java.util.HashMap<>();
			if (m.has("names") && m.get("names").isJsonArray()) {
				for (JsonElement n : m.getAsJsonArray("names")) {
					if (n.isJsonPrimitive() && NAME.matcher(n.getAsString()).matches()) names.put(n.getAsString().toLowerCase(), n.getAsString());
				}
			}
			webPlayers = Map.copyOf(names);
			return;
		}
		if (type.equals("ack")) { // the dashboard's answer to a whisper or account request sent up
			Consumer<JsonObject> a = m.has("id") ? asked.remove(m.get("id").getAsString()) : null;
			if (a != null) {
				a.accept(m);
				return;
			}
			Consumer<String> c = m.has("id") ? waiting.remove(m.get("id").getAsString()) : null;
			if (c != null && !(m.has("ok") && m.get("ok").getAsBoolean())) {
				c.accept(m.has("error") ? m.get("error").getAsString() : "the website refused it");
			}
			return;
		}
		if (type.equals("update")) { // a newer mod is out (2.1.0)
			handler.update(m);
			return;
		}
		if (type.equals("liveview_open")) { // someone on the dashboard wants to watch
			Live l = live;
			if (l != null) l.open();
			return;
		}
		if (type.equals("liveview_key") && m.has("id")) { // a Liveview key typed on the dashboard: { id, level, key, who }
			String id = m.get("id").getAsString();
			Live l = live;
			if (l == null) {
				ack(ws, id, "off");
				return;
			}
			String level = m.has("level") ? m.get("level").getAsString() : "";
			String key = m.has("key") ? m.get("key").getAsString() : "";
			String who = m.has("who") ? m.get("who").getAsString() : "";
			if (key.isEmpty() || key.length() > 256) {
				ack(ws, id, "wrong");
				return;
			}
			l.verify(level, key, who, (error, keyId) -> {
				JsonObject a = new JsonObject();
				a.addProperty("type", "ack");
				a.addProperty("id", id);
				a.addProperty("ok", error == null);
				if (error != null) a.addProperty("error", error);
				if (keyId != null) a.addProperty("key_id", keyId);
				send(ws, a.toString());
			});
			return;
		}
		if (!(type.equals("say") || type.equals("whisper")) || !m.has("id")) return;
		String id = m.get("id").getAsString();
		if (type.equals("whisper")) {
			handleWhisper(ws, id, m);
			return;
		}
		boolean admin = m.has("admin") && m.get("admin").getAsBoolean();
		String name = admin ? null : m.has("name") ? m.get("name").getAsString() : "";
		String text = m.has("text") ? clean(m.get("text").getAsString()) : "";
		if ((!admin && !NAME.matcher(name).matches()) || text.isEmpty()) {
			ack(ws, id, "bad message");
			return;
		}
		// Either the server thread takes the message within 4 seconds and its answer is the truth, or the
		// wait wins and the message is dropped: never "busy" for a message that then shows anyway.
		AtomicBoolean taken = new AtomicBoolean();
		handler.say(name, text, () -> taken.compareAndSet(false, true))
				.whenComplete((error, err) -> ack(ws, id, err != null ? "the server couldn't show it" : error));
		ScheduledExecutorService e = exec;
		if (e != null) {
			try {
				e.schedule(() -> {
					if (taken.compareAndSet(false, true)) ack(ws, id, "the server is too busy to show it");
				}, 4, TimeUnit.SECONDS);
			} catch (RuntimeException ignored) { } // stopping
		}
	}

	// A whisper typed on the dashboard, for one player in game: { id, name | admin, to, text }.
	private void handleWhisper(WebSocket ws, String id, JsonObject m) {
		boolean admin = m.has("admin") && m.get("admin").getAsBoolean();
		String name = admin ? null : m.has("name") ? m.get("name").getAsString() : "";
		String to = m.has("to") ? m.get("to").getAsString() : "";
		String text = m.has("text") ? clean(m.get("text").getAsString()) : "";
		if ((!admin && !NAME.matcher(name).matches()) || !NAME.matcher(to).matches() || text.isEmpty()) {
			ack(ws, id, "bad message");
			return;
		}
		AtomicBoolean taken = new AtomicBoolean();
		handler.whisper(name, to, text, () -> taken.compareAndSet(false, true))
				.whenComplete((error, err) -> ack(ws, id, err != null ? "the server couldn't show it" : error));
		ScheduledExecutorService e = exec;
		if (e != null) {
			try {
				e.schedule(() -> {
					if (taken.compareAndSet(false, true)) ack(ws, id, "the server is too busy to show it");
				}, 4, TimeUnit.SECONDS);
			} catch (RuntimeException ignored) { } // stopping
		}
	}

	// The socket allows one send at a time (a second one while the first is still going out throws),
	// and answers come from the server thread while pings come from this one's: each waits its turn.
	private CompletableFuture<?> sending = CompletableFuture.completedFuture(null);

	private synchronized void send(WebSocket ws, String text) {
		sending = sending.handle((x, err) -> null).thenCompose(x -> ws.sendText(text, true)).exceptionally(err -> {
			ChatLogMod.LOG.debug("Couldn't send on the web chat connection", err);
			return null;
		});
	}

	private void ack(WebSocket ws, String id, String error) {
		JsonObject a = new JsonObject();
		a.addProperty("type", "ack");
		a.addProperty("id", id);
		a.addProperty("ok", error == null || error.isEmpty());
		if (error != null && !error.isEmpty()) a.addProperty("error", error);
		send(ws, a.toString());
	}

	// One line of plain text: no control characters or § formatting codes.
	static String clean(String s) {
		String t = s.replaceAll("[\\p{Cntrl}]+", " ").replaceAll("§.?", "").strip();
		return t.length() > MAX_TEXT ? t.substring(0, MAX_TEXT) : t;
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
				if (message.length() <= 8192) handle(ws, message);
			}
			ws.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onPong(WebSocket ws, java.nio.ByteBuffer message) {
			lastHeard = System.currentTimeMillis();
			ws.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onClose(WebSocket ws, int code, String reason) {
			dropped(ws, reason == null || reason.isEmpty() ? "code " + code : reason);
			return null;
		}

		@Override
		public void onError(WebSocket ws, Throwable error) {
			dropped(ws, error.getClass().getSimpleName());
		}
	}
}
