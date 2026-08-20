# ARGUS Phase C — Historical Evaluation Forensic Audit

**Phase:** C — Audit only (no implementation in this document)  
**Date:** 2026-08-19  
**Authoritative inputs:** Current repository code, existing replay tests, prior audits (superseded where code has moved on)  
**Evidence grades:** CODE-VERIFIED · TEST-VERIFIED · RUN-VERIFIED · NOT VERIFIED · UNKNOWN

**Supersedes partially:** `ARGUS_FULL_SYSTEM_HISTORICAL_SIMULATION_AUDIT.md` (2026-08-18 — many listed gaps have since been implemented). This audit reflects **current** `src/server/replay/` as of Phase B completion.

---

## Executive summary

Argus already has a **substantial** “MODE B” full-system historical replay engine (`FullArgusReplayEngine.ts`) that:

- Uses **real** `RiskEngine` + **real** `OrderManagementService` + `HistoricalReplayBroker`
- Supports **operator-no-symbol** mode via `universeSource: 'ARGUS_DISCOVERY'`
- Enforces **InformationCutoff** / **ReplayClock** look-ahead protection
- Produces decision funnel, agent stats, missed-opportunity retrospective, performance diagnostics, and ZIP export

It is **not yet** a complete “Argus Historical Evaluation” product as defined in the Phase C spec because:

1. **Discovery is a replay-specific liquidity screen**, not literal reuse of `OpportunityDiscovery` / `OpportunityScreener` / `MarketUniverseScanner`
2. **Consensus is `CONSENSUS_MATH_REPLAY`** (`PitReplay.ts`), not live `ChiefTraderAgent` + EventBus
3. **Agents are partial** — Quant via `replayArgusStrategy`, Technical via RSI only; News/Fundamental/Macro/Kronos not historically faithful
4. **Default config** still defaults to `OPERATOR_SELECTED` in `defaultReplayConfig()` even though UI defaults to `ARGUS_DISCOVERY`
5. **RUN-VERIFIED** autonomous evaluation on **real Alpaca data** with **zero operator symbols** is **NOT VERIFIED** (tests use `golden_replay` fixture)
6. **CLI `argus replay`** and simplified “capital + dates only” UX need polish; API surface is partial vs spec §28

**Bottom line:** Phase C is largely **extension and honesty hardening**, not greenfield. Do **not** build a second trading brain.

---

## 1. Product requirement vs current state

| Spec requirement | Status | Grade | Evidence |
|------------------|--------|-------|----------|
| Operator provides capital + dates only (no symbols) | **IMPLEMENTED** (discovery mode) | TEST-VERIFIED | `createReplayRun` overrides symbols when `ARGUS_DISCOVERY` (`FullArgusReplayEngine.ts:396-403`); UI default `universeMode='ARGUS_DISCOVERY'` (`HistoricalReplayLab.tsx:290`); `phase18.fullReplay.test.ts:329-384` |
| Autonomous candidate universe at each T | **PARTIAL** | CODE-VERIFIED | Point-in-time **liquidity screen** over static pool (`HistoricalUniverseProvider.ts`); rescan every N bars; **not** live discovery modules |
| Full decision funnel | **IMPLEMENTED** | TEST-VERIFIED | `buildDecisionFunnel()` in `replayReport.ts`; populated in run summary (`FullArgusReplayEngine.ts:1086-1092`); asserted in phase18 test |
| Per-agent evaluation | **IMPLEMENTED** | TEST-VERIFIED | `buildAgentEvaluation()` + `session.agentIdeaStats` |
| Missed opportunities (post-run only) | **IMPLEMENTED** | TEST-VERIFIED | `MissedOpportunityAnalysis.ts`; consensus rejections only; label `AFTER-THE-FACT ANALYSIS` |
| Real RiskEngine on every BUY/SELL | **IMPLEMENTED** | CODE-VERIFIED | `submitThroughRiskAndOms()` → `riskEngine.evaluateRisk()` |
| Real OMS on every order | **IMPLEMENTED** | CODE-VERIFIED | OMS listens to `RISK_ASSESSMENT_COMPLETED`; `notifyReplayOrder(traceId)` sync |
| NEXT_BAR_OPEN fills | **IMPLEMENTED** | TEST-VERIFIED | `HistoricalReplayBroker` + `phase24.historicalReplay.test.ts` |
| Partial fills / volume cap | **IMPLEMENTED** | CODE-VERIFIED | `maxVolumeParticipationPct`, `PARTIALLY_FILLED` status (`HistoricalReplayBroker.ts:58-64, 179-263`) |
| Complete ZIP export | **IMPLEMENTED** | TEST-VERIFIED | `exportZipArchive()` in `replayStore.ts` |
| UI: no symbol selector in normal mode | **IMPLEMENTED** | CODE-VERIFIED | Symbols field hidden when `ARGUS_DISCOVERY` (`HistoricalReplayLab.tsx:598-599`) |
| UI: “Argus Historical Evaluation” branding | **NOT IMPLEMENTED** | CODE-VERIFIED | Still “Historical Replay Lab” |
| CLI headless replay | **NOT IMPLEMENTED** | CODE-VERIFIED | No `argus replay` command; API exists |
| RUN-VERIFIED real-market autonomous run | **NOT VERIFIED** | — | No recorded operator run on Alpaca with ARGUS_DISCOVERY for spec date range |

