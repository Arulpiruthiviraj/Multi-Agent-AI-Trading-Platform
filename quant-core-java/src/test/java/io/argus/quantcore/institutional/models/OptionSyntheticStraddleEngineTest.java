package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionSyntheticStraddleEngineTest {

    @Test
    void longCallSynthetic_matchesThePapersOwnClosedForm() {
        // S0=100, K=100, D=8 (> |S0-K|=0, required).
        var result = OptionSyntheticStraddleEngine.evaluate(OptionSyntheticStraddleEngine.Position.LONG_CALL_SYNTHETIC, 100, 100, 8);
        assertThat(result).isNotNull();
        assertThat(result.breakevenUpper()).isCloseTo(108, within(1e-9)); // 2K-S0+D
        assertThat(result.breakevenLower()).isCloseTo(92, within(1e-9)); // S0-D
        assertThat(result.maxProfit()).isEqualTo(Double.POSITIVE_INFINITY);
        assertThat(result.maxLoss()).isCloseTo(8, within(1e-9)); // D-(S0-K) = D-0
    }

    @Test
    void longPutSynthetic_matchesThePapersOwnClosedForm() {
        var result = OptionSyntheticStraddleEngine.evaluate(OptionSyntheticStraddleEngine.Position.LONG_PUT_SYNTHETIC, 100, 100, 8);
        assertThat(result).isNotNull();
        assertThat(result.breakevenUpper()).isCloseTo(108, within(1e-9)); // S0+D
        assertThat(result.breakevenLower()).isCloseTo(92, within(1e-9)); // 2K-S0-D
        assertThat(result.maxLoss()).isCloseTo(8, within(1e-9));
    }

    @Test
    void shortCallSynthetic_isTheMirrorOfLongCallSynthetic() {
        var result = OptionSyntheticStraddleEngine.evaluate(OptionSyntheticStraddleEngine.Position.SHORT_CALL_SYNTHETIC, 100, 100, 8);
        assertThat(result).isNotNull();
        assertThat(result.breakevenUpper()).isCloseTo(108, within(1e-9));
        assertThat(result.breakevenLower()).isCloseTo(92, within(1e-9));
        assertThat(result.maxProfit()).isCloseTo(8, within(1e-9)); // K-S0+C = 0+8
        assertThat(result.maxLoss()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void shortPutSynthetic_isTheMirrorOfLongPutSynthetic() {
        var result = OptionSyntheticStraddleEngine.evaluate(OptionSyntheticStraddleEngine.Position.SHORT_PUT_SYNTHETIC, 100, 100, 8);
        assertThat(result).isNotNull();
        assertThat(result.maxProfit()).isCloseTo(8, within(1e-9)); // S0-K+C
        assertThat(result.maxLoss()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void returnsNullRatherThanFabricating_whenPremiumDoesNotExceedIntrinsicGap() {
        // S0=110, K=100 -> |S0-K|=10; premium must exceed 10 for LONG_ variants.
        assertThat(OptionSyntheticStraddleEngine.evaluate(OptionSyntheticStraddleEngine.Position.LONG_CALL_SYNTHETIC, 110, 100, 5)).isNull();
    }
}
