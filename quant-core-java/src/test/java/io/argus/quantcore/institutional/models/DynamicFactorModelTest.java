package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class DynamicFactorModelTest {

    @Test
    void extractsARealDominantLeadingFactorWhenAllSeriesShareACommonDriver() {
        Random rnd = new Random(40);
        int n = 300;
        double[][] panel = new double[n][4];
        double commonFactorLevel = 0;
        for (int t = 0; t < n; t++) {
            commonFactorLevel = 0.5 * commonFactorLevel + rnd.nextGaussian(); // real AR(1) common driver
            for (int s = 0; s < 4; s++) {
                panel[t][s] = commonFactorLevel + rnd.nextGaussian() * 0.1; // small idiosyncratic noise
            }
        }

        var result = DynamicFactorModel.fit(panel, 2);
        assertThat(result).isNotNull();
        assertThat(result.pca().explainedVarianceRatio()[0]).isGreaterThan(0.9); // one factor dominates
        assertThat(result.leadingFactorSeries()).hasSize(n);
        assertThat(result.leadingFactorDynamics().lagCoefficients()[0]).isCloseTo(0.5, org.assertj.core.data.Offset.offset(0.2));
    }

    @Test
    void forecastLeadingFactorOneStepProducesARealFiniteNumber() {
        Random rnd = new Random(41);
        int n = 200;
        double[][] panel = new double[n][3];
        for (int t = 0; t < n; t++) {
            double common = rnd.nextGaussian();
            for (int s = 0; s < 3; s++) panel[t][s] = common + rnd.nextGaussian() * 0.2;
        }
        var result = DynamicFactorModel.fit(panel, 1);
        assertThat(result).isNotNull();
        double forecast = result.forecastLeadingFactorOneStep();
        assertThat(Double.isFinite(forecast)).isTrue();
    }

    @Test
    void returnsNullWhenThereIsNotEnoughDataForTheLeadingFactorArFit() {
        double[][] panel = new double[3][4];
        assertThat(DynamicFactorModel.fit(panel, 5)).isNull();
    }
}
