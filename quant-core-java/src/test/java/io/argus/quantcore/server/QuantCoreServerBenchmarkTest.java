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
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real, measured performance baseline (no JMH dependency added - see
 * docs/audits/ARGUS_JAVA_PYTHON_NODE_PERFORMANCE_BOUNDARY_AUDIT.md's Phase 0/§21 for why a
 * lightweight, dependency-free measurement was chosen over adding a new Maven dependency for
 * this). Prints real p50/p95/max microsecond numbers to stdout for a human to read - the
 * assertions below are deliberately loose sanity bounds (catch a true hang/regression), NOT
 * invented performance targets. This directly answers the "does Java's HTTP+JSON round-trip cost
 * eliminate its computational advantage for a small calculation like RSI" question: it measures
 * in-process SymbolState computation versus the full HTTP round-trip for the same calculation.
 */
class QuantCoreServerBenchmarkTest {

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

    private static long[] percentiles(long[] sortedUs) {
        return new long[]{
            sortedUs[(int) (sortedUs.length * 0.50)],
            sortedUs[(int) (sortedUs.length * 0.95)],
            sortedUs[sortedUs.length - 1],
        };
    }

    @Test
    void inProcessRsiMacdBollingerComputationTiming() {
        // Pure calculation cost, no HTTP/JSON - isolates the actual CPU work from the process
        // boundary, using the same real RSI/MACD/Bollinger classes SymbolState.snapshot() uses.
        var rsi = new io.argus.quantcore.indicators.RSI(14);
        var macd = new io.argus.quantcore.indicators.MACD(12, 26, 9);
        Random rnd = new Random(77);
        double[] prices = new double[200];
        double p = 100;
        for (int i = 0; i < prices.length; i++) {
            p += rnd.nextGaussian() * 0.3;
            prices[i] = p;
        }

        int reps = 10_000;
        long[] durationsUs = new long[reps];
        for (int i = 0; i < reps; i++) {
            long t0 = System.nanoTime();
            rsi.calculate(prices);
            macd.calculate(prices);
            io.argus.quantcore.indicators.Bollinger.calculate(prices, 20);
            durationsUs[i] = (System.nanoTime() - t0) / 1000;
        }
        Arrays.sort(durationsUs);
        long[] pct = percentiles(durationsUs);
        System.out.println("[BENCHMARK] in-process RSI+MACD+Bollinger (" + reps + " reps): p50="
            + pct[0] + "us p95=" + pct[1] + "us max=" + pct[2] + "us");

        // Loose sanity bound only - not a performance target. A real regression (e.g. an
        // accidental O(n^2) loop) would blow well past this; normal indicator math should not.
        assertThat(pct[1]).isLessThan(50_000); // p95 < 50ms is a hang/regression signal, not a target
    }

    @Test
    void httpRoundTripIndicatorsTimingVersusInProcess() throws Exception {
        // Warm up one symbol with enough ticks for a real (non-insufficientHistory) snapshot.
        double price = 100;
        Random rnd = new Random(88);
        for (int i = 0; i < 60; i++) {
            price += rnd.nextGaussian() * 0.3;
            var res = post("/api/v1/ticks", Map.of("symbol", "BENCH", "timestampMs", (double) i, "price", price, "volume", 1000.0));
            assertThat(res.statusCode()).isEqualTo(200);
        }

        int reps = 200; // HTTP round trips are far more expensive per-call than in-process math - fewer reps is still a real sample
        long[] durationsUs = new long[reps];
        for (int i = 0; i < reps; i++) {
            long t0 = System.nanoTime();
            var res = get("/api/v1/indicators/BENCH");
            durationsUs[i] = (System.nanoTime() - t0) / 1000;
            assertThat(res.statusCode()).isEqualTo(200);
        }
        Arrays.sort(durationsUs);
        long[] pct = percentiles(durationsUs);
        System.out.println("[BENCHMARK] full HTTP round-trip GET /api/v1/indicators (" + reps + " reps): p50="
            + pct[0] + "us p95=" + pct[1] + "us max=" + pct[2] + "us "
            + "- compare against inProcessRsiMacdBollingerComputationTiming's numbers above to see "
            + "how much of the total cost is HTTP/JSON versus real calculation.");

        assertThat(pct[1]).isLessThan(200_000); // p95 < 200ms sanity bound for a loopback HTTP call, not a target
    }

    @Test
    void institutionalFactorsHttpRoundTripTiming() throws Exception {
        // Same "flat then breakout" construction as
        // QuantCoreServerTest.institutionalFactorsComputesACompositeForARecentBreakoutAfterAFlatPeriod
        // (a plain symmetric random walk can occasionally produce a near-zero-variance window for
        // one of the five Z-scored factors, which FactorAlphaEngine.compute() correctly refuses
        // rather than dividing by ~0 - this shape avoids that degenerate case deterministically).
        Random rnd = new Random(99);
        double price = 100;
        List<Object> bars = new ArrayList<>();
        for (int i = 0; i < 300; i++) {
            double dailyReturn = i < 220 ? rnd.nextGaussian() * 0.001 : 0.01 + rnd.nextGaussian() * 0.001;
            double open = price;
            double close = price * (1 + dailyReturn);
            double high = Math.max(open, close) * (1.0005 + Math.abs(rnd.nextGaussian()) * 0.0003);
            double low = Math.min(open, close) * (1 - 0.0005 - Math.abs(rnd.nextGaussian()) * 0.0003);
            bars.add(Map.of("timestampMs", (double) i, "open", open, "high", high, "low", low,
                "close", close, "volume", 1_000_000.0 + Math.max(0, i - 220) * 5000));
            price = close;
        }
        Map<String, Object> body = Map.of("bars", bars);

        int reps = 100; // heavier computation (5-factor composite over 300 bars) - fewer reps
        long[] durationsUs = new long[reps];
        for (int i = 0; i < reps; i++) {
            long t0 = System.nanoTime();
            var res = post("/api/v1/institutional/factors/BENCH", body);
            durationsUs[i] = (System.nanoTime() - t0) / 1000;
            assertThat(res.statusCode()).as("response body: " + res.body()).isEqualTo(200);
        }
        Arrays.sort(durationsUs);
        long[] pct = percentiles(durationsUs);
        System.out.println("[BENCHMARK] full HTTP round-trip POST /api/v1/institutional/factors (" + reps + " reps, 200 bars): p50="
            + pct[0] + "us p95=" + pct[1] + "us max=" + pct[2] + "us");

        assertThat(pct[1]).isLessThan(200_000);
    }
}
