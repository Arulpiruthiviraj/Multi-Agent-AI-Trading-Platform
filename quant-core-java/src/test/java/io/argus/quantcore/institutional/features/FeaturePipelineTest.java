package io.argus.quantcore.institutional.features;

import io.argus.quantcore.backtest.engine.Bar;
import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class FeaturePipelineTest {

    private static Bar[] realisticBars(int n, long seed) {
        Random rnd = new Random(seed);
        Bar[] bars = new Bar[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            double close = price * (1 + rnd.nextGaussian() * 0.01);
            double open = price;
            double high = Math.max(open, close) * 1.002;
            double low = Math.min(open, close) * 0.998;
            bars[i] = new Bar(i, open, high, low, close, 1_000_000.0);
            price = close;
        }
        return bars;
    }

    @Test
    void buildsARealSnapshotWithGreenQualityForCleanSufficientData() {
        Bar[] bars = realisticBars(60, 5);
        long asOfMs = bars[bars.length - 1].timestampMs();
        FeatureSnapshot snap = FeaturePipeline.build("AAPL", bars, asOfMs);
        assertThat(snap).isNotNull();
        assertThat(snap.symbol()).isEqualTo("AAPL");
        assertThat(snap.rsi()).isBetween(0.0, 100.0);
        assertThat(snap.barsUsed()).isEqualTo(60);
        assertThat(snap.qualityReport().status().name()).isEqualTo("GREEN");
        assertThat(snap.close()).isEqualTo(bars[bars.length - 1].close());
    }

    @Test
    void refusesToBuildASnapshotWhenQualityIsRed() {
        Bar[] bars = realisticBars(5, 6); // below the 30-bar minimum -> RED
        FeatureSnapshot snap = FeaturePipeline.build("THIN", bars, bars[bars.length - 1].timestampMs());
        assertThat(snap).isNull();
    }

    @Test
    void stillBuildsASnapshotOnYellowQualityWithRealNumbers() {
        Random rnd = new Random(7);
        Bar[] bars = new Bar[40];
        double price = 100;
        for (int i = 0; i < 40; i++) {
            price *= i == 20 ? 3.0 : (1 + rnd.nextGaussian() * 0.005);
            bars[i] = new Bar(i, price, price * 1.001, price * 0.999, price, 1000.0);
        }
        FeatureSnapshot snap = FeaturePipeline.build("SPIKY", bars, bars[bars.length - 1].timestampMs(), 30, 1_000_000, 4.0);
        assertThat(snap).isNotNull();
        assertThat(snap.qualityReport().status().name()).isEqualTo("YELLOW");
        assertThat(snap.qualityReport().anomalyDetected()).isTrue();
    }
}
