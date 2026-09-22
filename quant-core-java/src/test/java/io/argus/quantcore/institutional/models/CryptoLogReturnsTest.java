package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class CryptoLogReturnsTest {

    @Test
    void logReturnMatchesTheCanonicalFormula() {
        double r = CryptoLogReturns.logReturn(110, 100);
        assertThat(r).isCloseTo(Math.log(1.1), org.assertj.core.data.Offset.offset(1e-12));
    }

    @Test
    void logReturnIsNanForNonPositivePrices() {
        assertThat(CryptoLogReturns.logReturn(0, 100)).isNaN();
        assertThat(CryptoLogReturns.logReturn(100, 0)).isNaN();
        assertThat(CryptoLogReturns.logReturn(-5, 100)).isNaN();
    }

    @Test
    void cumulativeLogReturnMatchesDirectComputationOverTheWindow() {
        double[] closes = {100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110};
        Double momentum = CryptoLogReturns.cumulativeLogReturn(closes, 10);
        assertThat(momentum).isCloseTo(Math.log(110.0 / 100.0), org.assertj.core.data.Offset.offset(1e-12));
    }

    @Test
    void cumulativeLogReturnIsNullWhenHistoryIsTooShort() {
        double[] closes = {100, 101, 102};
        assertThat(CryptoLogReturns.cumulativeLogReturn(closes, 10)).isNull();
    }

    @Test
    void logReturnsSeriesHasOneFewerElementThanCloses() {
        double[] closes = {100, 101, 102, 103};
        assertThat(CryptoLogReturns.logReturnsSeries(closes)).hasSize(3);
    }

    @Test
    void annualizedVolatilityIsZeroForAConstantPriceSeries() {
        double[] closes = new double[40];
        java.util.Arrays.fill(closes, 100);
        Double vol = CryptoLogReturns.annualizedVolatilityOfLogReturns(closes, 20, 365);
        assertThat(vol).isEqualTo(0.0);
    }

    @Test
    void annualizedVolatilityIsPositiveForAnAlternatingSeries() {
        int n = 40;
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price *= (i % 2 == 0) ? 1.02 : 0.98;
            closes[i] = price;
        }
        Double vol = CryptoLogReturns.annualizedVolatilityOfLogReturns(closes, 20, 365);
        assertThat(vol).isGreaterThan(0);
    }

    @Test
    void rollingAnnualizedVolatilitySeriesLengthMatchesAvailableWindows() {
        double[] closes = new double[50];
        double price = 100;
        for (int i = 0; i < 50; i++) {
            price *= 1.001;
            closes[i] = price;
        }
        double[] series = CryptoLogReturns.rollingAnnualizedVolatilitySeries(closes, 20, 365);
        // 49 total log returns, 20-bar window -> 49 - 20 + 1 = 30 readings
        assertThat(series).hasSize(30);
    }
}
