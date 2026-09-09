package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class FxHighMinusLowCarryEngineTest {

    @Test
    void buysHighestDiscountCurrencies_andSellsLowestDiscountCurrencies() {
        // discount = ln(S) - ln(F); higher spot-vs-forward premium (S > F) -> positive discount.
        List<FxHighMinusLowCarryEngine.CurrencyQuote> quotes = List.of(
            new FxHighMinusLowCarryEngine.CurrencyQuote("AUD", 1.50, 1.40), // large positive discount
            new FxHighMinusLowCarryEngine.CurrencyQuote("NZD", 1.50, 1.45),
            new FxHighMinusLowCarryEngine.CurrencyQuote("CAD", 1.30, 1.30), // zero discount
            new FxHighMinusLowCarryEngine.CurrencyQuote("EUR", 1.10, 1.15),
            new FxHighMinusLowCarryEngine.CurrencyQuote("JPY", 100.0, 110.0) // large negative discount
        );

        var result = FxHighMinusLowCarryEngine.evaluate(quotes, 0.2); // 1 per side of 5

        assertThat(result).isNotNull();
        assertThat(result.longBasket()).extracting(CrossSectionalQuantileBasketEngine.Position::symbol)
            .containsExactly("AUD");
        assertThat(result.shortBasket()).extracting(CrossSectionalQuantileBasketEngine.Position::symbol)
            .containsExactly("JPY");
    }

    @Test
    void skipsCurrenciesWithNonPositiveRates() {
        List<FxHighMinusLowCarryEngine.CurrencyQuote> quotes = List.of(
            new FxHighMinusLowCarryEngine.CurrencyQuote("A", 1.0, 1.1),
            new FxHighMinusLowCarryEngine.CurrencyQuote("B", 0.0, 1.1), // invalid, excluded
            new FxHighMinusLowCarryEngine.CurrencyQuote("C", 1.2, 1.0)
        );

        var result = FxHighMinusLowCarryEngine.evaluate(quotes, 0.5);
        assertThat(result).isNotNull();
        // only 2 valid currencies remain (A, C)
        assertThat(result.longBasket()).hasSize(1);
        assertThat(result.shortBasket()).hasSize(1);
    }

    @Test
    void returnsNull_whenFewerThanTwoValidCurrenciesRemain() {
        List<FxHighMinusLowCarryEngine.CurrencyQuote> quotes = List.of(
            new FxHighMinusLowCarryEngine.CurrencyQuote("A", 1.0, 1.1)
        );
        assertThat(FxHighMinusLowCarryEngine.evaluate(quotes, 0.2)).isNull();
    }
}
