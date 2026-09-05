package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class MarketRegimeEngineTest {

    @Test
    void combinesARealHmmLabelWithARealVolatilityPercentile() {
        Random rnd = new Random(21);
        int perBlock = 150;
        HmmRegimeEngine.Observation[] bull = block(rnd, perBlock, 0.015, 0.006, 0.01, 0.002);
        HmmRegimeEngine.Observation[] bear = block(rnd, perBlock, -0.015, 0.006, 0.01, 0.002);
        HmmRegimeEngine.Observation[] meanRevert = block(rnd, perBlock, 0.0, 0.003, 0.008, 0.001);
        HmmRegimeEngine.Observation[] chaos = block(rnd, perBlock, 0.0, 0.006, 0.05, 0.01);
        HmmRegimeEngine.Observation[] all = concat(bull, bear, meanRevert, chaos);

        double[] closes = new double[all.length + 1];
        closes[0] = 100;
        for (int i = 0; i < all.length; i++) closes[i + 1] = closes[i] * (1 + all[i].dailyReturn());

        MarketRegimeEngine.RegimeAssessment assessment = MarketRegimeEngine.assess("AAPL", all, closes, 20);
        assertThat(assessment).isNotNull();
        assertThat(assessment.hmmRegime()).isNotNull();
        assertThat(assessment.volatilityPercentile()).isBetween(0.0, 1.0);
    }

    @Test
    void returnsNullWhenTheHmmCannotFit() {
        HmmRegimeEngine.Observation[] tiny = block(new Random(1), 5, 0.01, 0.005, 0.01, 0.002);
        double[] closes = {100, 101, 100.5, 102, 101.5, 103};
        assertThat(MarketRegimeEngine.assess("THIN", tiny, closes, 3)).isNull();
    }

    private static HmmRegimeEngine.Observation[] block(Random rnd, int n, double meanReturn, double stdReturn, double meanVol, double stdVol) {
        HmmRegimeEngine.Observation[] out = new HmmRegimeEngine.Observation[n];
        for (int i = 0; i < n; i++) {
            double r = meanReturn + rnd.nextGaussian() * stdReturn;
            double v = Math.max(0.0001, meanVol + rnd.nextGaussian() * stdVol);
            out[i] = new HmmRegimeEngine.Observation(r, v);
        }
        return out;
    }

    private static HmmRegimeEngine.Observation[] concat(HmmRegimeEngine.Observation[]... blocks) {
        int total = 0;
        for (var b : blocks) total += b.length;
        HmmRegimeEngine.Observation[] out = new HmmRegimeEngine.Observation[total];
        int idx = 0;
        for (var b : blocks) {
            System.arraycopy(b, 0, out, idx, b.length);
            idx += b.length;
        }
        return out;
    }
}
