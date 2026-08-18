# ARGUS Defect Catalog

**Audit date:** 2026-08-17  
**Remediation date:** 2026-08-17  
**Scope:** Domains A–F (lifecycle, OMS, RiskEngine, network/AI, DB, frontend/WS)  
**Mode:** Adversarial / Day-1 informed  
**Pipeline invariant:** EventBus → ChiefTrader → RiskEngine → OMS → Broker (never bypass)

---

## Summary

| Severity | Total | Fixed | By design / documented |
|----------|-------|-------|------------------------|
| CRITICAL | 2 | 2 | 0 |
| HIGH | 5 | 5 | 0 |
| MEDIUM | 8 | 7 | 1 (DEF-08 fail-closed) |
| LOW | 4 | 3 | 1 (DEF-18 WAL concurrent open) |
| **Total** | **19** | **17** | **2** |

---

## Domain A — Lifecycle / startup / async

### DEF-01 · Boot reconciliation compares InternalPaper before real broker

| Field | Value |
|-------|-------|
| **File:line** | `server.ts:317–329` |
| **Severity** | HIGH |
| **Status** | **FIXED** |
| **Root cause** | `tradingEngine.initialize()` started `PortfolioReconciliation` before `BrokerManager.initialize()` swapped in Alpaca. First cycle compared real DB rows against InternalPaper's empty portfolio → `MISSING_REMOTELY` / cleared rows → `TRADING_PAUSED`. |
| **Why tests missed it** | Integration tests use InternalPaper end-to-end; no test booted with persisted `autoBotEnabled=true` + Alpaca credentials until Day-1 soak. |
| **Fix strategy** | `await BrokerManager.getInstance().initialize()` before `tradingEngine.initialize()`. |

### DEF-02 · Reconciliation boot warmup guard defined but never applied

| Field | Value |
|-------|-------|
| **File:line** | `src/server/core/startup.ts:20–27`, `PortfolioReconciliation.ts:223` |
| **Severity** | HIGH |
| **Status** | **FIXED** |
| **Root cause** | `isReconciliationWarmupActive()` and `reconciliationBootWarmupMs` (15s) were added to config but `reconcile()` still paused on any significant mismatch during the first cycles after boot — compounding DEF-01 false alarms. |
| **Why tests missed it** | `startup.ts` had zero consumers; reconciliation tests never advanced boot timestamp. |
| **Fix strategy** | Suppress `setTradingState('TRADING_PAUSED')` while warmup active; still sync positions and persist mismatch rows. Regression: `PortfolioReconciliation.warmup.test.ts`. |

### DEF-03 · AlpacaBroker retry backoff referenced undefined import

| Field | Value |
|-------|-------|
| **File:line** | `src/brokers/AlpacaBroker.ts:178` |
| **Severity** | CRITICAL |
| **Status** | **FIXED** |
| **Root cause** | Refactor from `ALPACA_RETRY_BASE_DELAY_MS` to `networkReconnectDelayMs()` left the function call in place without importing `reconnectBackoff.ts`. Any Alpaca retry path threw `ReferenceError`. |
| **Why tests missed it** | Reliability tests stub `fetch` and advance fake timers; successful first-attempt paths never hit retry branch in CI. |
| **Fix strategy** | `import { networkReconnectDelayMs } from '../server/core/reconnectBackoff'`. |

### DEF-04 · MarketDataWorker reconnect used removed `RECONNECT_MS` constant

| Field | Value |
|-------|-------|
| **File:line** | `src/server/services/MarketDataWorker.ts:220–227` |
| **Severity** | HIGH |
| **Status** | **FIXED** |
| **Root cause** | Intermediate edit replaced fixed 5s timer with `ReconnectBackoff` but left a stale `RECONNECT_MS` reference on error/close handlers. |
| **Why tests missed it** | Tests calling `connectAlpaca()` directly hit the broken close handler. |
| **Fix strategy** | Use `ReconnectBackoff.nextDelayMs()` via `scheduleReconnect()`. |

---

## Domain B — OMS / idempotency

### DEF-05 · Order submit without `client_order_id` not safely retried

| Field | Value |
|-------|-------|
| **File:line** | `src/brokers/AlpacaBroker.ts:325–340`, `OrderManagement.ts:346–355` |
| **Severity** | HIGH |
| **Status** | **FIXED** |
| **Root cause** | Timeout on POST `/v2/orders` without idempotency key could duplicate live orders on blind retry. |
| **Why tests missed it** | Covered only after Phase 1 hardening added explicit `idempotentRetrySafe` flag tied to `clientOrderId`. |
| **Fix strategy** | OMS always passes `clientOrderId`; AlpacaBroker sets `idempotentRetrySafe=true` only when key present. Tests: `OrderManagement.test.ts`, `OrderManagement.crashRecovery.test.ts`. |

### DEF-06 · PENDING rows after crash before `brokerOrderId` recorded

