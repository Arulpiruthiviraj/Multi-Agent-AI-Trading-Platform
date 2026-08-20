# ARGUS NO-TRADE REMEDIATION STATUS

**Date:** 2026-08-20  
**Source audit:** `ARGUS_LIVE_NO_TRADE_FORENSIC_AUDIT.md`  
**Scope:** Safe remediations only â€” no consensus floor changes, no RiskEngine/OMS bypass, no LIVE arming.

## Explicit safety floors (unchanged)

| Knob | Value | Status |
|---|---|---|
| `tradingSafety.consensusApprovalThreshold` | **0.75** | Unchanged |
| `tradingSafety.minIndependentAgreeingAgents` | **2** | Unchanged |
| `PAPER_TRADING_ONLY` | keep `true` | Unchanged |
| LIVE arming / `evaluateLiveReadiness` | `LIVE_NO_GO` | Unchanged |
| TradingAgents | inspiration only | Not wired as order path |

## Implemented (code)

### 1. Kronos / Chronos unavailable (audit secondary O)

- `KronosModelManager.markUnavailable()` fail-closed on **hard** service failures only; immediately schedules `/health` refresh so a recovered Chronos clears the latch.
- `KronosEngine` classifies forecast errors (`kronosFailureKind.ts`): **transient** timeouts/aborts do **not** global-latch; **hard** connection/HTTP failures still `markUnavailable`.
- `KronosForecastAgent` **does not** `emitTradeIdea` when Chronos `/health` is down or the forecast call fails; publishes `KRONOS_UNAVAILABLE` telemetry (HOLD / confidence 0) instead. Per-symbol prediction cooldown still applies after a timeout.
- Regressions: `src/server/services/KronosForecastAgent.test.ts`, `src/server/engines/kronos/kronosFailureKind.test.ts`

### 1b. Kronos research/UI path (2026-08-20 follow-up)

**Root causes (why `:8008` was idle during RTH / dashboard showed DATA_UNAVAILABLE):**

1. **Autobot gate blocked the entire tick path** — `isLiveIdeaGenerationEnabled()` returned before buffering ticks or calling `/forecast`, so Chronos never ran when Autobot was off or session hold was active.
2. **Agent only armed with Autobot** — `KronosForecastAgent.start()` lived inside `SystemBootstrap` / idea-worker arming; no boot-time listener (unlike News clustering / MarketDataWorker).
3. **Dashboard hard-coded DATA_UNAVAILABLE** — Historical Performance + ATR chart never called an API; hardware fields stayed `--` because Python `/health` did not report device/memory/latency.

**Fixes (PAPER-safe; consensus 0.75 / min-2 unchanged; ideas still fail-closed when Chronos down):**

- Boot: `ArgusCoreBoot` starts `kronosForecastAgent` when pipeline-enabled; `pipelineAgents.json` marks `KronosEngine` `keepsBackgroundPipeline: true`.
- Forecasts (persist to `kronos_predictions` + `agent_predictions` with confidence + price trajectory) run whenever Chronos is healthy + ≥`kronosMinHistory` ticks; **`emitTradeIdea` still requires live idea generation**.
- APIs: `GET /api/v1/kronos/status|metrics|forecast`; UI wires metrics from `prediction_outcomes` and chart from latest stored forecast.
- `scripts/local_ai_service.py` reports `device` / `memoryUsage` / `gpuUsage` / `latencyMs` (CPU/MPS → `N/A (CPU/MPS)`).
- Latch fix (2026-08-20): CPU multi-symbol fan-out timeouts no longer permanently kill all Kronos via global `markUnavailable`; fail-closed for that forecast only.
- Tests: `KronosForecastAgent.test.ts`, `KronosDashboardData.test.ts`, `kronosFailureKind.test.ts`

**Runtime verification (2026-08-20 ~13:39–13:45 ET, PAPER / LIVE_NO_GO):**

- Chronos :8008/health — **RUN-VERIFIED**. status=ok, model=amazon/chronos-t5-mini, device=cpu, memoryUsage present, gpuUsage=N/A (CPU/MPS), lastInferenceMs observed after inference (e.g. ~263–718 ms). Chronos PID **16268** (python `local_ai_service`).
- Argus headless — **RUN-VERIFIED**. `./argus start --headless` with `PAPER_TRADING_ONLY=true`. Engine PID **11880** (listener on :3000); spawn wrapper observed as **18740**. `GET /api/v2/runtime/health` ok; tradingMode PAPER; liveReadiness **LIVE_NO_GO**.
- KronosForecastAgent boot start — **RUN-VERIFIED** earlier same day in logs (independent of Autobot).
- Live forecast path — **RUN-VERIFIED** earlier same day (pre-exit): KRONOS_FORECAST_* for multiple symbols; timeouts fail-closed per symbol (post-fix: no global latch on TimeoutError).
- Consensus unchanged — still NO_TRADE under 0.75 / min-2.
- GET `/api/v1/kronos/status|metrics|forecast` (session cookie after `./argus login`) — **RUN-VERIFIED** (all HTTP 200):
  - status: Ready, isAvailable=true, version=amazon/chronos-t5-mini, device=cpu, serviceUrl=http://127.0.0.1:8008, forecastHorizon=5, timeframe=tick
  - metrics: source=prediction_outcomes, sampleSize=2690, directionalAccuracy≈0.48, unavailableReason=null
  - forecast: available=true, symbol=META, prediction=SELL, confidence=0.85, model=amazon/chronos-t5-mini (local), series length=5, unavailableReason=null
