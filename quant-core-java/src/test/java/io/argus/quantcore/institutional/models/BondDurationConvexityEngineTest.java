package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class BondDurationConvexityEngineTest {

    @Test
    void zeroCouponBond_macaulayDurationEqualsItsOwnMaturity() {
        // A single cash flow at T=5 -> Macaulay duration is trivially 5, regardless of PV.
        BondDurationConvexityEngine.CashFlow[] flows = {
            new BondDurationConvexityEngine.CashFlow(5.0, 80.0)
        };
        var result = BondDurationConvexityEngine.evaluate(flows, 0.05, 1.0);
        assertThat(result).isNotNull();
        assertThat(result.macaulayDuration()).isCloseTo(5.0, within(1e-9));
    }

    @Test
    void continuousCompounding_modifiedDurationEqualsMacaulayDuration() {
        BondDurationConvexityEngine.CashFlow[] flows = {
            new BondDurationConvexityEngine.CashFlow(2.0, 5.0),
            new BondDurationConvexityEngine.CashFlow(5.0, 90.0)
        };
        var result = BondDurationConvexityEngine.evaluate(flows, 0.05, 0.0); // periodLength=0 -> continuous
        assertThat(result).isNotNull();
        assertThat(result.modifiedDuration()).isCloseTo(result.macaulayDuration(), within(1e-9));
    }

    @Test
    void periodicCompounding_modifiedDurationIsLowerThanMacaulay() {
        BondDurationConvexityEngine.CashFlow[] flows = {
            new BondDurationConvexityEngine.CashFlow(2.0, 5.0),
            new BondDurationConvexityEngine.CashFlow(5.0, 90.0)
        };
        var result = BondDurationConvexityEngine.evaluate(flows, 0.05, 1.0);
        assertThat(result).isNotNull();
        assertThat(result.modifiedDuration()).isLessThan(result.macaulayDuration());
        assertThat(result.modifiedDuration()).isCloseTo(result.macaulayDuration() / 1.05, within(1e-9));
    }

    @Test
    void dollarDuration_equalsModifiedDurationTimesPrice() {
        BondDurationConvexityEngine.CashFlow[] flows = {
            new BondDurationConvexityEngine.CashFlow(5.0, 80.0)
        };
        var result = BondDurationConvexityEngine.evaluate(flows, 0.05, 1.0);
        assertThat(result).isNotNull();
        assertThat(result.dollarDuration()).isCloseTo(result.modifiedDuration() * result.bondPrice(), within(1e-9));
    }

    @Test
    void approximatePriceChangePct_isNegativeOfDurationTimesYieldChange_forSmallShifts() {
        double pctChange = BondDurationConvexityEngine.approximatePriceChangePct(5.0, 0.0, 0.01);
        assertThat(pctChange).isCloseTo(-0.05, within(1e-9));
    }

    @Test
    void approximateConvexity_isPositive_forAConvexPriceYieldRelationship() {
        // A simple convex function f(y) = 100 * exp(-5y) around y=0.05: price falls but convexly.
        double bump = 0.0001;
        double y = 0.05;
        double priceAt = 100 * Math.exp(-5 * y);
        double priceMinus = 100 * Math.exp(-5 * (y - bump));
        double pricePlus = 100 * Math.exp(-5 * (y + bump));

        Double convexity = BondDurationConvexityEngine.approximateConvexity(priceMinus, priceAt, pricePlus, bump);
        assertThat(convexity).isNotNull();
        assertThat(convexity).isCloseTo(25.0, within(0.01)); // f''(y)/f(y) = 25 for this function
    }

    @Test
    void returnsNullRatherThanFabricating_whenNoCashFlowsSupplied() {
        assertThat(BondDurationConvexityEngine.evaluate(new BondDurationConvexityEngine.CashFlow[0], 0.05, 1.0)).isNull();
    }
}
