package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionIronCondorNetDebitTest {

    @Test
    void evaluateNetDebit_matchesThePapersOwnClosedForm() {
        // Short put A=90, long put B=100, long call C=110, short call D=120, net debit 2.20.
        var result = OptionIronCondorEngine.evaluateNetDebit(90, 100, 110, 120, 2.20);
        assertThat(result).isNotNull();
        assertThat(result.breakevenLower()).isCloseTo(100 - 2.20, within(1e-9)); // B-D
        assertThat(result.breakevenUpper()).isCloseTo(110 + 2.20, within(1e-9)); // C+D
        assertThat(result.maxProfit()).isCloseTo(10 - 2.20, within(1e-9)); // wing width - debit
        assertThat(result.maxRisk()).isCloseTo(2.20, within(1e-9)); // = debit
    }

    @Test
    void evaluateNetDebit_isTheOppositeShapeFromEvaluateNetCredit() {
        // Same strikes, same magnitude premium - net-debit max profit should equal net-credit max risk and vice versa.
        var credit = OptionIronCondorEngine.evaluateNetCredit(90, 100, 110, 120, 2.20);
        var debit = OptionIronCondorEngine.evaluateNetDebit(90, 100, 110, 120, 2.20);
        assertThat(credit).isNotNull();
        assertThat(debit).isNotNull();
        assertThat(debit.maxProfit()).isCloseTo(credit.maxRisk(), within(1e-9));
        assertThat(debit.maxRisk()).isCloseTo(credit.maxProfit(), within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenWingsUnequal() {
        assertThat(OptionIronCondorEngine.evaluateNetDebit(90, 100, 110, 130, 2.20)).isNull();
    }
}
