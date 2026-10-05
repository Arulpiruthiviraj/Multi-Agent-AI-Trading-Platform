package io.argus.quantcore.strategy.institutional;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.strategy.types.LevelSuggestion;
import io.argus.quantcore.strategy.types.StrategyEvaluation;

import java.util.ArrayList;
import java.util.List;

/**
 * Canonical time-series momentum (Moskowitz-Ooi-Pedersen 2012, "Time Series Momentum").
 *
 * <p>Rule: go long (short) when the trailing 12-month return is positive (negative),
 * <b>skipping the most recent month</b> (the "12-1" construction). The skip-month avoids
 * short-term-reversal contamination of the formation window - the standard academic
 * construction, distinct from this repo's 20/60-day {@link VolScaledMtfMomentumStrategy}.
 *
 * <p>MOP size positions to a volatility target; here the 12-1 cumulative log return is
 * divided by 60-day realized (annualized) volatility to produce a Sharpe-like score, so
 * the entry bar is comparable across volatility regimes. A skip-month reversal guard
 * rejects entries where the most recent month is already violently unwinding the
 * 12-month drift (momentum-crash protection, cf. Daniel & Moskowitz 2016).
 *
 * <p>Research/quant-core infrastructure only - not wired into the live trading spine.
 * Side=SELL is a directional signal, not an instruction to short; the live brokers'
 * short-selling capability gates any such execution separately.
 *
 * <p>UNCOMPILED NOTE (2026-10-05): written without a JDK on the authoring host
 * ({@code java}/{@code javac}/{@code mvn} unavailable). Must be compiled and its tests run
 * via Maven before it is treated as verified.
 */
public final class TimeSeriesMomentum12MStrategy {

    public static final String ID = "INSTITUTIONAL_TS_MOMENTUM_12M";

    /** Formation window: 12 months of trading days. */
    private static final int FORMATION_DAYS = 252;
    /** Skip the most recent month (short-term reversal contamination). */
    private static final int SKIP_DAYS = 21;
    /** Vol estimation window for the Sharpe-like normalization. */
    private static final int VOL_DAYS = 60;
    private static final int MIN_BARS = FORMATION_DAYS + SKIP_DAYS + VOL_DAYS;
    /** Entry bar: one Sharpe unit of 12-1 drift. */
    private static final double ENTRY_THRESHOLD = 1.0;
    /** Skip-month reversal guard: a snapback beyond this multiple of 60d vol rejects entry. */
    private static final double REVERSAL_GUARD_MULTIPLE = 2.0;
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
        int n = logRets.length;

        // 12-1 formation: cumulative log return from t-(252+21) to t-21.
        int formStart = n - SKIP_DAYS - FORMATION_DAYS;
        double formationReturn = 0.0;
        for (int i = formStart; i < n - SKIP_DAYS; i++) formationReturn += logRets[i];

        double vol = realizedVol(logRets, n - VOL_DAYS, VOL_DAYS);
        if (vol <= 0 || Double.isNaN(vol)) {
            conditionsFailed.add("Volatility estimate degenerate (zero variance) - no signal by construction.");
            return noSignal(conditionsMet, conditionsFailed, contradictions);
        }
        double score = formationReturn * (TRADING_DAYS_PER_YEAR / FORMATION_DAYS) / vol;

        boolean bullish = score >= 0;
        StrategyEvaluation.Side side = bullish ? StrategyEvaluation.Side.BUY : StrategyEvaluation.Side.SELL;
        double dir = bullish ? 1.0 : -1.0;

        check(conditionsMet, conditionsFailed,
            bullish ? "12-1 formation return is positive (12m drift, most recent month skipped)"
                    : "12-1 formation return is negative (12m drift, most recent month skipped)",
            dir * score > 0);
        check(conditionsMet, conditionsFailed,
            "Vol-scaled 12-1 score clears the one-Sharpe-unit entry bar (|score|=" + round2(Math.abs(score)) + ")",
            Math.abs(score) >= ENTRY_THRESHOLD);

        // Skip-month reversal guard: if the skipped month moved violently against the
        // formation direction, the trend may already be unwinding - stand aside.
        // DEFECT FIX (2026-10-05): the skip-month return was normalized by a vol window that
        // INCLUDED the skip month itself ([n-60, n)). Exactly when this guard matters most — a
        // violent skip-month reversal — that violence inflated the denominator and pushed the
        // ratio below the tripwire (self-dampening). The guard vol now excludes the skip month
        // ([n-81, n-21)), matching the formation window's own 12-1 exclusion logic.
        double skipReturn = 0.0;
        for (int i = n - SKIP_DAYS; i < n; i++) skipReturn += logRets[i];
        double guardVol = realizedVol(logRets, n - SKIP_DAYS - VOL_DAYS, VOL_DAYS);
        double skipVolScaled = (guardVol > 0 && !Double.isNaN(guardVol))
            ? skipReturn * (TRADING_DAYS_PER_YEAR / SKIP_DAYS) / guardVol
            : Double.NaN;
        boolean reversing = !Double.isNaN(skipVolScaled) && dir * skipVolScaled < -REVERSAL_GUARD_MULTIPLE;
        check(conditionsMet, conditionsFailed,
            "No violent skip-month reversal (last-21d vol-scaled return not < -" + REVERSAL_GUARD_MULTIPLE + " against the signal)",
            !reversing);
        if (reversing) {
            contradictions.add("12-month drift says " + side + " but the most recent month is violently reversing - momentum-crash pattern.");
        }

        int total = conditionsMet.size() + conditionsFailed.size();
        boolean triggerMet = Math.abs(score) >= ENTRY_THRESHOLD && !reversing && dir * score > 0;
        int setupScore = triggerMet ? (int) Math.round(((double) conditionsMet.size() / total) * 100) : 0;

        return new StrategyEvaluation(ID, side, setupScore, setupScore / 100.0,
            triggerMet, // trigger: 12-1 vol-scaled drift beyond one Sharpe unit, no skip-month reversal
            conditionsMet, conditionsFailed, contradictions,
            List.of(
                "12-1 vol-scaled score flips sign on a subsequent re-evaluation.",
                "Skip-month reversal guard trips (violent snapback against the formation direction)."
            ),
            LevelSuggestion.none("Momentum signal - no structural stop level; stops are a sizing concern."),
            LevelSuggestion.none("Momentum signal - no structural target level; exits on signal flip."),
            List.of("BULLISH_TREND", "BEARISH_TREND"));
    }

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
        return Math.sqrt(var / (days - 1) * TRADING_DAYS_PER_YEAR);
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

    /** Bar hygiene: reject non-positive, NaN, or infinite prices (2026-10-05 defect fix). */
    private static boolean allPricesPositive(Bar[] bars) {
        for (Bar b : bars) {
            if (!Double.isFinite(b.close()) || !Double.isFinite(b.open())
                    || !Double.isFinite(b.high()) || !Double.isFinite(b.low())
                    || b.close() <= 0 || b.open() <= 0) return false;
        }
        return true;
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
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
