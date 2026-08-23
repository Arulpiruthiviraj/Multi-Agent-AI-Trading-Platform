package io.argus.quantcore.risk;

/**
 * Ported byte-for-byte from src/server/quant/risk/ExpectedValue.ts. Advisory only — per the TS
 * source's own header comment, this NEVER sizes a position or places an order; it returns a
 * suggested risk fraction only, for the idea payload's confidence/EV field (see the migration
 * blueprint §2.4). RiskEngine/PositionSizing remain the sole live sizing authority in TypeScript.
 */
public final class ExpectedValue {

    /** Snapshot mirror of tradingSafety.json (captured 2026-08-21) — see QuantThresholds's own
     *  header comment on why this is a snapshot, not a live config read, in Phase 1. */
    public static final int MIN_SAMPLE_SIZE_FOR_KELLY = 20;
    public static final double MAX_KELLY_FRACTION_OF_CAPITAL = 0.1;
    public static final double KELLY_FRACTION_DEFAULT = 0.25;

    private ExpectedValue() {
    }

    public record RiskRewardResult(Double ratio, double riskPerUnit, double rewardPerUnit) {
    }

    public static RiskRewardResult riskRewardRatio(double entry, double stop, double target) {
        if (!Double.isFinite(entry) || !Double.isFinite(stop) || !Double.isFinite(target)) {
            return null;
        }
        double riskPerUnit = Math.abs(entry - stop);
        double rewardPerUnit = Math.abs(target - entry);
        if (riskPerUnit == 0) {
            return null;
        }
        return new RiskRewardResult(rewardPerUnit / riskPerUnit, riskPerUnit, rewardPerUnit);
    }

    public record ExpectedValueResult(double expectedValueR, double winProbability, double riskRewardRatio) {
    }

    public static ExpectedValueResult expectedValue(double winProbability, double rrRatio) {
        if (!Double.isFinite(winProbability) || winProbability < 0 || winProbability > 1) {
            return null;
        }
        if (!Double.isFinite(rrRatio) || rrRatio <= 0) {
            return null;
        }
        double expectedValueR = winProbability * rrRatio - (1 - winProbability) * 1;
        return new ExpectedValueResult(round4(expectedValueR), winProbability, rrRatio);
    }

    public record KellyResult(
        double fullKellyFraction,
        double suggestedFraction,
        double fractionOfFullKelly,
        int sampleSize,
        boolean statisticallyJustified,
        String reason
    ) {
    }

    public static KellyResult fractionalKelly(double winProbability, double rrRatio, int sampleSize, double fraction) {
        if (sampleSize < MIN_SAMPLE_SIZE_FOR_KELLY) {
            return new KellyResult(0, 0, fraction, sampleSize, false,
                "INSUFFICIENT SAMPLE SIZE: only " + sampleSize + " closed trades back this win-rate estimate - Kelly sizing is not statistically meaningful below "
                    + MIN_SAMPLE_SIZE_FOR_KELLY + ". No size suggested.");
        }
        if (!Double.isFinite(winProbability) || winProbability <= 0 || winProbability >= 1
            || !Double.isFinite(rrRatio) || rrRatio <= 0) {
            return new KellyResult(0, 0, fraction, sampleSize, false,
                "Invalid winProbability or risk/reward ratio - cannot compute a real Kelly fraction.");
        }

        double fullKelly = (winProbability * (rrRatio + 1) - 1) / rrRatio;

        if (fullKelly <= 0) {
            return new KellyResult(round4(fullKelly), 0, fraction, sampleSize, true,
                "Full Kelly is non-positive (" + String.format("%.4f", fullKelly)
                    + ") - this setup has no real statistical edge at this win rate/R:R combination. No size suggested, regardless of sample size.");
        }

        double scaled = fullKelly * fraction;
        double suggestedFraction = Math.min(scaled, MAX_KELLY_FRACTION_OF_CAPITAL);
        boolean wasCapped = scaled > MAX_KELLY_FRACTION_OF_CAPITAL;

        String reason = wasCapped
            ? "Real positive edge (full Kelly " + String.format("%.4f", fullKelly) + ") over " + sampleSize
                + " real trades, but " + Math.round(fraction * 100) + "% Kelly (" + String.format("%.4f", scaled)
                + ") exceeded the hard cap of " + MAX_KELLY_FRACTION_OF_CAPITAL + " - capped, not the raw fractional-Kelly output."
            : "Real positive edge (full Kelly " + String.format("%.4f", fullKelly) + ") over " + sampleSize
                + " real trades - suggesting " + Math.round(fraction * 100) + "% of it.";

        return new KellyResult(round4(fullKelly), round4(suggestedFraction), fraction, sampleSize, true, reason);
    }

    public static KellyResult fractionalKelly(double winProbability, double rrRatio, int sampleSize) {
        return fractionalKelly(winProbability, rrRatio, sampleSize, KELLY_FRACTION_DEFAULT);
    }

    private static double round4(double v) {
        return Math.round(v * 10000.0) / 10000.0;
    }
}
