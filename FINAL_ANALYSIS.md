# Argus Autonomous Trading Platform — FINAL FORENSIC ANALYSIS & READINESS MATRIX

**Audit Date:** 2026-08-17T01:53:00Z (America/Toronto evening 2026-08-16)  
**Auditor role:** Principal Quantitative Systems Auditor / Lead Risk Officer / Adversarial Code Reviewer  
**Method:** Hostile zero-fabrication re-audit — live `tsc` / `vitest` / `build`, read-only `data/argus.db`, filesystem warehouse counts, and source greps. Unit-test green ≠ trading edge.

---

## I. Authoritative Verdict & Header

### Verification Summary (this pass — executed live)

| Command | Exit | Result |
|---|---|---|
| `npx tsc --noEmit` | **0** | Zero type errors |
| `npx vitest run` | **0** | **172** files, **1136** tests passed, **0** failed, ~**167s** |
| `npm run build` | **0** | SPA + `dist/server.cjs` OK; vendor chunks split (`vendor-react`, `vendor-framer`, `vendor-icons`, `vendor-charts`, `vendor-flow`); **no** Rollup large-chunk warnings (`chunkSizeWarningLimit: 2000` in `vite.config.ts`) |

### Core Verdicts

| Verdict | Status |
|---|---|
| **LIVE Autonomous Trading** | **NO-GO** |
| **Paper Trading (Supervised)** | **CONDITIONAL GO** (`settings.trading_mode=PAPER`, `trading_state=TRADING_ENABLED`, Autobot on — but **0 organic closes**) |
| **Empirical Trading Edge** | **NOT ESTABLISHED (0/100)** |
| **Organic Paper Evidence** | **0 / 30 trades** · **0 / 10 sessions** |
| **Canadian Live Routing** | **EXTERNAL_BLOCKED (IIROC 3200A.1(b)(i))** |

### Dual-score snapshot (formula in §II)

| Score | Value |
|---|---|
| Engineering Readiness | **87%** |
| Capital / Trading Validation | **12%** |
| **Blended Real-Money Readiness** \(0.5E + 0.5C\) | **49.5%** |

---

## II. Dual-Scorecard Readiness Breakdown

### 1. Engineering Readiness (weight mix → **87%**)

| Dimension | Weight | Score | Evidence |
|---|---|---|---|
| Software / Compiler / Tests | 15% | **94%** | `tsc` 0; vitest **1136**/172; build clean. UI (`App.tsx`) still thinly unit-tested. |
| Execution Spine & OMS Isolation | 20% | **95%** | `executeAutoBotTradeInSovereign`: **0** matches under `src/`. Production `.placeOrder(` confined to `OrderManagement.ts:347` + broker adapter close/flatten helpers. `BrokerEngine.ts`: **absent**. |
| 24-Gate Risk Ladder & Sizing Honesty | 20% | **94%** | `config/riskGateOrder.json` lists **24** gates; `RiskEngine.ts` `recordGate` always records before first-failure report. `PositionSizing.ts:239-256` flips zero-qty `CLAMPED` → `FAIL`. Fail-closed: `market_hours` clock outage, `data_freshness` null age (`marketDataQuality.ts:23-27`), `invalid_account_equity`, `emergency_stop`. |
| Security, Auth & Secrets Isolation | 15% | **88%** | Ecosystem strips `WALLET_PRIVATE_KEY`/`SOLANA_PRIVATE_KEY` to `""` (`ecosystem-dev.ts:342-344`). Auth/session when `AUTH_PASSWORD` set. Residual: local `.env` keys still operator-managed. |
| Broker Integration & Reconciliation | 15% | **78%** | Alpaca paper path live; `reconciliation_events` **137** rows; `kill_switch_events` **18**. Recurring DIAG `OPEN_ORDER_MISSING_REMOTELY` noise (ghost PENDING DIAG\* orders) — does not currently pause (`trading_state=TRADING_ENABLED`) but pollutes soak telemetry. |
| Data Warehouse & Research Infra | 15% | **82%** | `inspectResearchWarehouse()`: **16** GREEN parquet; **22** sidecars; **6** meta with `parquetBytesWritten:false`. TS↔Python evaluate harness verified (`strategyContextEvaluateParityVerified: true`) but WFO upserts keep `fullStrategyParity: false`. |

\[
E = 0.15(94)+0.20(95)+0.20(94)+0.15(88)+0.15(78)+0.15(82) = 87.0\%
\]

### 2. Capital / Trading Validation (weight mix → **12%**)

