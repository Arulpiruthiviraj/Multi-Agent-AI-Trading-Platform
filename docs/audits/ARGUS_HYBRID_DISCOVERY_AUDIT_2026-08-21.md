# ARGUS Hybrid REST Snapshot Discovery & WebSocket Hot-Swap Forensic Audit

**Date:** 2026-08-21 (America/New_York session)  
**Auditor mode:** Read-only (no trading-state mutation, no safety-invariant changes)  
**Runtime observed:** PAPER · `TRADING_ENABLED` · Autobot ON · `LIVE_NO_GO` · `marketDataConnected: true`  
**Process:** pid **41640** (restarted ~15:14–15:20Z window; prior pid 12780 had pre-hybrid discovery until reload)

---

## 1. Executive Verdict

### **DEGRADED**

Hybrid discovery is **live and partially working**: REST ranking of **122** liquid names, RTH adaptive scanner armed, `SNAPSHOT_HOT_SWAP` emits, WebSocket stays at **12/12**, anchors are not pruned, and OpportunityDiscovery still emits **0** trade ideas.  

It is **not PASS** because of a **hot-swap thrash loop** (multi-subscribe per cycle immediately evicts prior hot-swaps), likely **dual OpportunityDiscovery timers** (adaptive banner logged twice), and **no durable per-slot score table** in status API for auditors. Consensus **0.75 / min-2** and RiskEngine remain intact.

| Area | Grade | Result |
|---|---|---|
| Flags / cadence | RUN_VERIFIED + DATA_VERIFIED | Loop ON; scans ~every 12–18s (faster than configured 30s — dual timer suspected) |
| Snapshot scoring | DATA_VERIFIED + CODE_VERIFIED | Scores finite in prune logs (e.g. COIN 5.43); NaN not observed |
| Universe size | DATA_VERIFIED | `scanned: 122` (≥100 target) |
| Anchor lock | RUN_VERIFIED + CODE_VERIFIED | No `Pruned SPY/QQQ/GLD` in logs; protected set in MDW |
| Cap ≤12 | RUN_VERIFIED | Subscribe lines always `(12/12)` after fill |
| Unsubscribe-before-subscribe | CODE_VERIFIED + RUN_VERIFIED | Prune log line immediately precedes Subscribe |
| `symbol limit exceeded` (current pid) | RUN_VERIFIED | Not seen in current adaptive session logs |
| Discovery ≠ orders | DATA_VERIFIED + CODE_VERIFIED | `ideasEmitted: 0`; 0 `TRADE_IDEA_GENERATED` from OpportunityDiscovery (6h) |
| Downstream ticks | DATA_VERIFIED + RUN_VERIFIED | Technical/Kronos ticking; Kronos predicted on SOFI after swap |
| REST latency / HTTP 429 | NOT_VERIFIED | No persisted Alpaca REST latency/status counters in DB |

---

## 2. Live WebSocket Slot Allocation Table

**Source:** `logs/argus-dev.log` prune/subscribe pairs + status `discovery.shortlist` `already_subscribed` (RUN_VERIFIED).  
Exact in-memory `getActiveSymbols()` snapshot was not exposed on `argus-cli status` (continuous `/api/v1/continuous/status` not available via CLI). Slot list reconstructed from boot seed + last thrash cycle ending **RIVN @ 12/12**.

| Slot | Symbol | Type | RVOL / Momentum Score | Last Tick Age (ms) |
|---|---|---|---|---|
| 1 | SPY | Anchor | n/a (protected; not pruned) | Fresh feed (Technical/Kronos `lastTickAgeMs` ≈ 40–50 ms aggregate) — NOT_VERIFIED per-symbol |
| 2 | QQQ | Anchor | n/a (protected) | NOT_VERIFIED per-symbol |
| 3 | GLD | Anchor | n/a (protected) | NOT_VERIFIED per-symbol |
| 4–10 | NVDA, AAPL, MSFT, TSLA, IWM, AMD, META | Dynamic (seed holdovers) | Unscored / `+Inf` eviction bias — CODE_VERIFIED | NOT_VERIFIED per-symbol |
| 11–12 | Rotating: COIN ↔ MRVL ↔ SOFI ↔ RIVN ↔ ORCL | Dynamic (SNAPSHOT_HOT_SWAP) | Logged scores e.g. COIN **5.43**, MRVL **3.62**, SOFI **3.54**, RIVN **3.37**, ORCL **2.64** — RUN_VERIFIED | Thrash: often `ticks=0` at prune — RUN_VERIFIED |

