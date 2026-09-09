package io.argus.quantcore.institutional.models;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Commodity hedging pressure - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section 9.2,
 * based on CFTC Commitments of Traders (COT) hedgers'/speculators' hedging pressure (HP = long
 * contracts / total contracts, in [0,1]). A genuinely two-step conditional filter, distinct from
 * CrossSectionalQuantileBasketEngine's single-score quantile cut: (1) split the universe into the
 * upper and lower half by speculators' HP; (2) within the upper half, buy those in the bottom
 * quintile by hedgers' HP; within the lower half, sell those in the top quintile by hedgers' HP.
 * Hedgers'/speculators' HP values are caller-supplied (real COT report data, not something this
 * codebase has a feed for) - this class performs only the deterministic filter/ranking logic.
 */
public final class CommodityHedgingPressureEngine {

    private CommodityHedgingPressureEngine() {
    }

    public record CommodityHedgingPressureReading(String commodity, double hedgersHp, double speculatorsHp) {
    }

    public record Result(List<String> buyList, List<String> sellList) {
    }

    /**
     * @param readings per-commodity hedgers'/speculators' HP (each in [0,1]).
     * @param withinHalfQuantileFraction fraction of each half taken as the eligible extreme, e.g.
     *                                   0.2 for the paper's own worked quintile - caller-supplied,
     *                                   not defaulted.
     * @return null if fewer than 4 commodities are supplied (need at least 2 per half for the
     *         within-half quintile cut to be non-degenerate).
     */
    public static Result evaluate(List<CommodityHedgingPressureReading> readings, double withinHalfQuantileFraction) {
        if (readings == null || readings.size() < 4 || withinHalfQuantileFraction <= 0 || withinHalfQuantileFraction > 0.5) {
            return null;
        }
        List<CommodityHedgingPressureReading> bySpeculatorsHp = new ArrayList<>(readings);
        bySpeculatorsHp.sort(Comparator.comparingDouble(CommodityHedgingPressureReading::speculatorsHp).reversed());

        int total = bySpeculatorsHp.size();
        int halfSize = total / 2;
        List<CommodityHedgingPressureReading> upperHalf = new ArrayList<>(bySpeculatorsHp.subList(0, halfSize));
        List<CommodityHedgingPressureReading> lowerHalf = new ArrayList<>(bySpeculatorsHp.subList(total - halfSize, total));

        upperHalf.sort(Comparator.comparingDouble(CommodityHedgingPressureReading::hedgersHp)); // ascending: bottom first
        lowerHalf.sort(Comparator.comparingDouble(CommodityHedgingPressureReading::hedgersHp).reversed()); // descending: top first

        int upperQuantileSize = Math.max(1, (int) Math.round(upperHalf.size() * withinHalfQuantileFraction));
        int lowerQuantileSize = Math.max(1, (int) Math.round(lowerHalf.size() * withinHalfQuantileFraction));

        List<String> buyList = new ArrayList<>();
        for (int i = 0; i < Math.min(upperQuantileSize, upperHalf.size()); i++) {
            buyList.add(upperHalf.get(i).commodity());
        }
        List<String> sellList = new ArrayList<>();
        for (int i = 0; i < Math.min(lowerQuantileSize, lowerHalf.size()); i++) {
            sellList.add(lowerHalf.get(i).commodity());
        }

        return new Result(buyList, sellList);
    }
}
