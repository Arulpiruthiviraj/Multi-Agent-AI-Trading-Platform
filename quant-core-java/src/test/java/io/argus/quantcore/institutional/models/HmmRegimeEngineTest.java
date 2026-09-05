package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class HmmRegimeEngineTest {

    @Test
    void fitAndDecodeRecoverFourClearlySeparatedRegimeBlocks() {
        Random rnd = new Random(2024);
        int perBlock = 150;

        // Four blocks matching the assignLabels heuristic: highest-variance block -> HIGH_VOL_CHAOS;
        // of the rest, highest mean return -> BULL_TRENDING, lowest -> BEAR_TRENDING, middle -> MEAN_REVERTING.
        HmmRegimeEngine.Observation[] bull = block(rnd, perBlock, 0.015, 0.006, 0.01, 0.002);
        HmmRegimeEngine.Observation[] bear = block(rnd, perBlock, -0.015, 0.006, 0.01, 0.002);
        HmmRegimeEngine.Observation[] meanRevert = block(rnd, perBlock, 0.0, 0.003, 0.008, 0.001);
        HmmRegimeEngine.Observation[] chaos = block(rnd, perBlock, 0.0, 0.006, 0.05, 0.01);

        HmmRegimeEngine.Observation[] all = concat(bull, bear, meanRevert, chaos);

        HmmRegimeEngine.Fitted fitted = HmmRegimeEngine.fit(all, 100);
        assertThat(fitted).isNotNull();
        assertThat(fitted.stateLabels()).hasSize(4);

        HmmRegimeEngine.Regime[] decoded = HmmRegimeEngine.decode(fitted, all);
        assertThat(decoded).hasSize(all.length);

        assertMajorityLabel(decoded, 0, perBlock, HmmRegimeEngine.Regime.BULL_TRENDING);
        assertMajorityLabel(decoded, perBlock, perBlock, HmmRegimeEngine.Regime.BEAR_TRENDING);
        assertMajorityLabel(decoded, 2 * perBlock, perBlock, HmmRegimeEngine.Regime.MEAN_REVERTING);
        assertMajorityLabel(decoded, 3 * perBlock, perBlock, HmmRegimeEngine.Regime.HIGH_VOL_CHAOS);
    }

    @Test
    void returnsNullWhenNotEnoughObservations() {
        HmmRegimeEngine.Observation[] tiny = block(new Random(1), 5, 0.01, 0.005, 0.01, 0.002);
        assertThat(HmmRegimeEngine.fit(tiny, 50)).isNull();
    }

    private static void assertMajorityLabel(HmmRegimeEngine.Regime[] decoded, int start, int length, HmmRegimeEngine.Regime expected) {
        long matches = 0;
        for (int i = start; i < start + length; i++) {
            if (decoded[i] == expected) matches++;
        }
        double fraction = matches / (double) length;
        assertThat(fraction)
            .as("expected majority of [%d,%d) decoded as %s, got %.2f fraction", start, start + length, expected, fraction)
            .isGreaterThan(0.6);
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
