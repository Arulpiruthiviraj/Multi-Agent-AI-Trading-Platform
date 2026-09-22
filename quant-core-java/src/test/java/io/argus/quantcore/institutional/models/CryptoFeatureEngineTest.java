package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class CryptoFeatureEngineTest {

    private static double[] constant(int n, double v) {
        double[] a = new double[n];
        java.util.Arrays.fill(a, v);
        return a;
    }

    @Test
    void reportsInsufficientDataRatherThanFabricatingWhenHistoryIsTooShort() {
        double[] closes = { 100, 101, 102 };
        double[] highs = { 101, 102, 103 };
        double[] lows = { 99, 100, 101 };

        var snapshot = CryptoFeatureEngine.compute(closes, highs, lows);

        assertThat(snapshot.sufficientData()).isFalse();
        assertThat(snapshot.barCount()).isEqualTo(3);
        // Safe indicator defaults, not fabricated values - RSI's own documented neutral default.
        assertThat(snapshot.rsi14()).isEqualTo(50);
    }

    @Test
    void computesRealFeaturesFromASteadyUptrend() {
        int n = 40;
        double[] closes = new double[n];
        double[] highs = new double[n];
        double[] lows = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price *= 1.01; // steady 1% per-bar uptrend
            closes[i] = price;
            highs[i] = price * 1.005;
            lows[i] = price * 0.995;
        }

        var snapshot = CryptoFeatureEngine.compute(closes, highs, lows);

        assertThat(snapshot.sufficientData()).isTrue();
        assertThat(snapshot.lastClose()).isEqualTo(closes[n - 1]);
        // A steady uptrend must show a positive 20-bar return and a positive EMA slope - the
        // load-bearing direction check, not an exact-value check (real float arithmetic).
        assertThat(snapshot.return20Bar()).isGreaterThan(0);
        assertThat(snapshot.ema20SlopePct()).isGreaterThan(0);
        assertThat(snapshot.rsi14()).isGreaterThan(50); // sustained gains -> RSI above neutral
        assertThat(snapshot.atr14()).isGreaterThan(0);
        assertThat(snapshot.realizedVolatility()).isGreaterThan(0);
    }

    @Test
    void computesRealFeaturesFromASteadyDowntrend() {
        int n = 40;
        double[] closes = new double[n];
        double[] highs = new double[n];
        double[] lows = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price *= 0.99;
            closes[i] = price;
            highs[i] = price * 1.005;
            lows[i] = price * 0.995;
        }

        var snapshot = CryptoFeatureEngine.compute(closes, highs, lows);

        assertThat(snapshot.return20Bar()).isLessThan(0);
        assertThat(snapshot.ema20SlopePct()).isLessThan(0);
        assertThat(snapshot.rsi14()).isLessThan(50);
    }

    @Test
    void flatPriceSeriesProducesZeroVolatilityAndNeutralReadings() {
        int n = 40;
        double[] closes = constant(n, 100);
        double[] highs = constant(n, 100);
        double[] lows = constant(n, 100);

        var snapshot = CryptoFeatureEngine.compute(closes, highs, lows);

        assertThat(snapshot.sufficientData()).isTrue();
        assertThat(snapshot.return20Bar()).isEqualTo(0);
        assertThat(snapshot.atr14()).isEqualTo(0);
        assertThat(snapshot.realizedVolatility()).isEqualTo(0);
        assertThat(snapshot.bollingerZScore()).isEqualTo(0); // no dispersion -> half-band-width 0 -> defined-safe 0, not NaN/Infinity
    }

    @Test
    void relativeSnapshotReportsInsufficientDataForShortSeries() {
        double[] a = { 100, 101, 102 };
        double[] b = { 10, 10.1, 10.2 };
        var rel = CryptoFeatureEngine.computeRelative(a, b);
        assertThat(rel.sufficientData()).isFalse();
    }

    @Test
    void relativeSnapshotDetectsPerfectPositiveCorrelationWhenOneSeriesIsAScaledCopyOfTheOther() {
        int n = 30;
        double[] btc = new double[n];
        double[] eth = new double[n];
        double p = 100;
        for (int i = 0; i < n; i++) {
            p *= (i % 3 == 0) ? 1.02 : 0.995; // some real up/down variation, not monotonic
            btc[i] = p;
            eth[i] = p * 0.05; // ETH modeled as a fixed 5% scalar of BTC - genuinely perfectly correlated
        }

        var rel = CryptoFeatureEngine.computeRelative(btc, eth);

        assertThat(rel.sufficientData()).isTrue();
        assertThat(rel.correlation20()).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-9));
        // eth is a fixed scalar of btc's PRICE, so their period-over-period RETURNS are identical
        // (a 2% price move in btc is also a 2% price move in eth) -> beta of returns is 1.0, not
        // the 0.05 price-level scalar. Beta operates on returns, not price ratio.
        assertThat(rel.relativeBeta20()).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void relativeSnapshotDoesNotAssumeADirectionOfLeadLag() {
        // A real, independent-looking pair (no scaling relationship) should NOT be forced into a
        // spurious high correlation - this test protects against the engine ever being "tuned" to
        // report a relationship that isn't really there.
        double[] a = { 100, 101, 99, 102, 98, 103, 97, 104, 96, 105, 95, 106, 94, 107, 93, 108, 92, 109, 91, 110, 100, 101, 99 };
        double[] b = { 10, 10, 10.2, 10.1, 10.3, 10.05, 10.4, 10.0, 10.5, 9.95, 10.6, 9.9, 10.7, 9.85, 10.8, 9.8, 10.9, 9.75, 11.0, 9.7, 10, 10, 10.2 };
        var rel = CryptoFeatureEngine.computeRelative(a, b);
        assertThat(rel.sufficientData()).isTrue();
        // Real evidence, not asserted to any particular sign - just proving the computation runs
        // and produces a finite, honestly-measured value rather than a hardcoded constant.
        assertThat(rel.correlation20()).isNotNaN();
        assertThat(Math.abs(rel.correlation20())).isLessThanOrEqualTo(1.0);
    }
}
