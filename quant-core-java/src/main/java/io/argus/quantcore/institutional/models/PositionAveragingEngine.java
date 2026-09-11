package io.argus.quantcore.institutional.models;

import java.util.Arrays;

/**
 * Commission-aware "add-on-decline" position-averaging sizing rule, from Xu, Wang, Han, Zhang,
 * Liu &amp; Chang, "A Quantitative Trading Strategy Based on A Position Management Model" (2022),
 * Section 4.3.2, Eq. 9-11 &amp; Table 9.
 *
 * PROVENANCE NOTE (required disclosure, per this codebase's standing rule against transcribing
 * corrupted source text as if verified): the source paper's own equations 9-11 are OCR-mangled
 * beyond reconstruction (e.g. "𝑃 1 1% 𝑀. 𝑃 1 1% . 𝑀. 0" - not a parseable formula). Rather than
 * guess at the corrupted symbols, this class independently re-derives the described economics
 * from the paper's own prose and Table 9's worked recursive-loss structure (which IS legible and
 * internally consistent): size the next add-on purchase so that, if the position then recovers by
 * an assumed rate, the recovered proceeds cover the prior mark-to-market loss plus round-trip
 * commission on the whole position. The paper's own worked numeric example (P1=$75.4158345 on a
 * hypothetical "day 300" BTC position) cannot be independently reproduced from the text - it
 * depends on a prior position size never stated in the excerpt - so it is not claimed as verified
 * against that specific number. What IS preserved from the source: the core mechanism (size the
 * n-th add-on against a target recovery rate, commission-aware, breakeven-seeking) and the
 * separate streak/percentile statistics the paper uses to choose that recovery rate empirically
 * (mislabeled "Apriori" in the source - it is not association-rule mining, it is plain descriptive
 * statistics on consecutive up/down run lengths; not fabricated here as full Apriori).
 *
 * The empirical recovery-rate/decline-percentile inputs (the paper's own M1/M5-style values) are
 * NOT defaulted anywhere in this class - real caller-supplied inputs, matching every other
 * paper-sourced engine in this catalog's discipline against inventing empirically-fit constants.
 *
 * RISK DISCLOSURE (not in the source paper, added here because it is material): this is a
 * martingale/averaging-down position-sizing rule. It has a known, real failure mode - a losing
 * streak longer than what the caller provisioned for leaves the position maximally exposed at the
 * worst possible time (the paper's own numbers: ~4.35% probability of &gt;4 consecutive declines in
 * their example series). This class computes sizes; it does not bound or validate that risk - a
 * caller must supply their own streak-depth risk tolerance.
 *
 * No live data feed exists in Argus today for gold or crypto (per this session's standing scope
 * note) - this is a pure calculator, RESEARCH status, built ahead of that capability.
 */
public final class PositionAveragingEngine {

    private PositionAveragingEngine() {
    }

    /**
     * Required size of the next add-on purchase, re-derived from the source's Eq. 11 intent.
     *
     * Breakeven condition solved for addOnAmount:
     *   (priorMarketValue + addOnAmount) * (1 + assumedRecoveryRate) * (1 - commissionRate)
     *     &gt;= (priorCostBasis + addOnAmount) * (1 + commissionRate)
     *
     * Left side: proceeds from selling the whole position (existing + new add-on) after it
     * recovers by assumedRecoveryRate, net of exit commission. Right side: total cash paid in so
     * far (existing cost basis) plus this add-on's own notional, grossed up for entry commission
     * on everything. Returns null (never a fabricated or negative number) when the assumed
     * recovery cannot overcome round-trip commission at any size - i.e. adding more never helps,
     * a real, meaningful "this recovery assumption makes the strategy infeasible here" signal.
     *
     * @param priorCostBasis   total notional $ already invested in this position (sum of all
     *                         prior add-on amounts, before commission)
     * @param priorMarketValue current mark-to-market $ value of that existing position (below
     *                         priorCostBasis after a decline; equal to it if this is the first add-on)
     * @param commissionRate   round-trip-applied-each-way commission, e.g. 0.01 for gold, 0.02 for
     *                         bitcoin per the source paper's own stated fee structure
     * @param assumedRecoveryRate the recovery move this add-on is being sized against (e.g. a
     *                         caller-supplied empirical percentile up-move) - a positive fraction
     */
    public static Double requiredAddOnPosition(double priorCostBasis, double priorMarketValue,
                                                double commissionRate, double assumedRecoveryRate) {
        if (priorCostBasis < 0 || priorMarketValue < 0 || commissionRate < 0 || commissionRate >= 1) {
            return null;
        }
        double recoveryFactor = (1 + assumedRecoveryRate) * (1 - commissionRate);
        double costFactor = 1 + commissionRate;
        double denominator = recoveryFactor - costFactor;
        if (denominator <= 0) {
            // The assumed recovery isn't large enough to overcome round-trip commission at any
            // size - adding more can never break even under this assumption. Not a fabricated 0
            // or a misleading negative "add-on" - a real infeasibility signal.
            return null;
        }
        double addOn = (priorCostBasis * costFactor - priorMarketValue * recoveryFactor) / denominator;
        return Math.max(0, addOn);
    }