---

## 2. Architecture — one core, three environments

```
                    ARGUS CORE (protected spine logic)
                           |
         +-----------------+-----------------+
         |                 |                 |
       LIVE            REPLAY            RESEARCH
    MarketDataWorker   ReplayClock      BacktestEngine
    Live brokers       HistoricalReplayBroker   VectorBT / warehouse
    EventBus ON        EventBus OFF*     No OMS
         |                 |                 |
         +-----------------+-----------------+
                           |
              Shared modules (by reference):
              RiskEngine, OMS, PositionSizing,
              EvidenceAggregator, ThesisInvalidation,
              ExitIntelligenceEngine (called directly in replay)
```

\*Replay **deliberately** does not emit `TRADE_IDEA_GENERATED` on the live EventBus (`FullArgusReplayEngine.ts` header). It calls `riskEngine.evaluateRisk()` directly and relies on OMS’s existing listener. This preserves **live/replay isolation** but means the spec’s “EventBus where safe” is only partially met.

### Three replay-related engines (do not conflate)

| Engine | Path | Uses RiskEngine/OMS? | Role |
|--------|------|----------------------|------|
| **MODE B — Full Argus Replay** | `FullArgusReplayEngine.ts` | **Yes** | Product target for Phase C |
| **HistoricalReplayService** | `HistoricalReplayService.ts` | **No** | Quant-only `BacktestEngine.runStrategyBacktest` — requires symbol |
| **VectorBT / argusStrategyReplay** | research routes | **No** | MODE A research; not promotable spine |

Phase C must extend **MODE B only**.

---

## 3. Answers to the 20 explicit audit questions

### 1. What is reused exactly?

| Component | Reuse type | Grade |
|-----------|------------|-------|
| `RiskEngine.evaluateRisk()` | **Exact singleton** | CODE-VERIFIED |
| `OrderManagementService` | **Exact singleton** (RISK_ASSESSMENT_COMPLETED listener) | CODE-VERIFIED |
| `BrokerManager.getActiveBroker()` | Returns `replay.broker` when session active | CODE-VERIFIED |
| `PositionSizing` | Via RiskEngine (live code path) | CODE-VERIFIED |
| `EvidenceAggregator` + consensus thresholds | Via `PitReplay.replayChiefTraderFromEvidence` | CODE-VERIFIED |
| `tradingSafety.json` | Consensus 0.75, min-2 agents, gate thresholds (replay overrides some gate semantics) | CODE-VERIFIED |
| `RSIEngine` | Direct call in replay loop | CODE-VERIFIED |
| `replayArgusStrategy()` | Quant strategy evaluation on PIT bars | CODE-VERIFIED |
| `evaluateThesisInvalidation()` | Real function + `checkThesisInvalidation()` wrapper | CODE-VERIFIED |
| `evaluateExit()` (ExitIntelligenceEngine) | Real function, PIT bars | CODE-VERIFIED |
| `InformationCutoff` / `ReplayClock` | Exact classes | CODE-VERIFIED |
| `HistoricalReplayBroker` | Replay-only adapter (not live broker) | CODE-VERIFIED |

### 2. What is currently duplicated?

