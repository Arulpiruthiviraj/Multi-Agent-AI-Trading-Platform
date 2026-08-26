package io.argus.quantcore.backtest.cli;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.backtest.engine.BacktestMetrics;
import io.argus.quantcore.backtest.engine.SignalDrivenBacktest;
import io.argus.quantcore.backtest.engine.SignalDrivenBacktest.Signal;
import io.argus.quantcore.backtest.engine.TradeRecord;
import io.argus.quantcore.backtest.loader.SqliteBarLoader;
import io.argus.quantcore.institutional.models.ArimaModel;
import io.argus.quantcore.institutional.models.ArmaModel;
import io.argus.quantcore.institutional.models.AutoregressiveModel;
import io.argus.quantcore.institutional.models.MeanReversionZScoreEngine;
import io.argus.quantcore.institutional.models.MovingAverageCrossoverEngine;
import io.argus.quantcore.institutional.models.SarimaModel;
import io.argus.quantcore.institutional.models.TimeSeriesMomentumEngine;

import java.util.ArrayList;
import java.util.List;

/**
 * Real BACKTEST-stage graduation exercise, now covering 7 of the 37 new institutional Java modules
 * (2026-08-24 readiness audit, Part 9; extended 2026-08-25 with MOVING_AVERAGE_CROSSOVER_ENGINE,
 * an AR(5)-forecast signal, and - same pass, quant-graduation task - ArmaModel/ArimaModel/
 * SarimaModel forecast signals). Deliberately NOT a reflection/plugin-scanning system - an
 * explicit, hand-written registry, matching the audit's own "explicit registry metadata"
 * requirement. All 7 were picked because their `evaluate`/`fit`/`forecastOneStep` signatures only
 * need `closes` - most of the remaining ~27 modules (DonchianChannelEngine,
 * StochasticOscillatorEngine, TrendStrengthEngine, VolumeSignalEngine, the 5 ML regressors,
 * cross-symbol/panel models, ...) need highs/lows/volume/multi-symbol data that
 * SignalDrivenBacktest.SignalFunction does not currently pass through; extending that interface
 * (or the ML regressors' own feature-engineering step) is real, separate follow-up work, not done
 * here.
 *
 * All 7 modules remain RESEARCH in config/engineOwnership.json after this run - a backtest, even a
 * positive one, is never sufficient for promotion (this file's own report says so explicitly). No
 * live wiring anywhere here; SqliteBarLoader is read-only; this never places or influences a real
 * order.
 *
 * Reuses SAME_BAR_CLOSE-style fill/slippage/commission accounting (SignalDrivenBacktest.java),
 * the same non-promotable research fill model this module's other backtest tooling already uses -
 * see CLAUDE.md's "Research fill models" section for why that model is explicitly not the
 * promotion-adjacent one (that's canonicalNextBarEngine.ts, TypeScript-side, not this harness).
 */
public final class GraduationHarness {

    /** Real, hand-registered strategy metadata - the "explicit registry" the audit asked for instead of a generic plugin system. */
    public record RegisteredStrategy(String id, String description, int minWarmupBars, SignalDrivenBacktest.SignalFunction signalFn) {
    }

    private static Signal timeSeriesMomentumSignal(double[] closes) {
        TimeSeriesMomentumEngine.Result r = TimeSeriesMomentumEngine.evaluate(closes, 20, 60, 252);
        if (r.signal() == null) return Signal.NEUTRAL;
        return switch (r.signal()) {
            case BUY -> Signal.BUY;
            case SELL -> Signal.SELL;
            case NEUTRAL -> Signal.NEUTRAL;
        };
    }

    private static Signal meanReversionZScoreSignal(double[] closes) {
        MeanReversionZScoreEngine.Result r = MeanReversionZScoreEngine.evaluate(closes, 20, 2.0);
        if (r == null) return Signal.NEUTRAL;
        return switch (r.fadeSignal()) {
            case "BUY" -> Signal.BUY;
            case "SELL" -> Signal.SELL;
            default -> Signal.NEUTRAL;
        };
    }

    private static Signal movingAverageCrossoverSignal(double[] closes) {
        MovingAverageCrossoverEngine.Result r = MovingAverageCrossoverEngine.evaluate(closes, 20, 50, MovingAverageCrossoverEngine.MaType.SMA);
        if (r == null) return Signal.NEUTRAL;
        if (r.bullishCross()) return Signal.BUY;
        if (r.bearishCross()) return Signal.SELL;
        return Signal.NEUTRAL;
    }

    /**
     * AR(5)-forecast signal: fit an autoregressive model on the whole window, forecast the next
     * close, and compare it to the current close. A small no-trade band (0.15%) around zero
     * avoids treating forecast noise as a directional call - the model's own residuals mean a
     * forecast fractionally above/below the last close is not a meaningful signal on its own.
     */
    private static final int AR_LAGS = 5;
    private static final double AR_NO_TRADE_BAND_PCT = 0.0015;

