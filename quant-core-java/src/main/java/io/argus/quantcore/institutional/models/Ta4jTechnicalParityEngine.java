package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.Bollinger;
import io.argus.quantcore.indicators.MACD;
import io.argus.quantcore.indicators.MovingAverages;
import io.argus.quantcore.indicators.RSI;
import org.ta4j.core.BarSeries;
import org.ta4j.core.BaseBarSeriesBuilder;
import org.ta4j.core.indicators.MACDIndicator;
import org.ta4j.core.indicators.RSIIndicator;
import org.ta4j.core.indicators.averages.EMAIndicator;
import org.ta4j.core.indicators.averages.SMAIndicator;
import org.ta4j.core.indicators.bollinger.BollingerBandsLowerIndicator;
import org.ta4j.core.indicators.bollinger.BollingerBandsMiddleIndicator;
import org.ta4j.core.indicators.bollinger.BollingerBandsUpperIndicator;
import org.ta4j.core.indicators.helpers.ClosePriceIndicator;
import org.ta4j.core.indicators.statistics.StandardDeviationIndicator;
import org.ta4j.core.num.DoubleNumFactory;

import java.time.Duration;
import java.time.Instant;

/**
 * Multi-Library Java Quant Decision Intelligence Integration (2026-09-23), Phase 3/12: ta4j as an
 * INDEPENDENT, separately-authored reference implementation used ONLY to parity-check Argus's own
 * hand-rolled indicator math ({@link RSI}, {@link MACD}, {@link MovingAverages}, {@link Bollinger}
 * — themselves ported byte-for-byte from the live TypeScript agents, the single authoritative path
 * per the Java Quant Core Authority policy). This is the same class of bug the 2026-09-22
 * MACDEngine EMA-seeding defect was: found by comparing two independently-authored
 * implementations against each other, not by re-reading one implementation harder. This engine
 * NEVER emits a BUY/SELL signal, NEVER computes a confidence score, and NEVER becomes a vote or an
 * evidence record on its own — it reports raw numeric values from both sides only. RESEARCH status
 * (see config/engineOwnership.json): zero HTTP consumer wires this into any live or shadow
 * decision path as of this commit.
 *
 * <p>A real, expected divergence exists by design: Argus's EMA/MACD deliberately seed with the raw
 * first price (see {@link MovingAverages}'s own doc comment — a preserved TS quirk, not a bug),
 * while ta4j's EMA seeds with a period-SMA. That difference decays exponentially but never fully
 * vanishes across an infinite recursion, so EMA/MACD/Bollinger comparisons here are expected to
 * show a small, persistent, explainable gap — a real-world example of Phase 12's
 * {@code WARMUP_DIFFERENCE}/{@code EXPECTED_CONVENTION_DIFFERENCE} classification, not evidence of
 * a defect in either implementation. RSI has no such seeding ambiguity (both Argus's port and
 * ta4j's {@link RSIIndicator} implement the same 1978 Wilder formula with the same warmup), so an
 * RSI disagreement beyond floating-point epsilon here WOULD be a real defect signal in one of the
 * two implementations. This class only reports the numbers; classifying a given divergence is the
 * caller's (or a human reviewer's) job, done in tests, never silently resolved by changing Argus to
 * match ta4j (Phase 12's own explicit rule).
 */
public final class Ta4jTechnicalParityEngine {

    private Ta4jTechnicalParityEngine() {
    }

    public record IndicatorComparison(double argusValue, double ta4jValue, double absoluteDifference) {
    }

    public record Result(
        IndicatorComparison rsi,
        IndicatorComparison macd,
        IndicatorComparison macdSignal,
        IndicatorComparison macdHistogram,
        IndicatorComparison sma,
        IndicatorComparison ema,
        IndicatorComparison bollingerUpper,
        IndicatorComparison bollingerLower
    ) {
    }

