package io.argus.quantcore.institutional.models;

import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Stream;

/**
 * ARGUS Crypto V2 (2026-09-21) - regime-conditional research wrapper around
 * BtcAdaptiveVolatilityMomentumStrategy. RESEARCH status, unwired. Distinct from CryptoStrategy's
 * evaluate(double[] closes) interface because regime classification (CryptoRegimeEngine) needs
 * ATR, which needs highs/lows - a genuinely different input shape, not an arbitrary
 * inconsistency with the other strategies in this package.
 *
 * Research hypothesis (NOT an assumed truth): momentum entries are only taken when
 * CryptoRegimeEngine independently classifies the market as TRENDING_BULL. RANGE/UNKNOWN/
 * volatility-only regimes suppress the entry even if the underlying momentum strategy would have
 * gone LONG. This can only ever turn a LONG into a FLAT - it never invents a signal the
 * underlying momentum strategy did not already produce.
 */
public final class CryptoRegimeConditionalMomentumStrategy {

    public static final String STRATEGY_ID = "BTC_REGIME_ADAPTIVE_MOMENTUM";
    public static final String VERSION = "1.0.0";

    private final BtcAdaptiveVolatilityMomentumStrategy momentum;

    public CryptoRegimeConditionalMomentumStrategy(BtcAdaptiveVolatilityMomentumStrategy.Parameters momentumParams) {
        this.momentum = new BtcAdaptiveVolatilityMomentumStrategy(momentumParams);
    }

    public CryptoStrategyEvaluation evaluate(double[] closes, double[] highs, double[] lows) {
        CryptoStrategyEvaluation base = momentum.evaluate(closes);
        if (!base.sufficientData() || base.position() != CryptoPosition.LONG) {
            return base; // nothing to gate - already FLAT or insufficient data
        }

        CryptoFeatureEngine.Snapshot snapshot = CryptoFeatureEngine.compute(closes, highs, lows);
        CryptoRegimeEngine.Result regime = CryptoRegimeEngine.classify(snapshot);

        if (regime.regime() != CryptoRegimeEngine.Regime.TRENDING_BULL) {
            String[] evidence = Stream.concat(
                Arrays.stream(base.evidence()),
                Stream.of("SUPPRESSED: regime=" + regime.regime() + " (requires TRENDING_BULL for entry)")
            ).toArray(String[]::new);
            Map<String, Double> diagnostics = new HashMap<>(base.diagnostics());
            diagnostics.put("regimeConfidence", regime.regimeConfidence());
            return new CryptoStrategyEvaluation(CryptoPosition.FLAT, true, evidence, diagnostics);
        }

        String[] evidence = Stream.concat(
            Arrays.stream(base.evidence()),
            Stream.of("CONFIRMED: regime=TRENDING_BULL, entry allowed")
        ).toArray(String[]::new);
        return new CryptoStrategyEvaluation(base.position(), true, evidence, base.diagnostics());
    }
}
