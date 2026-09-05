package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.NelderMeadOptimizer;

/**
 * GARCH(1,1) via maximum likelihood (Gaussian innovations):
 *
 * <pre>  sigma^2_t = omega + alpha*r_{t-1}^2 + beta*sigma^2_{t-1}  </pre>
 *
 * Fitting is a 3-parameter Nelder-Mead search (see NelderMeadOptimizer) over an unconstrained
 * reparameterization that structurally guarantees the model's own validity constraints
 * (omega &gt; 0; alpha, beta &gt;= 0; alpha + beta &lt; 1 for stationarity) rather than checking them
 * after the fact - so a fit either succeeds inside the valid region or the caller sees an
 * obviously-degenerate result (e.g. alpha/beta pinned at 0), never a silently-invalid one.
 */
public final class GarchEngine {

    private static final double ALPHA_MAX = 0.999;

    private GarchEngine() {
    }

    public record Params(double omega, double alpha, double beta, double logLikelihood) {
        public double unconditionalVariance() {
            double denom = 1 - alpha - beta;
            return denom > 1e-12 ? omega / denom : Double.NaN;
        }
    }

    /**
     * @param returns de-meaned (or already-near-zero-mean) return series.
     * @return null if there's not enough data to fit 3 parameters meaningfully.
     */
    public static Params fit(double[] returns) {
        int n = returns.length;
        if (n < 30) {
            return null;
        }

        double sampleVar = sampleVariance(returns);
        // omega = softplus(u0) * 0.01 * sampleVar -> softplus(u0) = 5 gives an initial omega of
        // 0.05 * sampleVar, a conventional starting point (omega is typically a small fraction of
        // the unconditional variance once alpha+beta soak up most of the persistence).
        double[] initialUnconstrained = {invSoftplus(5.0), invSigmoid(0.1 / ALPHA_MAX), invSigmoid(0.85)};

        NelderMeadOptimizer.ObjectiveFunction negLogLik = u -> {
            double[] p = toParams(u, sampleVar);
            return -logLikelihood(returns, p[0], p[1], p[2], sampleVar);
        };

        double[] fittedUnconstrained = NelderMeadOptimizer.minimize(negLogLik, initialUnconstrained, 2000, 1e-10);
        double[] p = toParams(fittedUnconstrained, sampleVar);
        double ll = logLikelihood(returns, p[0], p[1], p[2], sampleVar);
        return new Params(p[0], p[1], p[2], ll);
    }

    /** Conditional variance forecast h steps ahead, given fitted params and the last observed state. */
    public static double forecastVariance(Params params, double lastReturn, double lastVariance, int stepsAhead) {
        double sigma2 = params.omega() + params.alpha() * lastReturn * lastReturn + params.beta() * lastVariance;
        if (stepsAhead <= 1) {
            return sigma2;
        }
        double uncond = params.unconditionalVariance();
        double persistence = params.alpha() + params.beta();
        double h = sigma2;
        for (int step = 1; step < stepsAhead; step++) {
            h = uncond + persistence * (h - uncond);
        }
        return h;
    }

    /** Conditional variance path over the fitting sample itself (for callers that want the full series). */
    public static double[] conditionalVariancePath(double[] returns, Params params) {
        int n = returns.length;
        double sampleVar = sampleVariance(returns);
        double[] sigma2 = new double[n];
        sigma2[0] = sampleVar;
        for (int t = 1; t < n; t++) {
            sigma2[t] = params.omega() + params.alpha() * returns[t - 1] * returns[t - 1] + params.beta() * sigma2[t - 1];
        }
        return sigma2;
    }

    private static double logLikelihood(double[] returns, double omega, double alpha, double beta, double sampleVar) {
        int n = returns.length;
        double sigma2 = sampleVar;
        double ll = 0;
        for (int t = 0; t < n; t++) {
            if (t > 0) {
                sigma2 = omega + alpha * returns[t - 1] * returns[t - 1] + beta * sigma2;
            }
            if (sigma2 <= 0 || Double.isNaN(sigma2)) {
                return -1e18;
            }
            ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(sigma2) + (returns[t] * returns[t]) / sigma2);
        }
        return ll;
    }

    /** unconstrained (u_omega, u_alpha, u_beta) -> valid (omega, alpha, beta) with alpha+beta<1 guaranteed. */
    private static double[] toParams(double[] u, double sampleVar) {
        double omega = softplus(u[0]) * 0.01 * sampleVar + 1e-10;
        double alpha = sigmoid(u[1]) * ALPHA_MAX;
        double beta = sigmoid(u[2]) * (1 - alpha);
        return new double[]{omega, alpha, beta};
    }

    private static double softplus(double x) {
        return x > 30 ? x : Math.log1p(Math.exp(x));
    }

    private static double invSoftplus(double y) {
        return Math.log(Math.expm1(Math.max(y, 1e-12)));
    }

    private static double sigmoid(double x) {
        return 1.0 / (1.0 + Math.exp(-x));
    }

    private static double invSigmoid(double p) {
        double clamped = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
        return Math.log(clamped / (1 - clamped));
    }

    private static double sampleVariance(double[] values) {
        double mean = 0;
        for (double v : values) mean += v;
        mean /= values.length;
        double s = 0;
        for (double v : values) s += (v - mean) * (v - mean);
        return s / values.length;
    }
}
