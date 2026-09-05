package io.argus.quantcore.institutional.models;

import java.util.ArrayList;
import java.util.List;

/**
 * Correlation-adjusted model ensemble - the fix for the "5 models say BUY -> confidence 100%"
 * fallacy this codebase's own audits flagged (docs/audits/ARGUS_JAVA_QUANT_ENGINE_BOUNDARY_AND_BENCHMARK_AUDIT.md
 * §8: "how Argus should avoid counting highly correlated strategies as independent evidence").
 *
 * effectiveIndependentCount() uses a real, standard statistical result - the generalization of the
 * Kish design effect / Grinold-Kahn "breadth" concept from active portfolio management - for the
 * effective number of independent observations underlying a weighted sum of correlated variables:
 *
 *   N_eff = (sum_i w_i)^2 / sum_i sum_j (w_i * w_j * rho_ij)
 *
 * This is a real formula, not invented for this pass. What IS a disclosed simplification: the
 * correlationMatrix input. This codebase has no historical per-model signal store yet (that would
 * be a future ModelPerformanceTracker's job), so there is no real measured model-to-model
 * correlation to feed in today. defaultFamilyCorrelationMatrix() below supplies an explicit,
 * reviewed, config-declared assumption (same-family models assumed correlated at
 * DEFAULT_SAME_FAMILY_CORRELATION, cross-family at DEFAULT_CROSS_FAMILY_CORRELATION) rather than
 * fabricating a precise empirical number - callers who obtain a real measured correlation matrix
 * (once that infrastructure exists) should pass it directly to combine() instead.
 *
 * ADVISORY ONLY: this class never calls emitTradeIdea-equivalent logic, never touches
 * RiskEngine/OMS/BrokerManager (this is a Java module with zero broker imports across the whole
 * codebase, by design) - it only combines already-computed model votes into one reported
 * assessment for a caller (e.g. a future ChiefTrader reasoning-context consumer) to use as
 * additional evidence, never as an automatic approval.
 */
public final class QuantEnsembleEngine {

    /** Reviewed, declared assumption pending real historical model-correlation tracking - see class header. */
    public static final double DEFAULT_SAME_FAMILY_CORRELATION = 0.75;
    public static final double DEFAULT_CROSS_FAMILY_CORRELATION = 0.15;

    public enum Side { BUY, SELL, NEUTRAL }

    public record ModelVote(String modelId, String family, Side side, double confidence) {
    }

    public record EnsembleResult(
        Side rawSide,
        int totalVotes,
        int agreeingCount,
        double avgConfidenceOfAgreeing,
        double effectiveIndependentCount,
        String[] agreeingModelIds,
        String[] dissentingModelIds
    ) {
    }

    private QuantEnsembleEngine() {
    }

    /**
     * Generalized Kish/Grinold-Kahn effective-independent-count formula. weights and
     * correlationMatrix must be the same length/order; correlationMatrix must be square with 1.0
     * on the diagonal. Returns the raw count (never inflating it) if the denominator is
     * non-positive - a degenerate input never fabricates a number smaller or larger than what the
     * math actually supports.
     */
    public static double effectiveIndependentCount(double[] weights, double[][] correlationMatrix) {
        if (weights.length == 0) return 0;
        if (weights.length == 1) return 1;
        double sumW = 0;
        for (double w : weights) sumW += w;
        double numerator = sumW * sumW;
        double denominator = 0;
        for (int i = 0; i < weights.length; i++) {
            for (int j = 0; j < weights.length; j++) {
                denominator += weights[i] * weights[j] * correlationMatrix[i][j];
            }
        }
        if (denominator <= 0) return weights.length;
        return Math.min(weights.length, numerator / denominator);
    }

