package io.argus.quantcore.risk;

import io.argus.quantcore.institutional.math.NormalDistribution;

/**
 * S-curve bet sizing from meta-label probabilities.
 * ============================================================================
 * WHAT: Converts a calibrated win probability into a signed position-size
 *   fraction. This is the sizing leg of the meta-labeling architecture:
 *   the meta-model predicts P(profitable | setup features), and this function
 *   maps that probability to how much capital to risk.
 *
 * THE MATH:
 *   Given p = P(the triggered setup is profitable after costs):
 *
 *     z    = (p - 0.5) / sqrt(p * (1 - p))
 *     size = 2 * Phi(z) - 1
 *
 *   where Phi is the standard normal CDF.
 *
 * WHY THIS FORMULA (the quant intuition):
 *   The term (p - 0.5) / sqrt(p * (1 - p)) is the standardized distance of p
 *   from the no-edge baseline (0.5), measured in units of the Bernoulli
 *   standard deviation. In other words: "how many standard deviations of
 *   evidence is this probability away from a coin flip?"
 *
 *   - At p = 0.5: z = 0, Phi(0) = 0.5, size = 0. No edge → bet nothing.
 *     This is the most important property: the function has a natural
 *     "off switch" at the point of maximum uncertainty.
 *   - As p → 1: z → +∞, Phi(z) → 1, size → +1. Complete certainty →
 *     maximum long position. (In practice p never reaches 1; the curve
 *     saturates gracefully.)
 *   - As p → 0: z → -∞, Phi(z) → 0, size → -1. Complete certainty of loss →
 *     maximum short (or equivalently, fade the signal).
 *   - The S-curve shape means: small edges get small bets (the curve is flat
 *     near p=0.5), large edges get proportionally larger bets (steep in the
 *     middle), and extreme probabilities saturate (diminishing marginal
 *     sizing as p approaches 0 or 1). This is more sensible than linear
 *     sizing (size = 2p - 1), which over-bets marginal edges.
 *
 * RELATIONSHIP TO KELLY:
 *   The Kelly criterion (f* = (bp - q) / b) is the theoretically optimal
 *   growth-maximizing bet size, but it is notoriously aggressive — it assumes
 *   perfectly known probabilities and produces ruin-sized bets on estimation
 *   error. Practitioners typically use "fractional Kelly" (bet half or quarter
 *   Kelly) as a safety margin. The S-curve here is philosophically similar to
 *   fractional Kelly: it captures Kelly's core insight (bet proportional to
 *   edge, nothing at no-edge) while being inherently conservative near p=0.5
 *   where estimation error is most dangerous. It is NOT Kelly, and makes no
 *   optimality claim — it is a robust heuristic with good boundary behavior.
 *
 * WHAT THIS RETURNS:
 *   A signed fraction in [-1, 1], NOT a dollar amount and NOT a share count.
 *   - +1.0 = maximum long position (whatever "maximum" means in context)
 *   - -1.0 = maximum short position (or maximum fade)
 *   -  0.0 = flat, bet nothing
 *   The caller multiplies by its own capital/risk budget to get notionals.
 *   This separation keeps the math pure and the capital policy in one place
 *   (PositionSizing / RiskEngine), rather than scattering dollar logic here.
 *
 * INPUT CONTRACT:
 *   winProbability MUST be a calibrated probability in (0, 1) exclusive.
 *   "Calibrated" means: when the model says p=0.7, the setup is actually
 *   profitable ~70% of the time. An uncalibrated model (e.g., raw classifier
 *   scores) fed into this function produces garbage sizes — the S-curve
 *   amplifies miscalibration. Calibration (Platt scaling, isotonic regression)
 *   is the meta-model training pipeline's responsibility, not this function's.
 *   The strict (0,1) input validation enforces this contract at the boundary:
 *   p=0 or p=1 would imply infinite certainty, which never exists in markets.
 *
 * ACTIVATION STATUS: DORMANT.
 *   This is a PURE MATHEMATICAL PRIMITIVE with no production caller. Per the
 *   research charter, no meta-model exists yet (insufficient real PAPER labels),
 *   so there is no p to feed it. When a calibrated meta-model exists with
 *   sufficient evidence, a future change may call this from PositionSizing —
 *   that integration requires its own review, its own evidence gate, and its
 *   own risk sign-off. Do not wire this into any live path without those.
 */
public final class MetaLabelSizing {

    // Non-instantiable: all methods are static pure functions.
    private MetaLabelSizing() {}

    /**
     * Convert a calibrated win probability to a signed size fraction in [-1, 1].
     *
     * <p>Behavioral contract (all verified by MetaLabelSizingTest):
     * <ul>
     *   <li>size(0.5) = 0 — the no-edge off switch</li>
     *   <li>size is strictly increasing in p (monotonic: more edge → bigger bet)</li>
     *   <li>size(1-p) = -size(p) (symmetric: fading a bad setup mirrors backing a good one)</li>
     *   <li>|size| &lt; 1 for all valid inputs (bounded: never exceeds the caller's maximum)</li>
     * </ul>
     *
     * @param winProbability calibrated P(profitable after costs), must be in (0, 1) exclusive.
     *        Values outside this range indicate a broken or uncalibrated model upstream.
     * @return signed size fraction: 0 at p=0.5, positive for p&gt;0.5, negative for p&lt;0.5
     * @throws IllegalArgumentException if p is NaN, infinite, or outside (0, 1).
     *         Failing fast here (rather than clamping) is deliberate: silently
     *         clamping a p=1.5 to p=0.99 would mask a model bug. The caller
     *         should fix their calibration, not have it papered over.
     */
    public static double size(double winProbability) {
        if (Double.isNaN(winProbability) || Double.isInfinite(winProbability)) {
            throw new IllegalArgumentException("winProbability must be finite, got: " + winProbability);
        }
        if (winProbability <= 0.0 || winProbability >= 1.0) {
            throw new IllegalArgumentException("winProbability must be in (0, 1), got: " + winProbability);
        }
        // Standardized distance from no-edge, in Bernoulli-std-dev units.
        // At p=0.5 the numerator is 0 → z=0 → size=0 regardless of denominator.
        double z = (winProbability - 0.5) / Math.sqrt(winProbability * (1.0 - winProbability));
        // Phi maps (-∞, +∞) → (0, 1); the affine transform maps that → (-1, +1).
        return 2.0 * NormalDistribution.cdf(z) - 1.0;
    }

    /**
     * Convenience overload: size scaled to a caller-defined maximum fraction.
     *
     * <p>Example: size(0.7, 0.10) returns the signed fraction of capital to
     * risk when the meta-model says p=0.7 and the risk policy caps any single
     * meta-sized position at 10% of capital. The S-curve determines the
     * proportion of the cap; the cap itself remains a risk-policy decision.
     *
     * @param winProbability calibrated P(profitable after costs) in (0, 1)
     * @param maxFraction maximum position as a fraction of capital, in (0, 1].
     *        Must be positive (a zero/negative cap is meaningless) and ≤1
     *        (cannot risk more than total capital through this function).
     * @return signed size in [-maxFraction, +maxFraction]
     * @throws IllegalArgumentException if maxFraction is NaN or outside (0, 1]
     */
    public static double size(double winProbability, double maxFraction) {
        if (Double.isNaN(maxFraction) || maxFraction <= 0.0 || maxFraction > 1.0) {
            throw new IllegalArgumentException("maxFraction must be in (0, 1], got: " + maxFraction);
        }
        return size(winProbability) * maxFraction;
    }
}
