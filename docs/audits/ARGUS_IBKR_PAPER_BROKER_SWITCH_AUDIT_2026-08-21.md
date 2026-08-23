# ARGUS — IBKR Paper Readiness & Dynamic Broker Switch Audit

**Date:** 2026-08-21  
**Mode:** Non-destructive (code inspection + local TCP/HTTPS probes; no Autobot toggle, no LIVE arm, no `placeOrder`)  
**Operator env:** `PAPER_TRADING_ONLY=true` present in `.env`

---

## Verdicts (headline)

| Dimension | Status |
|---|---|
| **1. IBKR Paper readiness (as Argus implements it)** | **PARTIALLY_IMPLEMENTED** — Client Portal Web API (`https://localhost:5000`), not TWS socket |
| **1b. IBKR Paper via IB Gateway socket port 4002** | **MISSING** — no TWS/socket client in-tree; open TCP ≠ Argus support |
| **2. Broker toggling (Alpaca Paper ↔ IBKR Paper)** | **SEAMLESS** for *execution* adapter switch via UI/API (restart not required); **not** a full market-data + recon cutover |
| **3. Live socket handshake `:4002`** | TCP **OPEN**; Argus **cannot** read `DUR*` / serverTime on that port |
| **Safety spine** | **PASS** — OMS sole `placeOrder`; 24 RiskEngine gates; `PAPER_TRADING_ONLY` enforced |

---

## Path correction (prompt vs repo)

| Prompt path / name | Actual |
|---|---|
| `src/server/brokers/IBKRBrokerAdapter.ts` | **Does not exist** |
| `src/server/brokers/IBrokerAdapter.ts` | **Does not exist** |
| `src/server/services/BrokerManager.ts` | **`src/brokers/BrokerManager.ts`** |
| `config/broker.json` | **Does not exist** |
| `POST /api/v2/broker/switch` | **Does not exist** |
| Shared interface | **`BrokerPlugin`** in `src/brokers/BrokerAdapter.ts` |
| IBKR class | **`InteractiveBrokersAdapter`** (`id: ibkr`) |
| Alpaca class | **`AlpacaBroker`** (`id: alpaca`) |

---

## Phase 1 — IBKR adapter readiness

### Transport

- **Implemented:** IBKR Client Portal (CP) Web API over HTTPS to local Gateway.
- **Default base URL:** `config/networkEndpoints.json` → `https://localhost:5000/v1/api` (`IBKR_GATEWAY_URL` override).
- **Explicitly unsupported:** TWS / IB Gateway **socket** API on **4002** (Gateway paper) / **7497** (TWS paper).
- **Socket libraries:** none in `package.json` (`@stoqey/ib`, `@quantconnect/ib`, native IB API — **absent**).

### Interface methods (`BrokerPlugin`)

| Capability | Status on `InteractiveBrokersAdapter` |
|---|---|
| `authenticate` / `connect` / `disconnect` / `health` | Yes — `/iserver/auth/status`, `/tickle`, SSO init |
| `account` / `portfolio` / `positions` | Yes — `/portfolio/...` (DU* paper vs U* live gated by `assertIbkrSessionAllowsOrder`) |
| `placeOrder` / `cancelOrder` | Yes — CP REST; **MARKET/LIMIT only** in payload (no native bracket/SL/TP attach in adapter) |
| `reqMktData` / `cancelMktData` / L1 stream | **No** — `streamingMarketData: false` |
| `ping()` as named API | **No** — use `health()` |
| TWS socket `managedAccounts` / `serverTime` on :4002 | **No** |

Paper vs live for IBKR is **which account is logged into the CP Gateway browser session**, plus Argus `paperTrading()` / `requestedMode` + P0.2 classification (`config/ibkrAccountClassification.json`, `DU*` prefixes).

### Live local port probe (this machine, 2026-08-21)

| Port | Service intent | Result |
|---|---|---|
| **4002** | IB Gateway **socket** paper | **TCP OPEN** |
| **7497** | TWS paper socket | **TIMEOUT** (not listening) |
| **5000** | Client Portal Gateway HTTPS | **TCP OPEN**; Node `GET /v1/api/iserver/auth/status` (TLS verify off) → **HTTP 401** (Gateway process up; session not usable without browser login / cookies) |

**Interpretation:** Something is listening on **4002**, so IB Gateway paper *socket* may be running — but Argus has **zero** code that speaks that protocol. Account id `DUR959160` / server time **cannot** be confirmed through Argus on :4002. For Argus IBKR paper, the supported path is **Client Portal on :5000** with browser 2FA. A raw 401 on `/iserver/auth/status` confirms CP is reachable but **not** authenticated for portfolio/order APIs until human login.

---

## Phase 2 — Dynamic broker switching

### Routing

