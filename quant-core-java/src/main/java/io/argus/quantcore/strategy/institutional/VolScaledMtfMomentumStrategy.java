package io.argus.quantcore.strategy.institutional;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.strategy.types.LevelSuggestion;
import io.argus.quantcore.strategy.types.StrategyEvaluation;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Volatility-scaled multi-timeframe momentum (AQR-style time-series momentum).
 *
 * The genuinely-missing institutional construct in this repo: {@code TrendFollowing} is an
 * SMA-stack regime check and {@code VolatilityTargetingEngine} is a sizing overlay, not a
 * signal. This strategy is one coherent signal:
 * <ol>
 *   <li>Compute log-return momentum over a fast (20d) and slow (60d) window.</li>
 *   <li>Normalize each by its own realized volatility (annualized stdev of daily log
 *       returns) so a 5% move in a calm tape scores the same as a 5% move in a wild
 *       tape only if the risk-adjusted drift is equal - raw price momentum is not
 *       comparable across volatility regimes, vol-scaled momentum is.</li>
 *   <li>Require timeframe confluence: fast and slow vol-scaled scores must agree in sign.</li>
 *   <li>Require volatility stability: the current 20d realized vol must not be exploding
 *       relative to its own 60d median (a vol spike means the vol estimate itself is
 *       unreliable and the "trend" is likely a gap, not drift).</li>
 * </ol>
 *
 * <p>Research/quant-core infrastructure only - not wired into the live trading spine.
 * Single-symbol, long/short-signal (side=SELL is a directional signal, not an instruction to
 * short; the live brokers' short-selling capability gates any such execution separately).
 *
 * <p>UNCOMPILED NOTE (2026-10-05): written without a JDK on the authoring host
 * ({@code java}/{@code javac}/{@code mvn} unavailable). Must be compiled and its tests run
 * via Maven before it is treated as verified.
 */
public final class VolScaledMtfMomentumStrategy {

    public static final String ID = "INSTITUTIONAL_VOL_SCALED_MTF_MOMENTUM";

    /** Fast/slow momentum lookbacks in trading days. */
    private static final int FAST_DAYS = 20;
    private static final int SLOW_DAYS = 60;
    /** Minimum bars: slow window + one full fast-vol window for the stability median, +1
     *  because logRets has bars.length - 1 entries (2026-10-05 defect fix: MIN_BARS was
     *  SLOW_DAYS + FAST_DAYS = 80, which admits 80 bars = 79 returns, but currentVolVsMedian
     *  needs 80 returns — the vol-stability guard could never pass at the advertised minimum). */
    private static final int MIN_BARS = SLOW_DAYS + FAST_DAYS + 1;
    /** Entry bar: |vol-scaled composite| must clear one Sharpe unit of drift (the score is
     *  ~N(0,1) under zero drift, so 1.0 is a one-sigma event). */
    private static final double ENTRY_COMPOSITE_THRESHOLD = 1.0;
    /** A timeframe's vol-scaled score below half a sigma is noise, not direction. */
    private static final double DIRECTION_MIN_SCORE = 0.5;
    /** Vol stability: current 20d vol beyond this multiple of its 60d median = explosion. */
    private static final double VOL_EXPLOSION_MULTIPLE = 2.5;
    private static final double TRADING_DAYS_PER_YEAR = 252.0;

    public StrategyEvaluation evaluate(InstitutionalStrategyContext ctx) {
        List<String> conditionsMet = new ArrayList<>();
        List<String> conditionsFailed = new ArrayList<>();
        List<String> contradictions = new ArrayList<>();

        Bar[] bars = ctx == null ? null : ctx.primaryBars();
        if (bars == null || bars.length < MIN_BARS || !allPricesPositive(bars)) {
            conditionsFailed.add("Insufficient clean bar history (need >= " + MIN_BARS + " bars with positive prices).");
            return noSignal(conditionsMet, conditionsFailed, contradictions);
        }

        double[] closes = closes(bars);
        double[] logRets = logReturns(closes);
        // logRets[i] is the return from close[i] to close[i+1]; length = closes.length - 1.

        double fastScore = volScaledMomentum(logRets, FAST_DAYS);
        double slowScore = volScaledMomentum(logRets, SLOW_DAYS);
        if (Double.isNaN(fastScore) || Double.isNaN(slowScore)) {
            conditionsFailed.add("Volatility estimate degenerate (zero variance) - no signal by construction.");
            return noSignal(conditionsMet, conditionsFailed, contradictions);
        }

        boolean bullish = (fastScore + slowScore) >= 0;
        StrategyEvaluation.Side side = bullish ? StrategyEvaluation.Side.BUY : StrategyEvaluation.Side.SELL;
        double dir = bullish ? 1.0 : -1.0;

        check(conditionsMet, conditionsFailed,
            bullish ? "Fast (20d) vol-scaled momentum is directionally positive" : "Fast (20d) vol-scaled momentum is directionally negative",
            dir * fastScore >= DIRECTION_MIN_SCORE);
        check(conditionsMet, conditionsFailed,
            bullish ? "Slow (60d) vol-scaled momentum agrees (timeframe confluence)" : "Slow (60d) vol-scaled momentum agrees (timeframe confluence)",
            dir * slowScore >= DIRECTION_MIN_SCORE);
        if (Math.signum(fastScore) != Math.signum(slowScore) && fastScore != 0 && slowScore != 0) {
            contradictions.add("Fast and slow timeframe momentum disagree in sign - trend not coherent across timeframes.");
        }

        double composite = (fastScore + slowScore) / 2.0;
        check(conditionsMet, conditionsFailed,
            "Vol-scaled composite |score| >= " + ENTRY_COMPOSITE_THRESHOLD + " (one Sharpe unit of drift)",
            Math.abs(composite) >= ENTRY_COMPOSITE_THRESHOLD);

        // Volatility stability: rolling 20d vol series over the last 60d; the latest reading
        // must not be exploding relative to its own median.
        double volStabilityRatio = currentVolVsMedian(logRets);
        boolean volStable = !Double.isNaN(volStabilityRatio) && volStabilityRatio <= VOL_EXPLOSION_MULTIPLE;
        check(conditionsMet, conditionsFailed,
            "Volatility stable (current 20d vol <= " + VOL_EXPLOSION_MULTIPLE + "x its 60d median)",
            volStable);

        int total = conditionsMet.size() + conditionsFailed.size();
        // CRITICAL DEFECT FIX (2026-10-05): vol-stability was a check() condition but NOT part of
        // triggerMet, so the strategy could emit a paper vote precisely when its own safety
        // rationale says the vol estimate is unreliable (exploding vol => the "trend" is likely
        // a gap, not drift). The header documents this as a REQUIREMENT; the trigger now enforces it.
        boolean triggerMet = Math.abs(composite) >= ENTRY_COMPOSITE_THRESHOLD
            && dir * fastScore >= DIRECTION_MIN_SCORE
            && dir * slowScore >= DIRECTION_MIN_SCORE
            && volStable;
        int setupScore = triggerMet ? (int) Math.round(((double) conditionsMet.size() / total) * 100) : 0;

        return new StrategyEvaluation(ID, side, setupScore, setupScore / 100.0,
            triggerMet, // trigger: coherent multi-timeframe vol-scaled drift beyond the entry bar
            conditionsMet, conditionsFailed, contradictions,
            List.of(
                "Vol-scaled composite flips sign on a subsequent re-evaluation.",
                "20d realized vol explodes beyond " + VOL_EXPLOSION_MULTIPLE + "x its 60d median (vol regime break)."
            ),
            LevelSuggestion.none("Momentum signal - no structural stop level; stops are a sizing concern."),
            LevelSuggestion.none("Momentum signal - no structural target level; exits on signal flip."),
            List.of("BULLISH_TREND", "BEARISH_TREND"));
    }

    /**
     * Vol-scaled momentum: sum of log returns over {@code days}, divided by the realized
     * volatility (annualized stdev of daily log returns) over the same window. Annualizing
     * the drift (sum * 252/days) and dividing by annualized vol gives a Sharpe-like ratio:
     * approximately standard-normal under the null of zero drift, so a threshold of 1.0
     * is a one-sigma drift event - comparable across volatility regimes, unlike raw
     * price momentum.
     */
    static double volScaledMomentum(double[] logRets, int days) {
        int n = logRets.length;
        if (n < days) return Double.NaN;
        double sum = 0.0;
        for (int i = n - days; i < n; i++) sum += logRets[i];
        double vol = realizedVol(logRets, n - days, days);
        if (vol <= 0 || Double.isNaN(vol)) return Double.NaN;
        return sum * (TRADING_DAYS_PER_YEAR / days) / vol;
    }

    /** Annualized stdev of daily log returns over [start, start+days). */
    static double realizedVol(double[] logRets, int start, int days) {
        if (start < 0 || start + days > logRets.length || days < 2) return Double.NaN;
        double mean = 0.0;
        for (int i = start; i < start + days; i++) mean += logRets[i];
        mean /= days;
        double var = 0.0;
        for (int i = start; i < start + days; i++) {
            double d = logRets[i] - mean;
            var += d * d;
        }
        var /= (days - 1);
        return Math.sqrt(var * TRADING_DAYS_PER_YEAR);
    }

    /**
     * Latest 20d annualized vol divided by the median of the three trailing 20d vol
     * readings (60 trading days of benchmark history, NOT including the current reading).
     * NaN when the history is insufficient.
     *
     * DEFECT FIX (2026-10-05): the current reading used to participate in its own benchmark
     * median, structurally desensitizing explosion detection (the outlier pulled the median
     * toward itself). Now: median-of-trailing-3 vs. current.
     */
    static double currentVolVsMedian(double[] logRets) {
        int n = logRets.length;
        // Need 4 non-overlapping 20d windows: current (ending at n) + 3 trailing benchmarks.
        if (n < SLOW_DAYS + FAST_DAYS) return Double.NaN;
        double[] vols = new double[4]; // vols[0] = current, vols[1..3] = trailing benchmarks
        for (int k = 0; k < 4; k++) {
            vols[k] = realizedVol(logRets, n - FAST_DAYS - k * FAST_DAYS, FAST_DAYS);
            if (Double.isNaN(vols[k]) || vols[k] <= 0) return Double.NaN;
        }
        // Benchmark median excludes the current reading under test.
        double[] trailing = {vols[1], vols[2], vols[3]};
        Arrays.sort(trailing);
        double median = trailing[1]; // median of 3
        return vols[0] / median;
    }

    private static double[] closes(Bar[] bars) {
        double[] out = new double[bars.length];
        for (int i = 0; i < bars.length; i++) out[i] = bars[i].close();
        return out;
    }

    private static double[] logReturns(double[] closes) {
        double[] out = new double[closes.length - 1];
        for (int i = 0; i < out.length; i++) out[i] = Math.log(closes[i + 1] / closes[i]);
        return out;
    }

    /**
     * Bar hygiene: reject non-positive, NaN, or infinite prices.
     * DEFECT FIX (2026-10-05): previously accepted +Infinity closes and never inspected
     * high/low for NaN. An infinite close makes logRets infinite and the variance NaN
     * (Inf - Inf), which fails closed downstream — but the guard's contract ("clean bar
     * history") is now actually enforced at the gate.
     */
    private static boolean allPricesPositive(Bar[] bars) {
        for (Bar b : bars) {
            if (!Double.isFinite(b.close()) || !Double.isFinite(b.open())
                    || !Double.isFinite(b.high()) || !Double.isFinite(b.low())
                    || b.close() <= 0 || b.open() <= 0) return false;
        }
        return true;
    }

    private static StrategyEvaluation noSignal(List<String> met, List<String> failed, List<String> contradictions) {
        return new StrategyEvaluation(ID, StrategyEvaluation.Side.HOLD, 0, 0.0,
            false, met, failed, contradictions,
            List.of(), LevelSuggestion.none("No signal."), LevelSuggestion.none("No signal."),
            List.of("ANY_REGIME"));
    }

    private static void check(List<String> met, List<String> failed, String name, boolean condition) {
        (condition ? met : failed).add(name);
    }
}
