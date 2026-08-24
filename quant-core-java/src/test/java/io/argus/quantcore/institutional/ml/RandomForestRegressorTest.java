package io.argus.quantcore.institutional.ml;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class RandomForestRegressorTest {

    @Test
    void averagesManyTreesToApproximateARealNonlinearFunction() {
        Random rnd = new Random(11);
        int n = 300;
        double[][] x = new double[n][1];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            double v = rnd.nextDouble() * 10;
            x[i][0] = v;
            y[i] = Math.sin(v) * 5 + rnd.nextGaussian() * 0.1;
        }
        var forest = RandomForestRegressor.fit(x, y, 50, 4, 5, 1, 42L);
        assertThat(forest).isNotNull();
        assertThat(forest.treeCount()).isEqualTo(50);

        // Peak of sin near x=1.57 should predict close to +5, trough near x=4.71 close to -5.
        double peakPrediction = forest.predict(new double[] { 1.57 });
        double troughPrediction = forest.predict(new double[] { 4.71 });
        assertThat(peakPrediction).isGreaterThan(troughPrediction);
    }

    @Test
    void returnsNullForZeroTrees() {
        double[][] x = { { 1 }, { 2 }, { 3 } };
        double[] y = { 1, 2, 3 };
        assertThat(RandomForestRegressor.fit(x, y, 0, 3, 1, 1, 0L)).isNull();
    }

    @Test
    void isDeterministicForAFixedSeed() {
        Random rnd = new Random(5);
        int n = 100;
        double[][] x = new double[n][2];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            x[i][0] = rnd.nextGaussian();
            x[i][1] = rnd.nextGaussian();
            y[i] = 2 * x[i][0] - x[i][1];
        }
        var forestA = RandomForestRegressor.fit(x, y, 20, 3, 3, 2, 7L);
        var forestB = RandomForestRegressor.fit(x, y, 20, 3, 3, 2, 7L);
        double[] point = { 1.0, 1.0 };
        assertThat(forestA.predict(point)).isEqualTo(forestB.predict(point));
    }
}
