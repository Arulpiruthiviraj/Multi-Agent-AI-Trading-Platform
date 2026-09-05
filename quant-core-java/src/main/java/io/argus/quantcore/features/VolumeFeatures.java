package io.argus.quantcore.features;

import io.argus.quantcore.backtest.engine.Bar;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.Arrays;
import java.util.List;

/**
 * Ported byte-for-byte from src/server/quant/indicators/volume.ts (JMIG-001). {@code
 * sessionStartOfDay}/{@code calculateSessionVWAP} are genuinely new (no prior implementation
 * anywhere) per volume.ts's own header note - distinct from the existing cumulative
 * TechnicalIndicatorsCompat.vwap this class calls internally once the session window is resolved.
 */
public final class VolumeFeatures {
    private VolumeFeatures() {
    }

    public record VwapContext(Double vwap, Double distancePct, Double slopePct, String event) {
    }

    public record Result(Double volumeSMA20, Double relativeVolume, Boolean isSpike, Double volumeROC,
                          double obv, double mfi, VwapContext vwap, Double cmf, double ad) {
    }

    public static Double volumeSMA(double[] volumes, int period) {
        if (volumes.length < period) {
            return null;
        }
        double sum = 0;
        for (int i = volumes.length - period; i < volumes.length; i++) {
            sum += volumes[i];
        }
        return sum / period;
    }

    /** Current bar's volume divided by its own trailing average, excluding the current bar itself. */
    public static Double relativeVolume(double[] volumes, int period) {
        if (volumes.length < period + 1) {
            return null;
        }
        double[] priorAll = Arrays.copyOfRange(volumes, 0, volumes.length - 1);
        Double avg = volumeSMA(priorAll, period);
        if (avg == null || avg == 0) {
            return null;
        }
        return volumes[volumes.length - 1] / avg;
    }

    public static Boolean isVolumeSpike(double[] volumes, int period, double threshold) {
        Double rvol = relativeVolume(volumes, period);
        return rvol == null ? null : rvol >= threshold;
    }

    public static Double volumeROC(double[] volumes, int period) {
        if (volumes.length < period + 1) {
            return null;
        }
        double anchor = volumes[volumes.length - 1 - period];
        if (anchor == 0) {
            return null;
        }
        return ((volumes[volumes.length - 1] - anchor) / anchor) * 100;
    }

    /** Midnight-UTC of the given bar's own day - a simple, documented session-boundary default. */
    public static long sessionStartOfDay(long timestampMs) {
        ZonedDateTime z = Instant.ofEpochMilli(timestampMs).atZone(ZoneOffset.UTC);
        return ZonedDateTime.of(z.getYear(), z.getMonthValue(), z.getDayOfMonth(), 0, 0, 0, 0, ZoneOffset.UTC)
            .toInstant().toEpochMilli();
    }

    /** Real session-anchored VWAP: cumulative typical-price VWAP over only the bars at/after
     *  {@code sessionStartMs} (resets each session, not cumulative across all supplied history). */
    public static Double calculateSessionVWAP(List<Bar> bars, Long sessionStartMs) {
        if (bars.isEmpty()) {
            return null;
        }
        long boundary = sessionStartMs != null ? sessionStartMs : sessionStartOfDay(bars.get(bars.size() - 1).timestampMs());
        List<Bar> sessionBars = bars.stream().filter(b -> b.timestampMs() >= boundary).toList();
        if (sessionBars.isEmpty()) {
            return null;
        }
        double[] typicalPrices = sessionBars.stream().mapToDouble(b -> (b.high() + b.low() + b.close()) / 3.0).toArray();
        double[] volumes = sessionBars.stream().mapToDouble(Bar::volume).toArray();
        return TechnicalIndicatorsCompat.vwap(typicalPrices, volumes);
    }

    /** RECLAIM = two most recent closes crossed from below session VWAP to above it (bullish).
     *  REJECTION = the mirror, bearish crossing. */
    public static VwapContext computeVWAPContext(List<Bar> bars, Long sessionStartMs) {
        Double vwap = calculateSessionVWAP(bars, sessionStartMs);
        if (vwap == null || bars.isEmpty()) {
            return new VwapContext(null, null, null, "NONE");
        }

        double currentPrice = bars.get(bars.size() - 1).close();
        double distancePct = ((currentPrice - vwap) / vwap) * 100;

        String event = "NONE";
        Double slopePct = null;
        if (bars.size() >= 2) {
            Double priorVwap = calculateSessionVWAP(bars.subList(0, bars.size() - 1), sessionStartMs);
            if (priorVwap != null) {
                slopePct = ((vwap - priorVwap) / priorVwap) * 100;
                double priorClose = bars.get(bars.size() - 2).close();
                if (priorClose < priorVwap && currentPrice > vwap) {
                    event = "RECLAIM";
                } else if (priorClose > priorVwap && currentPrice < vwap) {
                    event = "REJECTION";
                }
            }
        }
        return new VwapContext(vwap, distancePct, slopePct, event);
    }

    /** Chaikin Money Flow over {@code period} bars. Null if summed volume is 0 or every bar in the
     *  window has zero range (high===low). */
    public static Double calculateCMF(List<Bar> bars, int period) {
        if (bars.size() < period) {
            return null;
        }
        List<Bar> window = bars.subList(bars.size() - period, bars.size());
        double mfvSum = 0;
        double volSum = 0;
        for (Bar b : window) {
            if (b.high() == b.low()) {
                continue;
            }
            double mfm = ((b.close() - b.low()) - (b.high() - b.close())) / (b.high() - b.low());
            mfvSum += mfm * b.volume();
            volSum += b.volume();
        }
        if (volSum == 0) {
            return null;
        }
        return mfvSum / volSum;
    }

    /** Cumulative Accumulation/Distribution line over the full bars array supplied. */
    public static double calculateAD(List<Bar> bars) {
        double ad = 0;
        for (Bar b : bars) {
            if (b.high() == b.low()) {
                continue;
            }
            double mfm = ((b.close() - b.low()) - (b.high() - b.close())) / (b.high() - b.low());
            ad += mfm * b.volume();
        }
        return ad;
    }

    public static Result computeVolumeFeatures(List<Bar> bars) {
        double[] highs = bars.stream().mapToDouble(Bar::high).toArray();
        double[] lows = bars.stream().mapToDouble(Bar::low).toArray();
        double[] closes = bars.stream().mapToDouble(Bar::close).toArray();
        double[] volumes = bars.stream().mapToDouble(Bar::volume).toArray();

        return new Result(
            volumeSMA(volumes, 20),
            relativeVolume(volumes, 20),
            isVolumeSpike(volumes, 20, 2),
            volumeROC(volumes, 10),
            TechnicalIndicatorsCompat.obv(closes, volumes),
            TechnicalIndicatorsCompat.mfi(highs, lows, closes, volumes, 14),
            computeVWAPContext(bars, null),
            calculateCMF(bars, 20),
            calculateAD(bars)
        );
    }
}
