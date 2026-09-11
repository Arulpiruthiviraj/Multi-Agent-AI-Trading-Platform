# ARGUS Current Architecture — Forensic Audit (2026-09-09)

Companion documents: `ARGUS_QUANT_ENGINE_FORENSIC_AUDIT.md` (quant detail),
`ARGUS_QUANT_OWNERSHIP_MATRIX_CURRENT.md` (TS/Java authority per calculation),
`ARGUS_JAVA_QUANT_WIRING_AUDIT.md` (bridge trace), `ARGUS_STRATEGY_INVENTORY_AND_STATUS.md`
(every strategy), `ARGUS_TS_JAVA_PARITY_AUDIT.md` (parity forensics),
`ARGUS_QUANT_REMAINING_WORK.md` (prioritized gaps).

Repo state: see the ownership-matrix doc's §Repo State — same commit (`3509e255`), same dirty
working tree, not repeated here.

This document traces the actual live decision pipeline from source, per component, with evidence.
It does not copy `docs/architecture/ARGUS_ARCHITECTURE.md` — that file was not read as a source of
truth for this pass; every row below comes from a source-file citation checked this session or
(marked explicitly) an earlier session's direct verification still considered live.

## Pipeline trace

```text
Alpaca/IBKR market data
    ↓
MarketDataWorker (tick ingestion, MARKET_DATA/MARKET_DATA_UPDATED)
    ↓
Idea agents (TechnicalAgent, NewsEngine, FundamentalAgent, MacroAgent, PortfolioMonitor,
             QuantSignalAgent, KronosForecastAgent, OpportunityDiscovery/Screener)
    ↓ TRADE_IDEA_GENERATED (gateTradeIdea)
ChiefTraderAgent (EvidenceAggregator, consensus math, optional AIRouter debate)
    ↓ CHIEF_APPROVED_IDEA
RiskAgent → RiskEngine (25 gates)
    ↓
OMS → BrokerManager → active broker (ibkr_gateway in this deployment)
```

