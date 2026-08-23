package io.argus.quantcore.indicators;

/**
 * Wilder's smoothed RSI, ported byte-for-byte from src/server/engines/RSIEngine.ts's
 * {@code calculate()} so Java and TypeScript agree on the same price history to within
 * floating-point epsilon.
 */
public final class RSI {
    private final int period;

    public RSI(int period) {
        this.period = period;
    }

    public RSI() {
        this(14);
    }

    /** Returns 50 (neutral) when there isn't enough history yet, matching the TS default. */
    public double calculate(double[] prices) {
        if (prices.length <= period) {
            return 50;
        }

        double avgGain = 0;
        double avgLoss = 0;

        for (int i = 1; i <= period; i++) {
            double diff = prices[i] - prices[i - 1];
            if (diff > 0) {
                avgGain += diff;
            } else {
                avgLoss += Math.abs(diff);
            }
        }
        avgGain /= period;
        avgLoss /= period;

        for (int i = period + 1; i < prices.length; i++) {
            double diff = prices[i] - prices[i - 1];
            double currentGain = diff > 0 ? diff : 0;
            double currentLoss = diff > 0 ? 0 : Math.abs(diff);
            avgGain = ((avgGain * (period - 1)) + currentGain) / period;
            avgLoss = ((avgLoss * (period - 1)) + currentLoss) / period;
        }

        if (avgLoss == 0) {
            return 100;
        }
        double rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }
}
