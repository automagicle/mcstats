package dev.mcserverstats.liveview.hub;

import dev.mcserverstats.liveview.snapshot.ActionEvent;
import dev.mcserverstats.liveview.snapshot.EntitySample;
import dev.mcserverstats.liveview.snapshot.Look;
import dev.mcserverstats.liveview.snapshot.ParticleEvent;
import dev.mcserverstats.liveview.snapshot.InventorySample;
import dev.mcserverstats.liveview.snapshot.PlayerSample;
import dev.mcserverstats.liveview.snapshot.SectionId;
import dev.mcserverstats.liveview.snapshot.SlotSample;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

public final class Messages {
	private Messages() {
	}

	public static String hello(long serverTime, int cameraChunkRadius, int playerChunkRadius, int entityRadiusBlocks) {
		return "{\"type\":\"hello\",\"protocol\":1,\"serverTime\":"
				+ serverTime
				+ ",\"view\":{\"cameraChunkRadius\":"
				+ cameraChunkRadius
				+ ",\"playerChunkRadius\":"
				+ playerChunkRadius
				+ ",\"entityRadiusBlocks\":"
				+ entityRadiusBlocks
				+ "}}";
	}

	public static String players(List<PlayerSample> samples) {
		StringBuilder out = new StringBuilder();
		out.append("{\"type\":\"players\",\"players\":[");
		for (int i = 0; i < samples.size(); i++) {
			if (i > 0) {
				out.append(',');
			}
			player(out, samples.get(i), true);
		}
		out.append("]}");
		return out.toString();
	}

	public static String deltas(Map<UUID, PlayerSample> known, Map<UUID, PlayerSample> next) {
		StringBuilder out = new StringBuilder();
		out.append("{\"type\":\"player_deltas\",\"players\":[");
		boolean any = false;
		for (PlayerSample sample : next.values()) {
			PlayerSample previous = known.get(sample.uuid());
			if (previous == null || samePose(previous, sample)) {
				continue;
			}
			if (any) {
				out.append(',');
			}
			any = true;
			delta(out, previous, sample);
		}
		if (!any) {
			return null;
		}
		out.append("]}");
		return out.toString();
	}

	public static String remove(Collection<UUID> uuids) {
		StringBuilder out = new StringBuilder();
		out.append("{\"type\":\"player_remove\",\"uuids\":[");
		boolean first = true;
		for (UUID uuid : uuids) {
			if (!first) {
				out.append(',');
			}
			first = false;
			string(out, uuid.toString());
		}
		out.append("]}");
		return out.toString();
	}

	public static String inventory(InventorySample sample) {
		StringBuilder out = new StringBuilder();
		out.append("{\"type\":\"inventory\",\"uuid\":");
		string(out, sample.uuid().toString());
		out.append(",\"slots\":");
		slots(out, sample.slots(), true);
		if (sample.unavailable()) {
			out.append(",\"unavailable\":true");
		}
		out.append('}');
		return out.toString();
	}

	public static String inventoryDelta(UUID uuid, List<SlotSample> changed) {
		StringBuilder out = new StringBuilder();
		out.append("{\"type\":\"inventory_delta\",\"uuid\":");
		string(out, uuid.toString());
		out.append(",\"slots\":");
		slots(out, changed, false);
		out.append('}');
		return out.toString();
	}

	public static String action(ActionEvent event) {
		StringBuilder out = new StringBuilder();
		out.append("{\"type\":\"action\",\"id\":");
		out.append(event.id());
		out.append(",\"time\":");
		out.append(event.time());
		out.append(",\"kind\":");
		string(out, event.kind());
		out.append(",\"actor\":");
		uuidOrNull(out, event.actor());
		out.append(",\"dimension\":");
		if (event.dimension() == null) {
			out.append("null");
		} else {
			string(out, event.dimension());
		}
		out.append(',');
		nullableInt(out, "x", event.x());
		out.append(',');
		nullableInt(out, "y", event.y());
		out.append(',');
		nullableInt(out, "z", event.z());
		out.append(",\"target\":");
		string(out, event.target());
		out.append(",\"message\":");
		string(out, event.message());
		out.append('}');
		return out.toString();
	}

