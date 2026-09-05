package io.argus.quantcore.features;

import io.argus.quantcore.backtest.engine.Bar;

import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Ported byte-for-byte from src/server/quant/indicators/supportResistance.ts (JMIG-001).
 * {@link #groupBarsByUTCDay} is the single real implementation - priceAction.ts's real TS import
 * ({@code import { groupBarsByUTCDay } from './supportResistance'}) is mirrored here by
 * {@link PriceActionFeatures} calling this class's method directly rather than duplicating the
 * grouping logic a second time.
 */
public final class SupportResistanceFeatures {
    private SupportResistanceFeatures() {
    }

    public record Ohlc(double high, double low, double close) {
    }

    /** Mirrors supportResistance.ts's generic {@code AvailabilityTagged<T>} exactly, including the
     *  real nested {@code data} shape (NOT a flattened high/low on the tagged object itself) - the
     *  two real call sites this file has ({@link #openingRange}/{@link #premarketHighLow}) both
     *  tag a {@code {high, low}} range. */
    public record Range(double high, double low) {
    }

    public record AvailableRange(boolean available, String reason, Range data) {
    }

    public record PivotPoints(double pivot, double r1, double r2, double r3, double s1, double s2, double s3) {
    }

    public record LevelDistance(double level, double abs, double pct) {
    }

    public record Nearest(LevelDistance nearestResistance, LevelDistance nearestSupport) {
    }

    public record Result(Ohlc previousDay, Ohlc dailyHighLow, Ohlc weeklyHighLow, PivotPoints pivots,
                          TechnicalIndicatorsCompat.Fibonacci fibonacci, List<TrendFeatures.SwingPoint> recentSwings,
                          Nearest nearest, AvailableRange openingRange, Ohlc priorChannel20) {
    }

    /** Groups bars by their UTC calendar day, preserving chronological order of the groups -
     *  matches supportResistance.ts's groupBarsByUTCDay exactly. */
    public static List<List<Bar>> groupBarsByUTCDay(List<Bar> bars) {
        Map<String, List<Bar>> groups = new LinkedHashMap<>();
        for (Bar b : bars) {
            var z = Instant.ofEpochMilli(b.timestampMs()).atZone(ZoneOffset.UTC);
            String key = z.getYear() + "-" + z.getMonthValue() + "-" + z.getDayOfMonth();
            groups.computeIfAbsent(key, k -> new ArrayList<>()).add(b);
        }
        return new ArrayList<>(groups.values());
    }

    /** The most recently COMPLETED calendar day's high/low/close. Null if fewer than 2 distinct
     *  days exist. */
    public static Ohlc previousDayLevels(List<Bar> bars) {
        List<List<Bar>> days = groupBarsByUTCDay(bars);
        if (days.size() < 2) {
            return null;
        }
        List<Bar> previousDay = days.get(days.size() - 2);
        double high = max(previousDay);
        double low = min(previousDay);
        double close = previousDay.get(previousDay.size() - 1).close();
        return new Ohlc(high, low, close);
    }

    /** True if consecutive bars are ~24h apart (daily-granularity data). */
    static boolean looksDailyGranularity(List<Bar> bars) {
        if (bars.size() < 2) {
            return true;
        }
        List<Double> gaps = new ArrayList<>();
        for (int i = 1; i < Math.min(bars.size(), 6); i++) {
            gaps.add((double) (bars.get(i).timestampMs() - bars.get(i - 1).timestampMs()));
        }
        double sum = 0;
        for (double g : gaps) {
            sum += g;
        }
        double avgGapHours = (sum / gaps.size()) / (60.0 * 60 * 1000);
        return avgGapHours >= 20;
    }

    public static AvailableRange openingRange(List<Bar> bars, int windowMinutes) {
        if (looksDailyGranularity(bars)) {
            return new AvailableRange(false,
                "Only daily-granularity bars available - opening range requires intraday bars.", null);
        }
        List<List<Bar>> days = groupBarsByUTCDay(bars);
        if (days.isEmpty()) {
            return new AvailableRange(false, "No bars.", null);
        }
        List<Bar> currentDay = days.get(days.size() - 1);
        long sessionStart = currentDay.get(0).timestampMs();
        long windowEnd = sessionStart + windowMinutes * 60_000L;
        List<Bar> rangeBars = currentDay.stream().filter(b -> b.timestampMs() <= windowEnd).toList();
        if (rangeBars.isEmpty()) {
            return new AvailableRange(false, "No bars within the opening-range window yet.", null);
        }
        return new AvailableRange(true, null, new Range(max(rangeBars), min(rangeBars)));
    }

    public static AvailableRange premarketHighLow(List<Bar> bars, long regularSessionStartMs) {
        if (looksDailyGranularity(bars)) {
            return new AvailableRange(false,
                "Only daily-granularity bars available - premarket range requires intraday bars.", null);
        }
        List<Bar> premarketBars = bars.stream().filter(b -> b.timestampMs() < regularSessionStartMs).toList();
        if (premarketBars.isEmpty()) {
            return new AvailableRange(false, "No bars before the supplied regular-session-start timestamp.", null);
        }
        return new AvailableRange(true, null, new Range(max(premarketBars), min(premarketBars)));
    }

    public static Ohlc rollingHighLow(List<Bar> bars, int lookback) {
        if (bars.size() < lookback) {
            return null;
        }
        List<Bar> window = bars.subList(bars.size() - lookback, bars.size());
        return new Ohlc(max(window), min(window), window.get(window.size() - 1).close());
    }

    public static Ohlc dailyHighLow(List<Bar> bars, int days) {
        return rollingHighLow(bars, days);
    }

    public static Ohlc weeklyHighLow(List<Bar> bars, int weeks) {
        return rollingHighLow(bars, weeks * 5);
    }

    public static List<TrendFeatures.SwingPoint> swingHighsLows(List<Bar> bars, int lookback) {
        return TrendFeatures.detectSwingPoints(bars, lookback);
    }

    public static PivotPoints calculatePivotPoints(double prevHigh, double prevLow, double prevClose) {
        double pivot = (prevHigh + prevLow + prevClose) / 3;
        double range = prevHigh - prevLow;
        return new PivotPoints(pivot,
            2 * pivot - prevLow, pivot + range, prevHigh + 2 * (pivot - prevLow),
            2 * pivot - prevHigh, pivot - range, prevLow - 2 * (prevHigh - pivot));
    }

    public static LevelDistance distanceToLevel(double currentPrice, Double level) {
        if (level == null || level == 0) {
            return null;
        }
        double abs = currentPrice - level;
        return new LevelDistance(level, abs, (abs / level) * 100);
    }

    public static Nearest nearestSupportResistance(double currentPrice, double[] candidateLevels) {
        List<Double> above = new ArrayList<>();
        List<Double> below = new ArrayList<>();
        for (double l : candidateLevels) {
            if (l > currentPrice) {
                above.add(l);
            } else if (l < currentPrice) {
                below.add(l);
            }
        }
        above.sort(Double::compareTo);
        below.sort((a, b) -> Double.compare(b, a));
        LevelDistance resistance = above.isEmpty() ? null : distanceToLevel(currentPrice, above.get(0));
        LevelDistance support = below.isEmpty() ? null : distanceToLevel(currentPrice, below.get(0));
        return new Nearest(resistance, support);
    }

    public static Result computeSupportResistanceFeatures(List<Bar> bars) {
        double currentPrice = bars.isEmpty() ? 0 : bars.get(bars.size() - 1).close();
        Ohlc prevDay = previousDayLevels(bars);
        int lookback = FeatureThresholds.DONCHIAN_PRIOR_LOOKBACK;
        Ohlc daily = dailyHighLow(bars, lookback);
        Ohlc weekly = weeklyHighLow(bars, 4);
        PivotPoints pivots = prevDay != null ? calculatePivotPoints(prevDay.high(), prevDay.low(), prevDay.close()) : null;
        TechnicalIndicatorsCompat.Fibonacci fibonacci = daily != null
            ? TechnicalIndicatorsCompat.fibonacciRetracement(daily.high(), daily.low()) : null;
        List<TrendFeatures.SwingPoint> allSwings = swingHighsLows(bars, 2);
        List<TrendFeatures.SwingPoint> swings = allSwings.subList(Math.max(0, allSwings.size() - 10), allSwings.size());
        int orWindow = FeatureThresholds.OPENING_RANGE_WINDOW_MINUTES;
        List<Bar> priorBars = bars.size() > 1 ? bars.subList(0, bars.size() - 1) : List.of();

        List<Double> candidateLevels = new ArrayList<>();
        if (prevDay != null) {
            candidateLevels.add(prevDay.high());
            candidateLevels.add(prevDay.low());
        }
        if (pivots != null) {
            candidateLevels.add(pivots.r1());
            candidateLevels.add(pivots.r2());
            candidateLevels.add(pivots.s1());
            candidateLevels.add(pivots.s2());
        }
        for (TrendFeatures.SwingPoint s : swings) {
            candidateLevels.add(s.price());
        }
        double[] candArr = new double[candidateLevels.size()];
        for (int i = 0; i < candArr.length; i++) {
            candArr[i] = candidateLevels.get(i);
        }

        return new Result(
            prevDay, daily, weekly, pivots, fibonacci, swings,
            nearestSupportResistance(currentPrice, candArr),
            openingRange(bars, orWindow),
            rollingHighLow(priorBars, lookback)
        );
    }

    private static double max(List<Bar> bars) {
        double m = Double.NEGATIVE_INFINITY;
        for (Bar b : bars) {
            m = Math.max(m, b.high());
        }
        return m;
    }

    private static double min(List<Bar> bars) {
        double m = Double.POSITIVE_INFINITY;
        for (Bar b : bars) {
            m = Math.min(m, b.low());
        }
        return m;
    }
}
