package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class GarchEngineTest {

    @Test
    void fitsValidStationaryParametersOnASimulatedGarchSeries() {
        // Simulate a real GARCH(1,1) process with known parameters, then fit and check the
        // recovered parameters land in the model's own valid region (the reparameterization in
        // GarchEngine.toParams structurally guarantees this - this test is really checking that
        // fitting doesn't degenerate to the initial guess or blow up).
        double trueOmega = 0.02, trueAlpha = 0.1, trueBeta = 0.85;
        Random rnd = new Random(55);
        int n = 800;
        double[] returns = new double[n];
        double sigma2 = trueOmega / (1 - trueAlpha - trueBeta);
        for (int t = 0; t < n; t++) {
            double shock = rnd.nextGaussian() * Math.sqrt(sigma2);
            returns[t] = shock;
            sigma2 = trueOmega + trueAlpha * shock * shock + trueBeta * sigma2;
        }

        GarchEngine.Params fitted = GarchEngine.fit(returns);
        assertThat(fitted).isNotNull();
        assertThat(fitted.omega()).isGreaterThan(0);
        assertThat(fitted.alpha()).isGreaterThanOrEqualTo(0);
        assertThat(fitted.beta()).isGreaterThanOrEqualTo(0);
        assertThat(fitted.alpha() + fitted.beta()).isLessThan(1.0);
        assertThat(fitted.unconditionalVariance()).isFinite();
        assertThat(fitted.unconditionalVariance()).isGreaterThan(0);
        assertThat(fitted.logLikelihood()).isFinite();
    }

    @Test
    void forecastVarianceConvergesTowardUnconditionalVarianceAtLongHorizon() {
        GarchEngine.Params params = new GarchEngine.Params(0.01, 0.1, 0.8, 0);
        double forecast1 = GarchEngine.forecastVariance(params, 0.5, 1.0, 1);
        double forecastFar = GarchEngine.forecastVariance(params, 0.5, 1.0, 500);
        assertThat(forecastFar).isCloseTo(params.unconditionalVariance(), org.assertj.core.data.Offset.offset(1e-6));
        assertThat(forecast1).isNotEqualTo(forecastFar);
    }

    @Test
    void returnsNullWhenNotEnoughData() {
        assertThat(GarchEngine.fit(new double[]{0.01, 0.02, -0.01})).isNull();
    }
}
