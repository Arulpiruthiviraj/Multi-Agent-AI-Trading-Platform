package io.argus.quantcore.indicators;

/**
 * MACD(12,26,9), ported byte-for-byte from src/server/engines/MACDEngine.ts's {@code calculate()}
 * as of its 2026-09-22 seeding fix. Uses {@link MovingAverages#ema} for the same SMA-seeded,
 * backfilled EMA series the TS engine computes (see MovingAverages' own header for the history).
 */
public final class MACD {
    private final int shortPeriod;
    private final int longPeriod;
    private final int signalPeriod;

    public MACD(int shortPeriod, int longPeriod, int signalPeriod) {
        this.shortPeriod = shortPeriod;
        this.longPeriod = longPeriod;
        this.signalPeriod = signalPeriod;
    }

    public MACD() {
        this(12, 26, 9);
    }

    public record Result(double macd, double signal, double histogram) {
    }

    /** Returns all-zero when there isn't a full long-period history yet, matching the TS engine. */
    public Result calculate(double[] prices) {
        if (prices.length < longPeriod) {
            return new Result(0, 0, 0);
        }

        double[] shortEma = MovingAverages.ema(prices, shortPeriod);
        double[] longEma = MovingAverages.ema(prices, longPeriod);

        double[] macdLines = new double[prices.length];
        for (int i = 0; i < prices.length; i++) {
            macdLines[i] = shortEma[i] - longEma[i];
        }

        double[] signalLines = MovingAverages.ema(macdLines, signalPeriod);

        double currentMacd = macdLines[macdLines.length - 1];
        double currentSignal = signalLines[signalLines.length - 1];
        return new Result(currentMacd, currentSignal, currentMacd - currentSignal);
    }
}
