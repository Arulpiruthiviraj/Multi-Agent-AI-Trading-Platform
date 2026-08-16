# ARGUS_PHASE_24_HISTORICAL_REPLAY_REPORT

**Date:** 2026-08-16  
**Scope:** End-to-end Historical Market Replay / Digital Twin lab (MODE B) — implement, test, verify.  
**Predecessor:** Phase 18 MODE B skeleton (`FullArgusReplayEngine` → RiskEngine → OMS → `HistoricalReplayBroker`).

---

## Safety verdict (unchanged honesty)

| Gate | Verdict |
|------|---------|
| **LIVE** | **NO-GO** |
| **PAPER** | Unchanged from existing organic evidence (still not satisfied by replay) |
| **HISTORICAL REPLAY** | **GO** (golden / UNIT_FIXTURE path operational; live-market data providers remain partial) |
| **TRADING EDGE** | **Unchanged (8/100)** — replay infrastructure is not edge evidence |

Replay profitable or unprofitable outcomes do **not** prove future profitability, LIVE readiness, or strategy promotion.

---

## Implemented

### Exact replay architecture

```
Historical dataset (golden_replay / Alpaca when configured)
        ↓
ReplayClock + InformationCutoff (PIT)
        ↓
FullArgusReplayEngine (bar loop; not a second trading engine)
        ↓
Quant / golden schedule + Technical RSI (PIT bars only)
        ↓
replayChiefTraderFromEvidence (vote math; no live EventBus mix)
        ↓
RiskEngine.evaluateRisk (replay capital/allocation wired)
        ↓
OMS
        ↓
BrokerManager.getActiveBroker() → session.HistoricalReplayBroker
        ↓
Simulated portfolio + events.jsonl + summary package
```

Absolute enforcements:
- Historical Replay → Simulation Broker only (`BrokerManager` prefers `session.broker`)
- Historical Replay ↛ Alpaca / IBKR / Questrade live `placeOrder`
- Fills stamped `executionEnvironment=REPLAY` / ledger `HISTORICAL_REPLAY`
- Organic paper filters exclude REPLAY / BACKTEST
- Promotion remains `UNTESTED` / `canPromoteFromThisReplay: false`
- Canonical fill model: **`NEXT_BAR_OPEN`**

### Exact files changed / added

| Area | Files |
|------|--------|
| Config | `config/replaySafety.json` — capital presets, ZERO_COST_RESEARCH / REALISTIC_COST / CUSTOM_COST, `zeroCostWarning`, `minSortinoTrades` |
| Clock / PIT | `src/server/replay/ReplayContext.ts` — `replayVisibleBars` now `timestamp < t`; trade ledger types |
| Risk | `src/server/engines/RiskEngine.ts` — replay `allocationBudget`, `maxPositionSize`, `maxDailyLoss` |
| Engine | `src/server/replay/FullArgusReplayEngine.ts` — ledger, agent availability, async start, trades/portfolio/equity getters, richer summary |
| Report | `src/server/replay/replayReport.ts` — Sortino, exposure, turnover, per-symbol/strategy, benchmark UNAVAILABLE honesty, zero-cost warning |
| Store | `src/server/replay/replayStore.ts` — JSON/JSONL artifact read, trades/equity CSV export |
| API | `src/server/routes/researchRoutes.ts` — trades/portfolio/equity; export `format=json\|jsonl\|csv`; async start |
| UI | `src/components/HistoricalReplayLab.tsx` — presets, load/validate, pause/resume/step, poll, tables, exports |
| Tests | `src/server/replay/phase24.historicalReplay.test.ts` |
| Demo | `scripts/phase24_demo_replay.ts` |

### Exact APIs

