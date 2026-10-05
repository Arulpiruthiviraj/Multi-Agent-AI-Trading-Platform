package io.argus.quantcore.strategy.institutional;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.strategy.types.StrategyEvaluation;
import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class TimeSeriesMomentum12MStrategyTest {

    private static Bar[] driftBars(int n, double dailyDrift, double dailyNoise, long seed) {
        Random rnd = new Random(seed);
        Bar[] bars = new Bar[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            double dailyReturn = dailyDrift + rnd.nextGaussian() * dailyNoise;
            double open = price;
            double close = price * (1 + dailyReturn);
            bars[i] = new Bar(i, open, Math.max(open, close) * 1.001, Math.min(open, close) * 0.999, close, 1_000_000);
            price = close;
        }
        return bars;
    }

    @Test
    void producesBuySignalForYearLongUptrend() {
        // 0.08%/day drift, 1% noise over 340 bars: 12-1 formation strongly positive.
        Bar[] bars = driftBars(340, 0.0008, 0.01, 4242);
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", bars);
        StrategyEvaluation eval = new TimeSeriesMomentum12MStrategy().evaluate(ctx);
        assertThat(eval.strategy()).isEqualTo(TimeSeriesMomentum12MStrategy.ID);
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.BUY);
        assertThat(eval.triggerMet()).isTrue();
        assertThat(eval.setupScore()).isGreaterThan(0);
    }

    @Test
    void producesSellSignalForYearLongDowntrend() {
        Bar[] bars = driftBars(340, -0.0008, 0.01, 4243);
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", bars);
        StrategyEvaluation eval = new TimeSeriesMomentum12MStrategy().evaluate(ctx);
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.SELL);
        assertThat(eval.triggerMet()).isTrue();
    }

    @Test
    void skipMonthReversalGuardBlocksUnwindingTrend() {
        // Strong 11-month uptrend, then a violent -15% final month: the reversal guard
        // must block the trigger even though the 12-1 formation is still positive.
        Random rnd = new Random(4244);
        int n = 340;
        Bar[] bars = new Bar[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            double dailyReturn = i < n - 21 ? 0.001 + rnd.nextGaussian() * 0.008
                                           : -0.008 + rnd.nextGaussian() * 0.01;
            double open = price;
            double close = price * (1 + dailyReturn);
            bars[i] = new Bar(i, open, Math.max(open, close) * 1.001, Math.min(open, close) * 0.999, close, 1_000_000);
            price = close;
        }
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", bars);
        StrategyEvaluation eval = new TimeSeriesMomentum12MStrategy().evaluate(ctx);
        assertThat(eval.triggerMet()).isFalse();
        assertThat(eval.contradictions()).isNotEmpty();
    }

    @Test
    void returnsNoSignalWhenNotEnoughHistory() {
        Bar[] tiny = {new Bar(0, 100, 101, 99, 100.5, 1000)};
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", tiny);
        StrategyEvaluation eval = new TimeSeriesMomentum12MStrategy().evaluate(ctx);
        assertThat(eval.setupScore()).isEqualTo(0);
        assertThat(eval.triggerMet()).isFalse();
        assertThat(eval.conditionsFailed()).isNotEmpty();
    }
}