**Cap check:** All post-fill subscribe logs show `(12/12)`. Never observed `(13/` — RUN_VERIFIED.

---

## 3. Snapshot Scanner Health Matrix

| Metric | Value | Evidence |
|---|---|---|
| Flag `.env` `ARGUS_OPPORTUNITY_LOOP_ENABLED` | `true` | CODE/config read — DATA_VERIFIED |
| Live discovery.enabled | `true` | `argus-cli status` — RUN_VERIFIED |
| Configured RTH cadence | `snapshotScanRthMs = 30000` | `config/continuousIntelligence.json` — CODE_VERIFIED |
| Observed scan interval | **~12–18 s** between `OPPORTUNITY_SCAN_COMPLETED` | DB timestamps 15:15–15:19Z — DATA_VERIFIED |
| Adaptive banner | Logged **twice** (`RTH 30000ms / off 300000ms`) | `logs/argus-dev.log` lines ~188 & ~213 — RUN_VERIFIED (dual worker) |
| Symbols evaluated / scan | **122** | `json_extract(payload,'$.scanned')` — DATA_VERIFIED |
| `momentumHotSwap` | `true` (RTH) | status + DB — RUN/DATA_VERIFIED |
| `subscribeRequested` / cycle | **4** | status + DB — RUN/DATA_VERIFIED |
| `ideasEmitted` | **0** | status + DB — RUN/DATA_VERIFIED |
| Top movers requested | COIN, MRVL, SOFI, RIVN, ORCL | `WATCHLIST_SUBSCRIBE_REQUESTED` reason=`SNAPSHOT_HOT_SWAP` — DATA_VERIFIED |
| Avg Alpaca REST latency | — | **NOT_VERIFIED** (not instrumented) |
| HTTP 429 count | — | **NOT_VERIFIED** (not instrumented); no disconnect storm this pid |

**Scoring formula (CODE_VERIFIED):**  
`momentumScore = |intradayPctChange|×0.5 + relativeVolume×0.3 + rangeExpansion×0.2` in `SnapshotScanner.ts`.  
Prune logs show finite scores (no `NaN`) — RUN_VERIFIED.

---

## 4. Hot-Swap Eviction Log (last cycles)

Wire order repeatedly: **Pruned … → Subscribed … (12/12)** — RUN_VERIFIED.

| Time (log order) | Evicted (dynamic) | Score / ticks | In (new) | Cap |
|---|---|---|---|---|
| Cycle N | ORCL | 2.703 / 28 | COIN | 12/12 |
| same cycle | COIN | 5.427 / 0 | MRVL | 12/12 |
| same cycle | MRVL | 3.631 / 0 | SOFI | 12/12 |
| same cycle | SOFI | 3.581 / 0 | RIVN | 12/12 |
| Cycle N+1 | RIVN | 3.365 / 65 | COIN | 12/12 |
| … | COIN | 5.427 / 0 | MRVL | 12/12 |
| … | MRVL | 3.631 / 0 | SOFI | 12/12 |
| … | SOFI | 3.581 / 0 | ORCL | 12/12 |

**Anomaly (DEGRADED):** One scan emits **4** `SNAPSHOT_HOT_SWAP` requests. At a full stream, each subscribe prunes the **previous** hot-swap (often with `ticks=0`). Net effect: churn among COIN/MRVL/SOFI/RIVN/ORCL instead of a stable top-8 dynamic set.

**Root cause (CODE_VERIFIED):**  
1. `planSnapshotHotSwap` allows up to `momentumHotSwapSlotsPerCycle` (4) when `emptySlots=0`.  
2. MDW eviction uses `dynamicMomentumScores.get(s) ?? +Infinity`, so **unscored seed dynamics resist eviction** while **newly scored hot-swaps become the cheapest prune targets**.

**Unsubscribe-before-subscribe:** Implemented in `MarketDataWorker.unsubscribe` before `subscribe` send — CODE_VERIFIED; log ordering confirms — RUN_VERIFIED. Raw WS JSON `action:"unsubscribe"` text is not printed (no log line) — wire payload **NOT_VERIFIED** beyond ordering.

