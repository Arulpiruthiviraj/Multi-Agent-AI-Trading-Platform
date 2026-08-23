# ARGUS — IBKR Line-by-Line Forensic Audit

**Date:** 2026-08-21  
**Scope:** Exhaustive map of Interactive Brokers integration (connection, market data, account sync, order path, multi-broker toggle).  
**Mode:** Read-only forensic inspection of repository ground truth (no live `placeOrder`, no Autobot mutation).  
**Protocol libraries:** `@stoqey/ib@^1.6.7` (TCP); Node `https` (Client Portal REST).

---

## 1. Executive Summary & Readiness Score

### Score: **DEGRADED / PARTIALLY_IMPLEMENTED**

| Dimension | Score | Notes |
|---|---|---|
| Dual transport layout | **READY** | `ibkr_gateway` (TCP) + `ibkr_web` (REST) + alias `ibkr` |
| Silent socket auth (no browser by default) | **READY** | Desktop Gateway handshake; browser only opt-in web_api |
| OMS / RiskEngine single spine | **READY** | Only OMS calls `.placeOrder(` on active broker |
| P0.2 paper/live account gate | **READY** | `assertIbkrSessionAllowsOrder` + `DU*`/`U*` prefixes |
| `PAPER_TRADING_ONLY` | **READY** | Enforced in `BrokerManager.setActiveBroker` / `setLiveMode` |
| Market data 100-line socket path | **PARTIAL** | Cap + `reqMktData` bridge exist; tick mapping is price-only; no volume/OHLC; Alpaca still default until switch |
| Account / positions sync | **PARTIAL** | One-shot `reqAccountSummary` / `reqPositions` on connect; no continuous `reqPnL`; no DB recon bridge specific to IBKR |
| Order lifecycle completeness | **INCOMPLETE** | Submit MKT/LMT/STP/STP_LMT only; **no** `orderStatus` / `execDetails` / `openOrder` handlers; **no** brackets/OCO; **no** `getOrderByClientOrderId`; `nextValidId` not persisted |
| Reconnect / heartbeat | **INCOMPLETE** | Socket: no auto-reconnect loop; Web: 60s `/tickle` only |
| Institutional-grade stability | **NOT YET** | See P0–P2 checklist |

### Path corrections (prompt vs repo)

| Prompt assumption | Actual |
|---|---|
| `src/server/brokers/` | **`src/brokers/`** |
| `IBKRBrokerAdapter.ts` / `IBrokerAdapter.ts` | **`IBGatewaySocketAdapter`**, **`InteractiveBrokersWebApiAdapter`**, interface **`BrokerPlugin`** |
| `OrderManager.ts` | **`OrderManagement.ts`** (OMS) |
| `config/broker.json` | **`config/ibkrConnection.json`** (+ `ibkrAccountClassification.json`, `networkEndpoints.json`) |
| BrokerManager under `src/server/services/` | **`src/brokers/BrokerManager.ts`** |

---

## 2. File-by-File Breakdown Table

Line counts are approximate (non-blank-ish Measure-Object); treat as scale, not certificate.

