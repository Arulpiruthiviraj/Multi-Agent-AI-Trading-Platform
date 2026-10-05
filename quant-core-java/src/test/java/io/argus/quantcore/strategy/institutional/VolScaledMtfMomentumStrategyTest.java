package io.argus.quantcore.strategy.institutional;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.strategy.types.StrategyEvaluation;
import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class VolScaledMtfMomentumStrategyTest {

    private static Bar[] uptrendBars(int n, long seed) {
        Random rnd = new Random(seed);
        Bar[] bars = new Bar[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            // Steady drift + moderate noise: vol-scaled momentum should be strongly positive
            // on both the 20d and 60d windows.
            double dailyReturn = 0.003 + rnd.nextGaussian() * 0.008;
            double open = price;
            double close = price * (1 + dailyReturn);
            double high = Math.max(open, close) * 1.001;
            double low = Math.min(open, close) * 0.999;
            bars[i] = new Bar(i, open, high, low, close, 1_000_000);
            price = close;
        }
        return bars;
    }

    @Test
    void producesBuySignalForSteadyUptrend() {
        Bar[] bars = uptrendBars(150, 777);
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", bars);
        StrategyEvaluation eval = new VolScaledMtfMomentumStrategy().evaluate(ctx);
        assertThat(eval.strategy()).isEqualTo(VolScaledMtfMomentumStrategy.ID);
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.BUY);
        assertThat(eval.triggerMet()).isTrue();
        assertThat(eval.setupScore()).isGreaterThan(0);
        assertThat(eval.confidence()).isGreaterThan(0);
    }

    @Test
    void producesSellSignalForSteadyDowntrend() {
        Random rnd = new Random(778);
        int n = 150;
        Bar[] bars = new Bar[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            double dailyReturn = -0.003 + rnd.nextGaussian() * 0.008;
            double open = price;
            double close = price * (1 + dailyReturn);
            bars[i] = new Bar(i, open, Math.max(open, close) * 1.001, Math.min(open, close) * 0.999, close, 1_000_000);
            price = close;
        }
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", bars);
        StrategyEvaluation eval = new VolScaledMtfMomentumStrategy().evaluate(ctx);
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.SELL);
        assertThat(eval.triggerMet()).isTrue();
    }

    @Test
    void choppySidewaysTapeReturnsAWellFormedEvaluation() {
        Random rnd = new Random(779);
        int n = 150;
        Bar[] bars = new Bar[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            // Pure noise, zero drift.
            double dailyReturn = rnd.nextGaussian() * 0.01;
            double open = price;
            double close = price * (1 + dailyReturn);
            bars[i] = new Bar(i, open, Math.max(open, close) * 1.001, Math.min(open, close) * 0.999, close, 1_000_000);
            price = close;
        }
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", bars);
        StrategyEvaluation eval = new VolScaledMtfMomentumStrategy().evaluate(ctx);
        // Structural guarantees hold regardless of the (seed-dependent) trigger outcome:
        // scores are bounded, conditions are exhaustive, no contradictions invented.
        assertThat(eval.strategy()).isEqualTo(VolScaledMtfMomentumStrategy.ID);
        assertThat(eval.setupScore()).isBetween(0, 100);
        assertThat(eval.confidence()).isBetween(0.0, 1.0);
        assertThat(eval.conditionsMet().size() + eval.conditionsFailed().size()).isEqualTo(4);
    }

    @Test
    void returnsNoSignalWhenNotEnoughHistory() {
        Bar[] tiny = {new Bar(0, 100, 101, 99, 100.5, 1000)};
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", tiny);
        StrategyEvaluation eval = new VolScaledMtfMomentumStrategy().evaluate(ctx);
        assertThat(eval.setupScore()).isEqualTo(0);
        assertThat(eval.triggerMet()).isFalse();
        assertThat(eval.conditionsFailed()).isNotEmpty();
    }

    @Test
    void volScaledMomentumIsSharpeLike() {
        // 20 days of +1% daily returns with zero noise: sum = 0.2 log-return-ish,
        // vol = 0 -> NaN (degenerate). With tiny noise, score should be large positive.
        int n = 40;
        double[] rets = new double[n];
        Random rnd = new Random(780);
        for (int i = 0; i < n; i++) rets[i] = 0.01 + rnd.nextGaussian() * 0.0001;
        double score = VolScaledMtfMomentumStrategy.volScaledMomentum(rets, 20);
        assertThat(score).isGreaterThan(2.0);
    }
}
