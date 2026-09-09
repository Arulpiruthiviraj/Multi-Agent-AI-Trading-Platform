package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class CdsBasisArbitrageEngineTest {

    @Test
    void negativeBasis_signalsBuyBondBuyProtection() {
        var result = CdsBasisArbitrageEngine.evaluate(0.02, 0.03); // CDS < bond spread
        assertThat(result.basis()).isCloseTo(-0.01, within(1e-9));
        assertThat(result.signal()).isEqualTo("BUY_BOND_BUY_PROTECTION");
    }

    @Test
    void positiveBasis_signalsUnwindOrNeutral() {
        var result = CdsBasisArbitrageEngine.evaluate(0.03, 0.02);
        assertThat(result.basis()).isCloseTo(0.01, within(1e-9));
        assertThat(result.signal()).isEqualTo("UNWIND_OR_NEUTRAL");
    }

    @Test
    void zeroBasis_signalsUnwindOrNeutral() {
        var result = CdsBasisArbitrageEngine.evaluate(0.02, 0.02);
        assertThat(result.signal()).isEqualTo("UNWIND_OR_NEUTRAL");
    }
}