| Method | Path | Role |
|--------|------|------|
| GET | `/api/v2/research/replay/providers` | Provider availability |
| POST | `/api/v2/research/datasets/download` | Load + quality |
| POST | `/api/v2/research/replay/create` | Create run (RED blocks) |
| POST | `/api/v2/research/replay/:id/start` | Sync or `?async=1` |
| POST | `/api/v2/research/replay/:id/pause\|resume\|stop\|step` | Control |
| GET | `/api/v2/research/replay/:id` | Status |
| GET | `/api/v2/research/replay/:id/events` | Event tail |
| GET | `/api/v2/research/replay/:id/trades` | Fill ledger |
| GET | `/api/v2/research/replay/:id/portfolio` | Portfolio snapshot |
| GET | `/api/v2/research/replay/:id/equity` | Equity curve |
| GET | `/api/v2/research/replay/:id/report` | Metrics + agent availability |
| GET | `/api/v2/research/replay/:id/export?format=` | `manifest` \| `json` \| `jsonl` \| `csv` |

### Database

- Reuses existing `replay_runs` (`drizzle/0030_replay_runs.sql`) — no new SQLite for OHLCV.
- Artifacts under `data/replays/{replayId}/`: `configuration.json`, `dataset.json`, `events.jsonl`, `equity_curve.json`, `trades.json`, `rejected_orders.json`, `portfolio_final.json`, `summary.json`.

### UI changes

Research Lab → Historical Replay (`HistoricalReplayLab`):
- Capital presets $100 / $1k / $10k / $100k + custom
- Cost profiles including ZERO_COST_RESEARCH (explicit warning)
- Load/Validate, Run (async poll), Pause / Resume / Step / Stop
- Trades table, equity summary, event timeline, agent availability
- Export links JSON / JSONL / CSV
- Honesty banners; UNAVAILABLE / NO DATA / NOT RUN labels

---

## Tests

| Suite | Result |
|-------|--------|
| **tsc** (`npx tsc --noEmit`) | **PASS** |
| **Vitest replay** `phase18` + `phase24` + `historicalReplay` | **34 passed / 3 files** |
| Look-ahead / PIT | PASS (`replayVisibleBars < t`, future news filtered) |
| NEXT_BAR_OPEN | PASS (fill ≠ decision close) |
| Broker isolation spy | PASS (`placeOrder` on spy Alpaca = 0) |
| $100 whole-share | PASS (0 buys; cash ≥ 0) |
| Zero vs Base costs | PASS |
| Determinism | PASS (identical net PnL + trade sequence) |
| Organic paper / promotion | PASS |

---

## Demonstration (golden UNIT_FIXTURE — not REAL_MARKET_DATA edge)

```
Replay ID:       bac53a87-fb21-49b7-b24a-36bef4152cb1
Dataset:         golden_replay AAPL 1Day (sha256:a230164cbf3fe1c84b8c26fef450638caeffdaac7d8d9253cb1b5ee5d856cb01)
Period:          80 NY-session fixture bars (not live market years)
Symbols:         AAPL
Initial capital: 100000
Final equity:    99908.6854
Net P&L:         -91.3146
Return:          -0.0913%
Trade count:     1 closed (1 BUY + 1 SELL)
Fees:            0.26
Slippage:        2.9224
Execution model: NEXT_BAR_OPEN
LIVE:            NO-GO
Organic paper:   false
Can promote:     false
```

OMS path observed: RiskEngine → OMS → **Argus Historical Replay Simulator** (26 shares).  
This run proves path correctness and accounting consistency. It does **not** prove an edge.

Real multi-year Alpaca/Polygon historical download for operator-selected symbols remains credential/provider dependent. When a provider is missing: **DATA_PROVIDER_UNAVAILABLE** / **UNAVAILABLE** — no fabricated bars.

---

## Hostile verification (source-based)

