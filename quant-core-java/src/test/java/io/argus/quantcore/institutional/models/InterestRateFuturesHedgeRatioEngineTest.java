package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class InterestRateFuturesHedgeRatioEngineTest {

    @Test
    void conversionFactorHedgeRatio_computesCTimesNotionalRatio() {
        Double ratio = InterestRateFuturesHedgeRatioEngine.conversionFactorHedgeRatio(0.85, 10_000_000, 100_000);
        assertThat(ratio).isNotNull();
        assertThat(ratio).isCloseTo(0.85 * 10_000_000 / 100_000, within(1e-6));
    }

    @Test
    void conversionFactorHedgeRatio_returnsNullRatherThanFabricating_whenFuturesNotionalIsNotPositive() {
        assertThat(InterestRateFuturesHedgeRatioEngine.conversionFactorHedgeRatio(0.85, 10_000_000, 0)).isNull();
    }

    @Test
    void modifiedDurationHedgeRatio_computesBetaTimesDurationRatio() {
        Double ratio = InterestRateFuturesHedgeRatioEngine.modifiedDurationHedgeRatio(1.0, 6.5, 8.0);
        assertThat(ratio).isNotNull();
        assertThat(ratio).isCloseTo(6.5 / 8.0, within(1e-9));
    }

    @Test
    void modifiedDurationHedgeRatio_scalesWithBeta() {
        Double ratio = InterestRateFuturesHedgeRatioEngine.modifiedDurationHedgeRatio(1.2, 6.5, 8.0);
        assertThat(ratio).isNotNull();
        assertThat(ratio).isCloseTo(1.2 * 6.5 / 8.0, within(1e-9));
    }

    @Test
    void modifiedDurationHedgeRatio_returnsNullRatherThanFabricating_whenFuturesDurationIsNotPositive() {
        assertThat(InterestRateFuturesHedgeRatioEngine.modifiedDurationHedgeRatio(1.0, 6.5, 0)).isNull();
        assertThat(InterestRateFuturesHedgeRatioEngine.modifiedDurationHedgeRatio(1.0, 6.5, -1.0)).isNull();
    }
}
