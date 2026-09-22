package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Covers CryptoTransactionCostModel, CryptoVolatilityScaledPositionSizing,
 *  CryptoAtrRiskNormalization, CryptoBollingerBands, and CryptoBenchmarkComparison - small,
 *  focused research-advisory helpers, grouped into one file since each has only a few real
 *  behaviors to verify. */
class CryptoResearchHelpersTest {

    @Test
    void tan2025BaselineCostIsExactlyOnePointOnePercentOfNotional() {
        assertThat(CryptoTransactionCostModel.tan2025BaselineCost(10_000)).isCloseTo(10.0, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void realisticCostSumsFeeSpreadAndSlippageIndependently() {
        var inputs = new CryptoTransactionCostModel.RealisticCostInputs(0.001, 0.0005, 0.0002);
        double cost = CryptoTransactionCostModel.realisticCost(10_000, inputs);
        assertThat(cost).isCloseTo(10_000 * 0.0017, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void volatilityScaledSizingScalesUpWhenForecastVolIsBelowTarget() {
        var suggestion = CryptoVolatilityScaledPositionSizing.suggest(0.05, 0.40, 0.20, 3.0);
        assertThat(suggestion.scaleFactor()).isCloseTo(2.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(suggestion.scaledFraction()).isCloseTo(0.10, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(suggestion.capped()).isFalse();
    }

    @Test
    void volatilityScaledSizingNeverExceedsTheHardCapEvenForExtremelyLowForecastVol() {
        var suggestion = CryptoVolatilityScaledPositionSizing.suggest(0.05, 0.40, 0.01, 2.0);
        assertThat(suggestion.capped()).isTrue();
        assertThat(suggestion.scaleFactor()).isEqualTo(2.0);
        assertThat(suggestion.scaledFraction()).isCloseTo(0.10, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void volatilityScaledSizingIsANoOpForInvalidInputs() {
        var suggestion = CryptoVolatilityScaledPositionSizing.suggest(0.05, 0.40, 0, 2.0);
        assertThat(suggestion.scaledFraction()).isEqualTo(0.05);
        assertThat(suggestion.scaleFactor()).isEqualTo(1.0);
    }

    @Test
    void atrRiskNormalizationSuggestsSmallerQuantityForWiderStops() {
        double[] highs = {102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116};
        double[] lows = {98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112};
        double[] closes = {100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114};

        var tight = CryptoAtrRiskNormalization.suggest(highs, lows, closes, 10, 1.0, 1000);
        var wide = CryptoAtrRiskNormalization.suggest(highs, lows, closes, 10, 3.0, 1000);

        assertThat(wide.stopDistancePerUnit()).isGreaterThan(tight.stopDistancePerUnit());
        assertThat(wide.suggestedQuantity()).isLessThan(tight.suggestedQuantity());
    }

    @Test
    void cryptoBollingerBandsWithMultiplierTwoMatchesTheFixedLiveIndicator() {
        double[] prices = {100, 102, 101, 103, 99, 104, 98, 105, 97, 106, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109};
        var live = io.argus.quantcore.indicators.Bollinger.calculate(prices, 20);
        var research = CryptoBollingerBands.calculate(prices, 20, 2.0);

        assertThat(research.upper()).isCloseTo(live.upper(), org.assertj.core.data.Offset.offset(1e-9));
        assertThat(research.lower()).isCloseTo(live.lower(), org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void wideningTheMultiplierWidensTheBands() {
        double[] prices = {100, 102, 101, 103, 99, 104, 98, 105, 97, 106, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109};
        var narrow = CryptoBollingerBands.calculate(prices, 20, 1.0);
        var wide = CryptoBollingerBands.calculate(prices, 20, 3.0);

        assertThat(wide.upper() - wide.lower()).isGreaterThan(narrow.upper() - narrow.lower());
    }

    @Test
    void buyAndHoldComputesTotalAndAnnualizedReturnFromFirstToLastClose() {
        double[] closes = new double[366]; // 1 year of daily bars + 1
        for (int i = 0; i < closes.length; i++) closes[i] = 100 * Math.pow(1.10, i / 365.0);

        var result = CryptoBenchmarkComparison.buyAndHold(closes, 365);
        assertThat(result.totalReturn()).isCloseTo(0.10, org.assertj.core.data.Offset.offset(1e-3));
        assertThat(result.annualizedReturn()).isCloseTo(0.10, org.assertj.core.data.Offset.offset(1e-3));
    }

    @Test
    void buyAndHoldReportsNanRatherThanFabricatingAReturnForDegenerateInput() {
        var result = CryptoBenchmarkComparison.buyAndHold(new double[]{100}, 365);
        assertThat(result.totalReturn()).isNaN();
    }
}
