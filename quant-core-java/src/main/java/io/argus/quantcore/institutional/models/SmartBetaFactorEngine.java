package io.argus.quantcore.institutional.models;

import java.util.Arrays;

/**
 * Value and Quality "smart beta" composite factor scores, and winsorized score-proportional
 * portfolio weighting - Shishlenin, Harke &amp; Koppisetti, "Application of algorithmic trading
 * strategies for retail investors" (WorldQuant University MScFE capstone, 2019), Sec 3.2.1
 * (Eq. 1), Sec 3.2.2 (Eq. 2), and Appendix A (Z-score standardization + Winsor method).
 *
 * All Z-scores here are CROSS-SECTIONAL (standardized across the universe of securities supplied
 * in one call, at one point in time) - a different axis from this codebase's existing
 * RollingStatistics.zScore()/StatisticsMath.zScore(), which standardize one series across a
 * trailing TIME window. No existing cross-sectional standardization utility was found in this
 * codebase (checked institutional/models's other cross-sectional engines first, per this
 * codebase's own Java Engine Authority rule) - the small helper here is new, not a duplicate.
 *
 * Fundamental ratios (P/B, P/E, P/CF, dividend yield, ROA, ROE, D/E, CFO, EPS variability) are
 * entirely caller-supplied - Argus has no verified equity-fundamentals data path for these exact
 * fields today (FundamentalAgent's AlphaVantage integration was not checked against this specific
 * field list before writing this class - a real open question, not asserted either way). A
 * RESEARCH-status pure calculator, same discipline as every other paper-sourced engine in this
 * catalog: no live data feed claimed, no empirical constant defaulted beyond what the source
 * paper itself states as fixed (the equal factor weights in Eq. 1/2 ARE fixed by the source, not
 * caller-tunable, since the paper states them as its own chosen weighting, not an empirically-fit
 * value pending validation).
 */
public final class SmartBetaFactorEngine {

    private SmartBetaFactorEngine() {
    }

    /** Cross-sectional Z-score: (x_i - mean(x)) / stddev(x) across the supplied universe. Returns
     *  null (never a fabricated 0) when the universe has fewer than 2 members or zero variance -
     *  a Z-score is undefined in either case, not a degenerate 0. */
    public static double[] crossSectionalZScores(double[] values) {
        int n = values.length;
        if (n < 2) {
            return null;
        }
        double mean = Arrays.stream(values).average().orElse(0);
        double variance = 0;
        for (double v : values) {
            variance += (v - mean) * (v - mean);
        }
        variance /= n;
        double stdDev = Math.sqrt(variance);
        if (stdDev == 0) {
            return null;
        }
        double[] z = new double[n];
        for (int i = 0; i < n; i++) {
            z[i] = (values[i] - mean) / stdDev;
        }
        return z;
    }

    public record ValueInputs(double priceToBook, double priceToEarnings, double priceToCashFlow, double dividendYield) {
    }

    /**
     * Eq. 1: S_Vi = 0.25*(-Z_PB) + 0.25*(-Z_PE) + 0.25*(-Z_PCF) + 0.25*Z_DY. P/B, P/E, P/CF are
     * sign-inverted (a lower price-to-fundamental ratio means more undervalued, so should score
     * HIGHER on the value factor) per the source's own stated convention; dividend yield is not
     * inverted (higher yield scores higher). Equal 0.25 weights are the source's own fixed
     * choice, not fitted here. Returns null (universe-wide, not per-security) if the cross-
     * sectional Z-score is undefined for any of the four ratios (see crossSectionalZScores).
     */
    public static double[] valueScores(ValueInputs[] securities) {
        int n = securities.length;
        double[] pb = new double[n], pe = new double[n], pcf = new double[n], dy = new double[n];
        for (int i = 0; i < n; i++) {
            pb[i] = securities[i].priceToBook();
            pe[i] = securities[i].priceToEarnings();
            pcf[i] = securities[i].priceToCashFlow();
            dy[i] = securities[i].dividendYield();
        }
        double[] zPb = crossSectionalZScores(pb);
        double[] zPe = crossSectionalZScores(pe);
        double[] zPcf = crossSectionalZScores(pcf);
        double[] zDy = crossSectionalZScores(dy);
        if (zPb == null || zPe == null || zPcf == null || zDy == null) {
            return null;
        }
        double[] scores = new double[n];
        for (int i = 0; i < n; i++) {
            scores[i] = 0.25 * (-zPb[i]) + 0.25 * (-zPe[i]) + 0.25 * (-zPcf[i]) + 0.25 * zDy[i];
        }
        return scores;
    }

