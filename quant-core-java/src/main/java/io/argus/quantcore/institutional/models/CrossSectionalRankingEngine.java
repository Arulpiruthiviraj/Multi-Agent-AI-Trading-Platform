package io.argus.quantcore.institutional.models;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * Cross-sectional momentum / relative-strength ranking: ranks a basket of symbols by trailing
 * return over a common lookback window. Distinct from TimeSeriesMomentumEngine (which asks
 * "is this symbol's own history trending up") - this asks "how does this symbol's return compare
 * to its peers right now", the classical cross-sectional-momentum question.
 */
public final class CrossSectionalRankingEngine {

    private CrossSectionalRankingEngine() {
    }

    public record SymbolReturn(String symbol, double totalReturn) {
    }

    public record Ranked(String symbol, double totalReturn, int rank, double percentile) {
    }

    public record Result(List<Ranked> ranked, List<String> topDecile, List<String> bottomDecile) {
    }

    /**
     * @param closesBySymbol chronological close-price series per symbol; each series must have at
     *                       least lookbackBars+1 points or that symbol is silently excluded
     *                       (never a fabricated return for insufficient data).
     * @param lookbackBars   common lookback window across the whole basket.
     */
    public static Result evaluate(Map<String, double[]> closesBySymbol, int lookbackBars) {
        List<SymbolReturn> returns = new ArrayList<>();
        for (Map.Entry<String, double[]> e : closesBySymbol.entrySet()) {
            double[] closes = e.getValue();
            int n = closes.length;
            if (lookbackBars < 1 || n <= lookbackBars) continue;
            double start = closes[n - 1 - lookbackBars];
            double end = closes[n - 1];
            if (start == 0) continue;
            returns.add(new SymbolReturn(e.getKey(), (end - start) / start));
        }

        returns.sort(Comparator.comparingDouble(SymbolReturn::totalReturn).reversed());
        int total = returns.size();
        List<Ranked> ranked = new ArrayList<>(total);
        for (int i = 0; i < total; i++) {
            SymbolReturn sr = returns.get(i);
            double percentile = total > 1 ? 100.0 * (total - 1 - i) / (total - 1) : 100.0;
            ranked.add(new Ranked(sr.symbol(), sr.totalReturn(), i + 1, percentile));
        }

        int decileSize = Math.max(1, total / 10);
        List<String> topDecile = new ArrayList<>();
        List<String> bottomDecile = new ArrayList<>();
        for (int i = 0; i < Math.min(decileSize, total); i++) {
            topDecile.add(ranked.get(i).symbol());
            bottomDecile.add(ranked.get(total - 1 - i).symbol());
        }

        return new Result(ranked, topDecile, bottomDecile);
    }
}
