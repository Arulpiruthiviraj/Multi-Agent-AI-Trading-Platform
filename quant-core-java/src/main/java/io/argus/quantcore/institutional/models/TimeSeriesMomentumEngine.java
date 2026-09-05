package io.argus.quantcore.institutional.models;

/**
 * Time-series momentum family (Two-Sigma-style strategy catalog items: time-series momentum,
 * short/medium/long-term momentum, momentum acceleration, trend persistence) - deliberately built
 * as ONE parameterized engine rather than five near-duplicate classes, since each of those is the
 * same real return-over-lookback computation at a different horizon, not an independently
 * validated model. Treating them as five "independent" signals would be exactly the correlated-
 * votes-counted-as-independent mistake this codebase's own quant-activation plan warns against.
 *
 * Pure, stateless, real math only - no fabricated numbers. Every field is either a real computed
 * value or null when there isn't enough data for that horizon (never a guessed default).
 */
public final class TimeSeriesMomentumEngine {

    private TimeSeriesMomentumEngine() {
    }

    public enum Signal { BUY, SELL, NEUTRAL }

    public record HorizonMomentum(int lookbackBars, Double totalReturn) {
    }

    public record Result(
        HorizonMomentum shortTerm,
        HorizonMomentum mediumTerm,
        HorizonMomentum longTerm,
        Double momentumAcceleration,
        Double trendPersistence,
        Signal signal
    ) {
    }

    private static HorizonMomentum horizon(double[] closes, int lookbackBars) {
        int n = closes.length;
        if (lookbackBars < 1 || n <= lookbackBars) {
            return new HorizonMomentum(lookbackBars, null);
        }
        double start = closes[n - 1 - lookbackBars];
        double end = closes[n - 1];
        if (start == 0) {
            return new HorizonMomentum(lookbackBars, null);
        }
        return new HorizonMomentum(lookbackBars, (end - start) / start);
    }

    /** Fraction of up-bars (close > previous close) within the trailing window - real, in [0,1]. */
    private static Double trendPersistence(double[] closes, int window) {
        int n = closes.length;
        if (window < 1 || n <= window) {
            return null;
        }
        int upBars = 0;
        for (int i = n - window; i < n; i++) {
            if (closes[i] > closes[i - 1]) upBars++;
        }
        return upBars / (double) window;
    }

    private static Signal sideOf(Double totalReturn) {
        if (totalReturn == null) return null;
        if (totalReturn > 0) return Signal.BUY;
        if (totalReturn < 0) return Signal.SELL;
        return Signal.NEUTRAL;
    }

    /**
     * @param closes      chronological close prices.
     * @param shortBars   e.g. 20 (roughly one trading month of daily bars).
     * @param mediumBars  e.g. 60 (roughly one quarter).
     * @param longBars    e.g. 252 (roughly one year).
     */
    public static Result evaluate(double[] closes, int shortBars, int mediumBars, int longBars) {
        HorizonMomentum st = horizon(closes, shortBars);
        HorizonMomentum mt = horizon(closes, mediumBars);
        HorizonMomentum lt = horizon(closes, longBars);

        Double acceleration = (st.totalReturn() != null && mt.totalReturn() != null)
            ? st.totalReturn() - mt.totalReturn()
            : null;
        Double persistence = trendPersistence(closes, mediumBars);

        // Majority vote across whichever horizons are actually computable - never invents a side
        // from a horizon with insufficient data.
        int buy = 0, sell = 0, available = 0;
        for (Signal s : new Signal[] { sideOf(st.totalReturn()), sideOf(mt.totalReturn()), sideOf(lt.totalReturn()) }) {
            if (s == null) continue;
            available++;
            if (s == Signal.BUY) buy++;
            else if (s == Signal.SELL) sell++;
        }
        Signal signal;
        if (available < 2) {
            signal = Signal.NEUTRAL;
        } else if (buy > sell && buy >= 2) {
            signal = Signal.BUY;
        } else if (sell > buy && sell >= 2) {
            signal = Signal.SELL;
        } else {
            signal = Signal.NEUTRAL;
        }

        return new Result(st, mt, lt, acceleration, persistence, signal);
    }
}
