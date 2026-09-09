package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class BondImmunizationEngineTest {

    @Test
    void requiredInvestment_discountsTheFutureObligationCorrectly() {
        // F=1000, T*=5, Y=0.05, delta=1 -> P = 1000 / 1.05^5.
        double p = BondImmunizationEngine.requiredInvestment(1000, 5, 0.05, 1.0);
        assertThat(p).isCloseTo(1000 / Math.pow(1.05, 5), within(1e-6));
    }

    @Test
    void targetDuration_matchesTheClosedFormFormula() {
        double d = BondImmunizationEngine.targetDuration(5, 0.05, 1.0);
        assertThat(d).isCloseTo(5 / 1.05, within(1e-9));
    }

    @Test
    void targetConvexity_matchesTheClosedFormFormula() {
        double c = BondImmunizationEngine.targetConvexity(5, 0.05, 1.0);
        assertThat(c).isCloseTo(5 * 6 / (1.05 * 1.05), within(1e-9));
    }

    @Test
    void solveTwoBond_allocationsSatisfyBothConstraints() {
        double totalInvestment = 1000;
        double targetDuration = 4.0;
        var allocation = BondImmunizationEngine.solveTwoBond(totalInvestment, targetDuration, 2.0, 8.0);
        assertThat(allocation).isNotNull();
        assertThat(allocation.dollarsInBond1() + allocation.dollarsInBond2()).isCloseTo(totalInvestment, within(1e-6));
        double weightedDuration = (allocation.dollarsInBond1() * 2.0 + allocation.dollarsInBond2() * 8.0) / totalInvestment;
        assertThat(weightedDuration).isCloseTo(targetDuration, within(1e-6));
    }

    @Test
    void solveTwoBond_returnsNullRatherThanFabricating_whenDurationsAreEqual() {
        assertThat(BondImmunizationEngine.solveTwoBond(1000, 4.0, 5.0, 5.0)).isNull();
    }

    @Test
    void solveThreeBond_allocationsSatisfyAllThreeConstraints() {
        double totalInvestment = 1000;
        double targetDuration = 5.0;
        double targetConvexity = 30.0;
        var allocation = BondImmunizationEngine.solveThreeBond(totalInvestment, targetDuration, targetConvexity,
            2.0, 5.0, 10.0, 6.0, 30.0, 110.0);
        assertThat(allocation).isNotNull();

        double sum = allocation.dollarsInBond1() + allocation.dollarsInBond2() + allocation.dollarsInBond3();
        assertThat(sum).isCloseTo(totalInvestment, within(1e-3));

        double weightedDuration = (allocation.dollarsInBond1() * 2.0 + allocation.dollarsInBond2() * 5.0 + allocation.dollarsInBond3() * 10.0) / totalInvestment;
        assertThat(weightedDuration).isCloseTo(targetDuration, within(1e-3));

        double weightedConvexity = (allocation.dollarsInBond1() * 6.0 + allocation.dollarsInBond2() * 30.0 + allocation.dollarsInBond3() * 110.0) / totalInvestment;
        assertThat(weightedConvexity).isCloseTo(targetConvexity, within(1e-2));
    }

    @Test
    void solveThreeBond_returnsNullRatherThanFabricating_whenSystemIsSingular() {
        // All three bonds have identical duration/convexity -> singular 3x3 system.
        assertThat(BondImmunizationEngine.solveThreeBond(1000, 5.0, 30.0, 5.0, 5.0, 5.0, 30.0, 30.0, 30.0)).isNull();
    }
}
