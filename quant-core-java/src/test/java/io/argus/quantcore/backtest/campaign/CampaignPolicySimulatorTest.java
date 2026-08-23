package io.argus.quantcore.backtest.campaign;

import io.argus.quantcore.backtest.engine.TradeRecord;
import org.junit.jupiter.api.Test;

import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class CampaignPolicySimulatorTest {

    private static long nyTimestamp(int year, int month, int day, int hour) {
        return ZonedDateTime.of(year, month, day, hour, 0, 0, 0, ZoneId.of("America/New_York")).toInstant().toEpochMilli();
    }

    @Test
    void continueCountsAllTradesEvenAfterTargetReached() {
        List<TradeRecord> trades = List.of(
            new TradeRecord("A", 0, 100, nyTimestamp(2026, 1, 5, 10), 106, 10, 60, 1, 0.001), // +60, reaches $50 target
            new TradeRecord("B", 0, 100, nyTimestamp(2026, 1, 5, 14), 104, 10, 40, 1, 0.001)  // +40 more, after lock would-be time
        );
        var result = CampaignPolicySimulator.simulate(trades, 50, CampaignPolicySimulator.Policy.CONTINUE);
        assertThat(result.totalPnl()).isEqualTo(100); // both trades counted
        assertThat(result.daysTargetReached()).isEqualTo(1);
        assertThat(result.days().get(0).tradesExcludedAfterLock()).isZero();
    }

    @Test
    void lockAndIdleExcludesTradesAfterTargetReachedSameDay() {
        List<TradeRecord> trades = List.of(
            new TradeRecord("A", 0, 100, nyTimestamp(2026, 1, 5, 10), 106, 10, 60, 1, 0.001), // +60, reaches $50 target
            new TradeRecord("B", 0, 100, nyTimestamp(2026, 1, 5, 14), 104, 10, 40, 1, 0.001)  // excluded - after lock
        );
        var result = CampaignPolicySimulator.simulate(trades, 50, CampaignPolicySimulator.Policy.LOCK_AND_IDLE);
        assertThat(result.totalPnl()).isEqualTo(60); // only the first trade counts
        assertThat(result.daysTargetReached()).isEqualTo(1);
        assertThat(result.days().get(0).tradesExcludedAfterLock()).isEqualTo(1);
    }

    @Test
    void trailStopsOnlyProducesTheSameExclusionAsLockAndIdle_knownSimplification() {
        List<TradeRecord> trades = List.of(
            new TradeRecord("A", 0, 100, nyTimestamp(2026, 1, 5, 10), 106, 10, 60, 1, 0.001),
            new TradeRecord("B", 0, 100, nyTimestamp(2026, 1, 5, 14), 104, 10, 40, 1, 0.001)
        );
        var lockResult = CampaignPolicySimulator.simulate(trades, 50, CampaignPolicySimulator.Policy.LOCK_AND_IDLE);
        var trailResult = CampaignPolicySimulator.simulate(trades, 50, CampaignPolicySimulator.Policy.TRAIL_STOPS_ONLY);
        assertThat(trailResult.totalPnl()).isEqualTo(lockResult.totalPnl());
    }

    @Test
    void aDayThatNeverReachesTargetHasNoExclusions() {
        List<TradeRecord> trades = List.of(
            new TradeRecord("A", 0, 100, nyTimestamp(2026, 1, 5, 10), 102, 10, 20, 1, 0.001)
        );
        var result = CampaignPolicySimulator.simulate(trades, 50, CampaignPolicySimulator.Policy.LOCK_AND_IDLE);
        assertThat(result.daysTargetReached()).isZero();
        assertThat(result.days().get(0).tradesExcludedAfterLock()).isZero();
    }

    @Test
    void groupsTradesAcrossMultipleDaysIndependently() {
        List<TradeRecord> trades = List.of(
            new TradeRecord("A", 0, 100, nyTimestamp(2026, 1, 5, 10), 106, 10, 60, 1, 0.001),
            new TradeRecord("A", 0, 100, nyTimestamp(2026, 1, 6, 10), 102, 10, 20, 1, 0.001)
        );
        var result = CampaignPolicySimulator.simulate(trades, 50, CampaignPolicySimulator.Policy.LOCK_AND_IDLE);
        assertThat(result.totalDays()).isEqualTo(2);
        assertThat(result.daysTargetReached()).isEqualTo(1);
    }

    @Test
    void simulateAllReturnsAllThreePolicies() {
        List<TradeRecord> trades = List.of(
            new TradeRecord("A", 0, 100, nyTimestamp(2026, 1, 5, 10), 106, 10, 60, 1, 0.001)
        );
        var all = CampaignPolicySimulator.simulateAll(trades, 50);
        assertThat(all).containsKeys(
            CampaignPolicySimulator.Policy.CONTINUE,
            CampaignPolicySimulator.Policy.LOCK_AND_IDLE,
            CampaignPolicySimulator.Policy.TRAIL_STOPS_ONLY
        );
    }
}