| Field | Value |
|-------|-------|
| **File:line** | `OrderManagement.ts:88–141`, `617–665` |
| **Severity** | MEDIUM |
| **Status** | **FIXED** |
| **Root cause** | Process crash between broker accept and DB update left orphan PENDING rows; follow-up only polled rows with `brokerOrderId`. |
| **Why tests missed it** | Requires simulating crash mid-submit; added in `OrderManagement.crashRecovery.test.ts`. |
| **Fix strategy** | `reconcileStaleOrders()` looks up by `client_order_id` on boot + interval. |

---

## Domain C — RiskEngine (24 gates + PositionSizing)

### DEF-07 · Reconciliation set wrong pause flag (emergencyStopActive)

| Field | Value |
|-------|-------|
| **File:line** | `PortfolioReconciliation.ts:211–221` (historical) |
| **Severity** | CRITICAL |
| **Status** | **FIXED** |
| **Root cause** | `emergencyStopActive` was set directly; RiskEngine `emergency_stop` gate reads `tradingState`. Mismatches logged but orders not blocked. |
| **Why tests missed it** | Unit tests checked flag mutation, not end-to-end RiskEngine rejection. |
| **Fix strategy** | `tradingEngine.setTradingState('TRADING_PAUSED', …)`. Test: `PortfolioReconciliation.tradingBlock.test.ts`. |

### DEF-08 · Null quote age treated as stale (fail-closed)

| Field | Value |
|-------|-------|
| **File:line** | `src/server/core/marketDataQuality.ts`, `RiskEngine.ts` (data_freshness gate) |
| **Severity** | MEDIUM |
| **Status** | **BY DESIGN** (fail-closed — not weakened) |
| **Root cause** | No tick ever received → `getLatestPriceAgeMs()` returns null → gate blocks. Day-1: 14 `DATA_STALE` with zero organic trades. |
| **Why tests missed it** | Tests mock fresh quotes; E2E does not certify live Alpaca WS. |
| **Fix strategy** | Operational: certify MarketDataWorker WS at RTH open. Weakening this gate would allow orders on missing prices. |

### DEF-09 · order_rate_limit count-then-insert race

| Field | Value |
|-------|-------|
| **File:line** | `RiskEngine.ts`, `RiskEngine.concurrency.test.ts:113` |
| **Severity** | MEDIUM |
| **Status** | **FIXED** |
| **Root cause** | Concurrent evaluations could both pass rate limit before either inserted assessment row. |
| **Why tests missed it** | Sequential tests never interleaved evaluations. |
| **Fix strategy** | Serialized evaluation queue + concurrency test proving exact pass count. |

---

## Domain D — External network / TLS / AI

### DEF-10 · `alpacaTls.ts` imported missing `undici` package

| Field | Value |
|-------|-------|
| **File:line** | `src/server/core/alpacaTls.ts:7` (historical) |
| **Severity** | CRITICAL |
| **Status** | **FIXED** |
| **Root cause** | TLS fallback used `undici` Agent/fetch but `undici` is not a declared dependency. Any import of `alpacaTls` failed module resolution. |
| **Why tests missed it** | Full suite cached passing modules; isolated import of MarketDataWorker exposed failure. |
| **Fix strategy** | Replace undici with `node:https` + system CA. Regression: `alpacaTls.test.ts`. |

### DEF-11 · Alpaca REST TLS verification fails on Windows without system CA

| Field | Value |
|-------|-------|
| **File:line** | `src/brokers/AlpacaBroker.ts:184`, `RiskEngine.ts:30` |
| **Severity** | HIGH |
| **Status** | **FIXED** |
| **Root cause** | Node default CA store missing corporate/system roots → `UNABLE_TO_VERIFY_LEAF_SIGNATURE` on Alpaca paper API. |
| **Why tests missed it** | CI/Linux environments have complete CA bundles; Windows dev installs do not. |
| **Fix strategy** | Route Alpaca HTTP through `alpacaFetch()` with system CA fallback. |

### DEF-12 · MarketDataWorker WebSocket missing system CA

| Field | Value |
|-------|-------|
| **File:line** | `MarketDataWorker.ts:234` |
| **Severity** | HIGH |
| **Status** | **FIXED** |
| **Root cause** | `new WebSocket(url)` without CA options failed TLS same as REST on Windows. |
| **Why tests missed it** | Tests mock `ws` module; no live TLS handshake. |
| **Fix strategy** | `new WebSocket(url, alpacaWebSocketTlsOptions())`. |

### DEF-13 · AlphaVantage 25 req/day quota exhausted by Fund + Macro

| Field | Value |
|-------|-------|
| **File:line** | `FundamentalAgent.ts`, `MacroAgent.ts`, `AlphaVantageBudget.ts` |
| **Severity** | MEDIUM |
| **Status** | **FIXED** |
| **Root cause** | MacroAgent fired 3 parallel AV calls per cache miss; Fund added 1. Shared free-tier 25/day quota exhausted → HOLD@0%. |
| **Why tests missed it** | Tests mock fetch; no quota budget integration test. |
| **Fix strategy** | Global `AlphaVantageBudget` (`tradingSafety.alphaVantageDailyRequestBudget`); sequential Macro fetches; stale cache when budget exhausted. Tests: `AlphaVantageBudget.test.ts`. |

### DEF-14 · NewsEngine AI provider storm on invalid keys