    /**
     * @param closes       chronological close prices.
     * @param rsiPeriod    Wilder RSI period, e.g. 14.
     * @param smaEmaPeriod SMA/EMA/Bollinger lookback, e.g. 20.
     * @return null if there isn't enough history for the longest-lookback indicator (MACD's 26-period EMA).
     */
    public static Result evaluate(double[] closes, int rsiPeriod, int smaEmaPeriod) {
        int macdLongPeriod = 26;
        int requiredBars = Math.max(rsiPeriod, Math.max(smaEmaPeriod, macdLongPeriod)) + 1;
        if (closes.length < requiredBars) {
            return null;
        }

        // --- Argus's own existing, authoritative implementations (already TS-ported). ---
        double argusRsi = new RSI(rsiPeriod).calculate(closes);
        MACD.Result argusMacd = new MACD(12, macdLongPeriod, 9).calculate(closes);
        double argusSma = MovingAverages.sma(closes, smaEmaPeriod);
        double[] argusEmaSeries = MovingAverages.ema(closes, smaEmaPeriod);
        double argusEma = argusEmaSeries[argusEmaSeries.length - 1];
        Bollinger.Bands argusBands = Bollinger.calculate(closes, smaEmaPeriod);

        // --- ta4j's own, independently-authored implementations of the same formulas. ---
        BarSeries series = buildSeries(closes);
        ClosePriceIndicator closePrice = new ClosePriceIndicator(series);
        int lastIndex = series.getEndIndex();

        double ta4jRsi = new RSIIndicator(closePrice, rsiPeriod).getValue(lastIndex).doubleValue();

        MACDIndicator macdIndicator = new MACDIndicator(closePrice, 12, macdLongPeriod);
        double ta4jMacd = macdIndicator.getValue(lastIndex).doubleValue();
        double ta4jSignal = macdIndicator.getSignalLine(9).getValue(lastIndex).doubleValue();
        double ta4jHistogram = macdIndicator.getHistogram(9).getValue(lastIndex).doubleValue();

        double ta4jSma = new SMAIndicator(closePrice, smaEmaPeriod).getValue(lastIndex).doubleValue();
        double ta4jEma = new EMAIndicator(closePrice, smaEmaPeriod).getValue(lastIndex).doubleValue();

        BollingerBandsMiddleIndicator middle = new BollingerBandsMiddleIndicator(new SMAIndicator(closePrice, smaEmaPeriod));
        StandardDeviationIndicator populationStdDev = StandardDeviationIndicator.ofPopulation(closePrice, smaEmaPeriod);
        double ta4jBbUpper = new BollingerBandsUpperIndicator(middle, populationStdDev).getValue(lastIndex).doubleValue();
        double ta4jBbLower = new BollingerBandsLowerIndicator(middle, populationStdDev).getValue(lastIndex).doubleValue();

        return new Result(
            compare(argusRsi, ta4jRsi),
            compare(argusMacd.macd(), ta4jMacd),
            compare(argusMacd.signal(), ta4jSignal),
            compare(argusMacd.histogram(), ta4jHistogram),
            compare(argusSma, ta4jSma),
            compare(argusEma, ta4jEma),
            compare(argusBands.upper(), ta4jBbUpper),
            compare(argusBands.lower(), ta4jBbLower)
        );
    }

    /** Argus's own conventional defaults: RSI(14), SMA/EMA/Bollinger(20). */
    public static Result evaluate(double[] closes) {
        return evaluate(closes, 14, 20);
    }

    private static IndicatorComparison compare(double argusValue, double ta4jValue) {
        return new IndicatorComparison(argusValue, ta4jValue, Math.abs(argusValue - ta4jValue));
    }

    /**
     * ta4j 0.25+ requires a monotonically increasing endTime per bar. Only close prices matter for
     * every indicator this engine evaluates, so open/high/low are set equal to close and volume to
     * zero - a synthetic but internally consistent series, never presented as real OHLCV.
     */
    private static BarSeries buildSeries(double[] closes) {
        BarSeries series = new BaseBarSeriesBuilder()
            .withNumFactory(DoubleNumFactory.getInstance())
            .withName("ta4j-parity")
            .build();
        Instant start = Instant.EPOCH;
        for (int i = 0; i < closes.length; i++) {
            series.barBuilder()
                .timePeriod(Duration.ofDays(1))
                .endTime(start.plus(Duration.ofDays(i + 1)))
                .openPrice(closes[i])
                .highPrice(closes[i])
                .lowPrice(closes[i])
                .closePrice(closes[i])
                .volume(0)
                .add();
        }
        return series;
    }
}
