package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Xu, Wang, Han, Zhang, Liu &amp; Chang (2022) "A Quantitative Trading Strategy Based on A
 * Position Management Model" - Section 4.3.2. See PositionAveragingEngine's own class doc for the
 * provenance/OCR-corruption disclosure this test suite verifies against (independently re-derived
 * economics, not transcribed corrupted equations).
 */
class PositionAveragingEngineTest {

    @Test
    void requiredAddOnPosition_isNullRatherThanFabricated_whenRecoveryCannotOvercomeRoundTripCommission() {
        // 1% commission each way = ~2% round trip; a 1% assumed recovery can never clear that,
        // no matter how large the add-on is - denominator is <= 0.
        Double addOn = PositionAveragingEngine.requiredAddOnPosition(1000, 950, 0.01, 0.01);
        assertThat(addOn).isNull();
    }

    @Test
    void requiredAddOnPosition_isNullForInvalidInputs() {
        assertThat(PositionAveragingEngine.requiredAddOnPosition(-1, 100, 0.01, 0.05)).isNull();
        assertThat(PositionAveragingEngine.requiredAddOnPosition(100, -1, 0.01, 0.05)).isNull();
        assertThat(PositionAveragingEngine.requiredAddOnPosition(100, 100, 1.0, 0.05)).isNull();
        assertThat(PositionAveragingEngine.requiredAddOnPosition(100, 100, -0.01, 0.05)).isNull();
    }

    @Test
    void requiredAddOnPosition_sizingActuallyAchievesBreakeven_whenTheAssumedRecoveryIsRealized() {
        double priorCostBasis = 1000;
        double priorMarketValue = 900; // a 10% unrealized decline
        double commissionRate = 0.02; // bitcoin's stated rate in the source paper
        double assumedRecoveryRate = 0.15; // comfortably clears round-trip commission

        Double addOn = PositionAveragingEngine.requiredAddOnPosition(priorCostBasis, priorMarketValue, commissionRate, assumedRecoveryRate);
        assertThat(addOn).isNotNull();
        assertThat(addOn).isGreaterThan(0);

        double netPnl = PositionAveragingEngine.netPnlIfRecoveryRealized(priorCostBasis, priorMarketValue, addOn, commissionRate, assumedRecoveryRate);
        // The sizing formula's whole point: breakeven (>= 0, and close to exactly 0 - not a
        // fabricated cushion) if the assumed recovery is realized exactly.
        assertThat(netPnl).isCloseTo(0.0, within(1e-6));
    }

    @Test
    void requiredAddOnPosition_returnsZero_whenExistingPositionAlreadyBreaksEvenAtTheAssumedRecovery() {
        // No decline yet (cost basis == market value); any positive recovery already clears
        // breakeven net of the round-trip commission difference, so no add-on is required.
        double priorCostBasis = 1000;
        double priorMarketValue = 1000;
        Double addOn = PositionAveragingEngine.requiredAddOnPosition(priorCostBasis, priorMarketValue, 0.01, 0.10);
        assertThat(addOn).isNotNull();
        assertThat(addOn).isEqualTo(0.0);
    }

    @Test
    void requiredAddOnPosition_growsAsTheDeclineDeepens_forAFixedAssumedRecovery() {
        double commissionRate = 0.01;
        double assumedRecoveryRate = 0.10;
        Double addOnShallow = PositionAveragingEngine.requiredAddOnPosition(1000, 970, commissionRate, assumedRecoveryRate);
        Double addOnDeep = PositionAveragingEngine.requiredAddOnPosition(1000, 850, commissionRate, assumedRecoveryRate);

        assertThat(addOnShallow).isNotNull();
        assertThat(addOnDeep).isNotNull();
        assertThat(addOnDeep).isGreaterThan(addOnShallow);
    }

    // ---- Streak / percentile statistics (the source's own "Apriori"-mislabeled analysis) ----

    @Test
    void consecutiveStreaks_countsRunsCorrectlyAndBreaksOnZero() {
        double[] returns = {0.01, 0.02, -0.01, -0.02, -0.03, 0.0, 0.01, 0.01, 0.01};
        PositionAveragingEngine.Streak[] streaks = PositionAveragingEngine.consecutiveStreaks(returns);

        assertThat(streaks).hasSize(3);
        assertThat(streaks[0].isUp()).isTrue();
        assertThat(streaks[0].length()).isEqualTo(2);
        assertThat(streaks[1].isUp()).isFalse();
        assertThat(streaks[1].length()).isEqualTo(3);
        assertThat(streaks[2].isUp()).isTrue();
        assertThat(streaks[2].length()).isEqualTo(3);
    }

    @Test
    void streakCoverageFraction_matchesTheSourcePapersOwnWorkedExample() {
        // Source Table 10: K2=27, K3=11, K4=6, K5=2 occurrences of consecutive-decline streaks.
        // P(K2)+P(K3)+P(K4) = 95.65% of all down-streaks are length <= 4.
        java.util.List<PositionAveragingEngine.Streak> streaks = new java.util.ArrayList<>();
        for (int i = 0; i < 27; i++) streaks.add(new PositionAveragingEngine.Streak(false, 2, i));
        for (int i = 0; i < 11; i++) streaks.add(new PositionAveragingEngine.Streak(false, 3, i));
        for (int i = 0; i < 6; i++) streaks.add(new PositionAveragingEngine.Streak(false, 4, i));
        for (int i = 0; i < 2; i++) streaks.add(new PositionAveragingEngine.Streak(false, 5, i));

        double coverage = PositionAveragingEngine.streakCoverageFraction(
            streaks.toArray(new PositionAveragingEngine.Streak[0]), false, 4);
        assertThat(coverage).isCloseTo(0.9565, within(0.001));
    }

    @Test
    void streakCoverageFraction_isZero_whenNoStreaksMatchTheRequestedDirection() {
        PositionAveragingEngine.Streak[] streaks = {new PositionAveragingEngine.Streak(true, 3, 0)};
        assertThat(PositionAveragingEngine.streakCoverageFraction(streaks, false, 4)).isEqualTo(0.0);
    }

    @Test
    void quantile_medianOfOddLengthArray() {
        double[] values = {1, 3, 2, 5, 4};
        assertThat(PositionAveragingEngine.quantile(values, 0.5)).isEqualTo(3.0);
    }

    @Test
    void quantile_interpolatesBetweenPoints() {
        double[] values = {10, 20, 30, 40};
        // rank = 0.5 * 3 = 1.5 -> interpolate between values[1]=20 and values[2]=30
        assertThat(PositionAveragingEngine.quantile(values, 0.5)).isCloseTo(25.0, within(1e-9));
    }

    @Test
    void quantile_isNullRatherThanFabricated_forEmptyInput() {
        assertThat(PositionAveragingEngine.quantile(new double[0], 0.5)).isNull();
    }
}
