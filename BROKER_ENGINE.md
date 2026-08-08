# Argus - BROKER ENGINE

Documentation for the broker abstraction layer, verified against `src/brokers/*` and `src/server/services/OrderManagement.ts` on 2026-08-08. A prior revision of this file described classes that don't exist in this codebase (`BaseBroker`, `PaperBroker.ts`, a `BrokerManager` that "polls open positions" and "checks stop loss / take profit targets") — everything below is the real implementation.

---

## 🎯 Purpose

The broker layer provides one interface (`BrokerPlugin`, `src/brokers/BrokerAdapter.ts`) implemented by 5 concrete classes, only 2 of which actually work.

| Broker | File | `authenticate()` | `portfolio()` | `placeOrder()` | Status |
|---|---|---|---|---|---|
| Alpaca | `AlpacaBroker.ts` | Real REST call to `/v2/account` | Real, maps real positions from `/v2/positions` | Real POST to `/v2/orders` | ✅ **Real** |
| Internal Paper Simulator | `InternalPaperBroker.ts` | Always `true` | Real in-memory simulation | Real (queued, filled on next `tick()` with spread-adjusted price) | ✅ **Real simulation** (default broker) |
| Questrade | `QuestradeBroker.ts` | Always `true` (comment: `// Placeholder`) | Returns `{cash:0, buyingPower:0, equity:0, positions:[]}` | `throw new Error('Not implemented')` | 🔴 **100% stub** |
| Interactive Brokers | `InteractiveBrokersAdapter.ts` | Always `true` | All zeros | Throws | 🔴 **100% stub** |
| Coinbase | `CoinbaseBroker.ts` | Always `true` | All zeros | Throws | 🔴 **100% stub** |

**If you select Questrade, IBKR, or Coinbase as the active broker, nothing fails at selection time** — `authenticate()` returns `true` for all of them. **It fails the first time an order is actually placed**, throwing inside `OrderManagementService`'s try/catch, which records the trade as `status: "REJECTED"` with no further diagnostic.

---

## 🏗️ Architecture (real)

```
┌──────────────────────────────────────────────────────┐
│  BrokerManager (src/brokers/BrokerManager.ts)         │
│  • Singleton, private constructor seeds InternalPaperBroker as a placeholder
│  • initialize() reads broker_connections + settings.selectedBroker,
│    registers all 5 adapters, authenticates the selected one
│  • getActiveBroker() / setActiveBroker() / tick(prices)
└────────────────────┬─────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────┐
│         BrokerPlugin interface (BrokerAdapter.ts)     │
│  initialize() / authenticate() / paperTrading() / liveTrading()
│  portfolio() / orders() / positions() / account()
│  placeOrder() / cancelOrder() / disconnect() / health()
│  tick?(currentPrices) — optional, used by simulators
└────────────────────┬─────────────────────────────────┘
         ┌───────────┴─────────┬─────────────┬─────────────┐
         ↓                     ↓             ↓             ↓
  AlpacaBroker        InternalPaperBroker  Questrade    IBKR/Coinbase
  (real REST)          (real simulation)   (stub)       (stub)
```

### ⚠️ Confirmed startup gap: `BrokerManager.initialize()` is never called

A repo-wide search of `server.ts`'s `startServer()` function finds **no call site** for `BrokerManager.getInstance().initialize()`. The only place it's invoked is nowhere in the actual boot sequence. Practical consequence: on a fresh server start, `BrokerManager.getActiveBroker()` returns the bare `InternalPaperBroker` instance seeded in the private constructor (default `$100,000` virtual cash, `authenticate()` never called with your configured credentials) — **not** whatever you selected in `broker_connections`/`settings.selectedBroker` — until/unless something else in the request path happens to trigger `initialize()`. If you're debugging "why is my configured Alpaca connection not active," this is the first thing to check.

---

## 📝 `BrokerManager` — real responsibilities

**Location**: `src/brokers/BrokerManager.ts`

