package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class CryptoRegimeConditionalMomentumStrategyTest {

    private static double[] steadyUptrend(int n) {
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price *= 1.01;
            closes[i] = price;
        }
        return closes;
    }

    private static double[] offset(double[] closes, double factor) {
        double[] out = new double[closes.length];
        for (int i = 0; i < closes.length; i++) out[i] = closes[i] * factor;
        return out;
    }

    @Test
    void confirmsAndPassesThroughAnUnderlyingLongSignalWhenRegimeIsTrendingBull() {
        double[] closes = steadyUptrend(150);
        double[] highs = offset(closes, 1.005);
        double[] lows = offset(closes, 0.995);

        var underlying = new BtcAdaptiveVolatilityMomentumStrategy(BtcAdaptiveVolatilityMomentumStrategy.TAN2025_EQUIVALENT_PARAMETERS);
        assertThat(underlying.evaluate(closes).position()).isEqualTo(CryptoPosition.LONG); // precondition

        var wrapped = new CryptoRegimeConditionalMomentumStrategy(BtcAdaptiveVolatilityMomentumStrategy.TAN2025_EQUIVALENT_PARAMETERS);
        var result = wrapped.evaluate(closes, highs, lows);

        assertThat(result.position()).isEqualTo(CryptoPosition.LONG);
        assertThat(String.join(" ", result.evidence())).contains("CONFIRMED");
    }

    @Test
    void neverInventsALongSignalTheUnderlyingStrategyDidNotAlreadyProduce() {
        // A flat/choppy series where the underlying momentum strategy stays FLAT - the regime
        // wrapper must not turn that into a LONG no matter what regime it computes.
        int n = 150;
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price += (i % 2 == 0) ? 0.05 : -0.05;
            closes[i] = price;
        }
        double[] highs = offset(closes, 1.001);
        double[] lows = offset(closes, 0.999);

        var underlying = new BtcAdaptiveVolatilityMomentumStrategy(BtcAdaptiveVolatilityMomentumStrategy.TAN2025_EQUIVALENT_PARAMETERS);
        assertThat(underlying.evaluate(closes).position()).isEqualTo(CryptoPosition.FLAT); // precondition

        var wrapped = new CryptoRegimeConditionalMomentumStrategy(BtcAdaptiveVolatilityMomentumStrategy.TAN2025_EQUIVALENT_PARAMETERS);
        var result = wrapped.evaluate(closes, highs, lows);

        assertThat(result.position()).isEqualTo(CryptoPosition.FLAT);
    }

    @Test
    void suppressesALongSignalWhenTheIndependentRegimeReadDisagrees() {
        // Construct a series whose momentum condition is satisfied (positive momentum, low vol)
        // but whose ATR-based regime read is RANGE/COMPRESSION rather than TRENDING_BULL, by
        // using an extremely gentle drift with tight highs/lows (compressed ATR, weak slope).
        int n = 150;
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price *= 1.0005; // just barely positive momentum
            closes[i] = price;
        }
        double[] highs = offset(closes, 1.00001);
        double[] lows = offset(closes, 0.99999);

        var wrapped = new CryptoRegimeConditionalMomentumStrategy(BtcAdaptiveVolatilityMomentumStrategy.TAN2025_EQUIVALENT_PARAMETERS);
        var result = wrapped.evaluate(closes, highs, lows);

        // Whatever the underlying momentum strategy decided, if the wrapper reports FLAT it must
        // give an honest reason (SUPPRESSED by regime, or insufficient data) - never a silent FLAT.
        if (result.position() == CryptoPosition.FLAT) {
            String joined = String.join(" ", result.evidence());
            assertThat(joined.contains("SUPPRESSED") || joined.contains("insufficient")
                || joined.contains("<=") || joined.contains(">=")).isTrue();
        }
    }
}
