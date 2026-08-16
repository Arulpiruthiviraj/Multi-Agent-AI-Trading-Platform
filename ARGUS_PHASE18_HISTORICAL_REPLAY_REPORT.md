# ARGUS Phase 18 — Historical Replay / Digital-Twin Lab

## Architecture

MODE A remains VectorBT research (`VectorBTService`, `canPlaceOrders: false`).
MODE B is full Argus replay: Historical clock + `HistoricalReplayBroker` replace wall-clock / live broker. Quant `evaluate()`, ChiefTrader vote math (`EvidenceAggregator`), **RiskEngine**, and **OMS** are reused. Replay does **not** emit `TRADE_IDEA_GENERATED` on the live EventBus (that would mix live agents).

```
Historical bars (PIT prefix < T)
  → Quant / Technical (RSI on visible bars)
  → ChiefTrader vote math (debate not invented)
  → RiskEngine.evaluateRisk
  → OMS.executeOrder
  → HistoricalReplayBroker (NEXT_BAR_OPEN + costs)
```

LIVE is not enabled. Replay cannot set VALIDATED / LIVE_CANDIDATE.

## Data providers

Registry: `alpaca` (keys required; warehouse TFs `1Min`/`5Min`/`15Min`/`1Hour`/`1Day` plus aliases; **`30m` is honest `DATA_UNAVAILABLE`**), `golden_replay` UNIT_FIXTURE, `polygon` / `twelvedata` / `alphavantage` / `ibkr` → `DATA_PROVIDER_UNAVAILABLE` (no fake bars).

News: golden fixture or `HISTORICAL_NEWS_UNAVAILABLE`. Not today's News API.

## Golden schedule (path correctness only)

`golden_replay` uses a UNIT_FIXTURE BUY@65 / SELL@74 schedule with Chief-passable confidence so RiskEngine→OMS→`HistoricalReplayBroker` is exercised end-to-end. This is **not** REAL_MARKET_DATA edge and does not change promotion / LIVE / organic paper.

OMS treats broker id `historical_replay` as paper-sim (`executionEnvironment=REPLAY`) without requiring a `brokerConnections` row.

## Look-ahead

`ReplayClock` + `InformationCutoff`. Visible bars have `timestamp < T`. Fill uses bar **open at T** (NEXT_BAR_OPEN). Future news filtered. Correlation closes come from PIT bars during replay, not live Alpaca backfill.

## Execution / costs

`config/replaySafety.json` cost profiles Optimistic / Base / Conservative. Base has non-zero commission, spread, slippage. Gross vs net reported separately. Sharpe withheld below `minSharpeTrades`.

## Organic paper

`executionEnvironment=REPLAY` and broker id `historical_replay` are excluded from organic paper. RiskEngine live path ignores replay rows for cooldowns / consecutive losses.

## AI

Default `DISABLED`. `LIVE_MODEL_REPLAY` is labeled `MODEL_REPLAY NOT_HISTORICAL_AI_STATE` and does not invoke LLMs by default (cost + 2026 weights ≠ 2024). `RECORDED_DECISION_REPLAY` requires a PIT ledger.

## UI / API

Historical Replay Lab on Agent Evaluation. APIs under `/api/v2/research/replay/*` and `/api/v2/research/datasets/download`. Packages under `data/replays/{id}/` (gitignored).

## Tests

`src/server/replay/phase18.fullReplay.test.ts` plus existing VectorBT / warehouse / promotion tests.

## Remaining limitations

- Alpaca `30m` is unsupported (`DATA_UNAVAILABLE`); other intraday warehouse TFs require keys.
- Polygon/Twelve/Alpha Vantage/IBKR historical adapters are explicitly unavailable.
- LLM consensus is not reconstructed historically.
- Historical index universes / delisted PIT tapes are warnings, not a constituent database.
- Corporate actions: adjustment policy is recorded; mixed adjusted/unadjusted still grades via data quality, not a full CA engine.
- Replay P&L is not a trading edge. Edge score is unchanged.
- CORE strategies on golden bars alone often fail Chief consensus (low confidence) — schedule is for path tests only.

LIVE: **NO-GO**
