# Argus — Hostile Read-Only Verification Audit

**Date:** 2026-08-16 (updated same day after Phase 18 / 25 + LIVE-arm / OMS-fill shadow work)  
**Role:** Lead Systems Auditor / Quantitative Risk Officer  
**Method:** Source inspection of the live tree (`server.ts`, `src/`, `config/`, `python/argus_research/`, `scripts/`) plus commands run this session. Old markdown claims were not used as evidence.

This document does **not** authorize LIVE. It does **not** invent paper P&L, OOS, or edge.

Companion gap roadmap (planning only): `ARGUS_REAL_MONEY_GAP_ANALYSIS.md`.

---

## Gate 1 — Compiler and test integrity

| Command | Result |
|---|---|
| `npx tsc --noEmit` | **PASS** — exit code 0, zero TypeScript errors |
| `npx vitest run` | **PASS** — **1066** tests, **162** files, 0 failed (vitest 4.1.10, ~115s) |

Tests passing are not a trading edge. They are not organic paper. They are not LIVE readiness.

---

## Gate 2 — Execution and security invariants

### 2.1 Sovereign / shadow ledgers

**`executeAutoBotTradeInSovereign`:** **Deleted.** Repo-wide search: zero matches.

**`BrokerEngine.ts`:** **Deleted** (Phase 25). No dormant `submitOrder` parallel to OMS.

**Shadow ledger (OMS fills only):** `executeAutoBotTradeInShadow` in `server.ts` listens to `ORDER_EXECUTED` with `status=FILLED` after RiskEngine→OMS. It does **not** book on `CHIEF_APPROVED_IDEA`. Replay/backtest/simulation environments and `replay-` traces are skipped. Still **not** organic paper / not broker P&L.

### 2.2 `placeOrder` isolation

Production TypeScript (excluding `*.test.ts`):

- **OMS** `src/server/services/OrderManagement.ts` — `activeBroker.placeOrder(...)` after RiskEngine `RISK_ASSESSMENT_COMPLETED`.
- **Broker adapters only:** `AlpacaBroker`, `InternalPaperBroker`, `InteractiveBrokersAdapter`, `CoinbaseBroker`, `QuestradeBroker` (throws), `HistoricalReplayBroker` (replay session only via `BrokerManager.getActiveBroker()`).
- **`server.ts`:** no `.placeOrder(`.
- **`src/server/routes/`:** no `.closePosition(` (invariant test `phase21.invariants.test.ts`).
- **UI `App.tsx`:** no `BrokerManager` / `.placeOrder(`.
- **Python / VectorBT:** `canPlaceOrders: false`; no `BrokerManager`.

Adapter `closePosition` / flatten helpers call `this.placeOrder` **inside the adapter**. HTTP routes do not.

**Verdict:** Production broker orders are isolated to OMS → BrokerManager → adapter. Research/UI cannot place.

**OMS unknown submit:** `placeOrder` throw with no `brokerOrderId` keeps status **PENDING**, stamps `submitOutcome=UNKNOWN`, sets `TRADING_PAUSED`. It does **not** guess REJECTED. Crash recovery may later REJECTED only if `getOrderByClientOrderId` finds nothing (Alpaca-capable only).

**Manual override:** `POST /api/v2/trading/execute-override` skips ChiefTrader consensus only; still RiskEngine→OMS. Reasoning stamped `SOURCE: MANUAL_OVERRIDE`. BUY refused while Autobot off. Organic paper filters exclude overrides (`organicPaper.ts`).

### 2.3 Encryption and `data/secrets.json`

`EncryptionService.ts`:

- Missing `ENCRYPTION_SECRET` → **throw at module load**.
- `encrypt` / `decrypt` catch paths **throw** `ENCRYPTION_FAILED` / `DECRYPTION_FAILED`. Not a plaintext passthrough.
- Ciphertext without `iv:hex` → throw. Empty string short-circuits unchanged (not decrypt-fail-open).

`server.ts` boot: if `data/secrets.json` **exists**, process **throws** unless `ARGUS_ALLOW_PLAINTEXT_SECRETS_FILE=true`. File is never read for keys. `persistEncryptedSecrets.ts` writes encrypted SQLite only.

### 2.4 LIVE vs `paperMode` vs confirmation phrase

