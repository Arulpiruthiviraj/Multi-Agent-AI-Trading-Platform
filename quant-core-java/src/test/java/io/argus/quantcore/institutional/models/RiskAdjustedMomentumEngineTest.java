package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class RiskAdjustedMomentumEngineTest {

    @Test
    void computesTheHeadlineScoreAsMeanDividedByStdDev_forAKnownSmallSeries() {
        // Closes for t=14 (oldest) down to t=0 (now), skip=1, formation=12: uses closes[0..13].
        // Perfectly constant 1% compounding produces bit-identical periodic returns in IEEE754
        // double arithmetic (verified: stddev computes to exactly 0), which is a genuinely
        // degenerate input for a ratio-of-variance formula, not a "near constant" one - a tiny
        // deterministic wobble keeps the series close to +1%/period while giving it real,
        // non-degenerate variance.
        double[] closes = new double[15];
        closes[0] = 100.0;
        for (int i = 1; i < closes.length; i++) {
            double wobble = (i % 2 == 0) ? 0.0005 : -0.0005;
            closes[i] = closes[i - 1] * (1.01 + wobble);
        }

        var result = RiskAdjustedMomentumEngine.evaluate(closes, 1, 12);

        assertThat(result).isNotNull();
        assertThat(result.meanPeriodicReturn()).isCloseTo(0.01, within(1e-3));
        assertThat(result.riskAdjustedMomentum()).isGreaterThan(0);
    }

    @Test
    void higherVolatilityWithTheSameMeanReturn_producesALowerRiskAdjustedScore() {
        Random rnd = new Random(7);
        int n = 20;
        double[] steady = new double[n];
        double[] volatile_ = new double[n];
        steady[0] = 100.0;
        volatile_[0] = 100.0;
        for (int i = 1; i < n; i++) {
            // Same real-variance-fixing wobble as above - perfectly constant compounding is a
            // degenerate (exactly zero variance) input, not a "low volatility" one.
            double wobble = (i % 2 == 0) ? 0.0005 : -0.0005;
            steady[i] = steady[i - 1] * (1.01 + wobble);
            double noisyReturn = 0.01 + (rnd.nextBoolean() ? 0.05 : -0.05);
            volatile_[i] = volatile_[i - 1] * (1 + noisyReturn);
        }

        var steadyResult = RiskAdjustedMomentumEngine.evaluate(steady, 1, 12);
        var volatileResult = RiskAdjustedMomentumEngine.evaluate(volatile_, 1, 12);

        assertThat(steadyResult).isNotNull();
        assertThat(volatileResult).isNotNull();
        assertThat(steadyResult.riskAdjustedMomentum()).isGreaterThan(volatileResult.riskAdjustedMomentum());
    }

    @Test
    void cumulativeReturnMatchesSimpleTotalReturnOverTheFormationWindow() {
        double[] closes = new double[15];
        for (int i = 0; i < closes.length; i++) {
            closes[i] = 100 + i * 5; // closes[14] = 170 (now), closes[1] = 105 (P(S), skip=1), closes[1+12]=closes[13]=165 -> wait recompute
        }
        // last=14, skip=1 -> P(S) = closes[13] = 165; P(S+T) with T=12 -> closes[13-12]=closes[1]=105
        var result = RiskAdjustedMomentumEngine.evaluate(closes, 1, 12);

        assertThat(result).isNotNull();
        double expectedCumulative = closes[13] / closes[1] - 1;
        assertThat(result.cumulativeReturn()).isCloseTo(expectedCumulative, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenThereIsNotEnoughHistory() {
        double[] closes = new double[10]; // needs skip+formation+1 = 14
        for (int i = 0; i < closes.length; i++) closes[i] = 100 + i;

        assertThat(RiskAdjustedMomentumEngine.evaluate(closes, 1, 12)).isNull();
    }

    @Test
    void returnsNull_whenTheFormationPeriodReturnsHaveZeroVariance() {
        // Perfectly constant price -> all periodic returns are exactly 0 -> zero stddev.
        double[] closes = new double[15];
        for (int i = 0; i < closes.length; i++) closes[i] = 100.0;

        assertThat(RiskAdjustedMomentumEngine.evaluate(closes, 1, 12)).isNull();
    }

    @Test
    void defaultOverload_usesThePapersOwnConventionalSkip1Formation12() {
        double[] closes = new double[15];
        closes[0] = 100.0;
        for (int i = 1; i < closes.length; i++) {
            double wobble = (i % 2 == 0) ? 0.0005 : -0.0005;
            closes[i] = closes[i - 1] * (1.01 + wobble);
        }

        var withDefaults = RiskAdjustedMomentumEngine.evaluate(closes);
        var withExplicitArgs = RiskAdjustedMomentumEngine.evaluate(closes, 1, 12);

        assertThat(withDefaults).isNotNull();
        assertThat(withDefaults).isEqualTo(withExplicitArgs);
    }
}
