package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class BondButterflyEngineTest {

    @Test
    void dollarDurationNeutral_isBothDollarNeutralAndDurationNeutral() {
        double bodyDollars = 100;
        double bodyDuration = 5.0;
        var allocation = BondButterflyEngine.dollarDurationNeutral(bodyDollars, bodyDuration, 2.0, 10.0);
        assertThat(allocation).isNotNull();

        assertThat(allocation.dollarsInWing1() + allocation.dollarsInWing3()).isCloseTo(bodyDollars, within(1e-9));
        double weightedWingDuration = allocation.dollarsInWing1() * 2.0 + allocation.dollarsInWing3() * 10.0;
        assertThat(weightedWingDuration).isCloseTo(bodyDollars * bodyDuration, within(1e-6));
    }

    @Test
    void fiftyFifty_givesEqualDollarDurationOnEachWing_butIsNotDollarNeutral() {
        double bodyDollars = 100;
        double bodyDuration = 5.0;
        var allocation = BondButterflyEngine.fiftyFifty(bodyDollars, bodyDuration, 2.0, 10.0);
        assertThat(allocation).isNotNull();

        double wing1DollarDuration = allocation.dollarsInWing1() * 2.0;
        double wing3DollarDuration = allocation.dollarsInWing3() * 10.0;
        assertThat(wing1DollarDuration).isCloseTo(wing3DollarDuration, within(1e-9));
        assertThat(wing1DollarDuration).isCloseTo(bodyDollars * bodyDuration / 2.0, within(1e-9));

        // Since wing1 has lower duration than wing3, it needs MORE dollars for equal dollar duration.
        assertThat(allocation.dollarsInWing1() + allocation.dollarsInWing3()).isNotCloseTo(bodyDollars, within(1e-6));
    }

    @Test
    void maturityWeighted_matchesRegressionWeighted_whenBetaIsComputedFromMaturities() {
        double bodyDollars = 100;
        double bodyDuration = 5.0;
        double maturity1 = 2, maturity2 = 5, maturity3 = 10;
        double expectedBeta = (maturity2 - maturity1) / (maturity3 - maturity2);

        var maturityWeighted = BondButterflyEngine.maturityWeighted(bodyDollars, bodyDuration, 2.0, 10.0, maturity1, maturity2, maturity3);
        var regressionWeighted = BondButterflyEngine.regressionWeighted(bodyDollars, bodyDuration, 2.0, 10.0, expectedBeta);

        assertThat(maturityWeighted).isNotNull();
        assertThat(regressionWeighted).isNotNull();
        assertThat(maturityWeighted.dollarsInWing1()).isCloseTo(regressionWeighted.dollarsInWing1(), within(1e-9));
        assertThat(maturityWeighted.dollarsInWing3()).isCloseTo(regressionWeighted.dollarsInWing3(), within(1e-9));
    }

    @Test
    void regressionWeighted_satisfiesTheBetaRatioConstraint() {
        double bodyDollars = 100;
        double bodyDuration = 5.0;
        double beta = 1.5;
        var allocation = BondButterflyEngine.regressionWeighted(bodyDollars, bodyDuration, 2.0, 10.0, beta);
        assertThat(allocation).isNotNull();

        double dollarDuration1 = allocation.dollarsInWing1() * 2.0;
        double dollarDuration3 = allocation.dollarsInWing3() * 10.0;
        assertThat(dollarDuration1).isCloseTo(beta * dollarDuration3, within(1e-6));
        assertThat(dollarDuration1 + dollarDuration3).isCloseTo(bodyDollars * bodyDuration, within(1e-6));
    }

    @Test
    void dollarDurationNeutral_returnsNullRatherThanFabricating_whenDurationsAreEqual() {
        assertThat(BondButterflyEngine.dollarDurationNeutral(100, 5.0, 5.0, 5.0)).isNull();
    }
}