**Where LIVE is blocked:**

1. `TradingEngine.toggle`: enabling LIVE requires `confirmLiveTrading === 'ENABLE LIVE TRADING'` → **arms** this process (`LiveTradingConfirmation.ts`).
2. `POST /api/v1/config/settings` calls `toggle` first; LIVE without phrase → 400, no write.
3. `BrokerManager.setLiveMode(true, phrase)` arms; paper disarm clears arm; capability-gated; persists `paperMode: !live`.
4. **Per-order OMS:** `assertBrokerEnvironmentAllowsOrder` — LIVE only if `tradingMode=LIVE` **and** `paperMode=false`; disagreement → **UNKNOWN** → no order.
5. **Per-order LIVE arm:** OMS rejects LIVE env unless `isLiveTradingArmed()`. `AlpacaBroker.placeOrder` refuses live host (`api.alpaca.markets`) without arm. Restart clears arm even if SQLite still says LIVE.
6. Replay refuses while `tradingMode === 'LIVE'`.

**Verdict:** Dual-flag disagreement cannot trade. Phrase enables + arms. Live Alpaca POSTs without arm fail closed.

### 2.5 RiskEngine sizing honesty and `data_freshness`

**Freshness:** `evaluateQuoteFreshness({ priceAgeMs: null })` → grade **UNKNOWN**, `passed: false`. Gate `data_freshness`. **Fail-closed.**

**Sizing (`PositionSizing.ts`):**

| Gate | At qty 0 |
|---|---|
| `order_notional_cap` | `passed: false` when `maxSharesByCapital <= 0` |
| `symbol_concentration` / sector / correlation | `passed: false` when floor shares ≤ 0; honesty pass flips binding CLAMP→FAIL at zero |
| `sufficient_size` | **`passed: false` iff `maxQuantity === 0`** (blocks OMS) |

LIVE unknown sector/correlation: `failClosedUnknownInputs: tradingMode === 'LIVE'` → those gates `passed: false`.

---

## Gate 3 — Research parity and VectorBT

### 3.1 `BacktestEngine.ts` fill model

**Still SAME_BAR_CLOSE** (not converted to NEXT_BAR_OPEN). Stamped `promotable: false` / `SAME_BAR_CLOSE_NOT_PROMOTABLE`.

Canonical promotion fills: `canonicalNextBarEngine.ts` (`NEXT_BAR_OPEN`). Mixing models → `ENGINE_MISMATCH`. Do not re-label BacktestEngine as NEXT_BAR without a full parity rewrite.

### 3.2 `config/researchSafety.json` costs

```
commissionPerShare: 0.005
spreadBps: 2
slippageBps: 5
zeroCostBlocksPromotion: true
```

**Non-zero.** `isTheoreticalZeroCost()` is false → readiness gate `ZERO_COST_RESEARCH` **PASS**. Costs are research assumptions, not a live broker fee schedule.

### 3.3 CORE vs VectorBT / Python

- Feature vectors (BOS/RVOL/Keltner/S-R): **`FEATURE_PARITY_ESTABLISHED`** vs UNIT_FIXTURE (`strategySpecs.json`).
- Full `StrategyContext.evaluate()` Python parity: **`fullStrategyParity: false`** (`quantWfoGrid.json`, `core_strategies.py`).
- SMC: **`PROXY_NOT_FEATURE_PARITY`** / UNVALIDATED.
- Overlay must not retune live `quantThresholds.json` while full parity is false.

**Verdict:** Vector subset ≠ live strategy parity ≠ validated edge.

### 3.4 Warehouse GREEN before Parquet

`ingestAlpacaWarehouse.ts` + `scripts/ingest_research_warehouse.ts`: Parquet only after GREEN; no keys → no fabricated bars.

On disk this environment: `SPY_1Day_2024-07-21.meta.json` is GREEN REAL_MARKET_DATA (519 bars) with **`parquetBytesWritten: false`** (pyarrow / write job incomplete). Sidecar can exist without parquet. Quality engine: `assessDataQuality` (no class named `ResearchDataQualityEngine`).

### 3.5 Phase 18 historical replay (MODE B)

