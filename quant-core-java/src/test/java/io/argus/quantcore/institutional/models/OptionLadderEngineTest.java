package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionLadderEngineTest {

    @Test
    void bullCallLadder_matchesThePapersOwnClosedForm() {
        var result = OptionLadderEngine.evaluate(OptionLadderEngine.LadderType.BULL_CALL_LADDER, 100, 110, 120, 2.0);
        assertThat(result).isNotNull();
        assertThat(result.breakevenLower()).isCloseTo(102, within(1e-9)); // K1+H
        assertThat(result.breakevenUpper()).isCloseTo(120 + 110 - 100 - 2, within(1e-9)); // K3+K2-K1-H
        assertThat(result.maxProfit()).isCloseTo(110 - 100 - 2, within(1e-9)); // K2-K1-H
        assertThat(result.maxLoss()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void bullCallLadder_maxProfitMatchesTheUnderlyingBullCallSpreadsOwnMaxProfit() {
        // The 3rd leg (short K3 call) only changes the payoff ABOVE K3 - the core spread's
        // own max profit (at/below K2) should be identical to a plain bull call spread's.
        var ladder = OptionLadderEngine.evaluate(OptionLadderEngine.LadderType.BULL_CALL_LADDER, 100, 110, 120, 2.0);
        var spread = OptionVerticalSpreadEngine.evaluate(OptionVerticalSpreadEngine.SpreadType.BULL_CALL, 100, 110, -2.0);
        assertThat(ladder).isNotNull();
        assertThat(spread).isNotNull();
        assertThat(ladder.maxProfit()).isCloseTo(spread.maxReward(), within(1e-9));
    }

    @Test
    void bearCallLadder_matchesThePapersOwnClosedForm() {
        var result = OptionLadderEngine.evaluate(OptionLadderEngine.LadderType.BEAR_CALL_LADDER, 100, 110, 120, -2.0);
        assertThat(result).isNotNull();
        assertThat(result.breakevenLower()).isCloseTo(102, within(1e-9)); // K1-H
        assertThat(result.maxProfit()).isEqualTo(Double.POSITIVE_INFINITY);
        assertThat(result.maxLoss()).isCloseTo(110 - 100 + (-2.0), within(1e-9)); // K2-K1+H
    }

    @Test
    void bullPutLadder_matchesThePapersOwnClosedForm() {
        var result = OptionLadderEngine.evaluate(OptionLadderEngine.LadderType.BULL_PUT_LADDER, 100, 110, 120, -2.0);
        assertThat(result).isNotNull();
        assertThat(result.maxProfit()).isCloseTo(120 + 110 - 100 - (-2.0), within(1e-9)); // K3+K2-K1-H
        assertThat(result.maxLoss()).isCloseTo(100 - 110 + (-2.0), within(1e-9)); // K1-K2+H
    }

    @Test
    void bearPutLadder_matchesThePapersOwnClosedForm() {
        var result = OptionLadderEngine.evaluate(OptionLadderEngine.LadderType.BEAR_PUT_LADDER, 100, 110, 120, 2.0);
        assertThat(result).isNotNull();
        assertThat(result.maxProfit()).isCloseTo(100 - 110 - 2.0, within(1e-9)); // K1-K2-H
        assertThat(result.maxLoss()).isCloseTo(120 + 110 - 100 + 2.0, within(1e-9)); // K3+K2-K1+H
    }

    @Test
    void returnsNullRatherThanFabricating_whenStrikesNotStrictlyAscending() {
        assertThat(OptionLadderEngine.evaluate(OptionLadderEngine.LadderType.BULL_CALL_LADDER, 110, 100, 120, 2.0)).isNull();
    }
}
