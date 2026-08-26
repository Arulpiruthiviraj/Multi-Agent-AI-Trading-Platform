package io.argus.quantcore.backtest.cli;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real test coverage for the explicit graduation registry (2026-08-24 readiness audit, Part 9) -
 * not a reflection/plugin-scanning system, so its contents are worth asserting directly rather
 * than trusting a scan to find them.
 */
class GraduationHarnessTest {

    @Test
    void registersExactlyTheSevenModulesSelectedForThisPassGraduationExercise() {
        List<GraduationHarness.RegisteredStrategy> registry = GraduationHarness.registry();
        List<String> ids = registry.stream().map(GraduationHarness.RegisteredStrategy::id).toList();

        assertThat(ids).containsExactlyInAnyOrder(
            "TIME_SERIES_MOMENTUM_ENGINE", "MEAN_REVERSION_ZSCORE_ENGINE",
            "MOVING_AVERAGE_CROSSOVER_ENGINE", "AUTOREGRESSIVE_AR5_FORECAST_ENGINE",
            "ARMA_3_1_FORECAST_ENGINE", "ARIMA_3_1_1_FORECAST_ENGINE", "SARIMA_1_1_1x1_0_1_5_FORECAST_ENGINE");
    }

    @Test
    void everyRegisteredStrategyHasAPositiveWarmupRequirementAndAReal_nonNullSignalFunction() {
        for (GraduationHarness.RegisteredStrategy strat : GraduationHarness.registry()) {
            assertThat(strat.minWarmupBars()).isPositive();
            assertThat(strat.signalFn()).isNotNull();
            assertThat(strat.description()).isNotBlank();
        }
    }
}