    private static Signal autoregressiveForecastSignal(double[] closes) {
        AutoregressiveModel.Params params = AutoregressiveModel.fit(closes, AR_LAGS);
        if (params == null) return Signal.NEUTRAL;
        double lastClose = closes[closes.length - 1];
        double forecast = params.forecastOneStep(closes);
        double pctMove = (forecast - lastClose) / lastClose;
        if (pctMove > AR_NO_TRADE_BAND_PCT) return Signal.BUY;
        if (pctMove < -AR_NO_TRADE_BAND_PCT) return Signal.SELL;
        return Signal.NEUTRAL;
    }

    /**
     * ARMA(3,1)-forecast signal, same 0.15% no-trade band as the AR(5) signal above. longArOrder=10
     * satisfies Hannan-Rissanen's own requirement (>= p+q+1=5) with margin. Uses the same
     * series+residuals call pattern ArimaModel.Params.forecastOneStep() uses internally for its
     * own (d=0) case - not a new/invented forecast method.
     */
    private static final int ARMA_P = 3;
    private static final int ARMA_Q = 1;
    private static final int ARMA_LONG_AR_ORDER = 10;

    private static Signal armaForecastSignal(double[] closes) {
        ArmaModel.Params params = ArmaModel.fit(closes, ARMA_P, ARMA_Q, ARMA_LONG_AR_ORDER);
        if (params == null) return Signal.NEUTRAL;
        double lastClose = closes[closes.length - 1];
        double forecast = params.forecastOneStep(closes, params.residuals());
        double pctMove = (forecast - lastClose) / lastClose;
        if (pctMove > AR_NO_TRADE_BAND_PCT) return Signal.BUY;
        if (pctMove < -AR_NO_TRADE_BAND_PCT) return Signal.SELL;
        return Signal.NEUTRAL;
    }

    /** ARIMA(3,1,1)-forecast signal - d=1 differencing since raw daily closes are non-stationary. */
    private static final int ARIMA_P = 3;
    private static final int ARIMA_D = 1;
    private static final int ARIMA_Q = 1;
    private static final int ARIMA_LONG_AR_ORDER = 10;

    private static Signal arimaForecastSignal(double[] closes) {
        ArimaModel.Params params = ArimaModel.fit(closes, ARIMA_P, ARIMA_D, ARIMA_Q, ARIMA_LONG_AR_ORDER);
        if (params == null) return Signal.NEUTRAL;
        double lastClose = closes[closes.length - 1];
        double forecast = params.forecastOneStep(closes);
        double pctMove = (forecast - lastClose) / lastClose;
        if (pctMove > AR_NO_TRADE_BAND_PCT) return Signal.BUY;
        if (pctMove < -AR_NO_TRADE_BAND_PCT) return Signal.SELL;
        return Signal.NEUTRAL;
    }

    /** SARIMA(1,1,1)(1,0,1)_5-forecast signal - period 5 as the real trading-week seasonality for daily bars. */
    private static final int SARIMA_P = 1;
    private static final int SARIMA_D = 1;
    private static final int SARIMA_Q = 1;
    private static final int SARIMA_SP = 1;
    private static final int SARIMA_SD = 0;
    private static final int SARIMA_SQ = 1;
    private static final int SARIMA_PERIOD = 5;
    private static final int SARIMA_LONG_AR_ORDER = 15;

    private static Signal sarimaForecastSignal(double[] closes) {
        SarimaModel.Params params = SarimaModel.fit(closes, SARIMA_P, SARIMA_D, SARIMA_Q,
            SARIMA_SP, SARIMA_SD, SARIMA_SQ, SARIMA_PERIOD, SARIMA_LONG_AR_ORDER);
        if (params == null) return Signal.NEUTRAL;
        double lastClose = closes[closes.length - 1];
        double forecast = params.forecastOneStep(closes);
        double pctMove = (forecast - lastClose) / lastClose;
        if (pctMove > AR_NO_TRADE_BAND_PCT) return Signal.BUY;
        if (pctMove < -AR_NO_TRADE_BAND_PCT) return Signal.SELL;
        return Signal.NEUTRAL;
    }