    /** Same-family = DEFAULT_SAME_FAMILY_CORRELATION, cross-family = DEFAULT_CROSS_FAMILY_CORRELATION, 1.0 on the diagonal - see class header for why this is a declared assumption, not a measured value. */
    public static double[][] defaultFamilyCorrelationMatrix(ModelVote[] votes) {
        int n = votes.length;
        double[][] m = new double[n][n];
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < n; j++) {
                if (i == j) {
                    m[i][j] = 1.0;
                } else {
                    boolean sameFamily = votes[i].family() != null && votes[i].family().equals(votes[j].family());
                    m[i][j] = sameFamily ? DEFAULT_SAME_FAMILY_CORRELATION : DEFAULT_CROSS_FAMILY_CORRELATION;
                }
            }
        }
        return m;
    }

    /**
     * Combines votes into one ensemble result. Only agrees-with-the-majority-side votes are
     * pooled into the effective-independent-count calculation - a BUY vote and a SELL vote are
     * never "correlated agreement" with each other, so the correlationMatrix submatrix restricted
     * to agreeing votes (in their original order) is what actually feeds effectiveIndependentCount.
     * rawSide is decided by total confidence-weight, not raw vote count, so one high-confidence
     * vote can outweigh several low-confidence ones on the other side - ties resolve to NEUTRAL
     * (never an arbitrary tiebreak toward BUY or SELL).
     */
    public static EnsembleResult combine(ModelVote[] votes, double[][] correlationMatrix) {
        if (votes.length == 0) {
            return new EnsembleResult(Side.NEUTRAL, 0, 0, 0, 0, new String[0], new String[0]);
        }
        double buyWeight = 0, sellWeight = 0;
        for (ModelVote v : votes) {
            if (v.side() == Side.BUY) buyWeight += v.confidence();
            else if (v.side() == Side.SELL) sellWeight += v.confidence();
        }
        Side rawSide = buyWeight > sellWeight ? Side.BUY : sellWeight > buyWeight ? Side.SELL : Side.NEUTRAL;

        List<Integer> agreeingIdx = new ArrayList<>();
        List<Integer> dissentingIdx = new ArrayList<>();
        for (int i = 0; i < votes.length; i++) {
            if (rawSide != Side.NEUTRAL && votes[i].side() == rawSide) {
                agreeingIdx.add(i);
            } else {
                dissentingIdx.add(i);
            }
        }

        if (agreeingIdx.isEmpty()) {
            String[] allIds = new String[votes.length];
            for (int i = 0; i < votes.length; i++) allIds[i] = votes[i].modelId();
            return new EnsembleResult(rawSide, votes.length, 0, 0, 0, new String[0], allIds);
        }

        double[] agreeingWeights = new double[agreeingIdx.size()];
        double[][] agreeingCorrelation = new double[agreeingIdx.size()][agreeingIdx.size()];
        String[] agreeingIds = new String[agreeingIdx.size()];
        double confidenceSum = 0;
        for (int a = 0; a < agreeingIdx.size(); a++) {
            int origI = agreeingIdx.get(a);
            agreeingWeights[a] = votes[origI].confidence();
            agreeingIds[a] = votes[origI].modelId();
            confidenceSum += votes[origI].confidence();
            for (int b = 0; b < agreeingIdx.size(); b++) {
                agreeingCorrelation[a][b] = correlationMatrix[origI][agreeingIdx.get(b)];
            }
        }
        String[] dissentingIds = new String[dissentingIdx.size()];
        for (int d = 0; d < dissentingIdx.size(); d++) dissentingIds[d] = votes[dissentingIdx.get(d)].modelId();

        double effectiveCount = effectiveIndependentCount(agreeingWeights, agreeingCorrelation);
        double avgConfidence = confidenceSum / agreeingWeights.length;

        return new EnsembleResult(rawSide, votes.length, agreeingIdx.size(), avgConfidence, effectiveCount, agreeingIds, dissentingIds);
    }

    /** Convenience overload using the declared family-based default correlation assumption. */
    public static EnsembleResult combine(ModelVote[] votes) {
        return combine(votes, defaultFamilyCorrelationMatrix(votes));
    }
}