| Field | Value |
|-------|-------|
| **File:line** | `NewsEngine.ts`, `AIRouter.ts` initialize |
| **Severity** | MEDIUM |
| **Status** | **FIXED** |
| **Root cause** | 10s news pipeline × LLM escalation × sequential failover. Day-1: 887/1387 AI calls failed. |
| **Why tests missed it** | Unit tests use single mock provider. |
| **Fix strategy** | Skip unconfigured (no-key, non-local) providers at boot; cap NewsEngine LLM calls per cycle (`newsLlmMaxCallsPerCycle`). |

### DEF-15 · AIRouter `routeConsensus` parallel-calls every enabled provider

| Field | Value |
|-------|-------|
| **File:line** | `AIRouter.ts` `routeConsensus` |
| **Severity** | MEDIUM |
| **Status** | **FIXED** |
| **Root cause** | Consensus debate fired N concurrent LLM calls with no per-cycle budget cap. |
| **Why tests missed it** | Consensus path rarely exercised in unit tests. |
| **Fix strategy** | Limit consensus to top-K healthy providers (`tradingSafety.consensusMaxProviders`). |

---

## Domain E — DB / schema / migrations

### DEF-16 · Failed migration swallowed; process booted on broken schema

| Field | Value |
|-------|-------|
| **File:line** | `src/server/db/index.ts:65–72` |
| **Severity** | HIGH |
| **Status** | **FIXED** |
| **Root cause** | `migrate()` catch logged and continued. |
| **Why tests missed it** | Tests use fresh temp DBs that always migrate cleanly. |
| **Fix strategy** | Re-throw on migration failure. |

### DEF-17 · Strategy engine tables migration untracked in journal

| Field | Value |
|-------|-------|
| **File:line** | `drizzle/0035_strategy_engine_tables.sql`, `drizzle/meta/_journal.json` |
| **Severity** | MEDIUM |
| **Status** | **FIXED** |
| **Root cause** | New SQL file risked drifting from the drizzle journal. |
| **Why tests missed it** | No journal consistency test. |
| **Fix strategy** | Journal already includes `0035_strategy_engine_tables`; regression `drizzleJournal.test.ts` asserts every journal tag has a SQL file. |

### DEF-18 · Second process opening `argus.db` false SQLITE_CORRUPT

| Field | Value |
|-------|-------|
| **File:line** | `src/server/db/index.ts:52` |
| **Severity** | LOW |
| **Status** | **MITIGATED / DOCUMENTED** |
| **Root cause** | WAL mode + concurrent open from backup script vs live server. |
| **Fix strategy** | `PRAGMA busy_timeout=5000`; export via checkpoint API (`GET /api/v1/system/export-db`); never parallel-write the live file. |

---

## Domain F — Frontend / WebSocket / mobile

### DEF-19 · App.tsx hooks run on login screen before auth gate

| Field | Value |
|-------|-------|
| **File:line** | `src/App.tsx` fetch/WS effects |
| **Severity** | MEDIUM |
| **Status** | **FIXED** |
| **Root cause** | Early return for Login is after most useEffects; ungated effects fire 401 fetches. |
| **Fix strategy** | Gate remaining fetch/WS effects on `isAuthenticated` (secrets, liquidate, sandbox, TRADE_IDEA, autonomous loop). |

### DEF-20 · WebSocketContext unstable subscribe caused infinite re-render

| Field | Value |
|-------|-------|
| **File:line** | `src/context/WebSocketContext.tsx:219–246` |
| **Severity** | HIGH |
| **Status** | **FIXED** |
| **Root cause** | Unstable context callbacks caused Maximum update depth exceeded. |
| **Fix strategy** | `useCallback` + `useMemo` for stable context value. |

### DEF-21 · WS reconnect backfill fetch may 401 on auth-enabled deploys

| Field | Value |
|-------|-------|
| **File:line** | `WebSocketContext.tsx` `backfillMissedEvents` |
| **Severity** | LOW |
| **Status** | **FIXED** |
| **Fix strategy** | `credentials: 'include'`; ignore HTTP 401. |

### DEF-22 · WebSocket connects before auth on login screen

| Field | Value |
|-------|-------|
| **File:line** | `WebSocketContext.tsx`, `App.tsx` |
| **Severity** | LOW |
| **Status** | **FIXED** |
| **Fix strategy** | `setEnabled(isAuthenticated)` — no `/ws` until session confirmed; disconnect on logout. |

---

## Day-1 Blocker Cross-Reference

| Day-1 ID | Catalog ID | Status |
|----------|------------|--------|
| B1 Boot recon race | DEF-01, DEF-02 | FIXED |
| B2 Alpaca TLS | DEF-10, DEF-11, DEF-12 | FIXED |
| B3 News/AI failures | DEF-14, DEF-15 | FIXED |
| B4 AlphaVantage limit | DEF-13 | FIXED |

---

## Remaining non-code items

- **DEF-08** — keep fail-closed `data_freshness`; certify Alpaca WS at RTH.
- **DEF-18** — do not open `data/argus.db` from a second process; use export/import APIs.
