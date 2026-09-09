package io.argus.quantcore.institutional.models;

/**
 * Strap/Strip - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Sections 2.34-2.35, Eq.
 * 138-147. Unequal-ratio (2:1) straddle variants at a single ATM strike: Strap (2 long calls + 1
 * long put) is a volatility trade with a bullish bias; Strip (1 long call + 2 long puts) is a
 * volatility trade with a bearish bias.
 */
public final class OptionStrapStripEngine {

    private OptionStrapStripEngine() {
    }

    public enum Position { STRAP, STRIP }

    public record Result(
        double breakevenUpper,
        double breakevenLower,
        double maxLoss // = net debit; max profit is unlimited on both variants per the paper
    ) {
    }

    /**
     * @param strike     K, the common ATM strike.
     * @param netDebit   D, total premium paid for all 3 legs.
     * @return null if strike or netDebit is not positive.
     */
    public static Result evaluate(Position position, double strike, double netDebit) {
        if (strike <= 0 || netDebit <= 0) {
            return null;
        }
        double breakevenUpper = position == Position.STRAP ? strike + netDebit / 2.0 : strike + netDebit;
        double breakevenLower = position == Position.STRAP ? strike - netDebit : strike - netDebit / 2.0;
        return new Result(breakevenUpper, breakevenLower, netDebit);
    }
}
