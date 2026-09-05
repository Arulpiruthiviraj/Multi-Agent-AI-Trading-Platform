package io.argus.quantcore.institutional.models;

import java.util.Arrays;

/**
 * 4-state Gaussian Hidden Markov Model regime classifier, fit via Baum-Welch EM with Rabiner
 * (1989) scaling for numerical stability, decoded via Viterbi. Observations are 2-dimensional
 * (daily return, realized volatility) with a DIAGONAL covariance assumption per state - a
 * disclosed simplification (independent return/vol dimensions per state) chosen for numerical
 * robustness over a full 2x2 covariance fit, consistent with this codebase's convention of
 * disclosing simplified-vs-textbook modeling choices rather than presenting them as exact.
 *
 * States are unlabeled by Baum-Welch itself (EM has no notion of "bull" vs "bear") - after fitting,
 * states are ranked by their own fitted mean/variance to assign the 4 requested regime labels:
 * highest-variance state -&gt; HIGH_VOL_CHAOS; of the remaining three, highest mean return -&gt;
 * BULL_TRENDING, lowest -&gt; BEAR_TRENDING, middle -&gt; MEAN_REVERTING. This is a heuristic label
 * assignment, not a supervised classification - it is only as good as the feature separation in
 * the input data.
 */
public final class HmmRegimeEngine {

    private static final int STATES = 4;
    private static final int DIMS = 2;
    private static final double MIN_VARIANCE = 1e-10;

    public enum Regime {
        BULL_TRENDING, BEAR_TRENDING, MEAN_REVERTING, HIGH_VOL_CHAOS
    }

    public record Observation(double dailyReturn, double realizedVol) {
        double[] toArray() {
            return new double[]{dailyReturn, realizedVol};
        }
    }

    public record Fitted(
        double[][] means,       // [state][dim]
        double[][] variances,   // [state][dim], diagonal
        double[][] transition,  // [fromState][toState]
        double[] initialProbs,
        Regime[] stateLabels,   // stateLabels[state] = assigned regime
        double logLikelihood
    ) {
    }

    private HmmRegimeEngine() {
    }

    public static Fitted fit(Observation[] observations, int maxIterations) {
        int n = observations.length;
        if (n < STATES * 10) {
            return null;
        }
        double[][] obs = new double[n][DIMS];
        for (int t = 0; t < n; t++) obs[t] = observations[t].toArray();

        int[] labels = kMeansInit(obs, STATES);
        double[][] means = new double[STATES][DIMS];
        double[][] variances = new double[STATES][DIMS];
        double[] initial = new double[STATES];
        double[][] transition = new double[STATES][STATES];
        estimateGaussiansFromLabels(obs, labels, means, variances);
        estimateTransitionFromLabels(labels, transition, initial);

        double prevLogLik = Double.NEGATIVE_INFINITY;
        double logLik = Double.NEGATIVE_INFINITY;

        for (int iter = 0; iter < maxIterations; iter++) {
            double[][] emission = emissionMatrix(obs, means, variances);

            double[][] alphaHat = new double[n][STATES];
            double[] scale = new double[n];
            for (int s = 0; s < STATES; s++) alphaHat[0][s] = initial[s] * emission[0][s];
            scale[0] = normalize(alphaHat[0]);
            for (int t = 1; t < n; t++) {
                for (int s = 0; s < STATES; s++) {
                    double sum = 0;
                    for (int prev = 0; prev < STATES; prev++) {
                        sum += alphaHat[t - 1][prev] * transition[prev][s];
                    }
                    alphaHat[t][s] = sum * emission[t][s];
                }
                scale[t] = normalize(alphaHat[t]);
            }

            double[][] betaHat = new double[n][STATES];
            Arrays.fill(betaHat[n - 1], 1.0);
            scaleRow(betaHat[n - 1], scale[n - 1]);
            for (int t = n - 2; t >= 0; t--) {
                for (int s = 0; s < STATES; s++) {
                    double sum = 0;
                    for (int next = 0; next < STATES; next++) {
                        sum += transition[s][next] * emission[t + 1][next] * betaHat[t + 1][next];
                    }
                    betaHat[t][s] = sum;
                }
                scaleRow(betaHat[t], scale[t]);
            }

            double[][] gamma = new double[n][STATES];
            for (int t = 0; t < n; t++) {
                double sum = 0;
                for (int s = 0; s < STATES; s++) {
                    gamma[t][s] = alphaHat[t][s] * betaHat[t][s];
                    sum += gamma[t][s];
                }
                if (sum > 1e-300) {
                    for (int s = 0; s < STATES; s++) gamma[t][s] /= sum;
                }
            }

            double[][][] xi = new double[n - 1][STATES][STATES];
            for (int t = 0; t < n - 1; t++) {
                double denom = 0;
                for (int i = 0; i < STATES; i++) {
                    for (int j = 0; j < STATES; j++) {
                        double v = alphaHat[t][i] * transition[i][j] * emission[t + 1][j] * betaHat[t + 1][j];
                        xi[t][i][j] = v;
                        denom += v;
                    }
                }
                if (denom > 1e-300) {
                    for (int i = 0; i < STATES; i++) {
                        for (int j = 0; j < STATES; j++) {
                            xi[t][i][j] /= denom;
                        }
                    }
                }
            }

            for (int s = 0; s < STATES; s++) initial[s] = gamma[0][s];

            for (int i = 0; i < STATES; i++) {
                double denom = 0;
                for (int t = 0; t < n - 1; t++) denom += gamma[t][i];
                for (int j = 0; j < STATES; j++) {
                    double numer = 0;
                    for (int t = 0; t < n - 1; t++) numer += xi[t][i][j];
                    transition[i][j] = denom > 1e-300 ? numer / denom : 1.0 / STATES;
                }
            }

            for (int s = 0; s < STATES; s++) {
                double denom = 0;
                for (int t = 0; t < n; t++) denom += gamma[t][s];
                for (int d = 0; d < DIMS; d++) {
                    double numer = 0;
                    for (int t = 0; t < n; t++) numer += gamma[t][s] * obs[t][d];
                    means[s][d] = denom > 1e-300 ? numer / denom : means[s][d];
                }
                for (int d = 0; d < DIMS; d++) {
                    double numer = 0;
                    for (int t = 0; t < n; t++) {
                        double diff = obs[t][d] - means[s][d];
                        numer += gamma[t][s] * diff * diff;
                    }
                    variances[s][d] = denom > 1e-300 ? Math.max(numer / denom, MIN_VARIANCE) : variances[s][d];
                }
            }

            prevLogLik = logLik;
            logLik = 0;
            for (int t = 0; t < n; t++) logLik += Math.log(scale[t]);
            logLik = -logLik;

            if (iter > 0 && Math.abs(logLik - prevLogLik) < 1e-6) {
                break;
            }
        }

        Regime[] labelsOut = assignLabels(means, variances);
        return new Fitted(means, variances, transition, initial, labelsOut, logLik);
    }

