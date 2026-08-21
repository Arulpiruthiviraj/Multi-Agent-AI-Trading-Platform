# ARGUS NO-TRADE REMEDIATION STATUS

**Date:** 2026-08-20  
**Source audit:** `ARGUS_LIVE_NO_TRADE_FORENSIC_AUDIT.md`  
**Scope:** Safe remediations only — no consensus floor changes, no RiskEngine/OMS bypass, no LIVE arming.

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

### 1c. Chronos concurrency + latency alias (2026-08-20 secondary)

- **Concurrency:** `KronosInference` serializes Chronos `/forecast` via `ChronosForecastGate` (`runtimeIntervals.kronosForecastMaxConcurrent`, default **1**) to reduce multi-symbol timeout storms. Per-symbol fail-closed unchanged.
- **Latency alias:** `KronosModelManager.getStatusReport()` exposes `latencyMs` + `lastInferenceMs` alongside `inferenceTime` (Python `/health` field). Kronos dashboard reads `latencyMs ?? lastInferenceMs ?? inferenceTime`.
- Tests: `KronosInference.concurrency.test.ts`, `KronosModelManager.latencyAlias.test.ts`

### 2. NVDA `quant_target_price` ~$121.90 (forensic → code bug)

**Root cause (DATA + CODE):** PortfolioMonitor selected the newest `FILLED BUY` by `filled_at` **without excluding `REPLAY`**. Live NVDA holding was `EXTERNAL_SYNC` @ ~$206.85 (null quant target). Overnight REPLAY fills @ ~$114.22 with `quant_target_price=121.9` won the lookup → perpetual `TARGET_REACHED` at live ~$216.

**Fix:**

- `resolveOpeningTradeForLiveExit()` excludes `REPLAY` / `BACKTEST` / `SIMULATION` / historical / telemetry envs (and replay trace prefix).
- Long targets at/below average entry are ignored (warn only) — no silent rewrite that forces sells.
- Regressions in `PortfolioMonitor.test.ts`

### 3. Quant Alpaca 429

- `HistoricalDataGateway.ensureBars` arms a **shared** in-process backoff on HTTP 429 (honors `Retry-After`, else `alpacaCircuitBreakerCooldownMs`); subsequent symbols fail closed without further Alpaca calls.
- `QuantSignalAgent.runCycle` aborts the rest of the symbol fan-out on 429 / rate-limit errors (no idea storm).
- Regression in `HistoricalDataGateway.test.ts`

### 4. AI consensus debate — "No AI Providers available for consensus" (2026-08-20)

**Root causes:**

1. Empty / placeholder env keys (e.g. DEEPSEEK `your_*` / `CHANGE_ME`) were treated as configured → register → auth-fail.
2. Auth failure **permanently** set `ai_providers.enabled=false` and deleted the provider from the in-memory map, so real GEMINI/OPENAI keys still looked like “no providers” after one bad probe.
3. Error string did not distinguish zero registered vs keys present but unroutable (cooldown / skip / misconfigured).

**Fixes (consensus 0.75 / min-2 unchanged; fail-closed HOLD when debate cannot run):**

- `isPlaceholderApiKey` + `shouldSkipUnconfiguredProvider` skip empty/placeholder cloud keys; local Ollama still needs no key.
- Auth failure → temporary cooldown + `health=Offline` only (no permanent DB disable); heal prior `enabled=false` rows when a usable env key / local endpoint exists.
- Honest `describeConsensusProvidersUnavailable` messages for `routeConsensus` / empty `routeTask`.
- `aiModels.json` Ollama routes applied when local provider is registered; clearer warn if Ollama configured but not registered.
- Tests extended in `AIRouter.test.ts` (placeholder filtering + honest consensus error).

### 5. NewsAgent telemetry honesty (2026-08-20)

**Root cause:** Forensic `lastSuccessfulTickAt=null` / “no ideas” looked like a dead NewsAgent while `newsAgentMode=CATALYST_ONLY` correctly suppresses `TRADE_IDEA_GENERATED`. Pipeline success was already recorded after Phase-2 fix; telemetry was still sparse and easy to misread.

**Fixes (did not flip ideas ON):**

- Kept default `CATALYST_ONLY` (ideas OFF). Documented optional `ACTIVE_VOTE*` as enhancement in `deskIntelligence.json` `$comment`.
- `NEWS_PIPELINE_TICK` now includes `newsAgentMode`, `ideasEmitting`, `liveIdeaGenerationEnabled`.
- Pipeline snapshot for NewsAgent surfaces `newsAgentMode` / `ideasEmitting` / `catalystOnly`.
- Clustering/analysis still runs with Autobot off; `notePipelineAgentSuccess('NewsAgent')` still on every completed cycle.
- Tests: `NewsEngine.test.ts` (success with ideas disabled).

