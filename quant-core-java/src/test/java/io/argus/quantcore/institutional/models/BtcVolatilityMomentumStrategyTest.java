package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class BtcVolatilityMomentumStrategyTest {

    private static double[] steadyUptrend(int n) {
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price *= 1.005; // gentle, low-volatility uptrend
            closes[i] = price;
        }
        return closes;
    }

    private static double[] flatChoppy(int n) {
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price += (i % 2 == 0) ? 0.1 : -0.1; // no net drift -> momentum ~ 0
            closes[i] = price;
        }
        return closes;
    }

    @Test
    void baselineWrapperProducesTheIdenticalDecisionAsItsAdaptiveDelegateWithTanParameters() {
        double[] closes = steadyUptrend(120);
        var baseline = new BtcTan2025VolAdjustedMomentumStrategy();
        var adaptive = new BtcAdaptiveVolatilityMomentumStrategy(BtcAdaptiveVolatilityMomentumStrategy.TAN2025_EQUIVALENT_PARAMETERS);

        var baselineResult = baseline.evaluate(closes);
        var adaptiveResult = adaptive.evaluate(closes);

        assertThat(baselineResult.position()).isEqualTo(adaptiveResult.position());
        assertThat(baselineResult.diagnostics()).isEqualTo(adaptiveResult.diagnostics());
        // Distinct identity despite identical computation - this is the reproduction-tracking point.
        assertThat(baseline.strategyId()).isEqualTo("BTC_TAN2025_VOL_ADJUSTED_MOMENTUM");
        assertThat(adaptive.strategyId()).isEqualTo("BTC_ADAPTIVE_VOLATILITY_MOMENTUM");
    }

    @Test
    void reportsInsufficientDataRatherThanFabricatingASignalWhenHistoryIsShort() {
        double[] closes = {100, 101, 102};
        var strategy = new BtcTan2025VolAdjustedMomentumStrategy();
        var result = strategy.evaluate(closes);
        assertThat(result.sufficientData()).isFalse();
        assertThat(result.position()).isEqualTo(CryptoPosition.FLAT);
    }

    @Test
    void goesLongOnlyWhenMomentumIsPositiveAndVolatilityIsBelowItsOwnHistoricalThreshold() {
        double[] closes = steadyUptrend(150);
        var strategy = new BtcTan2025VolAdjustedMomentumStrategy();
        var result = strategy.evaluate(closes);

        assertThat(result.sufficientData()).isTrue();
        assertThat(result.diagnostics().get("momentum")).isGreaterThan(0);
        // A steady low-vol uptrend is exactly the condition the baseline is designed to catch.
        assertThat(result.position()).isEqualTo(CryptoPosition.LONG);
    }

    @Test
    void staysFlatWhenMomentumIsApproximatelyZero() {
        double[] closes = flatChoppy(150);
        var strategy = new BtcTan2025VolAdjustedMomentumStrategy();
        var result = strategy.evaluate(closes);

        assertThat(result.sufficientData()).isTrue();
        assertThat(result.position()).isEqualTo(CryptoPosition.FLAT);
    }

    @Test
    void aStricterAdaptiveThresholdCanFlipAPositionThatTheBaselineWouldHaveTaken() {
        double[] closes = steadyUptrend(150);
        var baseline = new BtcTan2025VolAdjustedMomentumStrategy();
        var baselineResult = baseline.evaluate(closes);
        assertThat(baselineResult.position()).isEqualTo(CryptoPosition.LONG); // precondition from the test above

        // Volatility percentile is always >= 0 by construction (StatisticsMath.percentileRank),
        // so a negative threshold can never be cleared regardless of the data's actual volatility.
        var strictParams = new BtcAdaptiveVolatilityMomentumStrategy.Parameters(30, 60, -1.0, 365);
        var strict = new BtcAdaptiveVolatilityMomentumStrategy(strictParams);
        var strictResult = strict.evaluate(closes);

        assertThat(strictResult.position()).isEqualTo(CryptoPosition.FLAT);
    }

    @Test
    void differentParameterObjectsProduceIndependentEvaluationsNotSharedState() {
        double[] closesA = steadyUptrend(150);
        double[] closesB = flatChoppy(150);
        var strategy = new BtcAdaptiveVolatilityMomentumStrategy(BtcAdaptiveVolatilityMomentumStrategy.TAN2025_EQUIVALENT_PARAMETERS);

        var resultA = strategy.evaluate(closesA);
        var resultB = strategy.evaluate(closesB);

        assertThat(resultA.position()).isEqualTo(CryptoPosition.LONG);
        assertThat(resultB.position()).isEqualTo(CryptoPosition.FLAT);
    }
}
