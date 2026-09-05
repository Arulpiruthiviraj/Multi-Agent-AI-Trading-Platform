package io.argus.quantcore.institutional.models;

import io.argus.quantcore.backtest.engine.Bar;
import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class FactorAlphaEngineTest {

    @Test
    void computesAPositiveMomentumFactorForARecentBreakoutAfterAFlatPeriod() {
        // Every factor here is itself a Z-score of the LAST value against its own trailing
        // window - so a "steady, constant-rate" uptrend has a provably CONSTANT trailing N-day
        // return series (zero variance -> RollingStatistics.zScore correctly returns null rather
        // than dividing by ~0), and a "steady uptrend + small noise" makes the sign of the last
        // Z-score a coin flip (it measures deviation from the window's OWN recent average, not
        // the sign of the underlying trend). To get a momentum Z-score that is unambiguously
        // positive by construction (not by lucky seed choice), the last ~50 bars have to be a
        // real acceleration relative to a flat first ~150 bars - exactly what a momentum factor
        // is supposed to detect (a recent breakout), not a generic "line goes up."
        Random rnd = new Random(4242);
        int n = 200;
        Bar[] bars = new Bar[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            double dailyReturn = i < 150 ? rnd.nextGaussian() * 0.001 : 0.01 + rnd.nextGaussian() * 0.001;
            double open = price;
            double close = price * (1 + dailyReturn);
            double high = Math.max(open, close) * (1.0005 + Math.abs(rnd.nextGaussian()) * 0.0003);
            double low = Math.min(open, close) * (1 - 0.0005 - Math.abs(rnd.nextGaussian()) * 0.0003);
            double volume = 1_000_000 + Math.max(0, i - 150) * 5000 + rnd.nextGaussian() * 10_000;
            bars[i] = new Bar(i, open, high, low, close, volume);
            price = close;
        }

        FactorAlphaEngine.FactorScores scores = FactorAlphaEngine.compute(bars, 20, 10, 60);
        assertThat(scores).isNotNull();
        assertThat(scores.momentum()).isGreaterThan(0);
        assertThat(scores.composite()).isFinite();
        assertThat(scores.meanReversion()).isFinite();
        assertThat(scores.volumeLiquidity()).isFinite();
        assertThat(scores.volatility()).isFinite();
        assertThat(scores.orderFlowProxy()).isFinite();
    }

    @Test
    void returnsNullWhenNotEnoughBarHistory() {
        Bar[] tiny = {new Bar(0, 100, 101, 99, 100.5, 1000)};
        assertThat(FactorAlphaEngine.compute(tiny, 20, 10, 60)).isNull();
    }
}
