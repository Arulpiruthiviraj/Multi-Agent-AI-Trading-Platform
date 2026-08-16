# Argus Phase 20 — Security & Execution-Leak Audit Report

**Date:** 2026-08-16  
**Scope:** Surgical P0/P1 fixes from the hostile audit. **Not** a new product feature.  
**Untouched:** RiskEngine gate **order**, ChiefTrader consensus math, VectorBT research harness.  
**Verification:** `npx tsc --noEmit` exit 0. `npx vitest run` **977/977** (151 files).

---

## 1. Encryption fail-closed

**Was:** `EncryptionService.encrypt` / `decrypt` caught errors and **returned the input string**. `decrypt` also returned plaintext when the value had no `iv:hex` colon.

**Now (`src/server/core/EncryptionService.ts`):**

- Empty string still passes through (no secret).
- Encrypt failure throws `Error('ENCRYPTION_FAILED')`.
- Decrypt of non-`iv:hex` or garbage ciphertext throws `Error('DECRYPTION_FAILED')`.
- Decrypt **never** returns the raw input on failure.

**Callers:**

- `AIRouter.initialize` skips a provider on `DECRYPTION_FAILED` instead of crashing the process.
- `BrokerManager.initialize` refuses to treat a failed decrypt as a usable key (no plaintext fallback).

**Tests:** `src/server/core/EncryptionService.test.ts`.

---

## 2. Plaintext `data/secrets.json` removed from the boot path

**Was:** `server.ts` read `data/secrets.json` at boot, copied keys into `process.env`, and `PUT /api/v1/secrets` wrote the file (mode 0o600, still plaintext).

**Now:**

- File is **not** read or written.
- If the file still exists on disk, boot logs a warning that it is ignored.
- `PUT /api/v1/secrets` encrypts allowlisted keys into SQLite via `persistAllowlistedSecrets()`:
  - Alpaca / Questrade → `broker_connections`
  - Gemini / OpenAI / Anthropic / Mistral → `ai_providers`
  - Finnhub / FRED → `news_providers`
- Process env is updated **in-memory** for the current process only (so MarketDataWorker can see new Alpaca keys without a second plaintext store).
- `GET /api/v1/secrets` reports configured/masked status from env and DB presence, never dumps secrets.

`.env` remains the operator source for keys that were never stored in SQLite. That is not a plaintext JSON secrets file.

---

## 3. Unauthenticated mutating API lockdown

**Was:** `AUTH_PASSWORD` unset → `isAuthed` returned true for every `/api/*` request (LAN-open toggle/liquidate/settings).

**Now (`AuthConfig.ts` + `server.ts` `isAuthed`):**

- Production still **refuses to boot** without `AUTH_PASSWORD`.
- Development without password:
  - **GET/HEAD/OPTIONS** still allowed (local UI reads).
  - **POST/PUT/PATCH/DELETE** on `/api/v1/*` and `/api/v2/*` require:
    - loopback (`127.0.0.1` / `::1`), **or**
    - header `X-Argus-Dev-Token` matching `ARGUS_DEV_TOKEN` (generated at boot if unset; logged once).
- `/api/v1/auth/*` remains reachable so login is not blocked when a password is later configured.

Supertest and the local SPA on the same machine remain loopback. Remote mutating calls without the token get **401**.

**Tests:** `AuthConfig.test.ts` lockdown describe block.

---

## 4. Alpaca live URL paper-reset

**Was:** `authenticate()` without `credentials.isLive` **always** set `https://paper-api.alpaca.markets`, wiping a prior `liveTrading()`.

**Now:**

- `paperTrading()` / `liveTrading()` set both `isPaper` and `baseUrl`.
- `authenticate()`:
  - `isLive === true` or `tradingMode === 'LIVE'` → live host.
  - `isLive === false` or `tradingMode === 'PAPER'` → paper host.
  - **omitted** → leave the URL already set by `liveTrading()` / `paperTrading()`.
- `BrokerManager` passes `isLive: connection.paperMode === false`. Env-only Alpaca uses `settings.tradingMode === 'LIVE'`.

