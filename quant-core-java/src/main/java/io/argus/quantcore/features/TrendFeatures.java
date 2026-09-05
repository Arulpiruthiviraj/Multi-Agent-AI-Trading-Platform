package io.argus.quantcore.features;

import io.argus.quantcore.backtest.engine.Bar;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Ported byte-for-byte from src/server/quant/indicators/trend.ts (JMIG-001). SMA/EMA/ATR reuse
 * {@link TechnicalIndicatorsCompat} (matching TechnicalIndicators.ts's calculateSMA/calculateEMA -
 * NOT the existing io.argus.quantcore.indicators.MovingAverages, which mirrors a different TS
 * caller's EMA seeding; see that class's own header comment).
 */
public final class TrendFeatures {
    private TrendFeatures() {
    }

    public record MovingAverageSet(Double sma20, Double sma50, Double sma100, Double sma200,
                                    Double ema9, Double ema20, Double ema50, Double ema200) {
    }

    public record PriceVsMA(double diff, double diffPct, boolean above) {
    }

    public record DmiResult(double plusDI, double minusDI, double adx) {
    }

    /** {@code type} is "high"/"low"; {@code kind} is "HH"/"HL"/"LH"/"LL" or null - mirrors trend.ts's
     *  SwingPointKind union exactly, just as plain strings (no Java enum) to keep JSON fixture
     *  comparison trivial. */
    public record SwingPoint(int index, long timestamp, double price, String type, String kind) {
    }

    public record MarketStructureResult(String trend, String event, Double lastSwingHigh, Double lastSwingLow) {
    }

    public record Result(MovingAverageSet movingAverages, PriceVsMA priceVsSMA20, PriceVsMA priceVsSMA50,
                          PriceVsMA priceVsSMA200, Double sma50SlopePct, DmiResult dmi,
                          MarketStructureResult structure) {
    }

    /** Null (not 0) when there isn't enough real history for a given period - matches trend.ts's
     *  own contract exactly. */
    public static MovingAverageSet movingAverageSet(double[] closes) {
        return new MovingAverageSet(
            closes.length >= 20 ? TechnicalIndicatorsCompat.sma(closes, 20) : null,
            closes.length >= 50 ? TechnicalIndicatorsCompat.sma(closes, 50) : null,
            closes.length >= 100 ? TechnicalIndicatorsCompat.sma(closes, 100) : null,
            closes.length >= 200 ? TechnicalIndicatorsCompat.sma(closes, 200) : null,
            closes.length >= 9 ? TechnicalIndicatorsCompat.ema(closes, 9) : null,
            closes.length >= 20 ? TechnicalIndicatorsCompat.ema(closes, 20) : null,
            closes.length >= 50 ? TechnicalIndicatorsCompat.ema(closes, 50) : null,
            closes.length >= 200 ? TechnicalIndicatorsCompat.ema(closes, 200) : null
        );
    }

    public static Double maSlopePct(double[] closes, int period, int lookbackBars, boolean useEma) {
        if (closes.length < period + lookbackBars) {
            return null;
        }
        double now = useEma ? TechnicalIndicatorsCompat.ema(closes, period) : TechnicalIndicatorsCompat.sma(closes, period);
        double[] priorSlice = Arrays.copyOfRange(closes, 0, closes.length - lookbackBars);
        double then = useEma ? TechnicalIndicatorsCompat.ema(priorSlice, period) : TechnicalIndicatorsCompat.sma(priorSlice, period);
        if (then == 0) {
            return null;
        }
        return ((now - then) / then) * 100;
    }

    public static PriceVsMA priceVsMA(double currentPrice, Double maValue) {
        if (maValue == null || maValue == 0) {
            return null;
        }
        double diff = currentPrice - maValue;
        return new PriceVsMA(diff, (diff / maValue) * 100, diff > 0);
    }

