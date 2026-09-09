package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class FuturesCrossHedgeRatioEngineTest {

    @Test
    void recoversAKnownHedgeRatioCloseToTheTrueRelationship() {
        Random rnd = new Random(11);
        int n = 100;
        double trueRatio = 0.8;
        double[] hedgingReturns = new double[n];
        double[] hedgedReturns = new double[n];
        for (int i = 0; i < n; i++) {
            hedgingReturns[i] = rnd.nextGaussian() * 0.02;
            hedgedReturns[i] = trueRatio * hedgingReturns[i] + rnd.nextGaussian() * 0.002;
        }

        var result = FuturesCrossHedgeRatioEngine.evaluate(hedgedReturns, hedgingReturns);

        assertThat(result).isNotNull();
        assertThat(result.hedgeRatio()).isCloseTo(trueRatio, within(0.1));
        assertThat(result.rSquared()).isGreaterThan(0.8);
    }

    @Test
    void returnsNullRatherThanFabricating_whenSeriesAreMisalignedOrTooShort() {
        assertThat(FuturesCrossHedgeRatioEngine.evaluate(new double[]{0.01, 0.02}, new double[]{0.01, 0.02})).isNull();
        assertThat(FuturesCrossHedgeRatioEngine.evaluate(new double[]{0.01, 0.02, 0.03}, new double[]{0.01, 0.02})).isNull();
    }
}
