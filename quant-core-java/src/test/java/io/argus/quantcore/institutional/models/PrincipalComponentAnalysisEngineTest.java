package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class PrincipalComponentAnalysisEngineTest {

    @Test
    void firstComponentExplainsMostVarianceWhenTwoFeaturesAreHighlyCorrelated() {
        Random rnd = new Random(9);
        int n = 200;
        double[][] data = new double[n][2];
        for (int i = 0; i < n; i++) {
            double base = rnd.nextGaussian();
            data[i][0] = base;
            data[i][1] = base * 2 + rnd.nextGaussian() * 0.05; // almost perfectly collinear
        }
        var result = PrincipalComponentAnalysisEngine.evaluate(data);
        assertThat(result).isNotNull();
        assertThat(result.explainedVarianceRatio()[0]).isGreaterThan(0.95);

        double sumRatios = 0;
        for (double r : result.explainedVarianceRatio()) sumRatios += r;
        assertThat(sumRatios).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-6));
    }

    @Test
    void splitsVarianceRoughlyEvenlyAcrossTwoIndependentFeatures() {
        Random rnd = new Random(10);
        int n = 500;
        double[][] data = new double[n][2];
        for (int i = 0; i < n; i++) {
            data[i][0] = rnd.nextGaussian();
            data[i][1] = rnd.nextGaussian(); // independent of feature 0, same variance
        }
        var result = PrincipalComponentAnalysisEngine.evaluate(data);
        assertThat(result.explainedVarianceRatio()[0]).isBetween(0.3, 0.7);
    }

    @Test
    void projectedScoresHaveTheSameRowCountAsTheInputData() {
        double[][] data = { { 1, 2 }, { 3, 4 }, { 5, 6 }, { 7, 8 } };
        var result = PrincipalComponentAnalysisEngine.evaluate(data);
        assertThat(result.projectedScores()).hasNumberOfRows(4);
    }

    @Test
    void returnsNullForFewerThanTwoObservations() {
        double[][] data = { { 1, 2 } };
        assertThat(PrincipalComponentAnalysisEngine.evaluate(data)).isNull();
    }
}
