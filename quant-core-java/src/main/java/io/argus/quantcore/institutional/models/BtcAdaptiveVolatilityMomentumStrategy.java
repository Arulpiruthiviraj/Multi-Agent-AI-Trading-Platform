package io.argus.quantcore.institutional.models;

import java.util.Arrays;
import java.util.Map;

import io.argus.quantcore.features.StatisticsMath;

/**
 * ARGUS Crypto V2 (2026-09-21) - adaptive research extension of a volatility-adjusted momentum
 * rule, modeled on Tan (2025) "Optimal Bitcoin Trading Strategy Development...". RESEARCH status:
 * real, tested, zero HTTP endpoint, zero live consumer, never wired to
 * ChiefTraderAgent/RiskEngine/OMS/BrokerManager.
 *
 * A SEPARATE strategy/version from the baseline reproduction (BtcTan2025VolAdjustedMomentumStrategy
 * wraps this class with fixed parameters rather than duplicating its logic - CLAUDE.md Java rule 7,
 * single authoritative computation path). Investigates whether a different volatility percentile
 * threshold (the thesis's own 80th-percentile choice is one point in a larger space) changes
 * strategy behavior. This class does NOT select a "best" threshold from history - it evaluates
 * whatever threshold the caller supplies. Threshold SELECTION belongs in a walk-forward/OOS
 * harness, never inside the strategy itself, to avoid look-ahead parameter selection.
 *
 * Rule: LONG iff N-day log-return momentum > 0 AND M-day annualized log-return volatility is
 * below its own historical percentile threshold. FLAT otherwise. Long-only (matches the thesis's
 * own reported baseline behavior).
 */
public final class BtcAdaptiveVolatilityMomentumStrategy implements CryptoStrategy {

    public record Parameters(
        int momentumWindowDays,
        int volatilityWindowDays,
        double volatilityPercentileThreshold,
        int periodsPerYear
    ) {
    }

    /** Matches the Tan (2025) baseline's own parameters exactly - a reference point for
     *  reproduction, not an endorsed optimum. */
    public static final Parameters TAN2025_EQUIVALENT_PARAMETERS = new Parameters(30, 60, 80.0, 365);

    private final Parameters params;

    public BtcAdaptiveVolatilityMomentumStrategy(Parameters params) {
        this.params = params;
    }

    public Parameters parameters() {
        return params;
    }

    @Override
    public String strategyId() {
        return "BTC_ADAPTIVE_VOLATILITY_MOMENTUM";
    }

    @Override
    public String version() {
        return "1.0.0";
    }

    @Override
    public CryptoStrategyEvaluation evaluate(double[] closes) {
        int minBars = params.volatilityWindowDays() + 2;
        if (closes.length < minBars) {
            return new CryptoStrategyEvaluation(CryptoPosition.FLAT, false,
                new String[]{"insufficient bar history (" + closes.length + " bars, need >= " + minBars + ")"},
                Map.of());
        }

        Double momentum = CryptoLogReturns.cumulativeLogReturn(closes, params.momentumWindowDays());
        if (momentum == null) {
            return new CryptoStrategyEvaluation(CryptoPosition.FLAT, false,
                new String[]{"insufficient bars for " + params.momentumWindowDays() + "-day momentum window"}, Map.of());
        }

        double[] volSeries = CryptoLogReturns.rollingAnnualizedVolatilitySeries(
            closes, params.volatilityWindowDays(), params.periodsPerYear());
        if (volSeries.length < 2) {
            return new CryptoStrategyEvaluation(CryptoPosition.FLAT, false,
                new String[]{"insufficient volatility history to compute a historical percentile"}, Map.of());
        }
        double currentVol = volSeries[volSeries.length - 1];
        double[] priorVol = Arrays.copyOfRange(volSeries, 0, volSeries.length - 1);
        Double volPercentile = StatisticsMath.percentileRank(priorVol, currentVol);
        if (volPercentile == null) {
            return new CryptoStrategyEvaluation(CryptoPosition.FLAT, false,
                new String[]{"could not compute volatility percentile rank"}, Map.of());
        }

        boolean momentumPositive = momentum > 0;
        boolean volBelowThreshold = volPercentile < params.volatilityPercentileThreshold();
        CryptoPosition position = (momentumPositive && volBelowThreshold) ? CryptoPosition.LONG : CryptoPosition.FLAT;

        String[] evidence = {
            String.format("%dd log-return momentum=%.6f (%s 0)", params.momentumWindowDays(), momentum, momentumPositive ? ">" : "<="),
            String.format("%dd annualized volatility=%.4f at percentile=%.1f (threshold=%.1f)",
                params.volatilityWindowDays(), currentVol, volPercentile, params.volatilityPercentileThreshold()),
        };

        return new CryptoStrategyEvaluation(position, true, evidence, Map.of(
            "momentum", momentum,
            "volatility", currentVol,
            "volatilityPercentile", volPercentile,
            "volatilityPercentileThreshold", params.volatilityPercentileThreshold()
        ));
    }
}