    /** Viterbi most-likely state path, mapped through the fitted regime labels. */
    public static Regime[] decode(Fitted fitted, Observation[] observations) {
        int n = observations.length;
        double[][] obs = new double[n][DIMS];
        for (int t = 0; t < n; t++) obs[t] = observations[t].toArray();
        double[][] emission = emissionMatrix(obs, fitted.means(), fitted.variances());

        double[][] logDelta = new double[n][STATES];
        int[][] psi = new int[n][STATES];
        for (int s = 0; s < STATES; s++) {
            logDelta[0][s] = safeLog(fitted.initialProbs()[s]) + safeLog(emission[0][s]);
        }
        for (int t = 1; t < n; t++) {
            for (int s = 0; s < STATES; s++) {
                double best = Double.NEGATIVE_INFINITY;
                int bestPrev = 0;
                for (int prev = 0; prev < STATES; prev++) {
                    double v = logDelta[t - 1][prev] + safeLog(fitted.transition()[prev][s]);
                    if (v > best) {
                        best = v;
                        bestPrev = prev;
                    }
                }
                logDelta[t][s] = best + safeLog(emission[t][s]);
                psi[t][s] = bestPrev;
            }
        }

        int[] path = new int[n];
        double best = Double.NEGATIVE_INFINITY;
        for (int s = 0; s < STATES; s++) {
            if (logDelta[n - 1][s] > best) {
                best = logDelta[n - 1][s];
                path[n - 1] = s;
            }
        }
        for (int t = n - 2; t >= 0; t--) {
            path[t] = psi[t + 1][path[t + 1]];
        }

        Regime[] out = new Regime[n];
        for (int t = 0; t < n; t++) out[t] = fitted.stateLabels()[path[t]];
        return out;
    }

    public static Regime currentRegime(Fitted fitted, Observation[] observations) {
        Regime[] path = decode(fitted, observations);
        return path[path.length - 1];
    }

    private static double[][] emissionMatrix(double[][] obs, double[][] means, double[][] variances) {
        int n = obs.length;
        double[][] emission = new double[n][STATES];
        for (int t = 0; t < n; t++) {
            for (int s = 0; s < STATES; s++) {
                double density = 1.0;
                for (int d = 0; d < DIMS; d++) {
                    double diff = obs[t][d] - means[s][d];
                    double var = variances[s][d];
                    density *= Math.exp(-0.5 * diff * diff / var) / Math.sqrt(2 * Math.PI * var);
                }
                emission[t][s] = Math.max(density, 1e-300);
            }
        }
        return emission;
    }

    private static double normalize(double[] row) {
        double sum = 0;
        for (double v : row) sum += v;
        if (sum < 1e-300) {
            Arrays.fill(row, 1.0 / row.length);
            return 1.0 / row.length;
        }
        for (int i = 0; i < row.length; i++) row[i] /= sum;
        return sum;
    }

    private static void scaleRow(double[] row, double scale) {
        for (int i = 0; i < row.length; i++) row[i] /= scale;
    }