| Area | Live module | Replay implementation | Divergence risk |
|------|-------------|----------------------|-----------------|
| Discovery | `OpportunityDiscovery`, `OpportunityScreener`, `MarketUniverseScanner` | `HistoricalUniverseProvider.screenHistoricalCandidates` | **High** — live changes won’t propagate |
| Consensus orchestration | `ChiefTraderAgent` + EventBus | `PitReplay.replayChiefTraderFromEvidence` | **Medium** — math shared, debate/TTL not |
| Technical ideas | `TechnicalAgent` full loop | RSI-only + synthetic confidence in idea list | **Medium** |
| Quant ideas | `QuantSignalAgent` live timer | `replayArgusStrategy` per bar | **Medium** |
| Exit orchestration | `PortfolioMonitor` timer loop | Inline exit block in `processTimestamp()` | **Low–Medium** — calls same exit/thesis functions where wired |
| Market data feed | `MarketDataWorker` | Replay sets `cacheObservedQuote` + PIT bars | **Low** — intentional adapter |

**No duplicate** `SimulationRiskEngine`, `SimulationOMS`, or second `placeOrder` production path — **CODE-VERIFIED** (`architecture.protection.test.ts`, `phase21.invariants.test.ts`).

### 3. What must be adapted?

| Adapter | Purpose | Priority |
|---------|---------|----------|
| `HistoricalMarketDataAdapter` (conceptual) | Feed PIT bars to shared discovery/screener interfaces | P1 |
| `HistoricalUniverseAdapter` | Point-in-time tradable set (honest survivorship limits) | P1 |
| `HistoricalOpportunityContext` | Replace `MarketDataWorker`/`Date.now()` in discovery gates | P1 |
| `ExitEvaluationContext` | Already partially done via PIT `visible` bars passed to production exit functions | P2 |
| Replay-safe EventBus **tap** (optional) | Emit replay events to isolated bus or session log only — not live bus | P3 |

### 4. What cannot be historically reproduced?

| Input | Status | Honest label |
|-------|--------|--------------|
| LLM ChiefTrader debate | **UNAVAILABLE** | `CONSENSUS_MATH_REPLAY`; `aiMode: DISABLED` default |
| Point-in-time fundamentals | **UNAVAILABLE** | `FundamentalAgent: UNAVAILABLE` in `agentAvailability` |
| Point-in-time macro | **UNAVAILABLE** | `MacroAgent: UNAVAILABLE` |
| Historical news corpus (general) | **UNAVAILABLE** except golden fixture | `NewsAgent: CATALYST_ONLY` or UNAVAILABLE |
| Kronos Chronos forecasts at T | **UNKNOWN / likely UNAVAILABLE** | Not wired in replay loop |
| True historical index membership / delisted names | **UNAVAILABLE** with current data | Static curated pool |
| Historical L2 / spread reconstruction | **UNAVAILABLE** | Spread model from config bps only |
| Organic paper / LIVE broker fills | **N/A — forbidden** | Isolation enforced |

### 5. Where can look-ahead occur?

| Vector | Mitigation | Grade |
|--------|------------|-------|
| Bar access at decision time | `timestamp < t` filters; `InformationCutoff.assertNotFuture` | TEST-VERIFIED |
| Discovery volume spike “tomorrow” | `screenHistoricalCandidates` uses `timestamp < t` only | TEST-VERIFIED (`HistoricalUniverseProvider.test.ts`) |
| Missed-opportunity analysis | Post-run only; uses full bar series **after** terminal status | CODE-VERIFIED |
| Benchmark SPY fetch after run | Uses historical provider for date range — not decision loop | CODE-VERIFIED |
| `marketDataWorker.cacheObservedQuote` during replay | Sets quote at simulated T — could affect live if concurrent run | **RISK**: single process should not run live + replay concurrently |
| Alpaca `fetchTradableAssets` in live scanner | **Not in replay clock** | N/A today |

### 6. What is the true historical universe?

**CODE-VERIFIED methodology:**

1. **Candidate pool:** `config/replaySafety.json` → `historicalDiscoveryUniverse` (~30 liquid large-cap / ETF symbols). Human-curated **today’s** names.
2. **Per timestamp T (ARGUS_DISCOVERY):** `screenHistoricalCandidates()` ranks by trailing avg dollar volume using bars with `timestamp < T`, min volume floor, max 8 active names, rescan every 5 bars.
3. **Evaluation set:** `activeDiscoveredSymbols ∪ openStops.keys()` (held positions never dropped).

**Honest limitations (must appear in every report):**

