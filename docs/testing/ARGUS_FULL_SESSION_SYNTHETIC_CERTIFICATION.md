# Argus Full-Session Synthetic Certification

**Date:** 2026-10-11/12 · **Branch:** `mission/oct8-oct9-closure` · **Build:** see `BUILD_SHA` in run artifacts
**Status:** DRAFT (Worker H) — replaces the Worker-I stub. This is the real artifact.
**Safety posture:** PAPER ONLY, `LIVE_NO_GO`. Synthetic certification proves engineering capability, not alpha.

> Verdict language per repo convention: "no known blocking defects found under the conditions
> tested" — never "zero defects" / "perfect". All synthetic fixtures labeled `SYNTHETIC_SEEDED` /
> `NON_ORGANIC` / `CERTIFICATION_FIXTURE_ONLY`, never presented as organic evidence.

---

## 1. Session design

A deterministic accelerated full trading-day session — **PREMARKET → OPEN → MORNING → MIDDAY →
POWER HOUR → CLOSE → POST-CLOSE** — executed against the repair-branch build with:

- **Real production services:** Discovery, subscription allocator, HistoricalDataGateway, Quant
  scheduler, Java Quant Core (via the bridge), strategy selection, lifecycle authorization,
  policy router, ChiefTrader, RiskAgent, RiskEngine, PositionSizing, OMS, BrokerManager
  simulator, fills, accounting, reconciliation. **No middle-stage approval was inserted manually.**
- **Synthetic environment only:** synthetic market data (seeded PRNG, `CERTIFIED_BULLISH_ENTRY_EXIT`
  scenario, 390 one-minute bars, 5 symbols + 1 late mover), synthetic broker
  (`HistoricalReplayBroker`), synthetic clock (30x), isolated DB per run, fault injection.
  Synthetic controls the ENVIRONMENT, never the decision — no forced signals, no forced
  Chief/Risk approvals, no forced fills above the broker boundary.

**Harness** (new, Worker H): `scripts/sim/fullSession.ts` (parent launcher, pure) →
`scripts/sim/fullSessionChild.ts` (isolated child, spawn-time env isolation) →
`src/server/replay/synthetic/SyntheticSessionEngine.ts` (extended) +
`src/server/replay/synthetic/SessionFaultPlan.ts` (new: environment-only fault plan).
Per-run JSON in the out dir plus `combined-summary.json`.

**Certification gate:** `evaluateCertification()` — FAIL on (a) zero market-data ticks (broken
simulator, not a safety proof), (b) **idea generation HELD at boot** (see §4, new),
(c) timeline invariant violations, (d) fills without applied costs, (e) no trade when a trade
is required. A quiet session under an open gate is a PASS (Test A semantics); a quiet session
under a held gate is a FAIL (broken test setup, not a quiet market).

---

## 2. Scenario matrix and per-scenario outcomes

### Canonical full day (v2, 2026-10-12 ~03:51 UTC)

Seed 424242, `CERTIFIED_BULLISH_ENTRY_EXIT`, 390 bars, full fault matrix. **Gate open**
(`ideaGenerationGateOpen: true`). Certification: **FAIL** — `requireTradeForCertification=true`
and zero trades resulted (all 66 ideas correctly blocked at consensus; see §3). No invariant
violations; 2270 MARKET_DATA ticks.

| # | Scenario / fault | Phase | Outcome |
|---|---|---|---|
| 1 | PREMARKET probes | PREMARKET | **PASS** — RISK_REJECTION_PROBE: 1B-share SPY BUY → `RISK_ASSESSMENT_COMPLETED` approved=false (rejectionGate=data_freshness). INVALID_STRATEGY_PROBE: unknown strategy → `REQUIRES_CONSENSUS`, never authorized. VALID_STRATEGY_PROBE: real strategy → `NOT_AUTHORIZED`/`NO_LIFECYCLE_RECORD` (path exercisable). STALE_TAIL_PROBE: unseeded symbol → 0 bars (fail-closed). JEV_OUTAGE_PROBE ×2: `isConfigured()=false`, `decide()` throws `NO_API_KEY` before network. |
| 2 | LATE_MOVER | bar 5 | **INFO** — `CERT_LATE` admitted (subscribed, bars revealed); pipeline evaluated it like any symbol. |
| 3 | AI_OUTAGE | bar 60 | **PASS** — 2 providers cleared; `hasAnyRoutableProvider()=false`. |
| 4 | NEWS_BURST | bar 150 | **INFO** — 8 articles injected; real news pipeline produced `NEWS_CATALYST` events and 2 NewsAgent ideas. |
| 5 | AI_RECOVERY | bar 180 | **INFO** — 2 providers re-registered; `hasAnyRoutableProvider()=true`. (Reporting bug fixed: previously said "0 providers".) |
| 6 | BACKUP_RUN | bar 200 | **PASS** — `DbBackupService.runBackup()` completed mid-session; event loop maintained. |
| 7 | PARTIAL_FILL_LIQUIDITY_CAP | bars 0–389 | **INFO** — window armed, `maxVolumeParticipationPct=0.05` enforced per bar (would force partial fills on any order > 5% of bar volume; no orders were submitted — see §3). |
| 8 | FEED_INTERRUPTION | bars 300–309 | **INFO** — window armed; ticks suppressed for the window (no orders may exist inside it — invariant checked). |
| 9 | Stale cache (MSFT 1Day) | session | **INFO** — `HistoricalDataGateway` logged `STALE_TAIL` (wall-clock freshness vs simulated date); served cached bars with warning by design in synthetic mode. |
| 10 | Quant scheduler load | session | **INFO** — full-universe quant evaluation cycles ran each bar; `QUANT_CYCLE_STARTED/COMPLETED` throughout. |
| 11 | Empty provider response / provider timeout / provider recovery / hung request | session | **COVERED** — local AI endpoints unreachable in sandbox (fetch failed); providers decayed to Degraded/Offline honestly; contradiction analysis degraded to `available:false`; no fabricated AI output. |
| 12 | Market-data reconnect | session | **COVERED** — feed interruption window + recovery; ticks resumed after. |
| 13 | Successful / winning / losing PAPER trade, protective exit | session | **NOT COVERED** — zero trades (see §3). The pipeline correctly refused to trade; trade-lifecycle mechanics remain covered by broker/OMS unit tests, not this session. |
| 14 | Restart | — | See §5 (restart halves). |

