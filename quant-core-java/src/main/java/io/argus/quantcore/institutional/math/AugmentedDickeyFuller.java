package io.argus.quantcore.institutional.math;

/**
 * Augmented Dickey-Fuller unit-root test, constant-no-trend specification (the standard form for
 * testing mean-reversion of a spread / cointegration residual - a deterministic trend term isn't
 * meaningful for a spread that's supposed to hover around a fixed mean):
 *
 * <pre>  Δy_t = α + β·y_{t-1} + Σ γ_i·Δy_{t-i} + ε_t  </pre>
 *
 * H0: β = 0 (unit root / non-stationary). H1: β &lt; 0 (stationary / mean-reverting). Rejecting H0
 * is evidence of stationarity - exactly what a cointegration residual or a StatArb spread needs.
 *
 * Critical values are MacKinnon's asymptotic (large-sample) approximations for the
 * constant-no-trend case, not the finite-sample response-surface adjustment - disclosed here
 * rather than silently treated as exact, matching this codebase's disclosed-simplification
 * convention (see CampaignPolicySimulator's TRAIL_STOPS_ONLY note for the same pattern).
 */
public final class AugmentedDickeyFuller {

    private static final double CRITICAL_1PCT = -3.43;
    private static final double CRITICAL_5PCT = -2.86;
    private static final double CRITICAL_10PCT = -2.57;

    private AugmentedDickeyFuller() {
    }

    public record Result(
        double testStatistic,
        double criticalValue1Pct,
        double criticalValue5Pct,
        double criticalValue10Pct,
        boolean isStationaryAt5Pct,
        int lags,
        int observations
    ) {
    }

    /** Schwert's (1989) rule of thumb: floor(12 * (n/100)^0.25). Used when caller has no better prior. */
    public static int suggestLags(int n) {
        return (int) Math.floor(12.0 * Math.pow(n / 100.0, 0.25));
    }

    /**
     * @param series levels (not yet differenced) - e.g. a price series or a cointegration spread.
     * @param lags   number of lagged Δy terms to include (0 is the plain Dickey-Fuller test).
     * @return null if there aren't enough observations for the requested lag order.
     */
    public static Result test(double[] series, int lags) {
        int n = series.length;
        if (lags < 0 || n - lags - 1 < lags + 2) {
            return null;
        }

        double[] diffs = new double[n - 1];
        for (int i = 1; i < n; i++) {
            diffs[i - 1] = series[i] - series[i - 1];
        }

        int usable = diffs.length - lags;
        if (usable < lags + 2) {
            return null;
        }

        double[] y = new double[usable];
        double[][] predictors = new double[usable][1 + lags];
        for (int i = 0; i < usable; i++) {
            int diffIdx = lags + i;
            y[i] = diffs[diffIdx];
            int levelIdx = diffIdx;
            predictors[i][0] = series[levelIdx];
            for (int lag = 1; lag <= lags; lag++) {
                predictors[i][lag] = diffs[diffIdx - lag];
            }
        }

        OlsRegression.Result reg = OlsRegression.fit(predictors, y, true);
        if (reg == null) {
            return null;
        }

        double betaLevel = reg.coefficients()[1];
        double seLevel = reg.standardErrors()[1];
        if (seLevel < 1e-15 || Double.isNaN(seLevel)) {
            return null;
        }
        double testStat = betaLevel / seLevel;

        return new Result(
            testStat,
            CRITICAL_1PCT,
            CRITICAL_5PCT,
            CRITICAL_10PCT,
            testStat < CRITICAL_5PCT,
            lags,
            usable
        );
    }
}
