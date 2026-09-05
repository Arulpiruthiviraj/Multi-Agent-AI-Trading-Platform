package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.ZoneId;

import static org.assertj.core.api.Assertions.assertThat;

class SeasonalityEffectsEngineTest {

    private static long epochMs(LocalDate date) {
        return date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
    }

    @Test
    void computesARealAverageReturnPerDayOfWeek() {
        // Two full weeks (business days only), Monday always +1%, every other day 0%.
        LocalDate d = LocalDate.of(2026, 1, 5); // a Monday
        long[] timestamps = new long[10];
        double[] returns = new double[10];
        int idx = 0;
        for (int week = 0; week < 2; week++) {
            for (int dow = 0; dow < 5; dow++) {
                LocalDate date = d.plusDays(week * 7L + dow);
                timestamps[idx] = epochMs(date);
                returns[idx] = dow == 0 ? 0.01 : 0.0;
                idx++;
            }
        }

        var result = SeasonalityEffectsEngine.evaluate(timestamps, returns, ZoneOffset.UTC, 3);
        assertThat(result).isNotNull();
        assertThat(result.avgReturnByDayOfWeek().get(DayOfWeek.MONDAY)).isEqualTo(0.01);
        assertThat(result.avgReturnByDayOfWeek().get(DayOfWeek.TUESDAY)).isEqualTo(0.0);
        assertThat(result.sampleCountByDayOfWeek().get(DayOfWeek.MONDAY)).isEqualTo(2);
    }

    @Test
    void separatesTurnOfMonthReturnsFromRestOfMonthReturns() {
        // January has 31 days: day 1-3 and 29-31 are "turn of month" at turnOfMonthDays=3.
        long[] timestamps = new long[31];
        double[] returns = new double[31];
        for (int day = 1; day <= 31; day++) {
            LocalDate date = LocalDate.of(2026, 1, day);
            timestamps[day - 1] = epochMs(date);
            boolean isTurn = day <= 3 || day > 28;
            returns[day - 1] = isTurn ? 0.02 : -0.01;
        }

        var result = SeasonalityEffectsEngine.evaluate(timestamps, returns, ZoneOffset.UTC, 3);
        assertThat(result.turnOfMonthAvgReturn()).isCloseTo(0.02, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(result.restOfMonthAvgReturn()).isCloseTo(-0.01, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(result.turnOfMonthSampleCount()).isEqualTo(6); // days 1,2,3,29,30,31
        assertThat(result.restOfMonthSampleCount()).isEqualTo(25);
    }

    @Test
    void returnsNullOnMismatchedArrayLengthsRatherThanFabricating() {
        long[] timestamps = { 0L, 1L };
        double[] returns = { 0.01 };
        assertThat(SeasonalityEffectsEngine.evaluate(timestamps, returns, ZoneId.of("America/New_York"), 3)).isNull();
    }
}
