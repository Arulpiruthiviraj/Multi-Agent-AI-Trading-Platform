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
        server.createContext("/api/v1/institutional/factors/", this::handleInstitutionalFactors);
        server.createContext("/api/v1/institutional/pairs", this::handleInstitutionalPairs);
        server.createContext("/api/v1/institutional/volatility/", this::handleInstitutionalVolatility);
        server.createContext("/api/v1/institutional/regime/", this::handleInstitutionalRegime);
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
            // DEBUG, not INFO - high-frequency tick ingestion would otherwise flood the log file
            // during 100+ symbol live streaming (this is the exact bug class TechnicalAgent's own
            // debounce fix guarded against on the TS side - see technicalSignalCooldownMs).
            StructuredLogger.log(StructuredLogger.Level.DEBUG, "QuantCoreJava", "TICK_INGESTED",
                "Tick ingested for " + symbol, null, symbol, Map.of("price", price));
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

            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "INSTITUTIONAL_VOLATILITY_COMPUTED",
                "Fit GARCH(1,1) for " + symbol, traceId, symbol,
                Map.of("alpha", params.alpha(), "beta", params.beta()));
            sendJson(exchange, 200, garchResultToJson(symbol, params, lastVariance, forecastVariance, stepsAhead, returns.length));
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

            StructuredLogger.log(StructuredLogger.Level.INFO, "QuantCoreJava", "INSTITUTIONAL_REGIME_COMPUTED",
                "Fit 4-state HMM regime for " + symbol, traceId, symbol,
                Map.of("currentRegime", currentRegime.name()));
            sendJson(exchange, 200, hmmFittedToJson(symbol, fitted, currentRegime, observations.length));
        } catch (Json.JsonParseException | ClassCastException | NullPointerException e) {
            sendJson(exchange, 400, Map.of("ok", false, "error", "malformed request body: " + e.getMessage()));
        } finally {
            TraceContext.clear();
        }
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

    private static Map<String, Object> garchResultToJson(String symbol, GarchEngine.Params p, double lastConditionalVariance, double forecastVariance, int stepsAhead, int returnsUsed) {
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
        return m;
    }

    private static Map<String, Object> hmmFittedToJson(String symbol, HmmRegimeEngine.Fitted fitted, HmmRegimeEngine.Regime currentRegime, int observationCount) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("schemaVersion", 1.0);
        m.put("symbol", symbol);
        m.put("currentRegime", currentRegime.name());
        m.put("logLikelihood", fitted.logLikelihood());
        m.put("observationCount", (double) observationCount);
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
