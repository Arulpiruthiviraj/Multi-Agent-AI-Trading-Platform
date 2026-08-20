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
