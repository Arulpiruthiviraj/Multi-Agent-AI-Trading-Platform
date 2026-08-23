package io.argus.quantcore.indicators;

/**
 * Price generators mirroring scripts/_java_parity_fixtures.ts exactly (same formula, same
 * per-step rounding) so Java and TypeScript compute indicators over byte-identical input arrays.
 * Ground-truth expected values were captured by running the real RSIEngine/MACDEngine/
 * technicalSignal/TechnicalIndicators TypeScript modules against these exact fixtures.
 */
final class TestFixtures {

    private TestFixtures() {
    }

    static double[] risingTrend(int n, double start) {
        double[] out = new double[n];
        double p = start;
        for (int i = 0; i < n; i++) {
            p += (i % 3 == 2) ? -1.15 : 1.0;
            out[i] = round4(p);
        }
        return out;
    }

    static double[] oscillating(int n, double start) {
        double[] out = new double[n];
        double p = start;
        for (int i = 0; i < n; i++) {
            p += Math.sin(i / 3.0) * 2;
            out[i] = round4(p);
        }
        return out;
    }

    static double[] highs(double[] prices) {
        double[] out = new double[prices.length];
        for (int i = 0; i < prices.length; i++) {
            out[i] = prices[i] * 1.01;
        }
        return out;
    }

    static double[] lows(double[] prices) {
        double[] out = new double[prices.length];
        for (int i = 0; i < prices.length; i++) {
            out[i] = prices[i] * 0.99;
        }
        return out;
    }

    private static double round4(double v) {
        return Math.round(v * 10000.0) / 10000.0;
    }
}
