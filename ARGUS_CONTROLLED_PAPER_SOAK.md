# ARGUS Controlled Paper Soak Protocol

**Operator framing (2026-08-21):**  
`SUPERVISED_PAPER_OPERATION_READY` — mechanical GO; **Autobot paper run verification NEXT**; **NO LIVE**; **NO EDGE CLAIM**.

**Mode:** Supervised PAPER. `PAPER_TRADING_ONLY=true`. **LIVE_NO_GO**.  
**Immutable floors:** `tradingSafety.consensusApprovalThreshold` **0.75**, `minIndependentAgreeingAgents` **2**.  
**Do not** bypass `news_veto`, RiskEngine, OMS, or BrokerManager. Do not lower consensus to “get trades.”  
**Do not** auto-enable Autobot from engineering or this protocol.

Cross-links: `ARGUS_NO_TRADE_REMEDIATION_STATUS.md`, `ARGUS_TODAY_PAPER_READINESS_AUDIT.md`, `ARGUS_TODAY_FULL_TRADING_AND_TOMORROW_READINESS_AUDIT.md`, soak floors in `config/researchSafety.json`.

---

## Immutable floors (never relaxed in this protocol)

| Knob | Value |
|---|---|
| Consensus approval threshold | **0.75** |
| Min independent agreeing agents | **2** |
| Paper-only | `PAPER_TRADING_ONLY=true` |
| LIVE | `LIVE_NO_GO` until `evaluateLiveReadiness() === LIVE_READY` |
| Organic exclusions | REPLAY / BACKTEST / DIAGNOSTIC / EXTERNAL_SYNC / MANUAL_OVERRIDE / TELEMETRY_PULSE do **not** count |

Soak counting unit remains organic FILLED PAPER **SELL** with numeric `profit_loss` (`isOrganicClosedPaper`). First-fill forensic triggers on the first organic PAPER **fill** (BUY or SELL) via `isOrganicPaperFill`.

---

## Three-phase supervised protocol

### Phase 1 — Mechanical paper operation (GO)

Engineering + supervised runtime prove the protected spine without claiming edge:

1. Single Argus writer; Chronos healthy if Kronos enabled.
2. `LIVE_NO_GO`; `PAPER_TRADING_ONLY=true`.
3. Kill switch / pause / restart / reconciliation contracts TEST+RUN verified.
4. Autobot remains **OFF** until Phase 2 (this protocol never auto-enables it).
5. Pipeline health: enabled agents waiting for ticks with Autobot off show **`IDLE_WAITING_FOR_MARKET_DATA`**, not FAILED/DEAD. Chronos down → **UNAVAILABLE**.

**Exit criterion:** `SUPERVISED_PAPER_OPERATION_READY` / mechanical execution VERIFIED. Autobot autonomous operation still **NOT YET RUN-VERIFIED**.

### Phase 2 — Autobot paper run verification (NEXT)

Operator-supervised RTH with intentional Autobot ON:

1. Operator enables Autobot only while watching Mission Control / Digital Twin / recon.
2. Expect consensus scarcity and `news_veto` on exits — fail-closed safety, not a defect to “fix” by lowering 0.75 / min 2.
3. **First organic PAPER fill → automated forensic checkpoint** (fail-closed).
4. Continue only if checkpoint **PASS** and operator remains present.

### Phase 3 — Organic soak / performance ledger (unmet)

1. Autobot off at EOD (or schedule window ended); clean stop preferred.
2. Confirm fills unique vs broker; no LIVE rows; no REPLAY counted as organic.
3. Update soak counters (`npx tsx scripts/organic_paper_soak_status.ts`).
4. Edge claim stays **NOT ESTABLISHED** until `researchSafety.json` floors are met with organic closes (30 trades / 10 sessions / 30 days / PF≥1.2 / expectancy>0).

---

## Fail-closed first-fill forensic rule (engineering)

Service: `src/server/services/FirstFillForensicCheckpoint.ts`  
Boot: `ArgusCoreBoot` starts the listener (Autobot-independent).  
Trigger: first `ORDER_EXECUTED` with `status=FILLED` that `isOrganicPaperFill` accepts.

### Checks

| Check id | Rule |
|---|---|
| `order_persisted` | `trades` row FILLED, matching symbol, qty>0, price>0 |
| `fill_ledger` | ≥1 `fills` row with positive quantity |
| `portfolio_broker_match` | Local portfolio qty ≈ broker positions for symbol |
| `recon_clean` | Latest recon MATCH and no `MISSING_REMOTELY` for symbol |
| `sell_pnl_non_null` | Closing SELL must have numeric `profit_loss` (BUY: N/A) |
| `trace_completeness` | `traceId` present with trade (and risk assessment when available) |

### On FAIL

1. `TradingEngine.toggle({ enabled: false })` — existing Autobot path (**not** a second kill switch / not EMERGENCY_STOP).
2. `setForensicCheckpointBuyLock` → `ideaGenerationGate` blocks new BUY ideas (SELL/exits still allowed when `TRADING_ENABLED`).
3. Emit `FORENSIC_CHECKPOINT_FAILED` (persisted via `eventNames.json`).
4. Write `data/logs/first_fill_forensic_YYYY-MM-DD.json` + section in `ARGUS_CONTROLLED_PAPER_SOAK_AUDIT_YYYY-MM-DD.md`.

### On PASS

1. Emit `FORENSIC_CHECKPOINT_PASSED`.
2. Persist the same JSON + markdown stub.
3. Supervised session may continue; Phase 3 soak floors still apply.

State marker: `data/.first_fill_forensic_checkpoint.json` (one completed checkpoint per environment until cleared by operator/ops).

---

## Health-state semantics (operator lamps)

Canonical labels: `STARTING` | `IDLE_WAITING_FOR_MARKET_DATA` | `RUNNING` | `DEGRADED` | `UNAVAILABLE` | `FAILED`  
(+ arming: `ENV_OFF` | `OFFLINE` | `NOT_ARMED` | `GATED`).

| Situation | Label |
|---|---|
| Enabled + available + no ticks yet; Autobot off (tick bus quiet) | `IDLE_WAITING_FOR_MARKET_DATA` |
| Chronos `/health` down (Kronos) | `UNAVAILABLE` |
| Fresh successful ticks | `RUNNING` |
| Stale heartbeat while Autobot on (ticks expected) | `FAILED` |

Digital Twin and Kronos status surfaces the same vocabulary (waiting ≠ FAIL).

---

## Explicit non-goals

- Do not auto-start Autobot.
- Do not arm LIVE.
- Do not weaken RiskEngine gates or consensus.
- Do not count REPLAY / historical evaluation fills toward soak.
- Do not claim edge from mechanical GO alone.
