package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class CryptoExpectedEdgeEngineTest {

    @Test
    void reportsUncalibratedRatherThanTrustingAZeroSampleEstimate() {
        var calibration = new CryptoExpectedEdgeEngine.Calibration(0.6, 0.05, 0.03, 0);
        var result = CryptoExpectedEdgeEngine.estimate(calibration, 0.001, 0.0, 20);
        assertThat(result.calibrated()).isFalse();
        assertThat(result.sufficientEdge()).isFalse(); // never trust an uncalibrated estimate, even if the raw math looks positive
        assertThat(result.reasonCode()).contains("UNCALIBRATED");
    }

    @Test
    void reportsUncalibratedBelowTheMinimumSampleSizeEvenWithManyObservations() {
        var calibration = new CryptoExpectedEdgeEngine.Calibration(0.6, 0.05, 0.03, 15);
        var result = CryptoExpectedEdgeEngine.estimate(calibration, 0.001, 0.0, 20);
        assertThat(result.calibrated()).isFalse();
    }

    @Test
    void computesTheRealExpectedEdgeFormula() {
        // winProb=0.6, avgWin=5%, avgLoss=3%, lossProb=0.4
        // expectedEdge = 0.6*0.05 - 0.4*0.03 = 0.03 - 0.012 = 0.018 (1.8%)
        var calibration = new CryptoExpectedEdgeEngine.Calibration(0.6, 0.05, 0.03, 50);
        var result = CryptoExpectedEdgeEngine.estimate(calibration, 0.002, 0.0, 20);
        assertThat(result.expectedEdgePct()).isCloseTo(0.018, within(1e-9));
        assertThat(result.expectedEdgeAfterCostPct()).isCloseTo(0.016, within(1e-9));
        assertThat(result.calibrated()).isTrue();
        assertThat(result.sufficientEdge()).isTrue();
        assertThat(result.reasonCode()).isEqualTo("OK");
    }

    @Test
    void rejectsATradeWhenCostConsumesTheEntireEdge() {
        var calibration = new CryptoExpectedEdgeEngine.Calibration(0.55, 0.01, 0.01, 100);
        // expectedEdge = 0.55*0.01 - 0.45*0.01 = 0.0055 - 0.0045 = 0.001 (0.1%)
        var result = CryptoExpectedEdgeEngine.estimate(calibration, 0.002, 0.0, 20); // cost (0.2%) exceeds edge (0.1%)
        assertThat(result.expectedEdgeAfterCostPct()).isLessThan(0);
        assertThat(result.sufficientEdge()).isFalse();
        assertThat(result.reasonCode()).contains("NO_EDGE");
    }

    @Test
    void requiresClearingTheSafetyMarginNotJustBreakingEven() {
        var calibration = new CryptoExpectedEdgeEngine.Calibration(0.6, 0.05, 0.03, 100);
        // expectedEdgeAfterCost = 0.018 - 0.002 = 0.016 (1.6%)
        var barelyInsufficient = CryptoExpectedEdgeEngine.estimate(calibration, 0.002, 0.02, 20); // safety margin (2%) > edge (1.6%)
        assertThat(barelyInsufficient.sufficientEdge()).isFalse();

        var sufficient = CryptoExpectedEdgeEngine.estimate(calibration, 0.002, 0.01, 20); // safety margin (1%) < edge (1.6%)
        assertThat(sufficient.sufficientEdge()).isTrue();
    }

    @Test
    void neverFabricatesANegativeWinProbabilityOutOfRangeInputs() {
        var calibration = new CryptoExpectedEdgeEngine.Calibration(-0.5, 0.05, 0.03, 100);
        var result = CryptoExpectedEdgeEngine.estimate(calibration, 0.001, 0.0, 20);
        // clamped to 0 -> expectedEdge = 0*0.05 - 1*0.03 = -0.03
        assertThat(result.expectedEdgePct()).isCloseTo(-0.03, within(1e-9));
    }

    @Test
    void clampsAnOutOfRangeWinProbabilityAboveOne() {
        var calibration = new CryptoExpectedEdgeEngine.Calibration(1.5, 0.05, 0.03, 100);
        var result = CryptoExpectedEdgeEngine.estimate(calibration, 0.001, 0.0, 20);
        // clamped to 1 -> expectedEdge = 1*0.05 - 0*0.03 = 0.05
        assertThat(result.expectedEdgePct()).isCloseTo(0.05, within(1e-9));
    }
}
