package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class CdoHedgeRatioEngineTest {

    @Test
    void computesTheDurationRatio() {
        Double ratio = CdoHedgeRatioEngine.evaluate(3.5, 5.0);
        assertThat(ratio).isNotNull();
        assertThat(ratio).isCloseTo(0.7, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenHedgeInstrumentDurationIsNotPositive() {
        assertThat(CdoHedgeRatioEngine.evaluate(3.5, 0.0)).isNull();
        assertThat(CdoHedgeRatioEngine.evaluate(3.5, -1.0)).isNull();
    }
}
