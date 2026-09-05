package io.argus.quantcore.institutional.models;

/**
 * Dynamic Factor Model via the principal-components ("diffusion index") approach (Stock &amp;
 * Watson, "Forecasting Using Principal Components from a Large Number of Predictors", JASA 2002):
 * extracts common factors from a real cross-sectional panel via {@link PrincipalComponentAnalysisEngine}
 * (no re-derivation of PCA), then fits a real AR(p) model ({@link AutoregressiveModel}) to the
 * leading factor's own time series - the "dynamic" half of a dynamic factor model, giving the
 * static PCA factor real forecasting dynamics.
 *
 * This is a genuine, published, standard alternative to full Kalman-filter-based DFM estimation
 * (which jointly estimates loadings and dynamics via a state-space model, a materially larger
 * undertaking) - documented here as the chosen simpler-but-real method, not a shortcut invented
 * for this codebase.
 */
public final class DynamicFactorModel {

    private DynamicFactorModel() {
    }

    public record Result(
        PrincipalComponentAnalysisEngine.Result pca,
        double[] leadingFactorSeries,
        AutoregressiveModel.Params leadingFactorDynamics
    ) {
        /** One-step-ahead forecast of the leading common factor's own level. */
        public double forecastLeadingFactorOneStep() {
            return leadingFactorDynamics.forecastOneStep(leadingFactorSeries);
        }
    }

    /**
     * @param panel        n observations (rows, chronological) x k series (columns) - e.g. returns
     *                     for a basket of related symbols.
     * @param factorArOrder AR order used to give the leading factor forecasting dynamics.
     * @return null if the underlying PCA or the leading-factor AR fit fails (insufficient data
     *         either way - see PrincipalComponentAnalysisEngine/AutoregressiveModel for exact floors).
     */
    public static Result fit(double[][] panel, int factorArOrder) {
        PrincipalComponentAnalysisEngine.Result pca = PrincipalComponentAnalysisEngine.evaluate(panel);
        if (pca == null) {
            return null;
        }
        int n = panel.length;
        double[] leadingFactor = new double[n];
        for (int t = 0; t < n; t++) {
            leadingFactor[t] = pca.projectedScores()[t][0];
        }
        AutoregressiveModel.Params dynamics = AutoregressiveModel.fit(leadingFactor, factorArOrder);
        if (dynamics == null) {
            return null;
        }
        return new Result(pca, leadingFactor, dynamics);
    }
}
