package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ParabolicSarEngineTest {

    @Test
    void staysInAnUptrend_withSarBelowPrice_duringACleanRally() {
        int n = 30;
        double[] highs = new double[n];
        double[] lows = new double[n];
        for (int i = 0; i < n; i++) {
            highs[i] = 100 + i * 2.0;
            lows[i] = 100 + i * 2.0 - 1.0; // steady, non-overlapping higher highs and higher lows
        }

        var result = ParabolicSarEngine.evaluate(highs, lows);

        assertThat(result).isNotNull();
        assertThat(result.uptrend()).isTrue();
        assertThat(result.signal()).isEqualTo("BUY");
        assertThat(result.sar()).isLessThan(lows[n - 1]); // trailing stop sits below price in an uptrend
    }

    @Test
    void reversesToADowntrend_whenACleanRallyIsFollowedByASharpDrop() {
        int n = 20;
        double[] highs = new double[n];
        double[] lows = new double[n];
        for (int i = 0; i < 15; i++) {
            highs[i] = 100 + i * 2.0;
            lows[i] = 100 + i * 2.0 - 1.0;
        }
        // Sharp reversal: each subsequent bar's high/low is well below the established SAR.
        for (int i = 15; i < n; i++) {
            highs[i] = 100 - (i - 14) * 5.0;
            lows[i] = highs[i] - 2.0;
        }

        var series = ParabolicSarEngine.calculate(highs, lows);

        assertThat(series).isNotNull();
        boolean sawReversalToDowntrend = false;
        for (int i = 15; i < n; i++) {
            if (!series.uptrend()[i]) {
                sawReversalToDowntrend = true;
                break;
            }
        }
        assertThat(sawReversalToDowntrend).isTrue();
    }

    @Test
    void seedsAtTheFirstBarsLowInAnAssumedInitialUptrend() {
        double[] highs = { 105, 106 };
        double[] lows = { 100, 101 };

        var series = ParabolicSarEngine.calculate(highs, lows);

        assertThat(series).isNotNull();
        assertThat(series.sar()[0]).isEqualTo(100.0);
        assertThat(series.uptrend()[0]).isTrue();
    }

    @Test
    void returnsNullRatherThanFabricatingWithFewerThanTwoBars() {
        double[] highs = { 100 };
        double[] lows = { 99 };
        assertThat(ParabolicSarEngine.calculate(highs, lows)).isNull();
    }
}
