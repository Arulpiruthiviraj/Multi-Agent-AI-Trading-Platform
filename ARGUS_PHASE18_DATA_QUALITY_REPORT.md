# ARGUS Phase 18 — data quality report

Engine reused: `src/server/research/dataQuality.ts`.

| Dataset | Provenance | Quality | Promotable |
|---|---|---|---|
| `GOLDEN_SMA_DET` | UNIT_FIXTURE | GREEN/YELLOW as bars allow; **not** promotion-grade | NO |
| Production `ohlcv_bars` | UNKNOWN unless tagged | Not scanned as a research warehouse this phase | NO unless imported as REAL_MARKET_DATA with GREEN |
| `data/research/*.parquet` | Empty unless operator imports | N/A | N/A |

Invalid OHLC / duplicates still RED. Canadian live remains blocked at promotion.

**No real multi-year SPY/QQQ/IWM research warehouse was added.** Downloading market data in CI/tests is forbidden. Import path: `POST /api/v2/research/datasets/import` with explicit `provenance`.
