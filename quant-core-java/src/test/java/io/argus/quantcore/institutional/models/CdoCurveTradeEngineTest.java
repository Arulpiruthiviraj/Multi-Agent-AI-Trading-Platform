package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class CdoCurveTradeEngineTest {

    @Test
    void flattenerHasPositiveCarry_onAnUpwardSlopingSpreadCurve() {
        // Flattener: sell short-term (Slong>Sshort convention per paper for upward curve), buy long-term.
        double carry = CdoCurveTradeEngine.carry(10_000_000, 0.06, 10_000_000, 0.03, 0.25);
        assertThat(carry).isCloseTo((10_000_000 * 0.06 - 10_000_000 * 0.03) * 0.25, within(1e-6));
        assertThat(carry).isGreaterThan(0);
    }

    @Test
    void profitAndLossIsTheDifferenceInTrancheMarkToMarketValues() {
        double pnl = CdoCurveTradeEngine.profitAndLoss(150_000, 90_000);
        assertThat(pnl).isCloseTo(60_000, within(1e-6));
    }
}
