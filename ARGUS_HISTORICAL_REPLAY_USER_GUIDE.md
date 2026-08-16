# ARGUS Historical Replay User Guide

This lab is **HISTORICAL REPLAY / SIMULATION ONLY**. It is **not LIVE**, **not paper**, and **not actual trading**.

## MODE A vs MODE B

- **MODE A — VectorBT strategy research:** parameter sweeps and vectorized analysis. `canPlaceOrders: false`.
- **MODE B — Full Argus replay:** Quant + ChiefTrader math + RiskEngine + OMS + HistoricalReplayBroker.

They are not expected to match. Do not treat VectorBT PnL as Argus PnL.

## Steps

1. Open **Agent Evaluation** → Historical Replay Lab.
2. Set start/end date (and optional session times).
3. Set market/exchange/timezone (`America/New_York` or `America/Toronto`).
4. Enter symbols (comma-separated). Operator-selected lists carry a **survivorship bias warning**.
5. Choose frequency. If the provider cannot supply it, you get `DATA_UNAVAILABLE` — bars are not invented.
6. Choose provider. `golden_replay` is the deterministic UNIT_FIXTURE. `alpaca` needs keys and currently supports **1Day** warehouse ingest. Others show `DATA_PROVIDER_UNAVAILABLE`.
7. Download/validate: quality GREEN/YELLOW/RED. RED cannot run. YELLOW runs as **PARTIAL** and cannot promote.
8. Set initial capital (research), Argus allocation budget, cost profile (Optimistic / Base / Conservative). Base is not zero-cost.
9. AI mode: keep **DISABLED** unless you accept `MODEL_REPLAY NOT_HISTORICAL_AI_STATE`.
10. Click **Start historical replay**. Watch status, quality, hashes, NO_TRADE counts, and the report.
11. Inspect trades/P&L only from the replay report. Gross ≠ net (fees + slippage).
12. Export: `GET /api/v2/research/replay/{id}/export` plus files in `data/replays/{id}/`.
13. Compare VectorBT only as MODE A research. Feature parity is labeled separately (`ENGINE_MATCH` / `PROXY_NOT_FEATURE_PARITY`).
14. Interpret: a profitable replay does **not** mean LIVE-ready. Organic paper and OOS/WFO gates are independent. LIVE stays NO-GO until the promotion engine and a human `ENABLE LIVE TRADING` phrase say otherwise.

## Controls

PAUSE / RESUME / STOP / STEP (speed `STEP`) plus 1x / 10x / 100x / MAX.

## What you will not see invented

Future bars, today's news as 2024 news, LLM “what we would have said in 2022”, S&P membership as a historical universe, or replay fills inside organic paper stats.
