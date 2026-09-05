package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class CorrelationEngineTest {

    @Test
    void detectsHighCorrelationForATrackingIndexAndItsHeavilyOverlappingComponent() {
        Random rnd = new Random(4);
        int n = 300;
        double[] indexReturns = new double[n];
        double[] trackerReturns = new double[n];
        for (int i = 0; i < n; i++) {
            double common = rnd.nextGaussian() * 0.01;
            indexReturns[i] = common;
            trackerReturns[i] = common + rnd.nextGaussian() * 0.0005; // near-identical, tiny idiosyncratic noise
        }
        CorrelationEngine.CorrelationResult result = CorrelationEngine.compute(
            new String[]{"SPY", "IVV"}, new double[][]{indexReturns, trackerReturns});
        assertThat(result).isNotNull();
        assertThat(result.correlationMatrix()[0][1]).isCloseTo(1.0, within(0.05));
        assertThat(result.correlationMatrix()[0][0]).isCloseTo(1.0, within(1e-9));
    }

    @Test
    void detectsLowCorrelationForIndependentSeries() {
        Random rnd = new Random(5);
        int n = 300;
        double[] a = new double[n];
        double[] b = new double[n];
        for (int i = 0; i < n; i++) {
            a[i] = rnd.nextGaussian() * 0.01;
            b[i] = rnd.nextGaussian() * 0.01;
        }
        CorrelationEngine.CorrelationResult result = CorrelationEngine.compute(new String[]{"A", "B"}, new double[][]{a, b});
        assertThat(Math.abs(result.correlationMatrix()[0][1])).isLessThan(0.3);
    }

    @Test
    void returnsNullOnRaggedInput() {
        double[] a = {0.01, 0.02, 0.03};
        double[] b = {0.01, 0.02};
        CorrelationEngine.CorrelationResult result = CorrelationEngine.compute(new String[]{"A", "B"}, new double[][]{a, b});
        assertThat(result).isNull();
    }

    @Test
    void returnsNullWhenSymbolCountDoesNotMatchReturnsCount() {
        double[] a = {0.01, 0.02, 0.03};
        CorrelationEngine.CorrelationResult result = CorrelationEngine.compute(new String[]{"A", "B"}, new double[][]{a});
        assertThat(result).isNull();
    }
}
