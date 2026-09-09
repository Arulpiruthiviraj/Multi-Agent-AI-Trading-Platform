package io.argus.quantcore.institutional.models;

/**
 * Minimum-variance combination of two strategy return streams - Kakushadze &amp; Serur, "151 Trading
 * Strategies" (2018), Section 8.4 (momentum &amp; carry combo), citing Olszewski &amp; Zhou, "Strategy
 * Diversification: Combining Momentum and Carry Strategies Within and Across Asset Classes," J.
 * Alternative Investments 2013. Closed-form weights (verified independently via first-order
 * condition on Var(w1*R1 + (1-w1)*R2), matching Eq. 448-452): minimize the variance of a convex
 * combination R = w1*R1 + w2*R2, w1+w2=1. Not FX-specific despite the paper's own framing (the
 * formula only references the two return series' own variance/covariance) - reusable for combining
 * any two strategy return streams, e.g. momentum with carry, or any other pair.
 */
public final class MinVarianceTwoStrategyCombinerEngine {

    private MinVarianceTwoStrategyCombinerEngine() {
    }

    public record Result(
        double weight1,
        double weight2,
        double correlation,
        double stdDev1,
        double stdDev2
    ) {
    }

    /**
     * @param returns1, returns2 serial (per-period) returns of the two strategies, same length and
     *                  alignment.
     * @return null if the series are misaligned, too short (fewer than 2 points, sample stddev
     *         undefined), or either has zero variance (a degenerate combination weight, not
     *         fabricated as 50/50).
     */
    public static Result evaluate(double[] returns1, double[] returns2) {
        if (returns1 == null || returns2 == null || returns1.length != returns2.length || returns1.length < 2) {
            return null;
        }
        int n = returns1.length;
        double mean1 = mean(returns1);
        double mean2 = mean(returns2);

        double var1 = 0, var2 = 0, cov = 0;
        for (int i = 0; i < n; i++) {
            double d1 = returns1[i] - mean1;
            double d2 = returns2[i] - mean2;
            var1 += d1 * d1;
            var2 += d2 * d2;
            cov += d1 * d2;
        }
        var1 /= (n - 1);
        var2 /= (n - 1);
        cov /= (n - 1);

        double stdDev1 = Math.sqrt(var1);
        double stdDev2 = Math.sqrt(var2);
        if (stdDev1 == 0 || stdDev2 == 0) {
            return null;
        }
        double correlation = cov / (stdDev1 * stdDev2);

        double denominator = var1 + var2 - 2 * stdDev1 * stdDev2 * correlation;
        if (denominator == 0) {
            return null;
        }
        double weight1 = (var2 - stdDev1 * stdDev2 * correlation) / denominator;
        double weight2 = (var1 - stdDev1 * stdDev2 * correlation) / denominator;

        return new Result(weight1, weight2, correlation, stdDev1, stdDev2);
    }

    private static double mean(double[] values) {
        double sum = 0;
        for (double v : values) sum += v;
        return sum / values.length;
    }
}