| File Path | Primary Responsibility | ~LOC | Protocol | Readiness |
|---|---|---|---|---|
| `src/brokers/IbkrSocketSession.ts` | `@stoqey/ib` session: connect, MD, account, place/cancel | ~300 | **TCP Socket** | PARTIAL |
| `src/brokers/IBGatewaySocketAdapter.ts` | `BrokerPlugin` id `ibkr_gateway` | ~200 | Socket | PARTIAL |
| `src/brokers/InteractiveBrokersWebApiAdapter.ts` | `BrokerPlugin` id `ibkr_web` Client Portal REST | ~349 | **REST HTTPS :5000** | PARTIAL |
| `src/brokers/InteractiveBrokersAdapter.ts` | Compatibility facade → gateway or web | ~103 | Both | READY (thin) |
| `src/brokers/ibkrTcpProbe.ts` | TCP port reachability | ~36 | TCP probe only | READY |
| `src/brokers/ibkrAccountClassification.ts` | DU*/U* paper/live gate (P0.2) | ~62 | N/A | READY |
| `src/brokers/BrokerManager.ts` | Register, switch, alias, MD bind, health paths | ~551 | Orchestration | READY+PARTIAL |
| `src/brokers/BrokerAdapter.ts` | Shared `BrokerPlugin` / `Order` / `Position` | ~135 | Interface | READY |
| `src/server/config/ibkrConnection.ts` | Load `ibkrConnection.json` + port candidates | ~64 | Config | READY |
| `config/ibkrConnection.json` | mode, ports, clientId, max MD lines | ~14 | Config | READY |
| `config/ibkrAccountClassification.json` | Paper/live prefixes | ~5 | Config | READY |
| `config/networkEndpoints.json` | Legacy CP URL default (`:5000`) | ~51 | Config | READY |
| `src/server/services/MarketDataWorker.ts` | Quote backend switch; IB ingest | ~667 | Alpaca WS + IB bridge | PARTIAL |
| `src/server/services/OrderManagement.ts` | Sole production `placeOrder` caller | ~745 | Spine | READY |
| `src/server/routes/integrationRoutes.ts` | `POST /api/v1/brokers/active` | ~96 | HTTP | READY |
| `src/server/routes/v2Runtime.ts` | Health + `ibkrPaths` | ~129 | HTTP | READY |
| `src/server/routes/configRoutes.ts` | `selectedBroker` → `setActiveBroker` | (partial) | HTTP | READY |
| `src/server/ai/ModelRuntimeManager.ts` | Optional CP `:5000` probe | ~336 | REST probe | LEGACY/OPT-IN |
| `scripts/devWithOpenAlice.ts` | Dev IBKR probe; no browser by default | ~600 | Spawn/probe | READY |
| `scripts/ibkr_socket_handshake.ts` | Standalone socket handshake | ~23 | TCP | READY |
| `src/brokers/__tests__/IBGatewaySocketAdapter.test.ts` | Unit tests gateway adapter | ~32 | Test | READY |
| `src/brokers/InteractiveBrokersAdapter.sessionIsolation.test.ts` | Web session + dual-id tests | ~75 | Test | READY |
| `src/brokers/ibkrAccountClassification.test.ts` | Prefix gate tests | ~42 | Test | READY |
| `src/brokers/BrokerManager.test.ts` | Switch / paper / preflight | (partial) | Test | READY |
| `src/components/BrokerManagement.tsx` | UI Set Active / Test Connection | UI | HTTP client | READY |
| `docs/audits/ARGUS_DUAL_IBKR_ADAPTER_2026-08-21.md` | Prior dual-adapter note | Doc | — | Meta |
| `docs/audits/ARGUS_IBKR_PAPER_BROKER_SWITCH_AUDIT_2026-08-21.md` | Prior :4002 vs :5000 audit | Doc | — | Meta |

**Not found (and not required):** `src/server/brokers/**`, `config/broker.json`, dedicated `brokerRoutes.ts`, IBKR-specific `AlpacaClient` twin.

---

## 3. Deep-Dive by Subsystem

### 3.1 Connection & Protocol Stack

#### A. Primary: IB Gateway TCP (`ibkr_gateway`)

**Library:** `@stoqey/ib` → `IBApi` (`IbkrSocketSession.ts`).

**Ports** (`config/ibkrConnection.json`):

| Mode | Ports (order) |
|---|---|
| Paper (default) | `4002` (Gateway), then `7497` (TWS) |
| Live (only if not `PAPER_TRADING_ONLY`) | `4001`, `7496`, then paper fallbacks |

**Initialization sequence (`IbkrSocketSession.connect`, ~L82–199):**

1. `disconnect()` prior session (clears listeners / maps).
2. `findFirstOpenTcpPort(host, candidates)` — TCP accept only (not IB handshake).
3. If none → warn + return `false` (**no browser**).
4. `new IBApi({ host, port, clientId })` — `clientId` default **17**.
5. Wire EventEmitter handlers **before** `ib.connect()`:
   - `connected` → `reqIds()`, `reqCurrentTime()`, `reqManagedAccts()`
   - `disconnected` → `connected=false`
   - `error` → fail handshake on `ErrorCode.CONNECT_FAIL` (502); else warn
   - `nextValidId` → store in-memory `nextOrderId`
   - `currentTime` → ISO `serverTime`
   - `managedAccounts` → first account id → `reqAccountSummary` + `reqPositions` → **finish(true)**
   - `accountSummary` / `position` / `tickPrice` handlers
