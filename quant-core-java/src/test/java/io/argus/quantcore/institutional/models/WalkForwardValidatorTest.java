package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class WalkForwardValidatorTest {

    @Test
    void buildsChronologicalNonOverlappingFoldsThatRollForwardByTheOosLength() {
        // 100 bars, TRAIN=20, VALIDATE=10, OOS=10 -> fold length 40, rolls forward by 10 each time.
        List<WalkForwardValidator.Fold> folds = WalkForwardValidator.buildFolds(100, 20, 10, 10);

        assertThat(folds).isNotEmpty();
        var first = folds.get(0);
        assertThat(first.trainStart()).isEqualTo(0);
        assertThat(first.trainEnd()).isEqualTo(20);
        assertThat(first.validateStart()).isEqualTo(20);
        assertThat(first.validateEnd()).isEqualTo(30);
        assertThat(first.oosStart()).isEqualTo(30);
        assertThat(first.oosEnd()).isEqualTo(40);

        if (folds.size() > 1) {
            var second = folds.get(1);
            // Rolls forward by the OOS length, not the whole fold - each fold's OOS starts where
            // the previous fold's OOS started + oosLengthBars.
            assertThat(second.trainStart()).isEqualTo(first.trainStart() + 10);
            assertThat(second.oosStart()).isEqualTo(first.oosStart() + 10);
        }

        // Every fold must fit inside the available data.
        for (var fold : folds) {
            assertThat(fold.oosEnd()).isLessThanOrEqualTo(100);
        }
    }

    @Test
    void producesNoFoldsWhenTotalBarsCannotFitEvenOneFold() {
        List<WalkForwardValidator.Fold> folds = WalkForwardValidator.buildFolds(10, 20, 10, 10);
        assertThat(folds).isEmpty();
    }

    @Test
    void evaluateRangeNeverUsesBarsAfterTheEvaluationIndex_changingFutureDataDoesNotChangePastDecisions() {
        var strategy = new BtcTan2025VolAdjustedMomentumStrategy();

        double[] closesA = steadyUptrend(150);
        double[] closesB = closesA.clone();
        // Radically alter every bar AFTER index 100 - a real lookahead-bias test.
        for (int i = 101; i < closesB.length; i++) {
            closesB[i] = closesB[100] * 0.01; // catastrophic future crash in the B series only
        }

        var evalsA = WalkForwardValidator.evaluateRange(strategy, closesA, 90, 101, WalkForwardValidator.WindowRole.OOS);
        var evalsB = WalkForwardValidator.evaluateRange(strategy, closesB, 90, 101, WalkForwardValidator.WindowRole.OOS);

        assertThat(evalsA).hasSameSizeAs(evalsB);
        for (int i = 0; i < evalsA.size(); i++) {
            assertThat(evalsA.get(i).position())
                .as("bar index " + evalsA.get(i).barIndex() + " must be identical regardless of what happens after it")
                .isEqualTo(evalsB.get(i).position());
        }
    }

    @Test
    void recordsInsufficientDataRatherThanSkippingEarlyBarsSilently() {
        var strategy = new BtcTan2025VolAdjustedMomentumStrategy();
        double[] closes = steadyUptrend(150);

        var evals = WalkForwardValidator.evaluateRange(strategy, closes, 0, 5, WalkForwardValidator.WindowRole.TRAIN);

        assertThat(evals).hasSize(5);
        for (var e : evals) {
            assertThat(e.sufficientData()).isFalse();
        }
    }

    private static double[] steadyUptrend(int n) {
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price *= 1.01;
            closes[i] = price;
        }
        return closes;
    }
}
