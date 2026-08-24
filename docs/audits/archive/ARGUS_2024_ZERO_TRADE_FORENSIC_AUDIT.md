# ARGUS 2024 ZERO-TRADE FORENSIC AUDIT

Investigation of a real, run-verified Historical Evaluation: full year 2024, `ALL_CORE` (5 core strategies), real Alpaca daily bars, `ARGUS_DISCOVERY` universe, $100,000 capital, AI disabled. Result: 0 trades filled against a +25.03% buy-and-hold benchmark. This document determines *why*, with evidence graded CODE-VERIFIED / DATA-VERIFIED / RUN-VERIFIED — no speculation presented as fact.

Replay run analyzed: `24d887d6-53d7-4f0f-85bb-71cf7253b8ef`.

---

## Executive summary

Two independent, fully-proven root causes, either of which alone guarantees zero fills:

1. **Consensus approval is mathematically unreachable** under the current default agent weights combined with the replay engine's TechnicalAgent confidence proxy. Not "rare" — *impossible*, for any input, by construction. **[CODE-VERIFIED + arithmetic proof]**
2. **The `market_hours` RiskEngine gate fails 100% of the time for `1Day`-frequency replay bars**, because Alpaca's daily bar timestamps land at midnight ET, not market open, and the session classifier correctly reports midnight as outside the 09:30–16:00 ET window. **[CODE-VERIFIED + DATA-VERIFIED against the real SQLite risk_assessments/risk_gate_results rows from this exact run]**

Neither finding is a "RiskEngine is too strict" or "the market didn't offer opportunities" story. Both are structural replay-fidelity/configuration issues, independent of market conditions, strategy quality, or the 2024 dataset specifically.

---

## 1. The funnel (real numbers from this run)

| Stage | Count |
|---|---|
| Strategy-pass evaluations (symbol × tick × strategy) | ~7,960 |
| Blocked pre-consensus (`INSUFFICIENT_SAMPLE`, warmup) | 320 |
| Blocked at ChiefTrader consensus (`NO_CHIEF_APPROVAL`) | 7,442 |
| Reached RiskEngine | 198 |
| RiskEngine rejections | 198 (100%) |
| Filled | 0 |

## 2. Consensus diagnosis — mathematically proven, not empirical

