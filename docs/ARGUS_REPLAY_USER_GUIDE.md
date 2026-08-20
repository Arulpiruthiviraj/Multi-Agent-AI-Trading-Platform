# Historical Replay Lab — operator guide

Internal name "MODE B full Argus replay." Runs the real ChiefTrader → RiskEngine → OrderManagementService path against historical bars through an isolated `HistoricalReplayBroker`. Never LIVE, never paper, never touches your real portfolio. See `ARGUS_FULL_SYSTEM_HISTORICAL_SIMULATION_AUDIT.md` for what it does and does not cover (short version: BUY side is real; discovery does not run; SELL/exit only checks STOP/TARGET, not the full live exit chain).

## Where it is

Desktop UI → **Evaluation** tab → top panel, "Historical Replay Lab." (`src/components/HistoricalReplayLab.tsx`, mounted in `App.tsx` under `activeTab === "evaluation"`.)

## The one setting most likely to trip you up

**`dataProvider` defaults to `golden_replay`**, which is a small deterministic *test fixture*, not real market history. If you want real historical prices, you must explicitly switch it to **`alpaca`** (uses your existing Alpaca API keys, already configured). `GET /api/v2/research/replay/providers` lists what's actually registered — check that before assuming which one you're getting.

## Form fields (with the shipped defaults)

| Field | Default | What it does |
|---|---|---|
| `startDate` / `endDate` | `2024-01-02` / `2024-06-28` | Historical window, `YYYY-MM-DD` |
| `startTime` / `endTime` | `09:30:00` / `16:00:00` | Session window each day |
| `symbols` | `AAPL` | Comma-separated — this is your **entire fixed universe**; nothing gets added mid-run |
| `frequency` | `1Day` | Bar size — daily bars are cheapest to fetch/run; intraday (e.g. `1Min`) will be far slower and heavier on Alpaca's API |
| `dataProvider` | `golden_replay` | Switch to `alpaca` for real data (see above) |
| `initialCapital` | `100000` | Starting simulated cash |
| `allocationBudget` | `3000` | Also sent as `maxPositionSize` — caps per-position sizing, same role as `settings.maxTradeSize` in live trading |
| `costProfile` | `Base` | Slippage/spread/commission profile from `replaySafety.json` |
| `aiMode` | `DISABLED` | Deliberately off — replay does not fabricate a historical LLM debate (see CLAUDE.md); consensus math is real, the LLM voice isn't |
| `strategyIds` | `MOMENTUM_BREAKOUT` | Which quant strategies are eligible to fire |
| `shortSelling` / `fractionalShares` / `extendedHours` | all `false` | Match live defaults unless you specifically want to test otherwise |
| `speed` | `MAX` | Runs as fast as the machine can process bars, not wall-clock real time |

## Running one (UI)

1. Set your symbols, date range, `dataProvider: alpaca`, and capital.
2. Click **Load/Validate** first — it hits `/research/datasets/download` per symbol and shows data quality before you commit to a full run.
3. Click **Create & Start**. It polls every 750ms until the run reaches a terminal status (`COMPLETED`/`PARTIAL`/`FAILED`/`CANCELLED`/`DATA_UNAVAILABLE`) and a performance report is attached.
4. Read the trades table, event feed (last 80 events), and equity curve directly in the panel. Use **Export** for the full JSON.

## Running one (API — scriptable)

```bash
# 1. optional: check data quality for one symbol before committing
curl -s -X POST http://127.0.0.1:3000/api/v2/research/datasets/download \
  -H "Content-Type: application/json" \
  -d '{"provider":"alpaca","symbol":"AAPL","startDate":"2025-01-01","endDate":"2025-03-31","frequency":"1Day"}'

# 2. create the run
curl -s -X POST http://127.0.0.1:3000/api/v2/research/replay/create \
  -H "Content-Type: application/json" \
  -d '{
    "symbols": ["AAPL","QQQ","SPY","NVDA"],
    "startDate": "2025-01-01",
    "endDate": "2025-03-31",
    "startTime": "09:30:00",
    "endTime": "16:00:00",
    "frequency": "1Day",
    "dataProvider": "alpaca",
    "initialCapital": 2000,
    "allocationBudget": 500,
    "maxPositionSize": 500,
    "costProfile": "Base",
    "aiMode": "DISABLED",
    "strategyIds": ["MOMENTUM_BREAKOUT"],
    "randomSeed": 1
  }'
# → returns { replayId, ... }

# 3. start it (async so it doesn't block the request)
curl -s -X POST "http://127.0.0.1:3000/api/v2/research/replay/<replayId>/start?async=1"

# 4. poll status until terminal
curl -s http://127.0.0.1:3000/api/v2/research/replay/<replayId>

# 5. read results
curl -s http://127.0.0.1:3000/api/v2/research/replay/<replayId>/trades
curl -s http://127.0.0.1:3000/api/v2/research/replay/<replayId>/events
curl -s http://127.0.0.1:3000/api/v2/research/replay/<replayId>/equity
curl -s http://127.0.0.1:3000/api/v2/research/replay/<replayId>/report
curl -s http://127.0.0.1:3000/api/v2/research/replay/<replayId>/export   # full dump
```

Other controls: `POST /:id/pause`, `/:id/resume`, `/:id/stop`, `/:id/step` (advance exactly one bar — useful for manually watching a specific decision unfold).

## Rate limiting

`replayLabLimiter` guards `create`/`start`/`pause`/`resume`/`stop`/`step`. If you get HTTP 429 (`REPLAY_LAB_RATE_LIMIT`), the response includes `Retry-After`; back off a few minutes rather than retrying immediately.

## Reading the results honestly

- Every replay trade lands in the real `trades`/`risk_assessments`/`fills` tables tagged `execution_environment='REPLAY'` — it will never count toward your organic 30-day soak, and it will never appear as a live/paper position.
- `datasetHash` / `configurationHash` / `replayHash` are in the run record — same inputs reproduce the same result; keep these if you want to cite a specific run later.
- **Treat SELL results with caution.** The exit logic only checks stop/target price bands against each bar's low/high — it does not exercise thesis invalidation, trailing stops, generic take-profit, or `ExitIntelligenceEngine`. A replay's exit timing and win rate are not representative of what live PortfolioMonitor would actually do.
- **The universe never expands.** Whatever you type into `symbols` is the entire tradable set for the whole run — this tool cannot currently tell you what Argus would have *discovered*, only how it would have traded a list you already chose.
- A losing or trade-free replay is a valid, useful result — it tells you something real about the consensus/risk funnel. Don't read a profitable replay as evidence of future live profitability (CLAUDE.md's own rule, unchanged here).
