package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.EffectiveRatio;

/**
 * VIX-based volatility-regime postprocessing filter, from Lu &amp; Wu, "A note on VIX for
 * postprocessing quantitative strategies" (2022). Not a directional alpha source - a
 * CONDITIONING/gating overlay meant to sit on top of an existing strategy's signal and suppress
 * trading on days where the VIX itself is trending unusually strongly (in either direction),
 * which the paper's own backtests (SH510300, SH510050) found correlates with materially worse
 * realized returns for the underlying strategy on those days.
 *
 * Core math: Kaufman's Efficiency Ratio (see EffectiveRatio.java) applied to the VIX series
 * instead of the traded asset's price series - the paper's specific contribution is this
 * application, not a new ratio formula.
 *
 * DELIBERATELY NOT hardcoding the paper's own fitted window/threshold values (M=18 for
 * SH510300, M=7 for SH510050; a scaled-chart threshold around -1 on a x10 axis, i.e. raw ER
 * magnitude around 0.1) as Argus defaults. Two reasons, both from the paper's own text, not
 * invented here: (1) those numbers were fit via OLS regression to two specific Chinese ETF
 * datasets - the paper explicitly frames them as an example of the method, not a universal
 * constant ("no claim is made on the suggestion of real market positions"); (2) the SIGN of the
 * effect was dataset-dependent in the paper itself - SH510300 showed suppressing on a strongly
 * POSITIVE VIX ER (VIX trending up) helped, while SH510050 showed the useful signal was a
 * strongly NEGATIVE VIX ER instead. Baking in one sign+threshold pair as "the" Argus default
 * would misrepresent an asset-specific empirical fit as a general law. Callers must supply their
 * own threshold and gating direction, presumably re-derived against Argus's own traded universe
 * before this ever influences a live decision - this class computes the input to that decision
 * honestly, it does not manufacture the decision itself.
 *
 * RESEARCH status: real formula, zero live consumer, no claim of validated edge. Also currently
 * unreachable from any live Argus data path - Argus has no historical VIX bar series today (only
 * a single current-snapshot VIX value via FinceptCacheAdapter.ts), a genuine, separate data-
 * acquisition gap this class does not attempt to paper over.
 */
public final class VixEffectiveRatioFilterEngine {

    private VixEffectiveRatioFilterEngine() {
    }

    public enum GateDirection {
        /** Suppress when the (signed) VIX ER rises ABOVE the threshold - VIX trending up strongly. */
        SUPPRESS_ABOVE,
        /** Suppress when the (signed) VIX ER falls BELOW the threshold - VIX trending down strongly. */
        SUPPRESS_BELOW,
    }

    public record Result(
        double vixEffectiveRatio, // raw, signed, in [-1, 1], or NaN if not computable
        boolean computable,
        boolean shouldSuppressTrading
    ) {
    }

    /**
     * @param vixCloses chronological VIX daily closes (oldest first); the last element is the
     *                  most recently known close. Callers are responsible for not including
     *                  today's still-forming/unknown VIX value - this mirrors the paper's own
     *                  explicit no-look-ahead framing (its et(M) is defined using v[t-1]..v[t-1-M]
     *                  specifically because v[t] is unknown at decision time t).
     * @param window    lookback M (paper's own examples used 18 and 7 - not defaults here; see
     *                  class doc comment).
     * @param direction which side of {@code threshold} triggers suppression.
     * @param threshold caller-supplied gate level for the raw (unscaled, [-1,1]) ER value.
     */
    public static Result evaluate(double[] vixCloses, int window, GateDirection direction, double threshold) {
        double er = EffectiveRatio.calculate(vixCloses, window);
        if (Double.isNaN(er)) {
            return new Result(Double.NaN, false, false);
        }
        boolean suppress = direction == GateDirection.SUPPRESS_ABOVE ? er > threshold : er < threshold;
        return new Result(er, true, suppress);
    }
}
