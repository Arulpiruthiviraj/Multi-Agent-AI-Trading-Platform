package io.argus.quantcore.institutional.models;

/**
 * ARGUS Crypto V2 (2026-09-21) - transaction cost models. RESEARCH status.
 * Tan (2025) uses a flat 0.1% per trade - the thesis itself names fixed transaction costs and
 * simplified execution as a limitation of its own methodology. This class reproduces that exact
 * assumption for baseline parity; realisticCost() is a SEPARATE, not-pre-populated structure for
 * fees/spread/slippage that real market data must supply - it must never be treated as validated
 * until real fee/spread/slippage inputs are wired in ("Never assume 0.1% is universally
 * realistic").
 */
public final class CryptoTransactionCostModel {
    private CryptoTransactionCostModel() {
    }

    public static final double TAN2025_BASELINE_COST_RATE = 0.001; // 0.1% per trade, reproduced exactly

    public static double tan2025BaselineCost(double notional) {
        return notional * TAN2025_BASELINE_COST_RATE;
    }

    public record RealisticCostInputs(double feeRate, double halfSpreadRate, double slippageRate) {
    }

    /** Sums fee + half-spread (paid on entry AND exit, hence the caller passes half-spread) +
     *  slippage as independent rate components against notional - each component must come from
     *  real, caller-supplied evidence (broker fee schedule, observed spread, measured slippage).
     *  This function fabricates none of those rates itself. */
    public static double realisticCost(double notional, RealisticCostInputs inputs) {
        return notional * (inputs.feeRate() + inputs.halfSpreadRate() + inputs.slippageRate());
    }
}