	public static String entities(Collection<EntitySample> samples) {
		StringBuilder out = new StringBuilder();
		out.append("{\"type\":\"entities\",\"entities\":[");
		boolean first = true;
		for (EntitySample sample : samples) {
			if (!first) {
				out.append(',');
			}
			first = false;
			entity(out, null, sample);
		}
		out.append("]}");
		return out.toString();
	}

	public static String entityDeltas(
			Map<Integer, EntitySample> known,
			Map<Integer, EntitySample> next,
			boolean throttled) {
		StringBuilder out = new StringBuilder();
		out.append("{\"type\":\"entity_deltas\",\"entities\":[");
		boolean any = false;
		for (EntitySample sample : next.values()) {
			EntitySample previous = known.get(sample.id());
			if (previous != null && sameEntity(previous, sample)) {
				continue;
			}
			if (any) {
				out.append(',');
			}
			any = true;
			entity(out, previous, sample);
		}
		out.append("],\"removed\":[");
		boolean removedAny = false;
		for (Integer id : known.keySet()) {
			if (next.containsKey(id)) {
				continue;
			}
			if (removedAny) {
				out.append(',');
			}
			removedAny = true;
			out.append(id.intValue());
		}
		out.append(']');
		if (throttled) {
			out.append(",\"throttled\":true");
		}
		out.append('}');
		if (!any && !removedAny && !throttled) {
			return null;
		}
		return out.toString();
	}

	public static String atlas(String url, String meta, int size) {
		StringBuilder out = new StringBuilder();
		out.append("{\"type\":\"atlas\",\"url\":");
		string(out, url);
		out.append(",\"meta\":");
		string(out, meta);
		out.append(",\"size\":").append(size).append('}');
		return out.toString();
	}

	public static String assetsError(String message) {
		StringBuilder out = new StringBuilder();
		out.append("{\"type\":\"assets_error\",\"message\":");
		string(out, message == null ? "" : message);
		out.append('}');
		return out.toString();
	}

	public static String window(String dimension, Collection<SectionId> add, Collection<SectionId> remove) {
		StringBuilder out = new StringBuilder();
		out.append("{\"type\":\"window\",\"dimension\":");
		string(out, dimension);
		out.append(",\"add\":");
		sections(out, add);
		out.append(",\"remove\":");
		sections(out, remove);
		out.append('}');
		return out.toString();
	}

	private static void sections(StringBuilder out, Collection<SectionId> ids) {
		out.append('[');
		boolean first = true;
		for (SectionId id : ids) {
			if (!first) {
				out.append(',');
			}
			first = false;
			out.append("{\"cx\":").append(id.cx()).append(",\"cz\":").append(id.cz()).append(",\"sy\":").append(id.sy()).append('}');
		}
		out.append(']');
	}

	/**
	 * {"type":"status",…}: sent to each viewer every couple of seconds. {@code control} is whether this viewer has
	 * controls switched on; {@code controlAllowed} whether the server lets the dashboard run commands at all;
	 * {@code spawn} the world spawn as JSON, or null when unknown.
	 */
	public static String status(int viewers, long droppedDeltas, boolean atlasReady, boolean control, boolean controlAllowed, double mspt,
			dev.mcserverstats.liveview.snapshot.WorldSky sky, String spawn) {
		return "{\"type\":\"status\",\"viewers\":"
				+ viewers
				+ ",\"droppedDeltas\":"
				+ droppedDeltas
				+ ",\"atlasReady\":"
				+ atlasReady
				+ ",\"control\":"
				+ control
				+ ",\"controlAllowed\":"
				+ controlAllowed
				+ ",\"mspt\":"
				+ (Double.isFinite(mspt) ? Math.round(mspt * 10.0) / 10.0 : -1)
				+ ",\"skyDarken\":"
				+ sky.skyDarken()
				+ ",\"time\":"
				+ sky.time()
				+ ",\"rain\":"
				+ Math.round(sky.rain() * 1000f) / 1000.0
				+ ",\"thunder\":"
				+ Math.round(sky.thunder() * 1000f) / 1000.0
				+ (spawn == null ? "" : ",\"spawn\":" + spawn)
				+ '}';
	}

