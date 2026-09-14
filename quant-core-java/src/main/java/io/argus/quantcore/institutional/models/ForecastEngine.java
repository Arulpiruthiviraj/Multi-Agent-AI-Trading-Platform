package io.argus.quantcore.institutional.models;

import java.util.Arrays;

/**
 * ARGUS MASTER TRANSFORMATION MANDATE Part 7 - the Quant Forecast Engine's authoritative
 * statistical computation. Pure, deterministic descriptive statistics over a real sample of
 * already-graded historical forward returns that TS assembles and provides - this class invents no
 * market data and fetches nothing itself; src/server/research/forecastEngine.ts (Node side) owns
 * real historical-outcome retrieval (prediction_outcomes / prediction_outcome_horizons, grouped by
 * strategy/direction/horizon - see that file's own header for why the grouping key is
 * secondaryGroupKey() today, not yet the agent_predictions.strategy_id column, which this same
 * mandate pass found is written by nothing - a real, separately-tracked bug, not a stylistic
 * choice) and this class owns turning that real sample into a statistically-defensible forecast,
 * per rule 7 (single authoritative calculation path per calculation) and rule 16 of CLAUDE.md's
 * Java 26 Engine Authority (a decision-authoritative forecast computation belongs in
 * quant-core-java, not TypeScript - distinct from the existing, unrelated TS-side
 * wilsonInterval()/effectiveSampleSize.ts, which remains a diagnostic/observability tool for agent
 * calibration reporting, never the authoritative Forecast object this class produces).
 *
 * "Profit" for probabilityOfProfit is defined as forward return > transactionCostBps (net of an
 * estimated round-trip cost), never simply return > 0 - matching the mandate's own explicit
 * definition (Part 7 item 5), since a return of +0.01% is not real profit once realistic costs are
 * subtracted.
 *
 * Every numeric field is null (not zero, not a fabricated default) when the real sample is too
 * small to support it - see {@link ForecastStatus#INSUFFICIENT_DATA}.
 */
public final class ForecastEngine {

    public enum ForecastStatus { VALID, INSUFFICIENT_DATA }

    /**
     * Minimum raw sample size before a forecast is considered statistically meaningful. Chosen in
     * the same order of magnitude as this codebase's other minimum-evidence floors (GarchEngine.fit()'s
     * own 30-point floor for a materially harder estimation problem) but deliberately more
     * conservative for a raw mean/median/trimmed-mean estimate, which - unlike a fitted GARCH model -
     * has no structural noise-averaging of its own to lean on below this size.
     */
    public static final int MIN_SAMPLE_SIZE = 20;

    private static final double TRIM_FRACTION = 0.10; // symmetric 10% trim each tail
    private static final double Z_95 = 1.959963985;

    public record ForecastResult(
        ForecastStatus status,
        int sampleSize,
        Double meanReturn,
        Double medianReturn,
        Double trimmedMeanReturn,
        Double stdevReturn,
        Double meanReturnLower,
        Double meanReturnUpper,
        Double probabilityOfProfit,
        Double probabilityOfProfitLower,
        Double probabilityOfProfitUpper,
        double transactionCostBps,
        Double netExpectedReturn
    ) {
    }

    private ForecastEngine() {
    }

    /**
     * @param forwardReturns real, already-graded historical forward returns (fractional, e.g.
     *                       0.004 = +0.4%), sign already oriented by the caller so a positive value
     *                       means favorable for this forecast's own direction - this method does
     *                       not know or assume BUY vs SELL.
     * @param transactionCostBps a real or conservatively-estimated round-trip cost in basis points,
     *                           used only to define "profit" net of cost. 0 is a valid, honest
     *                           input when no better cost estimate exists yet - never invented
     *                           beyond what the caller actually supplies.
     */
    public static ForecastResult compute(double[] forwardReturns, double transactionCostBps) {
        double[] returns = forwardReturns == null ? new double[0] : forwardReturns;
        int n = returns.length;
        if (n < MIN_SAMPLE_SIZE) {
            return new ForecastResult(
                ForecastStatus.INSUFFICIENT_DATA, n,
                null, null, null, null, null, null, null, null, null,
                transactionCostBps, null
            );
        }

        double[] sorted = returns.clone();
        Arrays.sort(sorted);

        double mean = mean(returns);
        double median = median(sorted);
        double trimmedMean = trimmedMean(sorted, TRIM_FRACTION);
        double stdev = sampleStdev(returns, mean);

        double standardErrorOfMean = stdev / Math.sqrt(n);
        double meanLower = mean - Z_95 * standardErrorOfMean;
        double meanUpper = mean + Z_95 * standardErrorOfMean;

        double costFraction = transactionCostBps / 10000.0;
        int profitable = 0;
        for (double r : returns) if (r > costFraction) profitable++;
        double p = (double) profitable / n;
        double[] wilson = wilsonInterval(profitable, n);

        double netExpectedReturn = mean - costFraction;

        return new ForecastResult(
            ForecastStatus.VALID, n,
            mean, median, trimmedMean, stdev,
            meanLower, meanUpper,
            p, wilson[0], wilson[1],
            transactionCostBps, netExpectedReturn
        );
    }

    private static double mean(double[] xs) {
        double s = 0;
        for (double x : xs) s += x;
        return s / xs.length;
    }

    private static double median(double[] sorted) {
        int n = sorted.length;
        if (n == 0) return 0;
        if (n % 2 == 1) return sorted[n / 2];
        return (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0;
    }

    /** @param sorted must already be ascending. Falls back to the plain median when the sample is
     *                too small for a symmetric trim to leave anything (degenerate, never throws). */
    private static double trimmedMean(double[] sorted, double trimFraction) {
        int n = sorted.length;
        int trimCount = (int) Math.floor(n * trimFraction);
        int start = trimCount;
        int end = n - trimCount;
        if (end <= start) return median(sorted);
        double s = 0;
        for (int i = start; i < end; i++) s += sorted[i];
        return s / (end - start);
    }

    private static double sampleStdev(double[] xs, double mean) {
        if (xs.length < 2) return 0;
        double s = 0;
        for (double x : xs) s += (x - mean) * (x - mean);
        return Math.sqrt(s / (xs.length - 1));
    }

    /**
     * Wilson score interval (95%) for a binomial proportion - standard closed-form. A separate,
     * intentional port from the existing TS-side wilsonInterval() (effectiveSampleSize.ts) - see
     * this class's own header for why that is not a split-brain (different purpose: diagnostic
     * agent-calibration reporting there, this authoritative Forecast object here).
     */
    private static double[] wilsonInterval(int successes, int n) {
        if (n == 0) return new double[]{0, 0};
        double p = (double) successes / n;
        double z = Z_95;
        double z2 = z * z;
        double denominator = 1 + z2 / n;
        double center = p + z2 / (2 * n);
        double margin = z * Math.sqrt((p * (1 - p) / n) + z2 / (4.0 * n * n));
        double lower = (center - margin) / denominator;
        double upper = (center + margin) / denominator;
        return new double[]{Math.max(0, lower), Math.min(1, upper)};
    }
}
