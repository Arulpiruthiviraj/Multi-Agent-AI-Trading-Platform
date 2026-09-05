package io.argus.quantcore.features;

import io.argus.quantcore.backtest.engine.Bar;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Ported byte-for-byte from src/server/quant/indicators/volatility.ts (JMIG-001). Class name is
 * deliberately distinct from the existing io.argus.quantcore.indicators.Volatility (ATR-only
 * helper, different package, different scope) - no collision, both are real and used here (this
 * class calls that one via {@link TechnicalIndicatorsCompat#atr}).
 */
public final class VolatilityFeatures {
    private VolatilityFeatures() {
    }

    public record Keltner(double middle, double upper, double lower) {
    }

    public record Result(double atr, Double atrPercent, Double historicalVolatilityPct,
                          Double volatilityPercentile, Double bollingerBandWidthPct, Keltner keltner,
                          String regime, Double closePriceZScore) {
    }

    /** ATR expressed as a % of current price. Null (not fabricated) when there's no real price or
     *  ATR is 0 (not enough history) - matches volatility.ts's `!currentPrice` falsy check, which
     *  in JS is true for both 0 and NaN. */
    public static Double atrPercent(double[] highs, double[] lows, double[] closes, int period) {
        if (closes.length == 0) {
            return null;
        }
        double currentPrice = closes[closes.length - 1];
        if (currentPrice == 0 || Double.isNaN(currentPrice)) {
            return null;
        }
        double atr = TechnicalIndicatorsCompat.atr(highs, lows, closes, period);
        if (atr == 0) {
            return null;
        }
        return (atr / currentPrice) * 100;
    }

    public static Double historicalVolatility(double[] closes, int period, int periodsPerYear) {
        Double vol = StatisticsMath.rollingVolatility(closes, period);
        if (vol == null) {
            return null;
        }
        return vol * Math.sqrt(periodsPerYear) * 100;
    }

    public static Double volatilityPercentile(List<Bar> bars, int lookback, int atrPeriod) {
        if (bars.size() < lookback + atrPeriod) {
            return null;
        }
        double[] highs = highs(bars);
        double[] lows = lows(bars);
        double[] closes = closes(bars);

        List<Double> history = new ArrayList<>();
        int start = bars.size() - lookback;
        for (int i = start; i < bars.size(); i++) {
            Double pct = atrPercent(
                Arrays.copyOfRange(highs, 0, i + 1),
                Arrays.copyOfRange(lows, 0, i + 1),
                Arrays.copyOfRange(closes, 0, i + 1),
                atrPeriod);
            if (pct != null) {
                history.add(pct);
            }
        }
        if (history.isEmpty()) {
            return null;
        }
        double current = history.get(history.size() - 1);
        double[] prior = new double[history.size() - 1];
        for (int i = 0; i < prior.length; i++) {
            prior[i] = history.get(i);
        }
        return StatisticsMath.percentileRank(prior, current);
    }

    public static Double bollingerBandWidth(double[] prices, int period, double stdDev) {
        if (prices.length < period) {
            return null;
        }
        var bb = TechnicalIndicatorsCompat.bollingerBands(prices, period, stdDev);
        if (bb.middle() == 0) {
            return null;
        }
        return ((bb.upper() - bb.lower()) / bb.middle()) * 100;
    }

    /** Real Keltner Channels: EMA(emaPeriod) middle line, ATR(atrPeriod)*multiplier bands. */
    public static Keltner keltnerChannels(double[] highs, double[] lows, double[] closes,
                                           int emaPeriod, int atrPeriod, double multiplier) {
        if (closes.length < Math.max(emaPeriod, atrPeriod + 1)) {
            return null;
        }
        double middle = TechnicalIndicatorsCompat.ema(closes, emaPeriod);
        double atr = TechnicalIndicatorsCompat.atr(highs, lows, closes, atrPeriod);
        return new Keltner(middle, middle + multiplier * atr, middle - multiplier * atr);
    }

    /** Compares the most recent ATR% reading against the average ATR% of the preceding
     *  {@code lookback} bars - real relative comparison, not an arbitrary absolute cutoff. */
    public static String classifyVolatilityRegime(List<Bar> bars, int lookback, int atrPeriod) {
        if (bars.size() < lookback + atrPeriod + 1) {
            return null;
        }
        double[] highs = highs(bars);
        double[] lows = lows(bars);
        double[] closes = closes(bars);

        List<Double> readings = new ArrayList<>();
        for (int i = bars.size() - lookback; i <= bars.size(); i++) {
            Double pct = atrPercent(
                Arrays.copyOfRange(highs, 0, i),
                Arrays.copyOfRange(lows, 0, i),
                Arrays.copyOfRange(closes, 0, i),
                atrPeriod);
            if (pct != null) {
                readings.add(pct);
            }
        }
        if (readings.size() < 2) {
            return null;
        }

        double current = readings.get(readings.size() - 1);
        double priorSum = 0;
        for (int i = 0; i < readings.size() - 1; i++) {
            priorSum += readings.get(i);
        }
        double priorAvg = priorSum / (readings.size() - 1);
        if (priorAvg == 0) {
            return "STABLE";
        }
        double changePct = ((current - priorAvg) / priorAvg) * 100;
        if (changePct > 15) {
            return "EXPANDING";
        }
        if (changePct < -15) {
            return "CONTRACTING";
        }
        return "STABLE";
    }

    public static Result computeVolatilityFeatures(List<Bar> bars) {
        double[] highs = highs(bars);
        double[] lows = lows(bars);
        double[] closes = closes(bars);

        return new Result(
            TechnicalIndicatorsCompat.atr(highs, lows, closes, 14),
            atrPercent(highs, lows, closes, 14),
            historicalVolatility(closes, 20, 252),
            volatilityPercentile(bars, 100, 14),
            bollingerBandWidth(closes, 20, 2),
            keltnerChannels(highs, lows, closes, 20, 10, 2),
            classifyVolatilityRegime(bars, 20, 14),
            StatisticsMath.zScore(closes, FeatureThresholds.CLOSE_PRICE_ZSCORE_LOOKBACK)
        );
    }

    static double[] highs(List<Bar> bars) {
        return bars.stream().mapToDouble(Bar::high).toArray();
    }

    static double[] lows(List<Bar> bars) {
        return bars.stream().mapToDouble(Bar::low).toArray();
    }

    static double[] closes(List<Bar> bars) {
        return bars.stream().mapToDouble(Bar::close).toArray();
    }
}
