# ARGUS Headless Architecture Audit (Phase 0)

**Date:** 2026-08-20  
**Scope:** Forensic baseline before headless/runtime hardening  
**Evidence grades:** CODE-VERIFIED · TEST-VERIFIED · RUN-VERIFIED · NOT VERIFIED · UNKNOWN

---

## Executive summary

Argus already separates **trading logic from React** (all spine code lives under `src/server/` with zero React imports). Phase B extracted `ArgusCoreBoot` and `ArgusApplication`. Phase C added HTTP-only CLI replay commands.

**Gap before this hardening pass:** No explicit `ArgusRuntime` lifecycle, no `/api/v2/runtime/*` contract, CLI could not start/stop the engine process, Vite was statically imported at `server.ts` load time even in headless mode.

**This pass adds:** `ArgusRuntime`, runtime API routes, CLI process lifecycle (`start`/`stop`/`restart`), dynamic Vite import, PID file management — without a second trading brain.

---

## Architecture map

```
Entry points
├── server.ts                    → Express + WS + optional Vite + bootCore()
├── scripts/start-headless.ts    → ARGUS_HEADLESS=true → server.ts
├── scripts/start-headless-prod.mjs → dist/server.cjs headless
└── scripts/argus-cli.ts         → HTTP client + optional spawn (NO trading imports)

Core (ONE brain)
├── ArgusCoreBoot.bootArgusCore()
├── ArgusRuntime (lifecycle facade)
├── ArgusApplication (adapter facade)
├── EventBus (singleton)
├── RiskEngine (singleton)
├── OMS (singleton) → sole production placeOrder caller
├── BrokerManager (singleton)
└── TradingEngine (singleton)

Adapters
├── Express /api/v2/*
├── WebSocket /ws
├── React/Vite (optional)
└── argus-cli.ts (HTTP + process spawn)
```

---

## Singleton audit

| Component | Construction | Grade |
|-----------|--------------|-------|
| eventBus | `EventBus.getInstance()` | CODE-VERIFIED |
| riskEngine | `RiskEngine.getInstance()` | CODE-VERIFIED |
| oms | `new OrderManagementService()` export | CODE-VERIFIED |
| BrokerManager | lazy `getInstance()` | CODE-VERIFIED |
| tradingEngine | `TradingEngine.getInstance()` | CODE-VERIFIED |
| marketDataWorker | module export | CODE-VERIFIED |

**placeOrder production path:** OMS only → `phase21.invariants.test.ts` TEST-VERIFIED

---

## CLI analysis

| Question | Answer | Grade |
|----------|--------|-------|
| CLI imports RiskEngine/OMS? | No — HTTP fetch only | TEST-VERIFIED |
| CLI can run without browser? | Yes, if headless server running | CODE-VERIFIED |
| CLI embeds trading brain? | No | TEST-VERIFIED |
| CLI start/stop process? | Added via `enginePid.ts` + spawn | CODE-VERIFIED |

---

## Browser ↔ backend coupling

| Direction | Finding | Grade |
|-----------|---------|-------|
| Server → React | Vite middleware gated by `isWebUiEnabled()`; now dynamic import | CODE-VERIFIED |
| Server → DOM | None in `src/server/` | CODE-VERIFIED |
| React → trading | UI uses HTTP/WS only; `App.tsx` never calls placeOrder | TEST-VERIFIED |
| React state → orders | No — operator commands hit API → TradingEngine.toggle | CODE-VERIFIED |

---

## Duplicate trading paths

| Path | Status |
|------|--------|
| Live spine | ChiefTrader → RiskEngine → OMS → BrokerManager |
| Replay | FullArgusReplayEngine → RiskEngine → OMS → HistoricalReplayBroker |
| VectorBT | Research only — cannot place production orders |
| Extension zones | architecture.protection TEST-VERIFIED — no placeOrder |

---

## Headless capability matrix

| Capability | Before | After this pass |
|------------|--------|-----------------|
| Core boot without Vite mount | Partial (static Vite import) | Dynamic import |
| `/api/v2/runtime/*` | Missing | Added |
| CLI `start`/`stop` | Missing | Added |
| Express optional | No | Still required for CLI/API |
| Standalone core-only process | No | Still no (by design: incremental) |

---

## Process isolation

| Concern | Mitigation | Grade |
|---------|------------|-------|
| LIVE + REPLAY concurrent | createReplayRun refuses LIVE | TEST-VERIFIED |
| Replay → live market cache | HistoricalReplayMarketDataContext | TEST-VERIFIED |
| Multi-process same SQLite | Not supported — documented | CODE-VERIFIED |

---

## Remaining limitations (honest)

1. **Single Node process** — engine + Express + WS coexist; not a separate daemon binary yet.
2. **`API_ENABLED=false`** — flag exists but Express is not skipped.
3. **CLI `start`** spawns full `server.ts`, not core-only entry.
4. **Multi-process** — not verified; one writer per `argus.db`.

---

## Related documents

- `ARGUS_HEADLESS_ARCHITECTURE.md` — Phase B baseline
- `ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md` — post-hardening runtime doc
- `ARGUS_CLI.md` — operator commands
- `ARGUS_HEADLESS_RUNTIME_FINAL_AUDIT.md` — evidence summary
