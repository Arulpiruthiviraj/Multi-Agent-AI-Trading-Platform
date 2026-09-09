package io.argus.quantcore.institutional.models;

/**
 * Synthetic stock positions built from a call + a put - ASX "Understanding Options Trading"
 * booklet, Strategies 3-4 and 9-10. SYNTHETIC_LONG (buy call A + sell put A) and SYNTHETIC_SHORT
 * (buy put A + sell call A) replicate long/short stock at a single strike; SPLIT_STRIKE_LONG
 * (sell put A + buy call B, A&lt;B) and SPLIT_STRIKE_SHORT (buy put A + sell call B, A&lt;B) are
 * "risk reversal" variants with a flat, zero-sensitivity zone between the two strikes. netPremium
 * uses the same signed convention as {@link OptionVerticalSpreadEngine}: positive = net credit
 * received, negative = net debit paid. All bounds independently re-derived from the payoff
 * function (a call minus a put at the same strike algebraically replicates the underlying minus
 * that strike, which is the basis for every formula here).
 */
public final class OptionSyntheticStockEngine {

    private OptionSyntheticStockEngine() {
    }

    public enum Position { SYNTHETIC_LONG, SYNTHETIC_SHORT, SPLIT_STRIKE_LONG, SPLIT_STRIKE_SHORT }

    public record Result(
        double breakeven,
        double maxRisk,
        double maxReward
    ) {
    }

    /**
     * @param lowStrike  the single strike for SYNTHETIC_LONG/SYNTHETIC_SHORT (highStrike unused,
     *                   pass any value), or A for the split-strike variants.
     * @param highStrike B for the split-strike variants (must exceed lowStrike); unused for the
     *                   single-strike variants.
     * @param netPremium signed: positive = net credit received, negative = net debit paid.
     * @return null if lowStrike is not positive, or (for split-strike variants) highStrike &lt;= lowStrike.
     */
    public static Result evaluate(Position position, double lowStrike, double highStrike, double netPremium) {
        if (lowStrike <= 0) {
            return null;
        }
        switch (position) {
            case SYNTHETIC_LONG -> {
                double breakeven = lowStrike - netPremium;
                double maxRisk = lowStrike - netPremium; // bounded at S=0
                return new Result(breakeven, maxRisk, Double.POSITIVE_INFINITY);
            }
            case SYNTHETIC_SHORT -> {
                double breakeven = lowStrike + netPremium;
                double maxReward = lowStrike + netPremium; // bounded at S=0
                return new Result(breakeven, Double.POSITIVE_INFINITY, maxReward);
            }
            case SPLIT_STRIKE_LONG -> {
                if (highStrike <= lowStrike) return null;
                double breakeven = lowStrike - netPremium;
                double maxRisk = lowStrike - netPremium; // bounded at S=0
                return new Result(breakeven, maxRisk, Double.POSITIVE_INFINITY);
            }
            case SPLIT_STRIKE_SHORT -> {
                if (highStrike <= lowStrike) return null;
                double breakeven = highStrike + netPremium;
                double maxReward = lowStrike + netPremium; // bounded at S=0 (floor on gains as underlying falls to zero)
                return new Result(breakeven, Double.POSITIVE_INFINITY, maxReward);
            }
            default -> throw new IllegalStateException("Unhandled position: " + position);
        }
    }
}
