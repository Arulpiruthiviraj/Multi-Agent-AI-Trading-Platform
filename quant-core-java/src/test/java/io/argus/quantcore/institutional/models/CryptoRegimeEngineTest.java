package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class CryptoRegimeEngineTest {

    private static CryptoFeatureEngine.Snapshot uptrendSnapshot() {
        int n = 40;
        double[] closes = new double[n];
        double[] highs = new double[n];
        double[] lows = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price *= 1.01;
            closes[i] = price;
            highs[i] = price * 1.005;
            lows[i] = price * 0.995;
        }
        return CryptoFeatureEngine.compute(closes, highs, lows);
    }

    private static CryptoFeatureEngine.Snapshot downtrendSnapshot() {
        int n = 40;
        double[] closes = new double[n];
        double[] highs = new double[n];
        double[] lows = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price *= 0.99;
            closes[i] = price;
            highs[i] = price * 1.005;
            lows[i] = price * 0.995;
        }
        return CryptoFeatureEngine.compute(closes, highs, lows);
    }

    private static CryptoFeatureEngine.Snapshot choppyRangeSnapshot() {
        int n = 40;
        double[] closes = new double[n];
        double[] highs = new double[n];
        double[] lows = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            // Amplitude tuned so atrPercent lands strictly between the compression (0.6%) and
            // expansion (2.0%) bars, with a symmetric zigzag keeping net trend near zero.
            price += (i % 2 == 0) ? 0.8 : -0.8;
            closes[i] = price;
            highs[i] = price * 1.001;
            lows[i] = price * 0.999;
        }
        return CryptoFeatureEngine.compute(closes, highs, lows);
    }

    private static CryptoFeatureEngine.Snapshot highVolatilitySnapshot() {
        int n = 40;
        double[] closes = new double[n];
        double[] highs = new double[n];
        double[] lows = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price *= (i % 2 == 0) ? 1.05 : 0.955; // large alternating swings, minimal net drift
            closes[i] = price;
            highs[i] = price * 1.03;
            lows[i] = price * 0.97;
        }
        return CryptoFeatureEngine.compute(closes, highs, lows);
    }

    @Test
    void reportsUnknownRatherThanGuessingWhenSnapshotHasInsufficientData() {
        double[] closes = { 100, 101, 102 };
        double[] highs = { 101, 102, 103 };
        double[] lows = { 99, 100, 101 };
        var snapshot = CryptoFeatureEngine.compute(closes, highs, lows);

        var result = CryptoRegimeEngine.classify(snapshot);

        assertThat(result.regime()).isEqualTo(CryptoRegimeEngine.Regime.UNKNOWN);
        assertThat(result.regimeConfidence()).isEqualTo(0);
        assertThat(result.evidence()).isNotEmpty();
    }

    @Test
    void classifiesASteadyUptrendAsTrendingBull() {
        var result = CryptoRegimeEngine.classify(uptrendSnapshot());

        assertThat(result.regime()).isEqualTo(CryptoRegimeEngine.Regime.TRENDING_BULL);
        assertThat(result.regimeConfidence()).isEqualTo(1.0);
        assertThat(result.evidence()).isNotEmpty();
    }

    @Test
    void classifiesASteadyDowntrendAsTrendingBear() {
        var result = CryptoRegimeEngine.classify(downtrendSnapshot());

        assertThat(result.regime()).isEqualTo(CryptoRegimeEngine.Regime.TRENDING_BEAR);
        assertThat(result.regimeConfidence()).isEqualTo(1.0);
    }

    @Test
    void classifiesLargeAlternatingSwingsAsVolatilityExpansion() {
        var result = CryptoRegimeEngine.classify(highVolatilitySnapshot());

        assertThat(result.regime()).isEqualTo(CryptoRegimeEngine.Regime.VOLATILITY_EXPANSION);
    }

    @Test
    void classifiesAFlatSeriesAsVolatilityCompressionNotRange() {
        int n = 40;
        double[] closes = new double[n];
        double[] highs = new double[n];
        double[] lows = new double[n];
        for (int i = 0; i < n; i++) {
            closes[i] = 100;
            highs[i] = 100.001; // near-zero true range -> atrPercent well under the compression bar
            lows[i] = 99.999;
        }
        var snapshot = CryptoFeatureEngine.compute(closes, highs, lows);

        var result = CryptoRegimeEngine.classify(snapshot);

        assertThat(result.regime()).isEqualTo(CryptoRegimeEngine.Regime.VOLATILITY_COMPRESSION);
    }

    @Test
    void classifiesNoTrendNoExpansionNoCompressionAsRangeWithReducedConfidence() {
        var result = CryptoRegimeEngine.classify(choppyRangeSnapshot());

        assertThat(result.regime()).isEqualTo(CryptoRegimeEngine.Regime.RANGE);
        // RANGE is a default/fallback read, not a definitive one - confidence must reflect that,
        // unlike the other branches which assert full 1.0 confidence.
        assertThat(result.regimeConfidence()).isLessThan(1.0);
    }

    @Test
    void customThresholdsChangeTheClassificationOfTheSameSnapshot() {
        var snapshot = uptrendSnapshot();

        // Under default thresholds this snapshot classifies as TRENDING_BULL (see above).
        // An artificially strict threshold (never clearable by this snapshot's real slope) must
        // prevent that same classification - proving thresholds are real inputs, not decoration.
        var strict = new CryptoRegimeEngine.Thresholds(1000, 55, 45, 0.6, 2.0);
        var result = CryptoRegimeEngine.classify(snapshot, strict);

        assertThat(result.regime()).isNotEqualTo(CryptoRegimeEngine.Regime.TRENDING_BULL);
    }

    @Test
    void defaultThresholdsOverloadMatchesExplicitDefaultThresholds() {
        var snapshot = downtrendSnapshot();

        var viaDefaultOverload = CryptoRegimeEngine.classify(snapshot);
        var viaExplicitDefaults = CryptoRegimeEngine.classify(snapshot, CryptoRegimeEngine.DEFAULT_THRESHOLDS);

        assertThat(viaDefaultOverload.regime()).isEqualTo(viaExplicitDefaults.regime());
        assertThat(viaDefaultOverload.regimeConfidence()).isEqualTo(viaExplicitDefaults.regimeConfidence());
    }
}
