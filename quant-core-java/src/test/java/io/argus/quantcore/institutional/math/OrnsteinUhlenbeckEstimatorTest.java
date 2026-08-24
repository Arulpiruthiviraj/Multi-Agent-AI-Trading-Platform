package io.argus.quantcore.institutional.math;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class OrnsteinUhlenbeckEstimatorTest {

    @Test
    void recoversKnownParametersFromASimulatedOuProcess() {
        double theta = 0.1, mu = 50.0, sigma = 2.0, dt = 1.0;
        double b = Math.exp(-theta * dt);
        double a = mu * (1 - b);
        double noiseStdDev = Math.sqrt(sigma * sigma * (1 - b * b) / (2 * theta));

        Random rnd = new Random(123);
        int n = 3000;
        double[] series = new double[n];
        series[0] = mu;
        for (int t = 1; t < n; t++) {
            series[t] = b * series[t - 1] + a + noiseStdDev * rnd.nextGaussian();
        }

        OrnsteinUhlenbeckEstimator.Result result = OrnsteinUhlenbeckEstimator.estimate(series, dt);
        assertThat(result).isNotNull();
        assertThat(result.theta()).isCloseTo(theta, org.assertj.core.data.Offset.offset(0.03));
        assertThat(result.mu()).isCloseTo(mu, org.assertj.core.data.Offset.offset(3.0));
        assertThat(result.sigma()).isCloseTo(sigma, org.assertj.core.data.Offset.offset(0.3));
        assertThat(result.halfLife()).isCloseTo(Math.log(2) / theta, org.assertj.core.data.Offset.offset(1.5));
    }

    @Test
    void returnsNullForAnExplosiveSeriesWithNoMeanReversion() {
        // Deterministic explosive AR(1) (b=1.05, exact, no noise) - the fitted b is guaranteed
        // >= 1 regardless of any RNG, so this is a robust (non-flaky) way to exercise the
        // "no mean reversion" guard. A noisy random walk's finite-sample OLS beta is only
        // asymptotically 1 (and is known to be downward-biased in finite samples - the classic
        // Dickey-Fuller bias), so it would not deterministically trip this guard either way.
        int n = 100;
        double[] series = new double[n];
        series[0] = 1.0;
        for (int t = 1; t < n; t++) {
            series[t] = 1.05 * series[t - 1];
        }
        assertThat(OrnsteinUhlenbeckEstimator.estimate(series, 1.0)).isNull();
    }

    @Test
    void returnsNullForTooShortASeries() {
        double[] tiny = {1, 2, 3, 4};
        assertThat(OrnsteinUhlenbeckEstimator.estimate(tiny, 1.0)).isNull();
    }
}
