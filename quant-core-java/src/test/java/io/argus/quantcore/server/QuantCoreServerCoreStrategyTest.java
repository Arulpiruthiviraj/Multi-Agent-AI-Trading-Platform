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
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real end-to-end HTTP tests for /api/v1/quant/strategy/{strategyId}/{symbol} and
 * /api/v1/quant/ensemble/{symbol} (2026-09-10) - the real, bars-owning path for the 5 CORE
 * strategies, distinct from /api/v1/evaluate's pre-built-StrategyContext path. Mirrors
 * QuantCoreServerResearchStrategyTest.java's own real-server, ephemeral-port pattern.
 */
class QuantCoreServerCoreStrategyTest {

    private QuantCoreServer server;
    private HttpClient client;
    private String base;

    @BeforeEach
    void start() throws Exception {
        server = new QuantCoreServer(0);
        server.start();
        base = "http://127.0.0.1:" + server.port();
        client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    }

    @AfterEach
    void stop() {
        server.stop();
    }

    private HttpResponse<String> post(String path, Object body) throws Exception {
        var req = HttpRequest.newBuilder(URI.create(base + path))
            .POST(HttpRequest.BodyPublishers.ofString(Json.write(body)))
            .header("Content-Type", "application/json")
            .build();
        return client.send(req, HttpResponse.BodyHandlers.ofString());
    }

    private static Map<String, Object> barJson(long t, double close) {
        return Map.of("timestampMs", (double) t, "open", close - 0.2, "high", close + 1, "low", close - 1, "close", close, "volume", 10_000.0);
    }

    private static List<Object> trendingBars(int count) {
        List<Object> bars = new ArrayList<>();
        double price = 100;
        long dayMs = 24L * 60 * 60 * 1000;
        long now = System.currentTimeMillis();
        for (int i = 0; i < count; i++) {
            price *= 1.003;
            bars.add(barJson(now - (count - i) * dayMs, price));
        }
        return bars;
    }

    @Test
    void strategyRoute_returns404ForAnUnknownStrategyId() throws Exception {
        var res = post("/api/v1/quant/strategy/NOT_A_REAL_STRATEGY/AAPL", Map.of("bars", trendingBars(220)));
        assertThat(res.statusCode()).isEqualTo(404);
    }

    @Test
    void strategyRoute_returns400WhenBarsAreMissing() throws Exception {
        var res = post("/api/v1/quant/strategy/MOMENTUM_BREAKOUT/AAPL", Map.of());
        assertThat(res.statusCode()).isEqualTo(400);
    }

    @Test
    void strategyRoute_returnsDataUnavailableRatherThanFabricating_whenBarsAreInsufficient() throws Exception {
        var res = post("/api/v1/quant/strategy/RANGE_REVERSION/AAPL", Map.of("bars", trendingBars(5)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("direction")).isEqualTo("DATA_UNAVAILABLE");
        assertThat(body.get("dataQuality")).isEqualTo("INSUFFICIENT_HISTORY");
    }

    @Test
    void strategyRoute_evaluatesRangeReversionFromRealJavaComputedFeatures() throws Exception {
        var res = post("/api/v1/quant/strategy/RANGE_REVERSION/AAPL", Map.of("bars", trendingBars(220)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("strategyId")).isEqualTo("RANGE_REVERSION");
        assertThat(body.get("direction")).isIn("BUY", "SELL");
        assertThat(body.get("score")).isNotNull();
        assertThat(body.get("confidence")).isNotNull();
        assertThat(body.get("dataQuality")).isEqualTo("FRESH");
        assertThat((Double) body.get("latencyMs")).isGreaterThanOrEqualTo(0.0);
    }

    @Test
    void ensembleRoute_returns400WhenSymbolMissing() throws Exception {
        var res = post("/api/v1/quant/ensemble/", Map.of("bars", trendingBars(220)));
        assertThat(res.statusCode()).isEqualTo(400);
    }

    @Test
    void ensembleRoute_combinesAllFiveCoreStrategiesViaTheExistingEnsembleEngine() throws Exception {
        var res = post("/api/v1/quant/ensemble/AAPL", Map.of("bars", trendingBars(220)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));

        assertThat(body.get("status")).isIn("HEALTHY", "DEGRADED");
        assertThat(body.get("direction")).isIn("BUY", "SELL", "HOLD");
        assertThat(((Number) body.get("strategyCount")).intValue()).isEqualTo(5);
        assertThat(((Number) body.get("effectiveIndependentCount")).doubleValue()).isGreaterThanOrEqualTo(0.0);
        @SuppressWarnings("unchecked")
        List<Object> assessments = (List<Object>) body.get("assessments");
        assertThat(assessments).hasSize(5);
    }

    @Test
    void ensembleRoute_reportsUnavailableRatherThanFabricating_whenAllStrategiesLackData() throws Exception {
        var res = post("/api/v1/quant/ensemble/AAPL", Map.of("bars", trendingBars(5)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("status")).isEqualTo("UNAVAILABLE");
        assertThat(body.get("direction")).isEqualTo("HOLD");
    }
}
