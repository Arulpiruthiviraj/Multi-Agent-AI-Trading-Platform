package io.argus.quantcore.backtest.engine;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/** Expected values captured from the real Commissions.ts/Slippage.ts (2026-08-21). */
class CommissionsAndSlippageTest {

    private static final double EPS = 0.0001;

    @Test
    void sellCommissionMatchesTypeScript() {
        var result = Commissions.calculate("SELL", 100, 50);
        assertThat(result.total()).isCloseTo(0.13, within(EPS));
        assertThat(result.secFee()).isCloseTo(0.11, within(EPS));
        assertThat(result.finraTaf()).isCloseTo(0.02, within(EPS));
    }

    @Test
    void buyCommissionIsZero() {
        var result = Commissions.calculate("BUY", 100, 50);
        assertThat(result.total()).isZero();
    }

    @Test
    void slippageMatchesTypeScript() {
        double[] highs = {101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115};
        double[] lows = {99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113};
        double[] closes = {100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114};
        double slip = Slippage.calculateDynamicSlippagePct(highs, lows, closes, 114, 500, 10000);
        assertThat(slip).isCloseTo(0.02637719298245614, within(EPS));
    }
}