Full Argus replay exists (`FullArgusReplayEngine`, `HistoricalReplayBroker`, `config/replaySafety.json`). Path: PIT bars → Chief vote math → RiskEngine → OMS → replay broker (NEXT_BAR_OPEN + costs). Does **not** emit live `TRADE_IDEA_GENERATED`. Golden UNIT_FIXTURE schedule exercises path correctness only — **not** REAL_MARKET_DATA edge. `executionEnvironment=REPLAY` excluded from organic paper. VectorBT remains MODE A `canPlaceOrders: false`.

---

## Gate 4 — UI honesty

### 4.1 Quarantined routes

- `app.all("/api/v1/signals")` → **410** `SIGNALS_PATH_QUARANTINED`
- Event-memory routes → **410**

Command Center does not restore fabricated signals. Memory UI handles 410.

### 4.2 Agent Network Focus Mode

`DigitalTwinVisualizer` / `AgentFocusMode`: real EventBus only. `AgentWorkflowTheater`: educational loops — not ticks.

### 4.3 Phase 25 Mission Control purge

`AutonomousMissionControl.tsx`: fabricated CIO win-rate percentages and arena return theater removed. Empty states use `AwaitingSignal` / `AWAITING_ORGANIC_PAPER_EVIDENCE`. Metrics must not be invented client-side.

Remaining `34.2%` strings in the tree are **NewsAgent calibration comments** (real measured bucket accuracy), not Mission Control P&L.

---

# Technical readiness (software execution safety)

**Score (hostile, this session):** ~73/100 infrastructure. **Not 100.** Not unattended-certified.

What the code actually does today:

- Sacred path: `TRADE_IDEA_GENERATED` → ChiefTrader → RiskEngine → OMS → BrokerManager → broker.
- Dual paper/LIVE flags + LIVE_ARM fail closed.
- Unknown quote age fails `data_freshness`.
- Unknown broker submit pauses trading.
- Quant off unless `QUANT_ENGINE_ENABLED=true`; SMC live only with `QUANT_SMC_STRATEGY_ENABLED=true`.
- Restricted-live dollar caps when `tradingMode === 'LIVE'` (not a profit proof).
- Auth: production refuses no-password boot (`enforceAuthConfigOrExit`). **Dev with `AUTH_PASSWORD` unset still exposes `/api` + `/ws`** (gap A5 in gap analysis).

Remaining gaps that still matter for money:

- Shadow is a second ledger (OMS-fill-only) — not organic paper.
- `BacktestEngine` SAME_BAR remains (labeled).
- No L2; no Canadian automated routing; IBKR 2FA; Questrade cannot place; Coinbase paper refuses `placeOrder`.
- OpenAlice / IBKR companion health may FAIL without blocking RiskEngine (wrong MCP / Gateway 401 are ops, not edge).

### Paper trading — infrastructural GO / NO-GO

**Refuse** stamp `PAPER TRADING READY (TECHNICAL)` as 100% autonomy.

1. Autobot / idea generation off unless enabled.
2. `data_freshness` blocks until a real tick age exists.
3. Organic closed paper in `data/argus.db` this session: **0** (`6` rows, all `PENDING` BUY, `execution_environment` null).
4. Shadow ≠ `trades` table.

**Paper path (PAPER + paperMode + Autobot on + ticks + InternalPaper or Alpaca paper):** fail-closed and usable → **CONDITIONAL GO (supervised)**.

**Unattended 100% autonomous paper certificate: NO-GO.**

---

# Trading-edge readiness (empirical statistical validation)

**Score: 8/100** (`tradingEdgeScore` / empty CORE evidence).

| Claim | Code / data reality |
|---|---|
| CORE validated | **UNTESTED** |
| SMC | **UNVALIDATED** |
| OOS / WFO / robustness on GREEN REAL_MARKET_DATA | Prior SPY 1Day NEXT_BAR run: WFO **FRAGILE**, robustness **FAILED** / insufficient — **not** promotion-ready |
| Non-zero research costs | **Configured** (0.005 / 2 / 5) |
| VectorBT full strategy parity | **`fullStrategyParity: false`** |
| Organic paper expectancy | **NOT ESTABLISHED** (0 closed PAPER SELLs) |
| Historical replay / golden schedule | Path test only — **not** edge |
| LLM confidence = P(win) | **Forbidden** |

