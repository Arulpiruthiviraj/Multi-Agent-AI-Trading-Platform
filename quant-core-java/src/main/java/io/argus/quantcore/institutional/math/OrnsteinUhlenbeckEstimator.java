package io.argus.quantcore.institutional.math;

/**
 * Ornstein-Uhlenbeck parameter estimation via AR(1) regression on the exact discretization of
 * {@code dY = theta*(mu - Y)*dt + sigma*dW}:
 *
 * <pre>  Y_t = Y_{t-1}*b + a + ε_t,   b = exp(-theta*dt),   a = mu*(1-b)  </pre>
 *
 * so {@code theta = -ln(b)/dt}, {@code mu = a/(1-b)}, and sigma is recovered from the regression
 * residual variance via the exact-discretization variance identity
 * {@code Var(ε) = sigma^2 * (1 - b^2) / (2*theta)}. Used for StatArb spread half-life (a spread
 * is modeled as an OU process around its equilibrium mean).
 */
public final class OrnsteinUhlenbeckEstimator {

    private OrnsteinUhlenbeckEstimator() {
    }

    public record Result(double theta, double mu, double sigma, double halfLife) {
    }

    /**
     * @param series observed process values (e.g. a cointegration spread), evenly spaced.
     * @param dt     time step between observations (1.0 = one bar).
     * @return null when there isn't enough data to regress, or the fitted AR(1) coefficient
     *         implies theta &lt;= 0 (no mean reversion - the series doesn't behave like an OU
     *         process over this window, so a half-life would be meaningless/infinite).
     */
    public static Result estimate(double[] series, double dt) {
        int n = series.length;
        if (n < 10) {
            return null;
        }
        double[] y = new double[n - 1];
        double[][] predictors = new double[n - 1][1];
        for (int i = 1; i < n; i++) {
            y[i - 1] = series[i];
            predictors[i - 1][0] = series[i - 1];
        }
        OlsRegression.Result reg = OlsRegression.fit(predictors, y, true);
        if (reg == null) {
            return null;
        }
        double a = reg.coefficients()[0];
        double b = reg.coefficients()[1];
        if (b <= 0 || b >= 1) {
            // b<=0 is oscillatory/degenerate for a spread; b>=1 is a unit root (no reversion).
            return null;
        }
        double theta = -Math.log(b) / dt;
        double mu = a / (1 - b);

        double residualVar = 0;
        for (double r : reg.residuals()) {
            residualVar += r * r;
        }
        residualVar /= Math.max(1, reg.residuals().length - 2);

        double denom = 1 - b * b;
        double sigma2 = denom > 1e-15 ? residualVar * 2 * theta / denom : Double.NaN;
        double sigma = sigma2 > 0 ? Math.sqrt(sigma2) : Double.NaN;

        double halfLife = Math.log(2) / theta;
        return new Result(theta, mu, sigma, halfLife);
    }
}
