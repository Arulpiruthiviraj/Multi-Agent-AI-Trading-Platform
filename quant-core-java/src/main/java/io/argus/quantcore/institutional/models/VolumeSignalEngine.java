package io.argus.quantcore.institutional.models;

/**
 * Volume breakout + price-volume divergence: real, classical-technical-analysis definitions.
 * Divergence here means price and volume trends disagreeing over the same window - a price move
 * NOT confirmed by rising volume is read as a divergence (weak rally / seller exhaustion), the
 * standard textbook reading, not an invented heuristic.
 */
public final class VolumeSignalEngine {

    private VolumeSignalEngine() {
    }

    public record Result(
        double relativeVolume,
        boolean volumeBreakout,
        double priceChangePct,
        double volumeChangePct,
        boolean bullishDivergence,
        boolean bearishDivergence
    ) {
    }

    /**
     * @param closes             chronological closes.
     * @param volumes            chronological volumes, same length.
     * @param avgVolumeWindow    window for the "average volume" relativeVolume is measured against (e.g. 20).
     * @param divergenceWindow   window for the price/volume trend comparison (e.g. 10, must be even).
     * @param volumeBreakoutMult relativeVolume at/above this counts as a volume breakout (e.g. 2.0).
     * @return null if there isn't enough real data for both computations.
     */
    public static Result evaluate(double[] closes, double[] volumes, int avgVolumeWindow, int divergenceWindow, double volumeBreakoutMult) {
        int n = closes.length;
        if (volumes.length != n || avgVolumeWindow < 1 || divergenceWindow < 2 || divergenceWindow % 2 != 0 || n <= Math.max(avgVolumeWindow, divergenceWindow)) {
            return null;
        }

        double avgVolume = 0;
        for (int i = n - 1 - avgVolumeWindow; i < n - 1; i++) avgVolume += volumes[i];
        avgVolume /= avgVolumeWindow;
        if (avgVolume == 0) {
            return null;
        }
        double relativeVolume = volumes[n - 1] / avgVolume;

        int half = divergenceWindow / 2;
        double priceStart = closes[n - 1 - divergenceWindow];
        double priceEnd = closes[n - 1];
        if (priceStart == 0) {
            return null;
        }
        double priceChangePct = (priceEnd - priceStart) / priceStart;

        double priorHalfVol = 0, recentHalfVol = 0;
        for (int i = n - divergenceWindow; i < n - half; i++) priorHalfVol += volumes[i];
        for (int i = n - half; i < n; i++) recentHalfVol += volumes[i];
        priorHalfVol /= half;
        recentHalfVol /= half;
        if (priorHalfVol == 0) {
            return null;
        }
        double volumeChangePct = (recentHalfVol - priorHalfVol) / priorHalfVol;

        boolean bullishDivergence = priceChangePct < 0 && volumeChangePct < 0;
        boolean bearishDivergence = priceChangePct > 0 && volumeChangePct < 0;

        return new Result(relativeVolume, relativeVolume >= volumeBreakoutMult, priceChangePct, volumeChangePct, bullishDivergence, bearishDivergence);
    }
}