    private static double safeLog(double v) {
        return v > 1e-300 ? Math.log(v) : Math.log(1e-300);
    }

    /** Simple few-iteration k-means, used only to seed Baum-Welch (not the final model). */
    private static int[] kMeansInit(double[][] obs, int k) {
        int n = obs.length;
        double[][] centroids = new double[k][DIMS];
        for (int s = 0; s < k; s++) {
            centroids[s] = obs[(int) ((long) s * n / k)].clone();
        }
        int[] labels = new int[n];
        for (int iter = 0; iter < 25; iter++) {
            for (int t = 0; t < n; t++) {
                double best = Double.MAX_VALUE;
                int bestS = 0;
                for (int s = 0; s < k; s++) {
                    double dist = squaredDistance(obs[t], centroids[s]);
                    if (dist < best) {
                        best = dist;
                        bestS = s;
                    }
                }
                labels[t] = bestS;
            }
            double[][] sums = new double[k][DIMS];
            int[] counts = new int[k];
            for (int t = 0; t < n; t++) {
                counts[labels[t]]++;
                for (int d = 0; d < DIMS; d++) sums[labels[t]][d] += obs[t][d];
            }
            for (int s = 0; s < k; s++) {
                if (counts[s] > 0) {
                    for (int d = 0; d < DIMS; d++) centroids[s][d] = sums[s][d] / counts[s];
                }
            }
        }
        return labels;
    }

    private static double squaredDistance(double[] a, double[] b) {
        double s = 0;
        for (int i = 0; i < a.length; i++) {
            double diff = a[i] - b[i];
            s += diff * diff;
        }
        return s;
    }

    private static void estimateGaussiansFromLabels(double[][] obs, int[] labels, double[][] means, double[][] variances) {
        int n = obs.length;
        int[] counts = new int[STATES];
        for (int t = 0; t < n; t++) {
            counts[labels[t]]++;
            for (int d = 0; d < DIMS; d++) means[labels[t]][d] += obs[t][d];
        }
        for (int s = 0; s < STATES; s++) {
            if (counts[s] > 0) {
                for (int d = 0; d < DIMS; d++) means[s][d] /= counts[s];
            }
        }
        for (int t = 0; t < n; t++) {
            for (int d = 0; d < DIMS; d++) {
                double diff = obs[t][d] - means[labels[t]][d];
                variances[labels[t]][d] += diff * diff;
            }
        }
        for (int s = 0; s < STATES; s++) {
            for (int d = 0; d < DIMS; d++) {
                variances[s][d] = counts[s] > 1 ? Math.max(variances[s][d] / counts[s], MIN_VARIANCE) : 1.0;
            }
        }
    }

    private static void estimateTransitionFromLabels(int[] labels, double[][] transition, double[] initial) {
        int n = labels.length;
        int[][] counts = new int[STATES][STATES];
        for (int t = 0; t < n - 1; t++) {
            counts[labels[t]][labels[t + 1]]++;
        }
        for (int i = 0; i < STATES; i++) {
            int total = 0;
            for (int j = 0; j < STATES; j++) total += counts[i][j];
            for (int j = 0; j < STATES; j++) {
                transition[i][j] = total > 0 ? (counts[i][j] + 0.1) / (total + 0.1 * STATES) : 1.0 / STATES;
            }
        }
        int[] stateCounts = new int[STATES];
        for (int label : labels) stateCounts[label]++;
        for (int s = 0; s < STATES; s++) {
            initial[s] = (stateCounts[s] + 0.1) / (n + 0.1 * STATES);
        }
    }

    private static Regime[] assignLabels(double[][] means, double[][] variances) {
        Regime[] labels = new Regime[STATES];
        int highVolState = 0;
        double maxVol = -1;
        for (int s = 0; s < STATES; s++) {
            if (variances[s][1] > maxVol) {
                maxVol = variances[s][1];
                highVolState = s;
            }
        }
        labels[highVolState] = Regime.HIGH_VOL_CHAOS;

        int bullState = -1, bearState = -1, meanRevState = -1;
        double maxReturn = Double.NEGATIVE_INFINITY, minReturn = Double.POSITIVE_INFINITY;
        for (int s = 0; s < STATES; s++) {
            if (s == highVolState) continue;
            if (means[s][0] > maxReturn) {
                maxReturn = means[s][0];
                bullState = s;
            }
        }
        for (int s = 0; s < STATES; s++) {
            if (s == highVolState || s == bullState) continue;
            if (means[s][0] < minReturn) {
                minReturn = means[s][0];
                bearState = s;
            }
        }
        for (int s = 0; s < STATES; s++) {
            if (s != highVolState && s != bullState && s != bearState) {
                meanRevState = s;
            }
        }
        labels[bullState] = Regime.BULL_TRENDING;
        labels[bearState] = Regime.BEAR_TRENDING;
        labels[meanRevState] = Regime.MEAN_REVERTING;
        return labels;
    }
}