| Dimension | Weight | Score | Evidence |
|---|---|---|---|
| Real Market Data & Parquet Durability | 10% | **70%** | 16 physical `.parquet`; baseline requires `parquetBytesWritten: true` + GREEN. Not full multi-year OOS coverage for all symbols. |
| OOS Validation Passes | 20% | **8%** | `data/research/runs/baseline_index.json`: CORE strategies `oosPass: false` (e.g. MOMENTUM `oosTrades: 1` — below `minOosTrades: 30`). |
| WFO Passes | 20% | **5%** | Baseline `wfoStatus: "FRAGILE"` / `walkForwardPass: false` across CORE. |
| 4-Gate Robustness | 15% | **5%** | `monteCarloPass/permutationPass/sensitivityPass/costStressPass` all **false**; `robustnessLabel: "FAILED"`. |
| Organic Closed Paper (≥30) & Expectancy | 25% | **0%** | DB organic count **0** (see §III). Expectancy N/A. |
| Multi-Day Live Soak Stability | 10% | **25%** | Soak operationally resumed (`kill_switch_events` id 18 → `TRADING_ENABLED`); Autobot enabled; **no** organic fills yet; DIAG recon noise ongoing. |

\[
C = 0.10(70)+0.20(8)+0.20(5)+0.15(5)+0.25(0)+0.10(25) = 12.0\%
\]

### 3. Blended Real-Money Readiness

\[
\text{Blended} = 0.5 \times 87\% + 0.5 \times 12\% = \mathbf{49.5\%}
\]

**Interpretation:** Engineering is near production-grade for *paper* operation. Capital evidence is near-zero. **Do not conflate the two.**

---

## III. Empirical Database Forensics (`data/argus.db`, readonly)

**Integrity:** `PRAGMA integrity_check` → `ok`  
**Script:** `npx tsx scripts/_audit_db_forensics.ts` (uses `isOrganicClosedPaper` from `src/server/research/organicPaper.ts`)

### `trades` — 10 rows total

| Slice | Count |
|---|---|
| By status | FILLED **4**, PENDING **6** |
| By side | BUY **9**, SELL **1** |
| By `execution_environment` | `(null)` **6**, `REPLAY` **2**, `EXTERNAL_SYNC` **2**, `PAPER` **0** |

**Row classification (hostile):**
- **6× PENDING DIAG\*** (`DIAGTEST*`, `DIAGPIPE*`, `DIAGORDER*`, `DIAGCHAIN*`) — diagnostic artifacts, not organic.
- **1× FILLED BUY + 1× FILLED SELL AAPL** — `execution_environment=REPLAY`, SELL `profit_loss=-91.05` — **excluded**.
- **2× FILLED BUY NVDA/GLD** — `EXTERNAL_SYNC` (“Imported during manual baseline reconciliation”) — **excluded**.

### Organic paper (authoritative)

```
organic_closed_count: 0
organic_sessions: 0
minPaperTrades: 30
minPaperSessions: 10
note: "No organic PAPER FILLED SELL rows with P&L. Not an edge. Not LIVE_CANDIDATE evidence."
```

Predicate: `organicPaper.ts` / `isOrganicClosedPaper()` — requires FILLED SELL, `execution_environment='PAPER'`, finite P&L, rejects REPLAY / EXTERNAL_SYNC / DIAG / MANUAL_OVERRIDE.

### Other tables

| Table | Rows | Notes |
|---|---|---|
| `fills` | **2** | Physical fill records only |
| `transactions` | **772** | `NO_CONSENSUS` **489**, `RISK_REJECTED` **243**, `OPEN` **40** |
| `risk_assessments` | **214** | Risk path exercised |
| `risk_gate_results` | **2014** | Gate audit trail populated |
| `reconciliation_events` | **137** | Latest: DIAG ORDER/CHAIN missing remotely; `action_taken=null` |
| `kill_switch_events` | **18** | Includes reconciliation pauses + admin resume for Phase 33 soak |

### Settings (live row)

- `trading_mode`: **PAPER**
- `trading_state`: **TRADING_ENABLED**
- `auto_bot_enabled`: **1**
- `selected_broker`: **Alpaca**
- `budget` (Argus allocation): **50000**
- `max_trade_size`: **3000**

---

## IV. Execution Spine & Order Authority

### Live path (unchanged, sacred)

```
EventBus → agents → ChiefTrader → RiskEngine (24 gates) → OMS → BrokerManager → broker.placeOrder
```

### Grep / filesystem (this pass)