- `historicalUniverseMethodology` — **IMPLEMENTED** in summary JSON
- `dataAvailabilityWarning` / `historicalDiscoveryFidelityWarning` — **IMPLEMENTED**
- `survivorshipBiasWarning` — **IMPLEMENTED** for operator-selected; discovery uses separate fidelity warning
- **NOT** a reconstructed 2015 market listing; delisted names **NOT** represented
- **HISTORICAL FIDELITY: LIMITED** — static pool + PIT screening, not full market reconstruction

### 7. How does discovery work at every historical timestamp?

**CODE-VERIFIED loop** (`FullArgusReplayEngine.ts:615-648`):

```
every processTimestamp(T):
  if universeSource === ARGUS_DISCOVERY:
    every historicalDiscoveryRescanEveryBars (or first tick):
      screened = screenHistoricalCandidates(pool, bars, T, opts)
      activeDiscoveredSymbols = top-N by avg dollar volume (PIT)
      emit DISCOVERY events for newly seen symbols
    evaluationSymbols = activeDiscovered ∪ keys(openStops)
  else:
    evaluationSymbols = config.symbols (fixed at create)
```

**NOT** running: `OpportunityDiscovery`, `OpportunityScreener`, `MarketUniverseScanner` inside replay clock.

### 8. How are held positions managed?

**CODE-VERIFIED:**

- Union with discovery set (`evaluationSymbols` includes `openStops.keys()`)
- Each open position: stop/target, generic TP/SL, `evaluateExit()`, `checkThesisInvalidation()`
- SELL path: `submitThroughRiskAndOms` → RiskEngine → OMS → broker
- End-of-run flatten for open positions (`FullArgusReplayEngine.ts:961-983`)

### 9. How does every BUY reach RiskEngine → OMS → broker?

**CODE-VERIFIED path:**

```
processTimestamp → quant/technical ideas → evidenceFromPitIdeas
  → replayChiefTraderFromEvidence (0.75 / min-2)
  → submitThroughRiskAndOms
      → riskEngine.evaluateRisk({ traceId, ... })
      → OMS on RISK_ASSESSMENT_COMPLETED
      → BrokerManager.getActiveBroker() → session.broker (HistoricalReplayBroker)
      → NEXT_BAR_OPEN fill at bar.open
```

No `emitTradeIdea` / `ChiefTraderAgent` listener on live EventBus.

### 10. How does every SELL reach RiskEngine → OMS → broker?

Same `submitThroughRiskAndOms` for exit-triggered SELLs (stop, target, thesis, exit intelligence, generic, END_OF_REPLAY). **CODE-VERIFIED**.

### 11. Which agents genuinely operate historically?

See **§6 Agent fidelity matrix** below.

### 12. What data providers are available?

| Provider | ID | Availability | Notes |
|----------|-----|--------------|-------|
| Golden fixture | `golden_replay` | TEST-VERIFIED | Deterministic; not real market; used in CI |
| Alpaca warehouse/bars | `alpaca` | CODE-VERIFIED if keys | Fetches per symbol; must load **entire** discovery pool for ARGUS_DISCOVERY |
| Polygon / IBKR / etc. | — | **NOT IMPLEMENTED** | Listed in UI copy as unavailable |

News: `golden_replay_news` fixture only; general historical news **UNAVAILABLE**.

### 13. What survivorship bias exists?

**Real and disclosed.** Replay can only discover among symbols whose bars were loaded. Pool is today’s liquid names. A symbol delisted before end date may be absent entirely. Reports must **never** claim survivorship-free discovery.

### 14. What execution assumptions exist?

| Assumption | Value | Disclosed? |
|------------|-------|------------|
| Fill model | NEXT_BAR_OPEN | Yes (`executionModel`) |
| Slippage/spread | `costProfiles` bps | Yes |
| Commission | per share | Yes |
| Partial fills | `VOLUME_PARTICIPATION_CAPPED` at 10% default | Yes (`partialFillModel`) |
| Market hours | `classifyMarketSession` | Yes |
| Whole shares default | `fractionalShares: false` | Yes |
| No order book depth | Simplified | Yes in `partialFillModelDescription` |

### 15. What reporting already exists?

**In `summary.json` after run:**

- `report` — full performance (`buildReplayPerformance`)
- `decisionFunnel`
- `agentEvaluation`
- `missedOpportunities` + label
- `performanceDiagnostics` (stage wall-clock times)
- `agentAvailability`
- `discoveredSymbols` (discovery mode)
- `historicalUniverseMethodology`, `dataAvailabilityWarning`, `partialFillModel`
- Hashes: `datasetHash`, `configurationHash`, `replayHash`

