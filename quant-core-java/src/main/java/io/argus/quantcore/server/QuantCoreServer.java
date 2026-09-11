package io.argus.quantcore.server;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.institutional.math.AugmentedDickeyFuller;
import io.argus.quantcore.institutional.math.OrnsteinUhlenbeckEstimator;
import io.argus.quantcore.institutional.models.FactorAlphaEngine;
import io.argus.quantcore.institutional.models.GarchEngine;
import io.argus.quantcore.institutional.models.HmmRegimeEngine;
import io.argus.quantcore.institutional.models.StatArbEngine;
import io.argus.quantcore.institutional.models.VolatilityEngine;
import io.argus.quantcore.institutional.models.CorrelationEngine;
import io.argus.quantcore.institutional.models.QuantEnsembleEngine;
import io.argus.quantcore.institutional.models.RegimeVolatilityOverlay;
import io.argus.quantcore.institutional.data.MarketDataQualityEngine;
import io.argus.quantcore.institutional.models.RsiMeanReversionEngine;
import io.argus.quantcore.institutional.models.MacdCrossoverEngine;
import io.argus.quantcore.institutional.models.BollingerMeanReversionEngine;
import io.argus.quantcore.institutional.models.MovingAverageCrossoverEngine;
import io.argus.quantcore.institutional.models.DonchianChannelEngine;
import io.argus.quantcore.institutional.models.TrendStrengthEngine;
import io.argus.quantcore.institutional.models.MeanReversionZScoreEngine;
import io.argus.quantcore.institutional.models.StochasticOscillatorEngine;
import io.argus.quantcore.institutional.models.TimeSeriesMomentumEngine;
import io.argus.quantcore.institutional.models.VolumeSignalEngine;
import io.argus.quantcore.institutional.features.FeaturePipeline;
import io.argus.quantcore.institutional.features.FeatureSnapshot;
import io.argus.quantcore.features.RegimeEngine;
import io.argus.quantcore.logging.StructuredLogger;
import io.argus.quantcore.logging.TraceContext;
import io.argus.quantcore.server.json.Json;
import io.argus.quantcore.strategy.StrategyRegistry;
import io.argus.quantcore.strategy.types.StrategyContext;
import io.argus.quantcore.strategy.types.StrategyEvaluation;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
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
        server.createContext("/api/v1/features/regime/", this::handleFeaturesRegime);
        server.createContext("/api/v1/institutional/factors/", this::handleInstitutionalFactors);
        server.createContext("/api/v1/institutional/pairs", this::handleInstitutionalPairs);
        server.createContext("/api/v1/institutional/volatility/", this::handleInstitutionalVolatility);
        server.createContext("/api/v1/institutional/regime/", this::handleInstitutionalRegime);
        server.createContext("/api/v1/institutional/features/", this::handleInstitutionalFeatures);
        server.createContext("/api/v1/institutional/correlation", this::handleInstitutionalCorrelation);
        server.createContext("/api/v1/institutional/ensemble", this::handleInstitutionalEnsemble);
        server.createContext("/api/v1/institutional/advisory", this::handleInstitutionalAdvisory);
        // 2026-09-09: HTTP-exposes 10 previously-endpoint-less RESEARCH-status engines (real,
        // unit-tested Java classes that already existed - see config/engineOwnership.json).
        // Exposing an endpoint is not the same as wiring a live consumer: nothing in
        // JavaQuantAdvisoryService.ts or QuantSignalAgent.ts calls this route yet. It only makes
        // these engines reachable for backtesting/research tooling instead of dead code.
        server.createContext("/api/v1/institutional/strategy/", this::handleInstitutionalStrategy);
        // 2026-09-10: real, bars-owning path for the 5 CORE strategies (CoreStrategyRunner) -
        // distinct from /api/v1/evaluate above, which decodes a pre-built StrategyContext a TS
        // caller would have to construct. These two routes compute every feature in Java from raw
        // bars - see FeaturesToStrategyContextAdapter's own header for why that distinction is
        // load-bearing, not stylistic. Neither route emits a trade idea or calls ChiefTrader/
        // RiskEngine/OMS - purely evidence-producing, matching every other route in this file.
        server.createContext("/api/v1/quant/strategy/", this::handleCoreStrategyAssessment);
        server.createContext("/api/v1/quant/ensemble/", this::handleCoreEnsembleDecision);
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

    /**
     * 2026-09-10 (docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md §6): two request shapes
     * on the same route, distinguished by the presence of "resync":
     *   - Normal tick: {"symbol","price","volume"?,"timestampMs","sequence"?} - sequence is
     *     OPTIONAL for backward compatibility (a caller not yet sending it never gets a false gap
     *     report, matching the old no-sequence onTick() overload); once a caller does send it, a
     *     mismatch vs. lastAppliedSequence+1 is reported back as "gapDetected":true in the response
     *     so the TS bridge can react, rather than this route ever rejecting/dropping the tick.
     *   - Resync: {"symbol","resync":{"prices":[...],"volumes":[...],"sequence":N},"timestampMs"} -
     *     wholesale-replaces this symbol's state (SymbolState.resync/CircularDoubleArray.reset),
     *     self-healing regardless of how diverged the prior state was, matching every other
     *     resynchronization mechanism in this codebase's own established fail-closed-then-recover
     *     pattern.
     */
    private void handleTicks(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed"));
            return;
        }
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            String symbol = Json.asString(body.get("symbol"));
            long timestampMs = (long) Json.asDoublePrimitive(body.get("timestampMs"), 0);
            if (symbol == null || symbol.isBlank()) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "invalid symbol"));
                return;
            }

            Object resyncRaw = body.get("resync");
            if (resyncRaw != null) {
                Map<String, Object> resync = Json.asObject(resyncRaw);
                double[] resyncPrices = decodeDoubleArray(resync.get("prices"));
                double[] resyncVolumes = decodeDoubleArray(resync.get("volumes"));
                long sequence = (long) Json.asDoublePrimitive(resync.get("sequence"), -1);
                symbols.computeIfAbsent(symbol, s -> new SymbolState()).resync(resyncPrices, resyncVolumes, sequence, timestampMs);
                StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "TICK_RESYNC_APPLIED",
                    "Resynchronized state for " + symbol + " from " + resyncPrices.length + " canonical prices",
                    resolveTraceId(exchange), symbol, Map.of("sequence", (double) sequence, "priceCount", (double) resyncPrices.length));
                sendJson(exchange, 200, Map.of("ok", true, "resynced", true));
                return;
            }

            double price = Json.asDoublePrimitive(body.get("price"), Double.NaN);
            Double volume = Json.asDouble(body.get("volume"));
            if (!Double.isFinite(price) || price <= 0) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "invalid price"));
                return;
            }
            SymbolState state = symbols.computeIfAbsent(symbol, s -> new SymbolState());
            boolean gapDetected;
            Object sequenceRaw = body.get("sequence");
            if (sequenceRaw == null) {
                state.onTick(price, volume, timestampMs);
                gapDetected = false;
            } else {
                long sequence = (long) Json.asDoublePrimitive(sequenceRaw, -1);
                gapDetected = state.onTick(price, volume, timestampMs, sequence);
                if (gapDetected) {
                    StructuredLogger.log(StructuredLogger.Level.WARN, "QuantCoreJava", "TICK_SEQUENCE_GAP_DETECTED",
                        "Sequence gap detected for " + symbol + " - received sequence " + sequence + " was not the expected next value",
                        resolveTraceId(exchange), symbol, Map.of("receivedSequence", (double) sequence));
                }
            }
            // DEBUG, not INFO - high-frequency tick ingestion would otherwise flood the log file
            // during 100+ symbol live streaming (this is the exact bug class TechnicalAgent's own
            // debounce fix guarded against on the TS side - see technicalSignalCooldownMs).
            StructuredLogger.log(StructuredLogger.Level.DEBUG, "QuantCoreJava", "TICK_INGESTED",
                "Tick ingested for " + symbol, null, symbol, Map.of("price", price));
            sendJson(exchange, 200, Map.of("ok", true, "gapDetected", gapDetected));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body"));
        }
    }

    private static double[] decodeDoubleArray(Object raw) {
        if (!(raw instanceof List<?> rawList)) {
            return new double[0];
        }
        double[] out = new double[rawList.size()];
        for (int i = 0; i < rawList.size(); i++) {
            out[i] = Json.asDoublePrimitive(rawList.get(i), Double.NaN);
        }
        return out;
    }

    private void handleIndicators(HttpExchange exchange) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed"));
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String symbol = path.substring(path.lastIndexOf('/') + 1);
        String traceId = resolveTraceId(exchange);
        TraceContext.bind(traceId, symbol);
        try {
            SymbolState state = symbols.get(symbol);
            if (state == null) {
                sendJson(exchange, 404, Map.of("error", "unknown symbol - no ticks received yet: " + symbol));
                return;
            }
            long start = System.nanoTime();
            IndicatorSnapshot snap = state.snapshot(symbol);
            long latencyUs = (System.nanoTime() - start) / 1000;
            Map<String, Object> logData = new java.util.LinkedHashMap<>();
            logData.put("rsi", snap.rsi());
            logData.put("macd", snap.macd());
            logData.put("macdSignal", snap.macdSignal());
            logData.put("calculationLatencyUs", (double) latencyUs);
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "INDICATOR_COMPUTED",
                "Computed indicators for " + symbol, traceId, symbol, logData);
            sendJson(exchange, 200, indicatorSnapshotToJson(snap));
        } finally {
            TraceContext.clear();
        }
    }

    private void handleEvaluate(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed"));
            return;
        }
        String traceId = resolveTraceId(exchange);
        String headerSymbol = exchange.getRequestHeaders().getFirst("X-Symbol");
        TraceContext.bind(traceId, headerSymbol);
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
            TraceContext.bind(traceId, ctx.symbol());
            StrategyEvaluation eval = StrategyRegistry.evaluate(strategyId, ctx).orElseThrow();
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "STRATEGY_EVALUATED",
                "Evaluated " + strategyId + " for " + ctx.symbol(), traceId, ctx.symbol(),
                Map.of("strategyId", strategyId, "side", eval.side().name(), "confidence", eval.confidence()));
            sendJson(exchange, 200, evaluationToSignalJson(eval, ctx));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    /**
     * POST /api/v1/quant/strategy/{strategyId}/{symbol}. Body: {"bars":[{timestampMs,open,high,
     * low,close,volume},...], "benchmarks"?: {"spy":{"bars":[...]}, "qqq":{...}, "iwm":{...},
     * "sectorName":"...", "sectorEtf":"...", "sector":{"bars":[...]}}}. benchmarks is optional -
     * only MOMENTUM_BREAKOUT reads marketContext among the 5 CORE strategies; omit it entirely for
     * the other 4. Returns a CoreStrategyRunner.Assessment - real Java-computed features, real
     * Java strategy decision logic, never a TS-supplied StrategyContext (see CoreStrategyRunner's
     * own header for why that distinction matters).
     */
    private void handleCoreStrategyAssessment(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed - POST a JSON body of bars"));
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String[] parts = path.substring("/api/v1/quant/strategy/".length()).split("/");
        if (parts.length != 2 || parts[0].isBlank() || parts[1].isBlank()) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "path must be /api/v1/quant/strategy/{strategyId}/{symbol}"));
            return;
        }
        String strategyId = parts[0];
        String symbol = parts[1];
        String traceId = resolveTraceId(exchange);
        TraceContext.bind(traceId, symbol);
        try {
            if (!CoreStrategyRunner.isCoreStrategy(strategyId)) {
                sendJson(exchange, 404, Map.of("ok", false, "error", "unknown or non-CORE strategyId: " + strategyId));
                return;
            }
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            Bar[] bars = decodeBars(body.get("bars"));
            if (bars == null || bars.length == 0) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "bars array is required"));
                return;
            }
            FeaturesToStrategyContextAdapter.BenchmarkBars benchmarks = decodeBenchmarks(body.get("benchmarks"));
            CoreStrategyRunner.Assessment assessment = CoreStrategyRunner.evaluate(strategyId, symbol, List.of(bars), benchmarks);
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "QUANT_STRATEGY_EVALUATED",
                "Evaluated " + strategyId + " for " + symbol + " from " + bars.length + " Java-owned bars",
                traceId, symbol, Map.of("strategyId", strategyId, "direction", assessment.direction(),
                    "dataQuality", assessment.dataQuality().name()));
            sendJson(exchange, 200, assessmentToJson(assessment));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    /**
     * POST /api/v1/quant/ensemble/{symbol}. Same body shape as handleCoreStrategyAssessment.
     * Runs all 5 CORE strategies from the same Java-computed bars and combines them via the
     * EXISTING QuantEnsembleEngine (institutional/models) - never a second correlation system.
     */
    private void handleCoreEnsembleDecision(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed - POST a JSON body of bars"));
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String symbol = path.substring("/api/v1/quant/ensemble/".length());
        if (symbol.isBlank()) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "path must be /api/v1/quant/ensemble/{symbol}"));
            return;
        }
        String traceId = resolveTraceId(exchange);
        TraceContext.bind(traceId, symbol);
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            Bar[] bars = decodeBars(body.get("bars"));
            if (bars == null || bars.length == 0) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "bars array is required"));
                return;
            }
            FeaturesToStrategyContextAdapter.BenchmarkBars benchmarks = decodeBenchmarks(body.get("benchmarks"));
            CoreStrategyRunner.EnsembleDecision decision = CoreStrategyRunner.runEnsemble(symbol, List.of(bars), benchmarks);
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "QUANT_ENSEMBLE_COMPLETED",
                "Combined " + decision.strategyCount() + " CORE strategies for " + symbol,
                traceId, symbol, Map.of("status", decision.status().name(), "direction", decision.direction(),
                    "effectiveIndependentCount", decision.effectiveIndependentCount()));
            sendJson(exchange, 200, ensembleDecisionToJson(decision));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    private static FeaturesToStrategyContextAdapter.BenchmarkBars decodeBenchmarks(Object raw) {
        if (raw == null) {
            return null;
        }
        Map<String, Object> b = Json.asObject(raw);
        return new FeaturesToStrategyContextAdapter.BenchmarkBars(
            decodeBenchmarkInput(b.get("spy")),
            decodeBenchmarkInput(b.get("qqq")),
            decodeBenchmarkInput(b.get("iwm")),
            Json.asString(b.get("sectorName")),
            Json.asString(b.get("sectorEtf")),
            decodeBenchmarkInput(b.get("sector"))
        );
    }

    private static io.argus.quantcore.features.MarketContext.BenchmarkInput decodeBenchmarkInput(Object raw) {
        if (raw == null) {
            return io.argus.quantcore.features.MarketContext.BenchmarkInput.failed("not supplied");
        }
        Map<String, Object> b = Json.asObject(raw);
        Bar[] bars = decodeBars(b.get("bars"));
        return bars == null
            ? io.argus.quantcore.features.MarketContext.BenchmarkInput.failed("not supplied")
            : io.argus.quantcore.features.MarketContext.BenchmarkInput.ok(List.of(bars));
    }

    private static Map<String, Object> assessmentToJson(CoreStrategyRunner.Assessment a) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("strategyId", a.strategyId());
        m.put("strategyVersion", a.strategyVersion());
        m.put("featureVersion", a.featureVersion());
        m.put("symbol", a.symbol());
        m.put("direction", a.direction());
        m.put("score", a.score() == null ? null : (double) a.score());
        m.put("confidence", a.confidence());
        m.put("reason", a.reason());
        m.put("regime", a.regime());
        m.put("dataQuality", a.dataQuality().name());
        m.put("evaluationTimestampMs", (double) a.evaluationTimestampMs());
        m.put("latencyMs", (double) a.latencyMs());
        return m;
    }

    private static Map<String, Object> ensembleDecisionToJson(CoreStrategyRunner.EnsembleDecision d) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("status", d.status().name());
        m.put("direction", d.direction());
        m.put("score", d.score());
        m.put("confidence", d.confidence());
        m.put("reason", d.reason());
        m.put("regime", d.regime());
        m.put("timestampMs", (double) d.timestampMs());
        m.put("featureVersion", d.featureVersion());
        m.put("strategyVersion", d.strategyVersion());
        m.put("strategyCount", (double) d.strategyCount());
        m.put("agreeingCount", (double) d.agreeingCount());
        m.put("effectiveIndependentCount", d.effectiveIndependentCount());
        m.put("contributingStrategies", d.contributingStrategies());
        m.put("contributingFamilies", d.contributingFamilies());
        List<Object> assessments = new java.util.ArrayList<>();
        for (CoreStrategyRunner.Assessment a : d.assessments()) {
            assessments.add(assessmentToJson(a));
        }
        m.put("assessments", assessments);
        return m;
    }

    /**
     * POST, not the spec's original GET: this is a stateless function of caller-supplied bar
     * history (there is no server-side bar store here - SymbolState only tracks tick-level
     * indicator state), so the payload is a real JSON body, not a query string. Disclosed
     * deviation, matching this session's practice of correcting a spec's assumed shape against
     * what the code actually supports rather than force-fitting it.
     */
    private void handleInstitutionalFactors(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed - POST a JSON body of bars"));
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String symbol = path.substring(path.lastIndexOf('/') + 1);
        String traceId = resolveTraceId(exchange);
        TraceContext.bind(traceId, symbol);
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            Bar[] bars = decodeBars(body.get("bars"));
            if (bars == null || bars.length == 0) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "bars array is required"));
                return;
            }
            int momentumDays = (int) Json.asDoublePrimitive(body.get("momentumDays"), 20);
            int smaWindow = (int) Json.asDoublePrimitive(body.get("smaWindow"), 10);
            int zScoreWindow = (int) Json.asDoublePrimitive(body.get("zScoreWindow"), 60);

            FactorAlphaEngine.FactorScores scores = FactorAlphaEngine.compute(bars, momentumDays, smaWindow, zScoreWindow);
            if (scores == null) {
                sendJson(exchange, 422, Map.of("ok", false, "error", "insufficient bar history for the requested windows",
                    "barsProvided", (double) bars.length));
                return;
            }
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "INSTITUTIONAL_FACTORS_COMPUTED",
                "Computed 5-factor composite for " + symbol, traceId, symbol,
                Map.of("composite", scores.composite()));
            sendJson(exchange, 200, factorScoresToJson(symbol, scores));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    /** POST for the same reason as handleInstitutionalFactors - a real pair evaluation needs two full bar series in the body. */
    private void handleInstitutionalPairs(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed - POST a JSON body of both symbols' bars"));
            return;
        }
        String traceId = resolveTraceId(exchange);
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            String primarySymbol = Json.asString(body.get("primarySymbol"));
            String pairSymbol = Json.asString(body.get("pairSymbol"));
            Bar[] primaryBars = decodeBars(body.get("primaryBars"));
            Bar[] pairBars = decodeBars(body.get("pairBars"));
            int zScoreWindow = (int) Json.asDoublePrimitive(body.get("zScoreWindow"), 60);

            if (primarySymbol == null || pairSymbol == null || primaryBars == null || pairBars == null) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "primarySymbol, pairSymbol, primaryBars, and pairBars are all required"));
                return;
            }
            TraceContext.bind(traceId, primarySymbol);

            double[] primaryClose = closesOf(primaryBars);
            double[] pairClose = closesOf(pairBars);
            StatArbEngine.PairResult result = StatArbEngine.evaluatePair(primaryClose, pairClose, zScoreWindow);
            if (result == null) {
                sendJson(exchange, 422, Map.of("ok", false, "error", "insufficient or misaligned bar history to fit the pair"));
                return;
            }
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "INSTITUTIONAL_PAIR_EVALUATED",
                "Evaluated pair " + primarySymbol + "/" + pairSymbol, traceId, primarySymbol,
                Map.of("cointegrated", result.cointegrated(), "hedgeRatio", result.hedgeRatio()));
            sendJson(exchange, 200, pairResultToJson(primarySymbol, pairSymbol, result));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    /**
     * GarchEngine.fit() was real, compiled, and unit-tested (GarchEngineTest.java) but had zero
     * HTTP endpoint before this pass - unreachable from the TypeScript control plane. Same POST-
     * bars-in-body shape as handleInstitutionalFactors, for the same reason (stateless function of
     * caller-supplied bar history).
     */
    private void handleInstitutionalVolatility(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed - POST a JSON body of bars"));
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String symbol = path.substring(path.lastIndexOf('/') + 1);
        String traceId = resolveTraceId(exchange);
        TraceContext.bind(traceId, symbol);
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            Bar[] bars = decodeBars(body.get("bars"));
            if (bars == null || bars.length == 0) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "bars array is required"));
                return;
            }
            int stepsAhead = (int) Json.asDoublePrimitive(body.get("forecastStepsAhead"), 1);

            double[] returns = simpleReturns(closesOf(bars));
            GarchEngine.Params params = GarchEngine.fit(returns);
            if (params == null) {
                sendJson(exchange, 422, Map.of("ok", false, "error", "insufficient return history to fit GARCH(1,1) - need at least 30 returns",
                    "returnsAvailable", (double) returns.length));
                return;
            }
            double[] variancePath = GarchEngine.conditionalVariancePath(returns, params);
            double lastReturn = returns[returns.length - 1];
            double lastVariance = variancePath[variancePath.length - 1];
            double forecastVariance = GarchEngine.forecastVariance(params, lastReturn, lastVariance, stepsAhead);

            // VolatilityEngine reuses GarchEngine internally too, but computing it separately here
            // (rather than refactoring this handler to call VolatilityEngine.assess() outright) is
            // the additive, backward-compatible choice - existing fields/behavior above are
            // untouched; realizedVolPercentile/compressed/expanded are new, real fields, not a
            // second GARCH fit (VolatilityEngine.assess's own GARCH fit is independent of this
            // one, both operate on the identical `returns` derivation, so both agree by construction).
            int realizedVolWindow = (int) Json.asDoublePrimitive(body.get("realizedVolWindow"), 20);
            VolatilityEngine.VolatilityAssessment volAssessment = VolatilityEngine.assess(symbol, closesOf(bars), realizedVolWindow);

            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "INSTITUTIONAL_VOLATILITY_COMPUTED",
                "Fit GARCH(1,1) for " + symbol, traceId, symbol,
                Map.of("alpha", params.alpha(), "beta", params.beta()));
            sendJson(exchange, 200, garchResultToJson(symbol, params, lastVariance, forecastVariance, stepsAhead, returns.length, volAssessment));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    /**
     * HmmRegimeEngine.fit()/decode() were real, compiled, and unit-tested (HmmRegimeEngineTest.java)
     * but had zero HTTP endpoint before this pass. Observations are (dailyReturn, realizedVol) pairs
     * built from the same bars the caller already sends - see rollingVolatilitySeries's own doc.
     */
    private void handleInstitutionalRegime(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed - POST a JSON body of bars"));
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String symbol = path.substring(path.lastIndexOf('/') + 1);
        String traceId = resolveTraceId(exchange);
        TraceContext.bind(traceId, symbol);
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            Bar[] bars = decodeBars(body.get("bars"));
            if (bars == null || bars.length == 0) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "bars array is required"));
                return;
            }
            int realizedVolWindow = (int) Json.asDoublePrimitive(body.get("realizedVolWindow"), 10);
            int maxIterations = (int) Json.asDoublePrimitive(body.get("maxIterations"), 100);

            HmmRegimeEngine.Observation[] observations = buildRegimeObservations(bars, realizedVolWindow);
            if (observations == null) {
                sendJson(exchange, 422, Map.of("ok", false, "error", "insufficient bar history for the requested realizedVolWindow"));
                return;
            }
            HmmRegimeEngine.Fitted fitted = HmmRegimeEngine.fit(observations, maxIterations);
            if (fitted == null) {
                sendJson(exchange, 422, Map.of("ok", false, "error", "insufficient observations to fit the 4-state HMM (need at least 40)",
                    "observationsAvailable", (double) observations.length));
                return;
            }
            HmmRegimeEngine.Regime currentRegime = HmmRegimeEngine.currentRegime(fitted, observations);
            // Additive: real volatility-compression/expansion context alongside the HMM label,
            // reusing VolatilityEngine (see handleInstitutionalVolatility's own comment on why this
            // is a second, independent GARCH fit rather than a refactor of either handler).
            VolatilityEngine.VolatilityAssessment volAssessment = VolatilityEngine.assess(symbol, closesOf(bars), realizedVolWindow);

            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "INSTITUTIONAL_REGIME_COMPUTED",
                "Fit 4-state HMM regime for " + symbol, traceId, symbol,
                Map.of("currentRegime", currentRegime.name()));
            sendJson(exchange, 200, hmmFittedToJson(symbol, fitted, currentRegime, observations.length, volAssessment));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    /**
     * FeaturePipeline.build() was real but had zero HTTP endpoint before this pass - the
     * institutional activation plan's "models should consume a FeatureSnapshot, not each
     * independently parse Bar[]" foundation. asOfMs defaults to the last bar's own timestamp (not
     * wall-clock time) so a historical/replay batch call is never spuriously flagged stale against
     * whatever time it happens to be called at - callers analyzing genuinely live data should pass
     * asOfMs explicitly.
     */
    private void handleInstitutionalFeatures(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed - POST a JSON body of bars"));
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String symbol = path.substring(path.lastIndexOf('/') + 1);
        String traceId = resolveTraceId(exchange);
        TraceContext.bind(traceId, symbol);
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            Bar[] bars = decodeBars(body.get("bars"));
            if (bars == null || bars.length == 0) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "bars array is required"));
                return;
            }
            long asOfMs = (long) Json.asDoublePrimitive(body.get("asOfMs"), bars[bars.length - 1].timestampMs());

            FeatureSnapshot snapshot = FeaturePipeline.build(symbol, bars, asOfMs);
            if (snapshot == null) {
                MarketDataQualityEngine.QualityReport quality = MarketDataQualityEngine.assess(bars, asOfMs, 30, 5L * 24 * 60 * 60 * 1000, 8.0);
                sendJson(exchange, 422, Map.of("ok", false, "error", "data quality is RED - refusing to build a feature snapshot",
                    "qualityIssues", java.util.Arrays.asList(quality.issues())));
                return;
            }
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "INSTITUTIONAL_FEATURES_COMPUTED",
                "Built feature snapshot for " + symbol, traceId, symbol,
                Map.of("qualityStatus", snapshot.qualityReport().status().name()));
            sendJson(exchange, 200, featureSnapshotToJson(snapshot));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    /**
     * SHADOW-ONLY parity endpoint (docs/architecture/JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md,
     * Phase 2 feature-pipeline follow-up): a pure, stateless function of caller-supplied bars,
     * same POST-bars-in-body shape as handleInstitutionalFactors/Volatility/Regime/Features above
     * (decodeBars() on a {@code {"bars":[...]}} body) - no new serialization convention invented.
     * Returns RegimeEngine.classifyRegime(bars)'s TOP-LEVEL fields only (regime, trendStrength,
     * volatility, marketStructure, confidence, insufficientData) - the nested trend/volatility/
     * priceAction feature sub-objects are intentionally NOT serialized here (TS-side
     * QuantCoreBridge.compareRegimeParity only diffs the top-level fields; a full nested-feature
     * parity comparison is a larger follow-up, not attempted in this pass).
     */
    private void handleFeaturesRegime(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed - POST a JSON body of bars"));
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String symbol = path.substring(path.lastIndexOf('/') + 1);
        String traceId = resolveTraceId(exchange);
        TraceContext.bind(traceId, symbol);
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            Bar[] bars = decodeBars(body.get("bars"));
            if (bars == null || bars.length == 0) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "bars array is required"));
                return;
            }
            RegimeEngine.Result result = RegimeEngine.classifyRegime(List.of(bars));
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "FEATURES_REGIME_COMPUTED",
                "Classified regime for " + symbol, traceId, symbol,
                Map.of("regime", result.regime(), "confidence", result.confidence()));
            sendJson(exchange, 200, regimeResultToJson(symbol, result));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    private static Map<String, Object> regimeResultToJson(String symbol, RegimeEngine.Result r) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("symbol", symbol);
        m.put("regime", r.regime());
        m.put("trendStrength", r.trendStrength());
        m.put("volatility", r.volatility());
        m.put("marketStructure", r.marketStructure());
        m.put("confidence", r.confidence());
        m.put("insufficientData", r.insufficientData());
        return m;
    }

    /**
     * CorrelationEngine (wrapping the previously-uncalled-anywhere EwmaCovariance) had zero HTTP
     * endpoint before this pass. Body: {"symbols":[...], "returnsByAsset":[[...],[...]], "lambda":0.94}.
     */
    private void handleInstitutionalCorrelation(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed - POST symbols + returnsByAsset"));
            return;
        }
        String traceId = resolveTraceId(exchange);
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            Object rawSymbols = body.get("symbols");
            Object rawReturns = body.get("returnsByAsset");
            if (!(rawSymbols instanceof java.util.List<?> symbolList) || !(rawReturns instanceof java.util.List<?> returnsList)) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "symbols and returnsByAsset arrays are both required"));
                return;
            }
            String[] symbols = new String[symbolList.size()];
            for (int i = 0; i < symbolList.size(); i++) symbols[i] = String.valueOf(symbolList.get(i));
            double[][] returnsByAsset = new double[returnsList.size()][];
            for (int i = 0; i < returnsList.size(); i++) {
                java.util.List<?> row = (java.util.List<?>) returnsList.get(i);
                double[] arr = new double[row.size()];
                for (int j = 0; j < row.size(); j++) arr[j] = Json.asDoublePrimitive(row.get(j), Double.NaN);
                returnsByAsset[i] = arr;
            }
            double lambda = Json.asDoublePrimitive(body.get("lambda"), io.argus.quantcore.institutional.math.EwmaCovariance.DEFAULT_LAMBDA);

            CorrelationEngine.CorrelationResult result = CorrelationEngine.compute(symbols, returnsByAsset, lambda);
            if (result == null) {
                sendJson(exchange, 422, Map.of("ok", false, "error", "ragged or insufficient returnsByAsset input (all assets must share the same length, at least 2)"));
                return;
            }
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "INSTITUTIONAL_CORRELATION_COMPUTED",
                "Computed EWMA correlation for " + symbols.length + " symbols", traceId, symbols.length > 0 ? symbols[0] : null,
                Map.of("symbolCount", (double) symbols.length));
            sendJson(exchange, 200, correlationResultToJson(result));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    private static Map<String, Object> featureSnapshotToJson(FeatureSnapshot s) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("symbol", s.symbol());
        m.put("asOfMs", (double) s.asOfMs());
        m.put("close", s.close());
        m.put("rsi", s.rsi());
        m.put("macd", s.macd());
        m.put("macdSignal", s.macdSignal());
        m.put("bbUpper", s.bbUpper());
        m.put("bbLower", s.bbLower());
        m.put("atr", s.atr());
        m.put("realizedVolatility", s.realizedVolatility());
        m.put("barsUsed", (double) s.barsUsed());
        Map<String, Object> quality = new java.util.LinkedHashMap<>();
        quality.put("status", s.qualityReport().status().name());
        quality.put("stale", s.qualityReport().stale());
        quality.put("sufficientHistory", s.qualityReport().sufficientHistory());
        quality.put("anomalyDetected", s.qualityReport().anomalyDetected());
        quality.put("gapDetected", s.qualityReport().gapDetected());
        quality.put("issues", java.util.Arrays.asList(s.qualityReport().issues()));
        m.put("qualityReport", quality);
        return m;
    }

    /**
     * QuantEnsembleEngine had zero HTTP endpoint before this pass. Body:
     * {"votes":[{"modelId":"...","family":"...","side":"BUY|SELL|NEUTRAL","confidence":0.7}, ...],
     *  "correlationMatrix": [[...]] (optional - defaults to the declared family-based assumption,
     *  see QuantEnsembleEngine's own header for why real measured correlation isn't available yet)}.
     * Generic and source-agnostic by design: this endpoint does not presume which upstream models
     * (GARCH/regime/factor/a future model) supplied the votes, and does not itself decide what
     * counts as a "directional vote" - a caller must not force a non-directional signal (e.g. a
     * volatility forecast) into a fabricated BUY/SELL here.
     */
    private void handleInstitutionalEnsemble(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed - POST a JSON body of votes"));
            return;
        }
        String traceId = resolveTraceId(exchange);
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            Object rawVotes = body.get("votes");
            if (!(rawVotes instanceof java.util.List<?> voteList) || voteList.isEmpty()) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "a non-empty votes array is required"));
                return;
            }
            QuantEnsembleEngine.ModelVote[] votes = new QuantEnsembleEngine.ModelVote[voteList.size()];
            for (int i = 0; i < voteList.size(); i++) {
                Map<String, Object> v = Json.asObject(voteList.get(i));
                String modelId = Json.asString(v.get("modelId"));
                String family = Json.asString(v.get("family"));
                String sideRaw = Json.asString(v.get("side"));
                double confidence = Json.asDoublePrimitive(v.get("confidence"), Double.NaN);
                if (modelId == null || sideRaw == null || !Double.isFinite(confidence)) {
                    sendJson(exchange, 400, Map.of("ok", false, "error", "each vote requires modelId, side, and a finite confidence"));
                    return;
                }
                QuantEnsembleEngine.Side side;
                try {
                    side = QuantEnsembleEngine.Side.valueOf(sideRaw);
                } catch (IllegalArgumentException e) {
                    sendJson(exchange, 400, Map.of("ok", false, "error", "invalid side \"" + sideRaw + "\" - must be BUY, SELL, or NEUTRAL"));
                    return;
                }
                votes[i] = new QuantEnsembleEngine.ModelVote(modelId, family, side, confidence);
            }

            Object rawMatrix = body.get("correlationMatrix");
            double[][] correlationMatrix;
            if (rawMatrix instanceof java.util.List<?> matrixList) {
                correlationMatrix = new double[matrixList.size()][];
                for (int i = 0; i < matrixList.size(); i++) {
                    java.util.List<?> row = (java.util.List<?>) matrixList.get(i);
                    double[] arr = new double[row.size()];
                    for (int j = 0; j < row.size(); j++) arr[j] = Json.asDoublePrimitive(row.get(j), Double.NaN);
                    correlationMatrix[i] = arr;
                }
                if (correlationMatrix.length != votes.length) {
                    sendJson(exchange, 400, Map.of("ok", false, "error", "correlationMatrix must be the same size as votes"));
                    return;
                }
            } else {
                correlationMatrix = QuantEnsembleEngine.defaultFamilyCorrelationMatrix(votes);
            }

            QuantEnsembleEngine.EnsembleResult result = QuantEnsembleEngine.combine(votes, correlationMatrix);
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "INSTITUTIONAL_ENSEMBLE_COMPUTED",
                "Combined " + votes.length + " model votes", traceId, votes.length > 0 ? votes[0].modelId() : null,
                Map.of("rawSide", result.rawSide().name(), "effectiveIndependentCount", result.effectiveIndependentCount()));
            sendJson(exchange, 200, ensembleResultToJson(result));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    private static Map<String, Object> ensembleResultToJson(QuantEnsembleEngine.EnsembleResult r) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("rawSide", r.rawSide().name());
        m.put("totalVotes", (double) r.totalVotes());
        m.put("agreeingCount", (double) r.agreeingCount());
        m.put("avgConfidenceOfAgreeing", r.avgConfidenceOfAgreeing());
        m.put("effectiveIndependentCount", r.effectiveIndependentCount());
        m.put("agreeingModelIds", java.util.Arrays.asList(r.agreeingModelIds()));
        m.put("dissentingModelIds", java.util.Arrays.asList(r.dissentingModelIds()));
        return m;
    }

    /**
     * The Dynamic Regime & Volatility Multiplier Layer's HTTP entry point: computes the
     * correlation-adjusted ensemble (same math as handleInstitutionalEnsemble) and then applies
     * RegimeVolatilityOverlay over it in one call. Body adds "regime" (one of HmmRegimeEngine's 4
     * labels) and "currentVolatility" (a real realized-volatility number the caller already has,
     * e.g. from /institutional/volatility's or /institutional/regime's own realizedVolatility
     * field) on top of handleInstitutionalEnsemble's existing votes/correlationMatrix body shape.
     */
    private void handleInstitutionalAdvisory(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed - POST votes, regime, and currentVolatility"));
            return;
        }
        String traceId = resolveTraceId(exchange);
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            Object rawVotes = body.get("votes");
            if (!(rawVotes instanceof java.util.List<?> voteList) || voteList.isEmpty()) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "a non-empty votes array is required"));
                return;
            }
            String regimeRaw = Json.asString(body.get("regime"));
            double currentVolatility = Json.asDoublePrimitive(body.get("currentVolatility"), Double.NaN);
            if (regimeRaw == null || !Double.isFinite(currentVolatility) || currentVolatility < 0) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "regime (a valid HmmRegimeEngine.Regime name) and a non-negative currentVolatility are both required"));
                return;
            }
            io.argus.quantcore.institutional.models.HmmRegimeEngine.Regime regime;
            try {
                regime = io.argus.quantcore.institutional.models.HmmRegimeEngine.Regime.valueOf(regimeRaw);
            } catch (IllegalArgumentException e) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "invalid regime \"" + regimeRaw + "\" - must be BULL_TRENDING, BEAR_TRENDING, MEAN_REVERTING, or HIGH_VOL_CHAOS"));
                return;
            }

            QuantEnsembleEngine.ModelVote[] votes = new QuantEnsembleEngine.ModelVote[voteList.size()];
            for (int i = 0; i < voteList.size(); i++) {
                Map<String, Object> v = Json.asObject(voteList.get(i));
                String modelId = Json.asString(v.get("modelId"));
                String family = Json.asString(v.get("family"));
                String sideRaw = Json.asString(v.get("side"));
                double confidence = Json.asDoublePrimitive(v.get("confidence"), Double.NaN);
                if (modelId == null || sideRaw == null || !Double.isFinite(confidence)) {
                    sendJson(exchange, 400, Map.of("ok", false, "error", "each vote requires modelId, side, and a finite confidence"));
                    return;
                }
                QuantEnsembleEngine.Side side;
                try {
                    side = QuantEnsembleEngine.Side.valueOf(sideRaw);
                } catch (IllegalArgumentException e) {
                    sendJson(exchange, 400, Map.of("ok", false, "error", "invalid side \"" + sideRaw + "\" - must be BUY, SELL, or NEUTRAL"));
                    return;
                }
                votes[i] = new QuantEnsembleEngine.ModelVote(modelId, family, side, confidence);
            }

            Object rawMatrix = body.get("correlationMatrix");
            double[][] correlationMatrix;
            if (rawMatrix instanceof java.util.List<?> matrixList) {
                correlationMatrix = new double[matrixList.size()][];
                for (int i = 0; i < matrixList.size(); i++) {
                    java.util.List<?> row = (java.util.List<?>) matrixList.get(i);
                    double[] arr = new double[row.size()];
                    for (int j = 0; j < row.size(); j++) arr[j] = Json.asDoublePrimitive(row.get(j), Double.NaN);
                    correlationMatrix[i] = arr;
                }
                if (correlationMatrix.length != votes.length) {
                    sendJson(exchange, 400, Map.of("ok", false, "error", "correlationMatrix must be the same size as votes"));
                    return;
                }
            } else {
                correlationMatrix = QuantEnsembleEngine.defaultFamilyCorrelationMatrix(votes);
            }

            QuantEnsembleEngine.EnsembleResult ensemble = QuantEnsembleEngine.combine(votes, correlationMatrix);
            RegimeVolatilityOverlay.AdjustedAdvisory advisory = RegimeVolatilityOverlay.apply(ensemble, regime, currentVolatility);

            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "INSTITUTIONAL_ADVISORY_COMPUTED",
                "Computed regime/volatility-adjusted advisory from " + votes.length + " votes", traceId, votes.length > 0 ? votes[0].modelId() : null,
                Map.of("adjustedConfidence", advisory.adjustedConfidence(), "gated", advisory.gated()));
            sendJson(exchange, 200, advisoryToJson(ensemble, advisory));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    private static Map<String, Object> advisoryToJson(QuantEnsembleEngine.EnsembleResult ensemble, RegimeVolatilityOverlay.AdjustedAdvisory a) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("rawSide", a.rawSide().name());
        m.put("rawAvgConfidence", a.rawAvgConfidence());
        m.put("rawEffectiveIndependentCount", a.rawEffectiveIndependentCount());
        m.put("regime", a.regime().name());
        m.put("regimeMultiplier", a.regimeMultiplier());
        m.put("currentVolatility", a.currentVolatility());
        m.put("volatilityMultiplier", a.volatilityMultiplier());
        m.put("adjustedConfidence", a.adjustedConfidence());
        m.put("gated", a.gated());
        m.put("reasoning", a.reasoning());
        m.put("agreeingModelIds", java.util.Arrays.asList(ensemble.agreeingModelIds()));
        m.put("dissentingModelIds", java.util.Arrays.asList(ensemble.dissentingModelIds()));
        return m;
    }

    private static Map<String, Object> correlationResultToJson(CorrelationEngine.CorrelationResult r) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("symbols", java.util.Arrays.asList(r.symbols()));
        m.put("lambda", r.lambda());
        java.util.List<Object> matrix = new java.util.ArrayList<>();
        for (double[] row : r.correlationMatrix()) {
            java.util.List<Double> rowList = new java.util.ArrayList<>();
            for (double v : row) rowList.add(v);
            matrix.add(rowList);
        }
        m.put("correlationMatrix", matrix);
        return m;
    }

    /** Simple (non-log) daily returns from closes, same convention FactorAlphaEngine.simpleReturns uses. */
    private static double[] simpleReturns(double[] close) {
        double[] out = new double[close.length - 1];
        for (int i = 1; i < close.length; i++) {
            out[i - 1] = close[i - 1] == 0 ? 0 : (close[i] - close[i - 1]) / close[i - 1];
        }
        return out;
    }

    /**
     * Builds (dailyReturn, realizedVol) observation pairs for HmmRegimeEngine: returns[] has
     * length bars.length-1; the trailing-window realized-vol series (window W) has length
     * returns.length-W+1, tail-aligned to returns indices [W-1 .. returns.length-1] - so
     * observations[i] pairs returns[i+W-1] with rollingVol[i], the same alignment
     * FactorAlphaEngine.rollingVolatilitySeries's own tail-aligned convention uses.
     */
    private static HmmRegimeEngine.Observation[] buildRegimeObservations(Bar[] bars, int window) {
        double[] returns = simpleReturns(closesOf(bars));
        if (returns.length < window) {
            return null;
        }
        int outLen = returns.length - window + 1;
        HmmRegimeEngine.Observation[] out = new HmmRegimeEngine.Observation[outLen];
        for (int i = 0; i < outLen; i++) {
            double sum = 0;
            double sumSq = 0;
            for (int j = i; j < i + window; j++) {
                sum += returns[j];
            }
            double mean = sum / window;
            for (int j = i; j < i + window; j++) {
                double diff = returns[j] - mean;
                sumSq += diff * diff;
            }
            double realizedVol = Math.sqrt(sumSq / window);
            out[i] = new HmmRegimeEngine.Observation(returns[i + window - 1], realizedVol);
        }
        return out;
    }

    private static Map<String, Object> garchResultToJson(String symbol, GarchEngine.Params p, double lastConditionalVariance, double forecastVariance, int stepsAhead, int returnsUsed, VolatilityEngine.VolatilityAssessment volAssessment) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("symbol", symbol);
        m.put("omega", p.omega());
        m.put("alpha", p.alpha());
        m.put("beta", p.beta());
        m.put("persistence", p.alpha() + p.beta());
        m.put("logLikelihood", p.logLikelihood());
        m.put("unconditionalVariance", p.unconditionalVariance());
        m.put("lastConditionalVariance", lastConditionalVariance);
        m.put("forecastStepsAhead", (double) stepsAhead);
        m.put("forecastVariance", forecastVariance);
        m.put("forecastVolatility", Math.sqrt(Math.max(forecastVariance, 0)));
        m.put("returnsUsed", (double) returnsUsed);
        // Additive fields from VolatilityEngine (institutional activation plan Phase 1) - a real
        // percentile-rank of current realized vol against its own trailing window, never fabricated.
        m.put("realizedVolatility", volAssessment.realizedVolatility());
        m.put("realizedVolPercentile", volAssessment.realizedVolPercentile());
        m.put("volatilityCompressed", volAssessment.compressed());
        m.put("volatilityExpanded", volAssessment.expanded());
        return m;
    }

    private static Map<String, Object> hmmFittedToJson(String symbol, HmmRegimeEngine.Fitted fitted, HmmRegimeEngine.Regime currentRegime, int observationCount, VolatilityEngine.VolatilityAssessment volAssessment) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("symbol", symbol);
        m.put("currentRegime", currentRegime.name());
        m.put("logLikelihood", fitted.logLikelihood());
        m.put("observationCount", (double) observationCount);
        // Additive: real volatility-compression/expansion context alongside the HMM label.
        m.put("volatilityCompressed", volAssessment.compressed());
        m.put("volatilityExpanded", volAssessment.expanded());
        m.put("volatilityPercentile", volAssessment.realizedVolPercentile());
        java.util.List<String> stateLabels = new java.util.ArrayList<>();
        for (HmmRegimeEngine.Regime r : fitted.stateLabels()) stateLabels.add(r.name());
        m.put("stateLabels", stateLabels);
        java.util.List<Object> meansJson = new java.util.ArrayList<>();
        for (double[] row : fitted.means()) meansJson.add(java.util.Arrays.asList(row[0], row[1]));
        m.put("stateMeans", meansJson); // [dailyReturn, realizedVol] per state, same order as stateLabels
        java.util.List<Object> variancesJson = new java.util.ArrayList<>();
        for (double[] row : fitted.variances()) variancesJson.add(java.util.Arrays.asList(row[0], row[1]));
        m.put("stateVariances", variancesJson);
        return m;
    }

    private static Bar[] decodeBars(Object rawBarsField) {
        if (!(rawBarsField instanceof List<?> rawList)) {
            return null;
        }
        Bar[] bars = new Bar[rawList.size()];
        for (int i = 0; i < rawList.size(); i++) {
            Map<String, Object> b = Json.asObject(rawList.get(i));
            bars[i] = new Bar(
                (long) Json.asDoublePrimitive(b.get("timestampMs"), 0),
                Json.asDoublePrimitive(b.get("open"), Double.NaN),
                Json.asDoublePrimitive(b.get("high"), Double.NaN),
                Json.asDoublePrimitive(b.get("low"), Double.NaN),
                Json.asDoublePrimitive(b.get("close"), Double.NaN),
                Json.asDoublePrimitive(b.get("volume"), 0)
            );
        }
        return bars;
    }

    private static double[] closesOf(Bar[] bars) {
        double[] out = new double[bars.length];
        for (int i = 0; i < bars.length; i++) out[i] = bars[i].close();
        return out;
    }

    private static double[] highsOf(Bar[] bars) {
        double[] out = new double[bars.length];
        for (int i = 0; i < bars.length; i++) out[i] = bars[i].high();
        return out;
    }

    private static double[] lowsOf(Bar[] bars) {
        double[] out = new double[bars.length];
        for (int i = 0; i < bars.length; i++) out[i] = bars[i].low();
        return out;
    }

    private static double[] volumesOf(Bar[] bars) {
        double[] out = new double[bars.length];
        for (int i = 0; i < bars.length; i++) out[i] = bars[i].volume();
        return out;
    }

    /**
     * Single generic dispatcher for the batch of previously-endpoint-less RESEARCH engines
     * (2026-09-09) - see the server-construction comment on this route's registration. Path shape:
     * POST /api/v1/institutional/strategy/{strategyId}/{symbol}, body {"bars": [...], ...params}.
     * strategyId matches config/engineOwnership.json's quantModels keys exactly - one dispatcher,
     * not ten near-duplicate handlers, since every one of these engines already takes plain
     * double[] arrays (no institutional-specific request/response shape needed).
     */
    private void handleInstitutionalStrategy(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "method not allowed - POST a JSON body of bars"));
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String[] parts = path.replaceFirst("^/api/v1/institutional/strategy/", "").split("/");
        if (parts.length != 2 || parts[0].isBlank() || parts[1].isBlank()) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "path must be /institutional/strategy/{strategyId}/{symbol}"));
            return;
        }
        String strategyId = parts[0];
        String symbol = parts[1];
        String traceId = resolveTraceId(exchange);
        TraceContext.bind(traceId, symbol);
        try {
            Map<String, Object> body = Json.asObject(Json.parse(readBody(exchange)));
            Bar[] bars = decodeBars(body.get("bars"));
            if (bars == null || bars.length == 0) {
                sendJson(exchange, 400, Map.of("ok", false, "error", "bars array is required"));
                return;
            }
            Map<String, Object> result = evaluateResearchStrategy(strategyId, symbol, bars, body);
            if (result == null) {
                sendJson(exchange, 404, Map.of("ok", false, "error", "unknown or unwired strategyId: " + strategyId));
                return;
            }
            // evaluateResearchStrategy() always pre-populates schemaVersion/strategyId/symbol
            // (3 fields) before dispatching - a case whose engine returns null for insufficient
            // data returns the map at exactly that baseline size, never truly empty. size() <= 3
            // is the real "no engine-specific fields were added" signal.
            if (result.size() <= 3) {
                sendJson(exchange, 422, Map.of("ok", false, "error", "insufficient bar history for " + strategyId,
                    "barsProvided", (double) bars.length));
                return;
            }
            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "RESEARCH_STRATEGY_EVALUATED",
                "Evaluated " + strategyId + " for " + symbol, traceId, symbol, Map.of("strategyId", strategyId));
            sendJson(exchange, 200, result);
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
    }

    /** Returns null for an unrecognized strategyId, an empty map when the engine itself returns null (insufficient data - never fabricated). */
    private static Map<String, Object> evaluateResearchStrategy(String strategyId, String symbol, Bar[] bars, Map<String, Object> body) {
        double[] closes = closesOf(bars);
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("schemaVersion", 1.0);
        out.put("strategyId", strategyId);
        out.put("symbol", symbol);

        switch (strategyId) {
            case "rsi_mean_reversion" -> {
                int period = (int) Json.asDoublePrimitive(body.get("period"), RsiMeanReversionEngine.DEFAULT_PERIOD);
                double oversold = Json.asDoublePrimitive(body.get("oversoldThreshold"), RsiMeanReversionEngine.DEFAULT_OVERSOLD);
                double overbought = Json.asDoublePrimitive(body.get("overboughtThreshold"), RsiMeanReversionEngine.DEFAULT_OVERBOUGHT);
                var r = RsiMeanReversionEngine.evaluate(closes, period, oversold, overbought);
                if (r == null) return out;
                out.put("rsi", r.rsi());
                out.put("oversold", r.oversold());
                out.put("overbought", r.overbought());
                out.put("fadeSignal", r.fadeSignal());
            }
            case "macd_crossover" -> {
                int shortP = (int) Json.asDoublePrimitive(body.get("shortPeriod"), 12);
                int longP = (int) Json.asDoublePrimitive(body.get("longPeriod"), 26);
                int signalP = (int) Json.asDoublePrimitive(body.get("signalPeriod"), 9);
                var r = MacdCrossoverEngine.evaluate(closes, shortP, longP, signalP);
                if (r == null) return out;
                out.put("macd", r.macd());
                out.put("signal", r.signal());
                out.put("histogram", r.histogram());
                out.put("bullishCross", r.bullishCross());
                out.put("bearishCross", r.bearishCross());
            }
            case "bollinger_mean_reversion" -> {
                int period = (int) Json.asDoublePrimitive(body.get("period"), 20);
                var r = BollingerMeanReversionEngine.evaluate(closes, period);
                if (r == null) return out;
                out.put("close", r.close());
                out.put("upperBand", r.upperBand());
                out.put("lowerBand", r.lowerBand());
                out.put("atOrBeyondUpperBand", r.atOrBeyondUpperBand());
                out.put("atOrBeyondLowerBand", r.atOrBeyondLowerBand());
                out.put("fadeSignal", r.fadeSignal());
            }
            case "moving_average_crossover" -> {
                int fastP = (int) Json.asDoublePrimitive(body.get("fastPeriod"), 20);
                int slowP = (int) Json.asDoublePrimitive(body.get("slowPeriod"), 50);
                String maType = body.get("maType") instanceof String s ? s : "SMA";
                var r = MovingAverageCrossoverEngine.evaluate(closes, fastP, slowP,
                    "EMA".equals(maType) ? MovingAverageCrossoverEngine.MaType.EMA : MovingAverageCrossoverEngine.MaType.SMA);
                if (r == null) return out;
                out.put("fastValue", r.fastValue());
                out.put("slowValue", r.slowValue());
                out.put("bullishCross", r.bullishCross());
                out.put("bearishCross", r.bearishCross());
                out.put("fastAboveSlow", r.fastAboveSlow());
            }
            case "donchian_channel" -> {
                int period = (int) Json.asDoublePrimitive(body.get("period"), 20);
                var r = DonchianChannelEngine.evaluate(highsOf(bars), lowsOf(bars), closes, period);
                if (r == null) return out;
                out.put("upperChannel", r.upperChannel());
                out.put("lowerChannel", r.lowerChannel());
                out.put("currentClose", r.currentClose());
                out.put("breakoutUp", r.breakoutUp());
                out.put("breakoutDown", r.breakoutDown());
                out.put("channelWidthPct", r.channelWidthPct());
            }
            case "trend_strength_adx" -> {
                int period = (int) Json.asDoublePrimitive(body.get("period"), 14);
                var r = TrendStrengthEngine.evaluate(highsOf(bars), lowsOf(bars), closes, period);
                if (r == null) return out;
                out.put("adx", r.adx());
                out.put("plusDI", r.plusDI());
                out.put("minusDI", r.minusDI());
                out.put("strongTrend", r.strongTrend());
                out.put("trendingUp", r.trendingUp());
            }
            case "mean_reversion_zscore" -> {
                int window = (int) Json.asDoublePrimitive(body.get("window"), 20);
                double extreme = Json.asDoublePrimitive(body.get("extremeZScore"), 2.0);
                var r = MeanReversionZScoreEngine.evaluate(closes, window, extreme);
                if (r == null) return out;
                out.put("zScore", r.zScore());
                out.put("extremeOverbought", r.extremeOverbought());
                out.put("extremeOversold", r.extremeOversold());
                out.put("fadeSignal", r.fadeSignal());
            }
            case "stochastic_oscillator" -> {
                int period = (int) Json.asDoublePrimitive(body.get("period"), 14);
                int dPeriod = (int) Json.asDoublePrimitive(body.get("dPeriod"), 3);
                var r = StochasticOscillatorEngine.evaluate(highsOf(bars), lowsOf(bars), closes, period, dPeriod);
                if (r == null) return out;
                out.put("percentK", r.percentK());
                out.put("percentD", r.percentD());
                out.put("overbought", r.overbought());
                out.put("oversold", r.oversold());
                out.put("bullishCross", r.bullishCross());
                out.put("bearishCross", r.bearishCross());
            }
            case "time_series_momentum" -> {
                int shortBars = (int) Json.asDoublePrimitive(body.get("shortBars"), 20);
                int mediumBars = (int) Json.asDoublePrimitive(body.get("mediumBars"), 60);
                int longBars = (int) Json.asDoublePrimitive(body.get("longBars"), 120);
                var r = TimeSeriesMomentumEngine.evaluate(closes, shortBars, mediumBars, longBars);
                if (r == null) return out;
                out.put("shortTermReturn", r.shortTerm() != null ? r.shortTerm().totalReturn() : null);
                out.put("mediumTermReturn", r.mediumTerm() != null ? r.mediumTerm().totalReturn() : null);
                out.put("longTermReturn", r.longTerm() != null ? r.longTerm().totalReturn() : null);
                out.put("momentumAcceleration", r.momentumAcceleration());
                out.put("trendPersistence", r.trendPersistence());
                out.put("signal", r.signal() != null ? r.signal().name() : null);
            }
            case "volume_signal" -> {
                int avgWindow = (int) Json.asDoublePrimitive(body.get("avgVolumeWindow"), 20);
                // VolumeSignalEngine.evaluate() requires an EVEN divergenceWindow (it splits the
                // window in half) - 5 would silently return null forever, never a real bug the
                // caller could see from the outside. 4 is the smallest sensible even default.
                int divWindow = (int) Json.asDoublePrimitive(body.get("divergenceWindow"), 4);
                double breakoutMult = Json.asDoublePrimitive(body.get("volumeBreakoutMult"), 2.0);
                var r = VolumeSignalEngine.evaluate(closes, volumesOf(bars), avgWindow, divWindow, breakoutMult);
                if (r == null) return out;
                out.put("relativeVolume", r.relativeVolume());
                out.put("volumeBreakout", r.volumeBreakout());
                out.put("priceChangePct", r.priceChangePct());
                out.put("volumeChangePct", r.volumeChangePct());
                out.put("bullishDivergence", r.bullishDivergence());
                out.put("bearishDivergence", r.bearishDivergence());
            }
            default -> {
                return null;
            }
        }
        return out;
    }

    private static Map<String, Object> factorScoresToJson(String symbol, FactorAlphaEngine.FactorScores s) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("symbol", symbol);
        m.put("momentum", s.momentum());
        m.put("meanReversion", s.meanReversion());
        m.put("volumeLiquidity", s.volumeLiquidity());
        m.put("volatility", s.volatility());
        m.put("orderFlowProxy", s.orderFlowProxy());
        m.put("orderFlowProxyIsRealOrderFlow", false); // see FactorAlphaEngine's header - OHLC-derived, not L2/order-book
        m.put("composite", s.composite());
        return m;
    }

    private static Map<String, Object> pairResultToJson(String primarySymbol, String pairSymbol, StatArbEngine.PairResult r) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("primarySymbol", primarySymbol);
        m.put("pairSymbol", pairSymbol);
        m.put("hedgeRatio", r.hedgeRatio());
        m.put("intercept", r.intercept());
        m.put("cointegrated", r.cointegrated());
        m.put("currentZScore", r.currentZScore());
        m.put("halfLifeBars", r.halfLifeBars());

        AugmentedDickeyFuller.Result adf = r.adf();
        if (adf != null) {
            Map<String, Object> adfJson = new java.util.LinkedHashMap<>();
            adfJson.put("testStatistic", adf.testStatistic());
            adfJson.put("criticalValue1Pct", adf.criticalValue1Pct());
            adfJson.put("criticalValue5Pct", adf.criticalValue5Pct());
            adfJson.put("criticalValue10Pct", adf.criticalValue10Pct());
            adfJson.put("lags", (double) adf.lags());
            adfJson.put("observations", (double) adf.observations());
            m.put("adf", adfJson);
        } else {
            m.put("adf", null);
        }

        OrnsteinUhlenbeckEstimator.Result ou = r.ouParams();
        if (ou != null) {
            Map<String, Object> ouJson = new java.util.LinkedHashMap<>();
            ouJson.put("theta", ou.theta());
            ouJson.put("mu", ou.mu());
            ouJson.put("sigma", ou.sigma());
            m.put("ouParams", ouJson);
        } else {
            m.put("ouParams", null);
        }
        return m;
    }

    /** X-Trace-Id from the caller if present (propagated, never re-minted - the TS side already
     *  mints real traceIds via generateTraceId()); a local fallback only for direct/manual calls
     *  that don't supply one, so logs are never left correlation-less. */
    private static String resolveTraceId(HttpExchange exchange) {
        String header = exchange.getRequestHeaders().getFirst("X-Trace-Id");
        if (header != null && !header.isBlank()) {
            return header;
        }
        return "quantcore-" + System.nanoTime();
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