## Remains operator-only

| Item | Action |
|---|---|
| **`news_veto` on NVDA exits** | Wait for `newsVetoWindowMs` expiry or archive/resolve high-impact clusters — **do not** bypass RiskEngine |
| **Chronos `:8008`** | Keep `npm run ai:serve` / Chronos up for honest forecasts. Ideas still fail-closed if `/health` is down. Single-symbol CPU timeouts no longer global-latch Kronos; forecasts are now serialized (`kronosForecastMaxConcurrent=1`). |
| **Alpaca bars budget** | Reduce concurrent Quant/universe pressure if 429s persist; backoff is fail-closed, not a free pass |
| **AI debate providers** | Ensure at least one **real** (non-placeholder) cloud key **or** healthy local Ollama for debate contribution. Code no longer falsely claims “no providers” when keys exist but are misconfigured — still must clear **0.75 / min-2** after a usable debate. |
| **News TRADE_IDEA votes** | Optional: set `deskIntelligence.newsAgentMode` to `ACTIVE_VOTE` only if intentionally wanting News as a voter (default remains catalyst-only for safety). |
| **Autobot / RTH** | Operator-supervised paper only; Autobot off when not intending ideas |
| **Runtime hygiene** | Single Argus writer; clean SIGTERM; ignore stale `.argus_dev.pid` |
| **Soak / edge** | Organic PAPER FILLED SELL P&L still **0** — remediations do not claim edge |

## 6. Performance-audit critical fixes (2026-08-20)

Source: `ARGUS_POST_MARKET_PERFORMANCE_AUDIT_2026-08-20.md`. Consensus **0.75 / min 2** unchanged; no RiskEngine/OMS/BrokerManager bypass; PAPER-safe.

### 6a. Silent NULL `trades.profit_loss` (OMS)

- **Root cause:** `preTradeEntryPrice` from `activeBroker.positions()` was wrapped in an empty `catch (e) {}` — broker miss/throw left `profit_loss` NULL (soak counter skipped the only closed PAPER SELL).
- **Fix:** `resolvePreTradeEntryPrice()` — broker positions → local `portfolio.averagePrice` → live FILLED BUY cost basis (excludes REPLAY/BACKTEST). Empty catch removed; P&L still persisted on full SELL fills.
- **Tests:** `omsEntryPrice.test.ts`, `OrderManagement.test.ts` (positions throw → local averagePrice P&L).

### 6b. Post-fill local portfolio lag → false `MISSING_REMOTELY`

- **Root cause:** Local `portfolio` only cleared on the next recon cycle after a full SELL fill → transient localQty > 0 with broker flat.
- **Fix:** `syncLocalPortfolioAfterFullSellFill()` from `recordFillProgress` when the SELL order is fully filled (zeros or reduces qty; mirrors recon’s quantity=0 clear).
- **Tests:** `localPortfolioSync.test.ts`, OMS sell-fallback asserts qty → 0 before recon.

### 6c. Bull/Bear leave HeavyModelMutex + research timeout

- `config/aiModels.json`: BullResearcher / BearResearcher → `0xroyce/plutus:latest` + `llama3.2:latest` (FundamentalAgent style). ReflectionEngine keeps `deepseek-r1:14b`.
- `researchTimeoutMs: 8000` — `routeConsensus` and Bull/Bear `routeTask` fail closed (HOLD / confidence 0 path) without 60–90s heavy-model hangs.
- **Tests:** `aiModels.test.ts`, `AIRouter.test.ts` (researchTimeoutMs fail-closed).

## Not done (by design)

- Did **not** lower consensus thresholds to “get trades”
- Did **not** weaken `news_veto`, RiskEngine, or OMS
- Did **not** enable LIVE or disable `PAPER_TRADING_ONLY`
- Did **not** flip `newsAgentMode` to ACTIVE_VOTE (ideas stay default-OFF)
- Did **not** rewrite stored REPLAY `quant_target_price` rows (research ledger stays intact)

## 7. Daily campaign tracker (additive, 2026-08-20)

See `ARGUS_CAMPAIGN_TRACKER.md`. Flag-gated (`campaign_enabled` default false). BUY soft-lock via `ideaGenerationGate` / `isCampaignBuyLocked` only — not EMERGENCY_STOP. Budget remains `settings.budget`. Consensus floors unchanged.