	/** {"type":"container","dimension","x","y","z","block","kind","title":[segments],"rows","slots":[...],"missing"}. */
	public static String container(dev.mcserverstats.liveview.snapshot.ContainerView view) {
		StringBuilder out = new StringBuilder(256 + view.slots().size() * 160);
		out.append("{\"type\":\"container\",\"dimension\":");
		string(out, view.dimension());
		out.append(",\"x\":").append(view.x()).append(",\"y\":").append(view.y()).append(",\"z\":").append(view.z());
		out.append(",\"block\":");
		string(out, view.block());
		out.append(",\"kind\":");
		string(out, view.kind());
		out.append(",\"title\":").append(view.title() == null ? "[]" : view.title());
		out.append(",\"rows\":").append(view.rows());
		out.append(",\"missing\":").append(view.missing());
		out.append(",\"slots\":");
		slots(out, view.slots(), true);
		return out.append('}').toString();
	}

	/** {"type":"particles","p":[[type,x,y,z,count,dx,dy,dz,speed,block|null,color],...]}; see mod/PROTOCOL.md. */
	public static String particles(List<ParticleEvent> events) {
		StringBuilder out = new StringBuilder(64 + events.size() * 96);
		out.append("{\"type\":\"particles\",\"p\":[");
		for (int i = 0; i < events.size(); i++) {
			ParticleEvent e = events.get(i);
			if (i > 0) {
				out.append(',');
			}
			out.append('[');
			string(out, e.type());
			out.append(',').append(round2(e.x())).append(',').append(round2(e.y())).append(',').append(round2(e.z()));
			out.append(',').append(e.count());
			out.append(',').append(round2(e.dx())).append(',').append(round2(e.dy())).append(',').append(round2(e.dz()));
			out.append(',').append(round2(e.speed())).append(',');
			if (e.block() == null) {
				out.append("null");
			} else {
				string(out, e.block());
			}
			out.append(',').append(e.color()).append(']');
		}
		out.append("]}");
		return out.toString();
	}

	private static double round2(double v) {
		return Double.isFinite(v) ? Math.round(v * 100.0) / 100.0 : 0;
	}

	public static String commandResult(boolean success, List<String> lines) {
		StringBuilder out = new StringBuilder();
		out.append("{\"ok\":").append(success).append(",\"lines\":[");
		for (int i = 0; i < lines.size(); i++) {
			if (i > 0) {
				out.append(',');
			}
			string(out, lines.get(i));
		}
		out.append("]}");
		return out.toString();
	}

	public static String error(String code) {
		StringBuilder out = new StringBuilder();
		out.append("{\"type\":\"error\",\"code\":");
		string(out, code);
		out.append(",\"protocol\":1}");
		return out.toString();
	}

	private static boolean samePose(PlayerSample previous, PlayerSample sample) {
		return previous.name().equals(sample.name())
				&& previous.dimension().equals(sample.dimension())
				&& previous.x() == sample.x()
				&& previous.y() == sample.y()
				&& previous.z() == sample.z()
				&& previous.yaw() == sample.yaw()
				&& previous.pitch() == sample.pitch()
				&& sameOptional(previous, sample);
	}

	private static boolean sameOptional(PlayerSample previous, PlayerSample sample) {
		return same(previous.health(), sample.health())
				&& same(previous.maxHealth(), sample.maxHealth())
				&& same(previous.hunger(), sample.hunger())
				&& same(previous.saturation(), sample.saturation())
				&& same(previous.gameMode(), sample.gameMode())
				&& same(previous.selectedSlot(), sample.selectedSlot())
				&& same(previous.heldItem(), sample.heldItem())
				&& previous.armor().equals(sample.armor())
				&& same(previous.skin(), sample.skin())
				&& same(previous.skinModel(), sample.skinModel())
				&& same(previous.look(), sample.look());
	}

	private static boolean same(Object left, Object right) {
		return left == null ? right == null : left.equals(right);
	}

	private static void player(StringBuilder out, PlayerSample sample, boolean full) {
		out.append('{');
		field(out, "uuid", sample.uuid().toString());
		field(out, "name", sample.name());
		field(out, "dimension", sample.dimension());
		numberField(out, "x", sample.x());
		numberField(out, "y", sample.y());
		numberField(out, "z", sample.z());
		numberField(out, "yaw", sample.yaw());
		numberField(out, "pitch", sample.pitch());
		if (full) {
			optional(out, sample);
		}
		out.append('}');
	}

