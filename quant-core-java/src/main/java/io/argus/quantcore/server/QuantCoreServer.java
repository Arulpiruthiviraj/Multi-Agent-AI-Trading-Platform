package io.argus.quantcore.server;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.argus.quantcore.server.json.Json;
import io.argus.quantcore.strategy.StrategyRegistry;
import io.argus.quantcore.strategy.types.StrategyContext;
import io.argus.quantcore.strategy.types.StrategyEvaluation;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;

/**
 * Lightweight, loopback-only embedded HTTP server (JDK's built-in {@code com.sun.net.httpserver}
 * — no new Maven dependency) implementing the local IPC bridge contract from
 * docs/architecture/JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md §3. ADVISORY ONLY: this process has
 * no broker imports, no credentials, and no equivalent of {@code .placeOrder(}; it computes
 * indicators/strategy signals and nothing else.
 *
 * Binds to 127.0.0.1 only (never 0.0.0.0) — matches this repo's own convention for the local
 * Chronos service on :8008 (see CLAUDE.md's "Bind: 127.0.0.1 when AUTH_PASSWORD unset").
 */
public final class QuantCoreServer {

    private final HttpServer server;
    private final Map<String, SymbolState> symbols = new ConcurrentHashMap<>();

    public QuantCoreServer(int port) throws IOException {
        this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/health", this::handleHealth);
        server.createContext("/api/v1/ticks", this::handleTicks);
        server.createContext("/api/v1/indicators/", this::handleIndicators);
        server.createContext("/api/v1/evaluate", this::handleEvaluate);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
    }

    public void start() {
        server.start();
    }

    public void stop() {
        server.stop(0);
    }

    public int port() {
        return server.getAddress().getPort();
    }

    private void handleHealth(HttpExchange exchange) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed"));
            return;
        }
        Runtime rt = Runtime.getRuntime();
        long usedMb = (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024);
        sendJson(exchange, 200, Map.of(
            "status", "UP",
            "memoryUsedMb", (double) usedMb,
            "activeSymbols", (double) symbols.size()
        ));
    }

    private void handleTicks(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed"));
            return;
        }
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            String symbol = Json.asString(body.get("symbol"));
            double price = Json.asDoublePrimitive(body.get("price"), Double.NaN);
            Double volume = Json.asDouble(body.get("volume"));
            long timestampMs = (long) Json.asDoublePrimitive(body.get("timestampMs"), 0);

            if (symbol == null || symbol.isBlank() || !Double.isFinite(price) || price <= 0) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "invalid symbol or price"));
                return;
            }
            symbols.computeIfAbsent(symbol, s -> new SymbolState()).onTick(price, volume, timestampMs);
            sendJson(exchange, 200, Map.of("ok", true));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body"));
        }
    }

    private void handleIndicators(HttpExchange exchange) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed"));
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String symbol = path.substring(path.lastIndexOf('/') + 1);
        SymbolState state = symbols.get(symbol);
        if (state == null) {
            sendJson(exchange, 404, Map.of("error", "unknown symbol - no ticks received yet: " + symbol));
            return;
        }
        IndicatorSnapshot snap = state.snapshot(symbol);
        sendJson(exchange, 200, indicatorSnapshotToJson(snap));
    }

    private void handleEvaluate(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed"));
            return;
        }
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            String strategyId = Json.asString(body.get("strategyId"));
            Map<String, Object> contextJson = Json.asObject(body.get("context"));
            if (strategyId == null || contextJson == null) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "strategyId and context are required"));
                return;
            }
            if (!StrategyRegistry.isCoreStrategy(strategyId)) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "unknown or non-CORE strategyId: " + strategyId));
                return;
            }
            StrategyContext ctx = StrategyContextCodec.decode(contextJson);
            StrategyEvaluation eval = StrategyRegistry.evaluate(strategyId, ctx).orElseThrow();
            sendJson(exchange, 200, evaluationToSignalJson(eval, ctx));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        }
    }

    private static Map<String, Object> indicatorSnapshotToJson(IndicatorSnapshot s) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", (double) s.schemaVersion());
        m.put("symbol", s.symbol());
        m.put("asOfTimestampMs", (double) s.asOfTimestampMs());
        m.put("rsi", s.rsi());
        m.put("macd", s.macd());
        m.put("macdSignal", s.macdSignal());
        m.put("bbUpper", s.bbUpper());
        m.put("bbLower", s.bbLower());
        m.put("atr", s.atr());
        m.put("vwap", s.vwap());
        m.put("regime", s.regime());
        m.put("insufficientHistory", s.insufficientHistory());
        return m;
    }

    /**
     * evSuppressed/regimeMismatchDiscounted are not wired to real EV/regime-mismatch logic in
     * this pass — StrategyEngine.ts's confidence blending (regime fit, EV suppression) lives
     * upstream of the individual strategy files and was not in scope for the 5 CORE strategy
     * ports. Both are reported false rather than fabricated.
     */
    private static Map<String, Object> evaluationToSignalJson(StrategyEvaluation eval, StrategyContext ctx) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("symbol", ctx.symbol());
        m.put("side", eval.side().name());
        m.put("confidence", eval.confidence());
        m.put("strategyId", eval.strategy());
        m.put("reasoning", String.join("; ", eval.conditionsMet()));
        m.put("currentPrice", ctx.currentPrice());
        m.put("regimeMismatchDiscounted", false);
        m.put("evSuppressed", false);
        return m;
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        return new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
    }

    private static void sendJson(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = Json.write(body).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }
}