- `BrokerManager.activeBroker` holds the current `BrokerPlugin`.
- Ids: `alpaca` | `ibkr` | `internal_paper` | `coinbase` (questrade blocked as non-functional for orders).
- **Runtime switch:** `BrokerManager.setActiveBroker(id)` — disconnects previous adapter, authenticates target, persists `settings.selectedBroker`.
- **REST:** `POST /api/v1/brokers/active` `{ "id": "alpaca" | "ibkr" }`.
- **Settings:** `POST /api/v1/config/settings` with `selectedBroker` now also calls `setActiveBroker` (display name or id alias).
- **Not wired:** `ACTIVE_BROKER` env, `config/broker.json`, `POST /api/v2/broker/switch`.
- **IBKR preflight:** `health()` before switch; fail-closed with message that Gateway must be on **:5000** (not 4002/7497).
- **`PAPER_TRADING_ONLY=true`:** forces `paperTrading()` / `isLive: false` on switch.

### Market-data / listener teardown on switch

- Switch **does** call previous broker `disconnect()` (IBKR clears `/tickle` interval).
- Switch **does not** tear down or rebind **`MarketDataWorker`** (Alpaca IEX WS). Market data remains Alpaca-path regardless of execution broker.
- No automatic cancel of open broker orders on the *previous* venue; UI warns about this.
- No automatic portfolio reconciliation gate before switch.

### UI

- **`BrokerManagement.tsx`:** Test Connection + **Set Active** for Alpaca / Interactive Brokers / etc.
- **`AutonomousMissionControl.tsx`:** also can set active broker.
- App “Live Broker Feed” select is **display filter only** (does not change `BrokerManager`).

**Toggle status label:** **SEAMLESS** for mid-session *execution* adapter change without process restart, with gaps above → not “one-click production cutover.”

---

## Phase 3 — Safety invariants & OMS alignment

```
TRADE_IDEA_GENERATED → ChiefTrader (consensus from tradingSafety JSON)
  → RiskEngine (24 gates) → OMS → BrokerManager.getActiveBroker().placeOrder()
```

- Production `.placeOrder(` sole caller: OMS (`phase21.invariants.test.ts` / architecture protection).
- Switching to `ibkr` does **not** create a second order path.
- `PAPER_TRADING_ONLY=true` blocks LIVE arm / live mode promotion (`BrokerManager.setLiveMode`, Alpaca `liveTrading`, Coinbase live place).
- IBKR orders still hit `assertIbkrSessionAllowsOrder` (DU* paper vs U* live mismatch fail-closed).

---

## Gaps / missing wiring (for true “IB Gateway :4002” + 1-click cutover)

1. **No TWS/Gateway socket adapter** — would be a new `BrokerPlugin` + reviewed dependency; architectural change, not a config flip.
2. **No `reqMktData` on IBKR** — quotes stay on Alpaca MDW; IBKR switch does not move the quote spine.
3. **No bracket/SL/TP native IBKR attach** in current `placeOrder` payload (MARKET/LIMIT only).
4. **No `getOrderByClientOrderId` on IBKR** — OMS crash-recovery path weaker than Alpaca.
5. **Switch does not pause Autobot / force recon** — operator must reconcile positions after venue change.
6. **CP session requires human 2FA ~24h** (`requiresManualReauth: true`).
7. Prompt paths (`config/broker.json`, `/api/v2/broker/switch`) unused — prefer existing `/api/v1/brokers/active`.

---

## Implementation fix recommendation

**Do not** wire Argus to port **4002** without an explicit architecture authorization to add a TWS socket client.

**Do use (already wired):**

1. Run **Client Portal Gateway** (not only socket Gateway) → `https://localhost:5000`, browser login + 2FA on **paper** account (`DU*`).
2. Keep `PAPER_TRADING_ONLY=true`.
3. UI **Broker Management → Set Active → Interactive Brokers**, or:
   ```http
   POST /api/v1/brokers/active
   { "id": "ibkr" }
   ```
4. Confirm `GET /api/v2/runtime/health` → `activeBroker.id === "ibkr"`.
5. Reconcile local portfolio vs IBKR before enabling Autobot.

Hardening already present (2026-08-21): IBKR preflight on switch, paper force under `PAPER_TRADING_ONLY`, settings `selectedBroker` → live `setActiveBroker`, health reports `activeBroker`.

---

## Evidence summary

| Check | Result |
|---|---|
| TWS socket deps | Absent |
| Adapter file | `src/brokers/InteractiveBrokersAdapter.ts` |
| Switch API | `POST /api/v1/brokers/active` |
| UI Set Active | Present |
| TCP :4002 | OPEN (unused by Argus) |
| TCP :5000 | OPEN (Argus IBKR path) |
| Organic placeOrder via audit | **Not executed** (non-destructive) |
