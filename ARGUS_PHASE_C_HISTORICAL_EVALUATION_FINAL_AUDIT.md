# ARGUS Phase C — Historical Evaluation Final Audit

**Date:** 2026-08-20  
**Phase:** C — Historical Evaluation Hardening  
**Baseline:** superseded interim `ARGUS_PHASE_C_HISTORICAL_EVALUATION_AUDIT.md` (now a stub). Lookahead/fill honesty is included here (former `ARGUS_PHASE_C_LOOKAHEAD_AUDIT.md` stub).

## 1. Executive summary

Phase C upgrades MODE B into the **Argus Historical Evaluation** product while preserving **one Argus core**: `FullArgusReplayEngine` → production `RiskEngine` → production `OMS` → `HistoricalReplayBroker`.

Delivered: default `ARGUS_DISCOVERY`, isolated replay market-data cache, discovery adapter layer, expanded technical PIT evaluation, report honesty metadata, CLI/API aliases, UI rebrand, tests, and documentation.

**Real Alpaca zero-symbol discovery run:** **NOT VERIFIED** (`scripts/phase-c-alpaca-discovery-run.ts` — keys present but Alpaca fetch failed in this environment). **Golden fixture ARGUS_DISCOVERY:** **TEST-VERIFIED** (`phase18.fullReplay.test.ts`).

## 2. Files changed (primary)

| File | Change |
|------|--------|
| `config/replaySafety.json` | Default `ARGUS_DISCOVERY`, consensus/fidelity metadata |
| `src/server/replay/ReplayContext.ts` | Smart default universe + empty symbols |
| `src/server/replay/HistoricalReplayMarketDataContext.ts` | **NEW** — isolated quote cache |
| `src/server/replay/replayDiscoveryAdapter.ts` | **NEW** — shared PIT ranker |
| `src/server/replay/replayTechnicalEvaluation.ts` | **NEW** — RSI/MACD/SMA/BB on PIT bars |
| `src/server/replay/HistoricalEvaluationService.ts` | **NEW** — thin facade |
| `src/server/replay/FullArgusReplayEngine.ts` | Isolation, technical eval, report metadata |
| `src/server/replay/HistoricalUniverseProvider.ts` | Delegates to adapter |
| `src/server/routes/researchRoutes.ts` | `/api/v2/historical-evaluations/*` |
| `scripts/argus-cli.ts` | `replay` subcommands |
| `src/components/HistoricalReplayLab.tsx` | Rebrand + disclaimer panel |
| Tests + docs | See §13 |

## 3. Architecture before/after

**Before:** Replay could write live `MarketDataWorker` quotes; default universe `OPERATOR_SELECTED`; UI “Historical Replay Lab”; no historical-evaluations API.

**After:** Same single engine and spine; replay quotes isolated; default discovery-first workflow; product naming and honesty metadata standardized.

## 4. Discovery architecture

```
REPLAY:
  HistoricalMarketDataAdapter (PIT bars in session.barsBySymbol)
    → replayDiscoveryAdapter.rankCandidatesByDollarVolume
    → HistoricalUniverseProvider.screenHistoricalCandidates
    → active candidates per timestamp
```

Live modules are **not** invoked inside the replay clock (by design).

## 5. Replay/core reuse matrix

| Component | Reused | Evidence |
|-----------|--------|----------|
| FullArgusReplayEngine | Yes (only MODE B engine) | CODE-VERIFIED |
| RiskEngine | Yes | phase18 + phase21 |
| OMS | Yes | phase21.invariants |
| HistoricalReplayBroker | Yes | broker tests |
| PositionSizing | Via RiskEngine | CODE-VERIFIED |
| ChiefTrader live agent | No — CONSENSUS_MATH_REPLAY | CODE-VERIFIED |
| Live EventBus | No | architecture.protection |

## 6. Agent fidelity matrix

