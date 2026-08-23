package io.argus.quantcore.stats;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Expected values captured by running the real src/server/quant/statistics.ts against these
 * exact fixtures (scripts/java_parity_fixtures_phase1.ts, 2026-08-21).
 */
class RollingStatisticsAndCorrelationTest {

    private static final double EPS = 0.0001;
    private static final double[] SERIES_A = StatsTestFixtures.risingTrend(60, 100);
    private static final double[] SERIES_B = StatsTestFixtures.oscillating(60, 100);

    @Test
    void rollingMeanMatchesTypeScript() {
        assertThat(RollingStatistics.rollingMean(SERIES_A, 20)).isCloseTo(115.025, within(EPS));
    }

    @Test
    void rollingStdDevMatchesTypeScript() {
        assertThat(RollingStatistics.rollingStdDev(SERIES_A, 20)).isCloseTo(1.6990070629635419, within(EPS));
    }

    @Test
    void zScoreMatchesTypeScript() {
        assertThat(RollingStatistics.zScore(SERIES_A, 20)).isCloseTo(1.1624436666879088, within(EPS));
    }

    @Test
    void percentileRankMatchesTypeScript() {
        assertThat(RollingStatistics.percentileRank(SERIES_A, 110)).isCloseTo(53.333333333333336, within(EPS));
    }

    @Test
    void correlationMatchesTypeScript() {
        assertThat(Correlation.correlation(SERIES_A, SERIES_B, 20)).isCloseTo(-0.10478315103850135, within(EPS));
    }

    @Test
    void covarianceMatchesTypeScript() {
        assertThat(Correlation.covariance(SERIES_A, SERIES_B, 20)).isCloseTo(-2.2546593644067783, within(EPS));
    }

    @Test
    void betaMatchesTypeScript() {
        double[] returnsA = RollingStatistics.rollingReturns(SERIES_A);
        double[] returnsB = RollingStatistics.rollingReturns(SERIES_B);
        assertThat(Correlation.beta(returnsA, returnsB, 20)).isCloseTo(-0.009717791171538587, within(EPS));
    }

    @Test
    void skewnessMatchesTypeScript() {
        assertThat(Correlation.skewness(SERIES_A, 20)).isCloseTo(0.0007353010852231042, within(EPS));
    }

    @Test
    void kurtosisMatchesTypeScript() {
        assertThat(Correlation.kurtosis(SERIES_A, 20)).isCloseTo(-1.1804463143815156, within(EPS));
    }

    @Test
    void autocorrelationMatchesTypeScript() {
        assertThat(Correlation.autocorrelation(SERIES_A, 1, 20)).isCloseTo(0.9780547183136286, within(EPS));
    }

    @Test
    void rollingMeanIsNullBelowPeriod() {
        assertThat(RollingStatistics.rollingMean(new double[]{1, 2, 3}, 20)).isNull();
    }

    @Test
    void correlationIsNullBelowMinOverlap() {
        assertThat(Correlation.correlation(new double[]{1, 2, 3}, new double[]{1, 2, 3}, 20)).isNull();
    }
}
