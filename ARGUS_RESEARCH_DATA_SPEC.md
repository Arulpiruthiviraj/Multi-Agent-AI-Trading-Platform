# ARGUS research data spec

## Bar columns (required)

`symbol` (dataset-level) · `timestamp` · `open` · `high` · `low` · `close` · `volume`

Optional: `vwap` · `trade_count` · `bid` · `ask` · `spread` · `market` · `sector` · `benchmark` · `corporate_actions`

## Dataset metadata (required)

`source` · `sourceVersion` · `timezone` · `symbol` · `market` · `frequency` · `adjustmentPolicy` · `missingBarPolicy` · `duplicatePolicy`

Also: `datasetId` · `dataHash` (`sha256:` of canonical JSON) · optional `downloadTimestamp` · `startTimestamp` · `endTimestamp` · `qualityStatus`

## Quality grades

| Grade | Backtest | Paper promotion | Live candidate |
|---|---|---|---|
| GREEN | allowed | allowed (other gates still apply) | never from quality alone |
| YELLOW | allowed | blocked | blocked |
| RED | blocked | blocked | blocked |

Checks: duplicate timestamps, unsorted bars, missing/invalid OHLC, non-positive prices, suspicious volume, missing timezone, Canadian live blocked flag.

## Storage

- SQLite `ohlcv_bars` remains the live/cache table. Do not dump millions of research rows there.
- Research Parquet target: `data/research/{datasetId}.parquet` (gitignored) plus `.meta.json` sidecar when `ARGUS_WRITE_RESEARCH_PARQUET=true`.
- Golden fixture lives in git: `fixtures/research/golden_sma.json`.

## Frequencies

`1m` `5m` `15m` `30m` `1h` `daily` — only where data actually exists. Unfinished candles must not feed closed-bar indicators.

## Look-ahead

Signal at bar T uses information at or before T. Golden SMA executes at **next bar open**. Same-bar close fills are not the default.

## Reproducibility tuple

strategy version + parameter version + dataset hash + engine version + cost model + slippage model + research config hash.
