# ARGUS — Same-Day Fix, Verification & Controlled Production Restart (2026-09-16)

Follow-up to `ARGUS_LIVE_ZERO_TRADE_FORENSIC_AUDIT_2026-09-16.md` and
`ARGUS_SAME_DAY_READINESS_FIX_AUDIT_2026-09-16.md`. Per explicit operator authorization, this pass
performed a full pre-restart validation, one controlled graceful stop/start of the production engine
(old PID 28136 → new PID 2804), and post-restart live verification. No trade was forced or
manufactured at any point.

## 1. Fixes made

**None.** No source file was modified during this pass. Every candidate investigated (IBKR
market-data coverage, delayed-data support, calibration/consensus, memory) was either already
confirmed defect-free from the prior same-day audit, or judged unsafe to hot-patch — see below.

## 2. Fixes deliberately NOT made

- **IBKR real-time equity data for individual symbols**: not fixed. This is an IBKR paper-account
  market-data entitlement limitation (real-time US equity Level 1 typically requires a linked, funded
  live account with an active subscription) — an account/business decision, not a code defect. No
  code workaround was implemented.
- **IBKR delayed-data fallback (`reqMarketDataType(DELAYED)`)**: available in the underlying
  `@stoqey/ib` library, deliberately not wired in. RiskEngine's `data_freshness` gate (gate 13)
  measures tick *arrival* time, not true data age — a delayed tick arrives "fresh" while reflecting a
  price up to 15–20 minutes stale, which would make that gate falsely pass. Implementing this safely
  requires a first-class `REAL_TIME`/`DELAYED`/`UNKNOWN` data-age field threaded from
  `IbkrSocketSession` → `MarketDataWorker` → every tick → RiskEngine, with an explicit rejection rule
  for execution against delayed data — a real, properly-scoped feature requiring new tests, not a
  same-day hot patch. Documented as a follow-up, not implemented.
- **Calibration/consensus**: audited directly against source (`ChiefTraderAgent.ts:707-742`) — no
  defect found. Not changed.
- **Memory**: no actionable defect identified in the current live window (see below). Not changed.
  This is deliberately weaker than "defect-free" — the historical P1-A retaining-owner question
  remains genuinely unresolved; this pass's clean short-window trend does not close it.

## 3. Tests

| Check | Result |
|---|---|
| `tsc --noEmit` | Clean, 0 errors |
| Full test suite (`npm test`) | **517/517 test files passed, 3,800/3,800 tests passed**, exit code 0 |
| Production build (`npm run build`) | Succeeded — `dist/server.cjs` (2.8MB) built in 13.5s |

One thing checked and ruled out during the test run: the test log showed `HEAP_SNAPSHOT_CAPTURED`
log lines referencing `data/heap-snapshots/` with today's date. Verified directly against disk
(`ls -la data/heap-snapshots/`): **only the two pre-existing files from the real 2026-09-14 P1-B
incident are present (both dated Sep 14) — no new file was written today.** These were test fixtures
exercising the logging code path itself (confirmed by an unmistakable test artifact in the same log
batch: `"Previous Argus session (pid 1) did not shut down cleanly"` — PID 1 never occurs in a real
process), not a real capture. The test-isolation guard worked correctly.

## 4. Market-data coverage

Unchanged from the prior audit — not touched this pass. Real-time: SPY, QQQ, GLD. Not available
(IBKR code 354): AMD, TSLA, NVDA, MSFT, META, IWM, AAPL, HOOD, GE, SOXL, INTC, DELL, XOM, MRVL, RIOT,
SOFI, SNAP, SCHW, SBUX, RIVN, and others. Delayed data is **not** used anywhere in the live path, and
cannot silently enter real-time trading (never wired in at all).

## 5. Calibration

Production remains on `RAW_BETA_BINOMIAL` (confirmed again via `agent_confidence_calibration.
calibration_method`, all rows). No synthetic/certification data present in today's `agent_predictions`
(direct substring query, 0 matches for today). `calibrateConfidenceDetailed()` uses the stored,
promotion-gated calibrated value when evidence exists, and explicitly labels
`NO_CALIBRATION_DATA` when it falls back to raw confidence — never a silent substitution. 0.75 STRONG
threshold and 2-agent independence floor unchanged.

## 6. Memory

**Pre-restart trend** (same PID 28136 throughout, non-invasive health polling only, no heap snapshot
taken against the live process):

| Uptime | RSS (MB) | Heap used (MB) |
|---|---|---|
| ~4.48h | 824.2 | 163.7 |
| ~4.60h | 1,119.6 | 419.7 |
| ~4.75h | 989.8 | 403.0 |
| ~4.85h | 996.6 | 558.4 |
| ~4.88h | 947.2 | 155.9 (major GC reclaim, -402MB in 2 min) |
| ~5.43h | 935.0 | 406.2 |

