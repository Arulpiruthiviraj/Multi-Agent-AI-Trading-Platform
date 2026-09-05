package io.argus.quantcore.institutional.models;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.stats.RollingStatistics;

import java.util.Arrays;

/**
 * 5-factor composite alpha score, each factor itself a Z-score so the composite is directly
 * comparable across symbols. All 5 factors are derived purely from OHLCV bars - this codebase
 * has no L2/order-book data source (CLAUDE.md's NOT_SUPPORTED list: L2, volume profile, DOM/CVD
 * are explicitly not available; the live UI shows "L2 Depth Data Unavailable" rather than a fake
 * ladder). The "order-flow / microstructure" factor here is therefore a disclosed OHLC-derived
 * proxy (Close Location Value - where within the bar's range the close printed), not real
 * order-flow or L2 data - it must never be described as one.
 *
 * Factors:
 * <ol>
 *   <li>Momentum - Z-scored trailing N-day return against its own trailing distribution.</li>
 *   <li>Mean-reversion - negative Z-score of price vs its short SMA (oversold -&gt; positive contribution).</li>
 *   <li>Volume/liquidity - Z-score of latest volume vs trailing average volume.</li>
 *   <li>Volatility - negative Z-score of realized volatility (lower-vol tilt; a disclosed convention, not the only valid one).</li>
 *   <li>Order-flow proxy (OHLC-derived, not L2) - Z-score of rolling Close Location Value.</li>
 * </ol>
 */
public final class FactorAlphaEngine {

    public record FactorScores(
        double momentum,
        double meanReversion,
        double volumeLiquidity,
        double volatility,
        double orderFlowProxy,
        double composite
    ) {
    }

    private FactorAlphaEngine() {
    }

    /**
     * @param bars           chronological OHLCV bars, oldest first.
     * @param momentumDays   lookback for the momentum return (e.g. 20).
     * @param smaWindow      short SMA window for the mean-reversion factor (e.g. 10).
     * @param zScoreWindow   window used for every internal Z-score computation (e.g. 60).
     * @return null if there isn't enough history for the requested windows.
     */
    public static FactorScores compute(Bar[] bars, int momentumDays, int smaWindow, int zScoreWindow) {
        int n = bars.length;
        int minRequired = Math.max(momentumDays, Math.max(smaWindow, zScoreWindow)) + zScoreWindow;
        if (n < minRequired) {
            return null;
        }

        double[] close = closes(bars);
        double[] volume = volumes(bars);

        double[] nDayReturns = trailingReturns(close, momentumDays);
        Double momentumZ = RollingStatistics.zScore(nDayReturns, zScoreWindow);

        double[] priceVsSma = priceVsSmaSeries(close, smaWindow);
        Double meanReversionRaw = RollingStatistics.zScore(priceVsSma, zScoreWindow);

        Double volumeZ = RollingStatistics.zScore(volume, zScoreWindow);

        double[] dailyReturns = simpleReturns(close);
        double[] rollingVol = rollingVolatilitySeries(dailyReturns, smaWindow);
        Double volatilityRaw = RollingStatistics.zScore(rollingVol, zScoreWindow);

        double[] clv = closeLocationValueSeries(bars);
        double[] clvSmoothed = movingAverageSeries(clv, smaWindow);
        Double orderFlowZ = RollingStatistics.zScore(clvSmoothed, zScoreWindow);

        if (momentumZ == null || meanReversionRaw == null || volumeZ == null || volatilityRaw == null || orderFlowZ == null) {
            return null;
        }

        double meanReversionZ = -meanReversionRaw;
        double volatilityZ = -volatilityRaw;

        double composite = (momentumZ + meanReversionZ + volumeZ + volatilityZ + orderFlowZ) / 5.0;

        return new FactorScores(momentumZ, meanReversionZ, volumeZ, volatilityZ, orderFlowZ, composite);
    }

    private static double[] closes(Bar[] bars) {
        double[] out = new double[bars.length];
        for (int i = 0; i < bars.length; i++) out[i] = bars[i].close();
        return out;
    }

    private static double[] volumes(Bar[] bars) {
        double[] out = new double[bars.length];
        for (int i = 0; i < bars.length; i++) out[i] = bars[i].volume();
        return out;
    }

    private static double[] simpleReturns(double[] close) {
        double[] out = new double[close.length - 1];
        for (int i = 1; i < close.length; i++) {
            out[i - 1] = close[i - 1] == 0 ? 0 : (close[i] - close[i - 1]) / close[i - 1];
        }
        return out;
    }

    private static double[] trailingReturns(double[] close, int days) {
        int n = close.length;
        double[] out = new double[n - days];
        for (int i = days; i < n; i++) {
            out[i - days] = close[i - days] == 0 ? 0 : (close[i] - close[i - days]) / close[i - days];
        }
        return out;
    }

    private static double[] priceVsSmaSeries(double[] close, int window) {
        int n = close.length;
        double[] out = new double[n - window + 1];
        for (int i = window - 1; i < n; i++) {
            double sma = mean(Arrays.copyOfRange(close, i - window + 1, i + 1));
            out[i - window + 1] = sma == 0 ? 0 : (close[i] - sma) / sma;
        }
        return out;
    }

    private static double[] rollingVolatilitySeries(double[] returns, int window) {
        int n = returns.length;
        if (n < window) return new double[0];
        double[] out = new double[n - window + 1];
        for (int i = window - 1; i < n; i++) {
            out[i - window + 1] = stdDev(Arrays.copyOfRange(returns, i - window + 1, i + 1));
        }
        return out;
    }

    private static double[] closeLocationValueSeries(Bar[] bars) {
        double[] out = new double[bars.length];
        for (int i = 0; i < bars.length; i++) {
            double range = bars[i].high() - bars[i].low();
            out[i] = range < 1e-12 ? 0 : ((bars[i].close() - bars[i].low()) - (bars[i].high() - bars[i].close())) / range;
        }
        return out;
    }

    private static double[] movingAverageSeries(double[] series, int window) {
        int n = series.length;
        if (n < window) return new double[0];
        double[] out = new double[n - window + 1];
        for (int i = window - 1; i < n; i++) {
            out[i - window + 1] = mean(Arrays.copyOfRange(series, i - window + 1, i + 1));
        }
        return out;
    }

    private static double mean(double[] values) {
        double s = 0;
        for (double v : values) s += v;
        return s / values.length;
    }

    private static double stdDev(double[] values) {
        double m = mean(values);
        double s = 0;
        for (double v : values) s += (v - m) * (v - m);
        return Math.sqrt(s / values.length);
    }
}
