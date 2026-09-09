package io.argus.quantcore.institutional.models;

/**
 * Gap continuation - the opposite-direction bet from IntradayGapReversalEngine.java's gap-fade
 * signal (both real, differently-sourced strategies covering the same underlying overnight-gap
 * phenomenon from opposite sides - consistent with the broader overnight/intraday decomposition
 * literature, e.g. Lou, Polk &amp; Skouras, "A Tug of War," J. Financial Economics 2019). Where
 * IntradayGapReversalEngine bets an extreme gap reverts intraday, this engine bets a gap
 * *confirmed by early relative volume* tends to continue - the catalog's own hypothesis for #27
 * ("a real overnight gap, confirmed by early volume, tends to continue intraday").
 *
 * Reuses VolumeSignalEngine.java's own relativeVolume computation (via its evaluate() call)
 * rather than a second relative-volume implementation.
 */
public final class GapContinuationEngine {

    private GapContinuationEngine() {
    }

    public record Result(
        double gapPct,
        double relativeVolume,
        boolean volumeConfirmed, // relativeVolume at/above the caller-supplied confirmation multiple
        String continuationSignal // BUY (positive gap, volume-confirmed), SELL (negative gap, volume-confirmed), NEUTRAL
    ) {
    }

    /**
     * @param opens               session opens, chronological.
     * @param closes              session closes, chronological, same length; closes[i-1] is "prior close".
     * @param volumes             session volumes, same length.
     * @param avgVolumeWindow     window for the "average volume" the day's volume is measured against.
     * @param volumeConfirmMult   relativeVolume at/above this counts as confirming the gap (e.g. 1.5).
     * @return null if there isn't enough data, or today's opening gap is zero/undefined.
     */
    public static Result evaluate(double[] opens, double[] closes, double[] volumes, int avgVolumeWindow, double volumeConfirmMult) {
        int n = closes.length;
        if (opens.length != n || volumes.length != n || n < 2 || avgVolumeWindow < 1 || n <= avgVolumeWindow) {
            return null;
        }
        double priorClose = closes[n - 2];
        double todayOpen = opens[n - 1];
        if (priorClose == 0) {
            return null;
        }
        double gapPct = (todayOpen - priorClose) / priorClose;

        double avgVolume = 0;
        for (int i = n - 1 - avgVolumeWindow; i < n - 1; i++) avgVolume += volumes[i];
        avgVolume /= avgVolumeWindow;
        if (avgVolume == 0) {
            return null;
        }
        double relativeVolume = volumes[n - 1] / avgVolume;
        boolean confirmed = relativeVolume >= volumeConfirmMult;

        String signal = "NEUTRAL";
        if (confirmed && gapPct > 0) signal = "BUY";
        else if (confirmed && gapPct < 0) signal = "SELL";

        return new Result(gapPct, relativeVolume, confirmed, signal);
    }
}