| Check | Result |
|---|---|
| `executeAutoBotTradeInSovereign` under `src/` | **0 matches** |
| `BrokerEngine.ts` | **Absent** (no file) |
| Production `placeOrder` callers | `OrderManagement.ts` (sole OMS submit) + `InternalPaperBroker` / `CoinbaseBroker` / `InteractiveBrokersAdapter` / `HistoricalReplayBroker` close/flatten helpers |
| Routes / `App.tsx` / research fabric | **No** broker order authority |

### 5-layer LIVE arming (fail-closed)

| Layer | Mechanism | Location |
|---|---|---|
| 1. Phrase | `confirmLiveTrading === 'ENABLE LIVE TRADING'` | `TradingEngine.ts` ~326–328; `LiveTradingConfirmation.ts:8` |
| 2. In-memory arm | `armLiveTrading` / `isLiveTradingArmed()` | `LiveTradingConfirmation.ts` |
| 3. Dual-flag | `assertBrokerEnvironmentAllowsOrder` — mode vs `paperMode` must agree or **UNKNOWN → no order** | `brokerEnvironment.ts:26-38`; OMS ~304 |
| 4. Alpaca live host | Live host refuse without arm | `AlpacaBroker` + OMS env gate |
| 5. Restart clearance | Arm is process-memory only | Documented in `liveReadinessEngine.ts:77` |

---

## V. RiskEngine 24-Gate & Sizing Honesty

**Catalog (`config/riskGateOrder.json`):** exactly **24** gates:

`emergency_stop`, `autobot_enabled`, `same_symbol_cooldown`, `post_loss_cooldown`, `daily_trade_limit`, `duplicate_signal`, `invalid_account_equity`, `daily_loss`, `consecutive_loss`, `portfolio_drawdown`, `order_rate_limit`, `market_hours`, `data_freshness`, `news_veto`, `price_validity`, `order_notional_cap`, `symbol_concentration`, `open_positions_cap`, `sector_concentration`, `correlation_exposure`, `sufficient_size`, `sell_position_exists` (SELL only), `argus_capital_allocation`, `daily_buy_notional`.

**Unconditional recording:** `RiskEngine.ts` `recordGate` (~200+) emits/persists every gate even after first failure (audit trail in `risk_gate_results`).

**Sizing honesty (`PositionSizing.ts:239-256`):** when `maxQuantity === 0`, gates still marked `passed:true` with `CLAMPED`/`boundQuantity===0` are flipped to `passed:false`, `status:'FAIL'`.

**Fail-closed samples:**
- `market_hours`: clock unavailable → block (`RiskEngine.ts:393-396`)
- `data_freshness`: `priceAgeMs === null` → fail (`marketDataQuality.ts:23-27`; tested in `failureInjectionSuite.test.ts:93`)
- `invalid_account_equity`: null/negative equity fails
- `emergency_stop` / `TRADING_PAUSED`: blocks

---

## VI. Research Warehouse & Parity State

### Warehouse filesystem / inventory

| Metric | Value |
|---|---|
| Physical `.parquet` files | **16** |
| `.meta.json` sidecars | **22** |
| `parquetBytesWritten: true` | **16** |
| `parquetBytesWritten: false` | **6** |
| `inspectResearchWarehouse().greenParquetCount` | **16** |
| `greenRealMarketData` | **true** |

Presence of parquet ≠ OOS/WFO/paper validation.

### Fill-model isolation

| Engine | Model | Promotion |
|---|---|---|
| `canonicalNextBarEngine.ts` | **NEXT_BAR_OPEN** | Only path used for promotion-adjacent research |
| `BacktestEngine.ts` | **SAME_BAR_CLOSE** | Explicitly **non-promotable** (`promotionEngine.ts` rejects `SAME_BAR_CLOSE`) |

### `config/quantWfoGrid.json` (honest parity status)

- `fullStrategyParity`: **false** (WFO upserts must not retune live thresholds)
- `strategyContextEvaluateParityVerified`: **true**
- `parityStatus`: `STRATEGY_CONTEXT_EVALUATE_PARITY_VERIFIED`
- Feature harness: RSI/MACD/DMI/StochRSI/Keltner/BOS/Regime/evaluate scores at 100% in research ports
- `wfoLiveOverlayAuthorized`: **0**
- Baseline `strategyParity` on runs still labels **FEATURE_SUBSET_PARITY** for VectorBT adapters (Python `signal_at` subset ≠ full live `evaluate` on streaming market context)

**Baseline index (`data/research/runs/baseline_index.json`):** `promotable: false`, `live: NO-GO`; CORE strategies fail OOS/WFO/robustness gates as of 2026-08-17T00:11:53Z.

