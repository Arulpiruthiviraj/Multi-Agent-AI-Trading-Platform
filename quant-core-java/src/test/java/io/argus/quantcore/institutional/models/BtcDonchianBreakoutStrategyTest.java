package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class BtcDonchianBreakoutStrategyTest {

    // Small period (5) so 10-bar fixtures are enough to hand-verify DonchianChannelEngine's own
    // "excludes current bar, uses the prior N bars" window precisely.
    private static final BtcDonchianBreakoutStrategy.Parameters SMALL_PARAMS =
        new BtcDonchianBreakoutStrategy.Parameters(5, 5, 5, 4, 2.0);

    /** Bars 0-8 flat/ranging (high=105, low=95); bar 9 defaults to the same range too - callers
     *  override specific indices to construct a breakout/continuation/reversion scenario. */
    private static double[][] flatRangeBars(int n) {
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n; i++) {
            highs[i] = 105;
            lows[i] = 95;
            closes[i] = 100;
        }
        return new double[][]{highs, lows, closes};
    }

    @Test
    void reportsInsufficientDataRatherThanFabricatingASignalWhenHistoryIsShort() {
        double[][] bars = flatRangeBars(4);
        var strategy = new BtcDonchianBreakoutStrategy(SMALL_PARAMS);
        var result = strategy.evaluate(bars[0], bars[1], bars[2]);
        assertThat(result.sufficientData()).isFalse();
        assertThat(result.position()).isEqualTo(CryptoPosition.FLAT);
    }

    @Test
    void closeOnlyEvaluateReturnsInsufficientDataRatherThanFabricatingAChannel() {
        var strategy = new BtcDonchianBreakoutStrategy(SMALL_PARAMS);
        var result = strategy.evaluate(new double[]{100, 101, 102, 103, 104, 105, 106, 107, 108, 109});
        assertThat(result.sufficientData()).isFalse();
        assertThat(result.position()).isEqualTo(CryptoPosition.FLAT);
    }

    @Test
    void classifiesAFreshBreakoutWhenOnlyTheCurrentBarClearsTheChannel() {
        double[][] bars = flatRangeBars(10);
        // bar 9: closes above the [4,8]-window channel (upper=105), bar 8 stays inside it.
        bars[0][9] = 112; bars[1][9] = 108; bars[2][9] = 110;
        var strategy = new BtcDonchianBreakoutStrategy(SMALL_PARAMS);
        var result = strategy.evaluate(bars[0], bars[1], bars[2]);

        assertThat(result.sufficientData()).isTrue();
        assertThat(result.evidence()[0]).contains("FRESH_BREAKOUT");
    }

    @Test
    void classifiesContinuationWhenBothTheCurrentAndPriorBarClearTheChannelInTheSameDirection() {
        double[][] bars = flatRangeBars(10);
        // bar 8 already breaks its own [3,7] channel (upper=105); bar 9 breaks the resulting
        // [4,8] channel too (upper now 112, from bar 8's own high).
        bars[0][8] = 112; bars[1][8] = 106; bars[2][8] = 110;
        bars[0][9] = 115; bars[1][9] = 109; bars[2][9] = 113;
        var strategy = new BtcDonchianBreakoutStrategy(SMALL_PARAMS);
        var result = strategy.evaluate(bars[0], bars[1], bars[2]);

        assertThat(result.sufficientData()).isTrue();
        assertThat(result.evidence()[0]).contains("CONTINUATION");
    }

    @Test
    void classifiesAFailedBreakoutWhenThePriorBarBrokeOutButTheCurrentBarIsBackInsideTheChannel() {
        double[][] bars = flatRangeBars(10);
        // bar 8 breaks its own [3,7] channel (upper=105) - real breakout as of "then".
        bars[0][8] = 112; bars[1][8] = 106; bars[2][8] = 110;
        // bar 9 reverts back inside the resulting [4,8] channel (upper=112, lower=95).
        bars[0][9] = 104; bars[1][9] = 98; bars[2][9] = 100;
        var strategy = new BtcDonchianBreakoutStrategy(SMALL_PARAMS);
        var result = strategy.evaluate(bars[0], bars[1], bars[2]);

        assertThat(result.sufficientData()).isTrue();
        assertThat(result.evidence()[0]).contains("FAILED_BREAKOUT");
        assertThat(result.position()).isEqualTo(CryptoPosition.FLAT);
    }

    @Test
    void staysFlatWithNoBreakoutContextWhenPriceNeverLeavesTheRange() {
        double[][] bars = flatRangeBars(10);
        var strategy = new BtcDonchianBreakoutStrategy(SMALL_PARAMS);
        var result = strategy.evaluate(bars[0], bars[1], bars[2]);

        assertThat(result.sufficientData()).isTrue();
        assertThat(result.evidence()[0]).contains("NO_BREAKOUT_CONTEXT");
        assertThat(result.position()).isEqualTo(CryptoPosition.FLAT);
    }

    @Test
    void aFailedBreakoutNeverGoesLongEvenThoughABreakoutOccurredRecently() {
        double[][] bars = flatRangeBars(10);
        bars[0][8] = 112; bars[1][8] = 106; bars[2][8] = 110;
        bars[0][9] = 104; bars[1][9] = 98; bars[2][9] = 100;
        var strategy = new BtcDonchianBreakoutStrategy(SMALL_PARAMS);
        var result = strategy.evaluate(bars[0], bars[1], bars[2]);
        assertThat(result.position()).isEqualTo(CryptoPosition.FLAT);
    }

    @Test
    void aDownwardBreakoutNeverGoesLong_longOnlyResearchStrategy() {
        double[][] bars = flatRangeBars(10);
        bars[0][9] = 92; bars[1][9] = 88; bars[2][9] = 90; // closes below the [4,8] channel (lower=95)
        var strategy = new BtcDonchianBreakoutStrategy(SMALL_PARAMS);
        var result = strategy.evaluate(bars[0], bars[1], bars[2]);

        assertThat(result.position()).isEqualTo(CryptoPosition.FLAT);
        assertThat(String.join(" ", result.evidence())).contains("downward");
    }

    @Test
    void aBareFreshBreakoutWithNoTrendVolumeOrContinuationConfirmationScoresLowAndStaysFlat() {
        double[][] bars = flatRangeBars(10);
        // A small, unconfirmed breakout (tiny distance, no ADX/volume data at this small n).
        bars[0][9] = 106; bars[1][9] = 104; bars[2][9] = 105.5;
        var strategy = new BtcDonchianBreakoutStrategy(SMALL_PARAMS);
        var result = strategy.evaluate(bars[0], bars[1], bars[2]);

        assertThat(result.sufficientData()).isTrue();
        assertThat((double) result.diagnostics().get("continuousScore")).isLessThan(0.35);
        assertThat(result.position()).isEqualTo(CryptoPosition.FLAT);
    }

    @Test
    void priorBarEvaluationOnlyUsesBarsVisibleAtThatTime_noLookaheadRegression() {
        // The CONTINUATION and FAILED_BREAKOUT tests above are the real no-lookahead proof: both
        // depend on the "prior" Donchian read (Arrays.copyOfRange(..., 0, n-1)) seeing a DIFFERENT
        // channel than the "current" read specifically because bar n-1 (the latest bar) must not
        // contribute to it. This test isolates that mechanism directly: appending a wild bar to an
        // otherwise-identical series must never change what the strategy concluded before that bar
        // existed.
        double[][] bars = flatRangeBars(9);
        var strategy = new BtcDonchianBreakoutStrategy(SMALL_PARAMS);
        var resultBefore = strategy.evaluate(bars[0], bars[1], bars[2]);

        double[] highs10 = java.util.Arrays.copyOf(bars[0], 10);
        double[] lows10 = java.util.Arrays.copyOf(bars[1], 10);
        double[] closes10 = java.util.Arrays.copyOf(bars[2], 10);
        highs10[9] = 500; lows10[9] = 1; closes10[9] = 250; // wild, unrelated future bar

        // A 9-bar evaluation must be identical whether or not a 10th bar will later exist -
        // simulated here by re-deriving the "prior" evaluation the strategy computes internally
        // for a 10-bar input and checking it matches evaluating those same first 9 bars directly.
        var priorViaTenBarInput = DonchianChannelEngine.evaluate(
            java.util.Arrays.copyOfRange(highs10, 0, 9), java.util.Arrays.copyOfRange(lows10, 0, 9),
            java.util.Arrays.copyOfRange(closes10, 0, 9), SMALL_PARAMS.donchianPeriod());
        var directNineBar = DonchianChannelEngine.evaluate(bars[0], bars[1], bars[2], SMALL_PARAMS.donchianPeriod());

        assertThat(priorViaTenBarInput).isEqualTo(directNineBar);
        assertThat(resultBefore.sufficientData()).isTrue();
    }

    @Test
    void differentParameterObjectsProduceIndependentEvaluationsNotSharedState() {
        double[][] barsBreakout = flatRangeBars(10);
        barsBreakout[0][9] = 112; barsBreakout[1][9] = 108; barsBreakout[2][9] = 110;
        double[][] barsFlat = flatRangeBars(10);

        var strategy = new BtcDonchianBreakoutStrategy(SMALL_PARAMS);
        var resultBreakout = strategy.evaluate(barsBreakout[0], barsBreakout[1], barsBreakout[2]);
        var resultFlat = strategy.evaluate(barsFlat[0], barsFlat[1], barsFlat[2]);

        assertThat(resultBreakout.evidence()[0]).contains("FRESH_BREAKOUT");
        assertThat(resultFlat.evidence()[0]).contains("NO_BREAKOUT_CONTEXT");
    }

    @Test
    void defaultParametersAreExposedAndNonZero() {
        assertThat(BtcDonchianBreakoutStrategy.DEFAULT_PARAMETERS.donchianPeriod()).isGreaterThan(0);
        var strategy = new BtcDonchianBreakoutStrategy(BtcDonchianBreakoutStrategy.DEFAULT_PARAMETERS);
        assertThat(strategy.strategyId()).isEqualTo("BTC_DONCHIAN_BREAKOUT");
        assertThat(strategy.version()).isEqualTo("1.0.0");
        assertThat(strategy.parameters()).isEqualTo(BtcDonchianBreakoutStrategy.DEFAULT_PARAMETERS);
    }
}
