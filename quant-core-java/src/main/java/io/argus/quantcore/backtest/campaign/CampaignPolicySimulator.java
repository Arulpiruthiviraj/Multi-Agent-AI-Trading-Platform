package io.argus.quantcore.backtest.campaign;

import io.argus.quantcore.backtest.engine.TradeRecord;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.*;

/**
 * Simulates Argus's three real target-achieved policies (src/server/services/CampaignTracker.ts:
 * CONTINUE / LOCK_AND_IDLE / TRAIL_STOPS_ONLY) against an already-produced trade list, grouped
 * into trading days (America/New_York) across all symbols combined (representing one desk's
 * combined daily P&L, matching CampaignTracker's own real dailyRealized aggregation).
 *
 * Known, disclosed simplification: TRAIL_STOPS_ONLY's real distinguishing behavior is tightening
 * the trailing stop on POSITIONS THAT REMAIN OPEN after the lock (PortfolioMonitor.ts's
 * resolveEffectiveTrailingStopPct) - it does not change which NEW trades are excluded, which is
 * identical to LOCK_AND_IDLE (both soft-lock new BUY entries once daily progress reaches 1.0).
 * RsiThresholdStrategy.java's trades are already-closed round trips with no "still open at lock
 * time" concept threaded through this simulator, so this simulation cannot distinguish
 * TRAIL_STOPS_ONLY from LOCK_AND_IDLE — both policies below use the same trade-exclusion rule
 * and will produce identical simulated results here. This is reported honestly, not silently
 * assumed away.
 */
public final class CampaignPolicySimulator {

    public enum Policy { CONTINUE, LOCK_AND_IDLE, TRAIL_STOPS_ONLY }

    public record DaySimulation(
        String tradingDate,
        double realizedPnl,
        boolean targetReached,
        int tradesIncluded,
        int tradesExcludedAfterLock,
        double maxIntradayDrawdownPct
    ) {
    }

    public record PolicyResult(Policy policy, double totalPnl, int daysTargetReached, int totalDays, List<DaySimulation> days) {
    }

    private CampaignPolicySimulator() {
    }

    public static PolicyResult simulate(List<TradeRecord> trades, double dailyTargetAmount, Policy policy) {
        Map<String, List<TradeRecord>> byDay = groupByTradingDay(trades);
        List<DaySimulation> days = new ArrayList<>();
        double totalPnl = 0;
        int daysReached = 0;

        for (var entry : new TreeMap<>(byDay).entrySet()) {
            String date = entry.getKey();
            List<TradeRecord> dayTrades = entry.getValue();
            dayTrades.sort(Comparator.comparingLong(TradeRecord::exitTimestampMs));

            double cumulative = 0;
            double peak = 0;
            double maxDrawdownPct = 0;
            boolean locked = false;
            int included = 0, excluded = 0;

            for (TradeRecord t : dayTrades) {
                if (locked && policy != Policy.CONTINUE) {
                    excluded++;
                    continue;
                }
                cumulative += t.pnl();
                included++;
                peak = Math.max(peak, cumulative);
                if (peak > 0) {
                    maxDrawdownPct = Math.max(maxDrawdownPct, (peak - cumulative) / peak * 100);
                }
                if (!locked && dailyTargetAmount > 0 && cumulative >= dailyTargetAmount) {
                    locked = true;
                }
            }

            boolean reached = dailyTargetAmount > 0 && cumulative >= dailyTargetAmount;
            if (reached) {
                daysReached++;
            }
            totalPnl += cumulative;
            days.add(new DaySimulation(date, cumulative, reached, included, excluded, maxDrawdownPct));
        }

        return new PolicyResult(policy, totalPnl, daysReached, days.size(), days);
    }

    public static Map<Policy, PolicyResult> simulateAll(List<TradeRecord> trades, double dailyTargetAmount) {
        Map<Policy, PolicyResult> out = new LinkedHashMap<>();
        for (Policy p : Policy.values()) {
            out.put(p, simulate(trades, dailyTargetAmount, p));
        }
        return out;
    }

    private static Map<String, List<TradeRecord>> groupByTradingDay(List<TradeRecord> trades) {
        Map<String, List<TradeRecord>> byDay = new HashMap<>();
        ZoneId ny = ZoneId.of("America/New_York");
        for (TradeRecord t : trades) {
            String date = ZonedDateTime.ofInstant(Instant.ofEpochMilli(t.exitTimestampMs()), ny).toLocalDate().toString();
            byDay.computeIfAbsent(date, k -> new ArrayList<>()).add(t);
        }
        return byDay;
    }
}