---

## VII. Ecosystem & Multi-Repo Process Isolation

`scripts/ecosystem-dev.ts` (real `npm run dev` entry):

- Spawns **separate OS processes** for Vibe / AutoHedge / OpenAlice / Fincept — **no** source merge into Argus OMS.
- AutoHedge env hard-strips: `WALLET_PRIVATE_KEY: ''`, `SOLANA_PRIVATE_KEY: ''`, `AUTOHEDGE_PAPER_ONLY: 'true'` (lines **342–344**).
- `SIGINT` / `SIGTERM` → `killTracked` (Windows `taskkill /T` tree kill) — lines **92–120**.
- Research fabric adapters (`src/server/research/fabric/*`) are **UNTRUSTED_READONLY**, `canPlaceOrders: false`, PIT look-ahead rejected.

---

## VIII. Gap Decomposition (Remaining Work)

| Gap bucket | Approx. remaining of “100% real-money ready” | Notes |
|---|---|---|
| Remaining **Engineering** work | **~13%** of Engineering (→ ~6.5 pts of blended) | DIAG ghost-order reconciliation hygiene; App chunk / UI tests; finish meta parquet=false sidecars; optional soak UX polish |
| Remaining **Validation & Evidence** | **~88%** of Capital (→ ~44 pts of blended) | 30 organic closes / 10 sessions; OOS≥30 trades; WFO pass; 4 robustness gates; multi-week soak without pause loops |
| **Real calendar time** | **30–60+ trading days** minimum | Organic paper alone is a 30-day soak *floor*; statistical gates need sample density beyond that |

**Blended remaining to ~90% real-money bar:** dominated by capital evidence, not more unit tests.

---

## IX. Actionable Itemized Roadmap

### Phase A — Immediate (paper soak operations) — **this week**

1. Keep `trading_mode=PAPER`; never arm LIVE.
2. Clear or archive lingering DIAG PENDING orders (`DIAGORDER*`, `DIAGCHAIN*`) so reconciliation stops reporting `OPEN_ORDER_MISSING_REMOTELY`.
3. Monitor Mission Control `OrganicPaperSoakTracker` + `GET /api/v2/research/organic-paper` — progress must stay **0/30** until true PAPER SELLs appear.
4. Do **not** count REPLAY / EXTERNAL_SYNC / DIAG rows toward soak.
5. Optional: `npx tsx scripts/ingest_research_warehouse.ts --years 10` for longer WFO windows (Alpaca keys required).

### Phase B — Bounded engineering (1–2 weeks)

1. Failure-injection suite already present (`failureInjectionSuite.test.ts`) — keep green; extend only with fail-closed cases, never bypasses.
2. Multiple-testing ledger already records trials — ensure every WFO/canonical run calls `recordExperimentTrial`.
3. Flush remaining `parquetBytesWritten:false` sidecars via `flushAllGreenParquet`.
4. Keep `quantWfoGrid.fullStrategyParity=false` for upserts even though evaluate harness is verified.

### Phase C — Empirical milestones before **any** manual LIVE arming review

| Gate | Requirement | Current |
|---|---|---|
| Organic paper | ≥30 closed PAPER SELLs, ≥10 sessions, expectancy documented | **0 / 0** |
| OOS | `oosPass` with ≥`minOosTrades` (30) on GREEN REAL_MARKET_DATA NEXT_BAR_OPEN | **FAIL** |
| WFO | `walkForwardPass` / non-FRAGILE median | **FAIL** |
| Robustness | MC + permutation + sensitivity + cost-stress all pass | **FAIL** |
| Parquet + quarantine | GREEN + `parquetBytesWritten` + NEXT_BAR_OPEN | Partial (**16** parquet) |
| Manual LIVE review | Human dual-control + phrase + arm — **after** above | **Forbidden now** |

Until Phase C is empirically green, **LIVE = NO-GO** remains the only honest certificate.

---

## X. What This Audit Explicitly Does *Not* Claim

- Passing **1136** tests does **not** imply edge.
- Research fabric / Fincept / Vibe / AutoHedge packets do **not** place orders.
- TS↔Python evaluate parity on golden fixtures does **not** authorize WFO overlay onto live `quantThresholds.json`.
- `TRADING_ENABLED` + Autobot on does **not** equal soak completion.
- Historical REPLAY P&L (−$91.05) is **not** paper evidence.

---

*End of forensic re-audit. Supersedes prior same-week readiness percentages where they conflict with this pass’s live DB and command evidence.*