| Component | File | Responsibility | Runtime status | Authoritative? | Evidence |
|---|---|---|---|---|---|
| MarketDataWorker | `src/server/services/MarketDataWorker.ts` | Tick ingestion, subscription slot management, rescue allocator | Production | Yes | Not re-read this pass; unchanged per prior sessions' verification |
| TechnicalAgent | `src/server/services/TechnicalAgent.ts` | Deterministic RSI/MACD/Bollinger via TS `RSIEngine.ts`/`MACDEngine.ts`/`technicalSignal.ts` — never calls an LLM | Production | **Yes (TS)** | HIGH, VERIFIED — see ownership matrix's Indicators table |
| QuantSignalAgent | `src/server/services/QuantSignalAgent.ts` | Off unless `QUANT_ENGINE_ENABLED=true`. Builds `StrategyContext`, calls TS `evaluateAll(strategyContext)` (line 287), plus `computeInternalEnsembleQualification()` (line 54 import) for the Java-ensemble independence-count path | Production (flag-gated) | **Yes for strategy evaluation (TS)**; Java only feeds the independence-count side-channel | HIGH, VERIFIED this pass — direct grep/read of both call sites |
| Java CORE strategies | `quant-core-java/.../strategy/core/*.java` | Byte-for-decision-logic ports of the 5 CORE strategies, registered in `StrategyRegistry.java`, HTTP-reachable via `POST /api/v1/evaluate` | **Implemented, registered, unreachable from live TS** | **No** | HIGH, VERIFIED — zero callers of `/api/v1/evaluate` anywhere outside the Java side and stale `.claude/worktrees/` copies |
| ChiefTraderAgent | `src/server/services/ChiefTraderAgent.ts` | Consensus math (0.75 bar, min-2-independent-agents), optional AIRouter debate, `loadJavaInstitutionalDebateContext()` folds 3 SHADOW Java engines' output into the debate prompt as **text only** | Production | Yes (Node-only, no Java counterpart per `config/engineOwnership.json`) | MEDIUM, REGISTRY (debate-context wiring itself confirmed via that file's per-engine notes, not re-read in `ChiefTraderAgent.ts` this pass) |
| RiskEngine | `src/server/engines/RiskEngine.ts` | 25 gates, fail-closed | Production | Yes (Node-only) | MEDIUM, REGISTRY — `risk_engine_24_gates: NODE_ONLY, javaAvailable: false` |
| OMS | `src/server/engines/OrderManagementService.ts` (or equivalent) | Sole `.placeOrder(` caller | Production | Yes (Node-only) | MEDIUM, REGISTRY |
| BrokerManager + adapters | `src/brokers/` | Order placement, IBKR/Alpaca/Coinbase/Questrade adapters | Production | Yes (Node-only) — `quant-core-java` has zero broker imports/credentials, verified by source inspection per the registry's own recurring audit note | MEDIUM, REGISTRY |
| QuantCoreBridge | `src/server/services/QuantCoreBridge.ts` | HTTP client from Node to the Java Quant Core process; indicator shadow-parity, institutional-engine fetches, research-strategy fetches | Production (advisory paths only) | N/A — a bridge, not a decision-maker | HIGH, VERIFIED this pass — see the wiring-audit doc |
| Java Quant Core (`QuantCoreServer.java`) | `quant-core-java/.../server/QuantCoreServer.java` | HTTP server exposing `/health`, `/api/v1/ticks`, `/api/v1/indicators/`, `/api/v1/evaluate`, `/api/v1/features/regime/`, 8 `institutional/*` routes | Running as a companion process (`QUANT_JAVA_CORE_ENABLED`) | **Advisory/shadow only** — see ownership matrix | HIGH, VERIFIED this pass — full route table read directly |
| `argusStrategyReplay.ts` | `src/server/research/argusStrategyReplay.ts` | Historical Evaluation (MODE B) — real ChiefTrader/RiskEngine/OMS math against `HistoricalReplayBroker`, strategies via TS `findStrategy()` | Research/replay, isolated from live broker | Yes (TS) — same strategy source as live | HIGH, VERIFIED this pass — `import { findStrategy } from '../quant/strategies/StrategyEngine'` confirmed |
| `BacktestEngine.ts` | `src/server/quant/BacktestEngine.ts` | Lightweight TA-rule backtester, `SAME_BAR_CLOSE`, explicitly non-promotable | Research | Yes (TS) | MEDIUM, REGISTRY |
| `JavaBacktestEngine.java` | `quant-core-java/.../JavaBacktestEngine.java` | Standalone Java backtest engine | **Implemented, unwired** | No — not cross-validated against either Node engine | MEDIUM, REGISTRY (registry's own note: "Do not treat its output as comparable evidence until a parity test exists") |

## Classification key applied above

- **production**: reachable from the live paper-trading path today.
- **research/advisory/shadow**: reachable only from a companion research service, or feeds context/logging with zero decision influence.
- **unreachable**: implemented and registered but no caller exists anywhere in the live or research TS tree (this is the 5 CORE Java strategies' actual status — not "shadow," not "dead code" in the sense of never compiling, but genuinely never invoked outside their own tests).

## What this document does NOT cover (explicitly out of scope / UNVERIFIED this pass)

- Full re-verification of MarketDataWorker, ChiefTraderAgent's consensus math internals, RiskEngine's
  25 gates, OMS, and broker adapters — these were extensively verified in prior sessions this
  conversation (capital-reservation leak fix, watchdog/reliability work, etc.) and are not
  re-derived here; treat their "Yes/Production" status as carried forward, not re-audited from
  scratch this pass.
- Discovery/ranking pipeline detail (`OpportunityDiscovery`, `ComposableRanking`, `MarketUniverseScanner`)
  — out of scope for a quant-engine-focused audit; see CLAUDE.md's own live-path section for that detail.
