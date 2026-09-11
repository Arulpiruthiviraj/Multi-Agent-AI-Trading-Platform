package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Shishlenin, Harke &amp; Koppisetti (2019) "Application of algorithmic trading strategies for
 * retail investors" - Sec 3.2.1 (Eq. 1), Sec 3.2.2 (Eq. 2), Appendix A.
 */
class SmartBetaFactorEngineTest {

    @Test
    void crossSectionalZScores_isNullRatherThanFabricated_forFewerThanTwoOrZeroVariance() {
        assertThat(SmartBetaFactorEngine.crossSectionalZScores(new double[]{5})).isNull();
        assertThat(SmartBetaFactorEngine.crossSectionalZScores(new double[0])).isNull();
        assertThat(SmartBetaFactorEngine.crossSectionalZScores(new double[]{3, 3, 3})).isNull(); // zero variance
    }

    @Test
    void crossSectionalZScores_hasZeroMeanAndUnitVariance() {
        double[] values = {10, 20, 30, 40, 50};
        double[] z = SmartBetaFactorEngine.crossSectionalZScores(values);
        assertThat(z).isNotNull();
        double mean = java.util.Arrays.stream(z).average().orElseThrow();
        assertThat(mean).isCloseTo(0.0, within(1e-9));
        double variance = java.util.Arrays.stream(z).map(v -> v * v).average().orElseThrow();
        assertThat(variance).isCloseTo(1.0, within(1e-9));
    }

    @Test
    void valueScores_cheaperAndHigherYieldingSecurityScoresHigher() {
        // Security A: cheap (low P/B, P/E, P/CF) and high dividend yield -> should score highest.
        // Security B: expensive and low yield -> should score lowest.
        // Security C: in between.
        SmartBetaFactorEngine.ValueInputs[] universe = {
            new SmartBetaFactorEngine.ValueInputs(1.0, 8.0, 5.0, 0.05),   // A: cheap, high yield
            new SmartBetaFactorEngine.ValueInputs(3.0, 20.0, 15.0, 0.02), // B: mid
            new SmartBetaFactorEngine.ValueInputs(6.0, 35.0, 25.0, 0.00), // C: expensive, no yield
        };
        double[] scores = SmartBetaFactorEngine.valueScores(universe);
        assertThat(scores).isNotNull();
        assertThat(scores[0]).isGreaterThan(scores[1]);
        assertThat(scores[1]).isGreaterThan(scores[2]);
    }

    @Test
    void valueScores_isNullRatherThanFabricated_whenAnyFactorHasZeroCrossSectionalVariance() {
        SmartBetaFactorEngine.ValueInputs[] universe = {
            new SmartBetaFactorEngine.ValueInputs(1.0, 8.0, 5.0, 0.05),
            new SmartBetaFactorEngine.ValueInputs(1.0, 20.0, 15.0, 0.02), // same P/B as above -> zero variance in P/B
        };
        assertThat(SmartBetaFactorEngine.valueScores(universe)).isNull();
    }

    @Test
    void qualityScores_lowLeverageStableHighReturnSecurityScoresHigher() {
        SmartBetaFactorEngine.QualityInputs[] universe = {
            new SmartBetaFactorEngine.QualityInputs(0.2, 0.05, 0.15, 0.20, 500), // A: low leverage, stable, profitable
            new SmartBetaFactorEngine.QualityInputs(0.8, 0.15, 0.08, 0.10, 200), // B: mid
            new SmartBetaFactorEngine.QualityInputs(2.0, 0.30, 0.02, 0.03, 50),  // C: high leverage, volatile, weak
        };
        double[] scores = SmartBetaFactorEngine.qualityScores(universe);
        assertThat(scores).isNotNull();
        assertThat(scores[0]).isGreaterThan(scores[1]);
        assertThat(scores[1]).isGreaterThan(scores[2]);
    }

    @Test
    void winsorize_clipsOutliersToTheSigmaBoundaryButLeavesNormalValuesUnchanged() {
        // A real property of naive one-pass winsorization, confirmed here rather than assumed: a
        // SINGLE extreme outlier among only a handful of points inflates its own std dev enough
        // to escape a 3-sigma test computed from that same small sample (e.g. {10,11,9,10,12,1000}
        // has mean~175, std~369, so 1000 sits inside mean+3*std~1282 and is NOT clipped - verified
        // by direct calculation, not a bug in the implementation). A larger baseline sample, where
        // the outlier no longer dominates the mean/variance estimate, is needed to actually
        // exercise clipping - 19 clustered points at 10 plus one outlier at 50.
        double[] values = new double[20];
        for (int i = 0; i < 19; i++) values[i] = 10;
        values[19] = 50;
        double[] winsorized = SmartBetaFactorEngine.winsorize(values, 3.0);

        assertThat(winsorized[19]).isLessThan(values[19]); // the outlier was clipped down
        // Non-outlier values within 3 sigma should be unchanged.
        assertThat(winsorized[0]).isEqualTo(10.0);
        assertThat(winsorized[10]).isEqualTo(10.0);
    }

    @Test
    void winsorize_returnsUnchangedInput_forZeroVarianceOrTooFewValues() {
        double[] constant = {5, 5, 5};
        assertThat(SmartBetaFactorEngine.winsorize(constant, 3.0)).containsExactly(5, 5, 5);
        double[] single = {7};
        assertThat(SmartBetaFactorEngine.winsorize(single, 3.0)).containsExactly(7);
    }

    @Test
    void winsorizedScoreWeighting_selectsTopNAndWeightsProportionallyToWinsorizedScore() {
        double[] scores = {5.0, 3.0, 1.0, -2.0, -5.0};
        SmartBetaFactorEngine.RankedSecurity[] result = SmartBetaFactorEngine.winsorizedScoreWeighting(scores, 3, 3.0);

        assertThat(result).isNotNull();
        assertThat(result).hasSize(3);
        // Selected the top 3 by score (indices 0,1,2 -> scores 5,3,1), in descending order.
        assertThat(result[0].originalIndex()).isEqualTo(0);
        assertThat(result[1].originalIndex()).isEqualTo(1);
        assertThat(result[2].originalIndex()).isEqualTo(2);
        // Weights sum to 1 and are monotonically decreasing with score.
        double weightSum = result[0].weight() + result[1].weight() + result[2].weight();
        assertThat(weightSum).isCloseTo(1.0, within(1e-9));
        assertThat(result[0].weight()).isGreaterThan(result[1].weight());
        assertThat(result[1].weight()).isGreaterThan(result[2].weight());
    }

    @Test
    void winsorizedScoreWeighting_isNullRatherThanFabricated_whenSelectedScoresSumNonPositive() {
        // All negative scores -> winsorized sum is negative -> no meaningful long-only weight scheme.
        double[] scores = {-1.0, -2.0, -3.0};
        assertThat(SmartBetaFactorEngine.winsorizedScoreWeighting(scores, 3, 3.0)).isNull();
    }

    @Test
    void winsorizedScoreWeighting_capsSelectionAtAvailableUniverseSize() {
        double[] scores = {2.0, 1.0};
        SmartBetaFactorEngine.RankedSecurity[] result = SmartBetaFactorEngine.winsorizedScoreWeighting(scores, 10, 3.0);
        assertThat(result).isNotNull();
        assertThat(result).hasSize(2);
    }
}
