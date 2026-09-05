package io.argus.quantcore.features;

import io.argus.quantcore.backtest.engine.Bar;

import java.util.Arrays;
import java.util.List;

/**
 * Ported byte-for-byte from src/server/quant/indicators/priceAction.ts (JMIG-001).
 * {@link #detectGap} calls {@link SupportResistanceFeatures#groupBarsByUTCDay} directly, mirroring
 * priceAction.ts's own real import ({@code import { groupBarsByUTCDay } from './supportResistance'})
 * rather than duplicating the day-grouping logic in this class too.
 */
public final class PriceActionFeatures {
    private PriceActionFeatures() {
    }

    public record GapResult(String type, Double sizePct) {
    }

    public record Result(GapResult gap, boolean consolidating, String rangeRegime, String candlestick) {
    }

    /** Real gap detection: today's session open vs. the prior session's close, grouped by real
     *  UTC calendar day. &gt;0.5% (default threshold) is flagged as a real gap. */
    public static GapResult detectGap(List<Bar> bars, double thresholdPct) {
        List<List<Bar>> days = SupportResistanceFeatures.groupBarsByUTCDay(bars);
        if (days.size() < 2) {
            return new GapResult(null, null);
        }
        List<Bar> priorDay = days.get(days.size() - 2);
        List<Bar> today = days.get(days.size() - 1);
        double priorClose = priorDay.get(priorDay.size() - 1).close();
        double todayOpen = today.get(0).open();
        if (priorClose == 0) {
            return new GapResult(null, null);
        }
        double sizePct = ((todayOpen - priorClose) / priorClose) * 100;
        if (Math.abs(sizePct) < thresholdPct) {
            return new GapResult(null, sizePct);
        }
        return new GapResult(sizePct > 0 ? "GAP_UP" : "GAP_DOWN", sizePct);
    }

    /** Real range-of-bar-ranges comparison: average (high-low) of the most recent {@code
     *  recentBars} against the average of the {@code priorBars} before them. */
    public static String rangeExpansionContraction(List<Bar> bars, int recentBars, int priorBars) {
        if (bars.size() < recentBars + priorBars) {
            return null;
        }
        double[] ranges = bars.stream().mapToDouble(b -> b.high() - b.low()).toArray();
        double[] recent = Arrays.copyOfRange(ranges, ranges.length - recentBars, ranges.length);
        double[] prior = Arrays.copyOfRange(ranges, ranges.length - (recentBars + priorBars), ranges.length - recentBars);
        double recentAvg = avg(recent);
        double priorAvg = avg(prior);
        if (priorAvg == 0) {
            return "STABLE";
        }
        double changePct = ((recentAvg - priorAvg) / priorAvg) * 100;
        if (changePct > 20) {
            return "EXPANDING";
        }
        if (changePct < -20) {
            return "CONTRACTING";
        }
        return "STABLE";
    }

    /** Real consolidation flag: the trailing {@code period} bars' full high-low range is within
     *  {@code thresholdPct} of the period's average close. */
    public static boolean detectConsolidation(List<Bar> bars, int period, double thresholdPct) {
        if (bars.size() < period) {
            return false;
        }
        List<Bar> window = bars.subList(bars.size() - period, bars.size());
        double high = window.stream().mapToDouble(Bar::high).max().orElse(0);
        double low = window.stream().mapToDouble(Bar::low).min().orElse(0);
        double avgClose = window.stream().mapToDouble(Bar::close).average().orElse(0);
        if (avgClose == 0) {
            return false;
        }
        return ((high - low) / avgClose) * 100 <= thresholdPct;
    }

    /** A small, deterministic set of well-known single/two-bar candlestick patterns, checked in a
     *  fixed priority order (DOJI, HAMMER, SHOOTING_STAR, then the two-bar engulfing patterns) -
     *  matches priceAction.ts's detectCandlestickPattern exactly, including its priority order. */
    public static String detectCandlestickPattern(List<Bar> bars) {
        if (bars.isEmpty()) {
            return null;
        }
        Bar cur = bars.get(bars.size() - 1);
        double body = Math.abs(cur.close() - cur.open());
        double range = cur.high() - cur.low();
        if (range == 0) {
            return null;
        }
        double upperWick = cur.high() - Math.max(cur.open(), cur.close());
        double lowerWick = Math.min(cur.open(), cur.close()) - cur.low();

        if (body / range < 0.1) {
            return "DOJI";
        }
        if (lowerWick > body * 2 && upperWick < body * 0.5) {
            return "HAMMER";
        }
        if (upperWick > body * 2 && lowerWick < body * 0.5) {
            return "SHOOTING_STAR";
        }

        if (bars.size() >= 2) {
            Bar prev = bars.get(bars.size() - 2);
            double prevBody = Math.abs(prev.close() - prev.open());
            if (prevBody > 0) {
                boolean prevBearish = prev.close() < prev.open();
                boolean curBullish = cur.close() > cur.open();
                if (prevBearish && curBullish && cur.open() <= prev.close() && cur.close() >= prev.open()) {
                    return "BULLISH_ENGULFING";
                }
                boolean prevBullish = prev.close() > prev.open();
                boolean curBearish = cur.close() < cur.open();
                if (prevBullish && curBearish && cur.open() >= prev.close() && cur.close() <= prev.open()) {
                    return "BEARISH_ENGULFING";
                }
            }
        }
        return null;
    }

    public static Result computePriceActionFeatures(List<Bar> bars) {
        return new Result(
            detectGap(bars, 0.5),
            detectConsolidation(bars, 10, 3),
            rangeExpansionContraction(bars, 5, 15),
            detectCandlestickPattern(bars)
        );
    }

    private static double avg(double[] arr) {
        double s = 0;
        for (double v : arr) {
            s += v;
        }
        return s / arr.length;
    }
}