6. Timeout `connectTimeoutMs` (default 10000) → disconnect + fail.

**Auth model:** Desktop Gateway already logged in. Argus does **not** send username/password. Success = managed account list received.

**Gaps:**

- No auto-reconnect after mid-session disconnect.
- If `managedAccounts` empty/never fires → hangs until timeout.
- `clientId` collision with other apps on same Gateway not handled beyond fixed config id.
- `removeAllListeners()` on disconnect is good; no leak of prior handlers if connect fails mid-wire (timeout path calls disconnect).

#### B. Secondary: Client Portal Web API (`ibkr_web`)

**Transport:** `https.request` to `baseUrl` (default `https://localhost:5000/v1/api`), **TLS verify off** (`rejectUnauthorized: false`) — documented for IBKR self-signed local cert.

**Auth (`authenticate`, ~L151–182):**

1. `GET /iserver/auth/status`
2. If authenticated → ok
3. Else if connected → `POST /iserver/auth/ssodh/init` then recheck
4. On success → start **60s** `POST /tickle` interval (session keepalive)
5. **Does not** open a browser itself

**Browser / spawn (`scripts/devWithOpenAlice.ts`):**

- Default `probeIbkrDesktopGateway()`: TCP probe 4002/7497 only; **never** opens browser.
- `startIbkrClientPortalGateway` only if `ibkrConnection.mode === web_api` **or** env forces web path; browser only if `openBrowserOnWebApiStartup` or `IBKR_OPEN_BROWSER=true`.

#### C. Alias & manager registration (`BrokerManager`)

**Boot (`initialize` ~L105–120):** registers `IBGatewaySocketAdapter` + `InteractiveBrokersWebApiAdapter` (plus alpaca, etc.).

**`setActiveBroker` (~L291–405):**

1. `ibkr` → `resolveIbkrAlias()` (socket open? → gateway : else web if :5000 open : else gateway).
2. Paper force under `PAPER_TRADING_ONLY`.
3. Preflight: gateway = TCP ports; web = `health()` Offline check.
4. `disconnect()` previous adapter.
5. `authenticate()` → `applyMarketDataBinding()`.

---

### 3.2 Market Data Streaming Pipeline

#### Socket path

| Step | Location | Behavior |
|---|---|---|
| Contract | `stockContract` L247–253 | `{ symbol, secType: STK, exchange: SMART, currency: USD }` |
| Subscribe | `subscribeMarketData` L303–317 | Dedup via `symbolToTicker`; cap `maxMarketDataLines` (100); `reqMktData(tickerId, contract, '', false, false)` |
| Cancel | `cancelMarketData` / `BySymbol` L320–334 | `cancelMktData` + map cleanup |
| Ticks | `tickPrice` L183–189 | Fields **LAST=4, BID=1, ASK=2** only; **price only** → `tickHandler(symbol, price)` |
| MDW bridge | `BrokerManager.applyMarketDataBinding` L409–436 | `setQuoteSink` → `marketDataWorker.ingestIbkrQuote` |
| Cap | `MarketDataWorker.setBrokerQuoteContext` L117–133 | `hardCapOverride = maxMarketDataLines` when gateway active |
| Subscribe routing | MDW `subscribe` L420–428 | If backend `ibkr_gateway`, **skip Alpaca WS subscribe**; call IB bridge |

#### What is **not** implemented

- No tick types for size/volume/high/low/close/halt.
- No `reqHistoricalData` / bars from IBKR.
- No IB depth (L2).
- When backend is Alpaca/`ibkr_web`, capacity remains `continuousIntelligence.maxActiveSubscriptions` (**12** typical).
- Switching to gateway does **not** automatically re-`reqMktData` for every already-active Alpaca symbol (new `subscribe()` calls do; existing set may need re-subscribe cycle).
- Discovery/hot-swap still emits `WATCHLIST_SUBSCRIBE_REQUESTED` into MDW — works with IB bridge once gateway is active.

---

### 3.3 Account, Positions & Reconciliation

#### Socket

| API | When | Tags / fields |
|---|---|---|
| `reqAccountSummary` | After managedAccounts | `NetLiquidation,AvailableFunds,BuyingPower,UnrealizedPnL,TotalCashValue` |
| `reqPositions` | Same | symbol, qty, avgCost → in-memory map |
| `portfolio()` | On demand | Maps tags → `{ cash, buyingPower, equity, positions }` |