	private static void delta(StringBuilder out, PlayerSample previous, PlayerSample sample) {
		out.append('{');
		field(out, "uuid", sample.uuid().toString());
		if (!previous.name().equals(sample.name())) {
			field(out, "name", sample.name());
		}
		if (!previous.dimension().equals(sample.dimension())) {
			field(out, "dimension", sample.dimension());
		}
		if (previous.x() != sample.x()) {
			numberField(out, "x", sample.x());
		}
		if (previous.y() != sample.y()) {
			numberField(out, "y", sample.y());
		}
		if (previous.z() != sample.z()) {
			numberField(out, "z", sample.z());
		}
		if (previous.yaw() != sample.yaw()) {
			numberField(out, "yaw", sample.yaw());
		}
		if (previous.pitch() != sample.pitch()) {
			numberField(out, "pitch", sample.pitch());
		}
		optionalChanged(out, previous, sample);
		out.append('}');
	}

	private static void optional(StringBuilder out, PlayerSample sample) {
		if (sample.health() != null) {
			numberField(out, "health", sample.health());
		}
		if (sample.maxHealth() != null) {
			numberField(out, "maxHealth", sample.maxHealth());
		}
		if (sample.hunger() != null) {
			rawField(out, "hunger", Integer.toString(sample.hunger()));
		}
		if (sample.saturation() != null) {
			numberField(out, "saturation", sample.saturation());
		}
		if (sample.gameMode() != null) {
			field(out, "gameMode", sample.gameMode());
		}
		if (sample.selectedSlot() != null) {
			rawField(out, "selectedSlot", Integer.toString(sample.selectedSlot()));
		}
		if (sample.heldItem() != null) {
			field(out, "heldItem", sample.heldItem());
		}
		if (!sample.armor().isEmpty()) {
			out.append(",\"armor\":[");
			for (int i = 0; i < sample.armor().size(); i++) {
				if (i > 0) {
					out.append(',');
				}
				string(out, sample.armor().get(i));
			}
			out.append(']');
		}
		if (sample.skin() != null) {
			field(out, "skin", sample.skin());
		}
		if (sample.skinModel() != null) {
			field(out, "skinModel", sample.skinModel());
		}
		if (sample.look() != null) {
			look(out, sample.look());
		}
	}

	/** "look":{light,texture?,model?,variant?,wool,armor[4],dye[4],main,off,cape?}; see mod/PROTOCOL.md. */
	private static void look(StringBuilder out, Look look) {
		out.append(",\"look\":{\"light\":").append(look.light());
		if (look.texture() != null) {
			out.append(",\"texture\":");
			string(out, look.texture());
		}
		if (look.model() != null) {
			out.append(",\"model\":");
			string(out, look.model());
		}
		if (look.variant() != null) {
			out.append(",\"variant\":");
			string(out, look.variant());
		}
		out.append(",\"wool\":").append(look.wool());
		out.append(",\"armor\":[");
		for (int i = 0; i < look.armor().size(); i++) {
			if (i > 0) {
				out.append(',');
			}
			string(out, look.armor().get(i));
		}
		out.append("],\"dye\":[");
		for (int i = 0; i < look.dye().size(); i++) {
			if (i > 0) {
				out.append(',');
			}
			out.append(look.dye().get(i));
		}
		out.append("],\"main\":");
		string(out, look.mainHand());
		out.append(",\"off\":");
		string(out, look.offHand());
		if (look.cape() != null) {
			out.append(",\"cape\":");
			string(out, look.cape());
		}
		out.append(",\"foil\":").append(look.foil());
		out.append(",\"mainTint\":").append(look.mainTint());
		out.append(",\"offTint\":").append(look.offTint());
		Look.Motion m = look.motion();
		if (m != null) {
			out.append(",\"motion\":{\"pose\":");
			string(out, m.pose());
			out.append(",\"sprint\":").append(m.sprinting());
			out.append(",\"swing\":").append(m.swing());
			out.append(",\"swingOff\":").append(m.swingOff());
			out.append(",\"using\":").append(m.using());
			out.append(",\"useOff\":").append(m.useOff());
			out.append(",\"hurt\":").append(m.hurt());
			out.append(",\"riding\":").append(m.riding());
			if (m.radius() > 0) {
				out.append(",\"radius\":").append(Math.round(m.radius() * 100) / 100.0);
			}
			out.append('}');
		}
		out.append('}');
	}

