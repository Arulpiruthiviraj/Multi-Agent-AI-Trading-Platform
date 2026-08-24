package io.argus.quantcore.strategy.institutional;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.strategy.types.StrategyEvaluation;
import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class InstitutionalStatArbStrategyTest {

    @Test
    void returnsNoSignalWhenNoPairConfigured() {
        Bar[] bars = simpleBars(50);
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", bars);
        StrategyEvaluation eval = new InstitutionalStatArbStrategy().evaluate(ctx);
        assertThat(eval.setupScore()).isEqualTo(0);
        assertThat(eval.conditionsFailed()).isNotEmpty();
    }

    @Test
    void producesASignalForACointegratedExtendedSpread() {
        Random rnd = new Random(321);
        int n = 400;
        double[] bPrice = new double[n];
        double[] aPrice = new double[n];
        double noise = 3.0; // start extended so the current Z-score is meaningfully non-zero
        bPrice[0] = 100;
        aPrice[0] = 2 * bPrice[0] + noise;
        for (int t = 1; t < n; t++) {
            bPrice[t] = bPrice[t - 1] + rnd.nextGaussian() * 0.3;
            noise = 0.3 * noise + rnd.nextGaussian() * 0.2;
            aPrice[t] = 2 * bPrice[t] + noise;
        }

        var ctx = InstitutionalStrategyContext.pair("A", toBars(aPrice), "B", toBars(bPrice));
        StrategyEvaluation eval = new InstitutionalStatArbStrategy().evaluate(ctx);
        assertThat(eval.strategy()).isEqualTo(InstitutionalStatArbStrategy.ID);
        assertThat(eval.conditionsMet()).isNotEmpty();
        assertThat(eval.confidence()).isBetween(0.0, 1.0);
    }

    private static Bar[] simpleBars(int n) {
        Bar[] bars = new Bar[n];
        for (int i = 0; i < n; i++) {
            bars[i] = new Bar(i, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000);
        }
        return bars;
    }

    private static Bar[] toBars(double[] close) {
        Bar[] bars = new Bar[close.length];
        for (int i = 0; i < close.length; i++) {
            bars[i] = new Bar(i, close[i], close[i], close[i], close[i], 1000);
        }
        return bars;
    }
}
