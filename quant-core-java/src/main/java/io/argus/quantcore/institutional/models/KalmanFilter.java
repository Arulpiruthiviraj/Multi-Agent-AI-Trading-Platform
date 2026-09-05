package io.argus.quantcore.institutional.models;

/**
 * Scalar linear-Gaussian Kalman filter (Kalman, "A New Approach to Linear Filtering and
 * Prediction Problems", 1960) - the standard predict/update recursion, configurable enough to
 * serve as a local-level model (F=1, H=1: state is a noisy random walk, e.g. a smoothed "fair
 * value" estimate) or an AR(1)-style latent state (F=phi). General state-space filtering; not
 * specific to one particular quant use case.
 */
public final class KalmanFilter {

    private final double transitionF;
    private final double observationH;
    private final double processNoiseQ;
    private final double observationNoiseR;

    /**
     * @param transitionF        state transition coefficient (state_t = F*state_{t-1} + processNoise).
     * @param observationH       observation coefficient (obs_t = H*state_t + observationNoise).
     * @param processNoiseQ      process noise variance (&gt;= 0).
     * @param observationNoiseR  observation noise variance (&gt; 0).
     */
    public KalmanFilter(double transitionF, double observationH, double processNoiseQ, double observationNoiseR) {
        this.transitionF = transitionF;
        this.observationH = observationH;
        this.processNoiseQ = processNoiseQ;
        this.observationNoiseR = observationNoiseR;
    }

    public record State(double stateEstimate, double errorCovariance) {
    }

    public record StepResult(State state, double predictedObservation, double innovation, double kalmanGain) {
    }

    /** One real predict+update cycle given the prior state and a new real observation. */
    public StepResult step(State prior, double observation) {
        double statePred = transitionF * prior.stateEstimate();
        double covPred = transitionF * transitionF * prior.errorCovariance() + processNoiseQ;

        double predictedObservation = observationH * statePred;
        double innovation = observation - predictedObservation;
        double innovationCovariance = observationH * observationH * covPred + observationNoiseR;
        double gain = innovationCovariance != 0 ? (covPred * observationH) / innovationCovariance : 0;

        double newState = statePred + gain * innovation;
        double newCov = (1 - gain * observationH) * covPred;

        return new StepResult(new State(newState, newCov), predictedObservation, innovation, gain);
    }

    /** Runs the filter across a full real observation series, returning the filtered state estimate at each step. */
    public double[] filterSeries(double[] observations, double initialStateEstimate, double initialErrorCovariance) {
        double[] filtered = new double[observations.length];
        State state = new State(initialStateEstimate, initialErrorCovariance);
        for (int t = 0; t < observations.length; t++) {
            StepResult result = step(state, observations[t]);
            filtered[t] = result.state().stateEstimate();
            state = result.state();
        }
        return filtered;
    }
}
