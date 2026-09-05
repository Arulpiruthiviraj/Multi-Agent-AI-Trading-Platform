package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ValueAtRiskEngineTest {

    @Test
    void computesARealHistoricalVarFromTheActualSortedTailObservations() {
        // 100 returns: 10 progressively worse losses (-0.02 down to -0.20) and 90 small gains
        // (+0.01) - at 95% confidence the cutoff falls solidly inside the real loss region
        // (index floor(0.05*100)=5 into the ascending-sorted array), not at the single worst point.
        double[] returns = new double[100];
        for (int i = 0; i < 90; i++) returns[i] = 0.01;
        for (int i = 0; i < 10; i++) returns[90 + i] = -0.02 * (i + 1); // -0.02, -0.04, ..., -0.20

        var result = ValueAtRiskEngine.evaluate(returns, 0.95);
        assertThat(result).isNotNull();
        // Sorted ascending, the 10 losses occupy indices 0-9 as -0.20,-0.18,...,-0.02; index 5 is -0.10.
        assertThat(result.historicalVaR()).isCloseTo(0.10, org.assertj.core.data.Offset.offset(0.001));
        // Expected shortfall averages the tail AT/BEYOND the VaR cutoff, which includes worse (more
        // negative) observations - so as a positive loss number it must be >= the VaR itself.
        assertThat(result.historicalExpectedShortfall()).isGreaterThanOrEqualTo(result.historicalVaR());
    }

    @Test
    void parametricVarMatchesTheKnownStandardNormalNinetyFivePercentZScore() {
        // Returns with mean 0, stddev 1 (synthetic, exact) - parametric VaR at 95% should be
        // close to the well-known z=1.645 (VaR = -(0 - 1.645*1) = 1.645).
        double[] returns = buildZeroMeanUnitStdDevSample();
        var result = ValueAtRiskEngine.evaluate(returns, 0.95);
        assertThat(result.parametricVaR()).isCloseTo(1.645, org.assertj.core.data.Offset.offset(0.05));
    }

    private static double[] buildZeroMeanUnitStdDevSample() {
        // A symmetric +/-1 sample has mean 0 and population stddev 1 by construction.
        double[] returns = new double[1000];
        for (int i = 0; i < 500; i++) returns[i] = 1.0;
        for (int i = 500; i < 1000; i++) returns[i] = -1.0;
        return returns;
    }

    @Test
    void returnsNullForAConfidenceLevelOutsideZeroOne() {
        double[] returns = { 0.01, -0.02, 0.03 };
        assertThat(ValueAtRiskEngine.evaluate(returns, 1.0)).isNull();
        assertThat(ValueAtRiskEngine.evaluate(returns, 0.0)).isNull();
    }

    @Test
    void returnsNullForAnEmptyReturnsSeries() {
        assertThat(ValueAtRiskEngine.evaluate(new double[0], 0.95)).isNull();
    }
}
