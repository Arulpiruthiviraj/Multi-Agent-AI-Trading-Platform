package io.argus.quantcore.institutional.models;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * ARGUS Crypto Quant Alpha mandate (2026-09-22) - the volatility/Donchian breakout family the
 * 2026-09-21 forensic audit found missing (momentum and mean-reversion already existed; this was
 * the one named gap in the BTC-first strategy suite). RESEARCH status: real, tested, zero HTTP
 * live consumer, never wired to ChiefTraderAgent/RiskEngine/OMS/BrokerManager (same disclosure as
 * every other class in this package).
 *
 * Deliberately reuses existing, already-tested engines rather than recomputing anything
 * (CLAUDE.md: "never a silent second computation of the same thing"):
 *   - DonchianChannelEngine for the channel itself (already excludes the current bar - real
 *     no-lookahead convention, classical Donchian).
 *   - TrendStrengthEngine (Wilder ADX) for trend-strength confirmation.
 *   - CryptoFeatureEngine for ATR% (volatility-normalized breakout distance) and realized
 *     volatility context.
 *   - VolumeSignalEngine for volume-expansion confirmation.
 *   - CryptoRegimeEngine for regime compatibility.
 *
 * BREAKOUT vs CONTINUATION vs FAILED_BREAKOUT is determined causally: this class evaluates the
 * Donchian channel as of "now" (bar n-1) AND as of "one bar ago" (bar n-2, using only bars visible
 * at that time) and compares the two reads - never using any bar after the evaluation point.
 */
public final class BtcDonchianBreakoutStrategy implements CryptoStrategy {

    public enum BreakoutState {
        FRESH_BREAKOUT,      // broke out this bar, did not break out (same direction) last bar
        CONTINUATION,        // broke out this bar AND last bar (same direction) - trend extending
        FAILED_BREAKOUT,     // broke out last bar (either direction), back inside the channel now
        NO_BREAKOUT_CONTEXT  // neither this bar nor last bar broke out
    }

    public record Parameters(
        int donchianPeriod,
        int adxPeriod,
        int volumeAvgWindow,
        int volumeDivergenceWindow,
        double volumeBreakoutMultiplier
    ) {
    }

    /** Conservative starting defaults - deliberately not tuned/backtested (matches
     *  CryptoRegimeEngine.DEFAULT_THRESHOLDS's own disclosed status). A walk-forward harness, not
     *  this class, is responsible for any future parameter selection. */
    public static final Parameters DEFAULT_PARAMETERS = new Parameters(20, 14, 20, 10, 2.0);

    private final Parameters params;

    public BtcDonchianBreakoutStrategy(Parameters params) {
        this.params = params;
    }

    public Parameters parameters() {
        return params;
    }

    @Override
    public String strategyId() {
        return "BTC_DONCHIAN_BREAKOUT";
    }

    @Override
    public String version() {
        return "1.0.0";
    }

    /** Close-only callers get FLAT/insufficient-data - this strategy structurally needs highs/lows
     *  for a real channel; a synthetic high=low=close channel would be meaningless, not a fallback
     *  worth returning as a real signal. */
    @Override
    public CryptoStrategyEvaluation evaluate(double[] closes) {
        return new CryptoStrategyEvaluation(CryptoPosition.FLAT, false,
            new String[]{"BTC_DONCHIAN_BREAKOUT requires highs/lows - call evaluate(highs, lows, closes) instead"}, Map.of());
    }

    public CryptoStrategyEvaluation evaluate(double[] highs, double[] lows, double[] closes) {
        return evaluate(highs, lows, closes, null);
    }