    public record QualityInputs(double debtToEquity, double epsVariability, double roa, double roe, double cfo) {
    }

    /**
     * Eq. 2: S_Qi = (-Z_DE - Z_EPSVar + Z_ROA + Z_ROE + Z_CFO) / 5. Debt-to-equity and EPS
     * variability are sign-inverted (lower leverage / lower earnings variability = higher
     * quality); ROA, ROE, CFO are not inverted. Equal 1/5 weights are the source's own fixed
     * choice.
     */
    public static double[] qualityScores(QualityInputs[] securities) {
        int n = securities.length;
        double[] de = new double[n], epsVar = new double[n], roa = new double[n], roe = new double[n], cfo = new double[n];
        for (int i = 0; i < n; i++) {
            de[i] = securities[i].debtToEquity();
            epsVar[i] = securities[i].epsVariability();
            roa[i] = securities[i].roa();
            roe[i] = securities[i].roe();
            cfo[i] = securities[i].cfo();
        }
        double[] zDe = crossSectionalZScores(de);
        double[] zEpsVar = crossSectionalZScores(epsVar);
        double[] zRoa = crossSectionalZScores(roa);
        double[] zRoe = crossSectionalZScores(roe);
        double[] zCfo = crossSectionalZScores(cfo);
        if (zDe == null || zEpsVar == null || zRoa == null || zRoe == null || zCfo == null) {
            return null;
        }
        double[] scores = new double[n];
        for (int i = 0; i < n; i++) {
            scores[i] = (-zDe[i] - zEpsVar[i] + zRoa[i] + zRoe[i] + zCfo[i]) / 5.0;
        }
        return scores;
    }

    /** Clips values beyond {@code sigmaLimit} standard deviations of the array's OWN mean/stddev
     *  to that boundary (Appendix A's Winsor method - the source targets a 3-sigma limit on the
     *  composite factor score, not the individual input ratios). Returns the input unchanged
     *  (never fabricates a clip) if fewer than 2 values or zero variance. */
    public static double[] winsorize(double[] values, double sigmaLimit) {
        if (values.length < 2) {
            return values.clone();
        }
        double mean = Arrays.stream(values).average().orElse(0);
        double variance = 0;
        for (double v : values) {
            variance += (v - mean) * (v - mean);
        }
        variance /= values.length;
        double stdDev = Math.sqrt(variance);
        if (stdDev == 0) {
            return values.clone();
        }
        double lower = mean - sigmaLimit * stdDev;
        double upper = mean + sigmaLimit * stdDev;
        double[] out = new double[values.length];
        for (int i = 0; i < values.length; i++) {
            out[i] = Math.min(upper, Math.max(lower, values[i]));
        }
        return out;
    }

    public record RankedSecurity(int originalIndex, double score, double winsorizedScore, double weight) {
    }

    /**
     * Appendix A: select the top {@code topN} securities by composite score (descending), 3-sigma
     * winsorize their scores, then weight each proportionally to its winsorized score
     * (w_i = Z_i_winsorized / sum(Z_winsorized) among the selected set). The source's own
     * convention: only positive-scoring securities are meaningfully investable under this scheme
     * (a negative or zero total winsorized-score sum among the selected set means the ranking
     * itself doesn't support a long-only weight allocation here) - returns null rather than
     * fabricating a weight scheme (e.g. via negative or divide-by-near-zero weights) in that case.
     */
    public static RankedSecurity[] winsorizedScoreWeighting(double[] scores, int topN, double sigmaLimit) {
        if (scores.length == 0 || topN <= 0) {
            return null;
        }
        Integer[] order = new Integer[scores.length];
        for (int i = 0; i < scores.length; i++) order[i] = i;
        Arrays.sort(order, (a, b) -> Double.compare(scores[b], scores[a]));
        int selectedCount = Math.min(topN, scores.length);
        int[] selectedIdx = new int[selectedCount];
        double[] selectedScores = new double[selectedCount];
        for (int i = 0; i < selectedCount; i++) {
            selectedIdx[i] = order[i];
            selectedScores[i] = scores[order[i]];
        }
        double[] winsorized = winsorize(selectedScores, sigmaLimit);
        double sum = Arrays.stream(winsorized).sum();
        if (sum <= 0) {
            return null;
        }
        RankedSecurity[] result = new RankedSecurity[selectedCount];
        for (int i = 0; i < selectedCount; i++) {
            result[i] = new RankedSecurity(selectedIdx[i], selectedScores[i], winsorized[i], winsorized[i] / sum);
        }
        return result;
    }
}