| # | Question | Answer |
|---|----------|--------|
| 1 | Can historical replay call a real broker? | **No** — `BrokerManager.getActiveBroker()` returns `session.broker` (`HistoricalReplayBroker`) while active; spy test: live `placeOrder` = 0 |
| 2 | Can replay bypass RiskEngine? | **No** — `submitThroughRiskAndOms` → `riskEngine.evaluateRisk` → OMS |
| 3 | Can future bars leak into decisions? | **No** — decision bars `timestamp < t`; cutoff asserts; tests cover |
| 4 | Can future news leak? | **No** — `newsVisibleAt` + golden future news test |
| 5 | Can same-bar fills enter canonical replay? | **No** — fill priced from bar open at T (`nextFillPrice`); labeled NEXT_BAR_OPEN |
| 6 | Can replay count as organic paper? | **No** — `executionEnvironment=REPLAY` excluded |
| 7 | Can replay auto-promote a strategy? | **No** — `canPromoteFromThisReplay: false`; lifecycle stays evidence-derived |
| 8 | Can missing data become fabricated? | **No** — RED blocks; unavailable providers return errors |
| 9 | Can unavailable agents look successful? | **No** — `agentAvailability` marks Fundamental/Macro UNAVAILABLE; News CATALYST_ONLY or UNAVAILABLE |
| 10 | Can replay use today’s system clock for decisions? | **No** — `ReplayClock` / `nowMs` from historical timestamp in RiskEngine when session active |
| 11 | Can $100 buy unaffordable whole share? | **No** — tested; 0 buys; cash stays non-negative |
| 12 | Can costs silently be zero? | **Only** if ZERO_COST_RESEARCH / all-zero profile — warning required in report |
| 13 | Reproducible? | **Yes** for golden fixture — identical hashes + net PnL + trade sequence |
| 14 | Trade → agent/strategy/risk chain? | **Yes** — events + `tradeLedger.traceId` / strategyId; UI timeline |
| 15 | P&L from actual fills? | **Yes** — broker realized PnL deltas → `tradePnls` / report |
| 16 | Exportable? | **Yes** — package files + export endpoints |
| 17 | Arbitrary historical period? | **Yes** when provider returns bars; golden ignores calendar and uses fixture |
| 18 | Multi-stock portfolio? | **Partial** — `symbols[]` supported; golden clones tape; no historical index membership |
| 19 | Survivorship bias identified? | **Yes** — `SURVIVORSHIP_BIAS_WARNING` when `OPERATOR_SELECTED` |
| 20 | REPLAY vs PAPER vs LIVE enforced? | **Yes** — env stamps + organic filters + LIVE refuse while `tradingMode=LIVE` |

---

## Remaining gaps (real)

1. **Live agent fidelity** — MODE B uses PIT strategy/Chief vote math; does not drive the full live EventBus agent timers (News/Fundamental/Macro remain UNAVAILABLE without PIT corpora).
2. **Benchmark overlay** — SPY/QQQ buy-and-hold in MODE B report is **UNAVAILABLE** unless PIT benchmark bars are supplied (field present, not auto-fetched).
3. **Non-Alpaca historical vendors** — polygon / twelvedata / alphavantage / ibkr stay `DATA_PROVIDER_UNAVAILABLE` until credentials + adapters ship.
4. **Historical news APIs** — only golden fixture PIT news; production historical news = EXTERNAL_DEPENDENCY_REQUIRED.
5. **RECORDED_DECISION_REPLAY** — ledger path still empty; mode labeled, does not invent votes.
6. **Universe-as-of** — no historical S&P constituent membership; operator lists carry survivorship warning.
7. **HTML/PDF export** — JSON / JSONL / CSV only.

---

## Do-not-claim checklist

- Does **not** claim Argus has a proven edge from this phase.
- Does **not** claim LIVE ready.
- Does **not** raise TRADING EDGE above **8/100**.
- Does **not** treat golden-fixture P&L as REAL_MARKET_DATA performance.

---

## Continuous loop status

IDENTIFY → IMPLEMENT → TEST → FIX → RETEST completed for feasible Phase 24 product gaps on top of Phase 18.  
**HISTORICAL REPLAY: GO** for the simulation path. **LIVE: NO-GO.**