**Gap vs spec §16 funnel labels:** funnel uses engine counters (`evaluationsAttempted`, `ideasGenerated`, etc.) — not labeled DISCOVERED/ELIGIBLE/ANALYZED exactly as spec prose, but structurally equivalent. **No unique-candidate funnel** — methodology string states this honestly.

### 16. What export already exists?

| Artifact | Format | Grade |
|----------|--------|-------|
| `summary.json`, `configuration.json`, `dataset.json` | JSON | CODE-VERIFIED |
| `trades.json`, `equity_curve.json`, `portfolio_final.json` | JSON | CODE-VERIFIED |
| `rejected_orders.json`, `missed_opportunities.json` | JSON | CODE-VERIFIED |
| `events.jsonl` | JSONL | CODE-VERIFIED |
| `trades.csv`, `equity_curve.csv`, `rejections.csv`, `missed_opportunities.csv` | CSV | CODE-VERIFIED |
| `report.md` | Markdown | CODE-VERIFIED |
| `replay-{id}-export.zip` | ZIP bundle | CODE-VERIFIED |

**Missing vs spec §22:** separate `discovery_events.csv`, `agent_decisions.csv`, `consensus_decisions.csv`, `risk_gate_results.csv`, `performance.csv`, `data_provenance.json` as first-class files (some data exists inside `summary.json` / `events.jsonl` only).

### 17. What tests already exist?

| Test file | Focus | Grade |
|-----------|-------|-------|
| `phase18.fullReplay.test.ts` | Full replay + **ARGUS_DISCOVERY** autonomous mode | TEST-VERIFIED |
| `phase24.historicalReplay.test.ts` | NEXT_BAR_OPEN, look-ahead | TEST-VERIFIED |
| `HistoricalUniverseProvider.test.ts` | PIT discovery, future bar exclusion | TEST-VERIFIED |
| `MissedOpportunityAnalysis.test.ts` | Post-run retrospective isolation | TEST-VERIFIED |
| `replayReport.test.ts` | Funnel + performance math | TEST-VERIFIED |
| `replayExitLogic.test.ts` | Exit helpers | TEST-VERIFIED |
| `thesisInvalidation.replay.test.ts` | Thesis path | TEST-VERIFIED |
| `replayStore.test.ts` | Export / ZIP | TEST-VERIFIED |
| `historicalReplay.test.ts` | InformationCutoff | TEST-VERIFIED |
| `PitReplay.test.ts` | Consensus math | TEST-VERIFIED |

**Missing tests vs spec §29:** RUN-VERIFIED Alpaca autonomous run; export reload validation; risk-gate CSV completeness; CLI replay; concurrent live+replay isolation stress.

### 18. What exact code changes are required?

See **§10 Phased implementation plan** — summary:

- P0: This audit ✅
- P1: Adapter layer to share discovery **rules** with live modules (or document permanent divergence)
- P2: Wire `QuantSignalAgent`/`TechnicalAgent` through historical adapters where safe (optional; high effort)
- P3: API route parity (`/funnel`, `/agents`, `/discovery`, `/export` unified)
- P4: CLI thin client `argus replay --capital --from --to`
- P5: UI rebrand + hide advanced controls behind Developer mode
- P6: Default `universeSourceDefault` → `ARGUS_DISCOVERY` in config
- P7: Alpaca batch ingest for full discovery pool (performance)
- P8: Separate CSVs / `data_provenance.json`; p95 latency stats
- P9: RUN-VERIFIED acceptance run + update stale docs (`ARGUS_REPLAY_USER_GUIDE.md`)

### 19. What are the safety risks?

| Risk | Severity | Mitigation today |
|------|----------|------------------|
| Replay emits on live EventBus | **Critical if occurred** | Not emitted — CODE-VERIFIED |
| Live broker reached from replay | **Critical** | `BrokerManager` returns replay broker; LIVE refused | CODE-VERIFIED |
| Replay while `tradingMode=LIVE` | **Critical** | `createReplayRun` throws | CODE-VERIFIED |
| Organic paper contamination | **High** | REPLAY tags excluded from soak | CODE-VERIFIED |
| Concurrent live trading + replay in one process | **Medium** | `marketDataWorker.cacheObservedQuote` mutation | Document: don’t run together |
| Lowering consensus for “interesting” backtests | **Critical policy** | PitReplay uses real thresholds | CODE-VERIFIED |
| Second trading brain | **Critical** | Architecture tests | TEST-VERIFIED |
| Survivorship honesty failure | **Medium** | Warnings in report — strengthen UI | PARTIAL |

