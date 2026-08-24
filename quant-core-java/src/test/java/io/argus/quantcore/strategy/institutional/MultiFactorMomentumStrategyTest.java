package io.argus.quantcore.strategy.institutional;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.strategy.types.StrategyEvaluation;
import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class MultiFactorMomentumStrategyTest {

    @Test
    void producesABuySignalForARecentBreakoutAfterAFlatPeriod() {
        // See FactorAlphaEngineTest's header for why a "flat then breakout" construction, not a
        // steady uptrend, is what deterministically produces a positive composite Z-score here.
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
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", bars);
        StrategyEvaluation eval = new MultiFactorMomentumStrategy().evaluate(ctx);
        assertThat(eval.strategy()).isEqualTo(MultiFactorMomentumStrategy.ID);
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.BUY);
        assertThat(eval.setupScore()).isGreaterThan(0);
    }

    @Test
    void returnsNoSignalWhenNotEnoughHistory() {
        Bar[] tiny = {new Bar(0, 100, 101, 99, 100.5, 1000)};
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", tiny);
        StrategyEvaluation eval = new MultiFactorMomentumStrategy().evaluate(ctx);
        assertThat(eval.setupScore()).isEqualTo(0);
        assertThat(eval.conditionsFailed()).isNotEmpty();
    }
}
