package io.argus.quantcore.institutional.models;

/**
 * Covered Short Straddle/Strangle - Kakushadze &amp; Serur, "151 Trading Strategies" (2018),
 * Sections 2.32-2.33, Eq. 131-137. A covered call (long stock + short call) augmented by also
 * writing a put, increasing income at the cost of additional downside exposure.
 */
public final class OptionCoveredStraddleEngine {

    private OptionCoveredStraddleEngine() {
    }

    public record StraddleResult(
        double breakeven,
        double maxProfit,
        double maxLoss
    ) {
    }

    /**
     * Covered Short Straddle (Eq. 131-134): long stock + short call + short put, ALL at the SAME
     * strike K.
     */
    public static StraddleResult coveredShortStraddle(double stockPrice, double strike, double netPremium) {
        if (stockPrice <= 0 || strike <= 0) {
            return null;
        }
        double breakeven = (stockPrice + strike - netPremium) / 2.0;
        double maxProfit = strike - stockPrice + netPremium;
        double maxLoss = stockPrice + strike - netPremium;
        return new StraddleResult(breakeven, maxProfit, maxLoss);
    }

    public record StrangleResult(
        double maxProfit,
        double maxLoss
        // The paper does not give a closed-form breakeven for this variant (unlike the straddle
        // case above) - not fabricated here.
    ) {
    }

    /**
     * Covered Short Strangle (Eq. 135-137): long stock + short call at strike K + short OTM put
     * at a lower strike K'.
     */
    public static StrangleResult coveredShortStrangle(double stockPrice, double callStrike, double putStrike, double netPremium) {
        if (stockPrice <= 0 || callStrike <= 0 || putStrike <= 0 || putStrike >= callStrike) {
            return null;
        }
        double maxProfit = callStrike - stockPrice + netPremium;
        double maxLoss = stockPrice + putStrike - netPremium;
        return new StrangleResult(maxProfit, maxLoss);
    }
}
