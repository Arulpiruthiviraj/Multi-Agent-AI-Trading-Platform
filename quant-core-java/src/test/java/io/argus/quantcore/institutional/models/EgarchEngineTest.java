package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class EgarchEngineTest {

    @Test
    void fitsRealParametersAndProducesAValidLogLikelihoodForGenuineReturns() {
        Random rnd = new Random(15);
        int n = 300;
        double[] returns = new double[n];
        double sigma = 0.01;
        for (int i = 0; i < n; i++) {
            // Simple volatility-clustering process: vol rises after big moves.
            returns[i] = rnd.nextGaussian() * sigma;
            sigma = 0.3 * Math.abs(returns[i]) + 0.7 * sigma + 0.001;
        }

        var params = EgarchEngine.fit(returns);
        assertThat(params).isNotNull();
        assertThat(params.beta()).isBetween(-1.0, 1.0); // stationarity constraint held
        // Gaussian log-likelihood is not sign-bounded in general (small-scale data with a tight
        // variance fit can genuinely push it positive) - only finiteness and "not the -1e18
        // fail-closed sentinel from a degenerate fit" are real, general invariants to assert here.
        assertThat(Double.isFinite(params.logLikelihood())).isTrue();
        assertThat(params.logLikelihood()).isGreaterThan(-1e10);
    }

    @Test
    void logVariancePathHasOneEntryPerReturnAndStaysFinite() {
        Random rnd = new Random(16);
        int n = 100;
        double[] returns = new double[n];
        for (int i = 0; i < n; i++) returns[i] = rnd.nextGaussian() * 0.02;

        var params = EgarchEngine.fit(returns);
        double[] path = EgarchEngine.logVariancePath(returns, params);
        assertThat(path).hasSize(n);
        for (double v : path) {
            assertThat(Double.isFinite(v)).isTrue();
        }
    }

    @Test
    void returnsNullForTooLittleData() {
        double[] returns = { 0.01, -0.02, 0.005 };
        assertThat(EgarchEngine.fit(returns)).isNull();
    }
}
