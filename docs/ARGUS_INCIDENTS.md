# ARGUS incidents (selected)

## 2026-08-19 market-open GPU TDR + zero executions

Windows bugcheck **0x116 VIDEO_TDR_FAILURE** killed the process around 10:18 ET. Argus did not cause that crash (forensic: `ARGUS_MARKET_OPEN_INCIDENT_FORENSIC_AUDIT.md`). Zero BUY/SELL because ChiefTrader never approved (bar 0.75 / min-2), not because RiskEngine rejected. Remediation: `ARGUS_MARKET_OPEN_INCIDENT_REMEDIATION.md`.

## Idea / AI storm (2026-08-18)

**Symptom:** 500+ `TRADE_IDEA_GENERATED` / min and 15k+ `ai_calls` / min on high-tick ETFs; event-loop saturation.

**Cause:** `TechnicalAgent` re-evaluated every tick after history warmup (`history.length` stayed at cap).

**Fix (still in force):** `technicalEvaluationCooldownMs` in `config/quantThresholds.json`.

**Defense in depth (2026-08-19):** `maxTradeIdeasPerMinute` / `maxAiCallsPerMinute` in `tradingSafety.json`; `IDEA_RATE_LIMITED` / `AI_RATE_LIMITED`. These caps are **not** a license to raise consensus frequency.

## Reconciliation pause (GLD ~$403 class)

Pause on mismatch is correct. Never auto-resume. See `PortfolioReconciliation` tests and `CLAUDE.md` DEF-23.

## 10s EMERGENCY_STOP blip

Operator/admin stop+resume, not an automated oscillator. Do not “fix” by removing the kill switch.

## Crash-handler self-logging cascade (2026-08-26, DEF-25)

**Symptom:** process died unrecoverably (silent hang, no exit code) twice in one day, ~37 min and ~3h06m into otherwise-normal PAPER sessions.

**Cause:** `console.error` inside `globalErrorHandlers.ts`'s `uncaughtException`/`unhandledRejection` handlers threw when stdout/stderr's write stream broke (root external trigger still unidentified — one incident was preceded by 6 SQLite `disk I/O error`s ~90s prior, the second had no such precursor). The handler's own logging call throwing re-entered the handler, cascading.

**Fix (still in force):** every logging call in `globalErrorHandlers.ts`/`crashLog.ts` now falls back to a raw fd write if `console.error` itself fails, plus a storm circuit-breaker (`>4` process-level errors in 5s → clean `process.exit(1)`). **Production-verified:** recurred once after the fix shipped and exited cleanly instead of hanging.

**Not fixed:** why the write stream breaks at all, and why `./argus restart` (SIGTERM) is itself logged by the successor process as an unclean shutdown (DEF-26) — see `CLAUDE.md`'s Active known issues.
