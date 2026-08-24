package io.argus.quantcore.institutional.data;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.institutional.data.MarketDataQualityEngine.QualityReport;
import io.argus.quantcore.institutional.data.MarketDataQualityEngine.QualityStatus;
import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class MarketDataQualityEngineTest {

    private static Bar bar(long t, double close) {
        return new Bar(t, close, close * 1.001, close * 0.999, close, 1000.0);
    }

    @Test
    void reportsRedWithNoBars() {
        QualityReport r = MarketDataQualityEngine.assess(new Bar[0], 0, 30, 100, 8.0);
        assertThat(r.status()).isEqualTo(QualityStatus.RED);
        assertThat(r.issues()).contains("NO_BARS");
    }

    @Test
    void reportsRedWhenBelowMinimumHistory() {
        Bar[] bars = { bar(0, 100), bar(1, 101), bar(2, 102) };
        QualityReport r = MarketDataQualityEngine.assess(bars, 2, 30, 1_000_000, 8.0);
        assertThat(r.status()).isEqualTo(QualityStatus.RED);
        assertThat(r.sufficientHistory()).isFalse();
        assertThat(r.issues()).contains("INSUFFICIENT_HISTORY");
    }

    @Test
    void reportsRedWhenLastBarIsStale() {
        Bar[] bars = new Bar[40];
        for (int i = 0; i < 40; i++) bars[i] = bar(i, 100 + i);
        long asOfMs = 39 + 10_000; // far beyond the stale threshold below
        QualityReport r = MarketDataQualityEngine.assess(bars, asOfMs, 30, 100, 8.0);
        assertThat(r.status()).isEqualTo(QualityStatus.RED);
        assertThat(r.stale()).isTrue();
    }

    @Test
    void reportsRedOnOutOfOrderOrDuplicateTimestamps() {
        Bar[] bars = new Bar[35];
        for (int i = 0; i < 35; i++) bars[i] = bar(i, 100 + i);
        bars[20] = bar(19, 150); // duplicate/out-of-order timestamp
        QualityReport r = MarketDataQualityEngine.assess(bars, 34, 30, 1_000_000, 8.0);
        assertThat(r.status()).isEqualTo(QualityStatus.RED);
        assertThat(r.gapDetected()).isTrue();
    }

    @Test
    void reportsYellowOnAPriceAnomalyButGreenOtherwiseHealthy() {
        Random rnd = new Random(11);
        Bar[] bars = new Bar[50];
        double price = 100;
        for (int i = 0; i < 50; i++) {
            price *= i == 25 ? 3.0 : (1 + rnd.nextGaussian() * 0.002); // one obvious bad tick
            bars[i] = bar(i, price);
        }
        QualityReport r = MarketDataQualityEngine.assess(bars, 49, 30, 1_000_000, 4.0);
        assertThat(r.status()).isEqualTo(QualityStatus.YELLOW);
        assertThat(r.anomalyDetected()).isTrue();
        assertThat(r.sufficientHistory()).isTrue();
        assertThat(r.stale()).isFalse();
    }

    @Test
    void reportsGreenForCleanSufficientFreshData() {
        Random rnd = new Random(22);
        Bar[] bars = new Bar[50];
        double price = 100;
        for (int i = 0; i < 50; i++) {
            price *= 1 + rnd.nextGaussian() * 0.002;
            bars[i] = bar(i, price);
        }
        QualityReport r = MarketDataQualityEngine.assess(bars, 49, 30, 1_000_000, 8.0);
        assertThat(r.status()).isEqualTo(QualityStatus.GREEN);
        assertThat(r.issues()).isEmpty();
    }
}