    /** Real, properly double-smoothed Wilder ADX/DMI - distinct from the existing
     *  io.argus.quantcore.indicators classes (none port this; trend.ts's own header explains why
     *  it is a new function distinct from TechnicalIndicators.ts's calculateADX). */
    public static DmiResult calculateDMI(double[] highs, double[] lows, double[] closes, int period) {
        if (closes.length < period * 2 + 1) {
            return null;
        }

        int n = highs.length - 1;
        double[] plusDM = new double[n];
        double[] minusDM = new double[n];
        double[] trs = new double[n];
        for (int i = 1; i < highs.length; i++) {
            double upMove = highs[i] - highs[i - 1];
            double downMove = lows[i - 1] - lows[i];
            plusDM[i - 1] = (upMove > downMove && upMove > 0) ? upMove : 0;
            minusDM[i - 1] = (downMove > upMove && downMove > 0) ? downMove : 0;
            double hl = highs[i] - lows[i];
            double hc = Math.abs(highs[i] - closes[i - 1]);
            double lc = Math.abs(lows[i] - closes[i - 1]);
            trs[i - 1] = Math.max(hl, Math.max(hc, lc));
        }

        double[] smoothTR = wilderSmooth(trs, period);
        double[] smoothPlusDM = wilderSmooth(plusDM, period);
        double[] smoothMinusDM = wilderSmooth(minusDM, period);

        double[] dxSeries = new double[smoothTR.length];
        for (int i = 0; i < smoothTR.length; i++) {
            if (smoothTR[i] == 0) {
                dxSeries[i] = 0;
                continue;
            }
            double plusDI = 100 * (smoothPlusDM[i] / smoothTR[i]);
            double minusDI = 100 * (smoothMinusDM[i] / smoothTR[i]);
            double sum = plusDI + minusDI;
            dxSeries[i] = sum == 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100;
        }
        if (dxSeries.length < period) {
            return null;
        }

        double adx = 0;
        for (int i = 0; i < period; i++) {
            adx += dxSeries[i];
        }
        adx /= period;
        for (int i = period; i < dxSeries.length; i++) {
            adx = ((adx * (period - 1)) + dxSeries[i]) / period;
        }

        double lastTR = smoothTR[smoothTR.length - 1];
        double plusDI = lastTR == 0 ? 0 : 100 * (smoothPlusDM[smoothPlusDM.length - 1] / lastTR);
        double minusDI = lastTR == 0 ? 0 : 100 * (smoothMinusDM[smoothMinusDM.length - 1] / lastTR);

        return new DmiResult(plusDI, minusDI, adx);
    }

    private static double[] wilderSmooth(double[] series, int period) {
        List<Double> out = new ArrayList<>();
        double first = 0;
        for (int i = 0; i < period; i++) {
            first += series[i];
        }
        out.add(first);
        for (int i = period; i < series.length; i++) {
            out.add(out.get(out.size() - 1) - out.get(out.size() - 1) / period + series[i]);
        }
        double[] arr = new double[out.size()];
        for (int i = 0; i < arr.length; i++) {
            arr[i] = out.get(i);
        }
        return arr;
    }

    /** Real fractal swing-point detection - bar i is a swing high if its high strictly exceeds
     *  every OTHER bar's high within {@code lookback} bars on both sides (the uniqueness count
     *  check matches trend.ts's own {@code windowHighs.filter(...).length === 1} exactly). */
    public static List<SwingPoint> detectSwingPoints(List<Bar> bars, int lookback) {
        List<SwingPoint> points = new ArrayList<>();
        Double lastHigh = null;
        Double lastLow = null;

        for (int i = lookback; i < bars.size() - lookback; i++) {
            double windowHigh = Double.NEGATIVE_INFINITY;
            double windowLow = Double.POSITIVE_INFINITY;
            for (int k = i - lookback; k <= i + lookback; k++) {
                windowHigh = Math.max(windowHigh, bars.get(k).high());
                windowLow = Math.min(windowLow, bars.get(k).low());
            }
            int highCount = 0;
            int lowCount = 0;
            for (int k = i - lookback; k <= i + lookback; k++) {
                if (bars.get(k).high() == windowHigh) {
                    highCount++;
                }
                if (bars.get(k).low() == windowLow) {
                    lowCount++;
                }
            }
            if (bars.get(i).high() == windowHigh && highCount == 1) {
                String kind = lastHigh == null ? null : (bars.get(i).high() > lastHigh ? "HH" : "LH");
                points.add(new SwingPoint(i, bars.get(i).timestampMs(), bars.get(i).high(), "high", kind));
                lastHigh = bars.get(i).high();
            } else if (bars.get(i).low() == windowLow && lowCount == 1) {
                String kind = lastLow == null ? null : (bars.get(i).low() > lastLow ? "HL" : "LL");
                points.add(new SwingPoint(i, bars.get(i).timestampMs(), bars.get(i).low(), "low", kind));
                lastLow = bars.get(i).low();
            }
        }
        return points;
    }