### 20. What is the smallest safe implementation sequence?

**Do not rewrite FullArgusReplayEngine.** Extend:

1. **Defaults & docs** — `ARGUS_DISCOVERY` as default; fix user guide (1 day)
2. **RUN-VERIFIED gate** — one Alpaca autonomous run script + recorded artifact (1–2 days)
3. **API/CLI adapters** — thin HTTP wrappers only (Phase B pattern) (2–3 days)
4. **Discovery adapter design** — extract shared screening interface from `OpportunityDiscovery` + `HistoricalUniverseProvider` (1 week, careful)
5. **Export completeness** — additional CSVs from existing session data (2–3 days)
6. **UI product polish** — rename, collapse advanced fields (2–3 days)

---

## 4. Agent historical fidelity matrix

| Agent | Classification | Historical source | PIT safe? | In consensus? | Notes |
|-------|----------------|-------------------|-----------|-----------------|-------|
| **QuantEngine** | **PARTIALLY HISTORICAL** | `replayArgusStrategy()` on PIT bars | Yes | Yes | Not live `QuantSignalAgent` timer |
| **TechnicalAgent** | **PARTIALLY HISTORICAL** | `RSIEngine` only | Yes | Yes (synthetic conf in idea list) | Not full MACD/BB live agent |
| **ChiefTrader** | **CONSENSUS_MATH_REPLAY** | `PitReplay` + `EvidenceAggregator` | Yes | N/A | No LLM debate; 0.75 / min-2 enforced |
| **NewsAgent** | **UNAVAILABLE** (or fixture) | `golden_replay_news` only | Fixture only | No real voter | Honest `agentAvailability` |
| **FundamentalAgent** | **UNAVAILABLE** | — | — | No | |
| **MacroAgent** | **UNAVAILABLE** | — | — | No | |
| **KronosForecastAgent** | **UNAVAILABLE** | Not called in replay | — | No | UNKNOWN if Chronos could be adapted |
| **OpportunityDiscovery** | **NOT IN REPLAY** | Separate screen | PIT screen only | N/A | Parallel implementation |
| **PortfolioMonitor** | **ADAPTED INLINE** | Exit block in replay | Yes | SELL ideas via exits | Not live timer |
| **ExitIntelligenceEngine** | **FULLY HISTORICAL** (deterministic) | `evaluateExit()` | Yes | Triggers SELL | |
| **ThesisInvalidation** | **FULLY HISTORICAL** | `evaluateThesisInvalidation()` | Yes | Triggers SELL | Requires thesis at entry |
| **RiskEngine** | **FULLY HISTORICAL** | Real gates + replay overrides | Yes | N/A | Some gates skipped/adjusted in replay |
| **AI / LLM debate** | **UNAVAILABLE** | — | — | No | `aiMode` default DISABLED |

**RiskEngine replay adjustments (CODE-VERIFIED):** `emergency_stop` uses replay session; `order_rate_limit` skipped; `data_freshness` passes; `duplicate_signal` skipped; daily loss uses replay config caps.

---

## 5. Discovery — live vs replay

### Live path (not in replay clock)

```
MarketDataWorker → OpportunityDiscovery (watchlist subscribe only, no ideas)
                 → OpportunityScreener (optional one-vote ideas, flag-gated)
                 → MarketUniverseScanner (broad universe, flag-gated)
```

### Replay path (current)

```
Static pool (historicalDiscoveryUniverse)
  → load all symbol bars at create (expensive for Alpaca)
  → screenHistoricalCandidates(T) on rescan cadence
  → evaluateSymbols = active ∪ openPositions
```

### Safest convergence design (recommended P1)

```
interface UniverseProvider {
  candidatesAt(clock: ReplayClock, cutoff: InformationCutoff): string[];
}

LiveUniverseProvider → MarketUniverseScanner + seed lists
ReplayUniverseProvider → screenHistoricalCandidates (or shared ranker)
```

Extract **ranking math** into shared pure functions; keep I/O separate. If literal reuse proves unsafe, **document divergence** in `agentAvailability.Discovery.reason` (already partially done).

---

## 6. Exit behavior — live vs replay (re-verified)