No strategy may be called profitable from this repository state.

**Trading-edge: NO-GO.**

---

# Phase status (code-verified)

### Phase 20 — secrets / LIVE enablement

| Item | Status |
|---|---|
| Encryption fail-closed | **CLOSED** |
| Refuse boot on leftover `secrets.json` | **CLOSED** |
| LIVE phrase + settings allowlist | **CLOSED** |
| Per-order LIVE_ARM (OMS + live Alpaca) | **CLOSED** |

### Phase 21 — one OMS / environment hygiene

| Item | Status |
|---|---|
| Single production `placeOrder` path | **CLOSED** |
| Organic filter (excludes UNKNOWN / test / MANUAL_OVERRIDE / REPLAY) | **CLOSED** (count still **0**) |
| BacktestEngine → NEXT_BAR | **OPEN** (intentionally labeled SAME_BAR) |

### Phase 22 — canonical research / warehouse / UI quarantine

| Item | Status |
|---|---|
| Canonical NEXT_BAR | **CLOSED** |
| Non-zero research costs | **CLOSED** |
| GREEN warehouse + Parquet bytes on disk | **PARTIAL** (meta/bars GREEN; parquet write incomplete here) |
| Signals / event-memory 410 | **CLOSED** |

### Phase 23 — VectorBT / overlay

| Item | Status |
|---|---|
| Vector FEATURE_PARITY_ESTABLISHED | **CLOSED** (vector claim only) |
| Full strategy parity | **OPEN** |
| CORE OOS/WFO/robustness pass on GREEN | **OPEN — EXTERNAL** |

### Phase 18 — historical replay

| Item | Status |
|---|---|
| MODE B RiskEngine→OMS→HistoricalReplayBroker | **CLOSED** (path) |
| Replay ≠ paper ≠ LIVE; golden schedule = UNIT_FIXTURE | **CLOSED** (honesty) |
| Replay as promotion / edge | **FORBIDDEN** |

### Phase 25 — UI honesty / pre-soak hardening

| Item | Status |
|---|---|
| Mission Control fabricated WR/arena returns removed | **CLOSED** |
| `BrokerEngine` deleted | **CLOSED** |
| Warehouse empty-dir test cwd isolation | **CLOSED** |
| `SOURCE: MANUAL_OVERRIDE` on execute-override | **CLOSED** |

### Phase 24+ (roadmap, not started)

Auth harden when `AUTH_PASSWORD` unset (non-prod), parquet ops, full parity decision, CORE research until not FRAGILE, organic paper soak, tiny LIVE human gate — see `ARGUS_REAL_MONEY_GAP_ANALYSIS.md`. **Await authorization.**

---

## Scorecard (this session)

| Dimension | Verdict |
|---|---|
| Compiler | GO |
| Unit/integration tests | GO (1066 / 162 files) |
| Production order path | GO (single OMS) |
| LIVE enablement | Fail-closed (phrase + dual flags + LIVE_ARM) |
| Paper **path** | CONDITIONAL GO (supervised) |
| Paper **100% autonomous** | **NO-GO** |
| Trading edge | **NO-GO (8/100)** |
| LIVE capital | **NO-GO** |
| Canadian automated live | **BLOCKED — EXTERNAL** |
| Organic paper closed SELLs | **0** |

`evaluateLiveReadiness()`: **`LIVE_NO_GO`**. Organic paper: **`NOT_ESTABLISHED`**. Canadian: **`NOT_AVAILABLE`**.

---

## Strict GO / NO-GO

| Question | Call |
|---|---|
| **Paper trading (supervised, InternalPaper or Alpaca paper, Autobot on, ticks, PAPER+paperMode aligned)** | **CONDITIONAL GO** — path fail-closed. Not profitability. |
| **Paper trading (100% unattended / “PAPER TRADING READY (TECHNICAL)”)** | **NO-GO** |
| **Live capital / autonomous real-money** | **NO-GO** |
| **Start 30-day organic paper soak after Phase 25?** | **Infrastructure CONDITIONAL GO** — evidence still 0 until NY sessions produce real OMS PAPER closes. |

Do not enable LIVE. Do not treat VectorBT, Phase 18 replay, passing tests, or CORE strategy files as edge. Do not count Shadow or manual overrides as organic paper.
