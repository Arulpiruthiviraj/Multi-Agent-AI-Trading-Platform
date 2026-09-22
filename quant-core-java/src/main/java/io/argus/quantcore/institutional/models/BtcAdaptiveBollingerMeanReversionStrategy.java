package io.argus.quantcore.institutional.models;

import java.util.Arrays;
import java.util.Map;

/**
 * ARGUS Crypto V2 (2026-09-21) - adaptive research extension of the Tan (2025) Bollinger
 * mean-reversion baseline. RESEARCH status, unwired. The thesis's own baseline (window=20,
 * multiplier=2) reportedly generated ZERO trades - this class turns that into a research
 * question by making both parameters caller-supplied rather than assuming the baseline was
 * simply "too tight" and loosening it unconditionally (CLAUDE.md: a correct NO TRADE is a valid
 * result).
 *
 * evaluate() is stateful-by-replay: given the full closes series, it walks forward bar-by-bar
 * from the first bar with enough history, applying the entry/exit rule causally (each bar's
 * decision compares only that bar and the one immediately before it), and returns the resulting
 * position AS OF THE LAST BAR.
 *   ENTRY (FLAT -> LONG): price crosses below the lower Bollinger band
 *   EXIT  (LONG -> FLAT): price crosses above the SMA (middle band)
 * Long-only, matching the thesis's own reported implementation - no shorts added here.
 */
public final class BtcAdaptiveBollingerMeanReversionStrategy implements CryptoStrategy {

    public record Parameters(int window, double stdDevMultiplier) {
    }

    /** Matches the Tan (2025) baseline's own parameters exactly. */
    public static final Parameters TAN2025_EQUIVALENT_PARAMETERS = new Parameters(20, 2.0);

    private final Parameters params;

    public BtcAdaptiveBollingerMeanReversionStrategy(Parameters params) {
        this.params = params;
    }

    public Parameters parameters() {
        return params;
    }

    @Override
    public String strategyId() {
        return "BTC_ADAPTIVE_BOLLINGER_MEAN_REVERSION";
    }

    @Override
    public String version() {
        return "1.0.0";
    }

    @Override
    public CryptoStrategyEvaluation evaluate(double[] closes) {
        int minBars = params.window() + 2;
        if (closes.length < minBars) {
            return new CryptoStrategyEvaluation(CryptoPosition.FLAT, false,
                new String[]{"insufficient bar history (" + closes.length + " bars, need >= " + minBars + ")"},
                Map.of());
        }

        CryptoPosition position = CryptoPosition.FLAT;
        int entries = 0;
        int exits = 0;
        int lastTransitionBar = -1;
        Double prevPrice = null;
        CryptoBollingerBands.Bands prevBands = null;

        for (int i = params.window(); i < closes.length; i++) {
            double[] windowPrices = Arrays.copyOfRange(closes, 0, i + 1);
            CryptoBollingerBands.Bands bands = CryptoBollingerBands.calculate(windowPrices, params.window(), params.stdDevMultiplier());
            double price = closes[i];

            if (prevPrice != null) {
                boolean crossedBelowLower = prevPrice >= prevBands.lower() && price < bands.lower();
                boolean crossedAboveMiddle = prevPrice <= prevBands.middle() && price > bands.middle();

                if (position == CryptoPosition.FLAT && crossedBelowLower) {
                    position = CryptoPosition.LONG;
                    entries++;
                    lastTransitionBar = i;
                } else if (position == CryptoPosition.LONG && crossedAboveMiddle) {
                    position = CryptoPosition.FLAT;
                    exits++;
                    lastTransitionBar = i;
                }
            }
            prevPrice = price;
            prevBands = bands;
        }

        String[] evidence = {
            String.format("window=%d multiplier=%.2f: replayed %d bars, %d entries, %d exits, final position=%s",
                params.window(), params.stdDevMultiplier(), closes.length - params.window(), entries, exits, position),
            lastTransitionBar >= 0 ? ("last transition at bar index " + lastTransitionBar) : "no transition occurred - price never crossed the lower band while flat",
        };

        return new CryptoStrategyEvaluation(position, true, evidence, Map.of(
            "entries", (double) entries,
            "exits", (double) exits
        ));
    }
}
