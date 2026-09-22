package io.argus.quantcore.institutional.models;

/**
 * Uniform shape every BTC (and future crypto) research strategy implements, so a walk-forward
 * harness can iterate over strategies generically instead of each caller hand-rolling its own
 * dispatch. evaluate() must be PURE and CAUSAL: given a closes array ending at "now", it returns
 * the signal as of "now" only - callers (backtest/replay loops) are responsible for executing at
 * the NEXT bar, never the same bar (no-lookahead rule). RESEARCH status only - no implementation
 * of this interface may be called from ChiefTraderAgent/RiskEngine/OMS/BrokerManager.
 */
public interface CryptoStrategy {
    String strategyId();

    String version();

    CryptoStrategyEvaluation evaluate(double[] closes);
}
