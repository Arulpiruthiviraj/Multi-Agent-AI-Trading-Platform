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
    void registersExactlyTheTwoModulesSelectedForThisPassGraduationExercise() {
        List<GraduationHarness.RegisteredStrategy> registry = GraduationHarness.registry();
        List<String> ids = registry.stream().map(GraduationHarness.RegisteredStrategy::id).toList();

        assertThat(ids).containsExactlyInAnyOrder("TIME_SERIES_MOMENTUM_ENGINE", "MEAN_REVERSION_ZSCORE_ENGINE");
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