### Trade-lifecycle variant (bootstrap, 2026-10-12 ~04:05 UTC)

Identical environment + fault matrix, plus operator-gated `QUANT_COLD_START_BOOTSTRAP_ENABLED=true`
(environment control — the documented operator gate; every idea still faced the identical
0.75-strict / min-2-agents consensus gate). **No crash** (validates the §4 AIRouter fix).
132 ideas (59 QuantEngine bootstrap, 69 TechnicalAgent, 2 NewsAgent, 1 FundamentalAgent,
1 MacroAgent), 42 consensus evaluations, **0 approvals** — highest-confidence ideas (0.791,
0.786, 0.758) cleared 0.75 but were still rejected for min-2-agents ("only 1 independent
evidence group agreed"). The remediated consensus gate holds under a denser idea flow.

---

## 3. What the session proves (and what it does not)

**Proves (engineering capability):**
- The full pipeline runs end-to-end on the repair-branch build: market data → agents →
  consensus → (no approvals, correctly) → RiskEngine probes → OMS → broker → accounting →
  reconciliation (`RECONCILIATION_MATCH` observed).
- The **remediated consensus gate works under load**: 66 ideas (canonical) and 132 ideas
  (bootstrap) were all correctly refused — sub-0.75 confidences rejected on the strict
  threshold; the three ideas above 0.75 rejected on min-2-agents. No bypass, no exception.
- Fault injection is environment-only and the pipeline degrades honestly (AI outage →
  `available:false`, never fabricated output; Jev inert; stale cache fail-closed).
- Certification fails loud on broken setups (zero ticks, held gate) instead of passing silently.

**Does NOT prove:** alpha, edge, or profitability. A synthetic session cannot prove a strategy
makes money. The zero-trade outcome is the system working correctly (fail-closed), not evidence
of anything about real-market performance.

**Not covered by this session:** actual fills, partial-fill execution, protective exits, and
win/loss P&L — no orders were submitted because consensus (correctly) approved nothing. These
mechanics are covered by the `HistoricalReplayBroker` / OMS unit tests and the pre-existing
Test B mechanism suite, not by this session. The scenario name `CERTIFIED_BULLISH_ENTRY_EXIT`
dates from 2026-09-15 when a RiskEngine-approved order flowed through the (then-bypassed)
consensus path; under the remediated gate the same scenario produces no trades.

---

## 4. Defects found

| # | Severity | File:line | Defect | Fix |
|---|---|---|---|---|
| H-1 | **HIGH** | `src/server/ai/AIRouter.ts:393` (was) | Unhandled promise rejection crashes the process: the #19 fix's `promise.finally(() => { entry.settled = true; })` discarded the derived promise; when `routeTask`'s execution rejected (all AI providers down but registered), the derived promise rejected unhandled → process death under Node's `--unhandled-rejections=throw`. Found live: the trade-lifecycle session crashed at the first quant contradiction-analysis AI call. Any total AI failure through `routeTask` would kill Argus instead of degrading gracefully. | Replaced with two-handler `.then(onF, onR)` (derived promise always fulfills); added regression test (fails on old code, passes on new). |
| H-2 | **MEDIUM** | `src/server/replay/synthetic/SyntheticSessionEngine.ts` + `CertificationGate.ts` | Silent held-gate: a crashed synthetic session leaves an unclean session marker; the next run with the same simulationId silently engages the restart-safety hold (`TRADING_PAUSED`, `allowsNewEntryIdeas()=false`) — every idea agent gated for the whole session, and the "no ideas" result looked like a quiet market. The canonical v1 run was affected (zero `TRADE_IDEA_GENERATED`). | Engine records `ideaGenerationGateOpen` at boot (warns if closed); `evaluateCertification` FAILs a held session; planned restart stops mark clean shutdown; driver uses unique simulationIds per run. |
| H-3 | MINOR | `src/server/replay/synthetic/SessionFaultPlan.ts` | AI_RECOVERY reported "re-registered 0 providers" (length read after `recoverAi()` cleared the array). | Capture count before clearing. |
| H-4 | MINOR | `src/server/replay/synthetic/SessionFaultPlan.ts` | Window faults (FEED_INTERRUPTION, PARTIAL_FILL_LIQUIDITY_CAP) had no recorded outcome. | INFO outcome recorded at window start. |
| H-5 | MINOR (test) | `src/server/ai/AIRouter.providerResilience.test.ts` | #19 changed pruning to settled-only but the TTL test still expected the old prune-unsettled behavior (pre-existing failure). | Test now settles the entry before advancing past TTL, matching #19's documented intent. |

All fixes are on `mission/oct8-oct9-closure`, committed separately by Worker H. No consensus/Risk/OMS/reconciliation invariant was weakened; `LIVE_NO_GO` and PAPER_ONLY hold throughout.

---

## 5. Restart and matrix runs

### Restart halves (2026-10-12 ~04:10 UTC)

Two fresh processes against one isolated DB: half 1 bars 0–199 (planned stop, clean shutdown
marked), half 2 resumes at bar 200 with exported/imported broker state.

| Check | Result |
|---|---|
| Half 1 completes, stops at bar 199 | **OK** — exit 0, `stoppedEarly=true`, 38 ideas, gate open |
| Half 2 resumes in a fresh process | **OK** — exit 0, 25 ideas, gate open (`ideaGenerationGateOpen: true` — the planned-stop clean-shutdown marking worked; no spurious restart-safety hold inherited) |
| Timeline continuity | **OK** — merged timeline sorted on the synthetic clock; no gaps, no duplicate bars |
| Broker state continuity | **OK** — `exportState()`/`importState()` round-trip; orders 0/0 (no orders to carry — consistent with the no-trade outcome) |
| Merged certification | **FAIL at CONSENSUS** (expected) — `MARKET_DATA: true`, `AGENT_IDEA: true`, zero invariant violations; blocked only because consensus (correctly) approved nothing and `requireTradeForCertification=true` |

**Proves:** a mid-session process restart resumes cleanly — order/broker state is resolvable
across the restart, the session continues on the same synthetic clock, and the resume half
does not inherit a spurious entry hold from the planned stop. (A real crash would leave the
marker unclean and the hold would correctly engage — that path is unit-covered by
`sessionRecovery` tests.)

### Scenario matrix (2026-10-12 ~04:25 UTC, re-run to persistent storage after a tmpfs wipe)

Six 90-bar scenarios (60x), no fault plan, gates open in all (`ideaGenerationGateOpen: true`):

| Scenario | Cert | Ideas → consensus → fills | Verdict |
|---|---|---|---|
| quiet-open (Test A) | **PASS** | 12 → 4 → 0 | Quiet market correctly produced no trades. |
| extreme-noise (Test A) | **PASS** | 12 → 7 → 0 | Pure random walk did not manufacture trades. |
| data-interruption (feed outage bar 30, 10 bars) | **PASS** | 11 → 7 → 0 | No orders inside the outage; recovery after. |
| trending-bear (Test B, short-side mirror) | **FAIL** | 15 → 8 → 0 | Blocked at CONSENSUS — `requireTradeForCertification=true`, no approvals (correct fail-closed; same finding as canonical). |
| news-shock (Test B, burst through real news pipeline) | **FAIL** | 6 → 6 → 0 | Blocked at CONSENSUS — same. |
| scheduler-load (10 symbols, 60 bars, observation) | n/a | 4 → ? → 0 | Ran clean; quant cycle latency observed, no anomalies. |

The two FAILs are the honest "no trade when a trade was required" outcome — the consensus gate
correctly refused every idea. No scenario manufactured a trade, no invariant violations anywhere.

---

## 6. Artifacts

- Canonical v2, trade-lifecycle, restart halves, matrix: `~/workspace/worker-h-full-session/` (persistent; the original `/tmp/full-session/` artifacts were lost in a 2026-10-12 tmpfs wipe — key numbers were captured in this document before the loss)
- Session DBs: `/tmp/argus_synthetic_sim_*.db` (isolated, disposable; likewise ephemeral)
- Driver: `node --use-system-ca node_modules/tsx/dist/cli.mjs scripts/sim/fullSession.ts [--only=canonical|lifecycle|restart|matrix] --outdir=<dir>`
