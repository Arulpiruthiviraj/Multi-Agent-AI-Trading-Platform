package io.argus.quantcore.features;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.indicators.MACD;
import io.argus.quantcore.indicators.RSI;

import java.util.List;

/**
 * Momentum feature computation for {@code strategy.types.StrategyContext.MomentumFeatures}
 * (rsi, roc, stochasticRSI, macd). Added 2026-09-10 as part of wiring the 5 CORE Java strategies
 * to real, Java-computed features rather than TS-precomputed JSON (see
 * docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md §0/§7 for why this class was missing
 * and what it closes).
 *
 * rsi/macd deliberately delegate to the existing, already byte-for-byte-ported
 * {@code io.argus.quantcore.indicators.RSI}/{@code MACD} rather than re-implementing them here —
 * this class's only new math is roc/stochasticRSI, ported from
 * src/server/quant/indicators/momentum.ts's calculateROC/calculateStochasticRSI (period defaults
 * 12/14/14, matching that file exactly). williamsR/momentum/cci from the same TS file are NOT
 * ported — StrategyContext.MomentumFeatures has no field for them; none of the 5 CORE strategies
 * read them. Do not add fields nobody consumes.
 */
public final class MomentumFeatures {

    public record Result(double rsi, Double roc, Double stochasticRSI, double macd, double macdSignal) {
    }

    private static final RSI RSI_14 = new RSI(14);
    private static final MACD MACD_12_26_9 = new MACD();

    private MomentumFeatures() {
    }

    public static Result computeMomentumFeatures(List<Bar> bars) {
        double[] closes = new double[bars.size()];
        for (int i = 0; i < bars.size(); i++) {
            closes[i] = bars.get(i).close();
        }
        double rsi = RSI_14.calculate(closes);
        MACD.Result macd = MACD_12_26_9.calculate(closes);
        return new Result(rsi, calculateROC(closes, 12), calculateStochasticRSI(closes, 14, 14), macd.macd(), macd.signal());
    }

    /** Rate of change (%) over `period` closes. Null (not fabricated 0) if insufficient history or a zero anchor. */
    static Double calculateROC(double[] closes, int period) {
        if (closes.length < period + 1) return null;
        double anchor = closes[closes.length - 1 - period];
        if (anchor == 0) return null;
        return ((closes[closes.length - 1] - anchor) / anchor) * 100;
    }

    /**
     * Stochastic RSI: RSI normalized against its own rolling range over `stochPeriod` bars of RSI
     * history — ported from momentum.ts's calculateStochasticRSI, which builds a real trailing RSI
     * series by sliding RSI.calculate() over successive windows, not a single latest value.
     */
    static Double calculateStochasticRSI(double[] closes, int rsiPeriod, int stochPeriod) {
        int minRequired = rsiPeriod + stochPeriod;
        if (closes.length < minRequired) return null;

        double[] rsiSeries = new double[stochPeriod];
        int idx = 0;
        for (int end = closes.length - stochPeriod + 1; end <= closes.length; end++) {
            double[] window = new double[end];
            System.arraycopy(closes, 0, window, 0, end);
            rsiSeries[idx++] = RSI_14.calculate(window);
        }

        double highestRSI = Double.NEGATIVE_INFINITY;
        double lowestRSI = Double.POSITIVE_INFINITY;
        for (double v : rsiSeries) {
            if (v > highestRSI) highestRSI = v;
            if (v < lowestRSI) lowestRSI = v;
        }
        if (highestRSI == lowestRSI) return null;
        double currentRSI = rsiSeries[rsiSeries.length - 1];
        return ((currentRSI - lowestRSI) / (highestRSI - lowestRSI)) * 100;
    }
}
