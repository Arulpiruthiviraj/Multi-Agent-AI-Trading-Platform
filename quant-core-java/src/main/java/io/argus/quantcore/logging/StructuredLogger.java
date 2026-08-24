package io.argus.quantcore.logging;

import io.argus.quantcore.server.json.Json;

import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Structured JSON logging matching the shape the Node.js side's StructuredLogger.ts produces
 * (io.argus.quantcore.server.json.Json is reused for serialization - no new dependency). Dual
 * sink: always stdout (so `npm run dev`'s own log-file redirection of this process's stdout, or a
 * direct terminal run, both see it), and best-effort append to logs/quant-core-java.log for
 * standalone runs (e.g. the CLI/BacktestCli) that aren't launched with that redirection already in
 * place. File logging fails open - a missing/unwritable logs/ directory never crashes the app.
 */
public final class StructuredLogger {

    public enum Level {
        TRACE(0), DEBUG(1), INFO(2), WARN(3), ERROR(4);
        final int rank;
        Level(int rank) { this.rank = rank; }
    }

    private static final Level MIN_LEVEL = resolveMinLevel();
    private static volatile OutputStream fileSink = resolveFileSink();

    private StructuredLogger() {
    }

    private static Level resolveMinLevel() {
        String raw = System.getenv("LOG_LEVEL");
        if (raw == null) return Level.INFO;
        try {
            return Level.valueOf(raw.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return Level.INFO;
        }
    }

    private static OutputStream resolveFileSink() {
        try {
            // Repo-root-relative logs/ dir - this module's cwd is normally quant-core-java/.
            Path candidate = Path.of("..", "logs", "quant-core-java.log");
            Files.createDirectories(candidate.toAbsolutePath().normalize().getParent());
            return new FileOutputStream(candidate.toFile(), true);
        } catch (IOException e) {
            return null; // fail open - stdout-only logging still works
        }
    }

    public static void log(Level level, String component, String event, String message) {
        log(level, component, event, message, null, null, null);
    }

    public static void log(Level level, String component, String event, String message,
                            String traceId, String symbol, Map<String, Object> data) {
        if (level.rank < MIN_LEVEL.rank) {
            return;
        }
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("timestamp", Instant.now().toString());
        record.put("level", level.name());
        record.put("component", component);
        record.put("service", "quant-core");
        record.put("traceId", traceId != null ? traceId : TraceContext.currentTraceId());
        record.put("symbol", symbol != null ? symbol : TraceContext.currentSymbol());
        record.put("event", event);
        record.put("message", message);
        record.put("data", data);

        String line = Json.write(record);
        System.out.println(line);
        writeToFile(line);
    }

    private static synchronized void writeToFile(String line) {
        OutputStream sink = fileSink;
        if (sink == null) {
            return;
        }
        try {
            sink.write((line + System.lineSeparator()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            sink.flush();
        } catch (IOException e) {
            fileSink = null; // stop trying once it fails - fail open, stdout still works
        }
    }
}
