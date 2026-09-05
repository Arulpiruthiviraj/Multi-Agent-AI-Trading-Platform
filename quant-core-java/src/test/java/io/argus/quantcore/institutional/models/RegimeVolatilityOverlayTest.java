package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.models.HmmRegimeEngine.Regime;
import io.argus.quantcore.institutional.models.QuantEnsembleEngine.EnsembleResult;
import io.argus.quantcore.institutional.models.QuantEnsembleEngine.ModelVote;
import io.argus.quantcore.institutional.models.QuantEnsembleEngine.Side;
import io.argus.quantcore.institutional.models.RegimeVolatilityOverlay.AdjustedAdvisory;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class RegimeVolatilityOverlayTest {

    private static EnsembleResult buyEnsemble(double confidence) {
        ModelVote[] votes = { new ModelVote("factor", "factor", Side.BUY, confidence) };
        return QuantEnsembleEngine.combine(votes);
    }

    @Test
    void trendAlignedRegimeFullyTrustsTheEnsembleConfidenceAtNormalVolatility() {
        AdjustedAdvisory result = RegimeVolatilityOverlay.apply(buyEnsemble(0.8), Regime.BULL_TRENDING, RegimeVolatilityOverlay.TARGET_DAILY_VOLATILITY);
        assertThat(result.regimeMultiplier()).isCloseTo(1.0, within(1e-9));
        assertThat(result.volatilityMultiplier()).isCloseTo(1.0, within(1e-9));
        assertThat(result.adjustedConfidence()).isCloseTo(0.8, within(1e-9));
        assertThat(result.gated()).isFalse();
    }

    @Test
    void counterTrendRegimeDiscountsTheEnsembleConfidence() {
        AdjustedAdvisory result = RegimeVolatilityOverlay.apply(buyEnsemble(0.8), Regime.BEAR_TRENDING, RegimeVolatilityOverlay.TARGET_DAILY_VOLATILITY);
        assertThat(result.regimeMultiplier()).isCloseTo(0.5, within(1e-9));
        assertThat(result.adjustedConfidence()).isCloseTo(0.4, within(1e-9));
    }

    @Test
    void highVolChaosDiscountsMoreThanMeanReverting() {
        AdjustedAdvisory chaos = RegimeVolatilityOverlay.apply(buyEnsemble(0.8), Regime.HIGH_VOL_CHAOS, RegimeVolatilityOverlay.TARGET_DAILY_VOLATILITY);
        AdjustedAdvisory meanReverting = RegimeVolatilityOverlay.apply(buyEnsemble(0.8), Regime.MEAN_REVERTING, RegimeVolatilityOverlay.TARGET_DAILY_VOLATILITY);
        assertThat(chaos.regimeMultiplier()).isLessThan(meanReverting.regimeMultiplier());
    }

    @Test
    void elevatedVolatilityScalesConfidenceDownViaInverseVolTargeting() {
        double elevatedVol = RegimeVolatilityOverlay.TARGET_DAILY_VOLATILITY * 3;
        AdjustedAdvisory result = RegimeVolatilityOverlay.apply(buyEnsemble(0.8), Regime.BULL_TRENDING, elevatedVol);
        assertThat(result.volatilityMultiplier()).isCloseTo(1.0 / 3.0, within(1e-6));
        assertThat(result.adjustedConfidence()).isLessThan(0.8);
    }

    @Test
    void quietMarketNeverScalesConfidenceAboveTheClampedMaximum() {
        double tinyVol = RegimeVolatilityOverlay.TARGET_DAILY_VOLATILITY / 100;
        AdjustedAdvisory result = RegimeVolatilityOverlay.apply(buyEnsemble(0.8), Regime.BULL_TRENDING, tinyVol);
        assertThat(result.volatilityMultiplier()).isCloseTo(RegimeVolatilityOverlay.MAX_VOLATILITY_MULTIPLIER, within(1e-9));
        assertThat(result.adjustedConfidence()).isCloseTo(Math.min(1.0, 0.8 * RegimeVolatilityOverlay.MAX_VOLATILITY_MULTIPLIER), within(1e-9));
    }

    @Test
    void neutralEnsembleIsAlwaysGatedWithZeroAdjustedConfidence() {
        ModelVote[] votes = {
            new ModelVote("a", "x", Side.BUY, 0.5),
            new ModelVote("b", "y", Side.SELL, 0.5),
        };
        EnsembleResult neutral = QuantEnsembleEngine.combine(votes);
        AdjustedAdvisory result = RegimeVolatilityOverlay.apply(neutral, Regime.BULL_TRENDING, RegimeVolatilityOverlay.TARGET_DAILY_VOLATILITY);
        assertThat(result.adjustedConfidence()).isEqualTo(0.0);
        assertThat(result.gated()).isTrue();
    }

    @Test
    void lowConfidenceCombinedWithACounterTrendRegimeGetsGated() {
        AdjustedAdvisory result = RegimeVolatilityOverlay.apply(buyEnsemble(0.25), Regime.BEAR_TRENDING, RegimeVolatilityOverlay.TARGET_DAILY_VOLATILITY);
        assertThat(result.adjustedConfidence()).isLessThan(RegimeVolatilityOverlay.MIN_ADJUSTED_CONFIDENCE_TO_SURFACE);
        assertThat(result.gated()).isTrue();
    }

    @Test
    void adjustedConfidenceNeverExceedsOne() {
        AdjustedAdvisory result = RegimeVolatilityOverlay.apply(buyEnsemble(1.0), Regime.BULL_TRENDING, RegimeVolatilityOverlay.TARGET_DAILY_VOLATILITY / 100);
        assertThat(result.adjustedConfidence()).isLessThanOrEqualTo(1.0);
    }
}