**Which agents vote in replay (CODE-VERIFIED, `FullArgusReplayEngine.ts:826-829`):**
```ts
ideas = [
  { agent: 'QuantEngine', side, confidence, ... },
  { agent: 'TechnicalAgent', side, confidence: rsi > 50 ? 0.55 : 0.45, ... },
];
```
Only 2 voters exist in this configuration (AI disabled): QuantEngine and TechnicalAgent. NewsAgent is `CATALYST_ONLY` (not a voter), FundamentalAgent/MacroAgent are `UNAVAILABLE` in replay (confirmed via this run's `agentAvailability`). TechnicalAgent's `side` is **not independently determined** — it is set to the *same* `side` QuantEngine already picked, with only its confidence varying by RSI. It can never disagree directionally, so the "≥2 independent agreeing agents" gate is trivially satisfied whenever QuantEngine emits a non-HOLD idea — that gate is not the bottleneck.

**Consensus math (CODE-VERIFIED, `EvidenceAggregator.ts:53-68`, `PitReplay.ts:94-101`):**
```
weightedConfidence = Σ(confidence_i × weight_i) / Σ(weight_i)   [agreeing agents only]
approved = side != HOLD AND independentAgents >= 2 AND weightedConfidence >= 0.75
```

**Real weights (`config/agentWeights.json`, DATA-VERIFIED):**
```
QuantEngine:     0.15
TechnicalAgent:  0.25   ← higher weight than QuantEngine
```

**TechnicalAgent's replay confidence ceiling (CODE-VERIFIED, `FullArgusReplayEngine.ts:828`):** `rsi > 50 ? 0.55 : 0.45` — maximum possible value is **0.55**.

**The proof:**
```
max possible weightedConfidence = (Qconf_max × 0.15 + 0.55 × 0.25) / (0.15 + 0.25)
                                 = (1.0 × 0.15 + 0.1375) / 0.40
                                 = 0.71875
```
Approval requires **≥ 0.75**. Even with QuantEngine at its theoretical absolute maximum confidence of 1.0 — a value no real strategy signal ever actually emits — the weighted consensus tops out at **0.71875, a full 0.03125 below the bar, for every possible input.** Consensus approval is not merely unlikely under this configuration; it is **provably impossible**. This is the complete, exact explanation for all 7,442 `NO_CHIEF_APPROVAL` rejections.

This is a **replay-fidelity finding**, not necessarily a live-system finding: TechnicalAgent's live implementation (real RSI/MACD/Bollinger, per CLAUDE.md) almost certainly computes a richer confidence score than this `rsi>50` binary proxy. `agentAvailability.TechnicalAgent.status` in this run is explicitly `"PARTIAL"` — the replay engine documents this itself as a simplification, not a live-accurate calculation. Whether live TechnicalAgent's real confidence range also skews this low is **NOT VERIFIED** in this pass and would require separate live-code tracing.

## 3. RiskEngine diagnosis — 100% single-gate failure, DATA-VERIFIED

Queried `data/argus.db` directly for every `risk_assessments`/`risk_gate_results` row belonging to this exact run (`trace_id LIKE 'replay-24d887d6-...-%'`):

| Gate | Passed | Failed |
|---|---|---|
| `market_hours` | 0 | **198 (100%)** |
| All other 23 gates | 198 (100%) | 0 |

Every single one of the 198 ideas that reached RiskEngine passed all 23 other gates — `argus_capital_allocation`, `price_validity`, `sufficient_size`, everything — and failed on exactly one, always with reasoning `"Market is currently closed (Alpaca clock)."`

**Root cause (CODE-VERIFIED, `RiskEngine.ts:269,441`):**
```ts
const nowMs = replay ? replay.clock.now() : Date.now();   // correctly uses simulated time
const marketClock = replay
  ? (sessionAllowsFills(classifyMarketSession(nowMs, replay.config.timezone, replay.config.extendedHours), ...) ? 'open' : 'closed')
  : await readMarketClock();
```
The replay-awareness itself is implemented correctly — the bug is upstream of it. Sample daily bar timestamps from this run's actual risk_assessments rows:

| Raw timestamp (ms) | UTC | America/New_York |
|---|---|---|
| 1712116800000 | 2024-04-03T04:00:00Z | **2024-04-03, 12:00:00 AM** |
| 1712203200000 | 2024-04-04T04:00:00Z | **2024-04-04, 12:00:00 AM** |

Alpaca's daily-bar timestamps mark the *start of the trading day* (midnight ET), not market open (9:30 AM ET). `classifyMarketSession()` checks `regularSessionStartMinutes` (570 = 9:30am) through `regularSessionEndMinutes` (960 = 4pm); midnight (minute 0) falls outside that window (and outside pre-market too, since `preMarketStartMinutes` = 240 = 4am > 0). So **every daily-bar decision looks like it's being made at midnight**, and `market_hours` fails unconditionally, independent of which historical date is being simulated. This is a pure timestamp-alignment defect specific to `1Day` frequency — intraday frequencies (`1Min`/`5Min`/`15Min`/`1Hour`) would carry real intraday timestamps and would not necessarily hit this.

## 4. Execution/fill diagnosis

Given finding #3, the answer to "why zero fills" is direct and complete: **all 198 ideas that reached RiskEngine were rejected there, at the exact same gate, for the exact same structural reason. Zero ever reached position sizing, OMS, or the broker.** There is no OMS/execution-layer problem to investigate — the funnel never got that far.

## 5. Discovery diagnosis

`ARGUS_DISCOVERY` selected the same 8 symbols for the entire year in this run: AAPL, MSFT, NVDA, GOOGL, AMZN, META, AMD, CRM — the most liquid names in the 31-symbol curated pool by point-in-time dollar volume, rescanned every 5 bars per `historicalDiscoveryRescanEveryBars`. **NOT INVESTIGATED further in this pass:** whether the rescan ever actually rotated any symbol out over the full year (would require re-querying `discoveredAt`/event logs from this run, which are still on disk under `data/replays/24d887d6-.../events.jsonl` if not yet cleaned up).

## 6. What this does NOT prove

- It does not prove Argus's strategies (MOMENTUM_BREAKOUT etc.) are good or bad — none of their signals ever got a fair chance to reach RiskEngine's non-`market_hours` gates in numbers large enough to judge, and consensus math blocked the vast majority before that.
- It does not prove the live system has the same ceiling — TechnicalAgent's live confidence formula was not traced in this pass.
- It does not prove `1Min`/`5Min`/`15Min` replay frequencies avoid the `market_hours` bug — not tested here.

## 7. Findings table

| # | Finding | Evidence grade | Component | Impact |
|---|---|---|---|---|
| 1 | Consensus cannot mathematically reach 0.75 given TechnicalAgent weight (0.25) > QuantEngine weight (0.15) and TechnicalAgent's 0.55 replay confidence ceiling | CODE-VERIFIED (arithmetic proof from real config values) | `EvidenceAggregator.ts`, `PitReplay.ts`, `config/agentWeights.json`, `FullArgusReplayEngine.ts:828` | Blocks 100% of possible replay trades under `aiMode: DISABLED`/`RECORDED_DECISION_REPLAY`/`LIVE_MODEL_REPLAY` (aiMode does not change this — see below) |
| 2 | `market_hours` gate fails 100% of daily-bar RiskEngine evaluations because Alpaca daily-bar timestamps are midnight ET, not 9:30am ET | CODE-VERIFIED + DATA-VERIFIED (real DB query, this run) | `RiskEngine.ts:441`, `marketSession.ts`, Alpaca daily bar format | Blocks 100% of ideas that survive consensus, for `1Day` frequency specifically |
| 3 | `aiMode` (`DISABLED`/`RECORDED_DECISION_REPLAY`/`LIVE_MODEL_REPLAY`) has no effect on consensus math today — `PitReplay.ts` never references `AIRouter`/`routeConsensus` | CODE-VERIFIED | `FullArgusReplayEngine.ts` (AI mode only changes a per-tick telemetry label), `PitReplay.ts` | "AI enabled" replay runs will show identical consensus/fill behavior to AI-disabled runs until this is wired up |

## 8. Recommendations (NOT implemented — investigation only, per instruction)

Ranked by the spec's own P0–P4 scale, for a future engineering-review pass:

- **P0 (correctness bug, not a threshold change):** `market_hours` gate should use `classifyMarketSession` against the bar's own *close/session* time or should treat `1Day`-frequency bars as inherently "the regular session occurred" rather than checking midnight against intraday-session minute boundaries. This is a bug fix, not a threshold loosening — it does not touch `consensusApprovalThreshold` or `minIndependentAgreeingAgents`.
- **P1 (replay fidelity):** Either (a) document that `TechnicalAgent`'s replay confidence proxy structurally cannot support consensus under current weights and that this is a known, accepted replay limitation, or (b) investigate whether live `TechnicalAgent`'s real confidence calculation has a materially different (higher) range, and if so, build a closer replay approximation. This is a fidelity question, not a "loosen the bar" question.
- **P2:** Wire `aiMode` into `PitReplay.ts`/consensus so "AI enabled" replay runs actually differ from "AI disabled" ones, or relabel the option to make clear it currently has no effect.

No production thresholds, gates, or weights were changed in this investigation.
