package io.argus.quantcore.strategy.core;

import io.argus.quantcore.strategy.types.StrategyContext;
import io.argus.quantcore.strategy.types.StrategyEvaluation;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Parity against the real momentumBreakout/pullbackContinuation/meanReversion/trendFollowing/
 * rangeReversion.ts strategies, run on identical synthetic StrategyContext fixtures (see
 * StrategyFixtures.java / scripts/java_parity_fixtures_phase1.ts, ground truth captured 2026-08-21).
 * This validates the strategies' own decision logic in isolation — the upstream feature
 * computation (RegimeEngine/trend/volume/etc.) that would populate a real StrategyContext from
 * live bars is NOT ported here (see StrategyContext.java's header comment).
 */
class StrategyParityTest {

    @Test
    void momentumBreakoutBullishMatchesTypeScript() {
        StrategyEvaluation eval = new MomentumBreakout().evaluate(StrategyFixtures.momentumBreakoutBullish());
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.BUY);
        assertThat(eval.setupScore()).isEqualTo(100);
        assertThat(eval.confidence()).isEqualTo(1.0);
        assertThat(eval.conditionsMet()).hasSize(8);
        assertThat(eval.conditionsFailed()).isEmpty();
        assertThat(eval.contradictions()).isEmpty();
    }

    @Test
    void momentumBreakoutBearishMatchesTypeScript() {
        StrategyEvaluation eval = new MomentumBreakout().evaluate(StrategyFixtures.momentumBreakoutBearish());
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.SELL);
        assertThat(eval.setupScore()).isEqualTo(100);
        assertThat(eval.conditionsMet()).hasSize(8);
        assertThat(eval.conditionsFailed()).isEmpty();
    }

    @Test
    void pullbackContinuationBullishMatchesTypeScript() {
        StrategyEvaluation eval = new PullbackContinuation().evaluate(StrategyFixtures.momentumBreakoutBullish());
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.BUY);
        assertThat(eval.setupScore()).isEqualTo(83);
        assertThat(eval.confidence()).isCloseTo(0.83, org.assertj.core.api.Assertions.within(0.001));
        assertThat(eval.conditionsMet()).hasSize(5);
        assertThat(eval.conditionsFailed()).hasSize(1);
    }

    @Test
    void pullbackContinuationBearishMatchesTypeScript() {
        StrategyEvaluation eval = new PullbackContinuation().evaluate(StrategyFixtures.momentumBreakoutBearish());
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.SELL);
        assertThat(eval.setupScore()).isEqualTo(83);
        assertThat(eval.conditionsMet()).hasSize(5);
        assertThat(eval.conditionsFailed()).hasSize(1);
    }

    @Test
    void meanReversionRangingMatchesTypeScript() {
        StrategyEvaluation eval = new MeanReversion().evaluate(StrategyFixtures.rangingNeutral());
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.BUY);
        assertThat(eval.setupScore()).isEqualTo(80);
        assertThat(eval.conditionsMet()).hasSize(4);
        assertThat(eval.conditionsFailed()).hasSize(1);
    }

    @Test
    void trendFollowingBullishMatchesTypeScript() {
        StrategyEvaluation eval = new TrendFollowing().evaluate(StrategyFixtures.momentumBreakoutBullish());
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.BUY);
        assertThat(eval.setupScore()).isEqualTo(100);
        assertThat(eval.conditionsMet()).hasSize(6);
        assertThat(eval.conditionsFailed()).isEmpty();
    }

    @Test
    void trendFollowingBearishMatchesTypeScript() {
        StrategyEvaluation eval = new TrendFollowing().evaluate(StrategyFixtures.momentumBreakoutBearish());
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.SELL);
        assertThat(eval.setupScore()).isEqualTo(100);
        assertThat(eval.conditionsMet()).hasSize(6);
    }

    @Test
    void rangeReversionRangingMatchesTypeScript() {
        StrategyEvaluation eval = new RangeReversion().evaluate(StrategyFixtures.rangingNeutral());
        assertThat(eval.side()).isEqualTo(StrategyEvaluation.Side.BUY);
        assertThat(eval.setupScore()).isEqualTo(100);
        assertThat(eval.conditionsMet()).hasSize(5);
        assertThat(eval.conditionsFailed()).isEmpty();
    }

    @Test
    void strategyRegistryDispatchesById() {
        var eval = io.argus.quantcore.strategy.StrategyRegistry.evaluate(
            MomentumBreakout.ID, StrategyFixtures.momentumBreakoutBullish());
        assertThat(eval).isPresent();
        assertThat(eval.get().side()).isEqualTo(StrategyEvaluation.Side.BUY);

        assertThat(io.argus.quantcore.strategy.StrategyRegistry.isCoreStrategy("NOT_A_REAL_ID")).isFalse();
        assertThat(io.argus.quantcore.strategy.StrategyRegistry.evaluate("NOT_A_REAL_ID", StrategyFixtures.rangingNeutral())).isEmpty();
    }
}