**Missing:** `reqPnL`, account update streaming, realized PnL dedicated tag, sector/currency multi-account selection (uses **first** managed account only), continuous refresh timer, IBKR-specific local DB reconciliation hook beyond generic portfolio sync.

#### Web API

| Endpoint | Use |
|---|---|
| `/portfolio/accounts` | Account id |
| `/portfolio/{id}/summary` | cash / BP / equity extraction |
| `/portfolio/{id}/positions/0` | Positions |

#### Paper account gate

`ibkrAccountClassification.json`: paper prefixes `DU`, `DF`; live `U`, `F`, `I` (paper checked first so `DU*` ≠ live `U*`).

`assertIbkrSessionAllowsOrder` fail-closed if mode unset, unclassified, or paper/live mismatch — called in **both** adapters’ `placeOrder`.

---

### 3.4 Order Execution & Risk Compliance

#### Spine (invariant — verified by architecture / OMS design)

```
TRADE_IDEA_GENERATED
  → ChiefTrader (consensus from tradingSafety JSON; min independent agents)
  → RiskEngine.evaluateRisk() (24 gates, fail-closed)
  → OrderManagement (OMS)
       authorizeProductionOrder (LIVE_NO_GO / PAPER)
       → BrokerManager.getActiveBroker().placeOrder(...)
```

OMS (`OrderManagement.ts` ~L289–356): sole production caller of adapter `placeOrder`. IBKR adapters never listen for ideas.

#### Socket order construction (`placeStockOrder` L256–292)

- Allocates `nextOrderId` from in-memory counter (seeded by `nextValidId` event).
- Types: MKT / LMT / STP / STP_LMT only.
- `tif: DAY`, `transmit: true`, optional `account`.
- **No** bracket / OCO / trail / attach SL-TP children.
- Returns Argus `Order` with `status: PENDING` immediately — **does not wait for fill**.

#### Web order construction (`placeOrder` L277–348)

- Resolve `conid` via `/iserver/secdef/search`.
- POST `/iserver/account/{id}/orders`.
- Confirmation loop (max 5): auto-confirm non-duplicate warnings; **refuse** duplicate-order confirm (tested).

#### Critical gaps (order lifecycle)

| Gap | Impact |
|---|---|
| No `orderStatus` / `execDetails` / `openOrder` listeners on socket | OMS fill ledger may not learn IB fills without polling/other path |
| No `getOrderByClientOrderId` on either IBKR adapter | OMS crash-recovery weaker than Alpaca |
| `nextValidId` not persisted | Process restart relies on Gateway’s next id event; race if orders in flight |
| `orders()` on socket returns `[]` | No open-order snapshot |
| Bracket/OCO unimplemented | Product types in `BrokerAdapter.Order` unused for IBKR |

#### PAPER_TRADING_ONLY

- Blocks LIVE promotion in `setLiveMode` / switch `isLive`.
- Does **not** by itself verify account string is `DUR…`; that is `assertIbkrSessionAllowsOrder` after `paperTrading()` set requested mode PAPER.

---

### 3.5 Multi-Broker Toggle & Interface Parity

#### `BrokerPlugin` parity (vs Alpaca)

| Method | Alpaca | ibkr_gateway | ibkr_web |
|---|---|---|---|
| placeOrder / cancelOrder / closePosition | Yes | Yes (subset types) | Yes (MKT/LMT focus) |
| portfolio / positions / account | Yes | Yes (snapshot) | Yes |
| health / authenticate / disconnect | Yes | Yes | Yes |
| streamingMarketData capability | false typical | **true** | false |
| requiresManualReauth | false | **false** | **true** |
| getOrderByClientOrderId | **Yes** | **No** | **No** |
| tick() | Internal paper | No | No |

#### Switch teardown

1. Previous `disconnect()` (socket: `removeAllListeners` + disconnect; web: clear tickle).
2. MDW: if leaving gateway, `ibkrBridge.clear()` + restore Alpaca cap.
3. **Not** cancelled: open broker-side orders on previous venue; operator must reconcile.
4. **Risk of duplicate ticks** if Alpaca WS left open while IB bridge also active for overlapping symbols — current design skips Alpaca **new** subs when gateway backend, but existing Alpaca socket may still deliver core symbols.

