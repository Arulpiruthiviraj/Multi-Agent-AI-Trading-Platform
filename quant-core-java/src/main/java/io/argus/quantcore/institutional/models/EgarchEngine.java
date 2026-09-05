package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.NelderMeadOptimizer;

/**
 * EGARCH(1,1) (Nelson, "Conditional Heteroskedasticity in Asset Returns: A New Approach",
 * Econometrica 1991) - models log-variance directly, capturing the real leverage effect (gamma:
 * negative shocks raise future variance more than positive shocks of the same size) that
 * {@link GarchEngine}'s symmetric alpha*r^2 term structurally cannot. A genuinely different model
 * from GARCH, not a re-parameterization - kept separate rather than folded into GarchEngine.
 *
 * <pre>  log(sigma^2_t) = omega + beta*log(sigma^2_{t-1}) + alpha*(|z_{t-1}| - E|z|) + gamma*z_{t-1}  </pre>
 *
 * where z_{t-1} = r_{t-1} / sigma_{t-1} and E|z| = sqrt(2/pi) for standard-normal innovations.
 * Fit via the same Nelder-Mead MLE approach GarchEngine uses (see that class's header) - beta is
 * reparameterized through tanh to keep |beta| &lt; 1 (stationarity); omega/alpha/gamma are left
 * unconstrained, since the log-variance formulation makes variance automatically positive without
 * needing GARCH's non-negativity constraints on alpha/beta.
 */
public final class EgarchEngine {

    private EgarchEngine() {
    }

    private static final double E_ABS_Z_STANDARD_NORMAL = Math.sqrt(2.0 / Math.PI);

    public record Params(double omega, double alpha, double gamma, double beta, double logLikelihood) {
    }

    /**
     * @param returns de-meaned (or already-near-zero-mean) return series.
     * @return null if there's not enough data to fit 4 parameters meaningfully.
     */
    public static Params fit(double[] returns) {
        int n = returns.length;
        if (n < 30) {
            return null;
        }
        double logSampleVar = Math.log(Math.max(sampleVariance(returns), 1e-12));

        double[] initialUnconstrained = {logSampleVar * 0.1, 0.1, -0.05, atanh(0.9)};
        NelderMeadOptimizer.ObjectiveFunction negLogLik = u ->
            -logLikelihood(returns, u[0], u[1], u[2], Math.tanh(u[3]), logSampleVar);

        double[] fitted = NelderMeadOptimizer.minimize(negLogLik, initialUnconstrained, 2000, 1e-10);
        double omega = fitted[0], alpha = fitted[1], gamma = fitted[2], beta = Math.tanh(fitted[3]);
        double ll = logLikelihood(returns, omega, alpha, gamma, beta, logSampleVar);
        return new Params(omega, alpha, gamma, beta, ll);
    }

    /** Conditional log-variance path over the fitting sample (exp() it for the variance itself). */
    public static double[] logVariancePath(double[] returns, Params params) {
        int n = returns.length;
        double logSampleVar = Math.log(Math.max(sampleVariance(returns), 1e-12));
        double[] logSigma2 = new double[n];
        logSigma2[0] = logSampleVar;
        for (int t = 1; t < n; t++) {
            double sigmaPrev = Math.sqrt(Math.exp(logSigma2[t - 1]));
            double zPrev = returns[t - 1] / sigmaPrev;
            logSigma2[t] = params.omega() + params.beta() * logSigma2[t - 1]
                + params.alpha() * (Math.abs(zPrev) - E_ABS_Z_STANDARD_NORMAL) + params.gamma() * zPrev;
        }
        return logSigma2;
    }

    private static double logLikelihood(double[] returns, double omega, double alpha, double gamma, double beta, double logSampleVar) {
        int n = returns.length;
        double logSigma2 = logSampleVar;
        double ll = 0;
        for (int t = 0; t < n; t++) {
            if (t > 0) {
                double sigmaPrev = Math.sqrt(Math.exp(logSigma2));
                double zPrev = returns[t - 1] / sigmaPrev;
                logSigma2 = omega + beta * logSigma2 + alpha * (Math.abs(zPrev) - E_ABS_Z_STANDARD_NORMAL) + gamma * zPrev;
            }
            double sigma2 = Math.exp(logSigma2);
            if (sigma2 <= 0 || Double.isNaN(sigma2) || Double.isInfinite(sigma2)) {
                return -1e18;
            }
            ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(sigma2) + (returns[t] * returns[t]) / sigma2);
        }
        return ll;
    }

    private static double atanh(double x) {
        return 0.5 * Math.log((1 + x) / (1 - x));
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