    /**
     * Verification helper (used by this class's own tests, also useful to a caller wanting to
     * confirm a sizing decision before acting on it): net $ profit/loss if the position is sized
     * per requiredAddOnPosition and then actually recovers by exactly assumedRecoveryRate before
     * being fully closed. Should be >= 0 (within floating-point tolerance) whenever
     * requiredAddOnPosition returned a non-null value - the whole point of the sizing formula.
     */
    public static double netPnlIfRecoveryRealized(double priorCostBasis, double priorMarketValue,
                                                    double addOnAmount, double commissionRate, double recoveryRate) {
        double totalCostBasis = priorCostBasis + addOnAmount;
        double totalPaidIn = totalCostBasis * (1 + commissionRate);
        double marketValueAfterAddOn = priorMarketValue + addOnAmount;
        double proceedsAfterRecovery = marketValueAfterAddOn * (1 + recoveryRate) * (1 - commissionRate);
        return proceedsAfterRecovery - totalPaidIn;
    }

    public record Streak(boolean isUp, int length, int startIndex) {
    }

    /**
     * Real descriptive statistics on consecutive up/down run lengths in a return series - what the
     * source paper actually computed (mislabeled "Apriori algorithm" there; this is not
     * association-rule mining). A zero return is treated as neither up nor down and breaks any
     * active streak, matching the source's own binary up/down framing.
     */
    public static Streak[] consecutiveStreaks(double[] returns) {
        if (returns.length == 0) {
            return new Streak[0];
        }
        java.util.List<Streak> streaks = new java.util.ArrayList<>();
        Boolean currentUp = null;
        int currentLength = 0;
        int currentStart = 0;
        for (int i = 0; i < returns.length; i++) {
            if (returns[i] == 0) {
                if (currentUp != null) {
                    streaks.add(new Streak(currentUp, currentLength, currentStart));
                }
                currentUp = null;
                currentLength = 0;
                continue;
            }
            boolean isUp = returns[i] > 0;
            if (currentUp != null && currentUp == isUp) {
                currentLength++;
            } else {
                if (currentUp != null) {
                    streaks.add(new Streak(currentUp, currentLength, currentStart));
                }
                currentUp = isUp;
                currentLength = 1;
                currentStart = i;
            }
        }
        if (currentUp != null) {
            streaks.add(new Streak(currentUp, currentLength, currentStart));
        }
        return streaks.toArray(new Streak[0]);
    }

    /**
     * Fraction of same-direction streaks (up or down, selected by isUp) whose length is
     * &lt;= maxLength - the source paper's own "probability that a losing streak is at most k
     * declines long" statistic (their worked example: P(K2)+P(K3)+P(K4)=95.65%, i.e.
     * streakCoverageFraction(streaks, false, 4)).
     */
    public static double streakCoverageFraction(Streak[] streaks, boolean isUp, int maxLength) {
        long matching = Arrays.stream(streaks).filter(s -> s.isUp() == isUp).count();
        if (matching == 0) {
            return 0;
        }
        long covered = Arrays.stream(streaks).filter(s -> s.isUp() == isUp && s.length() <= maxLength).count();
        return (double) covered / matching;
    }

    /**
     * Linear-interpolation quantile of a value set (e.g. the source paper's M1/M5/M9-style
     * percentile move sizes). p in [0,1]. Returns null (not fabricated) for an empty input.
     */
    public static Double quantile(double[] values, double p) {
        if (values.length == 0 || p < 0 || p > 1) {
            return null;
        }
        double[] sorted = values.clone();
        Arrays.sort(sorted);
        if (sorted.length == 1) {
            return sorted[0];
        }
        double rank = p * (sorted.length - 1);
        int lower = (int) Math.floor(rank);
        int upper = (int) Math.ceil(rank);
        if (lower == upper) {
            return sorted[lower];
        }
        double frac = rank - lower;
        return sorted[lower] * (1 - frac) + sorted[upper] * frac;
    }
}