1. **Broker registration & selection** (inside `initialize()`, when it does run): constructs all 5 adapters, calls each one's `initialize()`, reads `settings.selectedBroker` and the matching `broker_connections` row, decrypts credentials via `EncryptionService`, calls `paperTrading()`/`liveTrading()` based on `connection.paperMode`, then `authenticate(credentials)`. Falls back to `InternalPaperBroker` with `{initialCash: 100000}` if no connection row matches.
2. **`tick(prices)`** — called every 1000ms from `server.ts` with the `liveQuotes` price cache (populated by `server.ts`'s own, separate Alpaca WebSocket client — see [AI_CONTEXT.md](./AI_CONTEXT.md) on the duplicate-connection issue). Forwards to the active broker's own `tick()` if it has one (only `InternalPaperBroker` does — this is how its queued orders actually fill).
3. **`setActiveBroker(id, credentials)`** — safely disconnects the previous broker before authenticating the new one.

There is no position-monitoring, stop-loss/take-profit enforcement, or "close positions when targets hit" logic inside `BrokerManager` — that would need to live in `PortfolioMonitorWorker`, and even there it uses hardcoded thresholds, not broker-driven bracket orders (see [RISK_ENGINE.md](./RISK_ENGINE.md)).

---

## 🔌 Alpaca Broker Integration (real)

**Location**: `src/brokers/AlpacaBroker.ts`

Uses raw `fetch()` against Alpaca's REST API directly — **not** the `@alpacahq/alpaca-trade-api` npm package listed in `package.json` (that dependency is installed but unused by this class).

```ts
// Real, current implementation (abbreviated)
class AlpacaBroker implements BrokerPlugin {
  private baseUrl = 'https://paper-api.alpaca.markets'; // swapped by liveTrading()

  async authenticate(credentials) {
    this.apiKey = credentials?.apiKey || process.env.ALPACA_API_KEY;
    this.secretKey = credentials?.secretKey || process.env.ALPACA_SECRET_KEY;
    this.baseUrl = credentials?.isLive ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
    const res = await this.fetchAlpaca('/v2/account');
    return !!res.id;
  }

  async portfolio() {
    const account = await this.account();
    const positions = await this.fetchAlpaca('/v2/positions');
    return { cash, buyingPower, equity, positions: mappedPositions };
  }

  async placeOrder(orderData) {
    return this.fetchAlpaca('/v2/orders', { method: 'POST', body: JSON.stringify({ symbol, qty, side, type, time_in_force: 'day' }) });
  }
}
```

**Alpaca market data**: there are **two separate, independent WebSocket clients** connecting to `wss://stream.data.alpaca.markets/v2/iex` with the same credentials — one in `server.ts`'s `initializeAlpacaWebSocket()` (populates the module-local `liveQuotes` object, consumed by the legacy `/api/v1/signals` endpoint and by `BrokerManager.tick()`), and a second, independent one in `MarketDataWorker.connectAlpaca()` (populates its own `latestPrices` map and the real 1-minute OHLC bar aggregator that `RiskEngine` uses for ATR). Both authenticate and subscribe to the same symbol list. This is a known duplication, not two different data sources.

---

## 🧪 Internal Paper Simulator (real)

**Location**: `src/brokers/InternalPaperBroker.ts` (there is no `PaperBroker.ts` file — a prior doc revision invented that filename)

- Starts with `$100,000` virtual cash (hardcoded, not configurable via the constructor — `authenticate({initialCash})` can override it).
- `placeOrder()` queues the order as `PENDING`; it does **not** fill synchronously.
- `tick(currentPrices)` (called every 1s by `BrokerManager.tick()`) is what actually fills queued orders: applies a `0.05%` spread (buy pays `price + spread`, sell receives `price - spread`; slippage is explicitly `0`, per an inline comment "Removed fake slippage"), checks buying power, updates cash/positions, and recalculates unrealized P&L for all open positions against the latest tick.
- **Because fills happen asynchronously on the next tick rather than inside `placeOrder()`**, `OrderManagementService.executeOrder()` polls the broker's `orders()` list a few times (bounded retries with a short delay) after a `PENDING` result, so real trades aren't permanently recorded as pending in the `trades` table.
- Long-only: `placeOrder`'s SELL logic reduces or deletes the position; there's no short-selling support (an inline comment notes this is intentional for now).

---

## 📊 Real Order Flow (traced from code, not invented)

```
RiskEngine emits RISK_ASSESSMENT_COMPLETED {approved: true, symbol, side, maxQuantity, currentPrice, stopLossPrice, ...}
        ↓
OrderManagementService.executeOrder(symbol, side, quantity, reasoning, traceId, newsDetails?)
        ↓
BrokerManager.getInstance().getActiveBroker().placeOrder({symbol, side, type: 'MARKET', quantity})
        ↓
   [real Alpaca REST call | real in-memory sim fill | throws for Questrade/IBKR/Coinbase]
        ↓
if status === 'PENDING': poll broker.orders() a few times for a terminal status
        ↓
if side === 'SELL' && status === 'FILLED': compute profitLoss against the portfolio table's cost basis
        ↓
db.insert(trades, {id, symbol, side, quantity, price, status, timestamp, reasoning, traceId, profitLoss, newsUsed, ...})
        ↓
eventBus.emitOrderExecution({traceId, id, symbol, side, quantity, price, status, profitLoss})
        ↓
WebSocket wildcard broadcast → frontend (2 of ~15 broadcast event types are actually subscribed to — see FRONTEND_GUIDE.md)
```

There is no separate "position monitoring" step here that checks stop-loss/take-profit against the broker — that logic, such as it is, lives in `PortfolioMonitorWorker` on its own 60s timer with hardcoded ±5%/-3% thresholds (see [RISK_ENGINE.md](./RISK_ENGINE.md)).

---

## 🛡️ What safety features actually exist

- **Kill switch**: `enginesHalted` state exists in the legacy `/api/v1/signals` simulation path (`server.ts`) and in the frontend. It does **not** call `SystemBootstrap.stop()` on the real agent workers — it only affects the legacy simulation's own state flags.
- **Pre-trade validation**: handled entirely by `RiskEngine` (buying power, concentration, circuit breakers — see [RISK_ENGINE.md](./RISK_ENGINE.md)). There is no separate day-trade-count check or market-hours check in the real pipeline.
- **Emergency stop that cancels pending orders / closes all positions**: 🔵 **not implemented**. No code path in this repository iterates open broker orders/positions and force-closes them.

---

## 🔧 Configuration

### Environment Variables (actually read)

```bash
ALPACA_API_KEY=
ALPACA_SECRET_KEY=
PAPER_TRADING_ONLY=true   # read by the legacy /api/v1/signals endpoint and AlpacaBroker URL selection paths
```

Questrade/IBKR/Coinbase have no environment variables wired up anywhere — their adapters don't read any env vars at all, since they don't make real network calls.

### Database Configuration (`broker_connections` table)

```ts
{
  brokerName: 'Alpaca',
  apiKeyEncrypted: EncryptionService.encrypt(apiKey),
  secretEncrypted: EncryptionService.encrypt(secret),
  paperMode: true,
  status: 'Disconnected' // this field is display-only; BrokerManager doesn't read/write it to gate anything
}
```

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference, including the `BrokerManager.initialize()` startup gap
- [RISK_ENGINE.md](./RISK_ENGINE.md) — sizing/veto logic that runs before any order reaches this layer
- [API_REFERENCE.md](./API_REFERENCE.md) — real API endpoints
