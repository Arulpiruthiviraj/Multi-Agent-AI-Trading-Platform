# Argus execution forensics (OMS / brokers)

```
CHIEF_APPROVED_IDEA
  → RiskValidationAgent.assessRisk
  → RiskEngine.evaluateRisk (persist-then-emit)
  → RISK_ASSESSMENT_COMPLETED (approved)
  → OrderManagementService
  → authorizeProductionOrder (P0.1)
  → BrokerManager.getActiveBroker().placeOrder
  → adapter REST/WS
  → trades INSERT/UPDATE
  → fills (unique watermark)
  → ORDER_* events
  → TransactionLifecycleTracker updates transactions.status
```

**OMS is the only production `.placeOrder(` caller.** **TEST-VERIFIED** `phase21.invariants.test.ts`.

Telemetry / Digital Twin pulses must never place.

Whole-share MARKET orders: `Math.floor(dollars / price)`; Alpaca `qty` only. No fractional/notional live path. **CODE-VERIFIED** CLAUDE.md.

`clientOrderId` always passed; crash recovery `reconcileStaleOrders` by `client_order_id`.

Timeout: **PENDING / UNKNOWN**, never fabricated FILLED.

---

## Brokers currently in tree

| Adapter | File | Execution | Paper | Live | Auth | Orders | Limitations | SoT | Class |
|---|---|---|---|---|---|---|---|---|---|
| InternalPaperBroker | `src/brokers/InternalPaperBroker.ts` | Yes (in-process) | **Default** if none selected. Default cash `internalPaperDefaultCash` $100k | N/A | None | Market qty; queues then fills on next broker tick | Not a real venue | Local memory + `trades`/`fills` | **SIMULATED / PAPER** |
| AlpacaBroker | `src/brokers/AlpacaBroker.ts` | Yes | Alpaca paper REST | Alpaca live REST **blocked** without 5-layer arm + LIVE_READY | API key/secret; TLS `node:https` + system CA | MARKET qty; timeouts/retry/circuit breaker from tradingSafety | IEX top-of-book, no L2 | Broker API + local ledger | **PAPER real venue** or **LIVE** (currently LIVE_NO_GO) |
| InteractiveBrokersAdapter | `src/brokers/InteractiveBrokersAdapter.ts` | Yes via Client Portal Gateway | `DU*` paper | `U*` live — classification mismatch **fail-closed** (P0.2) | Local Gateway + human 2FA ~24h (`requiresManualReauth`) | Web API; User-Agent required (WAF 403 otherwise) | **Cannot** place Canadian-exchange equities (IIROC). Not unattended | Gateway session + local ledger | **PAPER or LIVE** (policy-blocked CA) |
| CoinbaseBroker | `src/brokers/CoinbaseBroker.ts` | Live Advanced Trade CDP-JWT | **`placeOrder` refuses in paper** (no sandbox) | Requires LIVE_ARM + PAPER_TRADING_ONLY check (P1.7) | CDP JWT | Crypto | Not funded-account verified here | Coinbase + local | **LIVE-capable; paper NOT IMPLEMENTED** |
| QuestradeBroker | `src/brokers/QuestradeBroker.ts` | **No** | N/A | N/A | OAuth2 | `placeOrder`/`modifyOrder` **throw** | Read-only | Broker positions read | **READ-ONLY** |
| HistoricalReplayBroker | `src/brokers/HistoricalReplayBroker.ts` | Research replay fills | N/A | N/A | None | Replay clock | Must not count as organic paper | Replay | **SIMULATED / REPLAY** |

`BrokerManager` (`src/brokers/BrokerManager.ts`): initialize **before** `tradingEngine.initialize()` (DEF-01). `setLiveMode(true)` refused if `PAPER_TRADING_ONLY=true`.

Credentials: AES-256-CBC (`ENCRYPTION_SECRET` or `data/.encryption_key`). Table `broker_connections` stores encrypted blobs.

---

## 5-layer LIVE arming (all fail-closed)

1. Human confirmation phrase on `tradingEngine.toggle` when going LIVE  
2. `tradingState === TRADING_ENABLED`  
3. `PAPER_TRADING_ONLY` false  
4. Alpaca live host refuses without arm  
5. Per-process `LIVE_ARM` memory-only (cleared on restart)  

OMS still refuses if `evaluateLiveReadiness() !== LIVE_READY`.

---

## Prove OMS called the broker

1. `trades.submitted_at` set  
2. `broker_order_id` **or** explicit UNKNOWN timeout reasoning on the row  
3. `ORDER_SUBMITTED` in `event_traces` (persist list)  
4. Adapter logs (never print secrets)

Inbound broker fill with no local OMS row: `SOURCE: EXTERNAL_MANUAL`, `executionEnvironment=UNKNOWN`, not RiskEngine-approved. Operator must intervene. **CODE-VERIFIED** OMS.

---

## Liquidate / rebalance

`PipelineFlatten` and `PortfolioRebalance` emit `CHIEF_APPROVED_IDEA` with agent `ManualOverride` after minting a transaction. **Still RiskEngine + OMS.** Rebalance is **not** HTTP 501 — `PortfolioRebalance.ts` implements `POST /api/v1/portfolio/rebalance` (direction only; RiskEngine sizes). **CODE-VERIFIED**.
