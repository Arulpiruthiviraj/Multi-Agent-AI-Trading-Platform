# ARGUS_PAPER_TRADING_EXPERIMENT.md

**Experiment ID:** `ARGUS_PAPER_EXPERIMENT_001`  
**Override:** `ARGUS_PAPER_EXPERIMENT_ID`  
**Status:** HARNESS READY — **NOT STARTED as a continuous organic run in this environment.**

This is a protocol, not a performance claim. `ARGUS_PAPER_TRADING_VALIDATION.md` already showed
this database contains **zero organic closed trades**. Nothing in Phase 16 injected signals, fills,
or market data to manufacture a book.

## What “running the experiment” means

Single Node process (`npm run dev` or `npm run start`), `tradingMode=PAPER`, AutoBot enabled only
if you intend autonomous paper orders, real Alpaca **paper** keys, real market hours.

Required properties (all already exist in code; this experiment must not bypass them):

| Requirement | Where |
|---|---|
| Real market data | `MarketDataWorker` Alpaca WS |
| Real market hours gate | `RiskEngine` Alpaca `/v2/clock` (skips, does not invent, if keys missing) |
| Real paper broker | `AlpacaBroker` paper host or `InternalPaperBroker` |
| Real orders / fills | `OrderManagement` → broker `placeOrder` |
| Real position recon | `PortfolioReconciliation` |
| Real risk ladder | `RiskEngine.evaluateRisk` |
| Real exits | `PortfolioMonitor` |
| Real logging | `event_traces`, `transactions`, `consensus_*`, `risk_assessments`, `trades` |

**Forbidden:** synthetic ticks, forced `TRADE_IDEA_GENERATED`, fake fills, replaying future-aware
LLM prompts as if they were 2019 decisions.

## Trace fields (already persisted — join, don’t duplicate)

Every organic fill should be reconstructable as:

- trade ID (`trades.id`) / signal (`traceId`) / transaction (`transactionId`)
- contributing agents (`consensus_evidence`)
- ChiefTrader decision (`consensus_decisions`)
- risk gates (`risk_gate_results`)
- entry/exit prices, `profitLoss` on SELL
- quant strategy / stop / target / invalidation snapshot when QuantEngine originated the BUY
- reasoning strings on the trade row

MAE/MFE for live paper: `PredictionOutcomeEvaluator` records MFE/MAE on **predictions** at a
1-hour horizon, not on round-trip trades. Round-trip MAE/MFE for paper fills is **not a separate
persisted column today** — do not report it as if it were. Use `profitLoss` + timestamps until a
dedicated fill-path MAE/MFE is built.

## How to read results

```
GET /api/v2/paper-trading/report
```

Response includes `experimentId`. `statisticallyMeaningful` is false below 30 closed FILLED SELLs
(`MIN_TRADES_FOR_PAPER_VALIDATION`). Do not declare an edge from a smaller sample.

## Current evidence

As of Phase 16 close-out, this environment still has no organic paper track record. Starting the
process for an afternoon of development **does not** satisfy this experiment. The next honest
update to this file is a dated note after a continuous multi-session run with `experimentId`
matching the env var, plus the report JSON — not a rewritten conclusion.
