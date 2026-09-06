# Argus — Trading Activity Forensic Audit (2026-09-05)

**Trigger:** the operator reported zero trades in the last month and asked for a diagnosis, not more features. This document is that diagnosis, plus two real bugs found and fixed along the way (DEF-27, and the IBKR reconnect gap in §7). It is evidence-based per this repository's own standard — every claim below is a direct SQL query result, a file/line reference, or a live-reproduced event, not a guess. Nothing here raises a readiness score — `CLAUDE.md` §0 governs.

---

## 1. Headline finding

**Almost all "trading activity" in the database is Historical Evaluation (REPLAY), not live/organic trading, and the live pipeline has essentially never run long enough, uninterrupted, for an idea to survive from generation to fill.** This is not a missing-feature problem. No code change fixes a system that keeps getting restarted before its own consensus/gate/fill cycle can complete.

## 2. The 30-day data

Queried directly against `data/argus.db` (30-day window from time of audit):

| Source | Count |
|---|---|
| `trades` rows, `execution_environment='REPLAY'` | 87 FILLED BUY + 87 FILLED SELL + 298 REJECTED BUY = 472 |
| `trades` rows, `execution_environment='PAPER'`, FILLED | **3 total** (1 BUY, 2 SELL) |
| Of those 3 PAPER fills | 2 are `trace_id` prefixed `manual-override-` (human-triggered Confirm Buy/Sell, IWM, 2026-08-21) — not autonomous. **1** is genuinely organic (NVDA SELL, 2026-08-20). |
| `risk_assessments`, `approved=1` | 480 (the vast majority correspond to REPLAY-environment evaluations, not live PAPER attempts) |
| `kill_switch_events` (any transition) | **176** in 30 days |
| — of which `TRADING_PAUSED` transitions | 74 (57 from `gracefulShutdown` process-restart drains, 11 from `PortfolioReconciliation` mismatches, 5 from `MemoryTelemetryGuard`, 1 manual) |
| — of which `EMERGENCY_STOP` transitions | 26, all "Manually triggered emergency stop" except one labeled test event |
| Approx. TRADING_ENABLED vs TRADING_PAUSED time, 30-day window | ~403h enabled / ~156h paused (calendar time — does not account for market being closed during "enabled" hours) |

**The `EMERGENCY_STOP` timestamps are themselves diagnostic:** 12 of the 26 fired within a single 40-minute window on 2026-08-17 (03:13–03:55 UTC). That is not a person repeatedly hitting a physical stop button at 3 AM — that is the signature of an active development/testing session (the same kind of activity this very conversation has been doing to the same deployment). Combined with 57 restart-triggered pauses in 30 days (~1.9 restarts/day), the honest conclusion is that this deployment has been in near-constant flux from active development, not run as a stable, continuously-attended paper-trading process.

## 3. P&L-attribution investigation — no bug found

The one genuinely organic fill (NVDA SELL, 2026-08-20, $216.85) has `profit_loss: null`, which is why `scripts/organic_paper_soak_status.ts`'s `closedTradeCount` still reads 0 even though a real organic sell did happen. This looked like a candidate bug and was investigated directly against the code, not assumed:

- `src/server/services/omsEntryPrice.ts`'s `resolvePreTradeEntryPrice()` (3-layer fallback: broker `positions()` → local `portfolio.averagePrice` → most recent non-REPLAY `FILLED` BUY) is structurally sound — both `AlpacaBroker.positions()` and `IBGatewaySocketAdapter.positions()` correctly map a real `entryPrice` field when a position exists.
- `src/server/services/PortfolioMonitor.ts:100-102` carries its own forensic comment, **dated the same day as the incident**: *"forensic 2026-08-20: PortfolioMonitor bound a REPLAY MOMENTUM_BREAKOUT NVDA fill ($114 / target $121.90) onto a live EXTERNAL_SYNC position (~$206), producing perpetual TARGET_REACHED noise."* — this is the exact NVDA position, and the fix (excluding REPLAY/BACKTEST/SIMULATION/HISTORICAL_REPLAY/HISTORICAL_SIMULATION/TELEMETRY_PULSE from opening-trade lookups) was already applied that day, mirrored identically in `omsEntryPrice.ts`.
- Querying NVDA's full trade history confirms the shape: a real `EXTERNAL_SYNC` BUY (2026-06-12, $206.85) plus 14 `REPLAY`-tagged BUY/SELL pairs (~$114/$110) from later historical-evaluation runs.

