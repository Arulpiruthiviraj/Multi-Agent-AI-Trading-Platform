package io.argus.quantcore.institutional.models;

/**
 * ARGUS Crypto V2 (2026-09-21) - faithful reproduction of Tan (2025) "Optimal Bitcoin Trading
 * Strategy Development Using Quantitative Models for the Current Market Regime" volatility-
 * adjusted momentum baseline. RESEARCH status: real, tested, zero HTTP endpoint, zero live
 * consumer, never wired to ChiefTraderAgent/RiskEngine/OMS/BrokerManager.
 *
 * A thin, deliberately non-duplicating wrapper: the actual computation lives in
 * BtcAdaptiveVolatilityMomentumStrategy (CLAUDE.md Java rule 7 - single authoritative path per
 * calculation), fixed here to the thesis's own exact parameters (TAN2025_EQUIVALENT_PARAMETERS:
 * 30d momentum window, 60d volatility window, 80th percentile threshold) and exposed under this
 * distinct strategyId/version so reproduction results can be tracked separately from the adaptive
 * research variant. The thesis itself reports this exact specification traded only ~1.5 round
 * trips across its study period and did not beat Buy-and-Hold on Sharpe - this class reproduces
 * the SPECIFICATION, not a claim of profitability.
 */
public final class BtcTan2025VolAdjustedMomentumStrategy implements CryptoStrategy {

    private final BtcAdaptiveVolatilityMomentumStrategy delegate =
        new BtcAdaptiveVolatilityMomentumStrategy(BtcAdaptiveVolatilityMomentumStrategy.TAN2025_EQUIVALENT_PARAMETERS);

    @Override
    public String strategyId() {
        return "BTC_TAN2025_VOL_ADJUSTED_MOMENTUM";
    }

    @Override
    public String version() {
        return "1.0.0";
    }

    @Override
    public CryptoStrategyEvaluation evaluate(double[] closes) {
        return delegate.evaluate(closes);
    }
}
