package io.argus.quantcore.institutional.models;

/**
 * ARGUS Crypto V2 (2026-09-21) - faithful reproduction of Tan (2025) Bollinger mean-reversion
 * baseline. RESEARCH status: real, tested, zero HTTP endpoint, zero live consumer.
 *
 * Thin wrapper over BtcAdaptiveBollingerMeanReversionStrategy (single authoritative computation
 * path), fixed to the thesis's own exact parameters (window=20, stdDevMultiplier=2.0). The
 * thesis itself reports this exact specification generated ZERO trades over its study period -
 * this class reproduces the specification and lets real BTC data determine whether that holds
 * here too, rather than assuming it does or "fixing" it before reproduction is verified.
 */
public final class BtcTan2025BollingerMeanReversionStrategy implements CryptoStrategy {

    private final BtcAdaptiveBollingerMeanReversionStrategy delegate =
        new BtcAdaptiveBollingerMeanReversionStrategy(BtcAdaptiveBollingerMeanReversionStrategy.TAN2025_EQUIVALENT_PARAMETERS);

    @Override
    public String strategyId() {
        return "BTC_TAN2025_BOLLINGER_MEAN_REVERSION";
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