	private static void slots(StringBuilder out, List<SlotSample> slots, boolean skipEmpty) {
		out.append('[');
		boolean any = false;
		for (SlotSample slot : slots) {
			if (skipEmpty && slot.empty()) {
				continue;
			}
			if (any) {
				out.append(',');
			}
			any = true;
			out.append("{\"slot\":");
			out.append(slot.slot());
			out.append(",\"item\":");
			string(out, slot.item());
			out.append(",\"count\":");
			out.append(slot.count());
			if (slot.customName() != null && !slot.customName().isBlank()) {
				out.append(",\"customName\":");
				string(out, slot.customName());
			}
			detail(out, slot.detail());
			out.append('}');
		}
		out.append(']');
	}

	/** Tooltip, glint, tint, durability and contents; see {@code ItemDetail}. The tooltip is already JSON. */
	static void detail(StringBuilder out, dev.mcserverstats.liveview.snapshot.ItemDetail detail) {
		if (detail == null) {
			return;
		}
		if (detail.foil()) {
			out.append(",\"foil\":true");
		}
		if (detail.color() >= 0) {
			out.append(",\"color\":").append(detail.color());
		}
		if (detail.maxDamage() > 0) {
			out.append(",\"damage\":").append(detail.damage()).append(",\"maxDamage\":").append(detail.maxDamage());
		}
		if (detail.tooltip() != null) {
			out.append(",\"tooltip\":").append(detail.tooltip());
		}
		if (!detail.contents().isEmpty()) {
			out.append(",\"contents\":");
			slots(out, detail.contents(), false);
		}
	}

	private static void uuidOrNull(StringBuilder out, UUID uuid) {
		if (uuid == null) {
			out.append("null");
		} else {
			string(out, uuid.toString());
		}
	}

	private static void nullableInt(StringBuilder out, String name, Integer value) {
		string(out, name);
		out.append(':');
		if (value == null) {
			out.append("null");
		} else {
			out.append(value.intValue());
		}
	}

	private static void optionalChanged(StringBuilder out, PlayerSample previous, PlayerSample sample) {
		changedNumber(out, "health", previous.health(), sample.health());
		changedNumber(out, "maxHealth", previous.maxHealth(), sample.maxHealth());
		if (!same(previous.hunger(), sample.hunger()) && sample.hunger() != null) {
			rawField(out, "hunger", Integer.toString(sample.hunger()));
		}
		changedNumber(out, "saturation", previous.saturation(), sample.saturation());
		if (!same(previous.gameMode(), sample.gameMode()) && sample.gameMode() != null) {
			field(out, "gameMode", sample.gameMode());
		}
		if (!same(previous.selectedSlot(), sample.selectedSlot()) && sample.selectedSlot() != null) {
			rawField(out, "selectedSlot", Integer.toString(sample.selectedSlot()));
		}
		if (!same(previous.heldItem(), sample.heldItem()) && sample.heldItem() != null) {
			field(out, "heldItem", sample.heldItem());
		}
		if (!previous.armor().equals(sample.armor()) && !sample.armor().isEmpty()) {
			out.append(",\"armor\":[");
			for (int i = 0; i < sample.armor().size(); i++) {
				if (i > 0) {
					out.append(',');
				}
				string(out, sample.armor().get(i));
			}
			out.append(']');
		}
		if (!same(previous.skin(), sample.skin()) && sample.skin() != null) {
			field(out, "skin", sample.skin());
		}
		if (!same(previous.skinModel(), sample.skinModel()) && sample.skinModel() != null) {
			field(out, "skinModel", sample.skinModel());
		}
		if (!same(previous.look(), sample.look()) && sample.look() != null) {
			look(out, sample.look());
		}
	}

	private static void changedNumber(StringBuilder out, String name, Number previous, Number next) {
		if (next != null && !same(previous, next)) {
			numberField(out, name, next.doubleValue());
		}
	}

