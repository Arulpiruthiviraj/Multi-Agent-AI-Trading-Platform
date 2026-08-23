package io.argus.quantcore.strategy.types;

import java.util.List;

/** Mirrors src/server/quant/strategies/types.ts's {@code scoreFromConditions} exactly (rounded %). */
public final class ScoreFromConditions {

    private ScoreFromConditions() {
    }

    public static int compute(List<String> conditionsMet, int totalConditions) {
        if (totalConditions == 0) {
            return 0;
        }
        return (int) Math.round(((double) conditionsMet.size() / totalConditions) * 100);
    }
}