    /** @param volumes optional - null/empty skips volume confirmation without failing the strategy
     *                 (a real but not-strictly-required piece of evidence). */
    public CryptoStrategyEvaluation evaluate(double[] highs, double[] lows, double[] closes, double[] volumes) {
        int n = closes.length;
        int minBars = params.donchianPeriod() + 2; // +1 for DonchianChannelEngine's own convention, +1 so a "one bar ago" read is also possible
        if (n < minBars || highs.length != n || lows.length != n) {
            return new CryptoStrategyEvaluation(CryptoPosition.FLAT, false,
                new String[]{"insufficient bar history (" + n + " bars, need >= " + minBars + ")"}, Map.of());
        }

        DonchianChannelEngine.Result current = DonchianChannelEngine.evaluate(highs, lows, closes, params.donchianPeriod());
        DonchianChannelEngine.Result prior = DonchianChannelEngine.evaluate(
            Arrays.copyOfRange(highs, 0, n - 1), Arrays.copyOfRange(lows, 0, n - 1), Arrays.copyOfRange(closes, 0, n - 1),
            params.donchianPeriod());
        if (current == null || prior == null) {
            return new CryptoStrategyEvaluation(CryptoPosition.FLAT, false,
                new String[]{"DonchianChannelEngine returned insufficient data for period=" + params.donchianPeriod()}, Map.of());
        }

        BreakoutState state = classify(current, prior);

        CryptoFeatureEngine.Snapshot features = CryptoFeatureEngine.compute(closes, highs, lows);
        TrendStrengthEngine.Result trend = TrendStrengthEngine.evaluate(highs, lows, closes, params.adxPeriod());
        VolumeSignalEngine.Result volumeSignal = (volumes != null && volumes.length == n)
            ? VolumeSignalEngine.evaluate(closes, volumes, params.volumeAvgWindow(), params.volumeDivergenceWindow(), params.volumeBreakoutMultiplier())
            : null;

        Map<String, Double> diagnostics = new LinkedHashMap<>();
        diagnostics.put("upperChannel", current.upperChannel());
        diagnostics.put("lowerChannel", current.lowerChannel());
        diagnostics.put("currentClose", current.currentClose());
        diagnostics.put("channelWidthPct", current.channelWidthPct());

        java.util.List<String> evidence = new java.util.ArrayList<>();
        evidence.add("breakoutState=" + state);

        // Only FRESH_BREAKOUT and CONTINUATION are ever eligible for a LONG read - a
        // FAILED_BREAKOUT is explicit negative evidence (price already gave the level back), and
        // NO_BREAKOUT_CONTEXT means there is nothing to evaluate a breakout signal from at all.
        if (state != BreakoutState.FRESH_BREAKOUT && state != BreakoutState.CONTINUATION) {
            String reason = state == BreakoutState.FAILED_BREAKOUT
                ? "prior breakout reverted - close back inside the channel this bar"
                : "no breakout at this bar or the prior bar";
            evidence.add(reason);
            return new CryptoStrategyEvaluation(CryptoPosition.FLAT, true, evidence.toArray(new String[0]), diagnostics);
        }

        // This strategy is long-only research (matches CryptoPosition's documented scope) - only a
        // breakoutUp forms a candidate LONG; a breakoutDown has no short counterpart to express here.
        if (!current.breakoutUp()) {
            evidence.add("breakout was downward (breakoutDown) - no short expression in this long-only research strategy");
            return new CryptoStrategyEvaluation(CryptoPosition.FLAT, true, evidence.toArray(new String[0]), diagnostics);
        }

        double atrPercent = features.sufficientData() ? features.atrPercent() : Double.NaN;
        double breakoutDistancePct = current.upperChannel() != 0
            ? (current.currentClose() - current.upperChannel()) / current.upperChannel() * 100.0 : 0.0;
        double atrNormalizedDistance = (!Double.isNaN(atrPercent) && atrPercent > 0) ? breakoutDistancePct / atrPercent : Double.NaN;
        diagnostics.put("breakoutDistancePct", breakoutDistancePct);
        if (!Double.isNaN(atrNormalizedDistance)) diagnostics.put("atrNormalizedBreakoutDistance", atrNormalizedDistance);
        evidence.add(String.format("breakoutDistance=%.3f%% of upper channel (%s)", breakoutDistancePct,
            Double.isNaN(atrNormalizedDistance) ? "ATR unavailable" : String.format("%.2fx ATR%%", atrNormalizedDistance)));

        boolean trendConfirms = trend != null && trend.trendingUp();
        boolean strongTrend = trend != null && trend.strongTrend();
        if (trend != null) {
            diagnostics.put("adx", trend.adx());
            diagnostics.put("plusDI", trend.plusDI());
            diagnostics.put("minusDI", trend.minusDI());
            evidence.add(String.format("ADX=%.1f, +DI %s -DI (%s)", trend.adx(), trend.plusDI() > trend.minusDI() ? ">" : "<=",
                strongTrend ? "strong trend" : "not a strong trend by Wilder's own threshold"));
        } else {
            evidence.add("ADX unavailable (insufficient bars)");
        }

        boolean volumeConfirms = volumeSignal != null && volumeSignal.volumeBreakout();
        if (volumeSignal != null) {
            diagnostics.put("relativeVolume", volumeSignal.relativeVolume());
            evidence.add(String.format("relativeVolume=%.2fx (%s)", volumeSignal.relativeVolume(),
                volumeConfirms ? "confirms breakout" : "does not confirm breakout"));
        } else {
            evidence.add("volume data unavailable - proceeding without volume confirmation");
        }

        // Continuous score in [0, 1]: normalized breakout distance (capped) is the base signal;
        // trend/volume confirmation and CONTINUATION (vs a first-bar FRESH_BREAKOUT) each add a
        // bounded increment. This is evidence accumulation, not "price > channel = BUY" - a bare
        // breakout with no confirmation scores low, never automatically LONG-worthy on its own.
        double distanceComponent = Double.isNaN(atrNormalizedDistance) ? 0.15 : Math.min(0.4, Math.max(0.0, atrNormalizedDistance * 0.2));
        double trendComponent = trendConfirms ? (strongTrend ? 0.25 : 0.12) : 0.0;
        double volumeComponent = volumeConfirms ? 0.2 : 0.0;
        double continuationComponent = state == BreakoutState.CONTINUATION ? 0.15 : 0.0;
        double score = Math.min(1.0, distanceComponent + trendComponent + volumeComponent + continuationComponent);
        diagnostics.put("continuousScore", score);

        CryptoRegimeEngine.Result regime = features.sufficientData() ? CryptoRegimeEngine.classify(features) : null;
        boolean regimeCompatible = regime != null && (
            regime.regime() == CryptoRegimeEngine.Regime.TRENDING_BULL
            || regime.regime() == CryptoRegimeEngine.Regime.VOLATILITY_EXPANSION
            || regime.regime() == CryptoRegimeEngine.Regime.VOLATILITY_COMPRESSION // classic "coiled spring" breakout origin
        );
        if (regime != null) {
            diagnostics.put("regimeConfidence", regime.regimeConfidence());
            evidence.add("regime=" + regime.regime() + " (" + (regimeCompatible ? "compatible" : "off-regime") + ")");
        }
        // Off-regime discounts the score rather than hard-blocking it - matches this codebase's
        // existing StrategyEngine.ts convention (regimeMismatchConfidenceMultiplier discounts,
        // never silently zeroes) applied identically here for consistency across TS and Java.
        double regimeAdjustedScore = regimeCompatible || regime == null ? score : score * 0.5;
        diagnostics.put("regimeAdjustedScore", regimeAdjustedScore);

        // Minimum bar: a fresh breakout with zero confirmation (no trend, no volume, no
        // continuation) scores 0.15-0.4 and stays FLAT - this strategy does not go LONG on channel
        // geometry alone.
        CryptoPosition position = regimeAdjustedScore >= 0.35 ? CryptoPosition.LONG : CryptoPosition.FLAT;
        diagnostics.put("confidence", regimeAdjustedScore);

        return new CryptoStrategyEvaluation(position, true, evidence.toArray(new String[0]), diagnostics);
    }

    private static BreakoutState classify(DonchianChannelEngine.Result current, DonchianChannelEngine.Result prior) {
        boolean currentBreakout = current.breakoutUp() || current.breakoutDown();
        boolean priorBreakout = prior.breakoutUp() || prior.breakoutDown();
        boolean sameDirection = (current.breakoutUp() && prior.breakoutUp()) || (current.breakoutDown() && prior.breakoutDown());

        if (currentBreakout && !priorBreakout) return BreakoutState.FRESH_BREAKOUT;
        if (currentBreakout && priorBreakout && sameDirection) return BreakoutState.CONTINUATION;
        if (!currentBreakout && priorBreakout) return BreakoutState.FAILED_BREAKOUT;
        return BreakoutState.NO_BREAKOUT_CONTEXT;
    }
}