| Live path (`PortfolioMonitor`) | Replay reachable? | Grade |
|--------------------------------|-------------------|-------|
| Quant stop | Yes | CODE-VERIFIED |
| Quant target | Yes | CODE-VERIFIED |
| Generic take-profit / hard stop (cost-basis) | Yes | CODE-VERIFIED |
| Thesis invalidation | Yes | CODE-VERIFIED + TEST |
| ExitIntelligenceEngine | Yes | CODE-VERIFIED |
| Quant-aware trailing-stop backstop | **No** | Live label is cost-basis; replay matches live honesty |
| Peak trailing (ATR/peak) | **No** | Not in live PortfolioMonitor as true peak trail |

**Older audit claim “only 2 of 8 exits” is obsolete** — current code has 5+ production-linked paths.

---

## 7. API, CLI, UI, headless

### API (existing — `researchRoutes.ts`)

| Method | Path | Status |
|--------|------|--------|
| POST | `/api/v2/research/replay/create` | CODE-VERIFIED |
| POST | `/api/v2/research/replay/:id/start` | CODE-VERIFIED |
| GET | `/api/v2/research/replay/:id` | CODE-VERIFIED |
| GET | `/api/v2/research/replay/:id/report` | Partial (report in GET :id) |
| GET | `/api/v2/research/replay/:id/trades` | CODE-VERIFIED |
| GET | `/api/v2/research/replay/:id/export` | CODE-VERIFIED (json/csv/md/zip) |
| GET | `/api/v2/research/replay/:id/events` | CODE-VERIFIED |

**Missing vs spec §28:** dedicated `/funnel`, `/agents`, `/discovery`, `/missed-opportunities` GET routes (data is inside summary).

### CLI

Phase B established `scripts/argus-cli.ts` as HTTP client. **`argus replay` NOT IMPLEMENTED** — should call same API (Phase C P7).

### Headless

Replay runs server-side without browser — **CODE-VERIFIED**. No Vite required. UI optional.

### UI gaps

- Still shows many “advanced” fields in normal flow (strategy, AI mode, speed, allocation)
- Fixed universe labeled “Advanced” but not “Developer/Diagnostic Mode”
- Product title still “Historical Replay Lab”
- User guide (`docs/ARGUS_REPLAY_USER_GUIDE.md`) **stale** — claims discovery doesn’t run

---

## 8. Live safety & isolation checklist

| Invariant | Status | Grade |
|-----------|--------|-------|
| Refuses LIVE trading mode | Yes | CODE-VERIFIED |
| Never uses live broker | Yes | CODE-VERIFIED |
| Never emits replay on live EventBus | Yes | CODE-VERIFIED |
| REPLAY fills tagged / excluded from organic soak | Yes | CODE-VERIFIED |
| No bypass of RiskEngine/OMS | Yes | CODE-VERIFIED |
| PAPER_TRADING_ONLY / LIVE_NO_GO unchanged | Yes | N/A for replay |
| Consensus not lowered | Yes | CODE-VERIFIED |

---

## 9. Reproducibility

| Hash | Implemented | Grade |
|------|-------------|-------|
| `datasetHash` | Yes | TEST-VERIFIED |
| `configurationHash` | Yes | TEST-VERIFIED |
| `replayHash` | Yes | TEST-VERIFIED |
| Code/build version in export | Partial (`replayEngineVersion` in events) | PARTIAL |

---

## 10. Phased implementation plan (Phase C work — post-audit)

| Phase | Scope | Already done? |
|-------|-------|---------------|
| **P0** | Forensic audit (this document) | ✅ |
| **P1** | Discovery adapter / shared ranker OR formal permanent divergence doc + tests | **Partial** — screen exists; live reuse no |
| **P2** | Full BUY/SELL path hardening | **Mostly done** — verify RUN on Alpaca |
| **P3** | Decision funnel + agent eval + audit trail | **Done** — extend CSV/trace joins |
| **P4** | Missed-opportunity analysis | **Done** — extend to risk rejections? |
| **P5** | Performance/latency diagnostics | **Partial** — add p95, per-agent timing |
| **P6** | Complete export bundle | **Mostly done** — add missing CSV kinds |
| **P7** | CLI/API integration | **API partial; CLI missing** |
| **P8** | UI redesign (“Argus Historical Evaluation”) | **Partial** — discovery default yes |
| **P9** | Full verification + RUN-VERIFIED acceptance | **NOT VERIFIED** |

---

## 11. Stop conditions (unchanged — do not proceed if)

