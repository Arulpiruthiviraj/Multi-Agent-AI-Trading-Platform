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
 * Real end-to-end HTTP tests for the generic /institutional/strategy/{strategyId}/{symbol}
 * dispatcher (2026-09-09) - proves the wiring works, not the underlying strategy math (each
 * engine already has its own unit tests, e.g. RsiMeanReversionEngineTest.java). Mirrors
 * QuantCoreServerTest.java's own real-server, ephemeral-port pattern exactly.
 */
class QuantCoreServerResearchStrategyTest {

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

    private static Map<String, Object> barJson(int t, double close) {
        return Map.of("timestampMs", (double) t, "open", close, "high", close + 1, "low", close - 1, "close", close, "volume", 1000.0);
    }

    private static List<Object> risingBars(int count) {
        List<Object> bars = new ArrayList<>();
        double price = 100;
        for (int i = 0; i < count; i++) {
            bars.add(barJson(i, price));
            price *= 1.01;
        }
        return bars;
    }

    @Test
    void returns404ForAnUnknownStrategyId() throws Exception {
        var res = post("/api/v1/institutional/strategy/not_a_real_strategy/AAPL", Map.of("bars", risingBars(30)));
        assertThat(res.statusCode()).isEqualTo(404);
    }

    @Test
    void returns400WhenBarsAreMissing() throws Exception {
        var res = post("/api/v1/institutional/strategy/rsi_mean_reversion/AAPL", Map.of());
        assertThat(res.statusCode()).isEqualTo(400);
    }

    @Test
    void returns422WithInsufficientHistoryRatherThanFabricating() throws Exception {
        var res = post("/api/v1/institutional/strategy/macd_crossover/AAPL", Map.of("bars", risingBars(3)));
        assertThat(res.statusCode()).isEqualTo(422);
    }