**Anchors:** No prune lines for SPY/QQQ/GLD — RUN_VERIFIED.

---

## 5. Downstream Agent Response Matrix

| Agent | Live health (status) | Hot-swapped symbols | Evidence |
|---|---|---|---|
| TechnicalAgent | TICKING / `lastTickAgeMs` ≈ 40–50 | Ideas/consensus on TSLA etc.; thrash limits dwell on COIN/MRVL | RUN_VERIFIED |
| KronosEngine | RUNNING / Chronos up | **SOFI SELL @ 0.85** (15:14:05Z); META/TSLA activity | DATA_VERIFIED (`agent_predictions`) |
| QuantSignalAgent | Present; intermittent stale `lastTickAgeMs` | Not specifically attributed to RIVN/COIN in sample | DEGRADED / partial |
| OpportunityScreener | Ideas armed | **27** `TRADE_IDEA_GENERATED` (OpportunityScreener) in 6h | DATA_VERIFIED |
| OpportunityDiscovery | — | **0** trade ideas | DATA_VERIFIED |
| ChiefTrader | Consensus holds @ 0.75 | e.g. TSLA BUY votes still fail bar (34% &lt; 75%) | RUN_VERIFIED |

**Idea-gate separation:** OpportunityDiscovery source never appears on `TRADE_IDEA_GENERATED` (6h count **0**) — DATA_VERIFIED. No `.placeOrder` in continuous zone — CODE_VERIFIED (`architecture.protection` contract).

---

## 6. Identified Anomalies / Gaps & Safest Action Required

### Anomalies
1. **Hot-swap thrash** — 4 sequential swaps/cycle at cap; high-score newcomers pruned with `ticks=0`.  
2. **Dual adaptive scanner start** — banner logged twice; observed cadence ~half of 30s.  
3. **Eviction score default `+Infinity`** for unscored symbols biases prune toward freshly scored movers.  
4. **Campaign watchlist boost storm** — 504 `CAMPAIGN_WATCHLIST_BOOST` in 6h (noise vs SNAPSHOT_HOT_SWAP).  
5. **REST latency / 429** — not observable in DB (instrumentation gap).  
6. **Historical** `symbol limit exceeded` exists in older `argus-dev-serveronly.log`; **not** observed under current adaptive pid’s prune path.

### Safest actions (operator / follow-up engineering — **not** done in this audit)
1. **Do not** lower consensus or widen WS cap.  
2. Restart once cleanly (single process) so only **one** OpportunityDiscovery timer runs; confirm a single “Adaptive snapshot scan” line.  
3. Engineering (separate change PR):  
   - Cap hot-swaps to **1** replacement per cycle when stream is full, **or** batch-plan evictions against weakest *unscored-or-low* dynamics.  
   - Treat missing momentum score as **0** (or tick-count-only), never `+Infinity`.  
   - Persist last SnapshotScanner top-N + active slot table on `/api/v1/continuous/status` for forensics.  
4. Optional: add Alpaca REST latency / status counters (no safety change).

### What is healthy
- PAPER / LIVE_NO_GO unchanged.  
- Cap **12** held.  
- Anchors **SPY/QQQ/GLD** not evicted.  
- Discovery still **watch-only** (`ideasEmitted: 0`).  
- Agents still receiving ticks; consensus bar still blocking weak agreements.

---

## Evidence index

| ID | Artifact |
|---|---|
| E1 | `argus-cli health/status` (pid 41640 / prior 12780) |
| E2 | `data/argus.db` `event_traces` (`OPPORTUNITY_SCAN_COMPLETED`, `WATCHLIST_SUBSCRIBE_REQUESTED`) |
| E3 | `data/argus.db` `agent_predictions` (Kronos SOFI/META/TSLA) |
| E4 | `logs/argus-dev.log` Adaptive banner ×2; Pruned→Subscribed (12/12) |
| E5 | `config/continuousIntelligence.json` + `SnapshotScanner.ts` + `MarketDataWorker.ts` |
| E6 | `.env` `ARGUS_OPPORTUNITY_LOOP_ENABLED=true` (flag presence only) |

---

*End of read-only audit. No code or runtime mutations were performed as part of remediation.*
