package dev.mcserverstats.liveview.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class Json {
	private Json() {
	}

	public sealed interface Value permits Obj, Arr, Str, Num, Bool, Nil {
	}

	public record Obj(Map<String, Value> fields) implements Value {
		public Value get(String key) {
			return fields.get(key);
		}

		public Obj object(String key) {
			return get(key) instanceof Obj obj ? obj : null;
		}

		public Arr array(String key) {
			return get(key) instanceof Arr arr ? arr : null;
		}

		public String string(String key) {
			return get(key) instanceof Str str ? str.value() : null;
		}

		public Boolean bool(String key) {
			return get(key) instanceof Bool bool ? bool.value() : null;
		}

		public Integer integer(String key) {
			if (!(get(key) instanceof Num num) || !Double.isFinite(num.value())) {
				return null;
			}
			double value = num.value();
			if (value != Math.rint(value) || value < Integer.MIN_VALUE || value > Integer.MAX_VALUE) {
				return null;
			}
			return (int) value;
		}

		public Double number(String key) {
			if (!(get(key) instanceof Num num) || !Double.isFinite(num.value())) {
				return null;
			}
			return num.value();
		}
	}

	public record Arr(List<Value> items) implements Value {
	}

	public record Str(String value) implements Value {
	}

	public record Num(double value) implements Value {
	}

	public record Bool(boolean value) implements Value {
	}

	public record Nil() implements Value {
	}

	public static final class JsonException extends Exception {
		public JsonException(String message) {
			super(message);
		}
	}

	public static Value parse(String text) throws JsonException {
		if (text == null) {
			throw new JsonException("missing json");
		}
		Parser parser = new Parser(text);
		Value value = parser.readValue();
		parser.skip();
		if (parser.index != text.length()) {
			throw new JsonException("trailing data");
		}
		return value;
	}

	private static final class Parser {
		private final String text;
		private int index;
		private int depth;

		private Parser(String text) {
			this.text = text;
		}

		private Value readValue() throws JsonException {
			skip();
			if (index >= text.length()) {
				throw error("unexpected end");
			}
			char c = text.charAt(index);
			return switch (c) {
				case '{' -> object();
				case '[' -> array();
				case '"' -> new Str(string());
				case 't' -> literal("true", new Bool(true));
				case 'f' -> literal("false", new Bool(false));
				case 'n' -> literal("null", new Nil());
				default -> number();
			};
		}

		private Obj object() throws JsonException {
			enter();
			expect('{');
			Map<String, Value> fields = new LinkedHashMap<>();
			skip();
			if (peek('}')) {
				index++;
				depth--;
				return new Obj(fields);
			}
			while (true) {
				skip();
				String key = string();
				skip();
				expect(':');
				fields.put(key, readValue());
				skip();
				if (peek('}')) {
					index++;
					depth--;
					return new Obj(fields);
				}
				expect(',');
			}
		}

		private Arr array() throws JsonException {
			enter();
			expect('[');
			List<Value> items = new ArrayList<>();
			skip();
			if (peek(']')) {
				index++;
				depth--;
				return new Arr(items);
			}
			while (true) {
				items.add(readValue());
				skip();
				if (peek(']')) {
					index++;
					depth--;
					return new Arr(items);
				}
				expect(',');
			}
		}

		private String string() throws JsonException {
			expect('"');
			StringBuilder out = new StringBuilder();
			while (index < text.length()) {
				char c = text.charAt(index++);
				if (c == '"') {
					return out.toString();
				}
				if (c == '\\') {
					if (index >= text.length()) {
						throw error("bad escape");
					}
					char escaped = text.charAt(index++);
					switch (escaped) {
						case '"', '\\', '/' -> out.append(escaped);
						case 'b' -> out.append('\b');
						case 'f' -> out.append('\f');
						case 'n' -> out.append('\n');
						case 'r' -> out.append('\r');
						case 't' -> out.append('\t');
						case 'u' -> out.append(unicode());
						default -> throw error("bad escape");
					}
				} else if (c < 0x20) {
					throw error("raw control character");
				} else {
					out.append(c);
				}
			}
			throw error("unterminated string");
		}

		private char unicode() throws JsonException {
			if (index + 4 > text.length()) {
				throw error("bad unicode escape");
			}
			int code = 0;
			for (int i = 0; i < 4; i++) {
				char c = text.charAt(index++);
				int digit = Character.digit(c, 16);
				if (digit < 0) {
					throw error("bad unicode escape");
				}
				code = (code << 4) + digit;
			}
			return (char) code;
		}

		private Value literal(String word, Value value) throws JsonException {
			if (!text.startsWith(word, index)) {
				throw error("expected " + word);
			}
			index += word.length();
			return value;
		}

		private Num number() throws JsonException {
			int start = index;
			if (peek('-')) {
				index++;
			}
			if (index >= text.length() || !Character.isDigit(text.charAt(index))) {
				throw error("expected number");
			}
			if (text.charAt(index) == '0') {
				index++;
			} else {
				while (index < text.length() && Character.isDigit(text.charAt(index))) {
					index++;
				}
			}
			if (peek('.')) {
				index++;
				if (index >= text.length() || !Character.isDigit(text.charAt(index))) {
					throw error("expected fraction");
				}
				while (index < text.length() && Character.isDigit(text.charAt(index))) {
					index++;
				}
			}
			if (peek('e') || peek('E')) {
				index++;
				if (peek('+') || peek('-')) {
					index++;
				}
				if (index >= text.length() || !Character.isDigit(text.charAt(index))) {
					throw error("expected exponent");
				}
				while (index < text.length() && Character.isDigit(text.charAt(index))) {
					index++;
				}
			}
			String token = text.substring(start, index);
			try {
				return new Num(Double.parseDouble(token));
			} catch (NumberFormatException e) {
				throw error("bad number");
			}
		}

		private void enter() throws JsonException {
			if (++depth > 32) {
				throw error("json too deep");
			}
		}

		private void skip() {
			while (index < text.length()) {
				char c = text.charAt(index);
				if (c != ' ' && c != '\n' && c != '\r' && c != '\t') {
					return;
				}
				index++;
			}
		}

		private boolean peek(char c) {
			return index < text.length() && text.charAt(index) == c;
		}

		private void expect(char c) throws JsonException {
			if (!peek(c)) {
				throw error("expected '" + c + "'");
			}
			index++;
		}

		private JsonException error(String message) {
			return new JsonException(message + " at " + index);
		}
	}
}