**Conclusion: the null is a preserved historical artifact from at/before the same-day fix, not a live bug.** `OrderManagement.ts` already does the right thing when attribution genuinely fails — it never fabricates a P&L figure, and instead emits a real, queryable `pnl_attribution_failed` / `PNL_ATTRIBUTION_FAILED` observability event (`OrderManagement.ts:450-461`). No code change was made here; making one would have been motion without a real defect behind it.

## 4. DEF-27 — a real bug found while investigating memory pressure

While checking current memory levels (a `MemoryTelemetryGuard` critical-pressure pause was active, tripped 5× this month on this same deployment), the engine instance running for this audit **crashed live**, ~2.5h into uptime. `data/logs/crash.log` showed a real, reproducible cascade:

```
TypeError: The database connection is not open
    at Database.prepare (...)
    ... (repeated 6+ times within a few hundred ms)
unhandledRejection: Error storm detected (>4 in 5000ms) — exiting cleanly instead of risking an unbounded cascade.
```

**Root cause:** `src/server/core/gracefulShutdown.ts`'s `drainTradingProcess()` calls `sqliteDb.close()` but, before this fix, only stopped 4 workers first (`SystemBootstrap`, `MarketDataWorker`, `NewsEngine`, `PortfolioReconciliation`). Grepping the full `src/server` tree for `setInterval(` and cross-referencing against what's actually stopped found **9 more interval-driven workers that were never stopped**, several of which do real, unconditional DB writes on their own timer — `SessionLifecycle` (`sessionLifecycleWorker`) most notably: it persists a snapshot roughly every 60 seconds and, per its own design, is started independent of Autobot at core boot (`ArgusCoreBoot.ts`). A tick from any of these landing after `sqliteDb.close()` throws; DEF-25's own storm circuit-breaker (`>4 errors in 5s`) then converts the cascade into a clean-but-unplanned process exit — exactly what was observed live.

**Fix applied:** `drainTradingProcess()` now also stops, in order, before closing SQLite: `sessionLifecycleWorker`, `javaQuantAdvisoryService`, `calibrationValidationWorker`, `marketUniverseScannerWorker`, `campaignTracker` (which itself stops `campaignWatchlistBoostWorker` and `campaignOpeningSurgeWorker` internally), `autoTradeScheduler`, `marketOpenNewsConfluence`, `strategyEngineShadowRunner`, and `openAliceVerificationService.stopPolling()` — matching the same try/catch-per-worker pattern the 4 pre-existing stops already used, so a failure to stop any one worker never blocks the rest of the drain.

**What remains honestly unresolved:** *why* the shutdown drain triggered in the first place on that run. Nothing in this conversation issued a stop/restart command at that point — the engine had simply been running. The two live possibilities are (a) a genuine trigger this audit didn't observe (an OS signal from somewhere), or (b) an artifact of how a sandboxed automation shell manages the lifecycle of a background-spawned process, which may not apply when `./argus start` is run from a normal interactive terminal. This is flagged, not resolved — the fix addresses the crash *cascade* (which is a real bug regardless of trigger), not a confirmed root cause for the trigger itself.

**Verified:** `gracefulShutdown.test.ts` gained explicit assertions that all 9 new workers are stopped, plus an explicit ordering assertion (`sessionLifecycleWorker.stop()` must be called before `sqliteDb.close()`) — 4/4 tests passing. `architecture.protection.test.ts`'s own static check on this file (`portfolioReconciliationWorker.stop(` must still appear) unaffected, 25/25 passing. Full suite and `tsc --noEmit` re-verified green after the change (see the summary delivered alongside this document for the exact count).

## 5. DEF-28 — IBKR socket adapter had no reconnect, unlike the Alpaca path