---

## 4. Data Flow Diagrams

### 4.1 Market Data (when `activeBroker === ibkr_gateway`)

```
IB Gateway Desktop :4002
        │  TCP @stoqey/ib
        ▼
IbkrSocketSession.reqMktData / tickPrice(LAST|BID|ASK)
        │
        ▼
IBGatewaySocketAdapter.setQuoteSink
        │
        ▼
MarketDataWorker.ingestIbkrQuote
        │  cache latestPrices + acceptTickTimestamp
        ▼
eventBus.emitMarketData  (only if Autobot+TRADING_ENABLED)
        │
        ├── TechnicalAgent / idea agents
        └── RiskEngine data_freshness / UI
```

### 4.2 Trade Idea → Order Execution

```
Idea agents ──emitTradeIdea──► TRADE_IDEA_GENERATED
                                    │
                                    ▼
                            ChiefTraderAgent
                         (weights + consensus bar)
                                    │
                                    ▼
                         CHIEF_APPROVED_IDEA
                                    │
                                    ▼
                            RiskEngine (24 gates)
                                    │
                                    ▼
                         OrderManagement (OMS)
                      authorizeProductionOrder
                                    │
                                    ▼
              BrokerManager.getActiveBroker()
                 │                      │
                 ▼                      ▼
        ibkr_gateway.placeOrder   ibkr_web.placeOrder
        (socket placeOrder)       (REST + confirm loop)
                 │                      │
                 ▼                      ▼
           IB Gateway TCP          Client Portal :5000
```

### 4.3 Account State Sync

```
connect success
   ├─ reqManagedAccts → accountId (first)
   ├─ reqAccountSummary → tags map
   └─ reqPositions → positions map
            │
            ▼
   adapter.portfolio() / account()  (on-demand pull)
            │
            ▼
   PortfolioMonitor / localPortfolioSync / UI
   (generic Argus paths — not IBKR-specific ledger)
```

---

## 5. Deep-Dive: Critical Method Line Ranges

### `IbkrSocketSession.ts`

| Method / handler | Lines (approx) | Role |
|---|---|---|
| `connect` | 82–199 | Full TCP handshake |
| `EventName.connected` | 119–123 | reqIds / time / accounts |
| `EventName.managedAccounts` | 147–157 | Auth success gate |
| `EventName.tickPrice` | 183–189 | L1 price sink |
| `requestAccountSummary` | 201–211 | One-shot summary |
| `disconnect` | 214–226 | Listener teardown |
| `placeStockOrder` | 256–292 | Order submit |
| `subscribeMarketData` | 303–317 | reqMktData + dedup |
| `cancelMarketData*` | 320–334 | Unsub |

### `IBGatewaySocketAdapter.ts`

| Method | Lines | Role |
|---|---|---|
| `setQuoteSink` | 25–31 | MDW binding |
| `authenticate` | 84–99 | Prefer paper ports |
| `placeOrder` | 150–190 | Session gate + types |
| `subscribeMarketData` | 216–217 | Delegate |

### `InteractiveBrokersWebApiAdapter.ts`

| Method | Lines | Role |
|---|---|---|
| `request` | 79–115 | HTTPS + User-Agent |
| `health` / `authenticate` | 134–182 | status + tickle |
| `portfolio` | 208–230 | REST summary/positions |
| `placeOrder` | 277–348 | conid + confirm loop |
| `cancelOrder` | ~354+ | DELETE order |

### `BrokerManager.ts`

| Method | Lines | Role |
|---|---|---|
| `initialize` IBKR register | 111–119 | Dual adapters |
| `resolveIbkrAlias` | 243–253 | Auto detect |
| `setActiveBroker` | 291–405 | Switch + paper + preflight |
| `applyMarketDataBinding` | 409–436 | Cap + bridge |
| `getIbkrPathStatus` | 440–478 | Health dual path |

### `MarketDataWorker.ts`

| Method | Lines | Role |
|---|---|---|
| `setBrokerQuoteContext` | 117–133 | Backend switch |
| `ingestIbkrQuote` | 259–267 | IB → EventBus cache |
| `subscribe` IB branch | 420–428 | reqMktData path |
| `unsubscribe` IB branch | 492–494 | cancelMktData |