**Tests:** `src/brokers/AlpacaBroker.authenticate.test.ts`.

---

## 5. Inbound broker orders skipping RiskEngine

**Was:** `OMS.reconcileInboundBrokerOrders` inserted **FILLED** `trades` + `fills` for broker orders with no local row (manual/external or crash-before-insert), which PortfolioMonitor could then manage.

**Now:**

- Unrecognized inbound fills are inserted as `status: 'EXTERNAL_MANUAL'`.
- `reasoning` includes `SOURCE: EXTERNAL_MANUAL`.
- **No** `fills` rows, **no** portfolio update, **no** auto-manage.
- Critical `console.error` + webhook type `external_manual_order`.
- `EXTERNAL_MANUAL` is a terminal OMS status so follow-up / cancel-all do not treat it as a working Argus order.

Argus-originated crash recovery of rows that **already** exist locally (`reconcileStaleOrders` / `clientOrderId` match) is unchanged and still does not skip RiskEngine on the original path.

**Tests:** `OrderManagement.lifecycle.test.ts`.

---

## 6. Dual Alpaca sockets (data divergence)

**Was:** `MarketDataWorker` IEX WS for ideas **and** `server.ts` `initializeAlpacaWebSocket()` `liveQuotes` feeding `BrokerManager.tick()` every 1s. Two sockets, two last prices.

**Now:**

- Legacy **quotes** WebSocket in `server.ts` is **deleted** (`liveQuotes` / `alpacaWs` gone).
- Alpaca **news** stream in `server.ts` is unchanged (not used for InternalPaper fills).
- `InternalPaperBroker.tick()`:
  1. `BrokerManager` listens to EventBus `MARKET_DATA` (payload `{ symbol, price }` from the worker).
  2. The existing 1s interval ticks from `marketDataWorker.getLatestPrices()` — **same process, same IEX cache**, so Autobot-off pending paper orders can still fill without re-opening idea-generation `MARKET_DATA` (Phase 19 gate stays).
- `GET /api/v1/alpaca/quote` reads the worker cache, not `liveQuotes`.

There is **one** IEX quote socket: `MarketDataWorker`.

---

## 7. News veto scale + JSON symbol match

**Gate order unchanged.** Comparison math only.

- Stored `news_clusters.impactScore` is 0–1 from `NewsImpactEngine`; threshold is 80.
- `newsImpactOnVetoScale`: values `<= 1` are multiplied by 100; values already on 0–100 are left as-is (existing tests that insert 95 still work).
- `clusterCoversSymbol` parses `symbols` as a JSON array and uses **strict** equality (`"A"` does not match `"AAPL"`). Invalid JSON does not fall back to substring `includes`.

Same scale helper is used in `PitRiskEngine` so PIT news veto is not a second, unscaled comparison.

**Tests:** `newsClusterMatch.test.ts`, extra cases in `RiskEngine.test.ts`.

---

## 8. Dead `BrokerEngine`

Deleted:

- `src/server/broker/BrokerEngine.ts` (unused duplicate; default EventBus import was not the live singleton).
- `src/server/broker/BrokerPlugin.ts` (only referenced by that engine).

Live brokers remain `src/brokers/BrokerManager.ts` + adapters.

---

## 9. What this phase did **not** do

- Did not enable LIVE, QUANT, or SMC.
- Did not claim a trading edge.
- Did not flatten positions on EXTERNAL_MANUAL (operator must reconcile at the broker).
- Did not lock GET APIs in local no-password mode (mutating only).
- Did not auto-delete an existing `data/secrets.json` on disk (ignored, not silently destroyed).

---

## 10. Operator notes

1. Move keys from any leftover `secrets.json` into Settings → encrypted broker/AI rows, or `.env`, then delete the file yourself.
2. Set `AUTH_PASSWORD` (and `AUTH_SESSION_SECRET`) before binding the API to a non-loopback network.
3. If you previously stored **plaintext** in `broker_connections.api_key_encrypted`, decrypt will now fail until you re-save credentials through the config form (which encrypts).
4. Manual broker fills will show as `EXTERNAL_MANUAL` in `trades` and will not be Argus-managed until you act.
