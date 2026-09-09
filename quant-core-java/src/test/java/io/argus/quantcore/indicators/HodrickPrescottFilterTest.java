package io.argus.quantcore.indicators;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class HodrickPrescottFilterTest {

    @Test
    void aPerfectlyLinearSeries_passesThroughAlmostUnchanged() {
        // A perfectly linear trend has zero second difference everywhere, so the smoothness
        // penalty is already zero - the filter should reproduce it almost exactly regardless of lambda.
        double[] series = new double[30];
        for (int i = 0; i < series.length; i++) series[i] = 100 + i * 2.0;

        double[] trend = HodrickPrescottFilter.trend(series, 1600.0);

        assertThat(trend).isNotNull();
        for (int i = 0; i < series.length; i++) {
            assertThat(trend[i]).isCloseTo(series[i], within(1e-6));
        }
    }

    @Test
    void higherLambda_producesASmootherTrendThanLowerLambda_forANoisySeries() {
        java.util.Random rnd = new java.util.Random(42);
        double[] series = new double[60];
        for (int i = 0; i < series.length; i++) {
            series[i] = 100 + i * 0.5 + rnd.nextGaussian() * 3.0;
        }

        double[] lowLambdaTrend = HodrickPrescottFilter.trend(series, 10.0);
        double[] highLambdaTrend = HodrickPrescottFilter.trend(series, 100000.0);

        assertThat(lowLambdaTrend).isNotNull();
        assertThat(highLambdaTrend).isNotNull();

        double lowLambdaRoughness = sumOfSquaredSecondDifferences(lowLambdaTrend);
        double highLambdaRoughness = sumOfSquaredSecondDifferences(highLambdaTrend);

        assertThat(highLambdaRoughness).isLessThan(lowLambdaRoughness);
    }

    @Test
    void returnsNullRatherThanFabricating_whenSeriesIsTooShort() {
        assertThat(HodrickPrescottFilter.trend(new double[]{1, 2, 3}, 1600.0)).isNull();
    }

    @Test
    void returnsNull_whenLambdaIsNotPositive() {
        double[] series = new double[10];
        for (int i = 0; i < series.length; i++) series[i] = 100 + i;

        assertThat(HodrickPrescottFilter.trend(series, 0.0)).isNull();
        assertThat(HodrickPrescottFilter.trend(series, -5.0)).isNull();
    }

    @Test
    void defaultOverload_usesTheConventionalMonthlyLambdaOf14400() {
        double[] series = new double[20];
        for (int i = 0; i < series.length; i++) series[i] = 100 + i * 0.3;

        double[] withDefault = HodrickPrescottFilter.trend(series);
        double[] withExplicit = HodrickPrescottFilter.trend(series, 14400.0);

        assertThat(withDefault).isEqualTo(withExplicit);
    }

    private static double sumOfSquaredSecondDifferences(double[] series) {
        double sum = 0;
        for (int i = 1; i < series.length - 1; i++) {
            double secondDiff = series[i + 1] - 2 * series[i] + series[i - 1];
            sum += secondDiff * secondDiff;
        }
        return sum;
    }
}
