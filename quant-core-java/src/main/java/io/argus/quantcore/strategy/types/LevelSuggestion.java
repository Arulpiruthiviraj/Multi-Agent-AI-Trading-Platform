package io.argus.quantcore.strategy.types;

/** Mirrors src/server/quant/strategies/types.ts's {@code LevelSuggestion} — always states why. */
public record LevelSuggestion(Double price, String basis) {
    public static LevelSuggestion none(String basis) {
        return new LevelSuggestion(null, basis);
    }
}
