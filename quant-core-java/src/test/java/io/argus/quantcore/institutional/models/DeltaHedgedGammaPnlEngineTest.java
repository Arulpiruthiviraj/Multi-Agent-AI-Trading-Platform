package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class DeltaHedgedGammaPnlEngineTest {

    @Test
    void shortGamma_profitsWhenRealizedVolatilityIsBelowImplied() {
        // Short straddle -> negative net gamma; realized (0.15) < implied (0.30) -> positive P&L.
        Double pnl = DeltaHedgedGammaPnlEngine.approximatePnl(-0.05, 100, 0.15, 0.30, 1.0 / 365);
        assertThat(pnl).isNotNull();
        assertThat(pnl).isGreaterThan(0);
    }

    @Test
    void shortGamma_losesWhenRealizedVolatilityExceedsImplied() {
        Double pnl = DeltaHedgedGammaPnlEngine.approximatePnl(-0.05, 100, 0.45, 0.30, 1.0 / 365);
        assertThat(pnl).isNotNull();
        assertThat(pnl).isLessThan(0);
    }

    @Test
    void longGamma_isTheMirrorImageOfShortGamma_forTheSameInputs() {
        Double shortPnl = DeltaHedgedGammaPnlEngine.approximatePnl(-0.05, 100, 0.15, 0.30, 1.0 / 365);
        Double longPnl = DeltaHedgedGammaPnlEngine.approximatePnl(0.05, 100, 0.15, 0.30, 1.0 / 365);
        assertThat(shortPnl).isNotNull();
        assertThat(longPnl).isNotNull();
        assertThat(longPnl).isCloseTo(-shortPnl, within(1e-12));
    }

    @Test
    void matchesTheClosedFormFormula_exactly() {
        double gamma = 0.03, spot = 150, realized = 0.25, implied = 0.20, dt = 5.0 / 365;
        Double pnl = DeltaHedgedGammaPnlEngine.approximatePnl(gamma, spot, realized, implied, dt);
        double expected = 0.5 * gamma * spot * spot * (realized * realized - implied * implied) * dt;
        assertThat(pnl).isCloseTo(expected, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenSpotOrDtIsNotPositive() {
        assertThat(DeltaHedgedGammaPnlEngine.approximatePnl(-0.05, 0, 0.15, 0.30, 1.0 / 365)).isNull();
        assertThat(DeltaHedgedGammaPnlEngine.approximatePnl(-0.05, 100, 0.15, 0.30, 0)).isNull();
    }
}
