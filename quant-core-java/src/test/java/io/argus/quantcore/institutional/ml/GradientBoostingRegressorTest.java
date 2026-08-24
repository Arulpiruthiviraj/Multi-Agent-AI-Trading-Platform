package io.argus.quantcore.institutional.ml;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class GradientBoostingRegressorTest {

    @Test
    void trainingErrorDecreasesAsMoreBoostingRoundsAreAdded() {
        Random rnd = new Random(21);
        int n = 200;
        double[][] x = new double[n][1];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            double v = rnd.nextDouble() * 10;
            x[i][0] = v;
            y[i] = v * v * 0.1 + rnd.nextGaussian() * 0.2;
        }

        var fewRounds = GradientBoostingRegressor.fit(x, y, 3, 2, 5, 0.1);
        var manyRounds = GradientBoostingRegressor.fit(x, y, 100, 2, 5, 0.1);
        assertThat(fewRounds).isNotNull();
        assertThat(manyRounds).isNotNull();

        double fewMse = mse(fewRounds, x, y);
        double manyMse = mse(manyRounds, x, y);
        assertThat(manyMse).isLessThan(fewMse);
    }

    private static double mse(GradientBoostingRegressor model, double[][] x, double[] y) {
        double sum = 0;
        for (int i = 0; i < y.length; i++) {
            double e = y[i] - model.predict(x[i]);
            sum += e * e;
        }
        return sum / y.length;
    }

    @Test
    void returnsNullForANonPositiveLearningRate() {
        double[][] x = { { 1 }, { 2 }, { 3 } };
        double[] y = { 1, 2, 3 };
        assertThat(GradientBoostingRegressor.fit(x, y, 10, 2, 1, 0.0)).isNull();
    }

    @Test
    void treeCountMatchesTheRequestedNumberOfBoostingRounds() {
        double[][] x = new double[20][1];
        double[] y = new double[20];
        for (int i = 0; i < 20; i++) { x[i][0] = i; y[i] = i * 2.0; }
        var model = GradientBoostingRegressor.fit(x, y, 15, 2, 2, 0.1);
        assertThat(model.treeCount()).isEqualTo(15);
    }
}