- Live EventBus would receive replay trade ideas
- RiskEngine or OMS bypass required
- Consensus thresholds would be lowered to “get trades”
- Fabricated historical news/fundamentals/LLM votes required
- Second trading brain appears necessary

**Current codebase does not require stop** — it requires **honest extension**.

---

## 12. Final acceptance criteria — current scorecard

> “I gave Argus capital + date range, no symbols, and Argus autonomously …”

| Criterion | Status |
|-----------|--------|
| No symbols required | TEST-VERIFIED (golden fixture) |
| Autonomous discovery | TEST-VERIFIED (static pool + PIT screen) |
| Real consensus/risk/OMS/broker path | CODE-VERIFIED |
| Held positions never orphaned | CODE-VERIFIED |
| Every decision recorded | PARTIAL (events.jsonl + traces; not one joined row) |
| Performance + diagnostics | IMPLEMENTED (partial p95) |
| Survivorship/limitations disclosed | IMPLEMENTED |
| Complete export | MOSTLY (ZIP exists; not every CSV kind) |
| No live impact | CODE-VERIFIED |
| **RUN-VERIFIED on real Alpaca historical period** | **NOT VERIFIED** ← **acceptance blocker** |

---

## 13. Recommended first implementation steps (after audit approval)

1. Add `scripts/run-autonomous-replay-acceptance.ts` — Alpaca + ARGUS_DISCOVERY + capital/dates only; archive RUN-VERIFIED artifact under `data/replays/`
2. Change `replaySafety.universeSourceDefault` to `ARGUS_DISCOVERY`; align `defaultReplayConfig()`
3. Extend `argus-cli.ts` with `replay create/start/status/export` subcommands (HTTP only)
4. Update `docs/ARGUS_REPLAY_USER_GUIDE.md` and UI title copy
5. Add GET routes for funnel/agents/discovery or document `summary.json` as canonical
6. P1 spike: extract shared `rankCandidatesByDollarVolume(bars, t)` used by both HistoricalUniverseProvider and OpportunityScreener ranking (if feasible)

---

## 14. Related documents

| Document | Status |
|----------|--------|
| `ARGUS_ARCHITECTURE_CONTRACT.md` | Binding — replay isolated |
| `ARGUS_HEADLESS_ARCHITECTURE.md` | CLI adapter pattern for replay |
| `ARGUS_HISTORICAL_REPLAY_FORENSIC_AUDIT.md` | **Partially stale** — use this Phase C audit |
| `ARGUS_FULL_SYSTEM_HISTORICAL_SIMULATION_AUDIT.md` | **Stale** — pre-ARGUS_DISCOVERY enhancements |
| `ARGUS_REPLAY_CONTEXT.md` | Context for operators |

---

**Phase C implementation must not begin until operator reviews this audit.** The highest-value next step is a **RUN-VERIFIED** autonomous Alpaca evaluation, not a rewrite of the replay engine.

---

## 15. Phase C implementation evidence (2026-08-20)

**Status:** Implementation complete — see `ARGUS_PHASE_C_HISTORICAL_EVALUATION_FINAL_AUDIT.md`

| Gap (§Executive) | Resolution | Grade |
|------------------|------------|-------|
| Default OPERATOR_SELECTED | `universeSourceDefault: ARGUS_DISCOVERY` + smart `defaultReplayConfig()` | TEST-VERIFIED |
| Live market cache mutation | `HistoricalReplayMarketDataContext` | TEST-VERIFIED |
| Discovery adapter | `replayDiscoveryAdapter.ts` | TEST-VERIFIED |
| Technical RSI-only | `replayTechnicalEvaluation.ts` (RSI/MACD/SMA/BB) | CODE-VERIFIED |
| CLI `argus replay` | `scripts/argus-cli.ts` | CODE-VERIFIED |
| API historical-evaluations | `researchRoutes.ts` aliases | CODE-VERIFIED |
| UI branding | Argus Historical Evaluation | CODE-VERIFIED |
| Report honesty | `summary.historicalEvaluation` block | CODE-VERIFIED |
| Alpaca zero-symbol RUN-VERIFIED | `scripts/phase-c-alpaca-discovery-run.ts` fetch failed | **NOT VERIFIED** |
| Live ChiefTrader consensus | Still CONSENSUS_MATH_REPLAY (honest) | CODE-VERIFIED |

Full suite: **1795 tests PASS** · Build: **PASS** · Lint: pre-existing `argus-ecosystem-status.ts` failure only.
