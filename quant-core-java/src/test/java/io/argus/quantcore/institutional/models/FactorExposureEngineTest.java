package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class FactorExposureEngineTest {

    @Test
    void recoversARealBetaAndLowIdiosyncraticVolatilityWhenNoiseIsSmall() {
        Random rnd = new Random(1);
        int n = 200;
        double trueBeta = 1.3;
        double[] benchmarkReturns = new double[n];
        double[] symbolReturns = new double[n];
        double[] dollarVolumes = new double[n];
        for (int i = 0; i < n; i++) {
            benchmarkReturns[i] = rnd.nextGaussian() * 0.01;
            symbolReturns[i] = trueBeta * benchmarkReturns[i] + rnd.nextGaussian() * 0.0005;
            dollarVolumes[i] = 1_000_000 + rnd.nextDouble() * 500_000;
        }
        var result = FactorExposureEngine.evaluate(symbolReturns, benchmarkReturns, dollarVolumes, 20, 10);
        assertThat(result).isNotNull();
        assertThat(result.beta()).isCloseTo(trueBeta, org.assertj.core.data.Offset.offset(0.2));
        assertThat(result.idiosyncraticVolatility()).isLessThan(0.01);
        assertThat(result.amihudIlliquidity()).isGreaterThan(0.0);
    }

    @Test
    void reportsHigherAmihudIlliquidityForThinlyTradedNames() {
        Random rnd = new Random(2);
        int n = 100;
        double[] benchmarkReturns = new double[n];
        double[] liquidSymbolReturns = new double[n];
        double[] illiquidSymbolReturns = new double[n];
        double[] liquidVolumes = new double[n];
        double[] illiquidVolumes = new double[n];
        for (int i = 0; i < n; i++) {
            benchmarkReturns[i] = rnd.nextGaussian() * 0.01;
            liquidSymbolReturns[i] = benchmarkReturns[i] + rnd.nextGaussian() * 0.001;
            illiquidSymbolReturns[i] = benchmarkReturns[i] + rnd.nextGaussian() * 0.001;
            liquidVolumes[i] = 10_000_000;
            illiquidVolumes[i] = 10_000; // far thinner
        }
        var liquid = FactorExposureEngine.evaluate(liquidSymbolReturns, benchmarkReturns, liquidVolumes, 20, 10);
        var illiquid = FactorExposureEngine.evaluate(illiquidSymbolReturns, benchmarkReturns, illiquidVolumes, 20, 10);
        assertThat(illiquid.amihudIlliquidity()).isGreaterThan(liquid.amihudIlliquidity());
    }

    @Test
    void returnsNullWhenDollarVolumesAreMisaligned() {
        double[] symbolReturns = new double[50];
        double[] benchmarkReturns = new double[50];
        double[] dollarVolumes = new double[40];
        assertThat(FactorExposureEngine.evaluate(symbolReturns, benchmarkReturns, dollarVolumes, 20, 10)).isNull();
    }
}
