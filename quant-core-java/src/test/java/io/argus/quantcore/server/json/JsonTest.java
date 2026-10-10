package io.argus.quantcore.server.json;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class JsonTest {

    @Test
    void roundTripsFlatObject() {
        String json = Json.write(Map.of("symbol", "AAPL", "price", 189.5, "volume", 1000));
        Object parsed = Json.parse(json);
        Map<String, Object> obj = Json.asObject(parsed);
        assertThat(Json.asString(obj.get("symbol"))).isEqualTo("AAPL");
        assertThat(Json.asDouble(obj.get("price"))).isEqualTo(189.5);
    }

    @Test
    void roundTripsNestedObjectsAndArrays() {
        Map<String, Object> nested = Map.of("a", 1.0, "b", List.of(1.0, 2.0, 3.0));
        // Map.of() rejects null values by design - built with a mutable map instead so this test
        // can also cover a real null field round-tripping through the JSON writer/parser.
        Map<String, Object> outer = new java.util.LinkedHashMap<>();
        outer.put("nested", nested);
        outer.put("flag", true);
        outer.put("missing", null);
        Object parsed = Json.parse(Json.write(outer));
        Map<String, Object> obj = Json.asObject(parsed);
        assertThat(obj.get("flag")).isEqualTo(true);
        assertThat(obj.get("missing")).isNull();
        Map<String, Object> parsedNested = Json.asObject(obj.get("nested"));
        assertThat(Json.asDouble(parsedNested.get("a"))).isEqualTo(1.0);
        @SuppressWarnings("unchecked")
        List<Object> arr = (List<Object>) parsedNested.get("b");
        assertThat(arr).hasSize(3);
    }

    @Test
    void parsesEscapedStringsAndUnicodeEscapes() {
        Object parsed = Json.parse("{\"s\": \"line1\\nline2\\t\\u0041\"}");
        Map<String, Object> obj = Json.asObject(parsed);
        assertThat(Json.asString(obj.get("s"))).isEqualTo("line1\nline2\tA");
    }

    @Test
    void writesIntegralDoublesWithoutTrailingDotZero() {
        assertThat(Json.write(100.0)).isEqualTo("100");
        assertThat(Json.write(100.5)).isEqualTo("100.5");
    }

    @Test
    void parsesNegativeAndDecimalNumbers() {
        Object parsed = Json.parse("[-1.5, 0, 42]");
        @SuppressWarnings("unchecked")
        List<Object> arr = (List<Object>) parsed;
        assertThat(Json.asDouble(arr.get(0))).isEqualTo(-1.5);
        assertThat(Json.asDouble(arr.get(2))).isEqualTo(42.0);
    }

    @Test
    void throwsOnMalformedJson() {
        org.junit.jupiter.api.Assertions.assertThrows(Json.JsonParseException.class, () -> Json.parse("{\"a\": }"));
    }

    /**
     * Java defect hunt 2026-10-10: these inputs used to leak raw NumberFormatException /
     * StringIndexOutOfBoundsException out of the parser (HTTP 500 from the handlers), instead
     * of the documented JsonParseException (HTTP 400 "malformed request body").
     */
    @Test
    void mapsUnparseableNumbersToJsonParseException() {
        org.junit.jupiter.api.Assertions.assertThrows(Json.JsonParseException.class, () -> Json.parse("[1e]"));
        org.junit.jupiter.api.Assertions.assertThrows(Json.JsonParseException.class, () -> Json.parse("[1.2.3]"));
        org.junit.jupiter.api.Assertions.assertThrows(Json.JsonParseException.class, () -> Json.parse("[+]"));
        org.junit.jupiter.api.Assertions.assertThrows(Json.JsonParseException.class, () -> Json.parse("[-]"));
    }

    @Test
    void mapsTruncatedAndInvalidUnicodeEscapesToJsonParseException() {
        org.junit.jupiter.api.Assertions.assertThrows(Json.JsonParseException.class, () -> Json.parse("[\"abc\\u12\"]"));
        org.junit.jupiter.api.Assertions.assertThrows(Json.JsonParseException.class, () -> Json.parse("[\"abc\\u12XY\"]"));
        org.junit.jupiter.api.Assertions.assertThrows(Json.JsonParseException.class, () -> Json.parse("[\"abc\\u\"]"));
    }

    /**
     * Java defect hunt 2026-10-10: integral doubles at/above 2^63 used to serialize as
     * 9223372036854775807 (Double.longValue() saturation) - a wrong number, not a big one.
     */
    @Test
    void writesHugeIntegralDoublesWithoutLongSaturation() {
        assertThat(Json.write(1e21)).isEqualTo("1.0E21");
        assertThat(Json.write(-1e21)).isEqualTo("-1.0E21");
        // Ordinary integral values still emit without ".0", and round-trip exactly.
        assertThat(Json.write(1791686400000.0)).isEqualTo("1791686400000");
        Object parsed = Json.parse(Json.write(1e21));
        assertThat(Json.asDouble(parsed)).isEqualTo(1e21);
    }

    @Test
    void stillParsesValidUnicodeAndExponentNumbers() {
        Object parsed = Json.parse("[\"\\u0041\", 1e3, -2.5e-2]");
        @SuppressWarnings("unchecked")
        List<Object> arr = (List<Object>) parsed;
        assertThat(Json.asString(arr.get(0))).isEqualTo("A");
        assertThat(Json.asDouble(arr.get(1))).isEqualTo(1000.0);
        assertThat(Json.asDouble(arr.get(2))).isCloseTo(-0.025, org.assertj.core.api.Assertions.within(1e-12));
    }
}
