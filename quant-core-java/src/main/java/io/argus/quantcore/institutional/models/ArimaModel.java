package io.argus.quantcore.institutional.models;

/**
 * ARIMA(p,d,q): differences the series d times (real integer differencing, Box-Jenkins
 * convention) then fits {@link ArmaModel} on the result - a thin wrapper, not a re-derivation of
 * ARMA estimation. Forecasts are produced in ARMA/differenced space then integrated back to the
 * original series' level by reversing the differencing exactly.
 *
 * Scope note (honest, not fabricated): seasonal ARIMA (SARIMA) needs seasonal differencing plus a
 * seasonal AR/MA polynomial multiplied into the non-seasonal one - deliberately NOT implemented
 * here rather than approximated with plain ARIMA on seasonally-differenced data.
 */
public final class ArimaModel {

    private ArimaModel() {
    }

    public record Params(int d, ArmaModel.Params armaParams) {
        /** @param originalSeries the real, undifferenced series this model was fit on. */
        public double forecastOneStep(double[] originalSeries) {
            double[][] levels = buildDifferenceLevels(originalSeries, d);
            double armaForecast = armaParams.forecastOneStep(levels[d], armaParams.residuals());
            double f = armaForecast;
            for (int level = d; level >= 1; level--) {
                f += levels[level - 1][levels[level - 1].length - 1];
            }
            return f;
        }
    }

    /** levels[0] = original series, levels[i] = series differenced i times. */
    private static double[][] buildDifferenceLevels(double[] series, int d) {
        double[][] levels = new double[d + 1][];
        levels[0] = series;
        for (int i = 1; i <= d; i++) {
            levels[i] = differenceOnce(levels[i - 1]);
        }
        return levels;
    }

    private static double[] differenceOnce(double[] series) {
        double[] out = new double[series.length - 1];
        for (int i = 1; i < series.length; i++) out[i - 1] = series[i] - series[i - 1];
        return out;
    }

    /**
     * @param series      chronological, undifferenced series.
     * @param p           AR order.
     * @param d           differencing order (0 = plain ARMA).
     * @param q           MA order.
     * @param longArOrder Hannan-Rissanen step-1 AR order (see ArmaModel.fit) - applied to the
     *                    ALREADY-DIFFERENCED series.
     * @return null if differencing leaves too little data, or the underlying ArmaModel.fit fails.
     */
    public static Params fit(double[] series, int p, int d, int q, int longArOrder) {
        if (d < 0 || series.length <= d + 1) {
            return null;
        }
        double[] differenced = series;
        for (int i = 0; i < d; i++) differenced = differenceOnce(differenced);

        ArmaModel.Params arma = ArmaModel.fit(differenced, p, q, longArOrder);
        if (arma == null) {
            return null;
        }
        return new Params(d, arma);
    }
}
