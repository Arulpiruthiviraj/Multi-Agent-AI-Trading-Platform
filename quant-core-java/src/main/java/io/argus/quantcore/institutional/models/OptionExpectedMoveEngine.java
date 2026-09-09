package io.argus.quantcore.institutional.models;

/**
 * Expected move under a simplified lognormal model: ExpectedMove = S0 * IV * sqrt(T). A standard,
 * widely-used options-desk heuristic for translating an implied volatility quote into a dollar
 * range the market is "pricing in" over the remaining life of the option - used to sanity-check
 * whether a strangle/iron-condor's strikes are actually far enough from spot to have a real edge,
 * rather than sitting inside the market's own one-standard-deviation expectation.
 */
public final class OptionExpectedMoveEngine {

    private OptionExpectedMoveEngine() {
    }

    public record Result(
        double expectedMove,
        double upperBound,
        double lowerBound
    ) {
    }

    /**
     * @param spot       S0.
     * @param impliedVolatility annualized IV.
     * @param timeToExpiryYears T, in years.
     * @return null if spot is not positive or timeToExpiryYears is not positive.
     */
    public static Result evaluate(double spot, double impliedVolatility, double timeToExpiryYears) {
        if (spot <= 0 || timeToExpiryYears <= 0) {
            return null;
        }
        double move = spot * impliedVolatility * Math.sqrt(timeToExpiryYears);
        return new Result(move, spot + move, spot - move);
    }
}
