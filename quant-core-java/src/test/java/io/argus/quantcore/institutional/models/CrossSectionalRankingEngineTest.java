package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class CrossSectionalRankingEngineTest {

    private static double[] trend(double start, double dailyPct, int n) {
        double[] closes = new double[n];
        double price = start;
        for (int i = 0; i < n; i++) {
            closes[i] = price;
            price *= 1 + dailyPct;
        }
        return closes;
    }

    @Test
    void ranksTheStrongestTrailingReturnFirst() {
        Map<String, double[]> closesBySymbol = new LinkedHashMap<>();
        closesBySymbol.put("STRONG", trend(100, 0.02, 30));
        closesBySymbol.put("MEDIUM", trend(100, 0.005, 30));
        closesBySymbol.put("WEAK", trend(100, -0.01, 30));

        var result = CrossSectionalRankingEngine.evaluate(closesBySymbol, 20);

        assertThat(result.ranked()).hasSize(3);
        assertThat(result.ranked().get(0).symbol()).isEqualTo("STRONG");
        assertThat(result.ranked().get(0).rank()).isEqualTo(1);
        assertThat(result.ranked().get(2).symbol()).isEqualTo("WEAK");
        assertThat(result.topDecile()).contains("STRONG");
        assertThat(result.bottomDecile()).contains("WEAK");
    }

    @Test
    void excludesSymbolsWithInsufficientHistoryRatherThanFabricatingAReturn() {
        Map<String, double[]> closesBySymbol = new LinkedHashMap<>();
        closesBySymbol.put("ENOUGH", trend(100, 0.01, 30));
        closesBySymbol.put("TOO_SHORT", new double[] { 100, 101, 102 });

        var result = CrossSectionalRankingEngine.evaluate(closesBySymbol, 20);

        assertThat(result.ranked()).hasSize(1);
        assertThat(result.ranked().get(0).symbol()).isEqualTo("ENOUGH");
    }

    @Test
    void assignsPercentileRankOneHundredToTheTopSymbolAndZeroToTheBottom() {
        Map<String, double[]> closesBySymbol = new LinkedHashMap<>();
        closesBySymbol.put("A", trend(100, 0.03, 30));
        closesBySymbol.put("B", trend(100, 0.0, 30));
        closesBySymbol.put("C", trend(100, -0.03, 30));

        var result = CrossSectionalRankingEngine.evaluate(closesBySymbol, 20);
        var byName = result.ranked().stream()
            .collect(java.util.stream.Collectors.toMap(CrossSectionalRankingEngine.Ranked::symbol, r -> r));

        assertThat(byName.get("A").percentile()).isEqualTo(100.0);
        assertThat(byName.get("C").percentile()).isEqualTo(0.0);
    }
}
