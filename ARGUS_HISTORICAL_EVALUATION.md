# Argus Historical Evaluation

**Product name:** Argus Historical Evaluation (UI title; component file may still be named `HistoricalReplayLab.tsx`)  
**Engine:** `FullArgusReplayEngine` (MODE B — the only replay engine)  
**LIVE:** NO-GO · **Not organic paper**  
**Name philosophy:** [`README.md`](README.md) § Why "ARGUS"? — learning through observation, not proof of edge.

## Purpose

Historical Evaluation runs Argus decision, risk, and execution logic against **point-in-time historical bars** to measure behavior under data that actually exists — without fabricating historical news, fundamentals, macro, or LLM debate.

This is **not** a claim that Argus would have traded identically live. Reports label fidelity **LIMITED** when appropriate.

Learning through observation (see README § Why "ARGUS"?): a completed run is **evidence and diagnosis** — compare predicted vs realized path, locate funnel failures — not proof of LIVE profitability and not an autonomous rewrite of RiskEngine. `ReflectionEngine` may update agent weights / debate prompt text; it does not bypass consensus, gates, or OMS.

## Architecture

```
ONE ARGUS CORE
      |
+-----+-----+-----+
|     |     |     |
LIVE  REPLAY RESEARCH
|     |     |
live  historical  research
adapters adapters  adapters
```

**Replay path (unchanged spine):**

```
HistoricalMarketDataAdapter (PIT bars)
  → agents (Quant partial, Technical partial, others honest UNAVAILABLE)
  → CONSENSUS_MATH_REPLAY (EvidenceAggregator + tradingSafety thresholds)
  → RiskEngine.evaluateRisk()
  → OrderManagementService
  → HistoricalReplayBroker (NEXT_BAR_OPEN)
```

- No second RiskEngine, OMS, or consensus brain.
- No live broker, no live EventBus trade ideas.
- Replay quotes use `HistoricalReplayMarketDataContext` — **never** `MarketDataWorker.cacheObservedQuote`.

## Primary operator workflow

| Input | Default |
|-------|---------|
| Capital | `config/replaySafety.json` `defaultInitialCapital` |
| Start date | required |
| End date | required |
| Universe | **ARGUS_DISCOVERY** (no symbols required) |

Advanced/debug: `OPERATOR_SELECTED` + explicit symbols.

## Discovery

**Default:** `ARGUS_DISCOVERY`

- Static curated pool: `config/replaySafety.json` → `historicalDiscoveryUniverse`
- Point-in-time screen: `replayDiscoveryAdapter.rankCandidatesByDollarVolume` (bars strictly `< T`)
- **Not** live `OpportunityDiscovery` / `OpportunityScreener` / `MarketUniverseScanner` inside the replay clock

**Honesty:** survivorship bias, no delisted universe, no true historical index membership.

## Agent availability (typical)

| Agent | Status | Notes |
|-------|--------|-------|
| QuantEngine | PARTIAL | PIT bars + `replayArgusStrategy` |
| TechnicalAgent | PARTIAL | RSI/MACD/SMA/BB via production engines on PIT bars |
| NewsAgent | CATALYST_ONLY or UNAVAILABLE | Fixture news only when configured |
| FundamentalAgent | UNAVAILABLE | No PIT fundamentals |
| MacroAgent | UNAVAILABLE | No PIT macro |
| Kronos | UNAVAILABLE | No historical forecast store |
| ChiefTrader | CONSENSUS_MATH_REPLAY | Not live EventBus + LLM debate |

**Read this table as a scope boundary, not a partial degradation:** every real historical replay run
evaluates against an explicitly-scoped **QuantEngine + TechnicalAgent** quorum only. FundamentalAgent,
MacroAgent, NewsAgent (outside the golden_replay fixture), and Kronos do not vote — not because they
failed, but because no point-in-time fundamentals/macro/news/forecast ledger exists yet to replay them
against honestly. This means replay's 2-independent-agent consensus bar draws from a structurally
smaller voter pool than a live session, which can legitimately be reached or missed for reasons a live
session wouldn't share. See `docs/audits/BACKTEST_FEATURE_PARITY_AUDIT.md` for the full analysis.

## Consensus

- Mode: `CONSENSUS_MATH_REPLAY`
- Thresholds from `tradingSafety.json`: `consensusApprovalThreshold` (0.75), `minIndependentAgreeingAgents` (2) — **not lowered for replay**
- Implementation: `replayChiefTraderFromEvidence()` in `PitReplay.ts`
- TechnicalAgent replay uses live `technicalSignal.ts` confidence range **[0.55, 0.95]** when a rule independently fires (never mirrors QuantEngine side)
- **AI_DISABLED fidelity:** QuantEngine alone cannot approve (needs ≥2 independent agreeing agents). Approval is reachable when Quant + Technical independently agree with sufficient confidence — not by inventing LLM votes
- **`aiMode` honesty:** `DISABLED` is the real default. `LIVE_MODEL_REPLAY` / `RECORDED_DECISION_REPLAY` are **labeled but unwired** (no PIT LLM corpus; see `aiReplayAvailability.ts` / `replaySafety.aiModeHonestyDescription`). They do not change consensus math today

## Prediction vs outcome evidence (additive)

Each completed run writes `decision_evidence.json` (`argus.historical_decision_evidence.v1`) with:

- Agent votes (side, confidence, weight)
- Consensus math (weighted confidence, independent agents, floors)
- Risk gate snapshots + `rejectionGate` when RiskEngine ran
- Forward return / MFE / MAE — **AFTER-THE-FACT only** (same contract as missed opportunities)

Also mirrored in `summary.json` as `decisionEvidence` / `predictionOutcomeEvidence`. Does **not** auto-tune live weights or thresholds.

## Fill model

- `NEXT_BAR_OPEN`
- Slippage/spread: `costProfiles` in `replaySafety.json`
- Volume cap: `maxVolumeParticipationPct` partial fills

## API

| Method | Path |
|--------|------|
| POST | `/api/v2/historical-evaluations` |
| GET | `/api/v2/historical-evaluations` |
| GET | `/api/v2/historical-evaluations/:id` |
| GET | `/api/v2/historical-evaluations/:id/report` |
| GET | `/api/v2/historical-evaluations/:id/export` |

Legacy replay routes under `/api/v2/research/replay/*` remain compatible.

## CLI

```bash
npm run argus-cli -- replay --capital 2000 --start 2025-01-01 --end 2025-12-31
npm run argus-cli -- replay list
npm run argus-cli -- replay report <runId>
npm run argus-cli -- replay export <runId>
```

CLI is HTTP-only — does not import RiskEngine/OMS/BrokerManager.

## Concurrency

- Replay refused when `tradingMode === LIVE`
- Only one active replay session per process
- Replay market-data cache is isolated from live `MarketDataWorker`

## Service layer

`HistoricalEvaluationService.ts` delegates to `FullArgusReplayEngine` — no duplicated trading logic.

## Determinism

Default `aiMode: DISABLED`. Identical data + config + seed → identical hashes (see `phase18.fullReplay.test.ts`).

## Interpreting results

Every completed run writes `summary.json` with `historicalEvaluation` metadata: fidelity label, warnings, limitations, consensus mode, fill model, agent availability, and decision funnel.

**Do not** treat Historical Evaluation as LIVE readiness or organic paper evidence.
