package io.argus.quantcore.risk;

import io.argus.quantcore.institutional.math.NormalDistribution;

/**
 * S-curve bet sizing from meta-label probabilities.
 *
 * <p>2026-10-05: Implements the sizing formula from the quant research program's
 * meta-labeling design (knowledge-base/entries/ml-meta-labeling.md):
 *
 * <pre>
 *   z = (p - 0.5) / sqrt(p * (1 - p))
 *   size = 2 * Phi(z) - 1
 * </pre>
 *
 * <p>where p is the meta-model's calibrated probability that a triggered setup is
 * profitable after costs, and Phi is the standard normal CDF.
 *
 * <p>Properties:
 * <ul>
 *   <li>p = 0.5 (no edge) -&gt; size = 0 (bet nothing)</li>
 *   <li>p &gt; 0.5 -&gt; positive size (long), increasing in p</li>
 *   <li>p &lt; 0.5 -&gt; negative size (short / fade), symmetric</li>
 *   <li>Bounded in [-1, 1]: a fraction of the maximum position, never a dollar amount</li>
 * </ul>
 *
 * <p>This is a PURE MATHEMATICAL PRIMITIVE. It is NOT wired into any live sizing path.
 * Per the research charter, no meta-model exists yet (insufficient real labels), so this
 * function has no production caller. When a calibrated meta-model exists with sufficient
 * PAPER evidence, a future change may use this to scale positions - that change requires
 * its own review and evidence gate.
 */
public final class MetaLabelSizing {

    private MetaLabelSizing() {}

    /**
     * Convert a calibrated win probability to a signed position-size fraction in [-1, 1].
     *
     * @param winProbability calibrated P(profitable after costs), must be in (0, 1)
     * @return signed size fraction: 0 at p=0.5, positive for p&gt;0.5, negative for p&lt;0.5
     * @throws IllegalArgumentException if p is NaN, infinite, or outside (0, 1)
     */
    public static double size(double winProbability) {
        if (Double.isNaN(winProbability) || Double.isInfinite(winProbability)) {
            throw new IllegalArgumentException("winProbability must be finite, got: " + winProbability);
        }
        if (winProbability <= 0.0 || winProbability >= 1.0) {
            throw new IllegalArgumentException("winProbability must be in (0, 1), got: " + winProbability);
        }
        double z = (winProbability - 0.5) / Math.sqrt(winProbability * (1.0 - winProbability));
        return 2.0 * NormalDistribution.cdf(z) - 1.0;
    }

    /**
     * Convenience: size scaled to a maximum notional fraction.
     *
     * @param winProbability calibrated P(profitable after costs) in (0, 1)
     * @param maxFraction maximum position as a fraction of capital, in (0, 1]
     * @return signed size in [-maxFraction, maxFraction]
     */
    public static double size(double winProbability, double maxFraction) {
        if (Double.isNaN(maxFraction) || maxFraction <= 0.0 || maxFraction > 1.0) {
            throw new IllegalArgumentException("maxFraction must be in (0, 1], got: " + maxFraction);
        }
        return size(winProbability) * maxFraction;
    }
}
