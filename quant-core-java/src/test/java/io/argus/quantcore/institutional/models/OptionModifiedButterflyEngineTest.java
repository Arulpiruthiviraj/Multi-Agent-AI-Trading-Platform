package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionModifiedButterflyEngineTest {

    @Test
    void modifiedCallButterfly_matchesThePapersOwnClosedForm() {
        // K1=95, K2=100 (5 wide), K3=115 (15 wide) -> non-equidistant, 5 < 15.
        var result = OptionModifiedButterflyEngine.evaluateModifiedCallButterfly(95, 100, 115, 2);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(117, within(1e-9)); // K3+D
        assertThat(result.maxProfit()).isCloseTo(100 - 115 - 2, within(1e-9)); // K2-K3-D (negative here, matching the paper's own formula even though unusual)
        assertThat(result.maxLoss()).isCloseTo(2, within(1e-9));
    }

    @Test
    void modifiedCallButterfly_returnsNullRatherThanFabricating_whenEquidistant() {
        assertThat(OptionModifiedButterflyEngine.evaluateModifiedCallButterfly(90, 100, 110, 2)).isNull();
    }

    @Test
    void modifiedPutButterfly_matchesThePapersOwnClosedForm_forPositivePremium() {
        // K1=85, K2=100 (15 wide), K3=105 (5 wide) -> non-equidistant, 5 < 15, net CREDIT (H>0).
        var result = OptionModifiedButterflyEngine.evaluateModifiedPutButterfly(85, 100, 105, 3);
        assertThat(result).isNotNull();
        assertThat(result.breakevenLower()).isCloseTo(2 * 100 - 105 + 3, within(1e-9));
        assertThat(result.breakevenUpper()).isNotNull();
        assertThat(result.breakevenUpper()).isCloseTo(105 - 3, within(1e-9));
        assertThat(result.maxProfit()).isCloseTo(105 - 100 - 3, within(1e-9));
        assertThat(result.maxLoss()).isCloseTo(2 * 100 - 85 - 105 + 3, within(1e-9));
    }

    @Test
    void modifiedPutButterfly_breakevenUpperIsNull_forNonPositivePremium() {
        var result = OptionModifiedButterflyEngine.evaluateModifiedPutButterfly(85, 100, 105, -2);
        assertThat(result).isNotNull();
        assertThat(result.breakevenUpper()).isNull();
    }

    @Test
    void modifiedPutButterfly_returnsNullRatherThanFabricating_whenEquidistant() {
        assertThat(OptionModifiedButterflyEngine.evaluateModifiedPutButterfly(90, 100, 110, 2)).isNull();
    }
}
