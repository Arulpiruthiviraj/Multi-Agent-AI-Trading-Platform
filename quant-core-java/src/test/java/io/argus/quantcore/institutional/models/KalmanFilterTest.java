package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class KalmanFilterTest {

    @Test
    void aLocalLevelFilterSmoothsRealNoisyObservationsTowardTheTrueUnderlyingLevel() {
        Random rnd = new Random(9);
        int n = 200;
        double trueLevel = 50.0;
        double[] observations = new double[n];
        for (int i = 0; i < n; i++) {
            observations[i] = trueLevel + rnd.nextGaussian() * 5.0; // noisy around a constant true level
        }

        // Local-level model: F=1, H=1. Small process noise (level barely moves), larger observation noise.
        KalmanFilter filter = new KalmanFilter(1.0, 1.0, 0.01, 25.0);
        double[] filtered = filter.filterSeries(observations, observations[0], 100.0);

        // The filtered estimate should end up much closer to the true level than raw noisy observations are on average.
        double finalEstimateError = Math.abs(filtered[n - 1] - trueLevel);
        assertThat(finalEstimateError).isLessThan(3.0);
    }

    @Test
    void kalmanGainStartsHighWhenPriorUncertaintyIsHighAndShrinksAsConfidenceGrows() {
        KalmanFilter filter = new KalmanFilter(1.0, 1.0, 0.0, 1.0);
        KalmanFilter.State prior = new KalmanFilter.State(0.0, 1000.0); // very uncertain prior
        var firstStep = filter.step(prior, 10.0);
        var secondStep = filter.step(firstStep.state(), 10.0);

        assertThat(firstStep.kalmanGain()).isGreaterThan(secondStep.kalmanGain());
        assertThat(firstStep.state().errorCovariance()).isGreaterThan(secondStep.state().errorCovariance());
    }

    @Test
    void innovationIsTheRealGapBetweenTheObservationAndThePredictedObservation() {
        KalmanFilter filter = new KalmanFilter(1.0, 1.0, 0.0, 1.0);
        KalmanFilter.State prior = new KalmanFilter.State(5.0, 1.0);
        var step = filter.step(prior, 8.0);
        assertThat(step.predictedObservation()).isEqualTo(5.0);
        assertThat(step.innovation()).isEqualTo(3.0);
    }
}
