package io.argus.quantcore.institutional.ml;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class DecisionTreeRegressorTest {

    @Test
    void learnsARealStepFunctionSplit() {
        // y = 0 when x < 5, y = 10 when x >= 5 - a tree should find this split exactly.
        int n = 100;
        double[][] x = new double[n][1];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            x[i][0] = i * 0.1;
            y[i] = x[i][0] < 5.0 ? 0.0 : 10.0;
        }
        var tree = DecisionTreeRegressor.fit(x, y, 3, 2);
        assertThat(tree).isNotNull();
        assertThat(tree.predict(new double[] { 1.0 })).isCloseTo(0.0, org.assertj.core.data.Offset.offset(0.5));
        assertThat(tree.predict(new double[] { 9.0 })).isCloseTo(10.0, org.assertj.core.data.Offset.offset(0.5));
    }

    @Test
    void returnsNullForMismatchedRowCounts() {
        double[][] x = { { 1 }, { 2 } };
        double[] y = { 1 };
        assertThat(DecisionTreeRegressor.fit(x, y, 3, 1)).isNull();
    }

    @Test
    void restrictsToASingleRandomlyChosenFeatureWhenMaxFeaturesPerSplitIsOne() {
        // Two features - only feature 1 is informative. With maxFeaturesPerSplit=1 and a lucky
        // seed the tree may or may not find it on a given split, but it must never crash and must
        // always produce a valid, real prediction.
        Random rnd = new Random(1);
        int n = 200;
        double[][] x = new double[n][2];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            x[i][0] = rnd.nextGaussian(); // noise, uninformative
            x[i][1] = i < n / 2 ? 0.0 : 1.0;
            y[i] = x[i][1] * 10.0;
        }
        var tree = DecisionTreeRegressor.fit(x, y, 4, 5, 1, new Random(2));
        assertThat(tree).isNotNull();
        double prediction = tree.predict(new double[] { 0.0, 1.0 });
        assertThat(prediction).isBetween(-5.0, 15.0); // sane, real number - not NaN/fabricated
    }
}
