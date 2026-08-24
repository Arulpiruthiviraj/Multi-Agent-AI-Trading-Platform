package io.argus.quantcore.logging;

import io.argus.quantcore.server.json.Json;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

/**
 * Captures real stdout (StructuredLogger always writes there regardless of file-sink success) and
 * parses each line back through the real Json parser - proving the emitted lines are genuinely
 * valid, parseable JSON matching the documented schema, not just assumed to be.
 */
class StructuredLoggerTest {

    private final PrintStream originalOut = System.out;

    @AfterEach
    void restoreStdout() {
        System.setOut(originalOut);
    }

    private String captureOneLogLine(Runnable action) {
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        System.setOut(new PrintStream(captured));
        action.run();
        System.setOut(originalOut);
        return captured.toString().trim();
    }

    @Test
    void emitsValidJsonWithTheDocumentedSchema() {
        String line = captureOneLogLine(() ->
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "INDICATOR_COMPUTED",
                "Computed 14-period RSI for NVDA", "tr-nvda-123", "NVDA", Map.of("rsi", 64.21)));

        Map<String, Object> parsed = Json.asObject(Json.parse(line));
        assertThat(parsed.get("level")).isEqualTo("INFO");
        assertThat(parsed.get("component")).isEqualTo("QuantCoreJava");
        assertThat(parsed.get("service")).isEqualTo("quant-core");
        assertThat(parsed.get("traceId")).isEqualTo("tr-nvda-123");
        assertThat(parsed.get("symbol")).isEqualTo("NVDA");
        assertThat(parsed.get("event")).isEqualTo("INDICATOR_COMPUTED");
        assertThat(parsed.get("message")).isEqualTo("Computed 14-period RSI for NVDA");
        assertThat(parsed.get("timestamp")).isNotNull();
        Map<String, Object> data = Json.asObject(parsed.get("data"));
        assertThat(Json.asDouble(data.get("rsi"))).isEqualTo(64.21);
    }

    @Test
    void timestampIsIso8601Utc() {
        String line = captureOneLogLine(() ->
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "X", "msg"));
        Map<String, Object> parsed = Json.asObject(Json.parse(line));
        String timestamp = Json.asString(parsed.get("timestamp"));
        assertThat(timestamp).endsWith("Z"); // Instant.toString() is always UTC, always 'Z'-suffixed
        assertThatCode(() -> java.time.Instant.parse(timestamp)).doesNotThrowAnyException();
    }

    @Test
    void debugIsSuppressedByDefaultMinLevelInfo() {
        // Default MIN_LEVEL is INFO unless LOG_LEVEL env is set - this JVM has no LOG_LEVEL set
        // for the test run, so DEBUG must produce no stdout line at all.
        String line = captureOneLogLine(() ->
            StructuredLogger.log(StructuredLogger.Level.DEBUG, "QuantCoreJava", "TICK_INGESTED", "tick"));
        assertThat(line).isEmpty();
    }

    @Test
    void infoAndAboveAreNotSuppressed() {
        String line = captureOneLogLine(() ->
            StructuredLogger.log(StructuredLogger.Level.WARN, "QuantCoreJava", "SOMETHING", "warned"));
        assertThat(line).isNotEmpty();
    }

    @Test
    void fallsBackToThreadBoundTraceContextWhenNotPassedExplicitly() {
        TraceContext.bind("tr-from-context", "TSLA");
        try {
            String line = captureOneLogLine(() ->
                StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "EVT", "msg"));
            Map<String, Object> parsed = Json.asObject(Json.parse(line));
            assertThat(parsed.get("traceId")).isEqualTo("tr-from-context");
            assertThat(parsed.get("symbol")).isEqualTo("TSLA");
        } finally {
            TraceContext.clear();
        }
    }
}
