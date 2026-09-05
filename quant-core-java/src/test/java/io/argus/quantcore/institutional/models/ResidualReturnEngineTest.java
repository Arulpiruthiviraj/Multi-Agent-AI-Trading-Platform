package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class ResidualReturnEngineTest {

    @Test
    void recoversARealBetaCloseToTheTrueRelationshipWhenTheSymbolTracksTheBenchmarkWithNoise() {
        Random rnd = new Random(13);
        int n = 100;
        double[] benchmarkReturns = new double[n];
        double[] symbolReturns = new double[n];
        double trueBeta = 1.5;
        for (int i = 0; i < n; i++) {
            benchmarkReturns[i] = rnd.nextGaussian() * 0.01;
            symbolReturns[i] = trueBeta * benchmarkReturns[i] + rnd.nextGaussian() * 0.001; // small idiosyncratic noise
        }

        var result = ResidualReturnEngine.evaluate(symbolReturns, benchmarkReturns, 20, 10);
        assertThat(result).isNotNull();
        assertThat(result.beta()).isCloseTo(trueBeta, org.assertj.core.data.Offset.offset(0.3));
        assertThat(result.rSquared()).isGreaterThan(0.8); // noise is small relative to the real relationship
    }

    @Test
    void residualMomentumIsPositiveWhenRecentIdiosyncraticReturnsAreConsistentlyPositive() {
        int n = 60;
        double[] benchmarkReturns = new double[n];
        double[] symbolReturns = new double[n];
        for (int i = 0; i < n; i++) {
            // Small real (non-degenerate) benchmark variation - a literally-all-zero predictor
            // makes the OLS design matrix singular (correctly returns null, not a fabricated fit).
            benchmarkReturns[i] = 0.001 * Math.sin(i);
            // Idiosyncratic drift only in the most recent 10 bars.
            symbolReturns[i] = i >= n - 10 ? 0.01 : 0.0;
        }

        var result = ResidualReturnEngine.evaluate(symbolReturns, benchmarkReturns, 20, 10);
        assertThat(result).isNotNull();
        assertThat(result.residualMomentum()).isGreaterThan(0.0);
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughAlignedHistory() {
        double[] symbolReturns = { 0.01, 0.02 };
        double[] benchmarkReturns = { 0.01, 0.015 };
        assertThat(ResidualReturnEngine.evaluate(symbolReturns, benchmarkReturns, 20, 10)).isNull();
    }

    @Test
    void returnsNullWhenSeriesLengthsAreMisaligned() {
        double[] symbolReturns = new double[50];
        double[] benchmarkReturns = new double[40];
        assertThat(ResidualReturnEngine.evaluate(symbolReturns, benchmarkReturns, 20, 10)).isNull();
    }
}