    @Test
    void evaluatesRsiMeanReversionEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/rsi_mean_reversion/AAPL", Map.of("bars", risingBars(20)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("strategyId")).isEqualTo("rsi_mean_reversion");
        assertThat(body.get("symbol")).isEqualTo("AAPL");
        assertThat(body).containsKey("rsi");
        assertThat(body).containsKey("fadeSignal");
    }

    @Test
    void evaluatesMacdCrossoverEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/macd_crossover/AAPL", Map.of("bars", risingBars(60)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("macd", "signal", "histogram", "bullishCross", "bearishCross");
    }

    @Test
    void evaluatesBollingerMeanReversionEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/bollinger_mean_reversion/AAPL", Map.of("bars", risingBars(25)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("upperBand", "lowerBand", "fadeSignal");
    }

    @Test
    void evaluatesMovingAverageCrossoverEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/moving_average_crossover/AAPL", Map.of("bars", risingBars(60)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("fastValue", "slowValue", "fastAboveSlow");
    }

    @Test
    void evaluatesDonchianChannelEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/donchian_channel/AAPL", Map.of("bars", risingBars(30)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("upperChannel", "lowerChannel", "breakoutUp", "breakoutDown");
    }

    @Test
    void evaluatesTrendStrengthAdxEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/trend_strength_adx/AAPL", Map.of("bars", risingBars(60)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("adx", "plusDI", "minusDI", "strongTrend");
    }

    @Test
    void evaluatesMeanReversionZScoreEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/mean_reversion_zscore/AAPL", Map.of("bars", risingBars(25)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("zScore", "fadeSignal");
    }

    @Test
    void evaluatesStochasticOscillatorEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/stochastic_oscillator/AAPL", Map.of("bars", risingBars(30)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("percentK", "percentD", "overbought", "oversold");
    }

    @Test
    void evaluatesTimeSeriesMomentumEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/time_series_momentum/AAPL", Map.of("bars", risingBars(130)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("shortTermReturn", "mediumTermReturn", "longTermReturn", "signal");
    }

    @Test
    void evaluatesVolumeSignalEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/volume_signal/AAPL", Map.of("bars", risingBars(30)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("relativeVolume", "volumeBreakout");
    }

    @Test
    void rejectsAGetRequestWithMethodNotAllowed() throws Exception {
        var req = HttpRequest.newBuilder(URI.create(base + "/api/v1/institutional/strategy/rsi_mean_reversion/AAPL")).GET().build();
        var res = client.send(req, HttpResponse.BodyHandlers.ofString());
        assertThat(res.statusCode()).isEqualTo(405);
    }

    @Test
    void evaluatesBtcTan2025VolAdjustedMomentumEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/btc_tan2025_vol_adjusted_momentum/SYN-BTC-USD", Map.of("bars", risingBars(150)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("position", "evidence", "diagnostics");
        assertThat(body.get("position")).isEqualTo("LONG"); // steady rising bars -> positive momentum, low vol
    }

    @Test
    void evaluatesBtcAdaptiveVolatilityMomentumWithCallerSuppliedParametersEndToEnd() throws Exception {
        Map<String, Object> reqBody = Map.of("bars", risingBars(150), "volatilityPercentileThreshold", -1.0);
        var res = post("/api/v1/institutional/strategy/btc_adaptive_volatility_momentum/SYN-BTC-USD", reqBody);
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        // An unreachable negative percentile threshold must force FLAT regardless of momentum.
        assertThat(body.get("position")).isEqualTo("FLAT");
    }

    @Test
    void evaluatesBtcTan2025BollingerMeanReversionEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/btc_tan2025_bollinger_mean_reversion/SYN-BTC-USD", Map.of("bars", risingBars(60)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("position", "evidence", "diagnostics");
    }

    @Test
    void evaluatesBtcAdaptiveBollingerMeanReversionWithCallerSuppliedParametersEndToEnd() throws Exception {
        Map<String, Object> reqBody = Map.of("bars", risingBars(60), "window", 10.0, "stdDevMultiplier", 1.5);
        var res = post("/api/v1/institutional/strategy/btc_adaptive_bollinger_mean_reversion/SYN-BTC-USD", reqBody);
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("position", "evidence", "diagnostics");
    }

    @Test
    void evaluatesCryptoFeatureEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/crypto_feature/SYN-BTC-USD", Map.of("bars", risingBars(30)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("return20Bar", "ema20SlopePct", "atr14", "rsi14", "bollingerZScore");
    }

    @Test
    void evaluatesCryptoRegimeEndToEnd() throws Exception {
        var res = post("/api/v1/institutional/strategy/crypto_regime/SYN-BTC-USD", Map.of("bars", risingBars(30)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body).containsKeys("regime", "regimeConfidence", "evidence");
        assertThat(body.get("regime")).isEqualTo("TRENDING_BULL"); // steady rising bars
    }

    @Test
    void returns422ForBtcMomentumWithInsufficientHistoryRatherThanFabricating() throws Exception {
        var res = post("/api/v1/institutional/strategy/btc_tan2025_vol_adjusted_momentum/SYN-BTC-USD", Map.of("bars", risingBars(5)));
        assertThat(res.statusCode()).isEqualTo(422);
    }

    @Test
    void handlesASymbolContainingAPercentEncodedSlashLikeARealCryptoPair() throws Exception {
        // 2026-09-21 real bug regression: "BTC/USD" percent-encoded as "BTC%2FUSD" (exactly what
        // encodeURIComponent() produces client-side) used to decode back to a literal slash before
        // path parsing, splitting into 3 segments instead of 2 and always failing with 400. This
        // reproduces the exact client encoding rather than embedding a literal slash in the test URL.
        var res = post("/api/v1/institutional/strategy/crypto_feature/BTC%2FUSD", Map.of("bars", risingBars(30)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("symbol")).isEqualTo("BTC/USD");
        assertThat(body).containsKey("return20Bar");
    }
}