Non-monotonic, healthy GC sawtooth behavior, peak well under the documented CRITICAL auto-pause
threshold (3,584MB RSS). Code review (this pass and the prior one) of every component named in the
mandate — `PredictionOutcomeEvaluator`, `MultiHorizonOutcomeEvaluator` (both single-flight guarded,
bounded `.limit(batchSize)` queries), `ObservabilityStore` (bounded queue, drop-on-full, no
re-queue), `QuantCoreBridge` (per-symbol-bounded Maps), `EventStore` (capped ring, already ruled out
2026-09-14) — found no regression and no actionable defect. **Post-restart**: fresh process (PID
2804), RSS 681MB / heap 500.7MB at ~89s uptime (normal fresh-boot allocation, not yet meaningfully
comparable to a multi-hour trend). **The original P1-A root cause (unidentified retaining owner from
the 2026-09-14 incident) remains genuinely unresolved.** This pass's finding is "no actionable defect
identified in the current live window," not "the leak is fixed" — that distinction matters and should
not be collapsed in any future summary of this report. Not investigated further via live heap
snapshot (that mechanism caused the P1-B freeze-and-kill incident and was not used again here).

## 7. Restart

| | Before | After |
|---|---|---|
| PID | 28136 | **2804** |
| Uptime at handoff | ~5.43h | fresh |
| Startup command | — | `npm run argus-cli -- stop` then `npm run argus-cli -- start --enable-trading` (same canonical CLI path used all day; no invented flags) |
| Stop method | Graceful HTTP shutdown (`POST /api/v1/system/shutdown`), confirmed via `/health` going unreachable — no SIGTERM fallback needed | — |
| Shutdown drain | `TRADING_ENABLED → TRADING_PAUSED` (`kill_switch_events` id 277, actor `gracefulShutdown`, 0 cancelled orders — none were open) | — |
| Boot time | — | **~89 seconds** to full health (materially faster than this morning's ~9-minute cold boot after the overnight outage — consistent with warm OS/file caches following the recent build/test run) |
| Resume | — | Automatic via `start --enable-trading`'s own safety-checked resume call — **no `RestartSafetyGuard` pause this time** (unlike this morning), because this was a clean, graceful shutdown, not an unclean one. `kill_switch_events` id 278: `TRADING_PAUSED → TRADING_ENABLED`, reason "Auto-resume via argus-cli start --enable-trading" |
| Broker | `ibkr_gateway`, authenticated, account DUR959160 (same paper account, `DU*` prefix correct) | Same |
| Reconciliation | — | Clean immediately post-boot (`matches: 1, mismatches: null`) |
| Watchdog | PID 16060, correctly stood down during the graceful stop (`cleanShutdown: true` path, confirmed in `argusWatchdog.ts` logic before restarting), resumed watching automatically | `READY` |
| `paperTradingOnly` | true | true (unchanged) |
| `LIVE_NO_GO` | yes | yes (unchanged) |
| Final trading state | — | **`TRADING_ENABLED`** |
| Positions | flat | flat |
| Open orders | 0 | 0 |

Watchdog race explicitly checked and ruled out beforehand: `argusWatchdog.ts` reads `cleanShutdown`
from the session file and explicitly logs "Engine appears to have been stopped intentionally... Not
restarting" for a graceful stop — confirmed this is exactly what happened; the watchdog did not
attempt its own competing restart.

One transient item: `aiProviderHealth` briefly read `0/10 healthy` / `AI_UNAVAILABLE` immediately
after boot (vs. `1/10` / `AI_DEGRADED` before restart) — expected fresh-boot state (providers on
cooldown, 4 not yet re-probed), not a new defect; will self-resolve on the next health cycles.

## 8. Live funnel after restart (first ~2 minutes)

- Agent predictions: 11 (KronosEngine actively evaluating GLD/AMD/TSLA/IWM — all high raw confidence,
  0.817–0.85, on the SELL side)
- Consensus attempts: 3 completed (`NO_CONSENSUS`), 8 in flight (`ANALYZING`)
- Approvals: 0
- Risk assessments today (cumulative): 0
- Orders: 0
- Fills: 0

Pipeline confirmed genuinely alive and evaluating post-restart, not merely reporting healthy.

## 9. Final status

**FULLY OPERATIONAL — TRADING ENABLED**

Separately:

**NO QUALIFYING OPPORTUNITY** (as of this report; consistent with the full day's evidence — best
live agreement remains well under the 75% STRONG bar). Operational readiness and market opportunity
are reported as the two distinct things they are — the restart proves the pipeline is healthy
end-to-end; it does not and should not manufacture a trade.
