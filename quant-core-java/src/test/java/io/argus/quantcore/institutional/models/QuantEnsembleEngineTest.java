package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.models.QuantEnsembleEngine.EnsembleResult;
import io.argus.quantcore.institutional.models.QuantEnsembleEngine.ModelVote;
import io.argus.quantcore.institutional.models.QuantEnsembleEngine.Side;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class QuantEnsembleEngineTest {

    @Test
    void twoPerfectlyCorrelatedVotesAreWorthAboutOneIndependentVote() {
        double[] weights = {0.8, 0.8};
        double[][] corr = {{1.0, 1.0}, {1.0, 1.0}};
        assertThat(QuantEnsembleEngine.effectiveIndependentCount(weights, corr)).isCloseTo(1.0, within(1e-9));
    }

    @Test
    void twoFullyIndependentVotesAreWorthTwo() {
        double[] weights = {0.8, 0.8};
        double[][] corr = {{1.0, 0.0}, {0.0, 1.0}};
        assertThat(QuantEnsembleEngine.effectiveIndependentCount(weights, corr)).isCloseTo(2.0, within(1e-9));
    }

    @Test
    void neverExceedsTheRawCountEvenWithNegativeCorrelationInputs() {
        double[] weights = {0.8, 0.8};
        double[][] corr = {{1.0, -0.9}, {-0.9, 1.0}};
        assertThat(QuantEnsembleEngine.effectiveIndependentCount(weights, corr)).isLessThanOrEqualTo(2.0);
    }

    @Test
    void combineProducesFewerIndependentEquivalentsThanRawAgreeingCountWhenModelsShareAFamily() {
        // Mirrors the user's own illustrative example: several BUY votes, some from the same
        // family (correlated by the declared default), one dissenting SELL.
        ModelVote[] votes = {
            new ModelVote("momentum_a", "momentum", Side.BUY, 0.8),
            new ModelVote("momentum_b", "momentum", Side.BUY, 0.75),
            new ModelVote("trend", "momentum", Side.BUY, 0.7),
            new ModelVote("factor", "factor", Side.BUY, 0.65),
            new ModelVote("volatility", "volatility", Side.BUY, 0.6),
            new ModelVote("mean_reversion", "mean_reversion", Side.SELL, 0.6),
        };
        EnsembleResult result = QuantEnsembleEngine.combine(votes);

        assertThat(result.rawSide()).isEqualTo(Side.BUY);
        assertThat(result.totalVotes()).isEqualTo(6);
        assertThat(result.agreeingCount()).isEqualTo(5);
        assertThat(result.effectiveIndependentCount()).isLessThan(5.0);
        assertThat(result.effectiveIndependentCount()).isGreaterThan(1.0);
        assertThat(result.dissentingModelIds()).containsExactly("mean_reversion");
        assertThat(result.agreeingModelIds()).hasSize(5);
    }

    @Test
    void allSameFamilyMeansMuchLowerEffectiveCountThanAllDifferentFamilies() {
        ModelVote[] sameFamily = {
            new ModelVote("m1", "momentum", Side.BUY, 0.8),
            new ModelVote("m2", "momentum", Side.BUY, 0.8),
            new ModelVote("m3", "momentum", Side.BUY, 0.8),
        };
        ModelVote[] differentFamilies = {
            new ModelVote("m1", "momentum", Side.BUY, 0.8),
            new ModelVote("m2", "factor", Side.BUY, 0.8),
            new ModelVote("m3", "volatility", Side.BUY, 0.8),
        };
        double sameFamilyEffective = QuantEnsembleEngine.combine(sameFamily).effectiveIndependentCount();
        double differentFamilyEffective = QuantEnsembleEngine.combine(differentFamilies).effectiveIndependentCount();

        assertThat(sameFamilyEffective).isLessThan(differentFamilyEffective);
        assertThat(differentFamilyEffective).isGreaterThan(2.0); // still discounted by the cross-family default, but much closer to the raw count of 3
    }

    @Test
    void weightsByConfidenceNotRawCountWhenDecidingTheWinningSide() {
        ModelVote[] votes = {
            new ModelVote("weak1", "a", Side.BUY, 0.1),
            new ModelVote("weak2", "a", Side.BUY, 0.1),
            new ModelVote("weak3", "a", Side.BUY, 0.1),
            new ModelVote("strong", "b", Side.SELL, 0.9),
        };
        EnsembleResult result = QuantEnsembleEngine.combine(votes);
        assertThat(result.rawSide()).isEqualTo(Side.SELL);
        assertThat(result.agreeingCount()).isEqualTo(1);
        assertThat(result.effectiveIndependentCount()).isCloseTo(1.0, within(1e-9));
    }

    @Test
    void tiedConfidenceResolvesToNeutralRatherThanAnArbitrarySide() {
        ModelVote[] votes = {
            new ModelVote("a", "x", Side.BUY, 0.5),
            new ModelVote("b", "y", Side.SELL, 0.5),
        };
        EnsembleResult result = QuantEnsembleEngine.combine(votes);
        assertThat(result.rawSide()).isEqualTo(Side.NEUTRAL);
        assertThat(result.agreeingCount()).isEqualTo(0);
        assertThat(result.dissentingModelIds()).containsExactlyInAnyOrder("a", "b");
    }

    @Test
    void emptyVotesReturnNeutralWithZeroesRatherThanThrowing() {
        EnsembleResult result = QuantEnsembleEngine.combine(new ModelVote[0]);
        assertThat(result.rawSide()).isEqualTo(Side.NEUTRAL);
        assertThat(result.totalVotes()).isEqualTo(0);
        assertThat(result.effectiveIndependentCount()).isEqualTo(0.0);
    }

    @Test
    void singleVoteIsTriviallyOneIndependentVote() {
        ModelVote[] votes = { new ModelVote("solo", "x", Side.BUY, 0.9) };
        EnsembleResult result = QuantEnsembleEngine.combine(votes);
        assertThat(result.effectiveIndependentCount()).isCloseTo(1.0, within(1e-9));
        assertThat(result.avgConfidenceOfAgreeing()).isCloseTo(0.9, within(1e-9));
    }
}
