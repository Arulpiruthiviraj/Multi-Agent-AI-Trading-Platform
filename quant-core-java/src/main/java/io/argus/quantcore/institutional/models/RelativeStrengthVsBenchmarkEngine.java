package io.argus.quantcore.institutional.models;

/**
 * Stock-vs-benchmark relative strength: a stock genuinely outperforming a broad index (e.g. SPY)
 * over a trailing window, not just moving up in absolute terms, is the standard relative-strength
 * reading - formalized academically inside the cross-sectional momentum literature (Jegadeesh &amp;
 * Titman, "Returns to Buying Winners and Selling Losers," J. Finance 1993) though the raw
 * stock-vs-benchmark spread itself (rather than a full cross-sectional rank) is the simpler,
 * single-symbol-computable form of the idea, distinct from CrossSectionalRankingEngine.java's own
 * scope (a real multi-name ranking, out of scope for one stock and one benchmark).
 */
public final class RelativeStrengthVsBenchmarkEngine {

    private RelativeStrengthVsBenchmarkEngine() {
    }

    public record Result(
        double stockReturn,
        double benchmarkReturn,
        double relativeStrength, // stockReturn - benchmarkReturn
        String signal // BUY (outperforming), SELL (underperforming), NEUTRAL (exactly equal)
    ) {
    }

    /**
     * @param stockCloses     chronological stock closes.
     * @param benchmarkCloses chronological benchmark closes, same length/alignment as stockCloses.
     * @param window          trailing window in bars (e.g. 60 for ~1 quarter of daily bars).
     * @return null if there isn't enough history, or either series' starting price is zero.
     */
    public static Result evaluate(double[] stockCloses, double[] benchmarkCloses, int window) {
        int n = stockCloses.length;
        if (benchmarkCloses.length != n || window < 1 || n <= window) {
            return null;
        }
        double stockStart = stockCloses[n - 1 - window];
        double stockEnd = stockCloses[n - 1];
        double benchStart = benchmarkCloses[n - 1 - window];
        double benchEnd = benchmarkCloses[n - 1];
        if (stockStart == 0 || benchStart == 0) {
            return null;
        }
        double stockReturn = (stockEnd - stockStart) / stockStart;
        double benchmarkReturn = (benchEnd - benchStart) / benchStart;
        double relativeStrength = stockReturn - benchmarkReturn;
        String signal = relativeStrength > 0 ? "BUY" : relativeStrength < 0 ? "SELL" : "NEUTRAL";

        return new Result(stockReturn, benchmarkReturn, relativeStrength, signal);
    }
}
