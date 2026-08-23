package io.argus.quantcore.server.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal, dependency-free JSON parser/writer. No Maven dependency was added for this — the
 * bridge's payload shapes (tick envelopes, indicator snapshots, strategy context/signals) are
 * small and fully known, so a compact recursive-descent parser plus a value-graph writer covers
 * everything the local IPC bridge needs without pulling in Jackson/Gson.
 *
 * The parsed value graph uses: {@code Map<String,Object>} (object), {@code List<Object>} (array),
 * {@code String}, {@code Double}, {@code Boolean}, or {@code null} — the same shape
 * {@code JSON.parse} would hand back in JavaScript.
 */
public final class Json {

    private Json() {
    }

    // ---------- Writing ----------

    public static String write(Object value) {
        StringBuilder sb = new StringBuilder();
        writeValue(value, sb);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static void writeValue(Object value, StringBuilder sb) {
        if (value == null) {
            sb.append("null");
        } else if (value instanceof String s) {
            writeString(s, sb);
        } else if (value instanceof Boolean b) {
            sb.append(b);
        } else if (value instanceof Double d) {
            if (d.isNaN() || d.isInfinite()) {
                sb.append("null"); // JSON has no NaN/Infinity - never fabricate a number
            } else if (d == Math.floor(d) && !d.isInfinite()) {
                sb.append(d.longValue());
            } else {
                sb.append(d);
            }
        } else if (value instanceof Number n) {
            sb.append(n);
        } else if (value instanceof Map<?, ?> map) {
            sb.append('{');
            boolean first = true;
            for (var entry : map.entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeString(String.valueOf(entry.getKey()), sb);
                sb.append(':');
                writeValue(entry.getValue(), sb);
            }
            sb.append('}');
        } else if (value instanceof List<?> list) {
            sb.append('[');
            boolean first = true;
            for (Object item : list) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeValue(item, sb);
            }
            sb.append(']');
        } else {
            throw new IllegalArgumentException("Unsupported JSON value type: " + value.getClass());
        }
    }

    private static void writeString(String s, StringBuilder sb) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
    }

    // ---------- Parsing ----------

    public static Object parse(String json) {
        Parser p = new Parser(json);
        p.skipWhitespace();
        Object value = p.parseValue();
        p.skipWhitespace();
        if (!p.atEnd()) {
            throw new JsonParseException("Unexpected trailing content at position " + p.pos);
        }
        return value;
    }

    public static class JsonParseException extends RuntimeException {
        public JsonParseException(String message) {
            super(message);
        }
    }

    private static final class Parser {
        private final String src;
        private int pos = 0;

        Parser(String src) {
            this.src = src;
        }

        boolean atEnd() {
            return pos >= src.length();
        }

        void skipWhitespace() {
            while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) {
                pos++;
            }
        }

        char peek() {
            if (atEnd()) {
                throw new JsonParseException("Unexpected end of input at position " + pos);
            }
            return src.charAt(pos);
        }

        void expect(char c) {
            if (atEnd() || src.charAt(pos) != c) {
                throw new JsonParseException("Expected '" + c + "' at position " + pos);
            }
            pos++;
        }

        Object parseValue() {
            skipWhitespace();
            char c = peek();
            return switch (c) {
                case '{' -> parseObject();
                case '[' -> parseArray();
                case '"' -> parseString();
                case 't', 'f' -> parseBoolean();
                case 'n' -> parseNull();
                default -> parseNumber();
            };
        }

        Map<String, Object> parseObject() {
            Map<String, Object> map = new LinkedHashMap<>();
            expect('{');
            skipWhitespace();
            if (peek() == '}') {
                pos++;
                return map;
            }
            while (true) {
                skipWhitespace();
                String key = parseString();
                skipWhitespace();
                expect(':');
                Object value = parseValue();
                map.put(key, value);
                skipWhitespace();
                char c = peek();
                if (c == ',') {
                    pos++;
                } else if (c == '}') {
                    pos++;
                    break;
                } else {
                    throw new JsonParseException("Expected ',' or '}' at position " + pos);
                }
            }
            return map;
        }

        List<Object> parseArray() {
            List<Object> list = new ArrayList<>();
            expect('[');
            skipWhitespace();
            if (peek() == ']') {
                pos++;
                return list;
            }
            while (true) {
                list.add(parseValue());
                skipWhitespace();
                char c = peek();
                if (c == ',') {
                    pos++;
                } else if (c == ']') {
                    pos++;
                    break;
                } else {
                    throw new JsonParseException("Expected ',' or ']' at position " + pos);
                }
            }
            return list;
        }

        String parseString() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = peek();
                pos++;
                if (c == '"') {
                    break;
                }
                if (c == '\\') {
                    char esc = peek();
                    pos++;
                    switch (esc) {
                        case '"' -> sb.append('"');
                        case '\\' -> sb.append('\\');
                        case '/' -> sb.append('/');
                        case 'n' -> sb.append('\n');
                        case 'r' -> sb.append('\r');
                        case 't' -> sb.append('\t');
                        case 'b' -> sb.append('\b');
                        case 'f' -> sb.append('\f');
                        case 'u' -> {
                            String hex = src.substring(pos, pos + 4);
                            sb.append((char) Integer.parseInt(hex, 16));
                            pos += 4;
                        }
                        default -> throw new JsonParseException("Invalid escape at position " + pos);
                    }
                } else {
                    sb.append(c);
                }
            }
            return sb.toString();
        }

        Boolean parseBoolean() {
            if (src.startsWith("true", pos)) {
                pos += 4;
                return Boolean.TRUE;
            }
            if (src.startsWith("false", pos)) {
                pos += 5;
                return Boolean.FALSE;
            }
            throw new JsonParseException("Invalid literal at position " + pos);
        }

        Object parseNull() {
            if (src.startsWith("null", pos)) {
                pos += 4;
                return null;
            }
            throw new JsonParseException("Invalid literal at position " + pos);
        }

        Double parseNumber() {
            int start = pos;
            if (!atEnd() && (src.charAt(pos) == '-' || src.charAt(pos) == '+')) {
                pos++;
            }
            while (!atEnd() && (Character.isDigit(src.charAt(pos)) || src.charAt(pos) == '.'
                || src.charAt(pos) == 'e' || src.charAt(pos) == 'E'
                || src.charAt(pos) == '+' || src.charAt(pos) == '-')) {
                pos++;
            }
            String numStr = src.substring(start, pos);
            if (numStr.isEmpty()) {
                throw new JsonParseException("Invalid number at position " + pos);
            }
            return Double.parseDouble(numStr);
        }
    }

    // ---------- Small typed accessors for the parsed Map<String,Object> graph ----------

    @SuppressWarnings("unchecked")
    public static Map<String, Object> asObject(Object v) {
        return (Map<String, Object>) v;
    }

    public static Double asDouble(Object v) {
        return v == null ? null : ((Number) v).doubleValue();
    }

    public static double asDoublePrimitive(Object v, double fallback) {
        return v == null ? fallback : ((Number) v).doubleValue();
    }

    public static String asString(Object v) {
        return (String) v;
    }

    public static Boolean asBoolean(Object v) {
        return (Boolean) v;
    }
}
