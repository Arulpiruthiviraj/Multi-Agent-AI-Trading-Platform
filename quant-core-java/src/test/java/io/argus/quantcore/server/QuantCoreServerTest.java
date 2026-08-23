package io.argus.quantcore.server;

import io.argus.quantcore.server.json.Json;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real end-to-end HTTP test against the actual embedded server (not a mock) — binds an
 * ephemeral loopback port per test so parallel runs never collide.
 */
class QuantCoreServerTest {

    private QuantCoreServer server;
    private HttpClient client;
    private String base;

    @BeforeEach
    void start() throws Exception {
        server = new QuantCoreServer(0); // 0 = OS-assigned ephemeral port
        server.start();
        base = "http://127.0.0.1:" + server.port();
        client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    }

    @AfterEach
    void stop() {
        server.stop();
    }

    private HttpResponse<String> get(String path) throws Exception {
        var req = HttpRequest.newBuilder(URI.create(base + path)).GET().build();
        return client.send(req, HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> post(String path, Object body) throws Exception {
        var req = HttpRequest.newBuilder(URI.create(base + path))
            .POST(HttpRequest.BodyPublishers.ofString(Json.write(body)))
            .header("Content-Type", "application/json")
            .build();
        return client.send(req, HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void healthReportsUpWithZeroSymbolsInitially() throws Exception {
        var res = get("/health");
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("status")).isEqualTo("UP");
        assertThat(Json.asDouble(body.get("activeSymbols"))).isEqualTo(0.0);
    }

    @Test
    void indicatorsReturns404ForUnknownSymbol() throws Exception {
        var res = get("/api/v1/indicators/NEVERSEEN");
        assertThat(res.statusCode()).isEqualTo(404);
    }

    @Test
    void rejectsMalformedTickBody() throws Exception {
        var res = post("/api/v1/ticks", Map.of("symbol", "AAPL")); // missing price
        assertThat(res.statusCode()).isEqualTo(400);
    }

    @Test
    void ingestsTicksAndComputesIndicatorsOnceHistoryFills() throws Exception {
        double price = 100;
        for (int i = 0; i < 30; i++) {
            price += (i % 3 == 2) ? -1.15 : 1.0;
            var tick = Map.of("schemaVersion", 1.0, "symbol", "AAPL", "timestampMs", (double) i, "price", price, "volume", 1000.0);
            var res = post("/api/v1/ticks", tick);
            assertThat(res.statusCode()).isEqualTo(200);
        }

        var res = get("/api/v1/indicators/AAPL");
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("insufficientHistory")).isEqualTo(false);
        assertThat(Json.asDouble(body.get("rsi"))).isBetween(0.0, 100.0);
        assertThat(body.get("macd")).isNotNull();

        var healthRes = get("/health");
        Map<String, Object> healthBody = Json.asObject(Json.parse(healthRes.body()));
        assertThat(Json.asDouble(healthBody.get("activeSymbols"))).isEqualTo(1.0);
    }

    @Test
    void reportsInsufficientHistoryBeforeMinBarsSeen() throws Exception {
        for (int i = 0; i < 5; i++) {
            post("/api/v1/ticks", Map.of("symbol", "THIN", "timestampMs", (double) i, "price", 100.0 + i));
        }
        var res = get("/api/v1/indicators/THIN");
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("insufficientHistory")).isEqualTo(true);
        assertThat(body.get("rsi")).isNull();
    }

    @Test
    void evaluateRejectsUnknownStrategyId() throws Exception {
        var res = post("/api/v1/evaluate", Map.of("strategyId", "NOT_REAL", "context", Map.of()));
        assertThat(res.statusCode()).isEqualTo(400);
    }

    @Test
    void evaluateRunsARealCoreStrategyAgainstAFullContext() throws Exception {
        Map<String, Object> context = Map.ofEntries(
            Map.entry("symbol", "TEST"),
            Map.entry("currentPrice", 110.0),
            Map.entry("trend", Map.of(
                "structure", Map.of("event", "BOS_BULLISH", "trend", "UPTREND", "lastSwingHigh", 108.0, "lastSwingLow", 95.0),
                "priceVsSMA20", Map.of("diffPct", 2.0, "above", true),
                "priceVsSMA200", Map.of("diffPct", 5.0, "above", true),
                "movingAverages", Map.of("sma20", 105.0, "sma50", 100.0, "sma200", 95.0),
                "dmi", Map.of("plusDI", 30.0, "minusDI", 15.0, "adx", 28.0)
            )),
            Map.entry("momentum", Map.of("rsi", 65.0, "roc", 1.5, "stochasticRSI", 70.0, "macd", Map.of("macd", 1.2, "signal", 0.8))),
            Map.entry("volatility", Map.of("regime", "EXPANDING", "atr", 2.0, "keltner", Map.of("upper", 112.0, "lower", 98.0, "middle", 105.0))),
            Map.entry("volume", Map.of("relativeVolume", 2.1, "vwap", Map.of("distancePct", 1.2), "cmf", 0.15, "isSpike", true)),
            Map.entry("priceAction", Map.of("candlestick", "BULLISH_ENGULFING", "consolidating", false)),
            Map.entry("supportResistance", Map.of("nearest", Map.of(
                "nearestSupport", Map.of("level", 100.0, "pct", -9.1),
                "nearestResistance", Map.of("level", 118.0, "pct", 7.3)
            ))),
            Map.entry("regime", Map.of("regime", "BULLISH_TREND", "marketStructure", "TRENDING", "trendStrength", 72.0)),
            Map.entry("marketContext", Map.of(
                "sector", Map.of("trend", Map.of("regime", Map.of("regime", "BULLISH_TREND", "marketStructure", "TRENDING", "trendStrength", 60.0))),
                "relativeStrengthVsSPY", Map.of("relativeStrengthPct", 1.8)
            ))
        );

        var res = post("/api/v1/evaluate", Map.of("strategyId", "MOMENTUM_BREAKOUT", "context", context));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("side")).isEqualTo("BUY");
        assertThat(Json.asDouble(body.get("confidence"))).isEqualTo(1.0);
        assertThat(body.get("strategyId")).isEqualTo("MOMENTUM_BREAKOUT");
    }
}
