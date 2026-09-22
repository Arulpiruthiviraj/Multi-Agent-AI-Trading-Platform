package io.argus.quantcore.institutional.models;

import java.util.Map;

/**
 * Uniform result shape every BTC/crypto research strategy returns (see CryptoStrategy). `evidence`
 * is human-readable, never hidden reasoning (CLAUDE.md: "Do not dump hidden chain-of-thought").
 * `diagnostics` carries the real numeric inputs that drove the decision (momentum, volatility,
 * percentile, entry/exit counts, ...) - never fabricated, always the actual computed values.
 */
public record CryptoStrategyEvaluation(
    CryptoPosition position,
    boolean sufficientData,
    String[] evidence,
    Map<String, Double> diagnostics
) {
}
