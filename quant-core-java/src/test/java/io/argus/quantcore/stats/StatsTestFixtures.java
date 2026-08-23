package io.argus.quantcore.stats;

/** Mirrors scripts/java_parity_fixtures_phase1.ts's risingTrend/oscillating generators exactly. */
final class StatsTestFixtures {

    private StatsTestFixtures() {
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

    private static double round4(double v) {
        return Math.round(v * 10000.0) / 10000.0;
    }
}