	private static boolean sameEntity(EntitySample previous, EntitySample sample) {
		return same(previous.uuid(), sample.uuid())
				&& previous.type().equals(sample.type())
				&& previous.dimension().equals(sample.dimension())
				&& previous.x() == sample.x()
				&& previous.y() == sample.y()
				&& previous.z() == sample.z()
				&& previous.yaw() == sample.yaw()
				&& previous.pitch() == sample.pitch()
				&& same(previous.health(), sample.health())
				&& previous.width() == sample.width()
				&& previous.height() == sample.height()
				&& previous.baby() == sample.baby()
				&& previous.headYaw() == sample.headYaw()
				&& same(previous.item(), sample.item())
				&& same(previous.look(), sample.look());
	}

	private static void entity(StringBuilder out, EntitySample previous, EntitySample sample) {
		out.append('{');
		rawField(out, "id", Integer.toString(sample.id()));
		if (previous == null || !same(previous.uuid(), sample.uuid())) {
			out.append(",\"uuid\":");
			uuidOrNull(out, sample.uuid());
		}
		if (previous == null || !previous.type().equals(sample.type())) {
			field(out, "type", sample.type());
		}
		if (previous == null || !previous.dimension().equals(sample.dimension())) {
			field(out, "dimension", sample.dimension());
		}
		if (previous == null || previous.x() != sample.x()) {
			numberField(out, "x", sample.x());
		}
		if (previous == null || previous.y() != sample.y()) {
			numberField(out, "y", sample.y());
		}
		if (previous == null || previous.z() != sample.z()) {
			numberField(out, "z", sample.z());
		}
		if (previous == null || previous.yaw() != sample.yaw()) {
			numberField(out, "yaw", sample.yaw());
		}
		if (previous == null || previous.pitch() != sample.pitch()) {
			numberField(out, "pitch", sample.pitch());
		}
		if (previous == null || !same(previous.health(), sample.health())) {
			out.append(",\"health\":");
			if (sample.health() == null) {
				out.append("null");
			} else {
				out.append(number(sample.health()));
			}
		}
		if (previous == null || previous.width() != sample.width()) {
			numberField(out, "width", sample.width());
		}
		if (previous == null || previous.height() != sample.height()) {
			numberField(out, "height", sample.height());
		}
		if (previous == null || previous.baby() != sample.baby()) {
			rawField(out, "baby", Boolean.toString(sample.baby()));
		}
		if (previous == null || previous.headYaw() != sample.headYaw()) {
			numberField(out, "headYaw", sample.headYaw());
		}
		if (sample.item() != null && (previous == null || !sample.item().equals(previous.item()))) {
			field(out, "item", sample.item());
		}
		if (sample.look() != null && (previous == null || !sample.look().equals(previous.look()))) {
			look(out, sample.look());
		}
		out.append('}');
	}

	private static void field(StringBuilder out, String name, String value) {
		if (out.charAt(out.length() - 1) != '{') {
			out.append(',');
		}
		string(out, name);
		out.append(':');
		string(out, value);
	}

	private static void rawField(StringBuilder out, String name, String jsonValue) {
		if (out.charAt(out.length() - 1) != '{') {
			out.append(',');
		}
		string(out, name);
		out.append(':');
		out.append(jsonValue);
	}

	private static void numberField(StringBuilder out, String name, double value) {
		rawField(out, name, number(value));
	}

	private static String number(double value) {
		if (!Double.isFinite(value)) {
			return "0.0";
		}
		if (value == Math.rint(value) && Math.abs(value) < 1.0e15) {
			return Long.toString((long) value) + ".0";
		}
		String text = Double.toString(value);
		if (text.indexOf('E') >= 0 || text.indexOf('e') >= 0) {
			return String.format(Locale.ROOT, "%.4f", value);
		}
		return text;
	}

	/** Appends {@code value} as a JSON string. */
	public static void appendString(StringBuilder out, String value) {
		string(out, value);
	}

	private static void string(StringBuilder out, String value) {
		out.append('"');
		for (int i = 0; i < value.length(); i++) {
			char c = value.charAt(i);
			switch (c) {
				case '"' -> out.append("\\\"");
				case '\\' -> out.append("\\\\");
				case '\b' -> out.append("\\b");
				case '\f' -> out.append("\\f");
				case '\n' -> out.append("\\n");
				case '\r' -> out.append("\\r");
				case '\t' -> out.append("\\t");
				default -> {
					if (c < 0x20) {
						out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
					} else {
						out.append(c);
					}
				}
			}
		}
		out.append('"');
	}
}
