# Argus evidence-readiness report (post-audit P0)

Date: 2026-08-16

This report does **not** raise LIVE readiness, paper organic evidence, or trading-edge score. Adding tests and stamps is capability, not edge.

---

## 1. Executive summary

Argus can now **prove mismatches and refuse fake paper counts** more honestly. It still **cannot prove a repeatable trading edge**.

| Claim | Evidence |
|---|---|
| LIVE | **NO-GO** (unchanged) |
| Paper plumbing | **CONDITIONAL GO** (unchanged) |
| Trading edge | **8/100** (unchanged; no organic PAPER FILLED SELL P&L sample, no REAL_MARKET_DATA OOS/WFO pass) |
| CORE strategies | **UNTESTED** |
| SMC | **UNVALIDATED** |
| QUANT_ENGINE_ENABLED | still defaults **OFF** |
| RiskEngine gates | **24** (`config/riskGateOrder.json`) |
| Order path | EventBus → ideas → ChiefTrader → RiskEngine → OMS → BrokerManager only |
| `npx tsc --noEmit` | **PASS** |
| `npx vitest run` | **991/991**, **152** files |

Highest-value P0 that was still open: organic paper could not count OMS fills (no `executionEnvironment` column; untagged rows classified `UNKNOWN`). OMS now stamps `executionEnvironment=` on **new** orders. Historical untagged rows remain `UNKNOWN`. That does **not** create paper evidence.

A second P0: `BacktestEngine` remains **SAME_BAR_CLOSE**; canonical research fill remains **NEXT_BAR_OPEN**. Mixing them is now an explicit `ENGINE_MISMATCH` (`EXECUTION_MODEL_VERSION=argus-research-execution-v1`). The mismatch is documented, not hidden.

---

## 2. Files changed (this increment)

- `config/executionModels.json` — version + `SAME_BAR_CLOSE` model
- `src/server/research/executionModel.ts` — version loader + `compareExecutionModels`
- `src/server/research/organicPaper.ts` — stamp, OMS env resolve, empty-honest summary
- `src/server/research/strategySpecs.ts` — `freezeStrategyVersion`, `listStrategySpecIds`
- `src/server/research/strategyEvidence.ts` — matrix carries engine mismatch
- `src/server/research/argusStrategyReplay.ts` — stamps execution model version
- `src/server/engines/backtest/BacktestEngine.ts` — SAME_BAR stamp; not comparable to canonical research
- `src/server/services/OrderManagement.ts` — stamp fill environment on execute
- `src/server/routes/researchRoutes.ts` — organic-paper / execution-models / strategy version
- `src/server/services/TechnicalAgent.ts`, `PortfolioMonitor.ts`, `news/NewsEngine.ts` — UUID traces
- `src/server/research/phase21.invariants.test.ts` — fill-path and promotion invariants
- Dead `executeAutoBotTradeInSovereign` / `server.ts` `placeOrder` already absent (verified)

---

## 3. Architectural changes

None to the live fill contract.

Research/backtest results now carry `executionModel` + `EXECUTION_MODEL_VERSION`. OMS reasoning may include `executionEnvironment=PAPER|LIVE|UNKNOWN`. Shadow portfolio remains ledger-only.

---

## 4. Safety invariants verified (tests)

| Invariant | Status |
|---|---|
| Autobot OFF → `isLiveIdeaGenerationEnabled() === false` | PASS |
| Empty PIT ledger cannot authorize AI BUY | PASS |
| Empty promotion evidence → UNTESTED, LIVE NO-GO | PASS |
| LIVE_CANDIDATE without `manualLiveApproval` → LIVE NO-GO | PASS |
| Production `.placeOrder(` only OMS + `src/brokers/` | PASS |
| `server.ts` has no `.placeOrder(` | PASS |
| VectorBT/Python CLI does not import BrokerManager | PASS |
| `App.tsx` does not call `placeOrder` | PASS |
| Experimental/SMC not in live `evaluateAll()` without env | PASS |
| Risk catalog length 24 | PASS |
| Untagged trades ≠ organic paper | PASS |

These tests protect **invariants**. They do not prove profitability.

---

## 5. Strategy validation improvements

`freezeStrategyVersion('MOMENTUM_BREAKOUT')` produces `MOMENTUM_BREAKOUT-1.0.0-<hash>` from `config/strategySpecs.json` + execution model. Changing config changes the hash. **No strategy is VALIDATED.**

---

## 6. Research data improvements

Unchanged warehouse policy: no fabricated bars; golden SMA remains `UNIT_FIXTURE`. Organic-paper GET returns **empty-honest** metrics when there are no tagged PAPER SELL fills (`invented: false`).

---

## 7. Backtest / OOS / WFO

