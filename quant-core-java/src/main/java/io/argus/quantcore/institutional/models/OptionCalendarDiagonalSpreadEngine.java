package io.argus.quantcore.institutional.models;

/**
 * Calendar and Diagonal call/put spreads - Kakushadze &amp; Serur, "151 Trading Strategies" (2018),
 * Sections 2.18-2.21, Eq. 73-80. The paper's own formula (Pmax = V - D, Lmax = D) needs V, "the
 * value of the long [longer-dated] option assuming the stock price equals the short leg's strike
 * at the short leg's expiration" - a quantity the paper explicitly does not derive, since it
 * depends on the volatility environment at that future date. This was the reason these four
 * strategies were skipped earlier in this session (no pricing model existed yet in this codebase).
 * Now that BlackScholesEngine exists, V is computed directly via Black-Scholes, using a
 * caller-supplied volatility ASSUMPTION for that remaining period - the paper's own uncertainty
 * about V is not resolved by this addition, only made computable given an explicit vol estimate,
 * exactly as honest as every other engine in this catalog that requires a caller-supplied market
 * input rather than fabricating one.
 */
public final class OptionCalendarDiagonalSpreadEngine {

    private OptionCalendarDiagonalSpreadEngine() {
    }

    public record Result(
        double longLegValueAtShortExpiry, // V
        double maxProfit,                 // V - netDebit
        double maxLoss                    // = netDebit
    ) {
    }

    /**
     * Calendar Call Spread (Sec 2.18): long call at strike K expiring T', short call at the SAME
     * strike K expiring at the sooner T. V is the long call's Black-Scholes value at t=T assuming
     * the stock is exactly at K then, with remainingYearsAfterShortExpiry = T'-T left to run.
     *
     * @return null if netDebit is not positive, or the underlying Black-Scholes call is undefined
     *         for the supplied inputs (see BlackScholesEngine's own contract).
     */
    public static Result calendarCallSpread(double strike, double remainingYearsAfterShortExpiry, double riskFreeRate,
                                             double dividendYield, double volatilityForRemainingPeriod, double netDebit) {
        if (netDebit <= 0) {
            return null;
        }
        var bs = BlackScholesEngine.call(strike, strike, riskFreeRate, dividendYield, volatilityForRemainingPeriod, remainingYearsAfterShortExpiry);
        if (bs == null) {
            return null;
        }
        return new Result(bs.price(), bs.price() - netDebit, netDebit);
    }

    /** Calendar Put Spread (Sec 2.19): same construction/formula with puts. */
    public static Result calendarPutSpread(double strike, double remainingYearsAfterShortExpiry, double riskFreeRate,
                                            double dividendYield, double volatilityForRemainingPeriod, double netDebit) {
        if (netDebit <= 0) {
            return null;
        }
        var bs = BlackScholesEngine.put(strike, strike, riskFreeRate, dividendYield, volatilityForRemainingPeriod, remainingYearsAfterShortExpiry);
        if (bs == null) {
            return null;
        }
        return new Result(bs.price(), bs.price() - netDebit, netDebit);
    }

    /**
     * Diagonal Call Spread (Sec 2.20): long DEEP ITM call at strike K1 expiring T', short OTM
     * call at a HIGHER strike K2 expiring at the sooner T. V is the long call's (strike K1) value
     * at t=T assuming the stock is at K2 then (the short leg's own strike - the best-case scenario,
     * same logic as the calendar spread).
     */
    public static Result diagonalCallSpread(double longCallStrike, double shortCallStrike, double remainingYearsAfterShortExpiry,
                                             double riskFreeRate, double dividendYield, double volatilityForRemainingPeriod, double netDebit) {
        if (netDebit <= 0 || shortCallStrike <= longCallStrike) {
            return null;
        }
        var bs = BlackScholesEngine.call(shortCallStrike, longCallStrike, riskFreeRate, dividendYield, volatilityForRemainingPeriod, remainingYearsAfterShortExpiry);
        if (bs == null) {
            return null;
        }
        return new Result(bs.price(), bs.price() - netDebit, netDebit);
    }

    /**
     * Diagonal Put Spread (Sec 2.21): long DEEP ITM put at strike K1 expiring T', short OTM put
     * at a LOWER strike K2 expiring at the sooner T. V is the long put's (strike K1) value at t=T
     * assuming the stock is at K2 then.
     */
    public static Result diagonalPutSpread(double longPutStrike, double shortPutStrike, double remainingYearsAfterShortExpiry,
                                            double riskFreeRate, double dividendYield, double volatilityForRemainingPeriod, double netDebit) {
        if (netDebit <= 0 || shortPutStrike >= longPutStrike) {
            return null;
        }
        var bs = BlackScholesEngine.put(shortPutStrike, longPutStrike, riskFreeRate, dividendYield, volatilityForRemainingPeriod, remainingYearsAfterShortExpiry);
        if (bs == null) {
            return null;
        }
        return new Result(bs.price(), bs.price() - netDebit, netDebit);
    }
}
