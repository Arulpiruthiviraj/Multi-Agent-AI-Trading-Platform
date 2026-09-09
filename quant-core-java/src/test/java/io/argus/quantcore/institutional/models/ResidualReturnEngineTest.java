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

    @Test
    void idiosyncraticVolatilityIsCloseToZero_whenTheSymbolTracksTheBenchmarkWithNegligibleNoise() {
        // Genuinely zero residuals (exact replication) would give the residual series zero
        // variance, which RollingStatistics.zScore correctly refuses to Z-score (division by
        // ~zero stddev) - a real, tiny amount of idiosyncratic noise is needed for this to be a
        // meaningful "small but nonzero" case rather than a degenerate one.
        java.util.Random rnd = new java.util.Random(99);
        int n = 60;
        double[] benchmarkReturns = new double[n];
        double[] symbolReturns = new double[n];
        for (int i = 0; i < n; i++) {
            benchmarkReturns[i] = 0.001 * Math.sin(i);
            symbolReturns[i] = benchmarkReturns[i] + rnd.nextGaussian() * 1e-6; // negligible idiosyncratic noise
        }

        var result = ResidualReturnEngine.evaluate(symbolReturns, benchmarkReturns, 20, 10);

        assertThat(result).isNotNull();
        assertThat(result.idiosyncraticVolatility()).isCloseTo(0.0, org.assertj.core.data.Offset.offset(1e-5));
    }

    @Test
    void signalsBuyOnAnExtremeNegativeResidual_whenAThresholdIsSupplied() {
        int n = 60;
        double[] benchmarkReturns = new double[n];
        double[] symbolReturns = new double[n];
        for (int i = 0; i < n; i++) {
            benchmarkReturns[i] = 0.001 * Math.sin(i);
            symbolReturns[i] = benchmarkReturns[i];
        }
        symbolReturns[n - 1] = -0.20; // sharp, idiosyncratic single-day crash at the very end

        var result = ResidualReturnEngine.evaluate(symbolReturns, benchmarkReturns, 20, 10, 2.0);

        assertThat(result.residualMeanReversionSignal()).isEqualTo("BUY");
    }

    @Test
    void theFourArgOverload_alwaysReadsNeutral_preservingExistingCallerBehavior() {
        int n = 60;
        double[] benchmarkReturns = new double[n];
        double[] symbolReturns = new double[n];
        for (int i = 0; i < n; i++) {
            benchmarkReturns[i] = 0.001 * Math.sin(i);
            symbolReturns[i] = benchmarkReturns[i];
        }
        symbolReturns[n - 1] = -0.20;

        var result = ResidualReturnEngine.evaluate(symbolReturns, benchmarkReturns, 20, 10);

        assertThat(result.residualMeanReversionSignal()).isEqualTo("NEUTRAL");
    }
}
