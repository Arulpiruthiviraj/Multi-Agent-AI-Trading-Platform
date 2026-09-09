package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class SwapSpreadArbitrageEngineTest {

    @Test
    void initialSpread_isSwapRateMinusTreasuryYield() {
        assertThat(SwapSpreadArbitrageEngine.initialSpread(0.045, 0.040)).isCloseTo(0.005, within(1e-9));
    }

    @Test
    void fundingSpread_isLiborMinusRepo() {
        assertThat(SwapSpreadArbitrageEngine.fundingSpread(0.03, 0.025)).isCloseTo(0.005, within(1e-9));
    }

    @Test
    void longSwap_profitsWhenFundingSpreadShrinks_belowTheInitialSpread() {
        double initial = SwapSpreadArbitrageEngine.initialSpread(0.045, 0.040); // 0.005
        double laterFundingSpread = SwapSpreadArbitrageEngine.fundingSpread(0.028, 0.025); // 0.003, LIBOR fell
        double pnl = SwapSpreadArbitrageEngine.pnlRate(initial, laterFundingSpread, true);
        assertThat(pnl).isGreaterThan(0);
    }

    @Test
    void shortSwap_isTheExactMirrorOfLongSwap() {
        double initial = 0.005;
        double laterFundingSpread = 0.003;
        double longPnl = SwapSpreadArbitrageEngine.pnlRate(initial, laterFundingSpread, true);
        double shortPnl = SwapSpreadArbitrageEngine.pnlRate(initial, laterFundingSpread, false);
        assertThat(shortPnl).isCloseTo(-longPnl, within(1e-12));
    }
}
