# ARGUS Phase D — Engine Daemon Final Audit

**Date:** 2026-08-20  
**Scope:** Dedicated engine daemon wrapping the existing Argus Core.  
**Living architecture:** [`ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`](ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md)  
**Binding:** `ARGUS_ARCHITECTURE_CONTRACT.md` §15  

Evidence grades: **CODE-VERIFIED** · **TEST-VERIFIED** · **RUN-VERIFIED** · **NOT VERIFIED**.

This audit does **not** claim LIVE readiness, organic edge, or a second trading brain.

---

## 1. Executive summary

Phase D adds a dedicated daemon entry that boots the **same** Argus Core used in browser mode:

- `scripts/argus-engine.ts` / `scripts/argus-engine-prod.mjs`
- `scripts/start-headless.ts` and `start-headless-prod.mjs` **delegate** to those entries
- `ArgusEngineRuntime` wraps `ArgusRuntime` (status/health/stop) — **not** a second OMS/RiskEngine
- Vite is dynamically imported and gated by `isWebUiEnabled()`
- WebSocket is optional (`WS_ENABLED`); disconnect does not stop the engine
- PID file `data/.argus_engine.pid` with stale-PID reclaim
- CLI remains HTTP for trading control; `start`/`stop`/`restart` are process spawn/SIGTERM only

Express typically remains in the **same Node process** (HTTP adapter). Historical Evaluation / `FullArgusReplayEngine` unchanged.

**Verification (Phase D complete):** `npm test` — **1814 tests PASS** · `npm run build` — **PASS**. LIVE remains **LIVE_NO_GO**. Organic paper FILLED SELL P&L remains **0**.

---

## 2. Architecture (code)

```
scripts/argus-engine.ts
  → claimEnginePid(process.pid)
  → import server.ts
       → ArgusRuntime / ArgusCoreBoot (ONE spine)
       → Express /api/* (same process)
       → WS if isWebSocketAdapterEnabled()
       → Vite only if isWebUiEnabled()  [dynamic import('vite')]
```

| Claim | File evidence | Grade |
|-------|----------------|-------|
| Dedicated daemon entry | `scripts/argus-engine.ts` sets `ARGUS_HEADLESS` + `ARGUS_ENGINE`, claims PID, imports `server.ts` | CODE-VERIFIED |
| Prod daemon | `scripts/argus-engine-prod.mjs` → `dist/server.cjs` | CODE-VERIFIED |
| Headless aliases delegate | `start-headless.ts` → `argus-engine.ts`; `start-headless-prod.mjs` → `argus-engine-prod.mjs` | CODE-VERIFIED |
| npm scripts | `package.json`: `start:engine`, `start:engine:prod`; headless scripts preserved | CODE-VERIFIED |
| Wrapper is not a second brain | `ArgusEngineRuntime.ts` imports `argusRuntime` only; architecture tests forbid RiskEngine/OMS/Broker imports | TEST-VERIFIED |
| Vite not a static required import | `server.ts` `await import('vite')` inside `isWebUiEnabled()` | TEST-VERIFIED |
| WS optional | `runtimeConfig.isWebSocketAdapterEnabled()`; `WS_ENABLED !== 'false'` | CODE-VERIFIED |
| WS close does not drain engine | architecture test asserts no `drainTradingProcess` / `system.stop` on close | TEST-VERIFIED |
| PID + stale reclaim | `enginePid.ts` `reconcileEnginePidFile` / `claimEnginePid` | CODE-VERIFIED |
| CLI spawn engine, no trading imports | `argus-cli.ts` spawn `argus-engine.ts`; no RiskEngine/OMS/Broker imports | TEST-VERIFIED |
| Full suite / production build | `npm test` 1814 PASS; `npm run build` PASS | TEST-VERIFIED / RUN-VERIFIED |

---

## 3. What Phase D did **not** change

| Item | Status |
|------|--------|
| Live path EventBus → ChiefTrader → RiskEngine → OMS → BrokerManager | Unchanged |
| 24 gates / consensus 0.75 / min-2 | Unchanged |
| `FullArgusReplayEngine` / Historical Evaluation | Unchanged (Phase C) |
| LIVE | **LIVE_NO_GO** |
| Organic PAPER FILLED SELL P&L | **0** (not soak evidence) |

---

## 4. CLI honesty

- Trading/observability commands: HTTP to `/api/v2/runtime/*` (and kill-switch on v1).
- `argus start` / `stop` / `restart`: OS process lifecycle, not a parallel engine.
- Replay subcommands: HTTP to `/api/v2/historical-evaluations` — still not a trading brain.

---

## 5. Safety

| Invariant | Grade |
|-----------|-------|
| ONE production `placeOrder` (OMS) | TEST-VERIFIED (`phase21.invariants.test.ts` in suite) |
| Enable/disable via `TradingEngine.toggle()` | CODE-VERIFIED |
| Replay refused when `tradingMode === LIVE` | TEST-VERIFIED (Phase C suite) |
| Browser not required | CODE-VERIFIED (`isWebUiEnabled` false when headless/engine) |

---

## 6. Docs consolidated into this audit

Interim Phase B headless architecture/audit stubs were deleted after consolidation into this file and [`ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`](ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md).

Phase C historical-evaluation evidence: `ARGUS_PHASE_C_HISTORICAL_EVALUATION_FINAL_AUDIT.md` (replay, not daemon).