| Agent | Grade | Notes |
|-------|-------|-------|
| QuantEngine | PARTIAL | TEST-VERIFIED golden path |
| TechnicalAgent | PARTIAL | RSI/MACD/SMA/BB engines on PIT bars |
| NewsAgent | CATALYST_ONLY / UNAVAILABLE | Honest |
| Fundamental/Macro/Kronos | UNAVAILABLE | Not fabricated |
| ExitIntelligence/Thesis | ENABLED | Production functions on PIT bars |

## 7. Consensus fidelity

- **Mode:** `CONSENSUS_MATH_REPLAY`
- **Implementation:** `replayChiefTraderFromEvidence` / `EvidenceAggregator`
- **Not claimed:** live ChiefTrader + LLM debate replay
- **Thresholds:** unchanged 0.75 / min-2 from `tradingSafety.json`

## 8. Risk/OMS verification

- **TEST-VERIFIED:** `phase18.fullReplay.test.ts`, `phase21.invariants.test.ts`
- Replay refused when LIVE
- OMS sole `.placeOrder(` caller unchanged

## 9. Fill model verification

- NEXT_BAR_OPEN, volume participation cap — **TEST-VERIFIED** (existing broker + phase18 tests)

## 10. Look-ahead audit

See §8 (fill model `NEXT_BAR_OPEN`) and `ARGUS_HISTORICAL_EVALUATION.md`. Former standalone lookahead file is a stub.

## 11. Isolation/concurrency audit

- **TEST-VERIFIED:** `replayMarketDataIsolation.test.ts`
- Replay clears isolated cache on start/end
- LIVE mode blocks replay create/start

## 12. CLI/API/UI verification

| Surface | Status |
|---------|--------|
| CLI `argus replay` | CODE-VERIFIED (HTTP-only) |
| API `/api/v2/historical-evaluations` | CODE-VERIFIED |
| UI “Argus Historical Evaluation” | CODE-VERIFIED |
| Symbols not required (discovery default) | TEST-VERIFIED |

## 13. Test results

```
npm test: 281 files, 1795 tests PASS
Targeted replay/architecture/phase21: PASS
New: defaultReplayConfig, replayMarketDataIsolation, replayDiscoveryAdapter, missedOpportunityArchitecture
```

## 14. Build results

```
npm run build: PASS
```

## 15. Lint results

```
npm run lint: FAIL (pre-existing, unrelated)
  scripts/argus-ecosystem-status.ts TS2322
```

Phase C changes: no new lint errors in touched replay files.

## 16. Real-data RUN-VERIFIED evidence

**NOT VERIFIED**

```json
{"step":"check_keys","hasAlpacaKeys":true}
{"result":"NOT VERIFIED","reason":"fetch failed"}
```

Script: `scripts/phase-c-alpaca-discovery-run.ts`  
**TEST-VERIFIED** alternative: golden `ARGUS_DISCOVERY` in `phase18.fullReplay.test.ts` (zero operator symbols, discovery funnel, BUY+SELL through RiskEngine+OMS).

## 17. Known limitations

- Static discovery pool (survivorship bias)
- No historical fundamentals/macro/news/Kronos voters
- CONSENSUS_MATH_REPLAY ≠ live ChiefTrader debate
- Shared SQLite if paper and replay run same process

## 18. Remaining risks

- Alpaca provider network/credentials for operator RUN-VERIFIED runs
- Operator may misread LIMITED fidelity as live parity without reading report panel

## 19. Evidence grades (Definition of Done)

| Item | Grade |
|------|-------|
| Single MODE B engine | CODE-VERIFIED |
| Default ARGUS_DISCOVERY | TEST-VERIFIED |
| Capital+dates without symbols | TEST-VERIFIED |
| RiskEngine/OMS reuse | TEST-VERIFIED |
| Replay isolation | TEST-VERIFIED |
| Report honesty metadata | CODE-VERIFIED |
| CLI/API/UI | CODE-VERIFIED |
| Full test suite | TEST-VERIFIED |
| Build | TEST-VERIFIED |
| Alpaca zero-symbol RUN-VERIFIED | **NOT VERIFIED** |
| Zero look-ahead | **NOT VERIFIED** (mitigations TEST-VERIFIED) |

---

*Historical evaluation under available point-in-time data. Not LIVE. Not organic paper.*
