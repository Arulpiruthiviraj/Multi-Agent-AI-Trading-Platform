package io.argus.quantcore.institutional.math;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class AugmentedDickeyFullerTest {

    @Test
    void rejectsUnitRootForAStationaryMeanRevertingSeries() {
        // y_t = 0.3*y_{t-1} + e_t -> stationary AR(1), clearly mean-reverting around 0.
        Random rnd = new Random(42);
        int n = 500;
        double[] series = new double[n];
        series[0] = 0;
        for (int t = 1; t < n; t++) {
            series[t] = 0.3 * series[t - 1] + rnd.nextGaussian();
        }
        AugmentedDickeyFuller.Result result = AugmentedDickeyFuller.test(series, 1);
        assertThat(result).isNotNull();
        assertThat(result.isStationaryAt5Pct()).isTrue();
        assertThat(result.testStatistic()).isLessThan(result.criticalValue5Pct());
    }

    @Test
    void failsToRejectUnitRootForARandomWalk() {
        Random rnd = new Random(42);
        int n = 500;
        double[] series = new double[n];
        series[0] = 0;
        for (int t = 1; t < n; t++) {
            series[t] = series[t - 1] + rnd.nextGaussian(); // pure random walk, unit root
        }
        AugmentedDickeyFuller.Result result = AugmentedDickeyFuller.test(series, 1);
        assertThat(result).isNotNull();
        assertThat(result.isStationaryAt5Pct()).isFalse();
    }

    @Test
    void suggestLagsMatchesSchwertsRule() {
        assertThat(AugmentedDickeyFuller.suggestLags(100)).isEqualTo(12);
        assertThat(AugmentedDickeyFuller.suggestLags(300)).isGreaterThan(12);
    }

    @Test
    void returnsNullForTooShortASeries() {
        double[] tiny = {1, 2, 3};
        assertThat(AugmentedDickeyFuller.test(tiny, 5)).isNull();
    }
}