Found while checking the live engine's broker connectivity, separately from the DEF-27 crash: a restarted engine came up with `IBGatewaySocketAdapter` fully disconnected (`authenticated: false`, port 4002 `TcpTestSucceeded: False` — confirmed directly, not inferred). The previous engine instance *had* been connected minutes earlier (`accountId: DUR959160`), so IB Gateway Desktop itself went offline or was closed sometime in between.

That specific event (Gateway going offline) is outside Argus's control — launching and logging into IB Gateway Desktop is an interactive step requiring the operator's own 2FA, and no code change makes that unnecessary. But investigating it surfaced a real, adjacent code gap: `src/brokers/IbkrSocketSession.ts` had **no reconnect logic of any kind**, unlike `MarketDataWorker.ts`'s Alpaca WebSocket path, which already uses a shared `ReconnectBackoff` utility (`src/server/core/reconnectBackoff.ts`) to retry with exponential backoff. Once IB Gateway dropped or was never reachable at boot, the connection stayed dead for the rest of that process's life — the only recovery was a full Argus restart, which itself costs another round of DEF-27-class risk and another cold start of every worker.

**Fix applied:** `IbkrSocketSession` now reuses the same `ReconnectBackoff` utility. A failed `connect()` (Gateway not found, connect timeout, or a `CONNECT_FAIL` error) and a post-success `disconnected` event both schedule a retry on the real backoff schedule (`networkReconnectBackoffMs`: 1s/2s/5s/10s/30s). A successful connection resets the backoff. Retrying is cheap even when Gateway is genuinely down — `findFirstOpenTcpPort`'s own fast TCP probe (1.5s timeout) fails immediately without ever attempting the real IB API handshake. Auto-reconnect only arms after the first real `connect()` call (never before this adapter is actually asked to connect) and is fully stoppable via the new `stopAutoReconnect()` method. This does not touch OMS, RiskEngine, or order placement in any way — it only restores the same connection the adapter already had permission to make.

**What this does NOT fix:** the actual reason the connection dropped (IB Gateway Desktop being closed/offline). That remains an operator action every time it happens. The fix only removes the *additional*, code-level requirement that Argus be manually restarted to notice Gateway coming back.

Verified: 3 new tests in `src/brokers/__tests__/IbkrSocketSession.reconnect.test.ts` (retry fires with the real backoff schedule and advances between attempts; `stopAutoReconnect()` actually cancels future attempts; a manual `connect()` supersedes a pending auto-retry rather than double-firing) — all passing, using fake timers and a mocked TCP probe (no real IB Gateway dependency), matching this file's sibling tests' own established pattern for testing this class without a live socket.

## 6. What this audit deliberately did not do

- **Did not loosen, tune, or bypass any RiskEngine gate, consensus threshold, or safety control** to "produce more trades." That would have addressed a symptom the data doesn't actually support (the gates are not the bottleneck — uptime is).
- **Did not attempt to fix `MemoryTelemetryGuard`'s recurring trips** — current memory on a freshly-restarted instance was healthy (251MB RSS); the historical pattern (5 trips this month) needs sustained observation over real hours to diagnose, not a guess made from a cold-boot snapshot.
- **Did not fabricate a P&L figure** for the one historical null — see §3.
- **Did not attempt to root-cause the shutdown-drain trigger** beyond what's stated in §4 — that needs testing `./argus start` from a normal terminal over a longer, unattended window, which is properly the operator's own environment to verify, not something reproducible with confidence from inside this session's sandbox.
- **Did not, and cannot, launch or log into IB Gateway Desktop** — see §5. This is the single most fundamental blocker found this session: no order can be placed at all without it, regardless of every other fix.

## 7. Recommendation

The single highest-leverage next step is **uninterrupted uptime**, not more code. Per §2, this deployment has not obviously had a multi-day stretch of continuous, unattended operation this month. Given DEF-27 is now fixed (removing one concrete crash cause), the most useful thing to do next is start the engine once, leave it running through a real trading day without restarting it, and see — for what may be the first time this month — whether the pipeline gets a genuine, uninterrupted opportunity to carry an idea all the way to a fill.
