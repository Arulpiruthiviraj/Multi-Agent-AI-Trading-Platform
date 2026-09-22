package io.argus.quantcore.institutional.models;

/**
 * ARGUS Crypto Quant Alpha mandate (2026-09-22) - "keep confidence and expectedEdge as distinct
 * quantities; never treat raw confidence as expected profitability" (explicit operator
 * instruction). RESEARCH status.
 *
 * This class computes the REAL formula only. It does not, and structurally cannot honestly,
 * supply win probability / average win / average loss itself - those are calibration inputs that
 * must come from real observed outcomes (a walk-forward harness or the eventual paper-trading
 * calibration ledger), never invented here. Until real calibration data exists, any caller of this
 * class is responsible for sourcing genuinely-measured inputs (or clearly labeling a hypothetical
 * scenario as such) - this mirrors CryptoTransactionCostModel.realisticCost()'s own documented
 * "fabricates none of those rates itself" contract, applied to the edge side of the same equation.
 */
public final class CryptoExpectedEdgeEngine {

    private CryptoExpectedEdgeEngine() {
    }

    public record Calibration(
        double winProbability,   // [0, 1] - must come from real observed outcomes, never assumed
        double avgWinPct,        // average winning trade return, as a positive fraction (e.g. 0.02 = 2%)
        double avgLossPct,       // average losing trade return, as a positive fraction (magnitude, not signed)
        int sampleSize           // number of observations this calibration is based on - 0 means "uncalibrated"
    ) {
    }

    public record EdgeEstimate(
        double expectedEdgePct,        // expected return per trade, before cost, as a fraction
        double expectedCostPct,        // round-trip cost, as a fraction (from CryptoTransactionCostModel-style inputs)
        double expectedEdgeAfterCostPct,
        boolean sufficientEdge,        // expectedEdgeAfterCostPct > safetyMarginPct
        boolean calibrated,            // sampleSize > 0 - an uncalibrated estimate must never be treated as trustworthy
        String reasonCode
    ) {
    }

    /**
     * @param calibration     real observed win-rate/avg-win/avg-loss statistics (sampleSize=0 if none exist yet).
     * @param costRateFraction round-trip transaction cost as a fraction of notional (fees + spread + slippage;
     *                         see CryptoTransactionCostModel).
     * @param safetyMarginPct  additional required edge above cost before a trade is considered worth taking
     *                         (a policy parameter, not invented here - caller supplies it from reviewed config).
     * @param minimumSampleSize below this many observations, the estimate is reported but flagged uncalibrated -
     *                          matches this codebase's existing small-sample skepticism (e.g. Kelly's own
     *                          "refuses < 20 closed trades" rule elsewhere in this codebase).
     */
    public static EdgeEstimate estimate(Calibration calibration, double costRateFraction, double safetyMarginPct, int minimumSampleSize) {
        double winProb = clamp01(calibration.winProbability());
        double lossProb = 1.0 - winProb;
        double expectedEdgePct = (winProb * calibration.avgWinPct()) - (lossProb * calibration.avgLossPct());
        double expectedEdgeAfterCostPct = expectedEdgePct - costRateFraction;
        boolean calibrated = calibration.sampleSize() >= minimumSampleSize;
        boolean sufficientEdge = calibrated && expectedEdgeAfterCostPct > safetyMarginPct;

        String reasonCode;
        if (!calibrated) {
            reasonCode = "UNCALIBRATED: sampleSize=" + calibration.sampleSize() + " < minimum " + minimumSampleSize + " - estimate is not trustworthy regardless of its sign";
        } else if (!sufficientEdge) {
            reasonCode = String.format("NO_EDGE: expectedEdgeAfterCost=%.4f%% <= safetyMargin=%.4f%%", expectedEdgeAfterCostPct * 100, safetyMarginPct * 100);
        } else {
            reasonCode = "OK";
        }

        return new EdgeEstimate(expectedEdgePct, costRateFraction, expectedEdgeAfterCostPct, sufficientEdge, calibrated, reasonCode);
    }

    private static double clamp01(double v) {
        if (Double.isNaN(v)) return 0.0;
        return Math.max(0.0, Math.min(1.0, v));
    }
}
