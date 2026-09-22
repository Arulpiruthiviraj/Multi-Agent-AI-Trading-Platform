package io.argus.quantcore.institutional.models;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * ARGUS Crypto V2 (2026-09-21) - generic chronological TRAIN/VALIDATE/OOS window harness.
 * RESEARCH status, unwired. Not yet run against real BTC history - no real multi-year BTC OHLCV
 * dataset is connected to this Java test environment as of this date, so this class provides the
 * MECHANISM (verified correct via synthetic price series in its own test suite), not a real OOS
 * result. Running it against genuine historical BTC data is real, separate, not-yet-done work.
 *
 * Windows are strictly chronological and non-overlapping within a single fold; rolling to the
 * next fold advances all three ranges forward together (walk-forward, never a random shuffle).
 */
public final class WalkForwardValidator {
    private WalkForwardValidator() {
    }

    public enum WindowRole { TRAIN, VALIDATE, OOS }

    public record Fold(int foldIndex, int trainStart, int trainEnd, int validateStart, int validateEnd,
                        int oosStart, int oosEnd) {
    }

    public record BarEvaluation(int barIndex, WindowRole role, CryptoPosition position, boolean sufficientData) {
    }

    /**
     * Builds chronological folds over [0, totalBars). Each fold's TRAIN/VALIDATE/OOS windows are
     * back-to-back and non-overlapping; folds roll forward by `oosLengthBars` each time, so every
     * bar past the first fold's TRAIN+VALIDATE prefix is used exactly once as OOS across the
     * whole walk-forward run.
     */
    public static List<Fold> buildFolds(int totalBars, int trainLengthBars, int validateLengthBars, int oosLengthBars) {
        List<Fold> folds = new ArrayList<>();
        int foldIndex = 0;
        int trainStart = 0;
        while (true) {
            int trainEnd = trainStart + trainLengthBars;
            int validateStart = trainEnd;
            int validateEnd = validateStart + validateLengthBars;
            int oosStart = validateEnd;
            int oosEnd = oosStart + oosLengthBars;
            if (oosEnd > totalBars) {
                break;
            }
            folds.add(new Fold(foldIndex, trainStart, trainEnd, validateStart, validateEnd, oosStart, oosEnd));
            foldIndex++;
            trainStart += oosLengthBars;
        }
        return folds;
    }

    /**
     * Evaluates `strategy` causally at every bar in [rangeStart, rangeEnd) using ONLY
     * closes[0..i] (never future bars) - the no-lookahead guarantee. Bars before the strategy has
     * enough history are recorded with sufficientData=false, never skipped silently.
     */
    public static List<BarEvaluation> evaluateRange(CryptoStrategy strategy, double[] closes,
                                                      int rangeStart, int rangeEnd, WindowRole role) {
        List<BarEvaluation> out = new ArrayList<>();
        for (int i = rangeStart; i < rangeEnd; i++) {
            double[] window = Arrays.copyOfRange(closes, 0, i + 1);
            CryptoStrategyEvaluation eval = strategy.evaluate(window);
            out.add(new BarEvaluation(i, role, eval.position(), eval.sufficientData()));
        }
        return out;
    }
}
