package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class TimeSeriesMomentumEngineTest {

    private static double[] linearTrend(int n, double startPrice, double dailyPct) {
        double[] closes = new double[n];
        double price = startPrice;
        for (int i = 0; i < n; i++) {
            closes[i] = price;
            price *= 1 + dailyPct;
        }
        return closes;
    }

    @Test
    void reportsPositiveReturnsAcrossAllThreeHorizonsForAConsistentUptrendAndSignalsBuy() {
        double[] closes = linearTrend(300, 100, 0.01); // steady 1%/bar uptrend
        var result = TimeSeriesMomentumEngine.evaluate(closes, 20, 60, 252);

        assertThat(result.shortTerm().totalReturn()).isPositive();
        assertThat(result.mediumTerm().totalReturn()).isPositive();
        assertThat(result.longTerm().totalReturn()).isPositive();
        assertThat(result.signal()).isEqualTo(TimeSeriesMomentumEngine.Signal.BUY);
        assertThat(result.trendPersistence()).isEqualTo(1.0); // every bar is up
    }

    @Test
    void reportsNegativeReturnsAndSignalsSellForAConsistentDowntrend() {
        double[] closes = linearTrend(300, 100, -0.01);
        var result = TimeSeriesMomentumEngine.evaluate(closes, 20, 60, 252);

        assertThat(result.shortTerm().totalReturn()).isNegative();
        assertThat(result.signal()).isEqualTo(TimeSeriesMomentumEngine.Signal.SELL);
        assertThat(result.trendPersistence()).isEqualTo(0.0);
    }

    @Test
    void leavesLongTermNullRatherThanFabricatingWhenNotEnoughHistoryExists() {
        double[] closes = linearTrend(80, 100, 0.005); // enough for short/medium, not for 252-bar long-term
        var result = TimeSeriesMomentumEngine.evaluate(closes, 20, 60, 252);

        assertThat(result.shortTerm().totalReturn()).isNotNull();
        assertThat(result.mediumTerm().totalReturn()).isNotNull();
        assertThat(result.longTerm().totalReturn()).isNull();
    }

    @Test
    void momentumAccelerationIsPositiveWhenShortTermOutpacesMediumTerm() {
        // A decline followed by a recent sharp rally: the medium-term window (spanning both) nets
        // out near/below zero, while the short-term window (the rally only) is strongly positive -
        // total-return-based acceleration, not a rate/slope comparison, so the older leg must
        // actually move against the recent one for acceleration to be positive.
        double[] decline = linearTrend(40, 100, -0.01);
        double rallyStart = decline[decline.length - 1] * (1 - 0.01);
        double[] rally = linearTrend(20, rallyStart, 0.02);
        double[] closes = new double[decline.length + rally.length];
        System.arraycopy(decline, 0, closes, 0, decline.length);
        System.arraycopy(rally, 0, closes, decline.length, rally.length);

        var result = TimeSeriesMomentumEngine.evaluate(closes, 20, 59, 59);
        assertThat(result.mediumTerm().totalReturn()).isLessThan(0.05);
        assertThat(result.shortTerm().totalReturn()).isGreaterThan(0.3);
        assertThat(result.momentumAcceleration()).isPositive();
    }

    @Test
    void signalIsNeutralWhenFewerThanTwoHorizonsAreComputable() {
        double[] closes = linearTrend(25, 100, 0.01); // only short-term (20) is computable
        var result = TimeSeriesMomentumEngine.evaluate(closes, 20, 60, 252);

        assertThat(result.signal()).isEqualTo(TimeSeriesMomentumEngine.Signal.NEUTRAL);
    }
}
