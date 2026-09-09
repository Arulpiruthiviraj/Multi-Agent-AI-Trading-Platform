package io.argus.quantcore.institutional.models;

/**
 * Long/Short Iron Butterfly - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Sections
 * 2.44-2.45, Eq. 196-205. A bull put spread + bear call spread combined at a shared ATM body
 * strike K2, with equidistant OTM wings (K2-K1 = K3-K2). "Long" iron butterfly (net credit, short
 * the ATM straddle, long the OTM wings for protection) is a sideways/income strategy; "short" (net
 * debit, long the ATM straddle, short the wings) is a volatility/capital-gain strategy - opposite
 * risk profile from {@link OptionButterflyEngine}'s all-call/all-put butterfly despite the shared
 * "butterfly" name, though the max-profit/max-loss shape (bounded both ways, kappa split between
 * them) is structurally the same.
 */
public final class OptionIronButterflyEngine {

    private OptionIronButterflyEngine() {
    }

    public enum Position { LONG_IRON_BUTTERFLY, SHORT_IRON_BUTTERFLY }

    public record Result(
        double breakevenLower,
        double breakevenUpper,
        double maxProfit,
        double maxLoss
    ) {
    }

    /**
     * @param wingLow, bodyStrike, wingHigh K1 &lt; K2 &lt; K3, equidistant (K2-K1 == K3-K2).
     * @param netPremium net credit received (LONG_IRON_BUTTERFLY) or net debit paid
     *                   (SHORT_IRON_BUTTERFLY); must be nonnegative and not exceed the wing width.
     * @return null if strikes are not equidistant/ordered, or netPremium is out of [0, wing width].
     */
    public static Result evaluate(Position position, double wingLow, double bodyStrike, double wingHigh, double netPremium) {
        if (wingLow <= 0 || bodyStrike <= wingLow || wingHigh <= bodyStrike || netPremium < 0) {
            return null;
        }
        double lowerWing = bodyStrike - wingLow;
        double upperWing = wingHigh - bodyStrike;
        if (Math.abs(lowerWing - upperWing) > 1e-9 || netPremium > lowerWing) {
            return null;
        }

        double breakevenLower = bodyStrike - netPremium;
        double breakevenUpper = bodyStrike + netPremium;
        double otherSide = lowerWing - netPremium;

        return position == Position.LONG_IRON_BUTTERFLY
            ? new Result(breakevenLower, breakevenUpper, netPremium, otherSide)
            : new Result(breakevenLower, breakevenUpper, otherSide, netPremium);
    }
}