Canonical research: **NEXT_BAR_OPEN**. `BacktestEngine.run` / `runStrategyBacktest`: **SAME_BAR_CLOSE**, `comparableToCanonicalResearch: false`. Comparison matrix `engineCompare.status = ENGINE_MISMATCH`. Existing golden WFO/permutation remain **fixture capability**, not REAL_MARKET_DATA edge.

---

## 8. Paper validation

Filter still requires `FILLED` + `SELL` + numeric P&L + `executionEnvironment=PAPER` (column or stamped reasoning). REJECTED / BACKTEST / REPLAY / UNKNOWN / test traces excluded. **This audit did not observe organic closed paper trades.** Do not treat InternalPaperBroker ticks in tests as organic evidence.

---

## 9. AI calibration

Unchanged. LLM confidence is not win probability. Empty PIT ledger still cannot authorize AI BUY (`PitReplay.test.ts`).

---

## 10. Risk engine

No gates removed or bypassed. Restricted-live caps remain **ceilings**, not edge. Generic `stopLossAssumptionPct` (5%) was **not** replaced with ATR live sizing (would be a new unvalidated model).

---

## 11. UI honesty

No App.tsx theater rewrite in this increment. Research APIs return `canPlaceOrders: false`, `live: NO-GO`, `UNTESTED` / `UNAVAILABLE` where evidence is empty. `FINAL_ANALYSIS.md` remains the UI truth table for fabricated widgets.

---

## 12. Test results

```
npx tsc --noEmit     PASS
npx vitest run       991 passed / 152 files
```

---

## 13. Remaining work

**P0**

- Collect **organic** paper: Autobot ON, InternalPaper or Alpaca **paper**, OMS-stamped `PAPER`, closed SELL with P&L. Until then paper evidence = empty.
- Do not compare SAME_BAR vs NEXT_BAR PnL for promotion.
- Dual flags (`settings.tradingMode` vs broker `paperMode`) still exist; LIVE remains operator-dangerous if mis-set.

**P1**

- NEXT_BAR_OPEN path inside `BacktestEngine` (or stop using it for promotion).
- REAL_MARKET_DATA warehouse with GREEN quality before any BACKTESTED claim.
- Walk-forward / robustness on that data, persisted per fold.
- Agent calibration with statistically meaningful outcomes (no weight bump on a few wins).
- UI: remaining fabricated Agent Network / dialogue series (`FINAL_ANALYSIS.md`).

**P2**

- Strategy-specific stop models (ATR/structure) only after backtest **and** paper on that version.
- Failure-injection breadth (broker down, WS drop) beyond existing tests.
- Latency/queue metrics; no premature optimization.

---

## 14. Current readiness (evidence-based; not inflated)

Paper plumbing: **CONDITIONAL GO** (path exists; organic sample not established).  
LIVE: **NO-GO**.  
CORE: **UNTESTED**. SMC: **UNVALIDATED**. QUANT default: **OFF**.

---

## 15. Trading edge score

**8 / 100.** Unchanged. No new OOS, WFO, robustness, or organic paper P&L was produced as real-market evidence.

---

## 16. Conditions to reach each lifecycle state

All require `dataProvenance = REAL_MARKET_DATA` except DRAFT. Fixture/golden SMA cannot promote.

| Status | Required evidence (all real, none invented) |
|---|---|
| RESEARCH_READY | GREEN warehouse dataset (symbol, TF, provider, hash, missing/duplicate grades); strategy version frozen |
| BACKTESTED | That dataset + **NEXT_BAR_OPEN** replay; costs/slippage stated; `EXECUTION_MODEL_VERSION` stamped |
| OOS_VALIDATED | Held-out period never used for params; sample ≥ `researchSafety.minOosTrades`; not SAME_BAR mixed in |
| WFO_VALIDATED | ≥ `minWalkForwardWindows` purged/embargoed folds persisted (train/val/test, trades, DD, costs) |
| ROBUSTNESS_VALIDATED | Perturb params/costs/slippage/delay; median not only peak; fragile if only one combo works |
| PAPER_VALIDATED | Organic PAPER FILLED SELL P&L ≥ `minPaperTrades` and `minPaperSessions`; expectancy/DD gates; not test traces |
| LIVE_CANDIDATE | All of the above + risk/broker/data/startup health + not Canadian-blocked |
| MANUAL_LIVE_APPROVED | LIVE_CANDIDATE **plus** explicit human approval. **This codebase must not flip LIVE from research status.** |

---

## 17. Verdict

**PAPER: CONDITIONAL GO**  
Plumbing and fail-closed path exist. Organic paper evidence has **not** been established.

**LIVE: NO-GO**  
Do not enable live trading. Restricted-live caps are not profitability. Canadian automated routing remains unavailable.

If later evidence shows no edge, report **NO EDGE**. If only a narrow parameter island works, report **FRAGILE**. Do not manufacture success.