    public static List<RegisteredStrategy> registry() {
        List<RegisteredStrategy> list = new ArrayList<>();
        list.add(new RegisteredStrategy(
            "TIME_SERIES_MOMENTUM_ENGINE", "20/60/252-bar time-series momentum (Two-Sigma-style catalog item)",
            253, (closes, idx) -> timeSeriesMomentumSignal(closes)));
        list.add(new RegisteredStrategy(
            "MEAN_REVERSION_ZSCORE_ENGINE", "20-bar rolling Z-score fade at |z| >= 2.0",
            21, (closes, idx) -> meanReversionZScoreSignal(closes)));
        list.add(new RegisteredStrategy(
            "MOVING_AVERAGE_CROSSOVER_ENGINE", "20/50-bar SMA golden/death cross",
            51, (closes, idx) -> movingAverageCrossoverSignal(closes)));
        list.add(new RegisteredStrategy(
            "AUTOREGRESSIVE_AR5_FORECAST_ENGINE", "AR(5) one-step-ahead forecast vs current close, 0.15% no-trade band",
            60, (closes, idx) -> autoregressiveForecastSignal(closes)));
        list.add(new RegisteredStrategy(
            "ARMA_3_1_FORECAST_ENGINE", "ARMA(3,1) Hannan-Rissanen one-step-ahead forecast, 0.15% no-trade band",
            90, (closes, idx) -> armaForecastSignal(closes)));
        list.add(new RegisteredStrategy(
            "ARIMA_3_1_1_FORECAST_ENGINE", "ARIMA(3,1,1) one-step-ahead forecast (differenced), 0.15% no-trade band",
            90, (closes, idx) -> arimaForecastSignal(closes)));
        list.add(new RegisteredStrategy(
            "SARIMA_1_1_1x1_0_1_5_FORECAST_ENGINE", "SARIMA(1,1,1)(1,0,1)_5 one-step-ahead forecast (5-day seasonality), 0.15% no-trade band",
            120, (closes, idx) -> sarimaForecastSignal(closes)));
        return list;
    }

    private static void printMetrics(String label, BacktestMetrics.Result m, List<TradeRecord> trades) {
        double avgHoldingBars = trades.isEmpty() ? 0 :
            trades.stream().mapToLong(t -> (t.exitTimestampMs() - t.entryTimestampMs())).average().orElse(0) / 86_400_000.0;
        // Simple per-trade-return Sharpe (not daily) - honestly labeled as such, not disguised as an
        // annualized daily Sharpe, which would require an equity curve this harness does not build.
        double sharpe = 0;
        if (trades.size() > 1) {
            double[] rets = trades.stream().mapToDouble(TradeRecord::pnl).toArray();
            double mean = java.util.Arrays.stream(rets).average().orElse(0);
            double variance = java.util.Arrays.stream(rets).map(r -> (r - mean) * (r - mean)).average().orElse(0);
            double sd = Math.sqrt(variance);
            sharpe = sd > 0 ? mean / sd : 0;
        }
        System.out.printf("  [%s] trades=%d winRate=%.1f%% profitFactor=%s netPnl=%.2f maxDD=%.2f%% avgHoldDays=%.1f perTradeSharpe=%.3f%n",
            label, m.tradeCount(), m.winRatePct(),
            Double.isInfinite(m.profitFactor()) ? "inf" : String.format("%.2f", m.profitFactor()),
            m.netPnl(), m.maxDrawdownPct(), avgHoldingBars, sharpe);
    }

    public static void main(String[] args) throws Exception {
        String dbPath = args.length > 0 ? args[0] : "../data/argus.db";
        String[] symbols = {"AAPL", "NVDA", "SPY", "MSFT", "AMD"};
        double startingCash = 100_000;
        double positionSizeFraction = 0.10;

        try (SqliteBarLoader loader = new SqliteBarLoader(dbPath)) {
            for (RegisteredStrategy strat : registry()) {
                System.out.println("=== " + strat.id() + " - " + strat.description() + " ===");
                System.out.println("Status: RESEARCH (unchanged by this run - a backtest never auto-promotes)");
                for (String symbol : symbols) {
                    List<Bar> bars = loader.loadBars(symbol, "1Day", 0, Long.MAX_VALUE);
                    if (bars.size() < strat.minWarmupBars() + 30) {
                        System.out.printf("  %s: SKIPPED - only %d bars available, need >= %d for a meaningful in-sample/out-of-sample split%n",
                            symbol, bars.size(), strat.minWarmupBars() + 30);
                        continue;
                    }
                    int splitIdx = (int) (bars.size() * 0.70);
                    List<Bar> inSample = bars.subList(0, splitIdx);
                    List<Bar> outOfSample = bars.subList(splitIdx, bars.size());

                    List<TradeRecord> isTrades = SignalDrivenBacktest.run(symbol, inSample, startingCash, positionSizeFraction, strat.minWarmupBars(), strat.signalFn());
                    List<TradeRecord> oosTrades = SignalDrivenBacktest.run(symbol, outOfSample, startingCash, positionSizeFraction, strat.minWarmupBars(), strat.signalFn());
                    BacktestMetrics.Result isMetrics = BacktestMetrics.compute(isTrades, startingCash);
                    BacktestMetrics.Result oosMetrics = BacktestMetrics.compute(oosTrades, startingCash);

                    System.out.println(" " + symbol + " (" + bars.size() + " bars, "
                        + new java.util.Date(bars.get(0).timestampMs()) + " to " + new java.util.Date(bars.get(bars.size() - 1).timestampMs()) + "):");
                    printMetrics("IN-SAMPLE  (first 70%)", isMetrics, isTrades);
                    printMetrics("OUT-OF-SAMPLE (last 30%)", oosMetrics, oosTrades);
                }
                System.out.println();
            }
        }
    }
}
