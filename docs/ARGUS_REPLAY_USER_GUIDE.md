# Argus Historical Evaluation — operator guide

Product name: **Argus Historical Evaluation** (UI title in `HistoricalReplayLab.tsx`; file name is historical). Internal: MODE B / `FullArgusReplayEngine`.

Runs real ChiefTrader **vote-math** → RiskEngine → OMS against historical bars through isolated `HistoricalReplayBroker`. Never LIVE, never organic paper, never your live/paper portfolio.

Canonical honesty: [`ARGUS_HISTORICAL_EVALUATION.md`](../ARGUS_HISTORICAL_EVALUATION.md). Phase C snapshot: `ARGUS_PHASE_C_HISTORICAL_EVALUATION_FINAL_AUDIT.md`.

## Where it is

Desktop UI → **Evaluation** tab → **Argus Historical Evaluation**.

## Defaults that matter

- **Universe:** `ARGUS_DISCOVERY` (capital + dates; no operator symbol list required). `OPERATOR_SELECTED` is advanced/debug with explicit symbols.
- **`dataProvider`:** UI/API often default `golden_replay` (small **test fixture**, not real history). For real prices switch to **`alpaca`**. `GET /api/v2/research/replay/providers` lists what is registered.
- **`aiMode`:** `DISABLED` — no fabricated historical LLM debate.

## Form fields (typical)

| Field | Notes |
|---|---|
| `startDate` / `endDate` | Required window, `YYYY-MM-DD` |
| Universe | Discovery (default) vs operator-selected symbols |
| `frequency` | `1Day` cheapest; `1Min` heavier on Alpaca |
| `dataProvider` | `golden_replay` vs `alpaca` |
| `initialCapital` / `allocationBudget` | Simulated cash / per-name cap (same *role* as `settings.maxTradeSize`) |
| `costProfile` | `replaySafety.json` |
| `strategyIds` | Quant strategies eligible to fire |
| `speed` | `MAX` = as fast as the machine, not wall clock |

## Running one (UI)

1. Prefer Discovery + dates + capital, or explicit symbols in operator mode. Set `dataProvider: alpaca` if you want real bars.
2. **Load/Validate** (operator-selected) hits dataset download per symbol.
3. **Create & Start**. Poll until terminal status. Export JSON for forensics.

Discovery is a **replay-specific** point-in-time screen over `config/replaySafety.json` `historicalDiscoveryUniverse` — **not** live OpportunityDiscovery inside the replay clock.

## Running one (API / CLI)

Preferred aliases: `/api/v2/historical-evaluations`. Legacy `/api/v2/research/replay/*` remains.

```bash
npm run argus-cli -- replay --capital 2000 --start 2025-01-01 --end 2025-12-31
npm run argus-cli -- replay list
npm run argus-cli -- replay report <runId>
```

CLI is HTTP-only for replay (engine must already be running). See `ARGUS_CLI.md`.

```bash
curl -s -X POST http://127.0.0.1:3000/api/v2/historical-evaluations \
  -H "Content-Type: application/json" \
  -d '{"startDate":"2025-01-01","endDate":"2025-03-31","initialCapital":2000,"dataProvider":"alpaca","aiMode":"DISABLED"}'
```

Operator-selected example: add `"universeSource":"OPERATOR_SELECTED","symbols":["AAPL","NVDA"]`.

Other controls (legacy paths): `POST /:id/pause`, `/:id/resume`, `/:id/stop`, `/:id/step`.

## Rate limiting

`replayLabLimiter` on create/start/pause/resume/stop/step. HTTP 429 `REPLAY_LAB_RATE_LIMIT` includes `Retry-After`.

## Reading results honestly

- Rows tagged `execution_environment='REPLAY'` do **not** count toward organic soak.
- Hashes (`datasetHash` / `configurationHash` / `replayHash`) identify a run; they are not LIVE proof.
- Exits in replay are not a full live PortfolioMonitor chain — treat SELL/win-rate as limited fidelity.
- Discovery universe is a curated PIT screen, not a reconstructed historical listing (survivorship bias).
- A losing or trade-free run is valid evidence. Profitable replay ≠ future live profitability. **LIVE_NO_GO.**
