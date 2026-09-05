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
import java.util.Random;

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

    @Test
    void institutionalFactorsComputesACompositeForARecentBreakoutAfterAFlatPeriod() throws Exception {
        // See FactorAlphaEngineTest's header for why a "flat then breakout" construction, not a
        // steady uptrend, deterministically produces a positive momentum Z-score.
        Random rnd = new Random(4242);
        double price = 100;
        List<Object> bars = new ArrayList<>();
        for (int i = 0; i < 200; i++) {
            double dailyReturn = i < 150 ? rnd.nextGaussian() * 0.001 : 0.01 + rnd.nextGaussian() * 0.001;
            double open = price;
            double close = price * (1 + dailyReturn);
            double high = Math.max(open, close) * (1.0005 + Math.abs(rnd.nextGaussian()) * 0.0003);
            double low = Math.min(open, close) * (1 - 0.0005 - Math.abs(rnd.nextGaussian()) * 0.0003);
            bars.add(Map.of("timestampMs", (double) i, "open", open, "high", high, "low", low,
                "close", close, "volume", 1_000_000.0 + Math.max(0, i - 150) * 5000));
            price = close;
        }
        var res = post("/api/v1/institutional/factors/AAPL", Map.of("bars", bars));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("symbol")).isEqualTo("AAPL");
        assertThat(Json.asDouble(body.get("momentum"))).isGreaterThan(0);
        assertThat(body.get("composite")).isNotNull();
        assertThat(body.get("orderFlowProxyIsRealOrderFlow")).isEqualTo(false);
    }

    @Test
    void institutionalFactorsReturns422WithTooFewBars() throws Exception {
        var res = post("/api/v1/institutional/factors/AAPL", Map.of("bars", List.of(
            Map.of("timestampMs", 0.0, "open", 100.0, "high", 101.0, "low", 99.0, "close", 100.5, "volume", 1000.0))));
        assertThat(res.statusCode()).isEqualTo(422);
    }

    @Test
    void institutionalFactorsRejectsMissingBarsField() throws Exception {
        var res = post("/api/v1/institutional/factors/AAPL", Map.of());
        assertThat(res.statusCode()).isEqualTo(400);
    }

    @Test
    void institutionalPairsDetectsCointegrationForAConstructedCointegratedPair() throws Exception {
        Random rnd = new Random(2468);
        int n = 400;
        List<Object> primaryBars = new ArrayList<>();
        List<Object> pairBars = new ArrayList<>();
        double bPrice = 100, noise = 0;
        for (int t = 0; t < n; t++) {
            bPrice += rnd.nextGaussian() * 0.4;
            noise = 0.35 * noise + rnd.nextGaussian() * 0.25;
            double aPrice = 1.5 * bPrice + noise;
            pairBars.add(barJson(t, bPrice));
            primaryBars.add(barJson(t, aPrice));
        }

        var res = post("/api/v1/institutional/pairs", Map.of(
            "primarySymbol", "A", "pairSymbol", "B",
            "primaryBars", primaryBars, "pairBars", pairBars, "zScoreWindow", 60.0));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("primarySymbol")).isEqualTo("A");
        assertThat(body.get("pairSymbol")).isEqualTo("B");
        assertThat(body.get("cointegrated")).isEqualTo(true);
        assertThat(Json.asDouble(body.get("hedgeRatio"))).isCloseTo(1.5, org.assertj.core.data.Offset.offset(0.2));
        assertThat(body.get("adf")).isNotNull();
    }

    @Test
    void institutionalPairsRejectsMissingFields() throws Exception {
        var res = post("/api/v1/institutional/pairs", Map.of("primarySymbol", "A"));
        assertThat(res.statusCode()).isEqualTo(400);
    }

    private static Map<String, Object> barJson(int t, double close) {
        return Map.of("timestampMs", (double) t, "open", close, "high", close, "low", close, "close", close, "volume", 1000.0);
    }

    // GarchEngine/HmmRegimeEngine were real, compiled, and unit-tested (GarchEngineTest.java,
    // HmmRegimeEngineTest.java) before this pass but had zero HTTP endpoint - unreachable from the
    // TypeScript control plane. These tests prove the new wiring, not the underlying statistics
    // (already proven at the engine level) - so they assert response shape/plausibility rather than
    // a specific fitted value or regime label.

    @Test
    void institutionalVolatilityFitsGarchForARealisticReturnSeries() throws Exception {
        Random rnd = new Random(1357);
        double price = 100;
        List<Object> bars = new ArrayList<>();
        double vol = 0.01;
        for (int i = 0; i < 250; i++) {
            // Simple vol-clustering construction (not GARCH-generated data itself - just enough
            // heteroskedasticity that a real GARCH(1,1) fit is meaningful, not degenerate).
            vol = 0.4 * vol + 0.6 * (0.005 + Math.abs(rnd.nextGaussian()) * 0.01);
            double ret = rnd.nextGaussian() * vol;
            double close = price * (1 + ret);
            bars.add(barJson(i, close));
            price = close;
        }
        var res = post("/api/v1/institutional/volatility/AAPL", Map.of("bars", bars));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("symbol")).isEqualTo("AAPL");
        assertThat(Json.asDouble(body.get("alpha"))).isBetween(0.0, 1.0);
        assertThat(Json.asDouble(body.get("beta"))).isBetween(0.0, 1.0);
        assertThat(Json.asDouble(body.get("persistence"))).isLessThan(1.0);
        assertThat(Json.asDouble(body.get("forecastVolatility"))).isGreaterThanOrEqualTo(0.0);
        assertThat(Json.asDouble(body.get("returnsUsed"))).isEqualTo(249.0);
    }

    @Test
    void institutionalVolatilityReturns422WithTooFewBars() throws Exception {
        var res = post("/api/v1/institutional/volatility/AAPL", Map.of("bars", List.of(
            barJson(0, 100.0), barJson(1, 101.0))));
        assertThat(res.statusCode()).isEqualTo(422);
    }

    @Test
    void institutionalVolatilityRejectsMissingBarsField() throws Exception {
        var res = post("/api/v1/institutional/volatility/AAPL", Map.of());
        assertThat(res.statusCode()).isEqualTo(400);
    }

    @Test
    void institutionalRegimeFitsAFourStateHmmAndReturnsAPlausibleShape() throws Exception {
        Random rnd = new Random(9182);
        double price = 100;
        List<Object> bars = new ArrayList<>();
        for (int i = 0; i < 260; i++) {
            // Alternating calm/choppy blocks so the fitted variances aren't degenerate uniform noise.
            boolean choppy = (i / 50) % 2 == 1;
            double ret = rnd.nextGaussian() * (choppy ? 0.03 : 0.006) + (choppy ? 0 : 0.0015);
            double close = price * (1 + ret);
            bars.add(barJson(i, close));
            price = close;
        }
        var res = post("/api/v1/institutional/regime/AAPL", Map.of("bars", bars));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("symbol")).isEqualTo("AAPL");
        assertThat(body.get("currentRegime")).isIn("BULL_TRENDING", "BEAR_TRENDING", "MEAN_REVERTING", "HIGH_VOL_CHAOS");
        @SuppressWarnings("unchecked")
        List<String> stateLabels = (List<String>) body.get("stateLabels");
        assertThat(stateLabels).hasSize(4);
        assertThat(Json.asDouble(body.get("observationCount"))).isGreaterThan(0.0);
    }

    @Test
    void institutionalRegimeReturns422WithTooFewBars() throws Exception {
        var res = post("/api/v1/institutional/regime/AAPL", Map.of("bars", List.of(
            barJson(0, 100.0), barJson(1, 101.0), barJson(2, 100.5))));
        assertThat(res.statusCode()).isEqualTo(422);
    }

    @Test
    void institutionalRegimeRejectsMissingBarsField() throws Exception {
        var res = post("/api/v1/institutional/regime/AAPL", Map.of());
        assertThat(res.statusCode()).isEqualTo(400);
    }

    @Test
    void institutionalVolatilityResponseIncludesTheNewVolatilityEngineFields() throws Exception {
        Random rnd = new Random(1357);
        double price = 100;
        List<Object> bars = new ArrayList<>();
        double vol = 0.01;
        for (int i = 0; i < 250; i++) {
            vol = 0.4 * vol + 0.6 * (0.005 + Math.abs(rnd.nextGaussian()) * 0.01);
            double ret = rnd.nextGaussian() * vol;
            double close = price * (1 + ret);
            bars.add(barJson(i, close));
            price = close;
        }
        var res = post("/api/v1/institutional/volatility/AAPL", Map.of("bars", bars));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(Json.asDouble(body.get("realizedVolPercentile"))).isBetween(0.0, 1.0);
        assertThat(body.get("volatilityCompressed")).isIn(true, false);
        assertThat(body.get("volatilityExpanded")).isIn(true, false);
    }

    @Test
    void institutionalRegimeResponseIncludesTheNewVolatilityContextFields() throws Exception {
        Random rnd = new Random(9182);
        double price = 100;
        List<Object> bars = new ArrayList<>();
        for (int i = 0; i < 260; i++) {
            boolean choppy = (i / 50) % 2 == 1;
            double ret = rnd.nextGaussian() * (choppy ? 0.03 : 0.006) + (choppy ? 0 : 0.0015);
            double close = price * (1 + ret);
            bars.add(barJson(i, close));
            price = close;
        }
        var res = post("/api/v1/institutional/regime/AAPL", Map.of("bars", bars));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(Json.asDouble(body.get("volatilityPercentile"))).isBetween(0.0, 1.0);
        assertThat(body.get("volatilityCompressed")).isIn(true, false);
    }

    // FeaturePipeline/MarketDataQualityEngine were real, unit-tested, but had zero HTTP endpoint -
    // proves the new /institutional/features/ wiring, not the underlying indicator math (already
    // covered by FeaturePipelineTest/MarketDataQualityEngineTest at the unit level).

    @Test
    void institutionalFeaturesBuildsARealSnapshotForCleanSufficientBars() throws Exception {
        Random rnd = new Random(321);
        double price = 100;
        List<Object> bars = new ArrayList<>();
        for (int i = 0; i < 60; i++) {
            price *= 1 + rnd.nextGaussian() * 0.01;
            bars.add(barJson(i, price));
        }
        var res = post("/api/v1/institutional/features/AAPL", Map.of("bars", bars));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("symbol")).isEqualTo("AAPL");
        assertThat(Json.asDouble(body.get("rsi"))).isBetween(0.0, 100.0);
        @SuppressWarnings("unchecked")
        Map<String, Object> quality = (Map<String, Object>) body.get("qualityReport");
        assertThat(quality.get("status")).isEqualTo("GREEN");
    }

    @Test
    void institutionalFeaturesReturns422WhenQualityIsRed() throws Exception {
        List<Object> bars = List.of(barJson(0, 100.0), barJson(1, 101.0)); // far below the 30-bar floor
        var res = post("/api/v1/institutional/features/THIN", Map.of("bars", bars));
        assertThat(res.statusCode()).isEqualTo(422);
    }

    @Test
    void institutionalFeaturesRejectsMissingBarsField() throws Exception {
        var res = post("/api/v1/institutional/features/AAPL", Map.of());
        assertThat(res.statusCode()).isEqualTo(400);
    }

    // RegimeEngine.classifyRegime was real, compiled, and unit-tested (Phase2FeatureParityTest,
    // byte-for-byte against RegimeEngine.ts) but had zero HTTP endpoint before this pass - the
    // shadow-only parity route QuantCoreBridge.compareRegimeParity() calls from evaluateSymbol().
    // These tests prove the new wiring/JSON shape, not the underlying classification math (already
    // proven at the unit level by Phase2FeatureParityTest).

    @Test
    void featuresRegimeReturnsTopLevelRegimeFieldsForSufficientBars() throws Exception {
        Random rnd = new Random(42);
        double price = 100;
        List<Object> bars = new ArrayList<>();
        for (int i = 0; i < 260; i++) {
            price *= 1 + (rnd.nextGaussian() * 0.01 + 0.001);
            bars.add(barJson(i, price));
        }
        var res = post("/api/v1/features/regime/AAPL", Map.of("bars", bars));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("symbol")).isEqualTo("AAPL");
        assertThat(body.get("regime")).isIn("BULLISH_TREND", "BEARISH_TREND", "SIDEWAYS_RANGE");
        assertThat(body.get("volatility")).isIn("HIGH", "LOW", "NORMAL");
        assertThat(body.get("marketStructure")).isIn("TRENDING", "RANGING", "CHOPPY");
        assertThat(Json.asDouble(body.get("confidence"))).isBetween(0.0, 1.0);
        assertThat(Json.asDouble(body.get("trendStrength"))).isBetween(0.0, 100.0);
        assertThat(body.get("insufficientData")).isEqualTo(false);
        // Deliberately NOT asserting on nested trend/volatility/priceAction sub-objects - the route
        // intentionally serializes top-level fields only (see handleFeaturesRegime's own comment).
        assertThat(body).doesNotContainKey("features");
        assertThat(body).doesNotContainKey("trend");
    }

    @Test
    void featuresRegimeFlagsInsufficientDataUnderTheMinBarsFloor() throws Exception {
        List<Object> bars = List.of(barJson(0, 100.0), barJson(1, 101.0), barJson(2, 100.5));
        var res = post("/api/v1/features/regime/THIN", Map.of("bars", bars));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("insufficientData")).isEqualTo(true);
    }

    @Test
    void featuresRegimeRejectsMissingBarsField() throws Exception {
        var res = post("/api/v1/features/regime/AAPL", Map.of());
        assertThat(res.statusCode()).isEqualTo(400);
    }

    // CorrelationEngine (wrapping the previously-uncalled EwmaCovariance) had zero HTTP endpoint -
    // proves the new /institutional/correlation wiring, not the underlying math (already covered
    // by CorrelationEngineTest at the unit level).

    @Test
    void institutionalCorrelationComputesAHighCorrelationForNearIdenticalSeries() throws Exception {
        Random rnd = new Random(654);
        int n = 200;
        List<Double> a = new ArrayList<>();
        List<Double> b = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            double common = rnd.nextGaussian() * 0.01;
            a.add(common);
            b.add(common + rnd.nextGaussian() * 0.0005);
        }
        var res = post("/api/v1/institutional/correlation", Map.of(
            "symbols", List.of("SPY", "IVV"), "returnsByAsset", List.of(a, b)));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        @SuppressWarnings("unchecked")
        List<List<Double>> matrix = (List<List<Double>>) body.get("correlationMatrix");
        assertThat(matrix.get(0).get(1)).isGreaterThan(0.9);
    }

    @Test
    void institutionalCorrelationReturns422OnRaggedInput() throws Exception {
        var res = post("/api/v1/institutional/correlation", Map.of(
            "symbols", List.of("A", "B"),
            "returnsByAsset", List.of(List.of(0.01, 0.02, 0.03), List.of(0.01, 0.02))));
        assertThat(res.statusCode()).isEqualTo(422);
    }

    @Test
    void institutionalCorrelationRejectsMissingFields() throws Exception {
        var res = post("/api/v1/institutional/correlation", Map.of("symbols", List.of("A", "B")));
        assertThat(res.statusCode()).isEqualTo(400);
    }

    // QuantEnsembleEngine (correlation-adjusted ensemble) had zero HTTP endpoint - proves the new
    // wiring, not the underlying math (already covered by QuantEnsembleEngineTest).

    @Test
    void institutionalEnsembleUsesTheDefaultFamilyCorrelationWhenNoMatrixIsSupplied() throws Exception {
        var votes = List.of(
            Map.of("modelId", "momentum_a", "family", "momentum", "side", "BUY", "confidence", 0.8),
            Map.of("modelId", "momentum_b", "family", "momentum", "side", "BUY", "confidence", 0.75),
            Map.of("modelId", "factor", "family", "factor", "side", "BUY", "confidence", 0.6),
            Map.of("modelId", "mean_reversion", "family", "mean_reversion", "side", "SELL", "confidence", 0.6));
        var res = post("/api/v1/institutional/ensemble", Map.of("votes", votes));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("rawSide")).isEqualTo("BUY");
        assertThat(Json.asDouble(body.get("agreeingCount"))).isEqualTo(3.0);
        assertThat(Json.asDouble(body.get("effectiveIndependentCount"))).isLessThan(3.0);
        @SuppressWarnings("unchecked")
        List<String> dissenting = (List<String>) body.get("dissentingModelIds");
        assertThat(dissenting).containsExactly("mean_reversion");
    }

    @Test
    void institutionalEnsembleAcceptsAnExplicitCorrelationMatrix() throws Exception {
        var votes = List.of(
            Map.of("modelId", "a", "family", "x", "side", "BUY", "confidence", 0.8),
            Map.of("modelId", "b", "family", "y", "side", "BUY", "confidence", 0.8));
        var matrix = List.of(List.of(1.0, 0.0), List.of(0.0, 1.0));
        var res = post("/api/v1/institutional/ensemble", Map.of("votes", votes, "correlationMatrix", matrix));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(Json.asDouble(body.get("effectiveIndependentCount"))).isCloseTo(2.0, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void institutionalEnsembleRejectsAnInvalidSide() throws Exception {
        var votes = List.of(Map.of("modelId", "a", "family", "x", "side", "UP", "confidence", 0.8));
        var res = post("/api/v1/institutional/ensemble", Map.of("votes", votes));
        assertThat(res.statusCode()).isEqualTo(400);
    }

    @Test
    void institutionalEnsembleRejectsEmptyVotes() throws Exception {
        var res = post("/api/v1/institutional/ensemble", Map.of("votes", List.of()));
        assertThat(res.statusCode()).isEqualTo(400);
    }

    @Test
    void institutionalEnsembleRejectsMissingVotesField() throws Exception {
        var res = post("/api/v1/institutional/ensemble", Map.of());
        assertThat(res.statusCode()).isEqualTo(400);
    }

    // RegimeVolatilityOverlay (the Dynamic Regime & Volatility Multiplier Layer) had zero HTTP
    // endpoint - proves the new /institutional/advisory wiring, not the underlying math (already
    // covered by RegimeVolatilityOverlayTest at the unit level).

    @Test
    void institutionalAdvisoryFullyTrustsAnEnsembleInATrendAlignedNormalVolatilityRegime() throws Exception {
        var votes = List.of(Map.of("modelId", "factor", "family", "factor", "side", "BUY", "confidence", 0.8));
        var res = post("/api/v1/institutional/advisory", Map.of(
            "votes", votes, "regime", "BULL_TRENDING", "currentVolatility", 0.015));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(body.get("rawSide")).isEqualTo("BUY");
        assertThat(Json.asDouble(body.get("regimeMultiplier"))).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(Json.asDouble(body.get("adjustedConfidence"))).isCloseTo(0.8, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(body.get("gated")).isEqualTo(false);
    }

    @Test
    void institutionalAdvisoryDiscountsACounterTrendRegime() throws Exception {
        var votes = List.of(Map.of("modelId", "factor", "family", "factor", "side", "BUY", "confidence", 0.8));
        var res = post("/api/v1/institutional/advisory", Map.of(
            "votes", votes, "regime", "BEAR_TRENDING", "currentVolatility", 0.015));
        assertThat(res.statusCode()).isEqualTo(200);
        Map<String, Object> body = Json.asObject(Json.parse(res.body()));
        assertThat(Json.asDouble(body.get("adjustedConfidence"))).isLessThan(0.8);
    }

    @Test
    void institutionalAdvisoryRejectsAnInvalidRegime() throws Exception {
        var votes = List.of(Map.of("modelId", "factor", "family", "factor", "side", "BUY", "confidence", 0.8));
        var res = post("/api/v1/institutional/advisory", Map.of("votes", votes, "regime", "SIDEWAYS", "currentVolatility", 0.015));
        assertThat(res.statusCode()).isEqualTo(400);
    }

    @Test
    void institutionalAdvisoryRejectsMissingCurrentVolatility() throws Exception {
        var votes = List.of(Map.of("modelId", "factor", "family", "factor", "side", "BUY", "confidence", 0.8));
        var res = post("/api/v1/institutional/advisory", Map.of("votes", votes, "regime", "BULL_TRENDING"));
        assertThat(res.statusCode()).isEqualTo(400);
    }
}
