package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class MinVarianceTwoStrategyCombinerEngineTest {

    @Test
    void weightsSumToOne_andFavorTheLowerVarianceStrategy_whenUncorrelated() {
        // Strategy 1: low volatility, Strategy 2: high volatility, both mean ~0, uncorrelated by construction.
        double[] r1 = {0.001, -0.001, 0.002, -0.002, 0.0015, -0.0015, 0.001, -0.001, 0.002, -0.002};
        double[] r2 = {0.05, -0.05, 0.06, -0.04, 0.03, -0.07, 0.04, -0.03, 0.05, -0.06};

        var result = MinVarianceTwoStrategyCombinerEngine.evaluate(r1, r2);

        assertThat(result).isNotNull();
        assertThat(result.weight1() + result.weight2()).isCloseTo(1.0, within(1e-9));
        // Lower-variance strategy 1 should get materially more weight than higher-variance strategy 2.
        assertThat(result.weight1()).isGreaterThan(result.weight2());
        assertThat(result.stdDev1()).isLessThan(result.stdDev2());
    }

    @Test
    void equalVarianceStrategies_alwaysSplitFiftyFifty_regardlessOfCorrelation() {
        // Same magnitude return series (equal variance) with a real, nonzero correlation between
        // them - the first-order-condition math (verified by hand: with var1 == var2, w1 reduces
        // to (v - s^2*rho) / (2*(v - s^2*rho)) = 1/2 for any rho != 1) means the split is exactly
        // 50/50 regardless of the actual correlation, not because correlation happens to be zero.
        double[] r1 = {0.01, -0.01, 0.02, -0.02, 0.015, -0.015};
        double[] r2 = {0.01, -0.01, -0.02, 0.02, -0.015, 0.015};

        var result = MinVarianceTwoStrategyCombinerEngine.evaluate(r1, r2);

        assertThat(result).isNotNull();
        assertThat(result.stdDev1()).isCloseTo(result.stdDev2(), within(1e-9));
        assertThat(result.correlation()).isNotCloseTo(0.0, within(0.3)); // confirms this isn't a zero-corr coincidence
        assertThat(result.weight1()).isCloseTo(0.5, within(1e-9));
        assertThat(result.weight2()).isCloseTo(0.5, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenSeriesAreMisalignedOrTooShort() {
        assertThat(MinVarianceTwoStrategyCombinerEngine.evaluate(new double[]{0.01}, new double[]{0.01})).isNull();
        assertThat(MinVarianceTwoStrategyCombinerEngine.evaluate(new double[]{0.01, 0.02}, new double[]{0.01})).isNull();
    }

    @Test
    void returnsNull_whenEitherStrategyHasZeroVariance() {
        double[] constant = {0.01, 0.01, 0.01, 0.01};
        double[] varying = {0.01, -0.01, 0.02, -0.02};
        assertThat(MinVarianceTwoStrategyCombinerEngine.evaluate(constant, varying)).isNull();
    }
}
