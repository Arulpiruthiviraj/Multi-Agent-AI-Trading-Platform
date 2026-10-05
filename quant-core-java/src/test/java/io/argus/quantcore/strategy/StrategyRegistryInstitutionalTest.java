package io.argus.quantcore.strategy;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.strategy.institutional.InstitutionalStrategyContext;
import io.argus.quantcore.strategy.institutional.TimeSeriesMomentum12MStrategy;
import io.argus.quantcore.strategy.institutional.VolScaledMtfMomentumStrategy;
import io.argus.quantcore.strategy.types.StrategyEvaluation;
import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 2026-10-05: proves the two new institutional momentum strategies are registered in
 * StrategyRegistry.INSTITUTIONAL and dispatch to the right implementation through
 * evaluateInstitutional(...). Deterministic synthetic bars (fixed seeds) - no market data.
 */
class StrategyRegistryInstitutionalTest {

    private static Bar[] trendBars(int n, long seed, double drift) {
        Random rnd = new Random(seed);
        Bar[] bars = new Bar[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            double dailyReturn = drift + rnd.nextGaussian() * 0.008;
            double open = price;
            double close = price * (1 + dailyReturn);
            bars[i] = new Bar(i, open, Math.max(open, close) * 1.001,
                    Math.min(open, close) * 0.999, close, 1_000_000);
            price = close;
        }
        return bars;
    }

    @Test
    void bothNewStrategiesAreInstitutional() {
        assertThat(StrategyRegistry.isInstitutionalStrategy(VolScaledMtfMomentumStrategy.ID)).isTrue();
        assertThat(StrategyRegistry.isInstitutionalStrategy(TimeSeriesMomentum12MStrategy.ID)).isTrue();
        assertThat(StrategyRegistry.isInstitutionalStrategy("NO_SUCH_STRATEGY")).isFalse();
        // Institutional ids must not leak into the CORE map.
        assertThat(StrategyRegistry.isCoreStrategy(VolScaledMtfMomentumStrategy.ID)).isFalse();
        assertThat(StrategyRegistry.isCoreStrategy(TimeSeriesMomentum12MStrategy.ID)).isFalse();
    }

    @Test
    void volScaledMtfMomentumDispatchesThroughRegistry() {
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", trendBars(150, 4242, 0.003));
        var eval = StrategyRegistry.evaluateInstitutional(VolScaledMtfMomentumStrategy.ID, ctx);
        assertThat(eval).isPresent();
        StrategyEvaluation e = eval.get();
        assertThat(e.strategy()).isEqualTo(VolScaledMtfMomentumStrategy.ID);
        assertThat(e.side()).isEqualTo(StrategyEvaluation.Side.BUY);
        assertThat(e.triggerMet()).isTrue();
    }

    @Test
    void timeSeriesMomentum12MDispatchesThroughRegistry() {
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", trendBars(400, 4243, 0.002));
        var eval = StrategyRegistry.evaluateInstitutional(TimeSeriesMomentum12MStrategy.ID, ctx);
        assertThat(eval).isPresent();
        StrategyEvaluation e = eval.get();
        assertThat(e.strategy()).isEqualTo(TimeSeriesMomentum12MStrategy.ID);
        assertThat(e.side()).isEqualTo(StrategyEvaluation.Side.BUY);
        assertThat(e.triggerMet()).isTrue();
    }

    @Test
    void unknownInstitutionalIdReturnsEmpty() {
        var ctx = InstitutionalStrategyContext.singleSymbol("AAPL", trendBars(150, 4244, 0.003));
        assertThat(StrategyRegistry.evaluateInstitutional("NO_SUCH_STRATEGY", ctx)).isEmpty();
    }
}
