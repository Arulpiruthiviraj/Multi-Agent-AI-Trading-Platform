package io.argus.quantcore.institutional.models;

/**
 * ARGUS Crypto V2 (2026-09-21) - Buy-and-Hold benchmark, used ONLY as a comparison point
 * ("Do not use Buy-and-Hold as a trading strategy. It is a benchmark."), never as a tradable
 * strategy signal and never itself implementing CryptoStrategy.
 */
public final class CryptoBenchmarkComparison {
    private CryptoBenchmarkComparison() {
    }

    public record BuyAndHoldResult(double totalReturn, double annualizedReturn) {
    }

    public static BuyAndHoldResult buyAndHold(double[] closes, int periodsPerYear) {
        if (closes.length < 2 || closes[0] <= 0) {
            return new BuyAndHoldResult(Double.NaN, Double.NaN);
        }
        double totalReturn = (closes[closes.length - 1] - closes[0]) / closes[0];
        double years = (closes.length - 1) / (double) periodsPerYear;
        double annualizedReturn = years > 0 ? Math.pow(1 + totalReturn, 1.0 / years) - 1 : Double.NaN;
        return new BuyAndHoldResult(totalReturn, annualizedReturn);
    }
}
