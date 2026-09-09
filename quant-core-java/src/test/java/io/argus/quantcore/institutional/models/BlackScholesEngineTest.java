package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class BlackScholesEngineTest {

    // Hull, "Options, Futures, and Other Derivatives" - the textbook's own standard worked
    // example: S=42, K=40, r=0.10, q=0, sigma=0.20, T=0.5 -> call ~4.76, put ~0.81.
    private static final double S = 42, K = 40, R = 0.10, Q = 0.0, SIGMA = 0.20, T = 0.5;

    @Test
    void callPrice_matchesHullsWellKnownTextbookExample() {
        var result = BlackScholesEngine.call(S, K, R, Q, SIGMA, T);
        assertThat(result).isNotNull();
        assertThat(result.price()).isCloseTo(4.76, within(0.02));
    }

    @Test
    void putPrice_matchesHullsWellKnownTextbookExample() {
        var result = BlackScholesEngine.put(S, K, R, Q, SIGMA, T);
        assertThat(result).isNotNull();
        assertThat(result.price()).isCloseTo(0.81, within(0.02));
    }

    @Test
    void putCallParity_holdsExactly_asAModelIndependentIdentity() {
        var call = BlackScholesEngine.call(S, K, R, Q, SIGMA, T);
        var put = BlackScholesEngine.put(S, K, R, Q, SIGMA, T);
        assertThat(call).isNotNull();
        assertThat(put).isNotNull();

        double lhs = call.price() - put.price();
        double rhs = S * Math.exp(-Q * T) - K * Math.exp(-R * T);
        assertThat(lhs).isCloseTo(rhs, within(1e-9));
    }

    @Test
    void callDelta_isBetweenZeroAndOne_andPutDeltaBetweenMinusOneAndZero() {
        var call = BlackScholesEngine.call(S, K, R, Q, SIGMA, T);
        var put = BlackScholesEngine.put(S, K, R, Q, SIGMA, T);
        assertThat(call.delta()).isBetween(0.0, 1.0);
        assertThat(put.delta()).isBetween(-1.0, 0.0);
    }

    @Test
    void gammaIsIdenticalForCallAndPutAtTheSameStrike_aKnownIdentity() {
        var call = BlackScholesEngine.call(S, K, R, Q, SIGMA, T);
        var put = BlackScholesEngine.put(S, K, R, Q, SIGMA, T);
        assertThat(call.gamma()).isCloseTo(put.gamma(), within(1e-9));
    }

    @Test
    void vegaIsIdenticalForCallAndPutAtTheSameStrike_aKnownIdentity() {
        var call = BlackScholesEngine.call(S, K, R, Q, SIGMA, T);
        var put = BlackScholesEngine.put(S, K, R, Q, SIGMA, T);
        assertThat(call.vega()).isCloseTo(put.vega(), within(1e-9));
    }

    @Test
    void deepInTheMoneyCall_convergesToIntrinsicDeltaOfOne() {
        var result = BlackScholesEngine.call(1000, 40, R, Q, SIGMA, T);
        assertThat(result).isNotNull();
        assertThat(result.delta()).isCloseTo(1.0, within(1e-6));
    }

    @Test
    void returnsNullRatherThanFabricating_whenInputsInvalid() {
        assertThat(BlackScholesEngine.call(0, K, R, Q, SIGMA, T)).isNull();
        assertThat(BlackScholesEngine.call(S, K, R, Q, 0, T)).isNull();
        assertThat(BlackScholesEngine.call(S, K, R, Q, SIGMA, 0)).isNull();
    }
}