---

## 6. Identified Bugs / Races / Edge Cases

| ID | Severity | Issue |
|---|---|---|
| IB-01 | **P0** | No socket `orderStatus`/`execDetails` → fills may not reach Argus fill ledger reliably |
| IB-02 | **P0** | No `getOrderByClientOrderId` → OMS crash recovery blind vs Alpaca |
| IB-03 | **P1** | `nextValidId` memory-only → restart collision risk under concurrent external clients |
| IB-04 | **P1** | No reconnect after Gateway drop mid-session |
| IB-05 | **P1** | First managed account only — multi-account Gateway sessions ambiguous |
| IB-06 | **P1** | Tick path ignores size/volume; BID/ASK can overwrite LAST without preference logic |
| IB-07 | **P1** | On switch to gateway, existing Alpaca subscriptions not forcibly migrated to IB |
| IB-08 | **P2** | Socket `orders()` always empty |
| IB-09 | **P2** | Web adapter TLS verify disabled (acceptable locally; document threat model) |
| IB-10 | **P2** | Bracket/OCO/trail advertised on shared `Order` type but refused/unimplemented on IBKR |
| IB-11 | **P2** | ModelRuntimeManager still CP-oriented probe messaging (opt-in) — can confuse operators |
| IB-12 | **Info** | Prompt paths `src/server/brokers/*` do not exist — audits must use `src/brokers/` |

---

## 7. Actionable Remediation Checklist

### P0 — Correctness / safety of fills

1. **Add socket listeners** for `orderStatus`, `execDetails`, `openOrder`, and map into OMS/fill ledger (or documented poll path).  
2. **Implement `getOrderByClientOrderId`** (or IB `orderRef` / permId mapping) for OMS `reconcileStaleOrders`.  
3. **Integration test:** paper Gateway connect → placeOrder (MARKET 1 share dry-run in paper) → observe status events (still through OMS).  
4. **Operator recon gate:** refuse Autobot enable after broker switch until local↔broker position compare OK.

### P1 — Stability & streaming

5. Auto-reconnect with backoff on `disconnected` / CONNECT_FAIL; preserve clientId.  
6. Persist or re-request `nextValidId` after reconnect; document clientId exclusivity.  
7. Prefer LAST over BID/ASK in tick handler; optionally emit mid.  
8. On `applyMarketDataBinding` to gateway: re-subscribe `activeStreams` via IB bridge; optionally pause Alpaca WS for non-core.  
9. Account refresh interval (`reqAccountSummary` / positions) while gateway active.  
10. Multi-account: config `preferredAccountId` matching `DUR…`.

### P2 — Feature completeness

11. Bracket / stop-attach orders only via OMS-approved types after RiskEngine.  
12. `reqOpenOrders` populate `orders()`.  
13. Historical bars provider optional (replay already separate).  
14. Clean ModelRuntimeManager copy for socket-primary.  
15. UI: explicit labels **IBKR Gateway (Socket)** vs **IBKR Web API** (IDs already distinct in `getAvailableBrokers`).

---

## 8. Verification Snapshot (engineering)

| Check | Result (session) |
|---|---|
| Dual adapters registered | Yes (`ibkr_gateway`, `ibkr_web`) |
| `@stoqey/ib` in package.json | Yes |
| Browser default on `npm run dev` | No (probe only) |
| Vitest `src/brokers/` (+ related) | 112 passed (prior dual-adapter verify) |
| `tsc` + `npm run build` | Green (prior verify) |
| Live handshake `scripts/ibkr_socket_handshake.ts` | Operator-run recommended when Gateway open |
| Organic PAPER edge | **Not established** (unchanged soak floors) |

---

## 9. Bottom Line

Argus now has a **real dual-mode IBKR architecture**: TCP Gateway as primary (`ibkr_gateway` / `@stoqey/ib`) and Client Portal REST as secondary (`ibkr_web`), with **no default browser popup**, **PAPER/LIVE account classification**, and **OMS-only execution**.  

It is **not** institutional-complete: fill/status event plumbing, OMS client-order recovery, reconnect, and richer market-data typing remain the main blockers between “connects and can submit” and “production-grade IBKR paper soak.”

**Overall readiness: DEGRADED / PARTIALLY_IMPLEMENTED.**