    public static MarketStructureResult detectMarketStructure(List<Bar> bars, int lookback) {
        List<SwingPoint> swings = detectSwingPoints(bars, lookback);
        List<SwingPoint> highs = swings.stream().filter(sp -> "high".equals(sp.type())).toList();
        List<SwingPoint> lows = swings.stream().filter(sp -> "low".equals(sp.type())).toList();
        SwingPoint lastHigh = highs.isEmpty() ? null : highs.get(highs.size() - 1);
        SwingPoint lastLow = lows.isEmpty() ? null : lows.get(lows.size() - 1);

        List<String> recentHighKinds = lastN(highs, 2).stream().map(SwingPoint::kind).toList();
        List<String> recentLowKinds = lastN(lows, 2).stream().map(SwingPoint::kind).toList();
        boolean isUp = recentHighKinds.stream().allMatch(k -> "HH".equals(k))
            && recentLowKinds.stream().allMatch(k -> "HL".equals(k))
            && !recentHighKinds.isEmpty() && !recentLowKinds.isEmpty();
        boolean isDown = recentHighKinds.stream().allMatch(k -> "LH".equals(k))
            && recentLowKinds.stream().allMatch(k -> "LL".equals(k))
            && !recentHighKinds.isEmpty() && !recentLowKinds.isEmpty();
        String trend = isUp ? "UPTREND" : isDown ? "DOWNTREND" : "SIDEWAYS";

        Double lastClose = bars.isEmpty() ? null : bars.get(bars.size() - 1).close();
        String event = "NONE";
        if (lastClose != null) {
            if ("UPTREND".equals(trend)) {
                if (lastHigh != null && lastClose > lastHigh.price()) {
                    event = "BOS_BULLISH";
                } else if (lastLow != null && lastClose < lastLow.price()) {
                    event = "CHOCH_BEARISH";
                }
            } else if ("DOWNTREND".equals(trend)) {
                if (lastLow != null && lastClose < lastLow.price()) {
                    event = "BOS_BEARISH";
                } else if (lastHigh != null && lastClose > lastHigh.price()) {
                    event = "CHOCH_BULLISH";
                }
            }
        }
        return new MarketStructureResult(trend, event,
            lastHigh != null ? lastHigh.price() : null,
            lastLow != null ? lastLow.price() : null);
    }

    private static <T> List<T> lastN(List<T> list, int n) {
        return list.subList(Math.max(0, list.size() - n), list.size());
    }

    /** Single entry point most callers (RegimeEngine, StrategyEngine, QuantSignalAgent) use in the
     *  TS original - assembles every trend feature above from one real bar array. */
    public static Result computeTrendFeatures(List<Bar> bars) {
        double[] closes = bars.stream().mapToDouble(Bar::close).toArray();
        double[] highs = bars.stream().mapToDouble(Bar::high).toArray();
        double[] lows = bars.stream().mapToDouble(Bar::low).toArray();
        double currentPrice = closes.length > 0 ? closes[closes.length - 1] : 0;
        MovingAverageSet mas = movingAverageSet(closes);

        return new Result(
            mas,
            priceVsMA(currentPrice, mas.sma20()),
            priceVsMA(currentPrice, mas.sma50()),
            priceVsMA(currentPrice, mas.sma200()),
            maSlopePct(closes, 50, 10, false),
            calculateDMI(highs, lows, closes, 14),
            detectMarketStructure(bars, 2)
        );
    }
}
