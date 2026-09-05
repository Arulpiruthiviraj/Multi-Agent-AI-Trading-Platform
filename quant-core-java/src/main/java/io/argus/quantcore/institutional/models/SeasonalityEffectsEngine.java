package io.argus.quantcore.institutional.models;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.DayOfWeek;
import java.time.YearMonth;
import java.util.EnumMap;
import java.util.Map;

/**
 * Calendar seasonality effects computed from real historical (timestamp, return) pairs - day-of-
 * week and turn-of-month averages only. Scope note (honest, not fabricated): intraday
 * open/close-window effects and holiday-specific effects need intraday-bar granularity and a real
 * market-holiday calendar respectively, neither of which this daily-bar-oriented engine has - they
 * are deliberately NOT implemented here rather than approximated.
 */
public final class SeasonalityEffectsEngine {

    private SeasonalityEffectsEngine() {
    }

    public record Result(
        Map<DayOfWeek, Double> avgReturnByDayOfWeek,
        Map<DayOfWeek, Integer> sampleCountByDayOfWeek,
        Double turnOfMonthAvgReturn,
        Double restOfMonthAvgReturn,
        int turnOfMonthSampleCount,
        int restOfMonthSampleCount
    ) {
    }

    /**
     * @param timestampsMs   epoch-millis for each bar's close, chronological, aligned with returns
     *                       (returns[i] is the return realized ON bar i, i.e. close[i] vs close[i-1]).
     * @param returns        simple returns, same length as timestampsMs.
     * @param zone           the market's real trading-calendar zone (e.g. America/New_York) - never
     *                       assumed/hardcoded by this engine, since the caller owns that context.
     * @param turnOfMonthDays how many calendar days counts as "turn of month" at each end of the
     *                        month (e.g. 3 -> last 3 + first 3 calendar days of the month).
     */
    public static Result evaluate(long[] timestampsMs, double[] returns, ZoneId zone, int turnOfMonthDays) {
        int n = returns.length;
        if (timestampsMs.length != n || n == 0 || turnOfMonthDays < 0) {
            return null;
        }

        Map<DayOfWeek, Double> sumByDay = new EnumMap<>(DayOfWeek.class);
        Map<DayOfWeek, Integer> countByDay = new EnumMap<>(DayOfWeek.class);
        double turnSum = 0, restSum = 0;
        int turnCount = 0, restCount = 0;

        for (int i = 0; i < n; i++) {
            LocalDate date = Instant.ofEpochMilli(timestampsMs[i]).atZone(zone).toLocalDate();
            DayOfWeek dow = date.getDayOfWeek();
            sumByDay.merge(dow, returns[i], Double::sum);
            countByDay.merge(dow, 1, Integer::sum);

            YearMonth ym = YearMonth.from(date);
            int day = date.getDayOfMonth();
            int daysInMonth = ym.lengthOfMonth();
            boolean isTurnOfMonth = day <= turnOfMonthDays || day > daysInMonth - turnOfMonthDays;
            if (isTurnOfMonth) {
                turnSum += returns[i];
                turnCount++;
            } else {
                restSum += returns[i];
                restCount++;
            }
        }

        Map<DayOfWeek, Double> avgByDay = new EnumMap<>(DayOfWeek.class);
        for (Map.Entry<DayOfWeek, Double> e : sumByDay.entrySet()) {
            avgByDay.put(e.getKey(), e.getValue() / countByDay.get(e.getKey()));
        }

        Double turnAvg = turnCount > 0 ? turnSum / turnCount : null;
        Double restAvg = restCount > 0 ? restSum / restCount : null;

        return new Result(avgByDay, countByDay, turnAvg, restAvg, turnCount, restCount);
    }
}
