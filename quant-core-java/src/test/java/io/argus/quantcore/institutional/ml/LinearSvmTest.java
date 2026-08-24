package io.argus.quantcore.institutional.ml;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class LinearSvmTest {

    @Test
    void learnsARealLinearlySeparableBoundary() {
        Random rnd = new Random(3);
        int n = 300;
        double[][] x = new double[n][2];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            double a = rnd.nextGaussian();
            double b = rnd.nextGaussian();
            x[i][0] = a;
            x[i][1] = b;
            y[i] = (a + b) > 0 ? 1.0 : -1.0; // separable by the line a+b=0
        }
        var svm = LinearSvm.fit(x, y, 0.01, 50, 1L);
        assertThat(svm).isNotNull();

        int correct = 0;
        for (int i = 0; i < n; i++) {
            if (svm.predictLabel(x[i]) == y[i]) correct++;
        }
        assertThat(correct / (double) n).isGreaterThan(0.9);
    }

    @Test
    void predictsPositiveFarOnThePositiveSideAndNegativeFarOnTheNegativeSide() {
        Random rnd = new Random(4);
        int n = 200;
        double[][] x = new double[n][1];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            double v = rnd.nextGaussian();
            x[i][0] = v;
            y[i] = v > 0 ? 1.0 : -1.0;
        }
        var svm = LinearSvm.fit(x, y, 0.01, 50, 2L);
        assertThat(svm.predictLabel(new double[] { 10.0 })).isEqualTo(1);
        assertThat(svm.predictLabel(new double[] { -10.0 })).isEqualTo(-1);
    }

    @Test
    void returnsNullForALabelOutsidePlusOrMinusOne() {
        double[][] x = { { 1 }, { 2 } };
        double[] y = { 1.0, 0.0 };
        assertThat(LinearSvm.fit(x, y, 0.01, 10, 0L)).isNull();
    }

    @Test
    void returnsNullForANonPositiveLambda() {
        double[][] x = { { 1 }, { 2 } };
        double[] y = { 1.0, -1.0 };
        assertThat(LinearSvm.fit(x, y, 0.0, 10, 0L)).isNull();
    }
}
