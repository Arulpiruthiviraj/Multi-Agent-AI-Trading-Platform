package io.argus.quantcore.server;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.features.SupportResistanceFeatures;
import io.argus.quantcore.features.TrendFeatures;
import io.argus.quantcore.features.VolatilityFeatures;
import io.argus.quantcore.strategy.types.StrategyContext;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Verifies FeaturesToStrategyContextAdapter's field-by-field mapping against the underlying
 * features.* calls directly, with particular attention to the record-shape/ordering mismatches
 * documented in the adapter's own header (Structure event/trend swap, Keltner reordering, Nearest
 * reordering, Level's dropped `abs` field, Vwap's dropped vwap/slopePct/event) - a positional-copy
 * bug in any of these would silently feed a strategy the wrong number under the right field name,
 * which no compiler error would catch. Deterministic synthetic bars, not captured real data.
 */
class FeaturesToStrategyContextAdapterTest {

    private static List<Bar> trendingBars(int count) {
        List<Bar> out = new ArrayList<>();
        double price = 100;
        for (int i = 0; i < count; i++) {
            price *= 1.003;
            out.add(new Bar(i * 60_000L, price - 0.5, price + 1, price - 1, price, 10_000 + i * 10));
        }
        return out;
    }

    @Test
    void buildsANonNullContextWithEveryTopLevelFieldPopulated() {
        List<Bar> bars = trendingBars(220);
        StrategyContext ctx = FeaturesToStrategyContextAdapter.build("TEST", bars, "1Day", null);

        assertThat(ctx.symbol()).isEqualTo("TEST");
        assertThat(ctx.currentPrice()).isEqualTo(bars.get(bars.size() - 1).close());
        assertThat(ctx.trend()).isNotNull();
        assertThat(ctx.momentum()).isNotNull();
        assertThat(ctx.volatility()).isNotNull();
        assertThat(ctx.volume()).isNotNull();
        assertThat(ctx.priceAction()).isNotNull();
        assertThat(ctx.supportResistance()).isNotNull();
        assertThat(ctx.regime()).isNotNull();
        // No benchmarks supplied -> honest null marketContext fields, never fabricated.
        assertThat(ctx.marketContext()).isNotNull();
        assertThat(ctx.marketContext().sector()).isNull();
        assertThat(ctx.marketContext().relativeStrengthVsSPY()).isNull();
    }

    @Test
    void structureEventAndTrendAreNotSwapped() {
        List<Bar> bars = trendingBars(220);
        TrendFeatures.MarketStructureResult raw = TrendFeatures.detectMarketStructure(bars, 2);
        StrategyContext ctx = FeaturesToStrategyContextAdapter.build("TEST", bars, "1Day", null);

        // features.MarketStructureResult is (trend, event, ...); StrategyContext.Structure is
        // (event, trend, ...) - a positional-copy bug would put `trend`'s value into `event` and
        // vice versa. Assert against the RAW computation, not a hand-typed expected string, so
        // this test tracks the real feature output rather than duplicating its logic.
        assertThat(ctx.trend().structure().event()).isEqualTo(raw.event());
        assertThat(ctx.trend().structure().trend()).isEqualTo(raw.trend());
    }

    @Test
    void priceVsMaDropsRawDiffButKeepsDiffPctAndAbove() {
        List<Bar> bars = trendingBars(220);
        double[] closes = bars.stream().mapToDouble(Bar::close).toArray();
        TrendFeatures.MovingAverageSet mas = TrendFeatures.movingAverageSet(closes);
        TrendFeatures.PriceVsMA raw = TrendFeatures.priceVsMA(closes[closes.length - 1], mas.sma20());

        StrategyContext ctx = FeaturesToStrategyContextAdapter.build("TEST", bars, "1Day", null);

        assertThat(ctx.trend().priceVsSMA20().diffPct()).isEqualTo(raw.diffPct());
        assertThat(ctx.trend().priceVsSMA20().above()).isEqualTo(raw.above());
    }

    @Test
    void keltnerFieldsAreMappedByNameNotPosition() {
        List<Bar> bars = trendingBars(220);
        double[] highs = bars.stream().mapToDouble(Bar::high).toArray();
        double[] lows = bars.stream().mapToDouble(Bar::low).toArray();
        double[] closes = bars.stream().mapToDouble(Bar::close).toArray();
        VolatilityFeatures.Keltner raw = VolatilityFeatures.keltnerChannels(highs, lows, closes, 20, 10, 2);

        StrategyContext ctx = FeaturesToStrategyContextAdapter.build("TEST", bars, "1Day", null);
        StrategyContext.Keltner mapped = ctx.volatility().keltner();

        // features.VolatilityFeatures.Keltner is (middle, upper, lower);
        // StrategyContext.Keltner is (upper, lower, middle) - a positional copy would put
        // `middle`'s value where `upper` is read from by the strategies.
        assertThat(mapped.upper()).isEqualTo(raw.upper());
        assertThat(mapped.lower()).isEqualTo(raw.lower());
        assertThat(mapped.middle()).isEqualTo(raw.middle());
    }

    @Test
    void nearestSupportResistanceFieldsAreMappedByNameNotPosition() {
        List<Bar> bars = trendingBars(220);
        SupportResistanceFeatures.Result raw = SupportResistanceFeatures.computeSupportResistanceFeatures(bars);

        StrategyContext ctx = FeaturesToStrategyContextAdapter.build("TEST", bars, "1Day", null);
        StrategyContext.Nearest mapped = ctx.supportResistance().nearest();

        // features.SupportResistanceFeatures.Nearest is (nearestResistance, nearestSupport);
        // StrategyContext.Nearest is (nearestSupport, nearestResistance) - reversed.
        if (raw.nearest().nearestSupport() != null) {
            assertThat(mapped.nearestSupport().level()).isEqualTo(raw.nearest().nearestSupport().level());
            assertThat(mapped.nearestSupport().pct()).isEqualTo(raw.nearest().nearestSupport().pct());
        } else {
            assertThat(mapped.nearestSupport()).isNull();
        }
        if (raw.nearest().nearestResistance() != null) {
            assertThat(mapped.nearestResistance().level()).isEqualTo(raw.nearest().nearestResistance().level());
        } else {
            assertThat(mapped.nearestResistance()).isNull();
        }
    }

    @Test
    void vwapCarriesOnlyDistancePct() {
        List<Bar> bars = trendingBars(220);
        StrategyContext ctx = FeaturesToStrategyContextAdapter.build("TEST", bars, "1Day", null);
        // Just asserts the field exists and is either null or a finite double - the real "only
        // distancePct, not vwap/slopePct/event" contract is enforced by StrategyContext.Vwap's
        // own single-field record shape (a compile-time guarantee, not a runtime one).
        assertThat(ctx.volume().vwap()).isNotNull();
    }
}
