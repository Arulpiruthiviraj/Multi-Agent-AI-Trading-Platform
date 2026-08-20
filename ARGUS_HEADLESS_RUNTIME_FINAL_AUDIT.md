# ARGUS Headless Runtime — Final Audit

**Date:** 2026-08-20  
**Phase:** Headless Trading Engine / CLI Architecture Hardening

## 1. Executive summary

Incremental hardening on Phase B/C: explicit **`ArgusRuntime`** lifecycle, **`/api/v2/runtime/*`** contract, first-class **CLI process commands** (`start`/`stop`/`restart`), **dynamic Vite import** for true headless boot without loading Vite module graph, and **PID file** management.

**ONE trading brain preserved.** No second RiskEngine, OMS, or placeOrder path.

## 2. Before / after architecture

**Before:**
- `ArgusApplication` owned boot phase inline
- No `/api/v2/runtime/*`
- CLI: HTTP only, no process lifecycle
- Static `import vite` at server load

**After:**
```
ArgusRuntime → ArgusCoreBoot → production spine
ArgusApplication → delegates to ArgusRuntime
Express routes → argusRuntime / argusApplication (no trading logic in routes)
argus-cli → HTTP + spawn (no trading imports)
```

## 3. Files changed (primary)

| File | Change |
|------|--------|
| `src/server/core/ArgusRuntime.ts` | Full lifecycle class |
| `src/server/app/ArgusApplication.ts` | Delegates to ArgusRuntime |
| `src/server/app/enginePid.ts` | PID file for CLI |
| `src/server/routes/v2Runtime.ts` | Runtime API |
| `src/server/routes/v2System.ts` | Mount runtime + aliases |
| `scripts/argus-cli.ts` | start/stop/restart + commands |
| `server.ts` | Dynamic Vite import |
| Tests + docs | See below |

## 4. Trading-path verification

| Invariant | Grade |
|-----------|-------|
| ONE RiskEngine | TEST-VERIFIED |
| ONE OMS | TEST-VERIFIED |
| ONE placeOrder production caller | TEST-VERIFIED (phase21) |
| CLI no trading imports | TEST-VERIFIED |
| v2Runtime no placeOrder | TEST-VERIFIED |
| Replay isolation preserved | TEST-VERIFIED (Phase C) |

## 5. CLI verification

| Command | Grade |
|---------|-------|
| status/health/config/positions/trades | CODE-VERIFIED |
| start/stop/restart (spawn) | CODE-VERIFIED |
| replay subcommands | CODE-VERIFIED (Phase C) |
| End-to-end start on clean port | **NOT VERIFIED** (port 3000 in use during run) |

## 6. Browser independence

| Item | Grade |
|------|-------|
| Core boots without Vite middleware | TEST-VERIFIED (ArgusCoreBoot.test) |
| Vite not statically imported | CODE-VERIFIED |
| Headless log shows core boot | RUN-VERIFIED (partial — exited on EADDRINUSE) |
| Browser disconnect stops trading | CODE-VERIFIED (by design: WS is client-only) |

## 7. Safety verification

- Enable/disable → `TradingEngine.toggle()` — CODE-VERIFIED
- Kill switch → existing `/api/v1/system/emergency-stop` — CODE-VERIFIED
- Runtime stop → pause + disable Autobot — TEST-VERIFIED
- LIVE + replay guard — TEST-VERIFIED (unchanged)

## 8. Test results

```
npm test: 284 files, 1800 tests PASS (+5 new)
npm run build: PASS
npm run lint: pre-existing argus-ecosystem-status.ts failure only
```

## 9. Runtime execution evidence

Headless prod start attempted:

```
Argus Core boot complete — DB initialized and state loaded.
Address in use, exiting...
```

**Grade:** Core boot **RUN-VERIFIED**; full listen + CLI probe **NOT VERIFIED** (port conflict in environment).

## 10. Remaining limitations

1. Engine + Express remain **one Node process** — not a separate core-only binary.
2. `API_ENABLED=false` does not skip Express yet.
3. CLI `start` spawns full server, not core-only daemon.
4. Single SQLite writer — no multi-process cluster.

## 11. Exact next steps

1. Dedicated `scripts/argus-engine.ts` entry (core + optional API flag) without loading unused server routes.
2. Enforce `API_ENABLED=false` to skip HTTP when embedding core elsewhere.
3. Windows service / systemd unit for `start:headless:prod`.
4. RUN-VERIFIED on clean port: `argus start` → `argus health` → `argus stop`.

---

*Browser optional. CLI first-class. ONE trading brain.*