- Note: Autobot was **ENABLED** on the Kronos API-verify headless restart (PID ~11880); operator preference is OFF unless intending supervised ideas. **2026-08-20 follow-up:** ./argus disable exit **0** — Autobot left **OFF** (PAPER, LIVE_NO_GO; KronosEngine still available/HEALTHY). Engine not stopped; no kill-switch. Forecasts do not require Autobot after boot-start fix; ideas still gated.
- Wealth vortex settings smoke — **RUN-VERIFIED** earlier: vitest `wealthVortexStore.test.ts` → 4/4 passed.
- Latch unit tests — **RUN-VERIFIED**: `kronosFailureKind.test.ts` + `KronosForecastAgent.test.ts` → 10/10 passed.

**Remaining blockers (operator / ops, not consensus/RiskEngine bypasses):**

1. Chronos CPU latency under multi-symbol fan-out can still timeout **individual** forecasts (expected; now per-symbol fail-closed, not global latch).
2. HuggingFace SSL noise on FinBERT warm load (cert verify) — Chronos still came up; watch cold starts.
3. Autobot left **OFF** after Kronos API verify (./argus disable exit 0 on PID 11880) — leave OFF unless intending supervised paper ideas.

### 2. NVDA `quant_target_price` ~$121.90 (forensic â†’ code bug)

**Root cause (DATA + CODE):** PortfolioMonitor selected the newest `FILLED BUY` by `filled_at` **without excluding `REPLAY`**. Live NVDA holding was `EXTERNAL_SYNC` @ ~$206.85 (null quant target). Overnight REPLAY fills @ ~$114.22 with `quant_target_price=121.9` won the lookup â†’ perpetual `TARGET_REACHED` at live ~$216.

**Fix:**

- `resolveOpeningTradeForLiveExit()` excludes `REPLAY` / `BACKTEST` / `SIMULATION` / historical / telemetry envs (and replay trace prefix).
- Long targets at/below average entry are ignored (warn only) â€” no silent rewrite that forces sells.
- Regressions in `PortfolioMonitor.test.ts`

### 3. Quant Alpaca 429

- `HistoricalDataGateway.ensureBars` arms a **shared** in-process backoff on HTTP 429 (honors `Retry-After`, else `alpacaCircuitBreakerCooldownMs`); subsequent symbols fail closed without further Alpaca calls.
- `QuantSignalAgent.runCycle` aborts the rest of the symbol fan-out on 429 / rate-limit errors (no idea storm).
- Regression in `HistoricalDataGateway.test.ts`

## Remains operator-only

| Item | Action |
|---|---|
| **`news_veto` on NVDA exits** | Wait for `newsVetoWindowMs` expiry or archive/resolve high-impact clusters â€” **do not** bypass RiskEngine |
| **Chronos `:8008`** | Keep `npm run ai:serve` / Chronos up for honest forecasts. Ideas still fail-closed if `/health` is down. Single-symbol CPU timeouts no longer global-latch Kronos (code fix 2026-08-20). |
| **Alpaca bars budget** | Reduce concurrent Quant/universe pressure if 429s persist; backoff is fail-closed, not a free pass |
| **AI debate providers** | Restore at least one consensus provider if debate should contribute (still must clear 0.75 / min-2) |
| **Autobot / RTH** | Operator-supervised paper only; Autobot off when not intending ideas |
| **Runtime hygiene** | Single Argus writer; clean SIGTERM; ignore stale `.argus_dev.pid` |
| **Soak / edge** | Organic PAPER FILLED SELL P&L still **0** â€” remediations do not claim edge |

## Not done (by design)

- Did **not** lower consensus thresholds to â€œget tradesâ€
- Did **not** weaken `news_veto`, RiskEngine, or OMS
- Did **not** enable LIVE or disable `PAPER_TRADING_ONLY`
- Did **not** rewrite stored REPLAY `quant_target_price` rows (research ledger stays intact)

