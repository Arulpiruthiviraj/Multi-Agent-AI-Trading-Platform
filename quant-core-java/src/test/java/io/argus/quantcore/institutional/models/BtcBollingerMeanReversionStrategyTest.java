package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class BtcBollingerMeanReversionStrategyTest {

    @Test
    void baselineWrapperProducesTheIdenticalDecisionAsItsAdaptiveDelegateWithTanParameters() {
        double[] closes = plungeThenRecover();
        var baseline = new BtcTan2025BollingerMeanReversionStrategy();
        var adaptive = new BtcAdaptiveBollingerMeanReversionStrategy(BtcAdaptiveBollingerMeanReversionStrategy.TAN2025_EQUIVALENT_PARAMETERS);

        var baselineResult = baseline.evaluate(closes);
        var adaptiveResult = adaptive.evaluate(closes);
        // Records compare array fields (evidence) by reference, not content, so compare the
        // meaningful fields directly rather than record equality.
        assertThat(baselineResult.position()).isEqualTo(adaptiveResult.position());
        assertThat(baselineResult.diagnostics()).isEqualTo(adaptiveResult.diagnostics());
        assertThat(baselineResult.evidence()).isEqualTo(adaptiveResult.evidence());
        assertThat(baseline.strategyId()).isEqualTo("BTC_TAN2025_BOLLINGER_MEAN_REVERSION");
        assertThat(adaptive.strategyId()).isEqualTo("BTC_ADAPTIVE_BOLLINGER_MEAN_REVERSION");
    }

    @Test
    void reportsInsufficientDataRatherThanFabricatingASignalWhenHistoryIsShort() {
        double[] closes = {100, 101, 102};
        var strategy = new BtcTan2025BollingerMeanReversionStrategy();
        var result = strategy.evaluate(closes);
        assertThat(result.sufficientData()).isFalse();
    }

    @Test
    void stableRangeboundPriceNeverCrossesTheBandsAndStaysFlat() {
        // Price oscillates in a tight band around 100 - never actually crosses the lower band by
        // enough to trigger the baseline's exact 2-stdev entry.
        int n = 60;
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price += (i % 4 < 2) ? 0.1 : -0.1;
            closes[i] = price;
        }
        var strategy = new BtcTan2025BollingerMeanReversionStrategy();
        var result = strategy.evaluate(closes);

        assertThat(result.sufficientData()).isTrue();
        assertThat(result.position()).isEqualTo(CryptoPosition.FLAT);
        assertThat(result.diagnostics().get("entries")).isEqualTo(0.0);
    }

    /** A sharp plunge (crossing below the lower band) followed by a strong recovery (crossing
     *  back above the SMA) - the one price path guaranteed to exercise both the entry and exit
     *  rule of the baseline's exact specification. */
    private static double[] plungeThenRecover() {
        java.util.List<Double> closes = new java.util.ArrayList<>();
        double price = 100;
        for (int i = 0; i < 25; i++) {
            closes.add(price); // establish a stable base so SMA/stdev are well-defined
        }
        for (int i = 0; i < 5; i++) {
            price *= 0.90; // sharp plunge - should cross below the lower band
            closes.add(price);
        }
        for (int i = 0; i < 15; i++) {
            price *= 1.05; // strong recovery - should cross back above the SMA
            closes.add(price);
        }
        double[] arr = new double[closes.size()];
        for (int i = 0; i < arr.length; i++) arr[i] = closes.get(i);
        return arr;
    }

    @Test
    void aSharpPlungeFollowedByRecoveryProducesAtLeastOneEntryAndExit() {
        double[] closes = plungeThenRecover();
        var strategy = new BtcTan2025BollingerMeanReversionStrategy();
        var result = strategy.evaluate(closes);

        assertThat(result.sufficientData()).isTrue();
        assertThat(result.diagnostics().get("entries")).isGreaterThanOrEqualTo(1.0);
        assertThat(result.diagnostics().get("exits")).isGreaterThanOrEqualTo(1.0);
        // Ended in strong recovery well above the SMA - should have exited back to FLAT.
        assertThat(result.position()).isEqualTo(CryptoPosition.FLAT);
    }

    @Test
    void widerMultiplierRequiresALargerMoveToEnterThanTheBaseline() {
        double[] closes = plungeThenRecover();
        var baseline = new BtcAdaptiveBollingerMeanReversionStrategy(new BtcAdaptiveBollingerMeanReversionStrategy.Parameters(20, 2.0));
        var wide = new BtcAdaptiveBollingerMeanReversionStrategy(new BtcAdaptiveBollingerMeanReversionStrategy.Parameters(20, 5.0));

        double baselineEntries = baseline.evaluate(closes).diagnostics().get("entries");
        double wideEntries = wide.evaluate(closes).diagnostics().get("entries");

        assertThat(wideEntries).isLessThanOrEqualTo(baselineEntries);
    }
}
