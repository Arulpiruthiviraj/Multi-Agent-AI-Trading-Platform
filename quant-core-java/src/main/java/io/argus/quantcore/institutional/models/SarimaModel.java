package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.OlsRegression;

/**
 * SARIMA(p,d,q)(P,D,Q)_m - seasonal ARIMA. Extends {@link ArimaModel}/{@link ArmaModel}'s real
 * Hannan-Rissanen two-step estimation (Hannan &amp; Rissanen, 1982) with seasonal AR/MA terms at
 * multiples of the seasonal period m, applied after regular differencing (d times) and seasonal
 * differencing (D times, at lag m) - the standard Box-Jenkins seasonal decomposition, not an
 * approximation. This was the documented gap left open when ArimaModel was first built ("SARIMA
 * deliberately NOT implemented" in that class's own header) - now filled with the real thing
 * rather than plain ARIMA on seasonally-differenced data (which would silently drop the seasonal
 * AR/MA structure this class actually estimates).
 */
public final class SarimaModel {

    private SarimaModel() {
    }

    public record Params(
        int d, int seasonalD, int seasonalPeriod,
        double intercept,
        double[] arCoefficients, double[] seasonalArCoefficients,
        double[] maCoefficients, double[] seasonalMaCoefficients,
        double[] residuals, double rSquared
    ) {
        /** @param originalSeries the real, undifferenced series this model was fit on. */
        public double forecastOneStep(double[] originalSeries) {
            double[][] chain = buildLevelChain(originalSeries, d, seasonalD, seasonalPeriod);
            double[] stationary = chain[chain.length - 1];

            int p = arCoefficients.length, pSeasonal = seasonalArCoefficients.length;
            int q = maCoefficients.length, qSeasonal = seasonalMaCoefficients.length;

            double forecast = intercept;
            for (int lag = 1; lag <= p; lag++) {
                forecast += arCoefficients[lag - 1] * stationary[stationary.length - lag];
            }
            for (int s = 1; s <= pSeasonal; s++) {
                forecast += seasonalArCoefficients[s - 1] * stationary[stationary.length - s * seasonalPeriod];
            }
            for (int lag = 1; lag <= q; lag++) {
                forecast += maCoefficients[lag - 1] * residuals[residuals.length - lag];
            }
            for (int s = 1; s <= qSeasonal; s++) {
                forecast += seasonalMaCoefficients[s - 1] * residuals[residuals.length - s * seasonalPeriod];
            }

            // Integrate back up the chain: undo seasonal differencing D times, then regular d times.
            double f = forecast;
            for (int level = chain.length - 1; level > d; level--) {
                double[] prevLevel = chain[level - 1];
                f += prevLevel[prevLevel.length - seasonalPeriod];
            }
            for (int level = d; level >= 1; level--) {
                double[] prevLevel = chain[level - 1];
                f += prevLevel[prevLevel.length - 1];
            }
            return f;
        }
    }

    private static double[] differenceOnce(double[] series) {
        double[] out = new double[series.length - 1];
        for (int i = 1; i < series.length; i++) out[i - 1] = series[i] - series[i - 1];
        return out;
    }

    private static double[] seasonalDifferenceOnce(double[] series, int m) {
        double[] out = new double[series.length - m];
        for (int i = m; i < series.length; i++) out[i - m] = series[i] - series[i - m];
        return out;
    }

    /** chain[0] = original series, chain[1..d] = regular diffs, chain[d+1..d+D] = seasonal diffs on top. */
    private static double[][] buildLevelChain(double[] series, int d, int seasonalD, int m) {
        double[][] chain = new double[d + seasonalD + 1][];
        chain[0] = series;
        for (int i = 1; i <= d; i++) chain[i] = differenceOnce(chain[i - 1]);
        for (int i = 1; i <= seasonalD; i++) chain[d + i] = seasonalDifferenceOnce(chain[d + i - 1], m);
        return chain;
    }

    /**
     * @param series          chronological, undifferenced series.
     * @param p, d, q         non-seasonal ARIMA orders.
     * @param seasonalP, seasonalD, seasonalQ  seasonal orders.
     * @param seasonalPeriod  m (e.g. 12 for monthly-seasonal, 5 for a trading week).
     * @param longArOrder     Hannan-Rissanen step-1 AR order, applied to the fully-differenced
     *                        series - must be large enough to reach the seasonal MA lags
     *                        (&gt;= seasonalQ*seasonalPeriod) as well as p+q+1.
     * @return null if differencing/lag requirements leave too little data, or either regression step fails.
     */
    public static Params fit(double[] series, int p, int d, int q, int seasonalP, int seasonalD, int seasonalQ, int seasonalPeriod, int longArOrder) {
        if (d < 0 || seasonalD < 0 || seasonalPeriod < 1 || longArOrder < p + q + 1) {
            return null;
        }
        if (series.length <= d + seasonalD * seasonalPeriod + 1) {
            return null;
        }
        double[][] chain = buildLevelChain(series, d, seasonalD, seasonalPeriod);
        double[] stationary = chain[chain.length - 1];

        AutoregressiveModel.Params longAr = AutoregressiveModel.fit(stationary, longArOrder);
        if (longAr == null) {
            return null;
        }
        double[] eHat = longAr.residuals(); // eHat[i] is the residual for stationary[longArOrder + i]

        int n = stationary.length;
        int maxSeasonalArLag = seasonalP * seasonalPeriod;
        int maxSeasonalMaLag = seasonalQ * seasonalPeriod;
        int regStart = Math.max(Math.max(p, maxSeasonalArLag), longArOrder + Math.max(q, maxSeasonalMaLag));
        int numRegressors = p + seasonalP + q + seasonalQ;
        int rows = n - regStart;
        if (numRegressors == 0 || rows <= numRegressors + 1) {
            return null;
        }

        double[][] predictors = new double[rows][numRegressors];
        double[] y = new double[rows];
        for (int t = regStart; t < n; t++) {
            y[t - regStart] = stationary[t];
            int col = 0;
            for (int lag = 1; lag <= p; lag++) predictors[t - regStart][col++] = stationary[t - lag];
            for (int s = 1; s <= seasonalP; s++) predictors[t - regStart][col++] = stationary[t - s * seasonalPeriod];
            for (int lag = 1; lag <= q; lag++) predictors[t - regStart][col++] = eHat[(t - lag) - longArOrder];
            for (int s = 1; s <= seasonalQ; s++) predictors[t - regStart][col++] = eHat[(t - s * seasonalPeriod) - longArOrder];
        }

        OlsRegression.Result reg = OlsRegression.fit(predictors, y, true);
        if (reg == null) {
            return null;
        }
        double intercept = reg.coefficients()[0];
        double[] arCoefficients = new double[p];
        double[] seasonalArCoefficients = new double[seasonalP];
        double[] maCoefficients = new double[q];
        double[] seasonalMaCoefficients = new double[seasonalQ];
        int c = 1;
        System.arraycopy(reg.coefficients(), c, arCoefficients, 0, p); c += p;
        System.arraycopy(reg.coefficients(), c, seasonalArCoefficients, 0, seasonalP); c += seasonalP;
        System.arraycopy(reg.coefficients(), c, maCoefficients, 0, q); c += q;
        System.arraycopy(reg.coefficients(), c, seasonalMaCoefficients, 0, seasonalQ);

        return new Params(d, seasonalD, seasonalPeriod, intercept, arCoefficients, seasonalArCoefficients,
            maCoefficients, seasonalMaCoefficients, reg.residuals(), reg.rSquared());
    }
}
