package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class CrossSectionalQuantileBasketEngineTest {

    @Test
    void buysTheTopQuantileAndSellsTheBottomQuantile_byScore() {
        Map<String, Double> scores = new LinkedHashMap<>();
        scores.put("A", 10.0);
        scores.put("B", 8.0);
        scores.put("C", 6.0);
        scores.put("D", 4.0);
        scores.put("E", 2.0);
        scores.put("F", 0.0);
        scores.put("G", -2.0);
        scores.put("H", -4.0);
        scores.put("I", -6.0);
        scores.put("J", -8.0);

        var result = CrossSectionalQuantileBasketEngine.evaluate(scores, 0.2); // 2 per side of 10

        assertThat(result).isNotNull();
        assertThat(result.longBasket()).hasSize(2);
        assertThat(result.shortBasket()).hasSize(2);
        assertThat(result.longBasket()).extracting(CrossSectionalQuantileBasketEngine.Position::symbol)
            .containsExactlyInAnyOrder("A", "B");
        assertThat(result.shortBasket()).extracting(CrossSectionalQuantileBasketEngine.Position::symbol)
            .containsExactlyInAnyOrder("I", "J");
    }

    @Test
    void weightsAreEqualWithinEachSideAndSumToOneInMagnitude() {
        Map<String, Double> scores = new LinkedHashMap<>();
        for (int i = 0; i < 10; i++) scores.put("SYM" + i, (double) i);

        var result = CrossSectionalQuantileBasketEngine.evaluate(scores, 0.2);

        assertThat(result).isNotNull();
        double longSum = result.longBasket().stream().mapToDouble(CrossSectionalQuantileBasketEngine.Position::weight).sum();
        double shortSum = result.shortBasket().stream().mapToDouble(CrossSectionalQuantileBasketEngine.Position::weight).sum();
        assertThat(longSum).isCloseTo(1.0, within(1e-9));
        assertThat(shortSum).isCloseTo(-1.0, within(1e-9));
    }

    @Test
    void returnsNull_whenFewerThanTwoSymbolsSupplied() {
        Map<String, Double> scores = new LinkedHashMap<>();
        scores.put("A", 1.0);
        assertThat(CrossSectionalQuantileBasketEngine.evaluate(scores, 0.2)).isNull();
    }

    @Test
    void returnsNull_whenQuantileFractionIsOutOfRange() {
        Map<String, Double> scores = new LinkedHashMap<>();
        scores.put("A", 1.0);
        scores.put("B", 2.0);
        assertThat(CrossSectionalQuantileBasketEngine.evaluate(scores, 0.0)).isNull();
        assertThat(CrossSectionalQuantileBasketEngine.evaluate(scores, 0.6)).isNull();
    }

    @Test
    void basketSizeNeverExceedsHalfTheUniverse_evenWithALargeQuantileFraction() {
        Map<String, Double> scores = new LinkedHashMap<>();
        scores.put("A", 1.0);
        scores.put("B", 2.0);
        scores.put("C", 3.0);

        var result = CrossSectionalQuantileBasketEngine.evaluate(scores, 0.5);

        assertThat(result).isNotNull();
        assertThat(result.longBasket()).hasSize(1);
        assertThat(result.shortBasket()).hasSize(1);
    }
}
